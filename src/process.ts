import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';

export interface ProcessResult {
  code: number | null;
  tail: string;
  stopped: boolean;
  durationMs: number;
  error?: string;
}

/** Stops the direct child on cancellation; callers own cleanup of external jobs such as containers. */
export async function runProcess(command: string, args: string[], cwd: string, logBase: string,
  deadline: number, signal?: AbortSignal): Promise<ProcessResult> {
  const started = Date.now();
  await writeFile(`${logBase}.command.json`, `${JSON.stringify({ command, args, cwd }, null, 2)}\n`);
  const output = createWriteStream(`${logBase}.stdout.log`, { flags: 'wx' });
  const errors = createWriteStream(`${logBase}.stderr.log`, { flags: 'wx' });
  const logCompletion = Promise.all([finished(output), finished(errors)]).then(
    () => undefined,
    (error: unknown) => String(error),
  );
  const finish = async (result: Omit<ProcessResult, 'durationMs'>): Promise<ProcessResult> => {
    output.end(); errors.end();
    const logError = await logCompletion;
    const complete = { ...result, ...(logError ? { error: logError } : {}), durationMs: Date.now() - started };
    await writeFile(`${logBase}.result.json`, `${JSON.stringify(complete, null, 2)}\n`);
    return complete;
  };
  if (signal?.aborted || deadline <= Date.now()) {
    return await finish({ code: null, tail: signal?.aborted ? 'Cancelled by caller.' : 'Deadline exceeded.', stopped: true });
  }
  const result = await new Promise<Omit<ProcessResult, 'durationMs'>>((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let stopped = false;
    let error: string | undefined;
    const append = (chunk: Buffer) => { tail = (tail + chunk.toString('utf8')).slice(-64_000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.stdout.pipe(output);
    child.stderr.pipe(errors);
    const stop = () => { stopped = true; child.kill('SIGKILL'); };
    const timer = setTimeout(stop, Math.max(1, deadline - Date.now()));
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', (cause) => { error = cause.message; });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve({ code, tail, stopped, ...(error ? { error } : {}) });
    });
  });
  return await finish(result);
}
