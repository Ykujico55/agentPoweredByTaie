import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject } from '../src/check.ts';
import { verifyTask } from '../src/verification.ts';

/** Real javac/Tai-e checks with deterministic edits; this harness does not call a model. */
async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = path.join(root, '.taie-agent', 'baseline-smoke', new Date().toISOString().replaceAll(/[:.]/g, '-'));
  const projectDir = path.join(directory, 'project');
  const sourcePath = path.join(projectDir, 'src/main/java/example/Main.java');
  await mkdir(path.dirname(sourcePath), { recursive: true });
  const method = (name: string, fixed = false) => [
    `  public static void ${name}(String input) {`,
    '    try { Integer.parseInt(input); } catch (RuntimeException ignored) {',
    ...(fixed ? ['      throw new IllegalArgumentException("Invalid number", ignored);'] : []),
    '    }', '  }',
  ].join('\n');
  const source = (fixed: boolean, introduced: boolean) => [
    'package example;', ...(introduced ? ['// Newly inserted lines must not turn the legacy finding into a new defect.', ''] : []),
    'public class Main {', method('legacy', fixed), method('obsolete', introduced),
    ...(introduced ? [method('introduced', fixed)] : []), '}', '',
  ].join('\n');
  await writeFile(sourcePath, source(false, false));
  const evidence: Record<string, unknown> = { status: 'running', projectDir, note: 'Deterministic edits with real Tai-e; no model request.' };
  const save = () => writeFile(path.join(directory, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  await save();
  console.log(`Baseline smoke: ${directory}`);
  try {
    let baselineBytes = '';
    const first = await verifyTask({
      task: 'Introduce one new warning, fix one old warning, and retain another warning after shifting lines.',
      maxRepairs: 0, repairMode: 'off',
      onBaseline(baseline) {
        assert.ok(baseline.check);
        assert.equal(readFileSync(sourcePath, 'utf8'), source(false, false), 'baseline must precede edits');
        baselineBytes = readFileSync(baseline.check.reportPath, 'utf8');
      },
      prompt: async () => { await writeFile(sourcePath, source(false, true)); },
      analyze: baseline => checkProject({ projectDir, sourceRoots: ['src/main/java'], analyses: ['dropped-exception'], baseline }),
    });
    evidence.first = first;
    await save();
    assert.equal(first.baseline.status, 'completed');
    assert.equal(first.baseline.check?.findings.length, 2);
    assert.equal(first.outcome, 'unresolved');
    assert.equal(first.checks.length, 1, 'baseline is separate from final host checks');
    assert.equal(first.checks[0].comparison?.status, 'compared');
    assert.deepEqual(first.checks[0].comparison?.counts, { added: 1, removed: 1, persisting: 1, changed: 0 });
    assert.equal(await readFile(first.baseline.check!.reportPath, 'utf8'), baselineBytes);
    const persisted = first.checks[0].comparison!.persisting![0];
    assert.equal(persisted.before.id, persisted.after.id);
    assert.notEqual(persisted.before.startLine, persisted.after.startLine);
    const second = await verifyTask({
      task: 'Fix the remaining warnings without claiming that project tests ran.', maxRepairs: 0, repairMode: 'off',
      prompt: async () => { await writeFile(sourcePath, source(true, true)); },
      analyze: baseline => checkProject({ projectDir, sourceRoots: ['src/main/java'], analyses: ['dropped-exception'], baseline }),
    });
    evidence.second = second;
    await save();
    assert.equal(second.baseline.check?.findings.length, 2);
    assert.equal(second.outcome, 'incomplete');
    assert.equal(second.checks[0].stages.test.status, 'not_run');
    assert.deepEqual(second.checks[0].comparison?.counts, { added: 0, removed: 2, persisting: 0, changed: 0 });
    for (const report of [first.checks[0], second.checks[0]]) {
      assert.match(await readFile(report.humanReportPath, 'utf8'), /与修改前基线对比/);
      assert.equal(JSON.parse(await readFile(report.reportPath, 'utf8')).comparison.status, 'compared');
    }
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error instanceof Error ? error.stack ?? error.message : String(error);
    process.exitCode = 1;
  } finally {
    await save();
    console.log(JSON.stringify({ status: evidence.status, resultPath: path.join(directory, 'result.json') }));
    if (evidence.error) console.error(evidence.error);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
