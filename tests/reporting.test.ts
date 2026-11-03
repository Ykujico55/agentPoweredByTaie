import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeFindings, toSarif, writeStructuredOutputs } from '../src/reporting.ts';
import type { AnalysisReport, Finding } from '../src/taie.ts';

const projectDir = path.resolve('sample-project');
function finding(overrides: Partial<Finding> & Record<string, unknown> = {}): Finding {
  return { id: 'raw-id', analysis: 'null-pointer', type: 'NULL_DEREFERENCE', severity: 'MAJOR',
    className: 'example.Main', method: '<example.Main: void main(java.lang.String[])>',
    sourcePath: path.join(projectDir, 'src', 'Main.java'), startLine: 7, endLine: 7,
    message: 'LineNumber: 7, possible null dereference', ...overrides };
}
function report(findings: Finding[] = [], overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    schemaVersion: 2, runId: 'test-run', status: 'completed', projectDir,
    findings, reportPath: path.join(projectDir, '.taie-agent', 'runs', 'test-run', 'report.json'),
    runDir: path.join(projectDir, '.taie-agent', 'runs', 'test-run'), diagnostics: [], limitations: ['Pattern checks only.'],
    startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '2026-10-21T10:00:01.000Z',
    sourceFiles: [], sourceRoots: [path.join(projectDir, 'src')], classpath: [], analyses: ['null-pointer'],
    sourceFingerprint: 'test-source-fingerprint',
    taiE: { artifactKind: 'official-release', baselineVersion: '0.5.4', expectedVersion: '0.5.4', version: '0.5.4', jarPath: '/unused.jar' },
    evidence: {}, ...overrides,
  };
}

test('finding identities survive checkout moves, run changes and location-only line shifts without altering raw findings', () => {
  const firstRoot = path.resolve('checkout-one');
  const secondRoot = path.resolve('checkout-two');
  const before = finding({ sourcePath: path.join(firstRoot, 'src', 'Main.java'),
    message: `LineNumber: 7---8, possible null dereference (${firstRoot}/.taie-agent/runs/first-run/trace)` });
  const after = finding({ sourcePath: path.join(secondRoot, 'src', 'Main.java'), startLine: 17, endLine: 18,
    message: `LineNumber: 17---18, possible null dereference (${secondRoot}/.taie-agent/runs/other-run/trace)` });
  const [a] = normalizeFindings([before], firstRoot);
  const [b] = normalizeFindings([after], secondRoot);
  assert.equal(a.id, b.id);
  assert.equal(before.id, 'raw-id');
  assert.equal(before.message.includes('LineNumber: 7---8'), true);
  assert.equal(a.ruleId, 'null-pointer/NULL_DEREFERENCE');
  assert.notEqual(normalizeFindings([finding({ message: 'value is 0' })], projectDir)[0].id,
    normalizeFindings([finding({ message: 'value is 1' })], projectDir)[0].id, 'semantic constants must remain part of identity');
  assert.notEqual(normalizeFindings([finding({ evidence: { sink: { statement: 'line = 0' } } })], projectDir)[0].id,
    normalizeFindings([finding({ evidence: { sink: { statement: 'line = 1' } } })], projectDir)[0].id,
    'a variable called line must not turn a semantic constant into a location annotation');
});

test('two identical statements in one method receive distinct, order-independent occurrence identities', () => {
  const first = finding({ startLine: 10, endLine: 10, message: 'LineNumber: 10, dereference value' });
  const second = finding({ startLine: 30, endLine: 30, message: 'LineNumber: 30, dereference value' });
  const ids = normalizeFindings([first, second], projectDir).map(item => item.id);
  assert.notEqual(ids[0], ids[1]);
  const shifted = normalizeFindings([
    { ...second, startLine: 40, endLine: 40, message: 'LineNumber: 40, dereference value' },
    { ...first, startLine: 20, endLine: 20, message: 'LineNumber: 20, dereference value' },
  ], projectDir).map(item => item.id);
  assert.deepEqual(shifted, [ids[1], ids[0]]);
});

test('SARIF source URIs are encoded relative to the project, external files use absolute file URIs, and line regions stay valid', () => {
  const sourcePath = path.join(projectDir, 'src', 'Hello world#中文.java');
  const outside = path.resolve(projectDir, '..', 'external folder', 'Other.java');
  const sarif = toSarif(report(normalizeFindings([
    finding({ sourcePath, severity: 'HIGH', startLine: 5, endLine: 9 }),
    finding({ sourcePath: outside, severity: 'NORMAL', startLine: -1, endLine: 0 }),
  ], projectDir)));
  assert.equal(sarif.version, '2.1.0');
  const run = sarif.runs[0];
  assert.equal(run.originalUriBaseIds['%SRCROOT%'].uri, pathToFileURL(projectDir + path.sep).href);
  const first = run.results[0];
  assert.equal(first.locations?.[0].physicalLocation?.artifactLocation.uri, 'src/Hello%20world%23%E4%B8%AD%E6%96%87.java');
  assert.equal(first.locations?.[0].physicalLocation?.artifactLocation.uriBaseId, '%SRCROOT%');
  assert.deepEqual(first.locations?.[0].physicalLocation?.region, { startLine: 5, endLine: 9 });
  assert.equal(first.level, 'error');
  assert.equal(run.results[1].level, 'warning');
  assert.equal(run.results[1].locations?.[0].physicalLocation?.artifactLocation.uri, pathToFileURL(outside).href);
  assert.equal(run.results[1].locations?.[0].physicalLocation?.region, undefined);
  assert.equal(run.results[1].locations?.[0].physicalLocation?.artifactLocation.uriBaseId, undefined);
});

test('taint evidence exports reported source, intermediate point and sink without inventing a runtime trace', () => {
  const source = { sourcePath: path.join(projectDir, 'src', 'Input.java'), className: 'Input', line: 4, statement: 'readInput()' };
  const middle = { sourcePath: path.join(projectDir, 'src', 'Transform.java'), className: 'Transform', line: 9, statement: 'value = input' };
  const sink = { sourcePath: path.join(projectDir, 'src', 'Output.java'), className: 'Output', line: 15, statement: 'execute(value)' };
  const evidence = { kind: 'taint-flow', source, sink, path: [source, middle, sink], extraRawDetail: { preserved: true } };
  const result = toSarif(report(normalizeFindings([finding({ analysis: 'pta', type: 'TAINT_FLOW', confidence: 'medium',
    sourcePath: sink.sourcePath, startLine: sink.line, evidence })], projectDir))).runs[0].results[0];
  assert.equal(result.relatedLocations?.length, 2);
  assert.match(result.relatedLocations![0].message!.text, /^Source:/);
  assert.match(result.relatedLocations![1].message!.text, /^Sink:/);
  const flow = result.codeFlows![0];
  assert.match(flow.message.text, /Static analysis/);
  assert.deepEqual(flow.threadFlows[0].locations.map(point => point.location.physicalLocation?.region?.startLine), [4, 9, 15]);
  assert.deepEqual(flow.threadFlows[0].locations.map(point => point.executionOrder), [1, 2, 3]);
  assert.deepEqual(result.properties.evidence, evidence);
  assert.equal(result.properties.confidence, 'medium');
  assert.equal(result.locations?.[0].physicalLocation?.region?.startLine, 15);
});

test('missing physical locations retain logical locations, and partial evidence does not invent code flow', () => {
  const result = toSarif(report([finding({ sourcePath: undefined, startLine: undefined, evidence: {
    kind: 'taint-flow', source: { method: '<Input: java.lang.String source()>' },
  } })])).runs[0].results[0];
  assert.equal(result.locations?.[0].physicalLocation, undefined);
  assert.equal(result.locations?.[0].logicalLocations?.[0].fullyQualifiedName, '<example.Main: void main(java.lang.String[])>');
  assert.equal(result.relatedLocations?.[0].logicalLocations?.[0].fullyQualifiedName, '<Input: java.lang.String source()>');
  assert.equal(result.codeFlows, undefined);
});

test('failed compilation, analyzer errors and timeouts remain unsuccessful SARIF invocations with diagnostics', () => {
  for (const status of ['compile_failed', 'analysis_failed', 'timeout'] as const) {
    const run = toSarif(report([], { status, diagnostics: ['Expected failure evidence.'] })).runs[0];
    assert.equal(run.invocations[0].executionSuccessful, false);
    assert.equal(run.invocations[0].toolExecutionNotifications[0].level, 'error');
    assert.match(run.invocations[0].toolExecutionNotifications[0].message.text, /Expected failure evidence/);
    assert.deepEqual(run.results, []);
    assert.equal(run.properties.status, status);
  }
  const successful = toSarif(report()).runs[0].invocations[0];
  assert.equal(successful.executionSuccessful, true);
  assert.deepEqual(successful.toolExecutionNotifications, []);
  const severities = ['major', 'unknown', 'INFO'].map(severity => toSarif(report([finding({ severity })])).runs[0].results[0].level);
  assert.deepEqual(severities, ['error', 'warning', 'note']);
});

test('structured files preserve raw evidence and keep every finding unreviewed in an editable separate triage file', async () => {
  const root = path.resolve('.taie-agent', 'reporting-tests');
  await mkdir(root, { recursive: true });
  const runDir = await mkdtemp(path.join(root, 'run-'));
  try {
    const rawPath = path.join(runDir, 'findings.raw.json');
    const raw = '{"rawEvidence":"must remain untouched"}\n';
    await writeFile(rawPath, raw);
    const analysis = report(normalizeFindings([finding(), finding({ type: 'OTHER', severity: 'INFO' })], projectDir), {
      runDir, reportPath: path.join(runDir, 'report.json'), evidence: { rawFindings: rawPath },
    });
    const originalFindings = JSON.stringify(analysis.findings);
    await writeStructuredOutputs(analysis);
    assert.equal(analysis.evidence.sarif, path.join(runDir, 'results.sarif'));
    assert.equal(analysis.evidence.triage, path.join(runDir, 'triage.json'));
    const sarif = JSON.parse(await readFile(analysis.evidence.sarif, 'utf8'));
    const triage = JSON.parse(await readFile(analysis.evidence.triage, 'utf8'));
    assert.equal(sarif.runs[0].results.length, 2);
    assert.equal(triage.schemaVersion, 2);
    assert.deepEqual(triage.findings.map((entry: { state: string }) => entry.state), ['unreviewed', 'unreviewed']);
    assert.deepEqual(triage.findings.map((entry: { findingId: string }) => entry.findingId), analysis.findings.map(item => item.id));
    triage.findings[0].state = 'unresolved';
    triage.findings[0].rationale = 'More evidence needed.';
    await writeFile(analysis.evidence.triage, JSON.stringify(triage));
    assert.equal(await readFile(rawPath, 'utf8'), raw);
    assert.equal(JSON.stringify(analysis.findings), originalFindings);
    assert.equal(JSON.parse(await readFile(analysis.evidence.triage, 'utf8')).findings[0].state, 'unresolved');
    await assert.rejects(() => writeStructuredOutputs(analysis), { code: 'EEXIST' });
  } finally {
    assert.ok(runDir.startsWith(root + path.sep));
    await rm(runDir, { recursive: true, force: true });
  }
});

test('project reports gate dependency details and keep review lists separate', async () => {
  const root = path.resolve('.taie-agent', 'reporting-tests');
  await mkdir(root, { recursive: true });
  const dependency = finding({ id: 'dependency-id', origin: 'dependency', className: 'lib.Helper', sourcePath: undefined });
  const project = finding({ id: 'project-id', origin: 'project' });
  for (const include of [false, true]) {
    const runDir = await mkdtemp(path.join(root, 'origin-'));
    try {
      const analysis = report([project], { runDir, findingScope: 'project',
        findingCounts: { project: 1, dependency: 1, total: 2 },
        ...(include ? { dependencyFindings: [dependency] } : {}) });
      await writeStructuredOutputs(analysis);
      const sarif = JSON.parse(await readFile(analysis.evidence.sarif, 'utf8'));
      const triage = JSON.parse(await readFile(analysis.evidence.triage, 'utf8'));
      assert.deepEqual(sarif.runs[0].results.map((item: any) => item.properties.origin),
        include ? ['project', 'dependency'] : ['project']);
      assert.deepEqual(triage.findings.map((item: any) => item.findingId), ['project-id']);
      assert.equal(triage.findings[0].origin, 'project');
      assert.equal(triage.findingCounts.dependency, 1);
      assert.deepEqual(triage.dependencyFindings?.map((item: any) => item.origin), include ? ['dependency'] : undefined);
    } finally {
      assert.equal(path.dirname(runDir), root);
      await rm(runDir, { recursive: true, force: true });
    }
  }
});
