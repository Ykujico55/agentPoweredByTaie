import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildComparisonKey } from '../src/check-context.ts';
import type { AnalysisReport } from '../src/taie.ts';
import type { MavenCheckResult } from '../src/docker-maven.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function write(file: string, contents: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}
async function workspace(t: TestContext) {
  const base = path.resolve('.taie-agent', 'check-context-tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'case-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(directory)), await realpath(base));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function fixture(root: string, mavenBackend = false) {
  const runDir = path.join(root, '.taie-agent', 'runs', 'run');
  const projectDir = mavenBackend ? path.join(runDir, 'check-workspace', 'project') : root;
  const source = path.join(projectDir, 'src', 'Main.java');
  const dependency = path.join(projectDir, 'lib', 'library.jar');
  const report: AnalysisReport = {
    schemaVersion: 2, status: 'completed', projectDir, runDir,
    runId: 'run', reportPath: path.join(runDir, 'analysis.json'), startedAt: '2026-11-03', durationMs: 1,
    analyses: ['null-pointer'], findings: [], sourceFingerprint: 'source-before', diagnostics: [], limitations: [],
    sourceRoots: [path.dirname(source)], sourceFiles: [source], classpath: [dependency],
    taiE: { artifactKind: 'custom', baselineVersion: '0.5.4', jarPath: path.join(root, 'tai-e.jar'), sha256: hash('analyzer'), javaVersion: '17.0.15' },
    analysisMetadata: { adapterFingerprint: hash('adapter') },
    evidence: { analyzeCommand: path.join(runDir, 'analyze.command.json'), analysisPlan: path.join(runDir, 'analysis-plan.json'),
      compileCommand: path.join(runDir, 'compile.command.json'), compileArguments: path.join(runDir, 'javac.args') },
  };
  await write(source, 'class Main {}');
  await write(dependency, 'library');
  await write(report.evidence.analyzeCommand, JSON.stringify({ command: 'java', args: ['TaieAgentExporter', '-scope', 'APP', '-m', 'Main'] }));
  await write(report.evidence.analysisPlan, JSON.stringify([{ id: 'null-pointer' }]));
  await write(report.evidence.compileCommand, JSON.stringify({ command: 'javac', args: ['-J-Dfile.encoding=UTF-8', `@${report.evidence.compileArguments}`] }));
  await write(report.evidence.compileArguments, ['-g', '-d', path.join(runDir, 'classes'), '-classpath', dependency, source]
    .map(arg => JSON.stringify(arg.replaceAll('\\', '/'))).join('\n'));
  const maven: MavenCheckResult = {
    schemaVersion: 2, status: 'passed', statusScope: 'project', includeDependencies: false,
    projectDir: root, runDir, reportPath: path.join(runDir, 'report.json'), image: 'maven', imageId: 'sha256:image-a',
    storage: { backend: 'docker-volumes', repositoryVolume: 'cache' }, dependencyNetwork: false, checkNetwork: 'none',
    review: 'not_run', diagnostics: [], analysis: report,
    maven: { status: 'completed', build: 'passed', test: { status: 'passed', tests: 1, failures: 0, errors: 0, skipped: 0, reportFiles: [] },
      versions: { java: '17.0.15', maven: '3.9.9' }, stages: [], diagnostics: [], durationMs: 1,
      reportPath: path.join(runDir, 'check-workspace', 'maven', 'check-report.json'),
      metadata: { packaging: 'jar', classesDir: path.join(projectDir, 'target', 'classes'), sourceDirectory: path.dirname(source),
        buildDirectory: path.join(projectDir, 'target'), testClassesDir: 'test-classes', testReportsDir: 'surefire-reports',
        sourceRoots: report.sourceRoots, sourceFiles: report.sourceFiles, generatedSourceDirectories: [],
        classpath: report.classpath, classpathScope: 'all-including-test', preparationPluginArtifactIds: [] } },
  };
  await write(path.join(runDir, 'snapshot', 'project', 'pom.xml'), '<project><version>1</version></project>');
  await write(path.join(path.dirname(maven.maven!.reportPath), 'effective-pom.xml'), '<project><release>17</release></project>');
  return { report, maven, source, dependency };
}

test('comparison context survives changed Java contents and checkout/run paths', async t => {
  const root = await workspace(t);
  for (const backend of [false, true]) {
    const before = await fixture(path.join(root, `before-${backend}`), backend);
    const after = await fixture(path.join(root, `after-${backend}`), backend);
    const original = structuredClone(before.report);
    await write(after.source, 'class Main { int f() { return 42; } }');
    after.report.sourceFingerprint = 'different-source';
    after.maven.snapshotFingerprint = 'different-project-snapshot';
    assert.equal(await buildComparisonKey(before.report, backend ? before.maven : undefined),
      await buildComparisonKey(after.report, backend ? after.maven : undefined));
    assert.deepEqual(before.report, original, 'reading context must preserve backend evidence');
  }
});

test('changed analyzer, JDK, compiler release, scope, entry, detector, adapter and dependency invalidate context', async t => {
  const { report, dependency } = await fixture(await workspace(t));
  const original = await buildComparisonKey(report);
  const mutations: ((copy: AnalysisReport) => void)[] = [
    copy => { copy.taiE.sha256 = hash('changed jar'); },
    copy => { copy.taiE.javaVersion = '21.0.5'; },
    copy => { copy.compileRelease = 11; },
    copy => { copy.analyses = ['dead-code']; },
    copy => { copy.analysisMetadata!.adapterFingerprint = hash('changed adapter'); },
    copy => { copy.sourceRoots.push(path.join(copy.projectDir, 'extra-sources')); },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(report); mutate(copy);
    assert.notEqual(await buildComparisonKey(copy), original);
  }
  for (const args of [['-scope', 'REACHABLE', '-m', 'Main'], ['-scope', 'APP', '-m', 'Other']]) {
    await write(report.evidence.analyzeCommand, JSON.stringify({ command: 'java', args }));
    assert.notEqual(await buildComparisonKey(report), original);
  }
  await write(report.evidence.analyzeCommand, JSON.stringify({ command: 'java', args: ['-scope', 'APP', '-m', 'Main'] }));
  await write(dependency, 'changed library bytes');
  assert.notEqual(await buildComparisonKey(report), original);
});

test('taint context uses the captured policy and implicit entries; unknown or missing evidence refuses comparison', async t => {
  const { report } = await fixture(await workspace(t));
  report.analyses = ['taint'];
  report.taintConfiguration = { originalPath: 'mutable-policy.yml', snapshotPath: path.join(report.runDir, 'policy.yml'),
    sha256: hash('policy-a'), implicitEntries: true };
  await write(report.taintConfiguration.snapshotPath, 'policy-a');
  await write(report.evidence.analysisPlan, JSON.stringify([{ id: 'pta', options: { 'taint-config': '/run/policy.yml', 'implicit-entries': true } }]));
  const original = await buildComparisonKey(report);
  report.taintConfiguration.implicitEntries = false;
  assert.notEqual(await buildComparisonKey(report), original);
  report.taintConfiguration.implicitEntries = true;
  await write(report.taintConfiguration.snapshotPath, 'policy-b');
  await assert.rejects(buildComparisonKey(report), /snapshot no longer matches/);
  report.taintConfiguration.sha256 = hash('policy-b');
  assert.notEqual(await buildComparisonKey(report), original);
  delete report.taiE.sha256;
  await assert.rejects(buildComparisonKey(report), /analyzer SHA-256/);
  await rm(report.evidence.analysisPlan);
  await assert.rejects(buildComparisonKey(report), /ENOENT/);
});

test('Maven keys read snapshot POM/.mvn and exported effective POM, with image identity and dependency scope', async t => {
  const { report, maven } = await fixture(await workspace(t), true);
  const original = await buildComparisonKey(report, maven);
  await write(path.join(maven.projectDir, 'pom.xml'), 'mutable current POM is deliberately ignored');
  assert.equal(await buildComparisonKey(report, maven), original);
  const snapshotPom = path.join(maven.runDir, 'snapshot', 'project', 'pom.xml');
  const oldPom = await readFile(snapshotPom, 'utf8');
  await write(snapshotPom, 'changed snapshot POM');
  assert.notEqual(await buildComparisonKey(report, maven), original);
  await write(snapshotPom, oldPom);
  const mvnConfig = path.join(path.dirname(snapshotPom), '.mvn', 'maven.config');
  await write(mvnConfig, '-Pspecial');
  assert.notEqual(await buildComparisonKey(report, maven), original);
  await rm(mvnConfig);
  await rmdir(path.dirname(mvnConfig));
  assert.equal(await buildComparisonKey(report, maven), original);
  maven.imageId = 'sha256:image-b';
  assert.notEqual(await buildComparisonKey(report, maven), original);
  maven.imageId = 'sha256:image-a';
  await write(path.join(path.dirname(maven.maven!.reportPath), 'effective-pom.xml'), '<project><release>11</release></project>');
  assert.notEqual(await buildComparisonKey(report, maven), original);
  delete maven.imageId;
  await assert.rejects(buildComparisonKey(report, maven), /Maven image ID/);
});

test('directory classpaths hash class bytes and refuse directory symlinks', async t => {
  const { report } = await fixture(await workspace(t));
  const classes = path.join(report.projectDir, 'dependency-classes');
  await write(path.join(classes, 'pkg', 'Library.class'), 'bytecode-a');
  report.classpath = [classes];
  const original = await buildComparisonKey(report);
  await write(path.join(classes, 'notes.txt'), 'not analysis input');
  assert.equal(await buildComparisonKey(report), original);
  await write(path.join(classes, 'pkg', 'Library.class'), 'bytecode-b');
  assert.notEqual(await buildComparisonKey(report), original);
  const linked = path.join(report.projectDir, 'linked-classes');
  await t.test('rejects a symlink classpath', async symlinkTest => {
    try { await symlink(classes, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      symlinkTest.skip('This environment does not permit creating symlinks.'); return;
    }
    report.classpath = [linked];
    await assert.rejects(buildComparisonKey(report), /Symlink classpath/);
  });
});
