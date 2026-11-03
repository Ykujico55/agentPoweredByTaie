import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { compareChecks } from '../src/comparison.ts';
import type { CheckResult } from '../src/check.ts';
import type { Finding } from '../src/taie.ts';

function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return { id, origin: 'project', analysis: 'null-pointer', type: 'NP_ALWAYS_NULL', severity: 'MAJOR',
    className: 'example.Main', method: '<example.Main: void run()>', message: 'LineNumber: 10, null dereference',
    ...overrides };
}

function report(name: string, findings: Finding[] = []): CheckResult {
  const projectDir = path.resolve('comparison-project');
  const runDir = path.join(projectDir, '.taie-agent', 'runs', name);
  return {
    schemaVersion: 1, backend: 'javac', status: 'tests_not_run', statusScope: 'project',
    projectDir, runDir, reportPath: path.join(runDir, 'check.json'), humanReportPath: path.join(runDir, 'check.md'),
    backendReportPath: path.join(runDir, 'report.json'), backendStatus: 'completed',
    analyses: ['null-pointer', 'dead-code'], comparisonKey: 'same-model-and-config',
    stages: { build: 'passed', test: { status: 'not_run', tests: 0, failures: 0, errors: 0, skipped: 0, reportFiles: [] },
      analysis: 'completed', review: 'not_run' },
    findings, findingCounts: { project: findings.length, dependency: 0, total: findings.length }, diagnostics: [], limitations: [],
  };
}

test('stable IDs retain findings when line numbers, snapshot paths and surrounding snippets move', () => {
  const baseline = report('before');
  const current = report('after');
  baseline.findings = [finding('stable', { sourcePath: path.join(baseline.runDir, 'snapshot/src/Main.java'), startLine: 10,
    message: `LineNumber: 10, null dereference (${baseline.runDir}/trace)`, snippet: '9: comment\n10: value.trim();',
    evidence: { kind: 'flow', sink: { line: 10, sourcePath: path.join(baseline.runDir, 'snapshot/src/Main.java'),
      className: 'example.Main', method: '<example.Main: void run()>', statement: '[2@L10] value.trim()' } } })];
  current.findings = [finding('stable', { sourcePath: path.join(current.runDir, 'snapshot/src/Main.java'), startLine: 20,
    message: `LineNumber: 20, null dereference (${current.runDir}/trace)`, snippet: '19: a different comment\n20: value.trim();',
    evidence: { sink: { method: '<example.Main: void run()>', className: 'example.Main', sourcePath: path.join(current.runDir, 'snapshot/src/Main.java'),
      line: 20, statement: '[7@L20] value.trim()' }, kind: 'flow' } })];
  current.analyses.reverse();
  const before = structuredClone([baseline, current]);
  const comparison = compareChecks(baseline, current);
  assert.equal(comparison.status, 'compared');
  assert.deepEqual(comparison.counts, { added: 0, removed: 0, persisting: 1, changed: 0 });
  assert.equal(comparison.persisting![0].before.startLine, 10);
  assert.equal(comparison.persisting![0].after.startLine, 20);
  assert.deepEqual([baseline, current], before, 'comparison must not rewrite either report or the raw evidence');
});

test('added, removed, persisting and changed findings are distinct and dependencies stay outside the comparison', () => {
  const baseline = report('before', [
    finding('stable'), finding('severity', { method: '<example.Main: void severity()>' }),
    finding('removed', { method: '<example.Main: void removed()>' }),
    finding('old-statement', { method: '<example.Main: void changed()>', message: 'value is 0' }),
    finding('dependency-before', { origin: 'dependency' }),
  ]);
  const current = report('after', [
    finding('stable'), finding('severity', { method: '<example.Main: void severity()>', severity: 'CRITICAL' }),
    finding('added', { method: '<example.Main: void added()>' }),
    finding('new-statement', { method: '<example.Main: void changed()>', message: 'value is 1' }),
    finding('dependency-after', { origin: 'dependency' }),
  ]);
  current.dependencyFindings = [finding('library-only', { origin: 'dependency' })];
  const comparison = compareChecks(baseline, current);
  assert.deepEqual(comparison.counts, { added: 1, removed: 1, persisting: 1, changed: 2 });
  assert.deepEqual(comparison.added!.map(item => item.id), ['added']);
  assert.deepEqual(comparison.removed!.map(item => item.id), ['removed']);
  assert.deepEqual(comparison.changed!.map(pair => [pair.before.id, pair.after.id]),
    [['severity', 'severity'], ['old-statement', 'new-statement']]);
  assert.match(comparison.limitations.join('\n'), /不证明缺陷已修复/);
  assert.match(comparison.limitations.join('\n'), /启发式/);
});

test('semantic constants and ordered evidence changes are retained even when the finding ID stays stable', () => {
  const baseline = report('before', [finding('stable', { evidence: { sink: { statement: 'line = 0' },
    path: [{ statement: 'input()' }, { statement: 'sink()' }] } })]);
  const current = report('after', [finding('stable', { evidence: { sink: { statement: 'line = 1' },
    path: [{ statement: 'sink()' }, { statement: 'input()' }] } })]);
  assert.deepEqual(compareChecks(baseline, current).counts, { added: 0, removed: 0, persisting: 0, changed: 1 });
});

test('ambiguous method candidates and missing logical locations are not forcibly matched', () => {
  const baseline = report('before', [finding('old-one'), finding('old-two'), finding('unknown-old', { method: undefined })]);
  const current = report('after', [finding('new-one'), finding('new-two'), finding('unknown-new', { method: undefined })]);
  assert.deepEqual(compareChecks(baseline, current).counts, { added: 3, removed: 3, persisting: 0, changed: 0 });
});

test('unavailable or incompatible analyses omit change counts instead of reporting that warnings disappeared', () => {
  for (const status of ['build_failed', 'analysis_failed', 'timeout', 'unsupported', 'error', 'stale'] as const) {
    const baseline = report('before', [finding('old')]);
    const current = report('after');
    current.status = status;
    let comparison = compareChecks(baseline, current);
    assert.equal(comparison.status, 'current_failed', status);
    assert.equal(comparison.counts, undefined);
    assert.equal(comparison.removed, undefined);
    comparison = compareChecks(current, baseline);
    assert.equal(comparison.status, 'baseline_failed', status);
    assert.equal(comparison.added, undefined);
  }
  for (const change of [
    (value: CheckResult) => { value.comparisonKey = undefined; },
    (value: CheckResult) => { value.comparisonKey = 'changed-environment'; },
    (value: CheckResult) => { value.analyses = ['dead-code']; },
    (value: CheckResult) => { value.backend = 'maven-docker'; },
    (value: CheckResult) => { value.projectDir = path.resolve('another-project'); },
  ]) {
    const baseline = report('before', [finding('old')]);
    const current = report('after');
    change(current);
    const comparison = compareChecks(baseline, current);
    assert.equal(comparison.status, 'incompatible');
    assert.equal(comparison.counts, undefined);
    assert.equal(comparison.removed, undefined);
  }
  const current = report('after');
  current.stages.analysis = 'failed';
  assert.equal(compareChecks(report('before'), current).status, 'current_failed');
});

test('completed static analysis remains comparable when tests fail and the test regression stays explicit', () => {
  const baseline = report('before');
  const current = report('after');
  baseline.backend = current.backend = 'maven-docker';
  baseline.status = 'passed';
  baseline.stages.test.status = 'passed';
  baseline.stages.test.tests = 1;
  current.status = 'test_failed';
  current.stages.test.status = 'failed';
  current.stages.test.tests = 1;
  current.stages.test.failures = 1;
  const comparison = compareChecks(baseline, current);
  assert.equal(comparison.status, 'compared');
  assert.equal(comparison.currentStatus, 'test_failed');
  assert.deepEqual(comparison.stageChanges.test, { before: 'passed', after: 'failed' });
  assert.deepEqual(comparison.counts, { added: 0, removed: 0, persisting: 0, changed: 0 });
  assert.equal(current.status, 'test_failed', 'comparison must not turn a test failure into a pass');
});
