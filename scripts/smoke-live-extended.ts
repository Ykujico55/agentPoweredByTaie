import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createTaieAgent } from '../src/agent.ts';
import { getJavaExecutables } from '../src/taie.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runDir = path.join(root, '.taie-agent', 'live-extended', new Date().toISOString().replace(/[:.]/g, '-'));
const projectDir = path.join(runDir, 'project');
const resultPath = path.join(runDir, 'result.json');

async function main() {
  assert.ok(process.env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY is required for this live test.');
  const manifest = JSON.parse(await readFile(path.join(root, '.tools', 'tai-e', 'source-build.json'), 'utf8'));
  assert.equal(createHash('sha256').update(await readFile(manifest.jarPath)).digest('hex'), manifest.sha256);
  await mkdir(runDir, { recursive: true });
  await cp(path.join(root, 'examples', 'division-buggy'), projectDir, {
    recursive: true, filter: source => !source.includes(`${path.sep}.taie-agent`),
  });
  const evidence: Record<string, unknown> = { status: 'running', projectDir, sourceBuild: manifest, assertions: [] };
  const assertions = evidence.assertions as string[];
  const save = () => writeFile(resultPath, JSON.stringify(evidence, null, 2) + '\n');
  await save();
  const agent = await createTaieAgent({
    projectDir, config: { jarPath: manifest.jarPath, analyses: ['division-by-zero', 'null-pointer'] },
    provider: 'deepseek', model: 'deepseek-v4-flash', maxRepairs: 2, maxTurns: 24, timeoutMs: 600000,
    onStatus: text => console.log(`[live-extended] ${text}`),
  });
  try {
    const report = await agent.run([
      'This is a two-stage integration test of a Java coding agent.',
      'The existing example.Main.divide(int numerator, int denominator) is intended to perform integer division.',
      'Required final behavior: divide(12,3)==4; divide(-12,3)==-4; divide(0,3)==0; a zero denominator throws IllegalArgumentException.',
      'STAGE ONE: reply exactly READY and stop. Do not call tools or modify any file in this first response.',
      'The host will now compile the existing program and run Tai-e. Its next message contains genuine analyzer feedback.',
      'STAGE TWO, only after that feedback: use taie_get_finding to inspect the host finding, repair the implementation while preserving this required behavior,',
      'and invoke taie_analyze to validate your actual changes. Do not delete code, suppress analysis or change analysis configuration.',
    ].join('\n'));
    evidence.agentRun = report;
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.outcome, 'incomplete', report.error ?? 'Javac must report missing project tests.');
    assert.ok(report.repairRounds >= 1, 'The host did not execute the feedback-and-repair stage.');
    assert.ok(report.checks[0].findings.some(finding => finding.type === 'INTEGER_DIVIDE_BY_ZERO'));
    assert.ok(report.toolCalls.includes('taie_get_finding'), 'Model did not inspect finding evidence.');
    assert.ok(report.toolCalls.includes('taie_analyze'), 'Model did not call the actual analyzer.');
    assert.equal(report.checks.at(-1)?.status, 'tests_not_run');
    assert.equal(report.checks.at(-1)?.stages.analysis, 'completed');
    assert.equal(report.checks.at(-1)?.findings.length, 0);
    assertions.push('A real host analysis found INTEGER_DIVIDE_BY_ZERO before model edits.');
    assertions.push('The host sent actual feedback; the model retrieved finding evidence, edited code and invoked Tai-e.');
    assertions.push('The last independent host build/analysis completed without findings; missing project tests remain explicit as incomplete.');
    const harness = path.join(runDir, 'DividerAssertions.java');
    await writeFile(harness, [
      'public class DividerAssertions {',
      '  public static void main(String[] args) {',
      '    if (example.Main.divide(12,3) != 4) throw new AssertionError("positive");',
      '    if (example.Main.divide(-12,3) != -4) throw new AssertionError("negative");',
      '    if (example.Main.divide(0,3) != 0) throw new AssertionError("zero numerator");',
      '    boolean rejected = false;',
      '    try { example.Main.divide(12,0); } catch (IllegalArgumentException expected) { rejected = true; }',
      '    if (!rejected) throw new AssertionError("zero denominator must be rejected");',
      '    System.out.print("ASSERTIONS_OK");',
      '  }',
      '}',
    ].join('\n'));
    const classes = path.join(runDir, 'independent-classes');
    await mkdir(classes);
    const execute = promisify(execFile);
    const java = getJavaExecutables();
    await execute(java.javac, ['-encoding', 'UTF-8', '-d', classes,
      path.join(projectDir, 'src', 'main', 'java', 'example', 'Main.java'), harness], { windowsHide: true, timeout: 30000 });
    const result = await execute(java.java, ['-cp', classes, 'DividerAssertions'], { windowsHide: true, timeout: 30000 });
    assert.equal(result.stdout, 'ASSERTIONS_OK');
    evidence.independentExecution = result;
    assertions.push('Independent Java assertions pass for positive, negative, zero numerator and zero denominator.');
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error instanceof Error ? error.stack ?? error.message : String(error);
    process.exitCode = 1;
  } finally {
    await agent.dispose();
    await save();
    console.log(`Extended live smoke ${evidence.status}: ${resultPath}`);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
