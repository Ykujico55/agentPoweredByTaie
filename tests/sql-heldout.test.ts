import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, loadFrozenProtocol, type HeldoutCase } from '../scripts/probe-sql-heldout.ts';
import { buildHeldoutReviewInput, loadDatasetLock, summarizeHeldout, type HeldoutObservation } from '../scripts/review-sql-heldout.ts';
import { REVIEW_PROMPT_VERSION, REVIEW_SYSTEM_PROMPT } from '../src/review.ts';
import type { CheckResult } from '../src/check.ts';

async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const base = path.resolve('.taie-agent/heldout-tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'case-'));
  t.after(async () => { assert.equal(path.dirname(await realpath(directory)), await realpath(base)); await rm(directory, { recursive: true }); });
  const write = async (relative: string, bytes: string) => {
    const file = path.join(directory, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); return file;
  };
  return { directory, write };
}

test('held-out freezes reject changed implementations, prompts and dataset locks before a request', async t => {
  const { directory, write } = await temporary(t);
  const implementation = await write('frozen.ts', 'ORIGINAL_IMPLEMENTATION');
  await write('system.txt', REVIEW_SYSTEM_PROMPT);
  const protocol = await write('protocol.json', JSON.stringify({ promptVersion: REVIEW_PROMPT_VERSION,
    systemPromptSha256: digest(REVIEW_SYSTEM_PROMPT), systemPromptFile: 'system.txt',
    frozenFiles: { 'frozen.ts': digest('ORIGINAL_IMPLEMENTATION') }, maxRetries: 0, maxTokens: 4096 }));
  const frozen = await loadFrozenProtocol(protocol, directory);
  await frozen.verify();
  await writeFile(implementation, 'changed');
  await assert.rejects(frozen.verify(), /implementation changed/);
  await assert.rejects(loadFrozenProtocol(protocol, directory), /implementation changed/);
  await writeFile(implementation, 'ORIGINAL_IMPLEMENTATION');
  await write('system.txt', REVIEW_SYSTEM_PROMPT + '\n');
  await assert.rejects(loadFrozenProtocol(protocol, directory), /prompt bytes changed/);
  await write('source.java', 'ORIGINAL_SOURCE');
  const lockFile = await write('dataset-lock.json', JSON.stringify({ fixtureHashes: { 'source.java': digest('ORIGINAL_SOURCE') }, runnerHashes: {} }));
  const locked = await loadDatasetLock(lockFile, directory);
  await write('source.java', 'CHANGED_SOURCE');
  await assert.rejects(locked.verify(), /dataset or runner changed/);
});

test('held-out evidence supplies only hash-matched selected code and original finding, excluding truth and tests', async t => {
  const { directory, write } = await temporary(t);
  const projectDir = path.join(directory, 'project');
  const runDir = path.join(projectDir, '.taie-agent/maven-runs/recorded');
  const snapshotRelative = 'project/.taie-agent/maven-runs/recorded/snapshot/project';
  const sources = { 'example/CaseG.java': 'class CaseG { void execute() { /* FULL_RECORDED_G */ } }',
    'example/Main.java': 'class Main { /* RECORDED_MAIN */ }', 'example/CaseH.java': 'UNSELECTED_SOURCE' };
  for (const [file, text] of Object.entries(sources)) await write(`${snapshotRelative}/src/main/java/${file}`, text);
  await write('project/src/main/java/example/CaseG.java', 'CURRENT_MUTABLE_SOURCE');
  await write(`${snapshotRelative}/src/test/java/Test.java`, 'SECRET_TEST_LABEL');
  await write(`${snapshotRelative}/oracle.json`, 'SECRET_ORACLE_LABEL');
  const policy = 'call-site-mode: true\nsources: []\nsinks: []\n';
  await write(`${snapshotRelative}/taint.yml`, policy);
  const check: CheckResult = {
    schemaVersion: 1, backend: 'maven-docker', status: 'findings', statusScope: 'project', projectDir, runDir,
    reportPath: path.join(runDir, 'check.json'), humanReportPath: path.join(runDir, 'check.md'),
    backendReportPath: path.join(runDir, 'report.json'), backendStatus: 'findings', analyses: ['taint'],
    sourceFingerprint: 'original-source', snapshotFingerprint: 'original-snapshot',
    stages: { build: 'passed', test: { status: 'passed', tests: 6, failures: 0, errors: 0, skipped: 0, reportFiles: [] }, analysis: 'completed', review: 'not_run' },
    findings: [{ id: 'finding-G', origin: 'project', analysis: 'taint', type: 'TAINT_FLOW', className: 'example.CaseG', message: 'Recorded taint',
      snippet: 'executeQuery(query);', evidence: { path: [{ statement: 'ORIGINAL_PATH' }] } },
    { id: 'finding-H', origin: 'project', analysis: 'taint', type: 'TAINT_FLOW', className: 'example.CaseH', message: 'UNSELECTED_FINDING' }],
    findingCounts: { project: 2, dependency: 0, total: 2 }, diagnostics: [], limitations: [],
  };
  await write('project/.taie-agent/maven-runs/recorded/check.json', JSON.stringify(check));
  await write('project/.taie-agent/maven-runs/recorded/report.json', JSON.stringify({ schemaVersion: 2, runDir,
    snapshotFingerprint: check.snapshotFingerprint, analysis: { sourceFingerprint: check.sourceFingerprint, taintConfiguration: { sha256: digest(policy) } } }));
  const probePath = await write('result.json', JSON.stringify({ status: 'completed', projectDir, check,
    cases: [{ truth: 'SECRET_TRUTH_LABEL', basis: 'SECRET_PROOF_LABEL' }], oracle: 'SECRET_OBSERVATIONS',
    inputs: { sourceManifest: Object.entries(sources).map(([relativePath, content]) => ({ relativePath, sha256: digest(content) })), policySha256: digest(policy) } }));
  const input = await buildHeldoutReviewInput(probePath, 'G', 'finding-G');
  assert.match(input.prompt, /FULL_RECORDED_G/); assert.match(input.prompt, /RECORDED_MAIN/);
  assert.doesNotMatch(input.prompt, /SECRET_|UNSELECTED_|CURRENT_MUTABLE_SOURCE/);
  const finding = JSON.parse(input.prompt).evidence.find((item: { id: string }) => item.id === 'finding').data;
  assert.deepEqual(finding.evidence, check.findings[0].evidence);
  assert.equal(await input.verifyUnchanged(), true);
  await write(`${snapshotRelative}/src/main/java/example/CaseG.java`, 'CHANGED_SNAPSHOT');
  assert.equal(await input.verifyUnchanged(), false);
  await assert.rejects(buildHeldoutReviewInput(probePath, 'G', 'finding-G'), /source changed/);
  assert.equal(JSON.parse(await readFile(check.reportPath, 'utf8')).status, 'findings');
});

test('classification denominators retain abstentions and invalid replies and separate missing findings', () => {
  const cases: HeldoutCase[] = ['G', 'H', 'I', 'J', 'K', 'L'].map((id, index) => ({
    id, className: `example.Case${id}`, truth: index % 2 ? 'safe_under_stated_assumptions' : 'vulnerable',
    basis: 'Independent proof', actualFindingCount: id === 'L' ? 0 : 1,
    findingIds: id === 'L' ? [] : [`finding-${id}`], reviewEligibility: id === 'L' ? 'not_reported' : 'eligible',
  }));
  const raw = ['true_positive', 'suspected_false_positive', 'analysis_incomplete', 'suspected_false_positive', 'suspected_false_positive'];
  const rows: HeldoutObservation[] = cases.slice(0, 5).map((item, index) => ({ caseId: item.id, findingId: item.findingIds[0], truth: item.truth,
    status: index === 3 ? 'failed' : 'completed', rawAssessment: raw[index],
    normalized: index === 3 ? undefined : { findingId: item.findingIds[0], assessment: raw[index], ruleClaim: 'rule', rationale: 'reason',
      evidenceRefs: ['finding'], coverage: 'whole_finding', assumptions: [], missingEvidence: [] } as HeldoutObservation['normalized'],
    requestAttempted: true, diagnostics: [], response: { text: 'saved response', stopReason: 'stop', provider: 'test', model: 'test', usage: { totalTokens: 10 } } }));
  const metrics = summarizeHeldout(cases, rows);
  assert.equal(metrics.plannedCases, 6); assert.deepEqual(metrics.notReportedCases, ['L']);
  assert.deepEqual(metrics.raw.primaryAccuracy, { numerator: 2, denominator: 5, rate: 0.4 });
  assert.deepEqual(metrics.raw.decisionAccuracy, { numerator: 2, denominator: 3, rate: 2 / 3 });
  assert.equal(metrics.raw.abstentions, 1); assert.equal(metrics.failed, 1);
  assert.equal(metrics.raw.confusion.trueAsFalse, 1); assert.equal(metrics.rawFalsePositiveSuggestionsOnVulnerable, 1);
  assert.equal(metrics.usage.totals.totalTokens, 50); assert.equal(metrics.responsesReceived, 5);
});
