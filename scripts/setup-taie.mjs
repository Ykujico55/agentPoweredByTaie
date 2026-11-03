import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const TAIE_VERSION = '0.5.4';
export const TAIE_SHA256 = '703d1750b66e8e621d628ac93b07a21315db795b3a1e2224001ad09190c1e4be';
export const TAIE_URL = `https://github.com/pascal-lab/Tai-e/releases/download/v${TAIE_VERSION}/tai-e-all-${TAIE_VERSION}.jar`;
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const jarPath = path.join(root, '.tools', 'tai-e', `tai-e-all-${TAIE_VERSION}.jar`);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function setupTaie() {
  await mkdir(path.dirname(jarPath), { recursive: true });
  try {
    const bytes = await readFile(jarPath);
    if (digest(bytes) === TAIE_SHA256) {
      console.log(`Tai-e ${TAIE_VERSION} verified: ${jarPath}`);
      return jarPath;
    }
    throw new Error(`Existing ${jarPath} failed SHA-256 verification. Remove it explicitly before reinstalling.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  console.log(`Downloading official Tai-e ${TAIE_VERSION} (${TAIE_URL})...`);
  const response = await fetch(TAIE_URL, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Tai-e download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = digest(bytes);
  if (sha256 !== TAIE_SHA256) throw new Error(`Tai-e SHA-256 mismatch: expected ${TAIE_SHA256}, received ${sha256}`);
  const temporary = `${jarPath}.${process.pid}.download`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, jarPath);
  } finally {
    await rm(temporary, { force: true });
  }
  await writeFile(path.join(path.dirname(jarPath), 'provenance.json'), `${JSON.stringify({
    version: TAIE_VERSION,
    downloadUrl: TAIE_URL,
    sha256,
    digestSource: 'https://api.github.com/repos/pascal-lab/Tai-e/releases/tags/v0.5.4',
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  console.log(`Tai-e ${TAIE_VERSION} installed and SHA-256 verified: ${jarPath}`);
  return jarPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupTaie().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
