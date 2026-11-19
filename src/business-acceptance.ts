import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CheckResult } from './check.ts';
import type { MavenCheckResult } from './docker-maven.ts';
import { runProcess } from './process.ts';
import type { BusinessAcceptance } from './verification.ts';

// Run the independent Java assertions against the classes and jars exported by this exact check.
export async function replayJavaCheck(check: CheckResult, sourceFile: string, logBase: string, signal?: AbortSignal) {
  const backend: MavenCheckResult = JSON.parse(await readFile(check.backendReportPath, 'utf8'));
  const workspace = path.join(backend.runDir, 'check-workspace');
  const metadata = backend.maven?.metadata;
  if (!metadata || !backend.imageId) throw new Error('业务验收需要 Maven 构建产物及原运行镜像。');
  const classpath = [metadata.classesDir, ...metadata.classpath]
    .map(file => '/replay/' + path.relative(workspace, file).split(path.sep).join('/')).join(':');
  const probe = '/' + path.basename(sourceFile);
  const container = 'taie-accept-' + randomUUID();
  const result = await runProcess('docker', ['run', '--rm', '--name', container, '--pull=never',
    '--network=none', '--read-only', '--user', '1000:1000', '--tmpfs', '/tmp',
    '--security-opt=no-new-privileges', '--cap-drop=ALL', '--pids-limit=256', '--cpus=2', '--memory=2g',
    '--mount', `type=bind,source=${workspace},target=/replay,readonly`,
    '--mount', `type=bind,source=${path.resolve(sourceFile)},target=${probe},readonly`,
    '--entrypoint', 'java', backend.imageId, '-cp', classpath, probe],
  path.dirname(logBase), logBase, Date.now() + 60_000, signal);
  if (result.stopped) await runProcess('docker', ['rm', '-f', container], path.dirname(logBase),
    logBase + '-cleanup', Date.now() + 15_000);
  return result;
}

export function parseBusinessAcceptance(code: number | null, stdout: string): BusinessAcceptance {
  const lines = stdout.trimEnd().split(/\r?\n/);
  const counts = /^(\d+)\/(\d+) passed$/.exec(lines.pop() ?? '');
  const failures = lines.filter(line => line.startsWith('FAIL '));
  const passed = lines.filter(line => line.startsWith('PASS ')).length;
  if (!counts || Number(counts[2]) === 0 || Number(counts[1]) !== passed ||
      Number(counts[2]) !== passed + failures.length || code !== (failures.length ? 1 : 0)) {
    throw new Error('Java 验收程序的退出码、PASS/FAIL 行与汇总计数不一致或未产生约定输出。');
  }
  return failures.length ? { status: 'failed', failures } : { status: 'passed' };
}

/** Capture the trusted acceptance source before handing the project to the coding session. */
export async function loadJavaAcceptance(sourceFile: string) {
  const source = await readFile(sourceFile);
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  return async (check: CheckResult, signal?: AbortSignal): Promise<BusinessAcceptance> => {
    const temp = await mkdtemp(path.join(tmpdir(), 'taie-java-accept-'));
    const frozenSource = path.join(temp, path.basename(sourceFile));
    const base = path.join(check.runDir, 'business-acceptance');
    try {
      await writeFile(frozenSource, source);
      const process = await replayJavaCheck(check, frozenSource, base, signal);
      if (process.error || process.stopped) throw new Error(process.error ?? 'Java 验收执行超时或取消。');
      const verdict = parseBusinessAcceptance(process.code, await readFile(base + '.stdout.log', 'utf8'));
      const reportPath = base + '.json';
      await writeFile(reportPath, JSON.stringify({ check: check.reportPath, sourceSha256, ...verdict }, null, 2));
      return { ...verdict, reportPath };
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error} 日志：${base}.stderr.log`);
    } finally {
      await rm(frozenSource, { force: true });
      await rmdir(temp);
    }
  };
}
