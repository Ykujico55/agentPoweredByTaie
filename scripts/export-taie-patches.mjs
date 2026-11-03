import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectSourceCheckout, projectRoot } from './setup-taie-source.mjs';

const exec = promisify(execFile);
const checkout = await inspectSourceCheckout();
const git = async (args, allowDifference = false) => {
  try {
    return (await exec('git', ['-C', checkout.directory, ...args], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    })).stdout;
  } catch (error) {
    if (allowDifference && error.code === 1) return error.stdout;
    throw error;
  }
};
let patch = await git(['diff', '--no-ext-diff', '--binary', checkout.lock.commit, '--']);
const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort();
for (const file of untracked) {
  patch += await git(['diff', '--no-ext-diff', '--no-index', '--binary', '--', '/dev/null', file], true);
}
const destination = path.join(projectRoot, 'patches', 'tai-e-agent.patch');
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, patch);
console.log(`Exported Tai-e changes against ${checkout.lock.commit}: ${destination}`);
console.log(`${untracked.length} new file(s), ${Buffer.byteLength(patch)} patch bytes. Review this file before sharing.`);
