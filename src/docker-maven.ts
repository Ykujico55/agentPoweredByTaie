import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProcess } from './process.ts';
import { getDefaultJarPath, TAIE_SHA256, type AnalyzeJavaProjectOptions, type AnalysisReport } from './taie.ts';
import type { MavenReport } from './maven.ts';
import { writeStructuredOutputs } from './reporting.ts';

export const MAVEN_IMAGE = 'taie-agent-maven:0.1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAVEN_REPOSITORY_VOLUME = `taie-maven-repository-v1-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
const excluded = new Set(['.git', '.taie-agent', '.tools', 'node_modules', 'target', 'build', '.gradle', '.m2']);

/** The same selection is hashed before copying and after checking, including POMs and tests. */
export async function projectSnapshot(projectDir: string, destination?: string, ignoredRelativeDirs: string[] = []): Promise<string> {
  const digest = createHash('sha256');
  async function visit(relative: string) {
    const entries = await readdir(path.join(projectDir, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if ((!relative && excluded.has(entry.name)) || /^\.env(?:\.|$)/.test(entry.name)) continue;
      const name = path.join(relative, entry.name);
      if (ignoredRelativeDirs.some(dir => name === dir || name.startsWith(`${dir}${path.sep}`))) continue;
      if (entry.isSymbolicLink()) throw new Error(`Project symlinks are not supported by this snapshot: ${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        const contents = await readFile(path.join(projectDir, name));
        digest.update(name.replaceAll('\\', '/')).update('\0').update(contents).update('\0');
        if (destination) {
          await mkdir(path.dirname(path.join(destination, name)), { recursive: true });
          await writeFile(path.join(destination, name), contents);
        }
      }
    }
  }
  await visit('');
  return digest.digest('hex');
}

export interface MavenCheckOptions extends AnalyzeJavaProjectOptions {
  /** Permit network only during explicit dependency preparation; checks always run offline. */
  dependencyNetwork?: boolean;
  /** Include dependency details in a separate list; never change the project gate. */
  includeDependencies?: boolean;
}
export interface MavenCheckResult {
  schemaVersion: 2;
  statusScope: 'project';
  includeDependencies: boolean;
  status: 'passed' | 'findings' | 'build_failed' | 'test_failed' | 'tests_not_run' | 'analysis_failed' | 'unsupported' | 'timeout' | 'error' | 'stale';
  projectDir: string;
  runDir: string;
  reportPath: string;
  image: string;
  imageId?: string;
  storage: { backend: 'docker-volumes'; repositoryVolume: string; recoveryVolume?: string };
  snapshotFingerprint?: string;
  durationMs?: number;
  dependencyNetwork: boolean;
  checkNetwork: 'none';
  preparation?: MavenReport;
  maven?: MavenReport;
  analysis?: AnalysisReport;
  review: 'not_run';
  diagnostics: string[];
}

export async function checkMavenInDocker(options: MavenCheckOptions): Promise<MavenCheckResult> {
  const started = Date.now();
  const projectDir = path.resolve(options.projectDir);
  const runDir = path.join(projectDir, '.taie-agent', 'maven-runs', `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(runDir, { recursive: true });
  const result: MavenCheckResult = {
    schemaVersion: 2, statusScope: 'project', includeDependencies: options.includeDependencies ?? false,
    status: 'error', projectDir, runDir, reportPath: path.join(runDir, 'report.json'),
    image: MAVEN_IMAGE, storage: { backend: 'docker-volumes', repositoryVolume: MAVEN_REPOSITORY_VOLUME },
    dependencyNetwork: options.dependencyNetwork ?? false, checkNetwork: 'none', review: 'not_run', diagnostics: [],
  };
  const deadline = started + (options.timeoutMs ?? 600_000);
  let work = path.join(runDir, 'snapshot');
  const input = path.join(runDir, 'input');
  const storageId = randomUUID();
  const workVolume = `taie-maven-work-${storageId}`;
  const inputVolume = `taie-maven-input-${storageId}`;
  const transfer = `taie-maven-transfer-${storageId}`;
  let storageStarted = false;
  const mounts = ['--mount', `type=volume,source=${workVolume},target=/workspace`,
    '--mount', `type=volume,source=${inputVolume},target=/input,readonly`,
    '--mount', `type=volume,source=${MAVEN_REPOSITORY_VOLUME},target=/maven-repository`];
  const dockerStep = async (name: string, args: string[], cleanup = false) => {
    const step = await runProcess('docker', args, root, path.join(runDir, name),
      cleanup ? Date.now() + 60_000 : deadline, cleanup ? undefined : options.signal);
    if (step.code !== 0 || step.error || step.stopped) throw new Error(`${name}: ${step.error ?? step.tail}`);
    return step;
  };
  const removeContainer = async (name: string, log: string) => {
    const cleanup = await runProcess('docker', ['rm', '-f', name], root, path.join(runDir, log), Date.now() + 10_000);
    if (cleanup.code !== 0 && !/No such container/i.test(cleanup.tail))
      throw new Error(`Container cleanup failed for ${name}: ${cleanup.error ?? cleanup.tail}`);
  };
  const localPaths = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (value.startsWith('/workspace/')) return path.join(work, value.slice('/workspace/'.length));
      if (value.startsWith('/input/')) return path.join(input, value.slice('/input/'.length));
      if (value.startsWith('/maven-repository/')) return path.join(work, 'dependencies', value.slice('/maven-repository/'.length));
      if (value.startsWith('file:///workspace/')) return pathToFileURL(path.join(work, decodeURIComponent(value.slice('file:///workspace/'.length)))).href;
    }
    if (Array.isArray(value)) return value.map(localPaths);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, localPaths(child)]));
    return value;
  };
  try {
    if (options.sourceRoots || options.classpath || options.compiledClassesDir)
      throw new Error('check-maven gets source roots, classpath and classes from Maven; manual overrides are not supported.');
    if (options.javaVersion !== undefined && options.javaVersion !== 17) throw new Error('check-maven currently supports JDK 17 only.');
    const daemon = await runProcess('docker', ['info', '--format', '{{.OSType}}'], root, path.join(runDir, 'docker-info'), deadline, options.signal);
    if (daemon.code !== 0 || daemon.error || daemon.stopped || daemon.tail.trim() !== 'linux')
      throw new Error(`A running Docker Linux engine is required. ${daemon.error ?? daemon.tail}`);
    const image = await runProcess('docker', ['image', 'inspect', '--format', '{{.Id}}', MAVEN_IMAGE], root, path.join(runDir, 'docker-image'), deadline, options.signal);
    if (image.code !== 0 || image.error || image.stopped) throw new Error('Maven image missing. Run npm run build:maven-image.');
    result.imageId = image.tail.trim();
    await mkdir(path.join(work, 'project'), { recursive: true });
    await mkdir(input);
    result.snapshotFingerprint = await projectSnapshot(projectDir, path.join(work, 'project'));
    const selectedJar = options.jarPath ?? process.env.TAIE_JAR;
    const jarContents = await readFile(path.resolve(projectDir, selectedJar ?? getDefaultJarPath()));
    if (!selectedJar && createHash('sha256').update(jarContents).digest('hex') !== TAIE_SHA256)
      throw new Error('Default Tai-e JAR SHA-256 mismatch. Select a development build explicitly with --jar.');
    await writeFile(path.join(input, 'tai-e.jar'), jarContents);
    const workerOptions: AnalyzeJavaProjectOptions & { includeDependencies: boolean } = {
      projectDir: '/workspace/project', analyses: options.analyses, mainClass: options.mainClass,
      timeoutMs: Math.max(1, deadline - Date.now()), taintImplicitEntries: options.taintImplicitEntries,
      includeDependencies: result.includeDependencies,
    };
    if (options.taintConfig) {
      await writeFile(path.join(input, 'taint.yml'), options.taintConfigContent ?? await readFile(path.resolve(projectDir, options.taintConfig)));
      workerOptions.taintConfig = '/input/taint.yml';
    }
    // Only this trusted initialization process runs as root; project execution stays uid 1000.
    storageStarted = true;
    await dockerStep('repository-volume', ['volume', 'create', MAVEN_REPOSITORY_VOLUME]);
    await dockerStep('workspace-volume', ['volume', 'create', workVolume]);
    await dockerStep('input-volume', ['volume', 'create', inputVolume]);
    await dockerStep('transfer-create', ['create', '--name', transfer, '--network', 'none', '--read-only',
      '--user', '0:0', '--cap-drop=ALL', '--cap-add=CHOWN', '--security-opt=no-new-privileges',
      '--cpus=2', '--memory=512m', '--pids-limit=64',
      ...mounts.map(arg => arg.replace('target=/input,readonly', 'target=/input')),
      '--entrypoint', 'node', result.imageId!, '/opt/runner/containers/maven/storage.ts', 'initialize']);
    await dockerStep('snapshot-import', ['cp', path.join(work, 'project'), `${transfer}:/workspace/`]);
    await writeFile(path.join(input, 'options.json'), JSON.stringify(workerOptions));
    await dockerStep('input-import', ['cp', `${input}${path.sep}.`, `${transfer}:/input/`]);
    await dockerStep('storage-initialize', ['start', '-a', transfer]);
    const container = async (phase: 'prepare' | 'check') => {
      const name = `taie-maven-${randomUUID()}`;
      workerOptions.timeoutMs = Math.max(1, deadline - Date.now());
      await writeFile(path.join(input, 'options.json'), JSON.stringify(workerOptions));
      await dockerStep(`${phase}-options`, ['cp', path.join(input, 'options.json'), `${transfer}:/input/options.json`]);
      const args = ['run', '--rm', '--init', '--name', name, '--pull=never',
        '--network', phase === 'prepare' && options.dependencyNetwork ? 'bridge' : 'none',
        '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--cpus=2', '--memory=2g', '--pids-limit=256', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=256m',
        '--user', '1000:1000', ...mounts,
        result.imageId!, phase, phase === 'prepare' && options.dependencyNetwork ? 'online' : 'offline'];
      try {
        return await runProcess('docker', args, root, path.join(runDir, phase), deadline, options.signal);
      } finally {
        // Killing the docker CLI does not stop its container. Remove exactly this task's named container.
        await removeContainer(name, `${phase}-cleanup`);
        // Stop all project processes before validating and exporting their output.
        try {
          const exporter = `taie-maven-export-${randomUUID()}`;
          try {
            await dockerStep(`${phase}-export-validate`, ['run', '--rm', '--name', exporter,
              '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop=ALL',
              '--security-opt=no-new-privileges', '--cpus=2', '--memory=512m', '--pids-limit=64',
              ...mounts, '--entrypoint', 'node', result.imageId!, '/opt/runner/containers/maven/storage.ts', 'export'], true);
          } finally { await removeContainer(exporter, `${phase}-export-cleanup`); }
          work = path.join(runDir, `${phase}-workspace`);
          await mkdir(work);
          await dockerStep(`${phase}-export`, ['cp', `${transfer}:/workspace/.`, work], true);
        } catch (error) {
          result.storage.recoveryVolume = workVolume;
          result.diagnostics.push(`Workspace export failed; evidence retained in Docker volume ${workVolume}.`);
          throw error;
        }
      }
    };
    const preparation = await container('prepare');
    if (preparation.stopped) {
      result.status = 'timeout'; result.diagnostics.push('Dependency preparation timed out or was cancelled; see prepare logs.'); return result;
    }
    if (preparation.error) throw new Error(preparation.error);
    result.preparation = localPaths(JSON.parse(await readFile(path.join(work, 'preparation.json'), 'utf8'))) as MavenReport;
    result.diagnostics.push(...result.preparation.diagnostics);
    if (result.preparation.status !== 'prepared') {
      result.status = result.preparation.status === 'unsupported' ? 'unsupported'
        : result.preparation.status === 'timeout' ? 'timeout' : 'build_failed';
      return result;
    }
    const snapshotDir = path.join(work, 'project');
    const metadata = result.preparation.metadata!;
    const outputDirectories = [...new Set([metadata.buildDirectory, metadata.classesDir, metadata.testClassesDir,
      metadata.testReportsDir, ...metadata.generatedSourceDirectories])];
    const sourceDirectories = [metadata.sourceDirectory, path.join(snapshotDir, 'src', 'test', 'java')];
    const coversInput = outputDirectories.some(directory => directory === snapshotDir || sourceDirectories.some(source => {
      const relative = path.relative(directory, source);
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    }));
    if (coversInput) {
      result.status = 'unsupported';
      result.diagnostics.push('Maven output directories must not cover the project root or source input directories.');
      return result;
    }
    if (await projectSnapshot(projectDir) !== result.snapshotFingerprint) {
      result.status = 'stale';
      result.diagnostics.push('Original project inputs changed during dependency preparation.');
      return result;
    }
    const ignoredOutputDirs = outputDirectories.map(directory => path.relative(snapshotDir, directory));
    const filteredBaseline = await projectSnapshot(projectDir, undefined, ignoredOutputDirs);
    const checked = await container('check');
    if (checked.stopped) {
      result.status = 'timeout'; result.diagnostics.push('Offline check timed out or was cancelled; see check logs.'); return result;
    }
    if (checked.error) throw new Error(checked.error);
    const payload = localPaths(JSON.parse(await readFile(path.join(work, 'check.json'), 'utf8'))) as { maven: MavenReport; analysis?: AnalysisReport };
    result.maven = payload.maven;
    result.analysis = payload.analysis;
    if (result.analysis?.status === 'completed' && result.analysis.findingScope !== 'project') {
      throw new Error('Maven image lacks project/dependency classification. Rebuild with npm run build:maven-image.');
    }
    result.diagnostics.push(...payload.maven.diagnostics, ...(payload.analysis?.diagnostics ?? []));
    if (result.analysis) {
      const analysisDir = path.join(runDir, 'analysis');
      await mkdir(analysisDir);
      result.analysis.evidence.containerReport = result.analysis.reportPath;
      result.analysis.runDir = analysisDir;
      result.analysis.reportPath = path.join(analysisDir, 'report.json');
      await writeStructuredOutputs(result.analysis);
      await writeFile(result.analysis.reportPath, JSON.stringify(result.analysis, null, 2));
    }
    result.status = payload.maven.status === 'timeout' || payload.analysis?.status === 'timeout' ? 'timeout'
      : payload.maven.status === 'unsupported' ? 'unsupported'
      : payload.maven.build !== 'passed' ? 'build_failed'
      : payload.maven.status !== 'completed' ? 'test_failed'
      : payload.maven.test.status === 'failed' ? 'test_failed'
      : payload.analysis?.status !== 'completed' ? 'analysis_failed'
      : payload.maven.test.status !== 'passed' ? 'tests_not_run'
      : payload.analysis.findings.length ? 'findings' : 'passed';
    if (result.status === 'passed' && checked.code !== 0) throw new Error(`Container check failed with exit code ${checked.code}.`);
    if (await projectSnapshot(projectDir) !== result.snapshotFingerprint
        || await projectSnapshot(path.join(work, 'project'), undefined, ignoredOutputDirs) !== filteredBaseline) {
      result.status = 'stale';
      result.diagnostics.push('Project inputs changed after snapshot creation (in the original project or during its build/tests).');
    }
  } catch (error) {
    result.status = options.signal?.aborted || Date.now() >= deadline ? 'timeout' : 'error';
    result.diagnostics.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (storageStarted) {
      try { await removeContainer(transfer, 'transfer-cleanup'); }
      catch (error) { result.diagnostics.push(String(error)); result.status = 'error'; }
      for (const volume of [workVolume, inputVolume]) {
        if (volume === result.storage.recoveryVolume) continue;
        const cleanup = await runProcess('docker', ['volume', 'rm', volume], root,
          path.join(runDir, volume === workVolume ? 'workspace-volume-cleanup' : 'input-volume-cleanup'), Date.now() + 10_000);
        if (cleanup.code !== 0 && !/no such volume/i.test(cleanup.tail)) {
          result.diagnostics.push(`Volume cleanup failed for ${volume}: ${cleanup.error ?? cleanup.tail}`);
          result.status = 'error';
        }
      }
    }
    result.durationMs = Date.now() - started;
    await writeFile(result.reportPath, JSON.stringify(result, null, 2));
  }
  return result;
}
