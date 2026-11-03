import { spawn } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function readSourceLock() {
  const lock = JSON.parse(await readFile(path.join(projectRoot, 'tai-e-source.lock.json'), 'utf8'));
  if (lock.schemaVersion !== 1 || lock.upstream !== 'https://github.com/pascal-lab/Tai-e.git'
      || !/^v\d+\.\d+\.\d+$/.test(lock.tag) || !/^[a-f0-9]{40}$/.test(lock.commit)
      || !/^\d+\.\d+\.\d+$/.test(lock.version) || lock.directory !== 'vendor/Tai-e') {
    throw new Error('Invalid tai-e-source.lock.json; expected an official, commit-pinned Tai-e source checkout.');
  }
  return lock;
}
export function run(command, args, { cwd = projectRoot, env = process.env, inherit = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`${command} exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
function canonicalGitUrl(url) { return url.replace(/\/$/, '').replace(/\.git$/, '').toLowerCase(); }
export async function inspectSourceCheckout() {
  const lock = await readSourceLock();
  const directory = path.resolve(projectRoot, lock.directory);
  const git = async (...args) => (await run('git', ['-C', directory, ...args])).stdout;
  const topLevel = path.resolve(await git('rev-parse', '--show-toplevel'));
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(topLevel) !== normalize(directory)) throw new Error(`${directory} is not its own Git checkout.`);
  const origin = await git('remote', 'get-url', 'origin');
  let upstreamRemote;
  try { upstreamRemote = await git('remote', 'get-url', 'upstream'); } catch { /* Optional for personal forks. */ }
  if (![origin, upstreamRemote].some((url) => url && canonicalGitUrl(url) === canonicalGitUrl(lock.upstream)))
    throw new Error(`Expected the official Tai-e URL at origin or upstream. Existing checkout ${origin} was preserved.`);
  const tagCommit = await git('rev-parse', `${lock.tag}^{commit}`);
  if (tagCommit !== lock.commit)
    throw new Error(`Tai-e ${lock.tag} resolves to ${tagCommit}, expected ${lock.commit}. Existing checkout was preserved.`);
  const head = await git('rev-parse', 'HEAD');
  try { await git('merge-base', '--is-ancestor', lock.commit, head); }
  catch { throw new Error(`Tai-e HEAD ${head} does not descend from pinned ${lock.commit}; existing checkout was preserved.`); }
  const status = await git('status', '--porcelain', '--untracked-files=all');
  return { lock, directory, origin, upstreamRemote, head, dirty: status.length > 0, status };
}
export async function setupTaieSource() {
  const lock = await readSourceLock();
  const directory = path.resolve(projectRoot, lock.directory);
  let present = true;
  try { await access(directory); } catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
  if (!present) {
    await mkdir(path.dirname(directory), { recursive: true });
    await run('git', ['clone', '--branch', lock.tag, '--depth', '1', '--', lock.upstream, directory], { inherit: true });
  }
  let checkout = await inspectSourceCheckout();
  const patchFile = path.join(projectRoot, 'patches', 'tai-e-agent.patch');
  let patch;
  try { patch = await readFile(patchFile, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (patch?.trim()) {
    const git = (...args) => run('git', ['-C', directory, 'apply', ...args, patchFile]);
    let alreadyApplied = false;
    try { await git('--reverse', '--check'); alreadyApplied = true; } catch { /* Try forward applicability. */ }
    if (alreadyApplied) console.log('Bundled agent analysis extensions are already applied.');
    else {
      try { await git('--check'); }
      catch {
        throw new Error('Bundled Tai-e patch cannot be applied or verified against this checkout. Existing changes were preserved. Review patches/tai-e-agent.patch; build existing intentional edits directly with npm run build:taie-source.');
      }
      await git();
      console.log('Applied bundled Tai-e detector fixes and extensions.');
    }
    checkout = await inspectSourceCheckout();
  }
  console.log(`Tai-e source ready: ${directory}`);
  console.log(`Pinned base: ${lock.tag} (${lock.commit}); HEAD: ${checkout.head}; dirty: ${checkout.dirty}`);
  if (checkout.head !== lock.commit || checkout.dirty)
    console.log('Existing local development changes were preserved.');
  return checkout;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupTaieSource().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
