import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectSourceCheckout, projectRoot } from './setup-taie-source.mjs';

const execute = promisify(execFile);
const checkout = await inspectSourceCheckout();
const root = path.join(projectRoot, '.taie-agent', 'patch-verification', new Date().toISOString().replace(/[:.]/g, '-'));
const tree = path.join(root, 'baseline');
await mkdir(tree, { recursive: true });
const patch = path.join(projectRoot, 'patches', 'tai-e-agent.patch');
const archive = path.join(root, 'baseline.tar');
const git = async (cwd, ...args) => (await execute('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })).stdout;
await git(checkout.directory, 'archive', '--format=tar', `--output=${archive}`, checkout.lock.commit);
await execute('tar', ['-xf', archive, '-C', tree], { windowsHide: true });
await git(tree, 'apply', '--check', patch);
await git(tree, 'apply', patch);
const changed = new Set((await git(checkout.directory, 'diff', '--name-only', checkout.lock.commit, '--')).trim().split(/\r?\n/).filter(Boolean));
for (const file of (await git(checkout.directory, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean)) changed.add(file);
const normalized = buffer => buffer.includes(0) ? buffer.toString('base64') : buffer.toString('utf8').replaceAll('\r\n', '\n');
for (const file of changed) {
  const target = path.resolve(tree, file);
  assert.ok(target.startsWith(tree + path.sep), 'Patch path escaped the verification tree.');
  assert.equal(normalized(await readFile(target)), normalized(await readFile(path.join(checkout.directory, file))), `Patched baseline differs: ${file}`);
}
const reportPath = path.join(root, 'result.json');
await writeFile(reportPath, JSON.stringify({ status: 'passed', baseCommit: checkout.lock.commit, patch, files: [...changed].sort() }, null, 2));
console.log(`Tai-e patch verification passed (${changed.size} files): ${reportPath}`);
