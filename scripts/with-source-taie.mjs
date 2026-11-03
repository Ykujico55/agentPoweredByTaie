import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, '.tools', 'tai-e', 'source-build.json');
try {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const digest = createHash('sha256').update(await readFile(manifest.jarPath)).digest('hex');
  if (digest !== manifest.sha256) throw new Error('Source build changed; run npm run build:taie-source first.');
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'chat';
  const analyses = 'dropped-exception,clone-idiom,dead-code,null-pointer,division-by-zero';
  const child = spawn(process.execPath, [path.join(root, 'src', 'cli.ts'), command,
    '--jar', manifest.jarPath, '--analyses', analyses, ...args], {
    cwd: process.cwd(), env: process.env, shell: false, windowsHide: true, stdio: 'inherit',
  });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('close', code => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(`${error.message}\nRun npm run setup:taie-source and npm run build:taie-source first.`);
  process.exitCode = 1;
}
