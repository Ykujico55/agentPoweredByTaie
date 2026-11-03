import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckResult } from '../src/check.ts';
import type { VerificationResult } from '../src/verification.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const evidenceDir = path.join(repoRoot, '.taie-agent', 'live-smoke', smokeId);
const projectDir = path.join(evidenceDir, 'generated');
const resultPath = path.join(evidenceDir, 'result.json');
const maxOutputBytes = 4 * 1024 * 1024;

interface CommandResult {
  executable: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  spawnError?: string;
}

interface AnalysisCheck {
  status: string;
  findings: unknown[];
  reportPath: string;
  sourceFingerprint?: string;
}

interface AgentRun {
  schemaVersion: 2;
  outcome: VerificationResult['outcome'];
  runDir: string;
  checks: CheckResult[];
  toolCalls: string[];
  model: unknown;
  finalText: string;
}

interface SmokeEvidence {
  smokeId: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'passed' | 'failed';
  projectDir: string;
  promptFile: string;
  commands: Record<string, CommandResult>;
  agentRun?: AgentRun;
  seededRepair?: {
    projectDir: string;
    promptFile: string;
    commands: Record<string, CommandResult>;
    baseline?: AnalysisCheck;
    agentRun?: AgentRun;
    assertions: string[];
  };
  assertions: string[];
  error?: string;
}

function runBounded(executable: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let spawnError: string | undefined;
    const child = spawn(executable, args, {
      cwd: repoRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      const kept = chunk.subarray(0, remaining);
      outputBytes += kept.length;
      if (kept.length < chunk.length) outputTruncated = true;
      if (stream === 'stdout') stdout += kept.toString('utf8');
      else stderr += kept.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'stderr'));
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => { spawnError = error.message; });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ executable, args, exitCode, signal, timedOut, durationMs: Date.now() - started,
        stdout, stderr, outputTruncated, ...(spawnError ? { spawnError } : {}) });
    });
  });
}

function requireSuccess(result: CommandResult, label: string, expectedExitCode = 0): void {
  assert.equal(result.spawnError, undefined, `${label} could not start: ${result.spawnError}`);
  assert.equal(result.timedOut, false, `${label} exceeded its time limit`);
  assert.equal(result.exitCode, expectedExitCode, `${label} exited ${result.exitCode}: ${result.stderr.slice(-3000)}`);
}

function javaExecutable(name: 'java' | 'javac'): string {
  const javaHome = process.env.TAIE_JAVA_HOME || process.env.JAVA_HOME;
  return javaHome ? path.join(javaHome, 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`) : name;
}

function hasDroppedException(report: AnalysisCheck): boolean {
  return Array.isArray(report.findings) && report.findings.some((finding) =>
    finding !== null && typeof finding === 'object' && 'type' in finding && finding.type === 'DE_MIGHT_IGNORE');
}

async function runSeededRepair(evidence: SmokeEvidence, timeoutMs: number, save: () => Promise<void>): Promise<void> {
  const repairDir = path.join(evidenceDir, 'seeded-repair');
  const promptFile = path.join(evidenceDir, 'repair-prompt.txt');
  const seeded: NonNullable<SmokeEvidence['seededRepair']> = {
    projectDir: repairDir, promptFile, commands: {}, assertions: [],
  };
  evidence.seededRepair = seeded;
  await cp(path.join(repoRoot, 'tests', 'fixtures', 'buggy'), repairDir, { recursive: true, force: false, errorOnExist: true });
  const sourcePath = path.join(repairDir, 'src', 'main', 'java', 'example', 'Main.java');
  await writeFile(path.join(evidenceDir, 'seeded-before.java'), await readFile(sourcePath));
  seeded.commands.baseline = await runBounded(process.execPath, [
    'src/cli.ts', 'analyze', '--project', repairDir, '--json',
  ], 180_000);
  const baselineCommand = seeded.commands.baseline;
  assert.equal(baselineCommand.spawnError, undefined, `Seeded baseline could not start: ${baselineCommand.spawnError}`);
  assert.equal(baselineCommand.timedOut, false, 'Seeded baseline analysis timed out');
  assert.equal(baselineCommand.exitCode, 2, 'Seeded baseline must exit 2 to report actual findings');
  seeded.baseline = JSON.parse(baselineCommand.stdout) as AnalysisCheck;
  assert.equal(seeded.baseline.status, 'completed', 'Seeded baseline analysis did not complete');
  assert.ok(hasDroppedException(seeded.baseline), 'Exact seeded fixture did not produce DE_MIGHT_IGNORE');
  assert.ok(seeded.baseline.sourceFingerprint, 'Seeded baseline omitted source fingerprint');
  const baselineReportText = await readFile(seeded.baseline.reportPath, 'utf8');
  seeded.assertions.push('Before the model ran, real Tai-e reported DE_MIGHT_IGNORE on the exact buggy fixture');
  await writeFile(promptFile, [
    'Repair the existing Java project. Keep public class example.Main and its public static void main(String[] args).',
    'First call taie_analyze before changing any files, so you observe the existing swallowed-exception warning.',
    'Keep normal operation: parse the first command-line argument with Integer.parseInt; a valid integer finishes successfully without printing output.',
    'Malformed input must fail explicitly instead of being swallowed. In the catch block, throw a descriptive IllegalArgumentException with the caught RuntimeException as its cause.',
    'Preserve the original exception cause; do not replace the parse operation or simply delete the functionality.',
    'Call taie_analyze after repairing the code and resolve remaining findings.',
    'Do not change analysis configuration, suppress a warning, or edit files under .taie-agent.',
  ].join('\n') + '\n');
  await save();
  console.log(`Live smoke seeded repair: ${repairDir}`);
  seeded.commands.agent = await runBounded(process.execPath, [
    'src/cli.ts', 'run', '--project', repairDir, '--prompt-file', promptFile, '--max-repairs', '2', '--repair-mode', 'auto',
  ], timeoutMs);
  await save();
  requireSuccess(seeded.commands.agent, 'Seeded repair agent (javac tests_not_run)', 1);
  seeded.agentRun = JSON.parse(await readFile(path.join(repairDir, '.taie-agent', 'last-agent-run.json'), 'utf8')) as AgentRun;
  const run = seeded.agentRun;
  assert.equal(run.schemaVersion, 2);
  assert.equal(run.outcome, 'incomplete', `Seeded repair outcome was ${run.outcome}`);
  assert.ok(run.toolCalls.includes('taie_analyze'), 'Seeded repair model did not call taie_analyze');
  const completedChecks = run.checks.filter((check) => check.stages.analysis === 'completed');
  assert.ok(completedChecks.length > 0, 'Seeded repair recorded no completed host analysis');
  assert.deepEqual(completedChecks.at(-1)?.findings, [], 'Final seeded repair host check still reported findings');
  assert.equal(completedChecks.at(-1)?.status, 'tests_not_run');
  for (const check of completedChecks) await readFile(check.reportPath, 'utf8');
  const events = (await readFile(path.join(run.runDir, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/)
    .filter(Boolean).map((line) => JSON.parse(line) as { type: string; report?: CheckResult });
  assert.ok(events.some((event) => event.type === 'taie_tool_report' && event.report?.stages.analysis === 'completed'
    && event.report.sourceFingerprint === seeded.baseline?.sourceFingerprint && hasDroppedException(event.report)),
  'No real model-invoked Tai-e report observed the unchanged seeded defect before repair');
  seeded.assertions.push('The model called Tai-e on the original source and received the actual dropped-exception finding');
  seeded.assertions.push('A fresh completed host check found no remaining findings after repair');
  assert.equal(await readFile(seeded.baseline.reportPath, 'utf8'), baselineReportText, 'Repair changed the immutable baseline report');
  assert.notEqual(completedChecks.at(-1)?.sourceFingerprint, seeded.baseline.sourceFingerprint, 'Seeded source did not change');
  seeded.assertions.push('Baseline evidence remained immutable and the repaired source fingerprint changed');
  await writeFile(path.join(evidenceDir, 'seeded-after.java'), await readFile(sourcePath));
  const classesDir = path.join(evidenceDir, 'seeded-independent-classes');
  await mkdir(classesDir, { recursive: true });
  seeded.commands.compile = await runBounded(javaExecutable('javac'), [
    '-encoding', 'UTF-8', '-d', classesDir, sourcePath,
  ], 60_000);
  requireSuccess(seeded.commands.compile, 'Independent seeded repair javac');
  seeded.commands.validInput = await runBounded(javaExecutable('java'), ['-cp', classesDir, 'example.Main', '7'], 30_000);
  requireSuccess(seeded.commands.validInput, 'Repaired main with valid integer');
  assert.equal(seeded.commands.validInput.stdout, '', 'Seeded repair changed normal stdout');
  assert.equal(seeded.commands.validInput.stderr, '', 'Seeded repair changed normal stderr');
  seeded.assertions.push('Independent execution with a valid integer preserves successful silent operation');
  seeded.commands.malformedInput = await runBounded(javaExecutable('java'), [
    '-cp', classesDir, 'example.Main', 'not-a-number',
  ], 30_000);
  const malformed = seeded.commands.malformedInput;
  assert.equal(malformed.spawnError, undefined, 'Repaired main could not start for malformed input');
  assert.equal(malformed.timedOut, false, 'Repaired main timed out for malformed input');
  assert.ok(malformed.exitCode !== null && malformed.exitCode !== 0, 'Malformed input was still swallowed');
  assert.match(malformed.stderr, /java\.lang\.IllegalArgumentException/, 'Malformed input did not produce the explicit failure');
  assert.match(malformed.stderr, /Caused by: java\.lang\.NumberFormatException/, 'Malformed input lost its original parse failure cause');
  seeded.assertions.push('Independent malformed-input execution fails explicitly and retains NumberFormatException as its cause');
  await save();
}

async function main(): Promise<void> {
  // A normal typecheck or test import never contacts an LLM. Only this script's
  // explicit invocation launches the live CLI and uses the configured API key.
  const configuredTimeout = Number(process.env.TAIE_SMOKE_TIMEOUT_MS ?? 600_000);
  assert.ok(Number.isSafeInteger(configuredTimeout) && configuredTimeout >= 10_000 && configuredTimeout <= 1_800_000,
    'TAIE_SMOKE_TIMEOUT_MS must be an integer between 10000 and 1800000');
  await mkdir(projectDir, { recursive: true });
  const promptFile = path.join(evidenceDir, 'prompt.txt');
  await writeFile(promptFile, [
    'Create a small Java project in the current project directory.',
    'Write src/main/java/Greeter.java in the default package, containing public class Greeter.',
    'Expose public static String greet(String name). For non-null name, return exactly "Hello, " + name + "!".',
    'For null name, return exactly "Hello, stranger!". Do not throw for null.',
    'Expose public static void main(String[] args). Print greet(args[0]) if an argument exists; otherwise print greet(null).',
    'Compile the code and explicitly call the taie_analyze tool to analyze the project.',
    'Fix any findings before finishing. Do not merely describe the code; write the requested Java file.',
  ].join('\n') + '\n');
  const evidence: SmokeEvidence = {
    smokeId, startedAt: new Date().toISOString(), status: 'running', projectDir, promptFile,
    commands: {}, assertions: [],
  };
  const save = () => writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`);
  await save();
  console.log(`Live smoke: ${evidenceDir}`);
  try {
    assert.ok(process.env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY is required for the live smoke test');
    evidence.commands.agent = await runBounded(process.execPath, [
      'src/cli.ts', 'run', '--project', projectDir,
      '--prompt-file', promptFile, '--max-repairs', '2', '--repair-mode', 'auto',
    ], configuredTimeout);
    await save();
    requireSuccess(evidence.commands.agent, 'Coding agent (javac tests_not_run)', 1);
    evidence.agentRun = JSON.parse(await readFile(path.join(projectDir, '.taie-agent', 'last-agent-run.json'), 'utf8')) as AgentRun;
    const run = evidence.agentRun;
    assert.equal(run.schemaVersion, 2);
    assert.equal(run.outcome, 'incomplete', `Agent outcome was ${run.outcome}`);
    assert.equal(run.checks.at(-1)?.status, 'tests_not_run');
    assert.deepEqual(run.checks.at(-1)?.findings, []);
    evidence.assertions.push('Host compilation and analysis succeeded; outcome=incomplete accurately records that javac runs no project tests');
    assert.ok(Array.isArray(run.toolCalls) && run.toolCalls.includes('taie_analyze'), 'Model did not call taie_analyze');
    evidence.assertions.push('Actual model tool calls include taie_analyze');
    assert.ok(Array.isArray(run.checks) && run.checks.length > 0, 'Host recorded no analysis checks');
    const completedChecks = run.checks.filter((check) => check.stages.analysis === 'completed');
    assert.ok(completedChecks.length > 0, 'Host recorded no completed analysis check');
    for (const check of completedChecks) {
      assert.ok(typeof check.reportPath === 'string' && check.reportPath.length > 0, 'Completed check omitted reportPath');
      await readFile(path.isAbsolute(check.reportPath) ? check.reportPath : path.resolve(projectDir, check.reportPath), 'utf8');
    }
    evidence.assertions.push(`${completedChecks.length} completed host analysis report(s) exist on disk`);
    const sourceFile = path.join(projectDir, 'src', 'main', 'java', 'Greeter.java');
    const source = await readFile(sourceFile, 'utf8');
    assert.ok(source.trim().length > 0, 'Greeter.java is empty');
    const harnessPath = path.join(evidenceDir, 'GreeterAssertions.java');
    await writeFile(harnessPath, [
      'public class GreeterAssertions {',
      '  public static void main(String[] args) {',
      '    if (!"Hello, Tai-e!".equals(Greeter.greet("Tai-e"))) throw new AssertionError("ordinary name");',
      '    if (!"Hello, stranger!".equals(Greeter.greet(null))) throw new AssertionError("null input");',
      '    if (!"Hello, !".equals(Greeter.greet(""))) throw new AssertionError("empty name");',
      '    System.out.print("ASSERTIONS_OK");',
      '  }',
      '}',
    ].join('\n') + '\n');
    const classesDir = path.join(evidenceDir, 'independent-classes');
    await mkdir(classesDir, { recursive: true });
    evidence.commands.compile = await runBounded(javaExecutable('javac'), [
      '-encoding', 'UTF-8', '-d', classesDir, sourceFile, harnessPath,
    ], 60_000);
    requireSuccess(evidence.commands.compile, 'Independent javac');
    evidence.assertions.push('Independent javac compiled the generated source and assertion harness');
    evidence.commands.main = await runBounded(javaExecutable('java'), ['-cp', classesDir, 'Greeter', 'Tai-e'], 30_000);
    requireSuccess(evidence.commands.main, 'Greeter main');
    assert.equal(evidence.commands.main.stdout.replace(/\r\n/g, '\n'), 'Hello, Tai-e!\n', 'Unexpected main stdout');
    evidence.assertions.push('Greeter main prints exactly Hello, Tai-e! followed by one newline');
    evidence.commands.mainWithoutArgs = await runBounded(javaExecutable('java'), ['-cp', classesDir, 'Greeter'], 30_000);
    requireSuccess(evidence.commands.mainWithoutArgs, 'Greeter main without args');
    assert.equal(evidence.commands.mainWithoutArgs.stdout.replace(/\r\n/g, '\n'), 'Hello, stranger!\n', 'Unexpected no-argument main stdout');
    evidence.assertions.push('Greeter main without arguments safely uses the null fallback');
    evidence.commands.assertions = await runBounded(javaExecutable('java'), ['-cp', classesDir, 'GreeterAssertions'], 30_000);
    requireSuccess(evidence.commands.assertions, 'Java assertion harness');
    assert.equal(evidence.commands.assertions.stdout, 'ASSERTIONS_OK', 'Java assertion harness did not report success');
    evidence.assertions.push('Executable Java assertions pass for a normal name, null, and empty string');
    await runSeededRepair(evidence, configuredTimeout, save);
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error instanceof Error ? error.stack ?? error.message : String(error);
    process.exitCode = 1;
  } finally {
    evidence.completedAt = new Date().toISOString();
    await save();
    console.log(`Live smoke ${evidence.status}: ${resultPath}`);
    if (evidence.error) console.error(evidence.error);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
