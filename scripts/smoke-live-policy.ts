import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTaieAgent, redactSecrets } from "../src/agent.ts";
import type { AnalysisReport } from "../src/taie.ts";
import { getJavaExecutables } from "../src/taie.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const runDir = path.join(root, ".taie-agent", "live-policy", stamp);
const projectDir = path.join(runDir, "project");
const resultPath = path.join(runDir, "result.json");
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function javaSources(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javaSources(file));
    else if (entry.isFile() && entry.name.endsWith(".java")) files.push(file);
  }
  return files.sort();
}

async function sourceSnapshot() {
  const files = await javaSources(path.join(projectDir, "src", "main", "java"));
  const hash = createHash("sha256");
  const entries = [];
  for (const file of files) {
    const relativePath = path.relative(projectDir, file).replaceAll(path.sep, "/");
    const content = await readFile(file);
    hash.update(relativePath).update("\0").update(content).update("\0");
    entries.push({ path: relativePath, sha256: digest(content) });
  }
  return { sha256: hash.digest("hex"), files: entries };
}

async function existingLog(file: string): Promise<Buffer> {
  try { return await readFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}

async function main() {
  await mkdir(runDir, { recursive: true });
  const phases: Record<string, Record<string, unknown>> = {};
  const confirmations: { phase: string; round: number; approved: boolean; reportPath: string; analyses: string[] }[] = [];
  const assertions: string[] = [];
  const evidence: Record<string, unknown> = {
    schemaVersion: 1, status: "running", startedAt: new Date().toISOString(), projectDir,
    phases, confirmations, assertions,
  };
  const save = () => writeFile(resultPath, `${redactSecrets(JSON.stringify(evidence, null, 2))}\n`);
  let agent: Awaited<ReturnType<typeof createTaieAgent>> | undefined;
  await save();
  try {
    assert.ok(process.env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY is required for this real-model smoke test.");
    const manifest = JSON.parse(await readFile(path.join(root, ".tools", "tai-e", "source-build.json"), "utf8"));
    assert.equal(typeof manifest.jarPath, "string");
    assert.ok(path.isAbsolute(manifest.jarPath), "The source-build manifest must identify an absolute JAR path.");
    assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
    assert.equal(digest(await readFile(manifest.jarPath)), manifest.sha256, "Source JAR does not match its build manifest.");
    evidence.sourceBuild = manifest;
    await cp(path.join(root, "examples", "division-buggy"), projectDir, {
      recursive: true,
      filter: source => !source.includes(`${path.sep}.taie-agent`),
    });
    const initial = await sourceSnapshot();
    evidence.initialSource = initial;
    const config = { jarPath: manifest.jarPath as string, analyses: ["division-by-zero"] };
    const expandedConfig = { ...config, analyses: ["division-by-zero", "null-pointer"] };
    agent = await createTaieAgent({
      projectDir, config, provider: "deepseek", model: "deepseek-v4-flash",
      repairMode: "off", maxRepairs: 1, maxTurns: 12, timeoutMs: 600000,
    });
    const activeAgent = agent;
    const sharedEventsPath = path.join(activeAgent.runDir, "events.jsonl");
    evidence.agentRunDir = activeAgent.runDir;
    evidence.sharedEventsPath = sharedEventsPath;

    const phase = async (name: string, task: string, configure?: () => Promise<void>) => {
      const offset = (await existingLog(sharedEventsPath)).length;
      const record: Record<string, unknown> = {
        startedAt: new Date().toISOString(), task, sharedEventsPath, eventByteStart: offset,
      };
      phases[name] = record;
      evidence.activePhase = name;
      await save();
      try {
        await configure?.();
        const report = await activeAgent.run(task);
        const reportPath = path.join(runDir, `${name}-report.json`);
        await writeFile(reportPath, `${redactSecrets(JSON.stringify(report, null, 2))}\n`);
        record.reportPath = reportPath;
        record.hostReportPaths = report.checks.map(check => check.reportPath);
        record.outcome = report.outcome;
        record.repairMode = report.repairMode;
        record.repairRounds = report.repairRounds;
        record.repairDecisions = report.repairDecisions;
        record.sourceAfter = await sourceSnapshot();
        for (const check of report.checks) assert.equal(check.taiE.sha256, manifest.sha256);
        return report;
      } finally {
        const log = await existingLog(sharedEventsPath);
        const eventsPath = path.join(runDir, `${name}-events.jsonl`);
        await writeFile(eventsPath, log.subarray(offset));
        record.eventsPath = eventsPath;
        record.eventByteEnd = log.length;
        record.finishedAt = new Date().toISOString();
        await save();
      }
    };

    const off = await phase("01-off", [
      "This project intentionally contains an integer division-by-zero defect in example.Main.divide.",
      "Read src/main/java/example/Main.java, then invoke the real taie_analyze tool and explain its findings.",
      "Preserve the intentional bug exactly. Do not change any file, implement a fix, or run shell commands.",
      "After explaining the analyzer findings, stop. Automatic repair is disabled for this task.",
    ].join("\n"));
    assert.equal(off.outcome, "unresolved", off.error);
    assert.equal(off.repairMode, "off");
    assert.equal(off.repairRounds, 0);
    assert.deepEqual(off.repairDecisions, []);
    assert.ok(off.toolCalls.includes("taie_analyze"), "The model did not call the real analyzer in off mode.");
    assert.ok(off.checks[0]?.findings.some(finding => finding.type === "INTEGER_DIVIDE_BY_ZERO"));
    assert.equal((await sourceSnapshot()).sha256, initial.sha256, "Off mode changed the Java source.");
    assertions.push("Off mode used the real analyzer, retained the warning and performed no repair or source changes.");
    await save();

    let deniedQuestions = 0;
    const denied = await phase("02-ask-denied", [
      "Reply exactly READY and stop. Do not invoke tools or modify files in this response.",
      "The host will check the unchanged deliberate defect with its updated analysis configuration.",
      "No repair has been approved. Preserve the existing code.",
    ].join("\n"), () => activeAgent.configure({
      repairMode: "ask", config: expandedConfig,
      confirmRepair: async (report: AnalysisReport, round: number) => {
        deniedQuestions++;
        confirmations.push({ phase: "02-ask-denied", round, approved: false,
          reportPath: report.reportPath, analyses: [...report.analyses] });
        return false;
      },
    }));
    assert.equal(deniedQuestions, 1, "Ask mode must request exactly one repair decision.");
    assert.equal(denied.outcome, "unresolved", denied.error);
    assert.equal(denied.repairMode, "ask");
    assert.equal(denied.repairRounds, 0);
    assert.deepEqual(denied.repairDecisions, [{ round: 1, approved: false }]);
    assert.deepEqual(denied.checks[0]?.analyses.slice().sort(), expandedConfig.analyses.slice().sort());
    assert.ok(denied.checks[0]?.findings.some(finding => finding.type === "INTEGER_DIVIDE_BY_ZERO"));
    assert.equal((await sourceSnapshot()).sha256, initial.sha256, "A refused repair changed the Java source.");
    assert.equal(denied.runDir, off.runDir, "Settings updates unexpectedly created a new agent session.");
    assertions.push("The same agent accepted updated detector settings, asked once, and preserved sources after refusal.");
    await save();

    let approvedQuestions = 0;
    const approved = await phase("03-ask-approved", [
      "This task tests an explicit host-approved repair while preserving the current conversation.",
      "FIRST RESPONSE: reply exactly READY and stop. Do not invoke tools or modify files yet.",
      "The host will analyze the unchanged code and ask for approval before starting a repair round.",
      "ONLY AFTER a host message explicitly approves the repair: use write or edit to repair example.Main.divide.",
      "Required behavior: calculate numerator / denominator; divide(12,3)==4; divide(-12,3)==-4; divide(0,3)==0.",
      "A zero denominator must throw IllegalArgumentException. Preserve this behavior; do not return a fabricated constant.",
      "After an approved edit, invoke taie_analyze to check the code. Do not suppress detectors, delete functionality or change analysis configuration.",
    ].join("\n"), () => activeAgent.configure({
      repairMode: "ask", config: expandedConfig,
      confirmRepair: async (report: AnalysisReport, round: number) => {
        approvedQuestions++;
        confirmations.push({ phase: "03-ask-approved", round, approved: true,
          reportPath: report.reportPath, analyses: [...report.analyses] });
        return true;
      },
    }));
    assert.equal(approvedQuestions, 1, "Only one approved repair round is expected.");
    assert.equal(approved.outcome, "verified", approved.error);
    assert.equal(approved.repairRounds, 1);
    assert.deepEqual(approved.repairDecisions, [{ round: 1, approved: true }]);
    assert.ok(approved.checks[0]?.findings.some(finding => finding.type === "INTEGER_DIVIDE_BY_ZERO"));
    assert.equal(approved.checks.at(-1)?.status, "completed");
    assert.equal(approved.checks.at(-1)?.findings.length, 0);
    assert.ok(approved.toolCalls.some(name => name === "write" || name === "edit"));
    const approvedEvents = (await readFile(phases["03-ask-approved"].eventsPath as string, "utf8"))
      .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    assert.ok(approvedEvents.some(event => event.type === "tool_execution_end"
      && (event.toolName === "write" || event.toolName === "edit") && event.isError === false),
    "No successful write/edit tool execution was recorded.");
    assert.notEqual((await sourceSnapshot()).sha256, initial.sha256);
    assert.equal(approved.runDir, off.runDir);
    assertions.push("Approval started exactly one repair round, a write/edit succeeded, and a fresh host scan was clean.");

    const harness = path.join(runDir, "DividerPolicyAssertions.java");
    await writeFile(harness, [
      "public class DividerPolicyAssertions {",
      "  public static void main(String[] args) {",
      '    if (example.Main.divide(12,3) != 4) throw new AssertionError("positive");',
      '    if (example.Main.divide(-12,3) != -4) throw new AssertionError("negative");',
      '    if (example.Main.divide(0,3) != 0) throw new AssertionError("zero numerator");',
      '    if (example.Main.divide(7,2) != 3) throw new AssertionError("denominator and integer truncation");',
      '    if (example.Main.divide(12,-3) != -4) throw new AssertionError("negative denominator");',
      "    boolean rejected = false;",
      "    try { example.Main.divide(12,0); } catch (IllegalArgumentException expected) { rejected = true; }",
      '    if (!rejected) throw new AssertionError("zero denominator");',
      '    System.out.print("ASSERTIONS_OK");',
      "  }",
      "}",
    ].join("\n"));
    const classes = path.join(runDir, "independent-classes");
    await mkdir(classes);
    const execute = promisify(execFile);
    const java = getJavaExecutables();
    const compileArgs = ["-encoding", "UTF-8", "-proc:none", "-d", classes,
      ...await javaSources(path.join(projectDir, "src", "main", "java")), harness];
    const runArgs = ["-cp", classes, "DividerPolicyAssertions"];
    const compileResult = await execute(java.javac, compileArgs, { windowsHide: true, timeout: 30000 });
    const execution = await execute(java.java, runArgs, { windowsHide: true, timeout: 30000 });
    assert.equal(execution.stdout, "ASSERTIONS_OK");
    const independentPath = path.join(runDir, "independent-execution.json");
    await writeFile(independentPath, `${JSON.stringify({
      javac: { command: java.javac, args: compileArgs, ...compileResult },
      java: { command: java.java, args: runArgs, ...execution },
    }, null, 2)}\n`);
    evidence.independentExecutionPath = independentPath;
    evidence.finalSource = await sourceSnapshot();
    assertions.push("Independent javac/java execution passed positive, negative, zero-numerator and zero-denominator assertions.");
    evidence.status = "passed";
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error instanceof Error ? error.stack ?? error.message : String(error);
    process.exitCode = 1;
  } finally {
    try { await agent?.dispose(); }
    catch (error) {
      evidence.status = "failed";
      evidence.disposeError = String(error);
      process.exitCode = 1;
    }
    evidence.finishedAt = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ status: evidence.status, phases: Object.fromEntries(
      Object.entries(phases).map(([name, value]) => [name, value.outcome ?? "failed"])), resultPath }));
  }
}

main().catch(error => {
  console.error(`[live-policy] ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
});
