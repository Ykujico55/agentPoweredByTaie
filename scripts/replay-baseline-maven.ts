import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMavenCheck, writeCheckReports, type CheckResult } from '../src/check.ts';
import { buildComparisonKey } from '../src/check-context.ts';
import { compareChecks } from '../src/comparison.ts';
import type { MavenCheckResult } from '../src/docker-maven.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultEvidence = path.join(root, '.taie-agent', 'live-maven', '2026-11-03T06-41-00-205Z-43f68278', 'project', '.taie-agent', 'maven-runs');
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const note = '历史 Maven 证据回放：仅重新生成统一报告与基线比较；未运行新的 Maven、Tai-e 或模型 API。';

async function main() {
  // Optional argument is a historical maven-runs directory from the staged live Maven fixture.
  const evidenceDir = path.resolve(process.argv[2] ?? defaultEvidence);
  const reports: { file: string; raw: MavenCheckResult }[] = [];
  for (const entry of (await readdir(evidenceDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(evidenceDir, entry.name, 'report.json');
    try { reports.push({ file, raw: JSON.parse(await readFile(file, 'utf8')) }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const before = reports.findLast(({ raw }) => raw.status === 'test_failed' && raw.analysis?.status === 'completed');
  const after = reports.findLast(({ raw }) => raw.status === 'passed' && raw.analysis?.status === 'completed');
  assert.ok(before && after, 'Historical fixture must include completed analysis with failed tests and a subsequent passing check.');
  assert.ok(before.file < after.file, 'The passing check must follow the failed check.');
  const originalPaths = [...new Set([before.file, after.file, before.raw.analysis!.reportPath, after.raw.analysis!.reportPath])];
  const originalHashes = Object.fromEntries(await Promise.all(originalPaths.map(async file => [file, sha256(await readFile(file))])));
  const directory = path.join(root, '.taie-agent', 'baseline-maven-replay', `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);

  async function replay(raw: MavenCheckResult, name: string): Promise<CheckResult> {
    const result = normalizeMavenCheck(raw);
    result.comparisonKey = await buildComparisonKey(raw.analysis!, raw);
    result.runDir = path.join(directory, name);
    result.reportPath = path.join(result.runDir, 'check.json');
    result.humanReportPath = path.join(result.runDir, 'check.md');
    result.limitations = [note, ...result.limitations];
    await mkdir(result.runDir, { recursive: true });
    return result;
  }
  const baseline = await replay(before.raw, 'baseline');
  const current = await replay(after.raw, 'current');
  current.comparison = compareChecks(baseline, current);
  assert.notEqual(baseline.sourceFingerprint, current.sourceFingerprint, 'This fixture must exercise changed Java sources.');
  assert.notEqual(baseline.snapshotFingerprint, current.snapshotFingerprint);
  assert.equal(baseline.comparisonKey, current.comparisonKey, 'Source edits must preserve compatible analysis context.');
  assert.equal(current.comparison.status, 'compared');
  assert.deepEqual(current.comparison.stageChanges.test, { before: 'failed', after: 'passed' });
  assert.deepEqual(current.comparison.counts, { added: 0, removed: 0, persisting: 0, changed: 0 });
  assert.equal(baseline.findingCounts.project, 0);
  assert.equal(current.findingCounts.project, 0);
  assert.equal(baseline.findingCounts.dependency, 0);
  assert.equal(current.findingCounts.dependency, 71);
  assert.equal(current.status, 'passed');
  await writeCheckReports(baseline);
  await writeCheckReports(current);
  assert.match(await readFile(current.humanReportPath, 'utf8'), /历史 Maven 证据回放/);
  for (const file of originalPaths) assert.equal(sha256(await readFile(file)), originalHashes[file], `Historical report changed: ${file}`);
  const resultPath = path.join(directory, 'result.json');
  await writeFile(resultPath, `${JSON.stringify({
    schemaVersion: 1, status: 'passed', mode: 'historical-evidence-replay', note,
    evidenceDir, originalHashes, originalsUnchanged: true,
    baselineReportPath: baseline.reportPath, currentReportPath: current.reportPath,
    currentHumanReportPath: current.humanReportPath, comparisonKey: current.comparisonKey,
    sourceFingerprints: { before: baseline.sourceFingerprint, after: current.sourceFingerprint },
    test: current.comparison.stageChanges.test, projectChanges: current.comparison.counts,
    dependencyCounts: { before: baseline.findingCounts.dependency, after: current.findingCounts.dependency },
  }, null, 2)}\n`, { flag: 'wx' });
  console.log(note);
  console.log(`Replay passed: ${resultPath}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
