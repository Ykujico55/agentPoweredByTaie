import test from 'node:test';
import assert from 'node:assert/strict';
import { findingEvidence } from '../src/check.ts';
import type { CheckResult } from '../src/check.ts';

function report(): CheckResult {
  return {
    schemaVersion: 1, backend: 'maven-docker', status: 'test_failed', statusScope: 'project',
    projectDir: '/project', runDir: '/evidence/run', reportPath: '/evidence/run/check.json',
    humanReportPath: '/evidence/run/check.md', backendReportPath: '/evidence/run/report.json',
    analysisReportPath: '/evidence/run/analysis/report.json', backendStatus: 'test_failed',
    sourceFingerprint: 'sources-at-check', snapshotFingerprint: 'project-at-check', analyses: ['null-pointer'],
    stages: { build: 'passed', test: { status: 'failed', tests: 1, failures: 1, errors: 0, skipped: 0, reportFiles: [] },
      analysis: 'completed', review: 'not_run' },
    findings: [{ id: 'project-id', origin: 'project', analysis: 'null-pointer', type: 'NP_ALWAYS_NULL',
      className: 'example.Main', message: 'Project evidence', evidence: { sink: { line: 10, statement: 'value.trim()' } } }],
    dependencyFindings: [{ id: 'dependency-id', origin: 'dependency', analysis: 'null-pointer', type: 'NP_ALWAYS_NULL',
      className: 'library.Helper', message: 'Library evidence' }],
    findingCounts: { project: 1, dependency: 1, total: 2 }, diagnostics: [], limitations: [],
  };
}

test('finding lookup defaults to project evidence and preserves check stages and snapshot identity', () => {
  const check = report();
  const before = structuredClone(check);
  const result = findingEvidence(check);
  assert.equal(result.origin, 'project');
  assert.deepEqual(result.findings, check.findings);
  assert.equal(result.status, 'test_failed');
  assert.equal(result.stages.test.status, 'failed');
  assert.equal(result.sourceFingerprint, 'sources-at-check');
  assert.equal(result.snapshotFingerprint, 'project-at-check');
  assert.equal(result.analysisReportPath, check.analysisReportPath);
  assert.equal(result.humanReportPath, check.humanReportPath);
  assert.equal(findingEvidence(check, { id: 'dependency-id' }).totalMatches, 0);
  const dependency = findingEvidence(check, { origin: 'dependency', id: 'dependency-id', limit: 1 });
  assert.equal(dependency.detailsIncluded, true);
  assert.deepEqual(dependency.findings, check.dependencyFindings);
  assert.deepEqual(check, before);
});

test('hidden dependency details are unavailable rather than an empty successful review', () => {
  const check = report();
  delete check.dependencyFindings;
  const dependency = findingEvidence(check, { origin: 'dependency' });
  assert.equal(dependency.detailsIncluded, false);
  assert.equal(dependency.totalRecorded, 1);
  assert.equal(dependency.totalMatches, 0);
  assert.deepEqual(dependency.findings, []);
  assert.match(dependency.message ?? '', /hidden by the host/);
  assert.equal(dependency.stages.review, 'not_run');
});
