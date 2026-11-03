import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaieAgent, redactSecrets } from '../src/agent.ts';
import type { CheckResult } from '../src/check.ts';
import { DEFAULT_ANALYSES, getDefaultJarPath } from '../src/taie.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function main(): Promise<void> {
  const stamp = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(root, '.taie-agent', 'live-maven', stamp);
  const projectDir = path.join(runDir, 'project');
  const resultPath = path.join(runDir, 'result.json');
  const sourcePath = path.join(projectDir, 'src/main/java/example/Greeter.java');
  const protectedPaths = ['pom.xml', 'src/test/java/example/GreeterTest.java'];
  const assertions: string[] = [];
  const confirmations: { round: number; approved: boolean; reportPath: string; sourceSha256: string }[] = [];
  const evidence: Record<string, unknown> = {
    schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), projectDir,
    assertions, confirmations,
    note: 'Real DeepSeek and offline Docker Maven test. The harness approves one repair only after a real failed JUnit check with zero project findings.',
  };
  let agent: Awaited<ReturnType<typeof createTaieAgent>> | undefined;
  let failedReportText: string | undefined;
  let failedReport: CheckResult | undefined;
  const save = () => writeFile(resultPath, `${redactSecrets(JSON.stringify(evidence, null, 2))}\n`);
  await mkdir(runDir, { recursive: true });
  await save();
  console.log(`[live-maven] Evidence: ${runDir}`);
  try {
    assert.ok(process.env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY is required for this real-model smoke test.');
    const timeoutMs = Number(process.env.TAIE_SMOKE_TIMEOUT_MS ?? 900_000);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10_000 && timeoutMs <= 1_800_000,
      'TAIE_SMOKE_TIMEOUT_MS must be an integer between 10000 and 1800000.');
    await cp(path.join(root, 'tests/fixtures/maven-simple'), projectDir, {
      recursive: true, filter: source => !['.taie-agent', 'target'].includes(path.basename(source)),
    });
    const originalSource = await readFile(sourcePath, 'utf8');
    await writeFile(path.join(runDir, 'before.java'), originalSource);
    const originalProtected = Object.fromEntries(await Promise.all(protectedPaths.map(async name =>
      [name, digest(await readFile(path.join(projectDir, name)))])));
    evidence.protectedInputHashes = originalProtected;
    const verifyProtected = async () => {
      for (const name of protectedPaths)
        assert.equal(digest(await readFile(path.join(projectDir, name))), originalProtected[name], `Model changed protected input: ${name}`);
    };
    const task = [
      'This is a staged integration test of code editing, real Maven/JUnit/Tai-e checks, and a host-approved repair.',
      'Work only on src/main/java/example/Greeter.java. Keep public class example.Greeter and public static String greet(String name).',
      'FIRST STAGE: deliberately replace the body of greet with return "BROKEN_GREETING"; so the existing tests fail.',
      'This deliberate faulty implementation is required for the first stage; do not correct it before the host approves a repair.',
      'Call taie_analyze using the configured Maven backend. Then call taie_get_finding to inspect the project finding list.',
      'Explain the real build/test/analysis results and stop. Zero static findings must not be described as passing when JUnit failed.',
      'SECOND STAGE, only after a host message explicitly authorizes a repair: restore the intended greeting behavior.',
      'Required final behavior: return "Hello, " + StringUtils.defaultIfBlank(name, "stranger") + "!", using the existing org.apache.commons.lang3 dependency.',
      'After repairing, call taie_analyze again and report the real result and humanReportPath.',
      'Do not edit pom.xml, tests, taie-agent.json, analysis policies or files under .taie-agent.',
      'Do not add test skipping or run Maven/Java through the shell; use the host check tool for builds and tests.',
    ].join('\n');
    await writeFile(path.join(runDir, 'prompt.txt'), task);
    agent = await createTaieAgent({
      projectDir,
      config: { buildBackend: 'maven-docker', analyses: [...DEFAULT_ANALYSES], jarPath: getDefaultJarPath(),
        dependencyNetwork: false, includeDependencies: false, timeoutMs: 600_000 },
      provider: 'deepseek', model: 'deepseek-v4-flash', repairMode: 'ask',
      maxRepairs: 1, maxTurns: 20, timeoutMs,
      onStatus: text => console.log(`[live-maven] ${redactSecrets(text)}`),
      async confirmRepair(check, round) {
        assert.equal(round, 1);
        assert.equal(confirmations.length, 0, 'Only one repair decision is expected.');
        assert.equal(check.backend, 'maven-docker');
        assert.equal(check.status, 'test_failed');
        assert.equal(check.stages.build, 'passed');
        assert.equal(check.stages.test.status, 'failed');
        assert.equal(check.stages.analysis, 'completed');
        assert.equal(check.findings.length, 0, 'The gate must catch failing tests even with no project findings.');
        const brokenSource = await readFile(sourcePath, 'utf8');
        assert.notEqual(brokenSource, originalSource, 'The model did not write the deliberately incorrect implementation.');
        assert.match(brokenSource, /return\s+"BROKEN_GREETING"\s*;/);
        await verifyProtected();
        await writeFile(path.join(runDir, 'before-approved-repair.java'), brokenSource);
        failedReport = check;
        failedReportText = await readFile(check.reportPath, 'utf8');
        confirmations.push({ round, approved: true, reportPath: check.reportPath, sourceSha256: digest(brokenSource) });
        evidence.failedCheck = check;
        assertions.push('The model wrote a deliberate defect; the host kept a real failed JUnit check despite zero project findings.');
        await save();
        console.log('[live-maven] Harness approved one repair after observing the failed test.');
        return true;
      },
    });
    evidence.agentRunDir = agent.runDir;
    await save();
    const report = await agent.run(task);
    evidence.agentRun = report;
    await save();
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.outcome, 'verified', report.error ?? `Unexpected outcome ${report.outcome}`);
    assert.equal(report.repairMode, 'ask');
    assert.equal(report.repairRounds, 1);
    assert.deepEqual(report.repairDecisions, [{ round: 1, approved: true }]);
    assert.equal(confirmations.length, 1);
    assert.equal(report.checks.length, 2, 'Host must independently check before and after the authorized repair.');
    assert.ok(report.checks.every(check => check.backend === 'maven-docker'));
    assert.equal(report.checks[0].status, 'test_failed');
    const finalCheck = report.checks.at(-1)!;
    assert.equal(finalCheck.status, 'passed');
    assert.equal(finalCheck.stages.build, 'passed');
    assert.equal(finalCheck.stages.test.status, 'passed');
    assert.equal(finalCheck.stages.test.tests, 1);
    assert.equal(finalCheck.stages.analysis, 'completed');
    assert.equal(finalCheck.stages.review, 'not_run');
    assert.deepEqual(finalCheck.findings, []);
    assert.ok(finalCheck.findingCounts.dependency > 0);
    assert.equal(finalCheck.dependencyFindings, undefined);
    assert.ok(report.toolCalls.includes('taie_analyze'));
    assert.ok(report.toolCalls.includes('taie_get_finding'));
    assert.ok(report.toolCalls.some(name => name === 'write' || name === 'edit'));
    await verifyProtected();
    assert.ok(failedReport && failedReportText);
    assert.equal(await readFile(failedReport.reportPath, 'utf8'), failedReportText, 'Repair overwrote original failed evidence.');
    assert.ok(failedReport.snapshotFingerprint && finalCheck.snapshotFingerprint);
    assert.notEqual(failedReport.snapshotFingerprint, finalCheck.snapshotFingerprint);
    for (const check of report.checks) {
      assert.ok((await readFile(check.humanReportPath, 'utf8')).includes(check.status));
      assert.equal(JSON.parse(await readFile(check.reportPath, 'utf8')).status, check.status);
    }
    const events = (await readFile(path.join(report.runDir, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/)
      .map(line => JSON.parse(line) as { type: string; report?: CheckResult });
    const toolChecks = events.filter(event => event.type === 'taie_tool_report').map(event => event.report!);
    assert.ok(toolChecks.every(check => check.backend === 'maven-docker'));
    assert.ok(toolChecks.some(check => check.status === 'test_failed' && check.findings.length === 0));
    assert.ok(toolChecks.some(check => check.status === 'passed'));
    assert.ok(toolChecks.every(check => !report.checks.some(host => host.reportPath === check.reportPath)),
      'Host verification must be fresh rather than reusing model tool output.');
    const finalSource = await readFile(sourcePath, 'utf8');
    assert.doesNotMatch(finalSource, /BROKEN_GREETING/);
    await writeFile(path.join(runDir, 'after.java'), finalSource);
    assertions.push('One approved repair preserved the POM and tests; fresh Maven build, one JUnit test and Tai-e analysis passed.');
    assertions.push('Model tool checks and final host checks used separate runs of the same Maven backend; original failed evidence and Markdown reports remain readable.');
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error instanceof Error ? error.stack ?? error.message : String(error);
    process.exitCode = 1;
  } finally {
    await agent?.dispose();
    evidence.finishedAt = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ status: evidence.status, resultPath, confirmations: confirmations.length }));
    if (evidence.error) console.error(redactSecrets(String(evidence.error)));
  }
}

// Importing or typechecking the script never starts a model request.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
