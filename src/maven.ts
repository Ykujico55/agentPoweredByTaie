import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { runProcess, type ProcessResult } from './process.ts';

const HELP = 'org.apache.maven.plugins:maven-help-plugin:3.5.2';
const DEPENDENCY = 'org.apache.maven.plugins:maven-dependency-plugin:3.11.0';
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });

export interface MavenOptions {
  projectDir: string;
  evidenceDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  repositoryDir?: string;
  offline?: boolean;
}
export interface MavenMetadata {
  packaging: 'jar';
  classesDir: string;
  sourceDirectory: string;
  buildDirectory: string;
  testClassesDir: string;
  testReportsDir: string;
  sourceRoots: string[];
  sourceFiles: string[];
  generatedSourceDirectories: string[];
  classpath: string[];
  classpathScope: 'all-including-test';
  preparationPluginArtifactIds: string[];
}
export interface MavenTestResult {
  status: 'not_run' | 'passed' | 'failed';
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  reportFiles: string[];
}
export interface MavenReport {
  status: 'prepared' | 'completed' | 'failed' | 'unsupported' | 'timeout';
  build: 'not_run' | 'passed' | 'failed';
  test: MavenTestResult;
  metadata?: MavenMetadata;
  versions: { maven?: string; java?: string };
  stages: (ProcessResult & { name: string; logBase: string })[];
  diagnostics: string[];
  reportPath: string;
  durationMs: number;
}

class UnsupportedProject extends Error {}
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
function xml(contents: string): any {
  const valid = XMLValidator.validate(contents);
  if (valid !== true) throw new Error(`Invalid XML: ${valid.err.msg}`);
  return parser.parse(contents);
}
function projectPath(projectDir: string, value: string): string {
  if (typeof value !== 'string' || value.includes('${')) throw new UnsupportedProject('Maven paths must be fully resolved.');
  const result = path.resolve(projectDir, value);
  const relative = path.relative(projectDir, result);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new UnsupportedProject(`Path outside the project snapshot is unsupported: ${value}`);
  }
  return result;
}

/** Only the effective, active single-module jar model is supported in this first adapter. */
export function parseMavenMetadata(contents: string, projectDir: string): MavenMetadata {
  const project = xml(contents).project;
  if (!project?.build) throw new Error('Effective POM is missing project/build.');
  if (array(project.modules?.module).length || (project.packaging ?? 'jar') !== 'jar') {
    throw new UnsupportedProject('Only single-module Maven jar projects are supported.');
  }
  const directory = (value: string) => projectPath(projectDir, value);
  const preparationPlugins = new Set([
    'maven-clean-plugin', 'maven-resources-plugin', 'maven-compiler-plugin', 'maven-surefire-plugin',
  ]);
  const preparationPhases = new Set([
    'pre-clean', 'clean', 'validate', 'initialize', 'generate-sources', 'process-sources',
    'generate-resources', 'process-resources', 'compile', 'process-classes', 'generate-test-sources',
    'process-test-sources', 'generate-test-resources', 'process-test-resources', 'test-compile',
    'process-test-classes', 'test',
  ]);
  const metadata: MavenMetadata = {
    packaging: 'jar',
    classesDir: directory(project.build.outputDirectory),
    sourceDirectory: directory(project.build.sourceDirectory),
    buildDirectory: directory(project.build.directory),
    testClassesDir: directory(project.build.testOutputDirectory),
    testReportsDir: directory(path.join(project.build.directory, 'surefire-reports')),
    sourceRoots: [], sourceFiles: [], classpath: [], classpathScope: 'all-including-test',
    generatedSourceDirectories: [directory(path.join(project.build.directory, 'generated-sources', 'annotations'))],
    preparationPluginArtifactIds: [],
  };
  for (const plugin of array<any>(project.build.plugins?.plugin)) {
    const executions = array<any>(plugin.executions?.execution);
    if (executions.some(execution => !execution.phase || preparationPhases.has(execution.phase))) {
      preparationPlugins.add(plugin.artifactId);
    }
    if (plugin.artifactId === 'maven-toolchains-plugin') throw new UnsupportedProject('Maven toolchains are not supported yet.');
    const configurations = [plugin.configuration, ...executions.map(e => e.configuration)].filter(Boolean);
    for (const config of configurations) {
      if (plugin.artifactId === 'maven-compiler-plugin') {
        if (config.fork === 'true' || config.executable || config.jdkToolchain || (config.compilerId && config.compilerId !== 'javac')) {
          throw new UnsupportedProject('Custom compiler executables and toolchains are not supported yet.');
        }
        if (config.outputDirectory && directory(config.outputDirectory) !== metadata.classesDir) {
          throw new UnsupportedProject('Extra compiler output directories are not supported yet.');
        }
        if (config.generatedSourcesDirectory) metadata.generatedSourceDirectories.push(directory(config.generatedSourcesDirectory));
      }
      if (plugin.artifactId === 'maven-surefire-plugin') {
        if (config.jvm || config.jdkToolchain) throw new UnsupportedProject('Custom test JVMs are not supported yet.');
        if (config.reportsDirectory) {
          const reportDirectory = directory(config.reportsDirectory);
          if (config !== plugin.configuration && reportDirectory !== metadata.testReportsDir) {
            throw new UnsupportedProject('Per-execution Surefire report directories are not supported yet.');
          }
          metadata.testReportsDir = reportDirectory;
        }
      }
    }
  }
  metadata.sourceRoots = [metadata.sourceDirectory];
  metadata.preparationPluginArtifactIds = [...preparationPlugins].sort();
  return metadata;
}

/** Discover source evidence from the completed compilation, not a guessed project-wide scan. */
export async function readMavenSources(metadata: MavenMetadata, projectDir: string): Promise<Pick<MavenMetadata,
  'sourceFiles' | 'sourceRoots' | 'generatedSourceDirectories'>> {
  const compilerStatus = path.join(metadata.buildDirectory, 'maven-status', 'maven-compiler-plugin', 'compile');
  let executions;
  try { executions = await readdir(compilerStatus, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new UnsupportedProject('Maven Compiler inputFiles.lst is required for source discovery.');
    throw error;
  }
  const inputs = new Set<string>();
  for (const execution of executions.filter(entry => entry.isDirectory())) {
    let contents: string;
    try { contents = await readFile(path.join(compilerStatus, execution.name, 'inputFiles.lst'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const file of contents.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) inputs.add(projectPath(projectDir, file));
  }
  if (!inputs.size) throw new UnsupportedProject('Maven Compiler inputFiles.lst contains no source inputs.');
  const generatedSourceDirectories: string[] = [];
  for (const directory of new Set(metadata.generatedSourceDirectories)) {
    try { if ((await stat(directory)).isDirectory()) generatedSourceDirectories.push(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const sourceFiles = [...inputs].sort();
  return {
    sourceFiles,
    sourceRoots: [...new Set([...sourceFiles.map(file => path.dirname(file)), ...generatedSourceDirectories])].sort(),
    generatedSourceDirectories,
  };
}

export function summarizeSurefire(reports: { file: string; content: string }[]): MavenTestResult {
  const result: MavenTestResult = { status: 'not_run', tests: 0, failures: 0, errors: 0, skipped: 0, reportFiles: [] };
  for (const report of reports) {
    const suite = xml(report.content).testsuite;
    if (!suite) throw new Error(`Surefire report has no testsuite: ${report.file}`);
    for (const key of ['tests', 'failures', 'errors', 'skipped'] as const) {
      const count = Number(suite[`@_${key}`] ?? 0);
      if (!Number.isInteger(count) || count < 0) throw new Error(`Invalid ${key} count in ${report.file}`);
      result[key] += count;
    }
    result.reportFiles.push(report.file);
  }
  if (result.failures || result.errors) result.status = 'failed';
  else if (result.tests > result.skipped) result.status = 'passed';
  return result;
}

async function testReports(directory: string): Promise<MavenTestResult> {
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return summarizeSurefire([]); throw error; }
  const reports = await Promise.all(files.filter(name => /^TEST-.*\.xml$/.test(name)).sort().map(async name => {
    const file = path.join(directory, name);
    return { file, content: await readFile(file, 'utf8') };
  }));
  return summarizeSurefire(reports);
}

async function mavenProject(options: MavenOptions, mode: 'prepare' | 'check'): Promise<MavenReport> {
  const started = Date.now();
  const projectDir = path.resolve(options.projectDir);
  const evidenceDir = path.resolve(options.evidenceDir);
  await mkdir(evidenceDir, { recursive: true });
  const report: MavenReport = {
    status: 'failed', build: 'not_run', test: summarizeSurefire([]), versions: {}, stages: [], diagnostics: [],
    reportPath: path.join(evidenceDir, `${mode}-report.json`), durationMs: 0,
  };
  const deadline = started + options.timeoutMs;
  const args = ['--batch-mode', '--no-transfer-progress', '--non-recursive', '-Dstyle.color=never'];
  if (options.repositoryDir) args.push(`-Dmaven.repo.local=${path.resolve(options.repositoryDir)}`);
  if (mode === 'check' || options.offline) args.push('--offline');
  const run = async (name: string, commandArgs: string[]) => {
    const logBase = path.join(evidenceDir, `${mode}-${name}`);
    const result = await runProcess('mvn', [...args, ...commandArgs], projectDir, logBase, deadline, options.signal);
    report.stages.push({ name, logBase, ...result });
    if (result.stopped) report.status = 'timeout';
    if (result.error || result.stopped || result.code !== 0) {
      report.diagnostics.push(`${name}: ${result.error ?? (result.stopped ? 'cancelled or timed out' : `exit ${result.code}`)}`);
      return false;
    }
    return true;
  };
  const finish = async () => {
    report.durationMs = Date.now() - started;
    await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  };
  try {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('timeoutMs must be positive.');
    if (!await run('versions', ['--version'])) return await finish();
    const versionOutput = report.stages.at(-1)!.tail;
    report.versions = { maven: versionOutput.match(/Apache Maven ([\d.]+)/)?.[1], java: versionOutput.match(/Java version: ([^,\s]+)/)?.[1] };
    if (!report.versions.maven?.startsWith('3.') || !report.versions.java?.startsWith('17.')) {
      throw new UnsupportedProject('This adapter requires Maven 3 running on JDK 17.');
    }
    const effectivePom = path.join(evidenceDir, 'effective-pom.xml');
    if (mode === 'prepare') {
      if (!await run('effective-pom', [`${HELP}:effective-pom`, `-Doutput=${effectivePom}`])) return await finish();
      report.metadata = parseMavenMetadata(await readFile(effectivePom, 'utf8'), projectDir);
      if (!await run('plugins', [`${DEPENDENCY}:resolve-plugins`,
        `-DincludeArtifactIds=${report.metadata.preparationPluginArtifactIds.join(',')}`])) return await finish();
      const preparedClasspath = path.join(evidenceDir, 'prepared-classpath.txt');
      if (!await run('dependencies', [`${DEPENDENCY}:build-classpath`, `-Dmdep.outputFile=${preparedClasspath}`])) return await finish();
      report.metadata.classpath = (await readFile(preparedClasspath, 'utf8')).trim().split(path.delimiter).filter(Boolean);
      await writeFile(path.join(evidenceDir, 'maven-metadata.json'), `${JSON.stringify(report.metadata, null, 2)}\n`);
      report.status = 'prepared';
    } else {
      const metadata = parseMavenMetadata(await readFile(effectivePom, 'utf8'), projectDir);
      report.metadata = metadata;
      report.build = 'failed';
      if (!await run('compile', ['clean', 'compile'])) return await finish();
      Object.assign(metadata, await readMavenSources(metadata, projectDir));
      if (!(await stat(metadata.classesDir)).isDirectory()) throw new Error('Maven class output directory is missing.');
      const classpathFile = path.join(evidenceDir, 'classpath.txt');
      if (!await run('classpath', [`${DEPENDENCY}:build-classpath`, `-Dmdep.outputFile=${classpathFile}`])) return await finish();
      metadata.classpath = (await readFile(classpathFile, 'utf8')).trim().split(path.delimiter).filter(Boolean);
      report.build = 'passed';
      const testSucceeded = await run('test', ['test']);
      report.test = await testReports(metadata.testReportsDir);
      if (!testSucceeded) {
        report.test.status = 'failed';
        return await finish();
      }
      report.status = report.test.status === 'failed' ? 'failed' : 'completed';
    }
  } catch (error) {
    report.status = error instanceof UnsupportedProject ? 'unsupported' : 'failed';
    report.diagnostics.push(String(error));
  }
  return await finish();
}

export const prepareMavenProject = (options: MavenOptions): Promise<MavenReport> => mavenProject(options, 'prepare');
export const checkMavenProject = (options: MavenOptions): Promise<MavenReport> => mavenProject(options, 'check');
