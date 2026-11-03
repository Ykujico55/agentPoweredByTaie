import { readFile, writeFile } from 'node:fs/promises';
import { prepareMavenProject, checkMavenProject } from '../../src/maven.ts';
import { analyzeJavaProject, type AnalyzeJavaProjectOptions } from '../../src/taie.ts';
import { partitionFindings, projectClassNames } from '../../src/finding-origin.ts';

// The host supplies options read-only, outside the project's writable snapshot.
const options = JSON.parse(await readFile('/input/options.json', 'utf8')) as AnalyzeJavaProjectOptions & { includeDependencies?: boolean };
const deadline = Date.now() + (options.timeoutMs ?? 600_000);
const buildOptions = {
  projectDir: '/workspace/project', evidenceDir: '/workspace/maven',
  timeoutMs: Math.max(1, deadline - Date.now()), repositoryDir: '/maven-repository',
  offline: process.argv[3] === 'offline',
};
if (process.argv[2] === 'prepare') {
  const prepared = await prepareMavenProject(buildOptions);
  await writeFile('/workspace/preparation.json', JSON.stringify(prepared, null, 2));
  process.exitCode = prepared.status === 'prepared' ? 0 : 1;
} else {
  const maven = await checkMavenProject(buildOptions);
  const analysis = maven.build === 'passed' && maven.metadata && Date.now() < deadline
    ? await analyzeJavaProject({
      ...options, projectDir: buildOptions.projectDir, jarPath: '/input/tai-e.jar',
      sourceRoots: maven.metadata.sourceRoots, classpath: maven.metadata.classpath,
      compiledClassesDir: maven.metadata.classesDir, timeoutMs: Math.max(1, deadline - Date.now()),
    }) : undefined;
  if (analysis?.status === 'completed') {
    const classes = await projectClassNames(maven.metadata!.classesDir);
    const { projectFindings, dependencyFindings } = partitionFindings(analysis.findings, classes);
    // Keep the raw analyzer report untouched. Only this build-owned view is scoped.
    analysis.findingScope = 'project';
    analysis.findingCounts = { project: projectFindings.length, dependency: dependencyFindings.length,
      total: projectFindings.length + dependencyFindings.length };
    analysis.findings = projectFindings;
    if (options.includeDependencies) analysis.dependencyFindings = dependencyFindings;
    analysis.evidence.projectClasses = '/workspace/project-classes.json';
    analysis.evidence.dependencyFindings = '/workspace/dependency-findings.json';
    await writeFile(analysis.evidence.projectClasses, JSON.stringify([...classes].sort(), null, 2));
    await writeFile(analysis.evidence.dependencyFindings, JSON.stringify(dependencyFindings, null, 2));
  }
  const result = { maven, analysis, review: 'not_run' };
  await writeFile('/workspace/check.json', JSON.stringify(result, null, 2));
  process.exitCode = maven.status === 'completed' && maven.test.status === 'passed'
    && analysis?.status === 'completed' && analysis.findings.length === 0 ? 0 : 1;
}
