import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../src/process.ts';

async function workspace() {
  const parent = path.resolve('.taie-agent', 'process-tests');
  await mkdir(parent, { recursive: true });
  return await mkdtemp(path.join(parent, 'run-'));
}

test('runs an executable and preserves separate logs and timing evidence', async () => {
  const cwd = await workspace();
  const logBase = path.join(cwd, 'success');
  const args = ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write("diagnostic")', 'literal $value; "quoted"'];
  const result = await runProcess(process.execPath, args, cwd, logBase, Date.now() + 10_000);
  assert.equal(result.code, 0);
  assert.equal(result.stopped, false);
  assert.equal(result.error, undefined);
  assert.ok(result.durationMs >= 0);
  assert.equal(await readFile(`${logBase}.stdout.log`, 'utf8'), args[2]);
  assert.equal(await readFile(`${logBase}.stderr.log`, 'utf8'), 'diagnostic');
  assert.deepEqual(JSON.parse(await readFile(`${logBase}.command.json`, 'utf8')), { command: process.execPath, args, cwd });
  assert.deepEqual(JSON.parse(await readFile(`${logBase}.result.json`, 'utf8')), result);
});

test('reports an exit failure and a missing executable without rejecting', async () => {
  const cwd = await workspace();
  const failed = await runProcess(process.execPath, ['-e', 'process.stderr.write("build failed"); process.exit(7)'],
    cwd, path.join(cwd, 'failed'), Date.now() + 10_000);
  assert.equal(failed.code, 7);
  assert.equal(failed.stopped, false);
  assert.match(failed.tail, /build failed/);
  const missing = await runProcess(path.join(cwd, 'missing-executable'), [], cwd, path.join(cwd, 'missing'), Date.now() + 10_000);
  assert.notEqual(missing.code, 0);
  assert.equal(missing.stopped, false);
  assert.match(missing.error!, /ENOENT/);
});

test('terminates a running child at its deadline', { timeout: 10_000 }, async () => {
  const cwd = await workspace();
  const logBase = path.join(cwd, 'timeout');
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    cwd, logBase, Date.now() + 500);
  assert.equal(result.stopped, true);
  assert.notEqual(result.code, 0);
  assert.deepEqual(JSON.parse(await readFile(`${logBase}.result.json`, 'utf8')), result);
});

test('does not start a child when already cancelled or expired', async () => {
  const cwd = await workspace();
  const sentinel = path.join(cwd, 'unexpected.txt');
  const args = ['-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', sentinel];
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runProcess(process.execPath, args, cwd, path.join(cwd, 'cancelled'), Date.now() + 10_000, controller.signal);
  const expired = await runProcess(process.execPath, args, cwd, path.join(cwd, 'expired'), Date.now() - 1);
  assert.equal(cancelled.stopped, true);
  assert.equal(cancelled.code, null);
  assert.equal(expired.stopped, true);
  assert.equal(expired.code, null);
  await assert.rejects(access(sentinel), { code: 'ENOENT' });
});
