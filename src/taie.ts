import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeFindings, writeStructuredOutputs } from './reporting.ts';
import { runProcess, type ProcessResult } from './process.ts';

export const TAIE_VERSION = '0.5.4';
export const TAIE_SHA256 = '703d1750b66e8e621d628ac93b07a21315db795b3a1e2224001ad09190c1e4be';
export const DEFAULT_ANALYSES = ['dropped-exception', 'clone-idiom', 'dead-code'];
export const EXTENDED_ANALYSES = [...DEFAULT_ANALYSES, 'null-pointer', 'division-by-zero'];
export const SUPPORTED_ANALYSES = [...EXTENDED_ANALYSES, 'taint'];
const installationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function getDefaultJarPath(): string {
  return path.join(installationRoot, '.tools', 'tai-e', `tai-e-all-${TAIE_VERSION}.jar`);
}
export function getJavaExecutables(): { java: string; javac: string } {
  const javaHome = process.env.TAIE_JAVA_HOME || process.env.JAVA_HOME;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return javaHome
    ? { java: path.join(javaHome, 'bin', `java${suffix}`), javac: path.join(javaHome, 'bin', `javac${suffix}`) }
    : { java: 'java', javac: 'javac' };
}
const javacVmArgs = ['-J-Duser.language=en', '-J-Duser.country=US', '-J-Dfile.encoding=UTF-8',
  '-J-Dstdout.encoding=UTF-8', '-J-Dstderr.encoding=UTF-8'];

export interface EvidenceLocation {
  className?: string;
  method?: string;
  sourcePath?: string;
  line?: number;
  statement?: string;
}
export interface Finding {
  id: string;
  analysis: string;
  type: string;
  severity?: string | number;
  className?: string;
  method?: string;
  startLine?: number;
  endLine?: number;
  sourcePath?: string;
  snippet?: string;
  message: string;
  ruleId?: string;
  confidence?: 'high' | 'medium' | 'low';
  evidence?: {
    kind?: string;
    source?: EvidenceLocation;
    sink?: EvidenceLocation;
    path?: EvidenceLocation[];
    [key: string]: unknown;
  };
}
export interface AnalyzeJavaProjectOptions {
  projectDir: string;
  /** Internal build integration: analyze these freshly built classes without recompiling sources. */
  compiledClassesDir?: string;
  jarPath?: string;
  analyses?: string[];
  sourceRoots?: string[];
  classpath?: string[];
  mainClass?: string;
  taintConfig?: string;
  /** Internal immutable snapshot used by agent sessions. */
  taintConfigContent?: string;
  /** Include modeled JVM implicit entries. Enabled unless explicitly disabled. */
  taintImplicitEntries?: boolean;
  /** javac --release target. Analysis models the installed JDK's runtime library. */
  javaVersion?: number;
  /** End-to-end deadline, including compilation. */
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface AnalysisReport {
  schemaVersion: 2;
  runId: string;
  status: 'completed' | 'compile_failed' | 'analysis_failed' | 'timeout';
  projectDir: string;
  findings: Finding[];
  reportPath: string;
  runDir: string;
  diagnostics: string[];
  limitations: string[];
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  sourceFingerprint?: string;
  sourceFiles: string[];
  sourceRoots: string[];
  classpath: string[];
  analyses: string[];
  compileRelease?: number;
  taiE: {
    artifactKind: 'official-release' | 'custom';
    baselineVersion: string;
    expectedVersion?: string;
    version?: string;
    commit?: string;
    javaVersion?: string;
    jarPath: string;
    sha256?: string;
  };
  analyzedEntities?: Record<string, number>;
  analysisMetadata?: Record<string, unknown>;
  taintConfiguration?: { originalPath: string; snapshotPath: string; sha256: string; implicitEntries: boolean };
  evidence: Record<string, string>;
}

const ignoredDirectories = new Set([
  '.git', '.tools', '.taie-agent', 'node_modules', 'target', 'build', 'out', 'dist', '.gradle',
  '.idea',
]);
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}
async function javaFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) files.push(...await javaFiles(path.join(root, entry.name)));
    else if (entry.isFile() && entry.name.endsWith('.java')) files.push(path.join(root, entry.name));
  }
  return files.sort();
}
async function fingerprint(files: string[]): Promise<string> {
  const digest = createHash('sha256');
  for (const file of [...files].sort()) digest.update(file).update('\0').update(await readFile(file)).update('\0');
  return digest.digest('hex');
}
function argumentFileValue(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Java arguments must not contain line breaks or NUL.');
  return `"${value.replaceAll('\\', '/').replaceAll('"', '\\"')}"`;
}

export async function analyzeJavaProject(options: AnalyzeJavaProjectOptions): Promise<AnalysisReport> {
  const started = Date.now();
  const projectDir = path.resolve(options.projectDir);
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(projectDir, '.taie-agent', 'runs', runId);
  await mkdir(runDir, { recursive: true });
  // An explicit path is an intentional opt-in to a locally built or forked analyzer.
  const customJar = options.jarPath || process.env.TAIE_JAR || undefined;
  const report: AnalysisReport = {
    schemaVersion: 2, runId, status: 'analysis_failed', projectDir, runDir,
    findings: [], reportPath: path.join(runDir, 'report.json'), diagnostics: [],
    limitations: [
      'These checks cover configured bug patterns; an empty result is not proof that the program has no bugs.',
      options.compiledClassesDir ? 'Analyzing supplied build output; the build integration owns compilation and dependency resolution.'
        : 'Dependencies must be supplied explicitly through classpath; Maven/Gradle dependency resolution is not automatic.',
      'Tai-e analyzes against the installed JDK runtime. javaVersion controls javac --release only.',
      'Reflection, native code, frameworks, and incomplete models may cause missed or spurious findings.',
      'In this Tai-e version APP includes loaded non-JRE dependency classes; findings may originate in libraries.',
    ],
    startedAt: new Date(started).toISOString(), sourceFiles: [], sourceRoots: [],
    classpath: (options.classpath ?? []).map((p) => path.resolve(projectDir, p)),
    analyses: [...new Set(options.analyses ?? DEFAULT_ANALYSES)], compileRelease: options.javaVersion,
    taiE: {
      artifactKind: customJar ? 'custom' : 'official-release',
      baselineVersion: TAIE_VERSION,
      ...(customJar ? {} : { expectedVersion: TAIE_VERSION }),
      jarPath: path.resolve(projectDir, customJar ?? getDefaultJarPath()),
    },
    evidence: {},
  };
  const deadline = started + (options.timeoutMs ?? 120_000);
  const finish = async () => {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - started;
    await writeStructuredOutputs(report);
    await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    return report;
  };
  const run = async (name: string, command: string, args: string[]) => {
    const base = path.join(runDir, name);
    report.evidence[`${name}Stdout`] = `${base}.stdout.log`;
    report.evidence[`${name}Stderr`] = `${base}.stderr.log`;
    report.evidence[`${name}Command`] = `${base}.command.json`;
    report.evidence[`${name}Result`] = `${base}.result.json`;
    return await runProcess(command, args, projectDir, base, deadline, options.signal);
  };
  const check = (result: ProcessResult, failureStatus: AnalysisReport['status']): boolean => {
    if (result.stopped) {
      report.status = 'timeout';
      report.diagnostics.push(options.signal?.aborted ? 'Analysis cancelled by caller.' : 'Analysis deadline exceeded.');
      return false;
    }
    if (result.error || result.code !== 0) {
      report.status = failureStatus;
      report.diagnostics.push(result.error ?? `Process exited with code ${result.code}.`);
      if (result.tail.trim()) report.diagnostics.push(result.tail.trim());
      return false;
    }
    return true;
  };
  try {
    if (!Number.isFinite(options.timeoutMs ?? 120_000) || (options.timeoutMs ?? 120_000) <= 0)
      throw new Error('timeoutMs must be a positive finite number.');
    if (report.analyses.length === 0 || report.analyses.some((a) => !SUPPORTED_ANALYSES.includes(a)))
      throw new Error(`Supported analyses: ${SUPPORTED_ANALYSES.join(', ')}. At least one is required.`);
    if (options.javaVersion !== undefined && (!Number.isInteger(options.javaVersion) || options.javaVersion < 8))
      throw new Error('javaVersion must be an integer javac --release target >= 8.');
    if (report.analyses.includes('division-by-zero') && !customJar)
      throw new Error('division-by-zero requires the extended source build. Use npm run start:extended or select its JAR explicitly.');
    if (report.analyses.includes('null-pointer') && !customJar) report.limitations.push(
      'Tai-e 0.5.4 null-pointer has a known upstream crash on some null-literal dereferences; such runs fail explicitly.',
    );
    if (report.analyses.includes('division-by-zero')) report.limitations.push(
      'Division-by-zero detection reports provably zero integral divisors in the intraprocedural model; unknown values and floating-point operations are not reported.',
    );
    if (report.analyses.includes('taint')) {
      if (!options.mainClass) throw new Error('taint analysis requires mainClass (--main-class) so the analyzed entry point is explicit.');
      if (!options.taintConfig) throw new Error('taint analysis requires taintConfig (--taint-config).');
      const originalPath = path.resolve(projectDir, options.taintConfig);
      const content = options.taintConfigContent ?? await readFile(originalPath, 'utf8');
      const snapshotPath = path.join(runDir, 'taint-config.yml');
      await writeFile(snapshotPath, content, { flag: 'wx' });
      report.taintConfiguration = { originalPath, snapshotPath, sha256: hash(content), implicitEntries: options.taintImplicitEntries ?? true };
      report.evidence.taintConfig = snapshotPath;
      report.limitations.push('Taint paths are abstract object/data-flow evidence, not proof of a feasible runtime execution or exploit.');
      if (options.taintImplicitEntries === false)
        report.limitations.push('Implicit JVM entry modeling was explicitly disabled for this taint analysis; this can reduce coverage.');
    }
    if (!await exists(report.taiE.jarPath)) throw new Error(`Tai-e JAR missing: ${report.taiE.jarPath}. Run npm run setup:taie.`);
    report.taiE.sha256 = hash(await readFile(report.taiE.jarPath));
    if (!customJar && report.taiE.sha256 !== TAIE_SHA256)
      throw new Error(`Tai-e JAR SHA-256 mismatch; expected the official ${TAIE_VERSION} release. Select a development build explicitly with --jar or TAIE_JAR.`);
    if (customJar) report.limitations.push(
      'A custom Tai-e artifact was explicitly selected. Its actual version and SHA-256 are recorded; the official release checksum is not applicable.',
    );
    if (customJar) {
      const manifestPath = path.join(installationRoot, '.tools', 'tai-e', 'source-build.json');
      try {
        const contents = await readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(contents) as { jarPath?: string; sha256?: string };
        if (manifest.jarPath && path.resolve(manifest.jarPath).toLowerCase() === report.taiE.jarPath.toLowerCase()
            && manifest.sha256 === report.taiE.sha256) {
          const snapshot = path.join(runDir, 'source-build.json');
          await writeFile(snapshot, contents, { flag: 'wx' });
          report.evidence.sourceBuildManifest = snapshot;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report.limitations.push('Local build provenance could not be read; the actual JAR hash is still recorded.');
      }
    }
    const javaExecutables = getJavaExecutables();
    for (const dependency of report.classpath) await stat(dependency);
    const defaults = await exists(path.join(projectDir, 'src', 'main', 'java')) ? ['src/main/java']
      : await exists(path.join(projectDir, 'src')) ? ['src'] : ['.'];
    report.sourceRoots = (options.sourceRoots ?? defaults).map((p) => path.resolve(projectDir, p));
    if (report.sourceRoots.length === 0) throw new Error('sourceRoots must contain at least one directory.');
    report.sourceFiles = [...new Set((await Promise.all(report.sourceRoots.map(javaFiles))).flat())].sort();
    if (report.sourceFiles.length === 0) {
      report.status = 'compile_failed';
      throw new Error(`No Java source files found in ${report.sourceRoots.join(', ')}.`);
    }
    report.sourceFingerprint = await fingerprint(report.sourceFiles);
    const classes = options.compiledClassesDir ? path.resolve(projectDir, options.compiledClassesDir) : path.join(runDir, 'classes');
    if (options.compiledClassesDir) {
      if (!(await stat(classes)).isDirectory()) throw new Error('Compiled classes directory is missing.');
      report.evidence.compiledClasses = classes;
    } else {
      await mkdir(classes);
      const compileArgs = ['-g', '-encoding', 'UTF-8', '-proc:none', '-d', classes];
      if (options.javaVersion !== undefined) compileArgs.push('--release', String(options.javaVersion));
      if (report.classpath.length) compileArgs.push('-classpath', report.classpath.join(path.delimiter));
      compileArgs.push(...report.sourceFiles);
      const compileArgsPath = path.join(runDir, 'javac.args');
      await writeFile(compileArgsPath, compileArgs.map(argumentFileValue).join('\n'));
      report.evidence.compileArguments = compileArgsPath;
      if (!check(await run('compile', javaExecutables.javac, [...javacVmArgs, `@${compileArgsPath}`]), 'compile_failed')) return await finish();
    }

    const adapterDirectory = path.join(installationRoot, 'java-adapter');
    const adapterSources = (await readdir(adapterDirectory)).filter(name => name.endsWith('.java')).sort();
    if (!adapterSources.includes('TaieAgentExporter.java')) throw new Error('Java adapter source is missing.');
    const exporterSources = path.join(runDir, 'exporter-src');
    const exporterClasses = path.join(runDir, 'exporter-classes');
    await mkdir(exporterSources);
    const exporterJavaFiles: string[] = [];
    const adapterDigest = createHash('sha256');
    for (const name of adapterSources) {
      const destination = path.join(exporterSources, name);
      const contents = await readFile(path.join(adapterDirectory, name));
      await writeFile(destination, contents);
      adapterDigest.update(name).update('\0').update(contents).update('\0');
      exporterJavaFiles.push(destination);
    }
    report.evidence.exporterSources = exporterSources;
    report.analysisMetadata = { adapterFingerprint: adapterDigest.digest('hex') };
    await mkdir(exporterClasses);
    if (!check(await run('exporter-compile', javaExecutables.javac, [...javacVmArgs, '-encoding', 'UTF-8', '-proc:none', '-cp', report.taiE.jarPath,
      '-d', exporterClasses, ...exporterJavaFiles]), 'analysis_failed')) return await finish();
    const rawPath = path.join(runDir, 'findings.raw.json');
    const taieOutput = path.join(runDir, 'tai-e-output');
    const args = ['-Duser.language=en', '-Duser.country=US', '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
      '-cp', [exporterClasses, report.taiE.jarPath].join(path.delimiter), 'TaieAgentExporter', rawPath,
      report.analyses.join(','), '-acp', classes, '-scope', 'APP', '--output-dir', taieOutput];
    if (options.mainClass) args.push('-m', options.mainClass);
    for (const entry of report.classpath) args.push('-cp', entry);
    const plan: { id: string; options?: Record<string, unknown> }[] = [];
    if (report.analyses.includes('taint')) {
      plan.push({ id: 'pta', options: {
        cs: 'ci', 'only-app': false,
        'implicit-entries': options.taintImplicitEntries ?? true,
        'taint-config': report.taintConfiguration!.snapshotPath,
        plugins: ['pascal.taie.analysis.pta.plugin.taint.AgentEvidencePlugin'],
      } });
    }
    if (report.analyses.includes('division-by-zero')) {
      plan.push({ id: 'throw', options: { exception: 'all', algorithm: 'intra' } });
      plan.push({ id: 'cfg', options: { exception: 'all' } });
    }
    for (const analysis of report.analyses) if (analysis !== 'taint') plan.push({ id: analysis });
    const planPath = path.join(runDir, 'analysis-plan.json');
    await writeFile(planPath, JSON.stringify(plan, null, 2));
    report.evidence.analysisPlan = planPath;
    args.push('-p', planPath);
    report.evidence.rawFindings = rawPath;
    report.evidence.taieLog = path.join(taieOutput, 'tai-e.log');
    report.evidence.taieOptions = path.join(taieOutput, 'options.yml');
    report.evidence.taiePlan = path.join(runDir, 'tai-e-plan.yml');
    const result = await run('analyze', javaExecutables.java, args);
    const analyzerLogs = (await Promise.all([
      readFile(report.evidence.analyzeStdout, 'utf8'), readFile(report.evidence.analyzeStderr, 'utf8'),
    ])).join('\n');
    report.taiE.version = analyzerLogs.match(/Tai-e Version:\s*(\S+)/)?.[1];
    report.taiE.commit = analyzerLogs.match(/Tai-e Commit:\s*(\S+)/)?.[1];
    report.taiE.javaVersion = analyzerLogs.match(/java.version:\s*(\S+)/)?.[1];
    if (!check(result, 'analysis_failed')) return await finish();
    if (!report.taiE.version) throw new Error('Tai-e version marker missing.');
    if (!customJar && report.taiE.version !== TAIE_VERSION)
      throw new Error(`Expected Tai-e ${TAIE_VERSION}; observed ${report.taiE.version}.`);
    if (!analyzerLogs.includes('TAIE_AGENT_EXPORT_COMPLETED ')) throw new Error('Structured exporter completion marker missing.');
    if (/phantom class|cannot resolve|class not found/i.test(analyzerLogs))
      throw new Error('Tai-e reported unresolved classes; analysis coverage is incomplete. Inspect the raw logs.');
    if (report.analyses.includes('taint') && /Cannot find (?:source|sink|taint-transfer|sanitizer) (?:method|field)|Unknown source kind|missing source "kind"/i.test(analyzerLogs))
      throw new Error('One or more configured taint rules could not be resolved. Fix the taint policy; unmatched rules are not treated as a clean analysis.');
    const raw: unknown = JSON.parse(await readFile(rawPath, 'utf8'));
    if (!raw || typeof raw !== 'object') throw new Error('Invalid structured analysis result.');
    const payload = raw as { schemaVersion?: unknown; findings?: unknown; analyzedEntities?: Record<string, unknown>; analysisMetadata?: Record<string, unknown> };
    if (payload.schemaVersion !== 2 || !Array.isArray(payload.findings) || !payload.analyzedEntities)
      throw new Error('Unrecognized structured analysis schema.');
    for (const analysis of report.analyses) {
      const count = payload.analyzedEntities[analysis];
      if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0)
        throw new Error(`No verified coverage count for ${analysis}.`);
    }
    const finalFiles = [...new Set((await Promise.all(report.sourceRoots.map(javaFiles))).flat())].sort();
    if (JSON.stringify(finalFiles) !== JSON.stringify(report.sourceFiles)
        || await fingerprint(finalFiles) !== report.sourceFingerprint)
      throw new Error('Java sources changed during analysis; this report cannot validate the current source.');
    const sources = new Map<string, { file: string; lines: string[] }>();
    for (const file of report.sourceFiles) {
      const content = await readFile(file, 'utf8');
      const packageName = content.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
      const className = path.basename(file, '.java');
      sources.set(packageName ? `${packageName}.${className}` : className, { file, lines: content.split(/\r?\n/) });
    }
    for (const value of payload.findings) {
      if (!value || typeof value !== 'object') throw new Error('Invalid finding entry.');
      const item = value as Record<string, unknown>;
      if (typeof item.type !== 'string' || typeof item.message !== 'string' || typeof item.analysis !== 'string'
          || !report.analyses.includes(item.analysis) || typeof item.className !== 'string')
        throw new Error('Unknown finding format.');
      const finding = { ...item, id: hash(JSON.stringify(item)).slice(0, 20) } as unknown as Finding;
      const source = sources.get(item.className.split('$')[0]);
      if (source) {
        finding.sourcePath = source.file;
        if (typeof finding.startLine === 'number' && finding.startLine > 0)
          finding.snippet = source.lines.slice(Math.max(0, finding.startLine - 3), finding.startLine + 2)
            .map((line, offset) => `${Math.max(1, finding.startLine! - 2) + offset}: ${line}`).join('\n');
      }
      const enrichLocation = (location?: EvidenceLocation) => {
        if (!location?.className) return;
        const referenced = sources.get(location.className.split('$')[0]);
        if (referenced) location.sourcePath = referenced.file;
      };
      enrichLocation(finding.evidence?.source);
      enrichLocation(finding.evidence?.sink);
      for (const location of finding.evidence?.path ?? []) enrichLocation(location);
      report.findings.push(finding);
    }
    report.findings = normalizeFindings(report.findings, projectDir);
    report.analyzedEntities = payload.analyzedEntities as Record<string, number>;
    report.analysisMetadata = { ...report.analysisMetadata, ...payload.analysisMetadata };
    report.status = 'completed';
  } catch (error) {
    report.diagnostics.push(error instanceof Error ? error.message : String(error));
    report.findings = [];
  }
  return await finish();
}
