import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { checkProject, normalizeJavacCheck, normalizeMavenCheck, renderCheckResult } from '../src/check.ts';
import type { AnalysisReport, Finding } from '../src/taie.ts';
import type { MavenCheckResult } from '../src/docker-maven.ts';

const projectFinding: Finding = { id: 'project-bug', analysis: 'dead-code', type: 'DEAD_CODE',
  className: 'example.Main$Inner', message: 'dead code' };
const dependencyFinding: Finding = { ...projectFinding, id: 'library-bug', className: 'org.library.Utility' };

function analysis(): AnalysisReport {
  const runDir = path.resolve('example-project', '.taie-agent', 'runs', 'example');
  return {
    schemaVersion: 2, status: 'completed', runId: 'example', projectDir: path.resolve('example-project'),
    runDir, reportPath: path.join(runDir, 'report.json'), startedAt: '2026-11-03T00:00:00Z', durationMs: 100,
    findings: [], diagnostics: [], limitations: ['Empty output is not proof of correctness.'],
    sourceRoots: ['src/main/java'], sourceFiles: ['src/main/java/example/Main.java'], classpath: [], analyses: ['dead-code'],
    taiE: { artifactKind: 'official-release', baselineVersion: '0.5.4', jarPath: 'taie.jar' }, evidence: {},
  };
}

function maven(): MavenCheckResult {
  const raw = analysis();
  raw.findingScope = 'project';
  raw.findingCounts = { project: 0, dependency: 71, total: 71 };
  return {
    schemaVersion: 2, status: 'passed', statusScope: 'project', includeDependencies: false,
    projectDir: raw.projectDir, runDir: raw.runDir, reportPath: raw.reportPath, image: 'fixed-image',
    storage: { backend: 'docker-volumes', repositoryVolume: 'repository' },
    dependencyNetwork: false, checkNetwork: 'none', review: 'not_run', diagnostics: [], analysis: raw,
    maven: { status: 'completed', build: 'passed', test: {
      status: 'passed', tests: 1, failures: 0, errors: 0, skipped: 0, reportFiles: ['TEST-example.Main.xml'],
    }, versions: {}, stages: [], diagnostics: [], reportPath: 'maven.json', durationMs: 50 },
  };
}

test('a passing Maven check retains dependency counts without letting library findings fail the project', () => {
  const raw = maven();
  const before = structuredClone(raw);
  const check = normalizeMavenCheck(raw);
  assert.equal(check.status, 'passed');
  assert.equal(check.stages.review, 'not_run');
  assert.deepEqual(check.findingCounts, { project: 0, dependency: 71, total: 71 });
  assert.equal(check.dependencyFindings, undefined);
  assert.equal(check.backendReportPath, raw.reportPath);
  assert.equal(check.reportPath, path.join(raw.runDir, 'check.json'));
  assert.deepEqual(raw, before, 'normalization must not rewrite original evidence');

  raw.analysis!.dependencyFindings = [{ ...dependencyFinding, origin: 'dependency' }];
  assert.equal(normalizeMavenCheck(raw).status, 'passed');
  assert.match(renderCheckResult(normalizeMavenCheck(raw)), /\[dependency\]/);
  raw.analysis!.findings = [{ ...projectFinding, origin: 'project' }];
  raw.analysis!.findingCounts = { project: 1, dependency: 71, total: 72 };
  const findingCheck = normalizeMavenCheck(raw);
  assert.equal(findingCheck.status, 'findings');
  assert.equal(findingCheck.backendStatus, 'passed');
  assert.match(renderCheckResult(findingCheck), /ID: project-bug/);
  assert.match(renderCheckResult(findingCheck), /\/review <告警ID>/);
});

test('zero findings cannot override unsuccessful backend status or failed, unrun or incomplete stages', () => {
  for (const status of ['findings', 'build_failed', 'test_failed', 'tests_not_run', 'analysis_failed', 'unsupported', 'timeout', 'error', 'stale'] as const) {
    const raw = maven();
    raw.status = status;
    assert.equal(normalizeMavenCheck(raw).status, status);
  }
  const failedTest = maven();
  failedTest.maven!.test.status = 'failed';
  failedTest.maven!.test.failures = 1;
  assert.equal(normalizeMavenCheck(failedTest).status, 'test_failed');
  const noTests = maven();
  noTests.maven!.test.status = 'not_run';
  noTests.maven!.test.tests = 0;
  assert.equal(normalizeMavenCheck(noTests).status, 'tests_not_run');
  const failedBuild = maven();
  failedBuild.maven!.build = 'failed';
  assert.equal(normalizeMavenCheck(failedBuild).status, 'build_failed');
  const failedAnalysis = maven();
  failedAnalysis.analysis!.status = 'analysis_failed';
  assert.equal(normalizeMavenCheck(failedAnalysis).status, 'analysis_failed');
  delete failedAnalysis.analysis;
  assert.equal(normalizeMavenCheck(failedAnalysis).stages.analysis, 'not_run');
  assert.equal(normalizeMavenCheck(failedAnalysis).status, 'analysis_failed');
  const unscoped = maven();
  delete unscoped.analysis!.findingScope;
  assert.equal(normalizeMavenCheck(unscoped).status, 'error');
});

test('javac partitions actual project classes but cannot claim passed without project tests', () => {
  const raw = analysis();
  raw.findings = [projectFinding, dependencyFinding];
  const before = structuredClone(raw);
  const classes = new Set(['example.Main', 'example.Main$Inner']);
  const check = normalizeJavacCheck(raw, undefined, classes);
  assert.equal(check.status, 'tests_not_run');
  assert.equal(check.stages.build, 'passed');
  assert.equal(check.stages.analysis, 'completed');
  assert.equal(check.stages.test.status, 'not_run');
  assert.deepEqual(check.findings.map(f => [f.id, f.origin]), [['project-bug', 'project']]);
  assert.deepEqual(check.findingCounts, { project: 1, dependency: 1, total: 2 });
  assert.equal(check.dependencyFindings, undefined);
  assert.deepEqual(raw, before);
  assert.equal(normalizeJavacCheck(raw, undefined, classes, true).dependencyFindings![0].origin, 'dependency');
  raw.findings = [];
  assert.equal(normalizeJavacCheck(raw, undefined, classes).status, 'tests_not_run');
});

test('javac preflight failure is not a successful build and compilation cancellation is distinct', () => {
  const raw = analysis();
  raw.status = 'analysis_failed';
  const preflight = normalizeJavacCheck(raw, undefined, new Set());
  assert.equal(preflight.stages.build, 'not_run');
  assert.equal(preflight.stages.analysis, 'failed');
  assert.equal(preflight.status, 'analysis_failed');
  assert.equal(normalizeJavacCheck(raw, { code: 0, stopped: false, tail: '', durationMs: 1 }, new Set()).stages.build, 'passed');
  raw.status = 'timeout';
  const cancelled = normalizeJavacCheck(raw, { code: null, stopped: true, tail: 'cancelled', durationMs: 1 }, new Set());
  assert.equal(cancelled.status, 'timeout');
  assert.equal(cancelled.stages.build, 'timeout');
  assert.equal(cancelled.stages.analysis, 'not_run');
});

test('host check writes a separate result for real preflight failure without a model or repair session', async () => {
  const base = path.resolve('.taie-agent', 'check-tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'project-'));
  try {
    const check = await checkProject({ projectDir: directory, jarPath: path.join(directory, 'missing.jar') });
    assert.equal(check.backend, 'javac');
    assert.equal(check.status, 'analysis_failed');
    assert.equal(check.stages.build, 'not_run');
    assert.equal(check.stages.review, 'not_run');
    const stored = JSON.parse(await readFile(check.reportPath, 'utf8'));
    assert.deepEqual(stored, JSON.parse(JSON.stringify(check)));
    assert.equal(check.humanReportPath, path.join(check.runDir, 'check.md'));
    const markdown = await readFile(check.humanReportPath, 'utf8');
    assert.match(markdown, /analysis_failed/);
    assert.match(markdown, /check\.json/);
    assert.ok(renderCheckResult(check).includes(check.humanReportPath));
    const raw = JSON.parse(await readFile(check.backendReportPath, 'utf8'));
    assert.equal(raw.schemaVersion, 2);
    assert.equal(raw.status, 'analysis_failed');
    assert.equal(raw.backend, undefined);
    assert.deepEqual(await readdir(path.join(directory, '.taie-agent')), ['runs']);
  } finally {
    assert.equal(path.dirname(await realpath(directory)), await realpath(base));
    await rm(directory, { recursive: true, force: true });
  }
});
