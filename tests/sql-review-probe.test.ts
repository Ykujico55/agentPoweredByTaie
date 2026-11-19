import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSqlReviewInput, summarizeSqlReviewObservations } from '../scripts/review-sql-probe.ts';
import type { CheckResult } from '../src/check.ts';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function fixture(t: TestContext) {
  const base = path.resolve('.taie-agent/sql-review-probe-tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'case-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(directory)), await realpath(base));
    await rm(directory, { recursive: true, force: true });
  });
  const projectDir = path.join(directory, 'project');
  const runDir = path.join(projectDir, '.taie-agent/maven-runs/recorded');
  const snapshot = path.join(runDir, 'snapshot/project');
  const sources = {
    'example/CaseA.java': 'class CaseA { String execute(String value) { return "SELECT".concat(value); } }',
    'example/CaseB.java': 'class CaseB { private static String identity(String value) { return value; } }',
    'example/CaseC.java': 'UNSELECTED_CASE_SOURCE',
    'example/CaseE.java': 'class CaseE { class Helper { String stored; String apply(String value) { if (stored == null) stored = value; return stored; } } }',
    'example/CaseF.java': 'class CaseF { class Helper { String apply(String value) { return value; } } }',
    'example/Main.java': 'class Main { static void entry() { /* RECORDED_ENTRY */ } }',
  };
  const write = async (file: string, content: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); };
  for (const [relativePath, content] of Object.entries(sources)) await write(path.join(snapshot, 'src/main/java', relativePath), content);
  await write(path.join(projectDir, 'src/main/java/example/CaseB.java'), 'MUTABLE_CURRENT_SOURCE');
  const policy = 'call-site-mode: true\nsources: []\nsinks: []\n';
  await write(path.join(snapshot, 'taint.yml'), policy);
  await write(path.join(snapshot, 'src/test/java/example/QueryBehaviorTest.java'), 'SECRET_TEST_ASSERTION_LABEL');
  const check: CheckResult = {
    schemaVersion: 1, backend: 'maven-docker', status: 'findings', statusScope: 'project', projectDir, runDir,
    reportPath: path.join(runDir, 'check.json'), humanReportPath: path.join(runDir, 'check.md'),
    backendReportPath: path.join(runDir, 'report.json'), backendStatus: 'findings', analyses: ['taint'],
    sourceFingerprint: 'sources-original', snapshotFingerprint: 'snapshot-original',
    stages: { build: 'passed', test: { status: 'passed', tests: 4, failures: 0, errors: 0, skipped: 0, reportFiles: [] },
      analysis: 'completed', review: 'not_run' },
    findings: ['A', 'B', 'E', 'F'].map(id => ({ id: `finding-${id}`, origin: 'project', analysis: 'taint', type: 'TAINT_FLOW', className: `example.Case${id}`,
      message: 'Recorded abstract flow', snippet: `Case${id}.executeQuery(query);`, evidence: { path: [{ statement: 'RECORDED_PATH_NODE' }] } })),
    findingCounts: { project: 4, dependency: 0, total: 4 }, diagnostics: [], limitations: ['Original analysis limitation.'],
  };
  await write(check.reportPath, JSON.stringify(check));
  await write(check.backendReportPath, JSON.stringify({ schemaVersion: 2, runDir, snapshotFingerprint: check.snapshotFingerprint,
    analysis: { sourceFingerprint: check.sourceFingerprint, taintConfiguration: { sha256: digest(policy) } } }));
  const probe = { status: 'completed', projectDir, check,
    cases: [{ id: 'B', truth: 'SECRET_TRUTH_LABEL', basis: 'SECRET_PROOF_LABEL' }], oracle: 'SECRET_ORACLE_OBSERVATION',
    inputs: { sourceManifest: Object.entries(sources).map(([relativePath, content]) => ({ relativePath, sha256: digest(content) })),
      policySha256: digest(policy), independentOracleSource: 'SECRET_ORACLE_PATH' } };
  const probePath = path.join(directory, 'result.json');
  await write(probePath, JSON.stringify(probe));
  return { probePath, probe, snapshot, sources, projectDir, write };
}

test('SQL full evidence uses only hash-matched snapshot sources and policy without investigator labels', async t => {
  const f = await fixture(t);
  const input = await buildSqlReviewInput(f.probePath, 'B', 'full');
  assert.match(input.prompt, /private static String identity/);
  assert.match(input.prompt, /RECORDED_ENTRY/);
  assert.match(input.prompt, /call-site-mode/);
  assert.doesNotMatch(input.prompt, /SECRET_|UNSELECTED_CASE_SOURCE|MUTABLE_CURRENT_SOURCE|finding-A/);
  assert.deepEqual(input.manifest.includedSourceFiles.map(file => file.relativePath), ['src/main/java/example/CaseB.java', 'src/main/java/example/Main.java']);
  assert.equal(input.manifest.currentWorkspace, 'not_checked');
  assert.equal(await input.verifyUnchanged(), true);
  await f.write(path.join(f.projectDir, 'src/main/java/example/CaseB.java'), 'Changed current source');
  assert.equal(await input.verifyUnchanged(), true);
  const repeated = await buildSqlReviewInput(f.probePath, 'B', 'full');
  assert.equal(input.prompt, repeated.prompt, 'Current workspace changes cannot change recorded review evidence.');
});

test('SQL recorded-only view preserves original snippet and path but does not supply helper or caller implementation', async t => {
  const f = await fixture(t);
  const input = await buildSqlReviewInput(f.probePath, 'B', 'recorded_only');
  const packet = JSON.parse(input.prompt);
  const finding = packet.evidence.find((item: { id: string }) => item.id === 'finding').data;
  assert.equal(finding.snippet, f.probe.check.findings[1].snippet);
  assert.deepEqual(finding.evidence, f.probe.check.findings[1].evidence);
  assert.match(input.prompt, /call-site-mode/);
  assert.doesNotMatch(input.prompt, /private static String identity|RECORDED_ENTRY|SECRET_|expected|弃权/);
  assert.deepEqual(input.manifest.includedSourceFiles, []);
  assert.ok(input.manifest.omittedSourceFiles.includes('src/main/java/example/CaseB.java'));
});

test('SQL evidence rejects changed snapshots, policies or checks rather than trusting mutable manifests', async t => {
  const f = await fixture(t);
  const sourcePath = path.join(f.snapshot, 'src/main/java/example/CaseB.java');
  await f.write(sourcePath, 'changed helper');
  await assert.rejects(buildSqlReviewInput(f.probePath, 'B', 'full'), /Snapshot differs/);
  await f.write(sourcePath, f.sources['example/CaseB.java']);
  const policyPath = path.join(f.snapshot, 'taint.yml');
  const policy = await readFile(policyPath, 'utf8');
  await f.write(policyPath, 'changed policy');
  await assert.rejects(buildSqlReviewInput(f.probePath, 'B', 'recorded_only'), /policy/);
  await f.write(policyPath, policy);
  const input = await buildSqlReviewInput(f.probePath, 'A', 'full');
  await f.write(f.probe.check.reportPath, JSON.stringify({ ...f.probe.check, status: 'passed' }));
  assert.equal(await input.verifyUnchanged(), false);
  await assert.rejects(buildSqlReviewInput(f.probePath, 'A', 'full'), /Stored check differs/);
});

test('stateful and neutral helper views expose full implementation only when selected, without changing recorded paths', async t => {
  const f = await fixture(t);
  for (const caseId of ['E', 'F'] as const) {
    const full = await buildSqlReviewInput(f.probePath, caseId, 'full');
    const partial = await buildSqlReviewInput(f.probePath, caseId, 'recorded_only');
    const fullPacket = JSON.parse(full.prompt);
    const partialPacket = JSON.parse(partial.prompt);
    const finding = (packet: typeof fullPacket) => packet.evidence.find((item: { id: string }) => item.id === 'finding').data;
    assert.equal(fullPacket.evidence.find((item: { id: string }) => item.id === 'context').data.sourceFiles[0].content,
      f.sources[`example/Case${caseId}.java`]);
    assert.deepEqual(finding(partialPacket), finding(fullPacket));
    assert.doesNotMatch(partial.prompt, /String apply|String stored|RECORDED_ENTRY|SECRET_|expected|vulnerable/);
    assert.doesNotMatch(full.prompt, /SECRET_|expected|vulnerable/);
    assert.deepEqual(full.manifest.includedSourceFiles.map(file => file.relativePath),
      [`src/main/java/example/Case${caseId}.java`, 'src/main/java/example/Main.java']);
    assert.deepEqual(partial.manifest.includedSourceFiles, []);
    assert.equal(full.manifest.promptVersion, partial.manifest.promptVersion);
    assert.match(full.manifest.systemPromptSha256, /^[a-f\d]{64}$/);
  }
});

test('grading counts a false-positive suggestion on vulnerable E even in a partial view and retains usage for rejected replies', () => {
  const result = summarizeSqlReviewObservations([
    { name: 'E_recorded_only', caseId: 'E', status: 'failed', expected: ['unknown', 'analysis_incomplete'],
      rawAssessment: 'suspected_false_positive', rawMatchesExpected: false, diagnostics: [], requestAttempted: true,
      response: { text: '{"assessment":"suspected_false_positive","extra":true}', stopReason: 'stop', provider: 'test', model: 'test',
        usage: { input: 100, output: 30, cacheRead: 20, totalTokens: 150 } } },
    { name: 'F_full', caseId: 'F', status: 'failed', expected: ['suspected_false_positive'],
      rawAssessment: 'suspected_false_positive', rawMatchesExpected: true, diagnostics: [], requestAttempted: true,
      response: { text: 'invalid schema', stopReason: 'stop', provider: 'test', model: 'test',
        usage: { input: 90, output: 10, cacheRead: 0, totalTokens: 100 } } },
    { name: 'B_full', caseId: 'B', status: 'failed', expected: ['suspected_false_positive'], diagnostics: [] },
  ]);
  assert.equal(result.trueFindingFalsePositiveSuggestions, 1);
  assert.equal(result.rawExpectedMatches, 1);
  assert.equal(result.completed, 0);
  assert.equal(result.attemptedViews, 3);
  assert.equal(result.requestsAttempted, 2);
  assert.equal(result.responsesReceived, 2);
  assert.equal(result.usage.totals.totalTokens, 250);
  assert.equal(result.usage.responsesWithUsage, 2);
});
