import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkMavenInDocker } from '../src/docker-maven.ts';

const runDir = path.resolve('.taie-agent', 'maven-smoke', new Date().toISOString().replaceAll(/[:.]/g, '-'));
const projectDir = path.join(runDir, 'project');
await mkdir(runDir, { recursive: true });
await cp(path.resolve('tests/fixtures/maven-simple'), projectDir, {
  recursive: true, filter: source => path.basename(source) !== '.taie-agent',
});
const results: Record<string, unknown> = {};
const check = async (name: string, dependencyNetwork = false, includeDependencies = false) => {
  const report = await checkMavenInDocker({ projectDir, dependencyNetwork, includeDependencies, timeoutMs: 600_000 });
  results[name] = { status: report.status, statusScope: report.statusScope, includeDependencies: report.includeDependencies,
    findingCounts: report.analysis?.findingCounts, reportPath: report.reportPath, durationMs: report.durationMs };
  await writeFile(path.join(runDir, 'result.json'), JSON.stringify(results, null, 2));
  console.log(`${name}: ${report.status}; ${report.reportPath}`);
  return report;
};
const clean = await check('dependency-findings', true);
assert.equal(clean.status, 'passed', clean.reportPath);
assert.equal(clean.schemaVersion, 2);
assert.equal(clean.statusScope, 'project');
assert.equal(clean.includeDependencies, false);
assert.equal(clean.maven?.build, 'passed');
assert.equal(clean.maven?.test.status, 'passed');
assert.deepEqual(clean.analysis?.findings, []);
assert.equal(clean.analysis?.findingCounts?.project, 0);
assert.ok(clean.analysis!.findingCounts!.dependency > 0);
assert.equal(clean.analysis?.dependencyFindings, undefined);
assert.equal(clean.maven?.test.tests, 1);
assert.match(clean.maven!.versions.java!, /^17\./);
assert.equal(clean.analysis?.evidence.compileCommand, undefined, 'Tai-e must use Maven classes, not recompile');
assert.ok(clean.analysis?.evidence.compiledClasses);
assert.equal(clean.checkNetwork, 'none');
const rawAnalysis = JSON.parse(await readFile(clean.analysis!.evidence.containerReport, 'utf8'));
assert.equal(rawAnalysis.findings.length, clean.analysis!.findingCounts!.total, 'raw APP evidence is retained');
const storedDependencies = JSON.parse(await readFile(clean.analysis!.evidence.dependencyFindings, 'utf8'));
assert.equal(storedDependencies.length, clean.analysis!.findingCounts!.dependency);
assert.ok(storedDependencies.every((finding: { origin: string }) => finding.origin === 'dependency'));
assert.deepEqual(JSON.parse(await readFile(clean.analysis!.evidence.sarif, 'utf8')).runs[0].results, []);
assert.deepEqual(JSON.parse(await readFile(clean.analysis!.evidence.triage, 'utf8')).findings, []);

const withDependencies = await check('include-dependencies', false, true);
assert.equal(withDependencies.status, 'passed', withDependencies.reportPath);
assert.equal(withDependencies.statusScope, 'project');
assert.equal(withDependencies.includeDependencies, true);
assert.deepEqual(withDependencies.analysis?.findings, []);
assert.deepEqual(withDependencies.analysis?.findingCounts, clean.analysis?.findingCounts);
assert.equal(withDependencies.analysis?.dependencyFindings?.length, clean.analysis?.findingCounts?.dependency);
assert.ok(withDependencies.analysis?.dependencyFindings?.every(finding =>
  finding.origin === 'dependency' && finding.className?.startsWith('org.apache.commons.lang3.')));
const includedSarif = JSON.parse(await readFile(withDependencies.analysis!.evidence.sarif, 'utf8'));
assert.equal(includedSarif.runs[0].results.length, withDependencies.analysis!.findingCounts!.dependency);
assert.ok(includedSarif.runs[0].results.every((finding: { properties: { origin: string } }) => finding.properties.origin === 'dependency'));
const includedTriage = JSON.parse(await readFile(withDependencies.analysis!.evidence.triage, 'utf8'));
assert.deepEqual(includedTriage.findings, []);
assert.equal(includedTriage.dependencyFindings.length, withDependencies.analysis!.findingCounts!.dependency);

const testFile = path.join(projectDir, 'src/test/java/example/GreeterTest.java');
const originalTest = await readFile(testFile, 'utf8');
await writeFile(testFile, originalTest.replace('assertEquals(', 'assertEquals("intentional failure", '));
// Change the expected output without changing production code.
await writeFile(testFile, (await readFile(testFile, 'utf8')).replace('"Hello, Tai-e!"', '"wrong expected greeting"'));
const failedTest = await check('failed-test');
assert.equal(failedTest.status, 'test_failed', failedTest.reportPath);
assert.equal(failedTest.maven?.build, 'passed');
assert.ok(failedTest.maven!.test.failures > 0);
await writeFile(testFile, originalTest);

const sourceFile = path.join(projectDir, 'src/main/java/example/Greeter.java');
const originalSource = await readFile(sourceFile, 'utf8');
await writeFile(sourceFile, 'package example; public class Greeter { invalid Java }');
const failedBuild = await check('failed-build');
assert.equal(failedBuild.status, 'build_failed', failedBuild.reportPath);
assert.equal(failedBuild.analysis, undefined);
await writeFile(sourceFile, originalSource);
await writeFile(sourceFile, originalSource.replace(/}\s*$/, `
    public static void swallowed(String input) {
        try { Integer.parseInt(input); } catch (NumberFormatException ignored) { }
    }
}
`));
const findings = await check('findings');
assert.equal(findings.status, 'findings', findings.reportPath);
assert.ok(findings.analysis?.findings.every(finding => finding.origin === 'project' && finding.className === 'example.Greeter'));
assert.equal(findings.analysis?.findings.filter(finding => finding.type === 'DE_MIGHT_IGNORE').length, 1);
assert.equal(findings.analysis?.findingCounts?.project, findings.analysis?.findings.length);
assert.equal(findings.analysis?.dependencyFindings, undefined);
// A separate JDK-only control exercises the zero-finding result. The dependency
// warnings above stay in their original report; this is not a repair/suppression.
await writeFile(sourceFile, originalSource.replace('import org.apache.commons.lang3.StringUtils;', '')
  .replace('StringUtils.defaultIfBlank(name, "stranger")', '(name == null || name.isBlank() ? "stranger" : name)'));
const passed = await check('passed');
assert.equal(passed.status, 'passed', passed.reportPath);
await writeFile(sourceFile, originalSource);
console.log(`Maven smoke passed. Evidence: ${runDir}`);
