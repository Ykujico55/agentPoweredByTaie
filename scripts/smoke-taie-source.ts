import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzeJavaProject, type AnalysisReport } from '../src/taie.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, '.tools', 'tai-e', 'source-build.json');

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { jarPath: string; sha256: string };
  assert.ok(path.isAbsolute(manifest.jarPath), 'Build manifest must contain an absolute jarPath.');
  const hash = createHash('sha256').update(await readFile(manifest.jarPath)).digest('hex');
  assert.equal(hash, manifest.sha256, 'Source-built JAR changed after the recorded build. Rebuild it.');
  const runDir = path.join(root, '.taie-agent', 'source-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(runDir, { recursive: true });
  const evidence: { manifestPath: string; status: string; reports: Record<string, AnalysisReport>; error?: string } = {
    manifestPath, status: 'running', reports: {},
  };
  try {
    for (const fixture of ['clean', 'buggy']) {
      const projectDir = path.join(runDir, fixture);
      await cp(path.join(root, 'tests', 'fixtures', fixture), projectDir, { recursive: true });
      const report = await analyzeJavaProject({ projectDir, jarPath: manifest.jarPath });
      evidence.reports[fixture] = report;
      assert.equal(report.status, 'completed', report.diagnostics.join('\n'));
      assert.equal(report.taiE.artifactKind, 'custom');
      assert.equal(report.taiE.sha256, manifest.sha256);
      assert.equal(report.taiE.expectedVersion, undefined);
      if (fixture === 'clean') assert.equal(report.findings.length, 0);
      else assert.ok(report.findings.some(finding => finding.type === 'DE_MIGHT_IGNORE'));
    }
    const nullProject = path.join(runDir, 'null-pointer');
    await cp(path.join(root, 'tests', 'fixtures', 'null-pointer-crash'), nullProject, { recursive: true });
    const nullReport = await analyzeJavaProject({ projectDir: nullProject, jarPath: manifest.jarPath, analyses: ['null-pointer'] });
    evidence.reports.nullPointer = nullReport;
    assert.equal(nullReport.status, 'completed', nullReport.diagnostics.join('\n'));
    assert.ok(nullReport.findings.some(finding => finding.type === 'NP_ALWAYS_NULL'));
    const nullSarif = JSON.parse(await readFile(nullReport.evidence.sarif, 'utf8'));
    assert.equal(nullSarif.runs[0].results.find((finding: { ruleId: string }) => finding.ruleId.endsWith('/NP_ALWAYS_NULL')).level, 'error');
    for (const sample of ['division-buggy', 'division-clean']) {
      const projectDir = path.join(runDir, sample);
      await cp(path.join(root, 'examples', sample), projectDir, { recursive: true, filter: source => !source.includes(`${path.sep}.taie-agent`) });
      const report = await analyzeJavaProject({ projectDir, jarPath: manifest.jarPath, analyses: ['division-by-zero'] });
      evidence.reports[sample] = report;
      assert.equal(report.status, 'completed', report.diagnostics.join('\n'));
      if (sample.endsWith('buggy')) assert.ok(report.findings.some(finding => finding.type === 'INTEGER_DIVIDE_BY_ZERO'));
      else assert.deepEqual(report.findings, []);
    }
    const taintProject = path.join(runDir, 'taint');
    await cp(path.join(root, 'tests', 'fixtures', 'taint-buggy'), taintProject, { recursive: true });
    const taint = await analyzeJavaProject({ projectDir: taintProject, jarPath: manifest.jarPath,
      analyses: ['taint', 'division-by-zero', 'null-pointer'], mainClass: 'example.Main', taintConfig: 'taint.yml', taintImplicitEntries: false });
    evidence.reports.taintWithDetectors = taint;
    assert.equal(taint.status, 'completed', taint.diagnostics.join('\n'));
    assert.ok(taint.findings.some(finding => finding.type === 'TAINT_FLOW' && finding.evidence?.pathStatus === 'computed'));
    const { stdout } = await promisify(execFile)(process.execPath, [
      path.join(root, 'src', 'cli.ts'), 'analyze', '--project', path.join(runDir, 'clean'),
    ], { cwd: root, env: { ...process.env, TAIE_JAR: manifest.jarPath }, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    const environmentReport = JSON.parse(stdout) as AnalysisReport;
    evidence.reports.environmentSelection = environmentReport;
    assert.equal(environmentReport.status, 'completed');
    assert.equal(environmentReport.taiE.artifactKind, 'custom');
    assert.equal(environmentReport.taiE.sha256, manifest.sha256);
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error instanceof Error ? error.stack ?? error.message : String(error);
    process.exitCode = 1;
  } finally {
    const reportPath = path.join(runDir, 'result.json');
    await writeFile(reportPath, JSON.stringify(evidence, null, 2) + '\n');
    console.log(`Source Tai-e smoke ${evidence.status}: ${reportPath}`);
    if (evidence.error) console.error(evidence.error);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
