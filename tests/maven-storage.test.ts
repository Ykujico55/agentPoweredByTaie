import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initializeStorage, prepareExport } from '../containers/maven/storage.ts';

async function fixture() {
  const base = path.resolve('.taie-agent', 'storage-tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'run-'));
  const workspace = path.join(directory, 'workspace'), repository = path.join(directory, 'repository');
  await mkdir(path.join(workspace, 'maven'), { recursive: true });
  await mkdir(path.join(repository, 'group'), { recursive: true });
  return { directory, workspace, repository, async cleanup() {
    assert.equal(path.dirname(await realpath(directory)), await realpath(base));
    await rm(directory, { recursive: true, force: true });
  } };
}

test('export materializes only referenced cache files and preserves build reports', async () => {
  const f = await fixture();
  try {
    const first = path.join(f.repository, 'group', 'one.jar'), second = path.join(f.repository, 'group', 'two.jar');
    await writeFile(first, 'first artifact');
    await writeFile(second, 'second artifact');
    await writeFile(path.join(f.repository, 'group', 'unused.jar'), 'not referenced');
    const projectClasses = path.join(f.workspace, 'project', 'target', 'classes');
    await mkdir(projectClasses, { recursive: true });
    const metadata = JSON.stringify({ classpath: [first] });
    const check = JSON.stringify({ maven: { metadata: { classpath: [first, second, projectClasses] } } });
    await writeFile(path.join(f.workspace, 'maven', 'maven-metadata.json'), metadata);
    await writeFile(path.join(f.workspace, 'check.json'), check);
    await prepareExport(f.workspace, f.repository);
    assert.equal(await readFile(path.join(f.workspace, 'dependencies', 'group', 'one.jar'), 'utf8'), 'first artifact');
    assert.equal(await readFile(path.join(f.workspace, 'dependencies', 'group', 'two.jar'), 'utf8'), 'second artifact');
    await assert.rejects(readFile(path.join(f.workspace, 'dependencies', 'group', 'unused.jar')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(f.workspace, 'maven', 'maven-metadata.json'), 'utf8'), metadata);
    assert.equal(await readFile(path.join(f.workspace, 'check.json'), 'utf8'), check);
  } finally { await f.cleanup(); }
});

test('partial output is exportable but external classpaths and malformed JSON are rejected', async () => {
  const f = await fixture();
  try {
    await prepareExport(f.workspace, f.repository);
    const metadataFile = path.join(f.workspace, 'maven', 'maven-metadata.json');
    await writeFile(metadataFile, JSON.stringify({ classpath: [path.join(f.directory, 'repository-other', 'outside.jar')] }));
    await assert.rejects(prepareExport(f.workspace, f.repository), /outside exported storage/);
    await writeFile(metadataFile, '{invalid');
    await assert.rejects(prepareExport(f.workspace, f.repository), SyntaxError);
  } finally { await f.cleanup(); }
});

test('storage helpers reject symlinks before reading or changing linked files', async t => {
  const f = await fixture();
  try {
    const external = path.join(f.directory, 'external.json');
    await writeFile(external, 'untouched');
    const linkedReport = path.join(f.workspace, 'check.json');
    try { await symlink(external, linkedReport, 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('Creating symlinks is not permitted in this environment.'); return;
      }
      throw error;
    }
    await assert.rejects(prepareExport(f.workspace, f.repository), /Unsupported storage entry/);
    await assert.rejects(initializeStorage(f.workspace, f.repository), /Unsupported storage entry/);
    assert.equal(await readFile(external, 'utf8'), 'untouched');
    await rm(linkedReport);
    const linkedJar = path.join(f.repository, 'group', 'linked.jar');
    await symlink(external, linkedJar, 'file');
    await writeFile(path.join(f.workspace, 'maven', 'maven-metadata.json'), JSON.stringify({ classpath: [linkedJar] }));
    await assert.rejects(prepareExport(f.workspace, f.repository), /Unsupported repository entry/);
  } finally { await f.cleanup(); }
});
