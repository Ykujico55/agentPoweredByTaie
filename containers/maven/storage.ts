import { chown, copyFile, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Export only ordinary files/directories; the project must be stopped before this walk. */
async function ordinaryTree(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function visit(file: string): Promise<void> {
    const info = await lstat(file);
    if (!info.isDirectory() && !info.isFile()) throw new Error(`Unsupported storage entry: ${file}`);
    entries.push(file);
    if (info.isDirectory()) {
      for (const name of await readdir(file)) await visit(path.join(file, name));
    }
  }
  await visit(root);
  return entries;
}

/** docker cp creates root-owned entries; only this bootstrap helper runs with CHOWN. */
export async function initializeStorage(workspace: string, input: string, uid = 1000, gid = 1000): Promise<void> {
  const entries = [...await ordinaryTree(workspace), ...await ordinaryTree(input)];
  for (const file of entries) await chown(file, uid, gid);
}

async function classpathFrom(file: string, checkReport = false): Promise<string[]> {
  let contents: string;
  try { contents = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const report = JSON.parse(contents);
  const classpath: unknown = checkReport ? report?.maven?.metadata?.classpath : report?.classpath;
  // Failed or interrupted runs may have no build metadata.
  if (classpath === undefined) return [];
  if (!Array.isArray(classpath) || classpath.some(entry => typeof entry !== 'string' || !path.isAbsolute(entry))) {
    throw new Error(`Invalid classpath in ${file}`);
  }
  return classpath as string[];
}

/** Materialize used cache artifacts so exported reports can point to real host files. */
export async function prepareExport(workspace: string, repository: string): Promise<void> {
  workspace = path.resolve(workspace);
  repository = path.resolve(repository);
  // Validate before reading report files or creating destinations, then again before docker cp.
  await ordinaryTree(workspace);
  const classpath = new Set([
    ...await classpathFrom(path.join(workspace, 'maven', 'maven-metadata.json')),
    ...await classpathFrom(path.join(workspace, 'check.json'), true),
  ]);
  for (const source of classpath) {
    if (inside(path.join(workspace, 'project'), source)) continue;
    if (!inside(repository, source)) throw new Error(`Classpath outside exported storage: ${source}`);
    const relative = path.relative(repository, source);
    const canonical = await realpath(source);
    if (canonical !== path.join(await realpath(repository), relative) || !(await lstat(source)).isFile()) {
      throw new Error(`Unsupported repository entry: ${source}`);
    }
    const destination = path.join(workspace, 'dependencies', relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  await ordinaryTree(workspace);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'initialize') await initializeStorage('/workspace', '/input');
  else if (process.argv[2] === 'export') await prepareExport('/workspace', '/maven-repository');
  else throw new Error('Storage helper requires initialize or export.');
}
