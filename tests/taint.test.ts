import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeJavaProject } from '../src/taie.ts';
import { loadProjectConfig } from '../src/config.ts';

async function fixture(name: string) {
  const base = path.resolve('.taie-agent', 'test-workspaces');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'taint-'));
  await cp(path.resolve('tests', 'fixtures', name), directory, { recursive: true });
  return directory;
}

test('real PTA plugin exports a source-specific interprocedural taint path, SARIF, and separate triage', { timeout: 90000 }, async () => {
  const projectDir = await fixture('taint-buggy');
  try {
    const config = await loadProjectConfig(projectDir);
    const report = await analyzeJavaProject({ ...config, analyses: ['taint', 'dropped-exception', 'clone-idiom', 'dead-code'], taintImplicitEntries: false, projectDir });
    assert.equal(report.status, 'completed', report.diagnostics.join('\n'));
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.findings.length, 1);
    const finding = report.findings[0];
    assert.equal(finding.type, 'TAINT_FLOW');
    assert.equal(finding.evidence?.source?.line, 7);
    assert.equal(finding.evidence?.sink?.line, 9);
    assert.equal(finding.evidence?.pathStatus, 'computed');
    assert.ok((finding.evidence?.path?.length ?? 0) >= 3);
    assert.ok(finding.evidence?.path?.some(point => point.method?.includes('relay')));
    assert.ok(finding.evidence?.path?.every(point => point.sourcePath?.endsWith('Main.java')));
    const metadata = report.analysisMetadata?.taint as Record<string, unknown>;
    assert.equal(metadata.pluginLifecycleCompleted, true);
    assert.ok(Number(metadata.callGraphEdges) > 0);
    const sarif = JSON.parse(await readFile(report.evidence.sarif, 'utf8'));
    assert.equal(sarif.runs[0].invocations[0].executionSuccessful, true);
    assert.ok(sarif.runs[0].results[0].codeFlows[0].threadFlows[0].locations.length >= 3);
    const original = await readFile(report.reportPath, 'utf8');
    const triage = JSON.parse(await readFile(report.evidence.triage, 'utf8'));
    assert.equal(triage.findings[0].state, 'unreviewed');
    triage.findings[0].state = 'unresolved';
    await writeFile(report.evidence.triage, JSON.stringify(triage));
    assert.equal(await readFile(report.reportPath, 'utf8'), original);
    assert.equal(report.findings.length, 1);
    assert.ok(report.limitations.some(text => text.includes('Implicit JVM entry')));
    const plan = await readFile(report.evidence.taiePlan, 'utf8');
    assert.match(plan, /const-prop/);
    assert.match(plan, /live-var/);
  } finally { await rm(projectDir, { recursive: true, force: true }); }
});

test('clean flow still runs the plugin and records completed coverage', { timeout: 90000 }, async () => {
  const projectDir = await fixture('taint-clean');
  try {
    const config = await loadProjectConfig(projectDir);
    const report = await analyzeJavaProject({ ...config, taintImplicitEntries: false, projectDir });
    assert.equal(report.status, 'completed', report.diagnostics.join('\n'));
    assert.deepEqual(report.findings, []);
    assert.ok(Number(report.analyzedEntities?.taint) > 0);
    assert.equal((report.analysisMetadata?.taint as Record<string, unknown>).pluginLifecycleCompleted, true);
  } finally { await rm(projectDir, { recursive: true, force: true }); }
});

test('missing taint contract and malformed rule configuration remain failures in JSON and SARIF', { timeout: 90000 }, async () => {
  const projectDir = await fixture('taint-buggy');
  try {
    const missing = await analyzeJavaProject({ projectDir, analyses: ['taint'] });
    assert.equal(missing.status, 'analysis_failed');
    assert.match(missing.diagnostics.join('\n'), /mainClass/);
    const sarif = JSON.parse(await readFile(missing.evidence.sarif, 'utf8'));
    assert.equal(sarif.runs[0].invocations[0].executionSuccessful, false);
    const invalid = await analyzeJavaProject({ projectDir, analyses: ['taint'], mainClass: 'example.Main',
      taintConfig: 'taint.yml', taintConfigContent: 'sources: [unterminated', taintImplicitEntries: false });
    assert.equal(invalid.status, 'analysis_failed');
    assert.deepEqual(invalid.findings, []);
    assert.ok(invalid.diagnostics.length > 0);
    const empty = await analyzeJavaProject({ projectDir, analyses: ['taint'], mainClass: 'example.Main',
      taintConfig: 'taint.yml', taintConfigContent: '{}', taintImplicitEntries: false });
    assert.equal(empty.status, 'analysis_failed');
    assert.deepEqual(empty.findings, []);
    await writeFile(path.join(projectDir, 'src', 'main', 'java', 'example', 'NoMain.java'), 'package example; public class NoMain { public static void noop() {} }\n');
    const noEntry = await analyzeJavaProject({ projectDir, analyses: ['taint'], mainClass: 'example.NoMain',
      taintConfig: 'taint.yml', taintImplicitEntries: false });
    assert.equal(noEntry.status, 'analysis_failed');
    assert.deepEqual(noEntry.findings, []);
  } finally { await rm(projectDir, { recursive: true, force: true }); }
});
