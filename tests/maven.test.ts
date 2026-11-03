import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseMavenMetadata, readMavenSources, summarizeSurefire } from '../src/maven.ts';

const projectDir = path.resolve('example-maven-project');
function pom(extra = '', plugins = ''): string {
  return `<project><packaging>jar</packaging>${extra}<build>
    <directory>generated-output</directory><outputDirectory>generated-output/main</outputDirectory>
    <testOutputDirectory>generated-output/tests</testOutputDirectory><sourceDirectory>java-source</sourceDirectory>
    <plugins>${plugins}</plugins></build></project>`;
}

test('effective Maven metadata preserves configured output and report paths', () => {
  const metadata = parseMavenMetadata(pom('', `<plugin><artifactId>maven-surefire-plugin</artifactId>
    <configuration><reportsDirectory>generated-output/test-results</reportsDirectory></configuration></plugin>`), projectDir);
  assert.equal(metadata.classesDir, path.join(projectDir, 'generated-output/main'));
  assert.deepEqual(metadata.sourceRoots, [path.join(projectDir, 'java-source')]);
  assert.equal(metadata.testReportsDir, path.join(projectDir, 'generated-output/test-results'));
  assert.equal(metadata.classpathScope, 'all-including-test');
});

test('dependency preparation only selects plugins needed through clean and test', () => {
  const execution = (artifactId: string, phase?: string) => `<plugin><artifactId>${artifactId}</artifactId>
    <executions><execution>${phase ? `<phase>${phase}</phase>` : ''}<goals><goal>run</goal></goals></execution></executions></plugin>`;
  const input = pom('', [execution('codegen-plugin', 'generate-sources'), execution('implicit-phase-plugin'),
    execution('maven-jar-plugin', 'package'), execution('maven-site-plugin', 'site')].join(''))
    .replace('<plugins>', '<pluginManagement><plugins><plugin><artifactId>maven-release-plugin</artifactId></plugin></plugins></pluginManagement><plugins>');
  assert.deepEqual(parseMavenMetadata(input, projectDir).preparationPluginArtifactIds, [
    'codegen-plugin', 'implicit-phase-plugin', 'maven-clean-plugin', 'maven-compiler-plugin',
    'maven-resources-plugin', 'maven-surefire-plugin',
  ]);
});

test('unsupported Maven models are rejected before compilation', () => {
  assert.throws(() => parseMavenMetadata(pom('<modules><module>child</module></modules>'), projectDir), /single-module/);
  assert.throws(() => parseMavenMetadata(pom('', `<plugin><artifactId>maven-compiler-plugin</artifactId>
    <configuration><fork>true</fork></configuration></plugin>`), projectDir), /compiler executables/);
  assert.throws(() => parseMavenMetadata(pom().replace('java-source', '../outside'), projectDir), /outside the project snapshot/);
});

test('source discovery reads compiler input lists and existing annotation output', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'taie-maven-inputs-'));
  try {
    const metadata = parseMavenMetadata(pom(), directory);
    await assert.rejects(readMavenSources(metadata, directory), /inputFiles.lst is required/);
    const inputsDir = path.join(metadata.buildDirectory, 'maven-status/maven-compiler-plugin/compile/default-compile');
    const inputFile = path.join(directory, 'java-source/example/Greeter.java');
    await mkdir(inputsDir, { recursive: true });
    await mkdir(path.dirname(inputFile), { recursive: true });
    await writeFile(inputFile, 'package example; class Greeter {}');
    await writeFile(path.join(inputsDir, 'inputFiles.lst'), `${inputFile}\n${inputFile}\n`);
    await mkdir(metadata.generatedSourceDirectories[0], { recursive: true });
    const sources = await readMavenSources(metadata, directory);
    assert.deepEqual(sources.sourceFiles, [inputFile]);
    assert.deepEqual(sources.sourceRoots, [path.dirname(inputFile), metadata.generatedSourceDirectories[0]].sort());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Surefire distinguishes passed, failed, absent and fully skipped tests', () => {
  const report = (attributes: string) => ({ file: 'TEST-example.xml', content: `<testsuite ${attributes}/>` });
  assert.equal(summarizeSurefire([]).status, 'not_run');
  assert.equal(summarizeSurefire([report('tests="2" skipped="2"')]).status, 'not_run');
  const passed = summarizeSurefire([report('tests="2" failures="0" errors="0" skipped="1"')]);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.tests, 2);
  assert.equal(summarizeSurefire([report('tests="1" failures="1"')]).status, 'failed');
  assert.equal(summarizeSurefire([report('tests="1" errors="1"')]).status, 'failed');
});
