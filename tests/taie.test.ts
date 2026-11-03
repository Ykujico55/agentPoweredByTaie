import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeJavaProject, getDefaultJarPath, getJavaExecutables, TAIE_SHA256 } from '../src/taie.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const workspaces = path.resolve('.taie-agent', 'test-workspaces');
async function fixture(name: string): Promise<string> {
  await mkdir(workspaces, { recursive: true });
  const directory = await mkdtemp(path.join(workspaces, 'taie-agent-test-'));
  await cp(path.join(fixtures, name), directory, { recursive: true });
  return directory;
}
async function cleanup(directory: string): Promise<void> {
  assert.ok(path.resolve(directory).startsWith(path.join(workspaces, 'taie-agent-test-')));
  await rm(directory, { recursive: true, force: true });
}

test('real Tai-e finds a swallowed exception, then freshly recompiles a clean repair', { timeout: 120_000 }, async () => {
  const projectDir = await fixture('buggy');
  try {
    const buggy = await analyzeJavaProject({ projectDir });
    assert.equal(buggy.status, 'completed', buggy.diagnostics.join('\n'));
    const warning = buggy.findings.find((finding) => finding.type === 'DE_MIGHT_IGNORE');
    assert.ok(warning, JSON.stringify(buggy.findings));
    assert.equal(warning.analysis, 'dropped-exception');
    assert.equal(warning.className, 'example.Main');
    assert.ok(warning.startLine && warning.startLine > 0);
    assert.ok(warning.sourcePath?.endsWith(path.join('example', 'Main.java')));
    assert.ok(buggy.analyzedEntities?.['dropped-exception']);
    assert.match(await readFile(buggy.evidence.analyzeStdout, 'utf8'), /TAIE_AGENT_EXPORT_COMPLETED/);
    assert.equal(JSON.parse(await readFile(buggy.reportPath, 'utf8')).status, 'completed');
    const originalReport = await readFile(buggy.reportPath, 'utf8');
    await cp(path.join(fixtures, 'clean'), projectDir, { recursive: true });
    const clean = await analyzeJavaProject({ projectDir });
    assert.equal(clean.status, 'completed', clean.diagnostics.join('\n'));
    assert.deepEqual(clean.findings, []);
    assert.notEqual(clean.runDir, buggy.runDir);
    assert.notEqual(clean.sourceFingerprint, buggy.sourceFingerprint);
    assert.equal(await readFile(buggy.reportPath, 'utf8'), originalReport);
  } finally { await cleanup(projectDir); }
});

test('a Java compilation error cannot become an empty completed analysis', { timeout: 30_000 }, async () => {
  const projectDir = await fixture('compile-error');
  try {
    const report = await analyzeJavaProject({ projectDir });
    assert.equal(report.status, 'compile_failed');
    assert.deepEqual(report.findings, []);
    assert.match(await readFile(report.evidence.compileStderr, 'utf8'), /String message = ;/);
    assert.equal(report.analyzedEntities, undefined);
  } finally { await cleanup(projectDir); }
});

test('upstream null-pointer crash is preserved as analysis_failed with raw evidence', { timeout: 60_000 }, async () => {
  const projectDir = await fixture('null-pointer-crash');
  try {
    const report = await analyzeJavaProject({ projectDir, analyses: ['null-pointer'] });
    assert.equal(report.status, 'analysis_failed');
    assert.deepEqual(report.findings, []);
    assert.match(await readFile(report.evidence.analyzeStderr, 'utf8'), /UnsupportedOperationException/);
    assert.ok(report.limitations.some((limitation) => limitation.includes('null-pointer')));
  } finally { await cleanup(projectDir); }
});

test('missing analyzer, unsupported analyses, and cancellation fail explicitly', { timeout: 30_000 }, async () => {
  const projectDir = await fixture('clean');
  try {
    const missing = await analyzeJavaProject({ projectDir, jarPath: path.join(projectDir, 'missing.jar') });
    assert.equal(missing.status, 'analysis_failed');
    assert.match(missing.diagnostics.join('\n'), /JAR missing/);
    const invalidJar = path.join(projectDir, 'invalid-custom.jar');
    await writeFile(invalidJar, 'not a Java archive');
    const invalid = await analyzeJavaProject({ projectDir, jarPath: invalidJar });
    assert.equal(invalid.status, 'analysis_failed');
    assert.equal(invalid.taiE.artifactKind, 'custom');
    assert.deepEqual(invalid.findings, []);
    const unsupported = await analyzeJavaProject({ projectDir, analyses: ['pta=taint-config:untrusted'] });
    assert.equal(unsupported.status, 'analysis_failed');
    assert.match(unsupported.diagnostics.join('\n'), /Supported analyses/);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await analyzeJavaProject({ projectDir, signal: controller.signal });
    assert.equal(cancelled.status, 'timeout');
    assert.match(cancelled.diagnostics.join('\n'), /cancelled/);
  } finally { await cleanup(projectDir); }
});

test('two explicit dependencies are both loaded and a production test package is included', { timeout: 60_000 }, async () => {
  const projectDir = await fixture('classpath');
  try {
    const classpath = ['one', 'two'].map((name) => path.join(projectDir, 'dependencies', `${name}-classes`));
    const compile = promisify(execFile);
    await compile(getJavaExecutables().javac, ['-d', classpath[0], path.join(projectDir, 'dependencies', 'one', 'Base.java')]);
    await compile(getJavaExecutables().javac, ['-d', classpath[1], path.join(projectDir, 'dependencies', 'two', 'Marker.java')]);
    assert.ok((await readFile(path.join(classpath[0], 'dependency', 'one', 'Base.class'))).length > 0);
    assert.ok((await readFile(path.join(classpath[1], 'dependency', 'two', 'Marker.class'))).length > 0);
    const report = await analyzeJavaProject({ projectDir, classpath });
    assert.equal(report.status, 'completed', report.diagnostics.join('\n') + '\n' + await readFile(report.evidence.compileArguments, 'utf8'));
    assert.equal(report.sourceFiles.length, 1);
    assert.ok(report.sourceFiles[0].includes(path.join('com', 'example', 'test', 'Main.java')));
    const options = await readFile(report.evidence.taieOptions, 'utf8');
    assert.match(options, /one-classes/);
    assert.match(options, /two-classes/);
    assert.deepEqual(report.findings, []);
  } finally { await cleanup(projectDir); }
});

test('an explicitly selected development JAR can differ from the official release and keeps real analysis evidence', { timeout: 60_000 }, async () => {
  const projectDir = await fixture('buggy');
  try {
    const customJar = path.join(projectDir, 'development-tai-e.jar');
    await cp(getDefaultJarPath(), customJar);
    await writeFile(path.join(projectDir, 'development-marker.txt'), 'Local development artifact for integration verification.\n');
    const javaHome = process.env.TAIE_JAVA_HOME || process.env.JAVA_HOME;
    const jar = javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar') : 'jar';
    await promisify(execFile)(jar, ['--update', '--file', customJar, '-C', projectDir, 'development-marker.txt']);
    const report = await analyzeJavaProject({ projectDir, jarPath: customJar });
    assert.equal(report.status, 'completed', report.diagnostics.join('\n'));
    assert.equal(report.taiE.artifactKind, 'custom');
    assert.equal(report.taiE.expectedVersion, undefined);
    assert.notEqual(report.taiE.sha256, TAIE_SHA256);
    assert.equal(report.taiE.version, '0.5.4');
    assert.ok(report.findings.some(finding => finding.type === 'DE_MIGHT_IGNORE'));
    assert.ok(report.analyzedEntities?.['dropped-exception']);
  } finally { await cleanup(projectDir); }
});

test('a tampered default artifact is rejected without changing the shared official installation', async () => {
  const projectDir = await fixture('clean');
  try {
    const installation = path.join(projectDir, 'isolated-installation');
    await mkdir(path.join(installation, 'src'), { recursive: true });
    await mkdir(path.join(installation, '.tools', 'tai-e'), { recursive: true });
    const modulePath = path.join(installation, 'src', 'taie.ts');
    await cp(fileURLToPath(new URL('../src/taie.ts', import.meta.url)), modulePath);
    await cp(fileURLToPath(new URL('../src/reporting.ts', import.meta.url)), path.join(installation, 'src', 'reporting.ts'));
    await cp(fileURLToPath(new URL('../src/process.ts', import.meta.url)), path.join(installation, 'src', 'process.ts'));
    await writeFile(path.join(installation, '.tools', 'tai-e', 'tai-e-all-0.5.4.jar'), 'altered default artifact');
    const isolated = await import(pathToFileURL(modulePath).href);
    const report = await isolated.analyzeJavaProject({ projectDir });
    assert.equal(report.status, 'analysis_failed');
    assert.equal(report.taiE.artifactKind, 'official-release');
    assert.match(report.diagnostics.join('\n'), /SHA-256 mismatch/);
    assert.equal(report.evidence.compileCommand, undefined);
  } finally { await cleanup(projectDir); }
});
