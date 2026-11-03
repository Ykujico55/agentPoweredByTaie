import { readFile, writeFile } from 'node:fs/promises';
import { prepareMavenProject, checkMavenProject } from '../../src/maven.ts';
import { analyzeJavaProject, type AnalyzeJavaProjectOptions } from '../../src/taie.ts';

// The host supplies options read-only, outside the project's writable snapshot.
const options = JSON.parse(await readFile('/input/options.json', 'utf8')) as AnalyzeJavaProjectOptions;
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
  const result = { maven, analysis, review: 'not_run' };
  await writeFile('/workspace/check.json', JSON.stringify(result, null, 2));
  process.exitCode = maven.status === 'completed' && maven.test.status === 'passed'
    && analysis?.status === 'completed' && analysis.findings.length === 0 ? 0 : 1;
}
