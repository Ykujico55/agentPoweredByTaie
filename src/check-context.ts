import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MavenCheckResult } from './docker-maven.ts';
import type { AnalysisReport } from './taie.ts';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const slash = (value: string) => value.replaceAll('\\', '/');

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function recordedHash(value: string | undefined, name: string): string {
  if (!value || !/^[a-f\d]{64}$/i.test(value)) throw new Error(`Missing or invalid ${name}.`);
  return value.toLowerCase();
}

async function fileHash(file: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular evidence file: ${file}`);
  return digest(await readFile(file));
}

/** Class directories use relative class names and bytes, never timestamps or the checkout path. */
async function treeHash(directory: string, classesOnly = false): Promise<string> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected an evidence directory: ${directory}`);
  const entries: [string, string][] = [];
  async function visit(relative: string) {
    for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlinks cannot establish comparison context: ${path.join(directory, name)}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile() && (!classesOnly || entry.name.endsWith('.class'))) {
        entries.push([slash(name), await fileHash(path.join(directory, name))]);
      }
    }
  }
  await visit('');
  return digest(JSON.stringify(entries));
}

async function command(file: string | undefined, name: string): Promise<{ command: string; args: string[] }> {
  const value = JSON.parse(await readFile(required(file, name), 'utf8'));
  if (typeof value.command !== 'string' || !Array.isArray(value.args) || !value.args.every((arg: unknown) => typeof arg === 'string')) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

/** A conservative compatibility key from recorded execution evidence; not a proof of equal coverage. */
export async function buildComparisonKey(analysis: AnalysisReport, maven?: MavenCheckResult): Promise<string> {
  if (analysis.status !== 'completed') throw new Error('Comparison context requires completed analysis.');
  if (!analysis.analyses.length || !analysis.sourceRoots.length) throw new Error('Missing detectors or source roots.');
  const execution = await command(analysis.evidence.analyzeCommand, 'analyzer command');
  const argument = (flag: string) => {
    const index = execution.args.indexOf(flag);
    return index < 0 ? undefined : required(execution.args[index + 1], `${flag} argument`);
  };
  const scope = required(argument('-scope'), 'analysis scope');
  const plan = JSON.parse(await readFile(required(analysis.evidence.analysisPlan, 'analysis plan'), 'utf8'));
  if (!Array.isArray(plan) || !plan.length) throw new Error('Invalid analysis plan.');
  // The captured policy hash supplies identity; its per-run filename must not affect comparison.
  for (const entry of plan) {
    if (entry.options && 'taint-config' in entry.options) entry.options['taint-config'] = '<taint-policy>';
  }
  const policy = analysis.taintConfiguration;
  if (analysis.analyses.includes('taint') && !policy) throw new Error('Missing taint configuration.');
  let taint;
  if (policy) {
    const sha256 = recordedHash(policy.sha256, 'taint policy SHA-256');
    if (await fileHash(policy.snapshotPath) !== sha256) throw new Error('Taint policy snapshot no longer matches recorded SHA-256.');
    taint = { sha256, implicitEntries: policy.implicitEntries };
  }
  const dependencies = [];
  for (const dependency of analysis.classpath) {
    const file = path.resolve(analysis.projectDir, dependency);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`Symlink classpath is unsupported for comparison: ${file}`);
    dependencies.push(info.isDirectory() ? { kind: 'classes', sha256: await treeHash(file, true) }
      : { kind: 'file', sha256: await fileHash(file) });
  }
  let build;
  if (maven) {
    const metadata = maven.maven?.metadata;
    if (!metadata) throw new Error('Missing Maven build metadata.');
    const snapshot = path.join(maven.runDir, 'snapshot', 'project');
    let mvnConfig: string | undefined;
    let hasMvnConfig = false;
    try { await lstat(path.join(snapshot, '.mvn')); hasMvnConfig = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Absence is meaningful; unreadable or malformed configuration is not treated as absent.
    if (hasMvnConfig) mvnConfig = await treeHash(path.join(snapshot, '.mvn'));
    build = {
      imageId: required(maven.imageId, 'Maven image ID'),
      mavenVersion: required(maven.maven?.versions.maven, 'Maven version'),
      javaVersion: required(maven.maven?.versions.java, 'Maven JDK version'),
      pom: await fileHash(path.join(snapshot, 'pom.xml')), mvnConfig,
      effectivePom: await fileHash(path.join(path.dirname(maven.maven!.reportPath), 'effective-pom.xml')),
      classpathScope: required(metadata.classpathScope, 'Maven classpath scope'),
    };
  } else {
    const compiler = await command(analysis.evidence.compileCommand, 'compiler command');
    const args = (await readFile(required(analysis.evidence.compileArguments, 'compiler arguments'), 'utf8'))
      .trim().split(/\r?\n/).map(line => JSON.parse(line) as string);
    const sourceFiles = new Set(analysis.sourceFiles.map(file => slash(path.resolve(analysis.projectDir, file))));
    const flags: string[] = [];
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '-d' || args[index] === '-classpath') { index++; continue; }
      if (!sourceFiles.has(slash(args[index]))) flags.push(args[index]);
    }
    build = { compiler: compiler.command, vmArgs: compiler.args.filter(arg => !arg.startsWith('@')), flags };
  }
  return digest(JSON.stringify({
    version: 1, backend: maven ? 'maven-docker' : 'javac',
    analyses: [...analysis.analyses].sort(),
    analyzer: recordedHash(analysis.taiE.sha256, 'analyzer SHA-256'),
    adapter: recordedHash(analysis.analysisMetadata?.adapterFingerprint as string | undefined, 'adapter SHA-256'),
    javaVersion: required(analysis.taiE.javaVersion, 'analyzer JDK version'), compileRelease: analysis.compileRelease,
    scope, mainClass: argument('-m'), plan, taint,
    sourceRoots: analysis.sourceRoots.map(root => slash(path.relative(analysis.projectDir, path.resolve(analysis.projectDir, root)))).sort(),
    dependencies, build,
  }));
}
