import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectSnapshot } from '../src/docker-maven.ts';

test('snapshot isolates edits, excludes outputs and secrets, and detects input changes', async () => {
  const base = path.resolve('.taie-agent', 'snapshot-tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'snapshot-'));
  try {
    const project = path.join(directory, 'project'), snapshot = path.join(directory, 'snapshot');
    await mkdir(path.join(project, 'target'), { recursive: true });
    await writeFile(path.join(project, 'pom.xml'), '<project/>');
    await writeFile(path.join(project, '.env'), 'private');
    await writeFile(path.join(project, 'target', 'old.class'), 'old artifact');
    await mkdir(path.join(project, 'src', 'build'), { recursive: true });
    await writeFile(path.join(project, 'src', 'build', 'Tool.java'), 'package build; class Tool {}');
    const fingerprint = await projectSnapshot(project, snapshot);
    assert.equal(await projectSnapshot(project), fingerprint);
    await assert.rejects(readFile(path.join(snapshot, '.env')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(snapshot, 'target', 'old.class')), { code: 'ENOENT' });
    assert.match(await readFile(path.join(snapshot, 'src', 'build', 'Tool.java'), 'utf8'), /class Tool/);
    const outputDirs = ['custom-output'];
    const inputFingerprint = await projectSnapshot(project, undefined, outputDirs);
    await mkdir(path.join(snapshot, 'custom-output'), { recursive: true });
    await writeFile(path.join(snapshot, 'custom-output', 'Generated.java'), 'class Generated {}');
    assert.equal(await projectSnapshot(snapshot, undefined, outputDirs), inputFingerprint);
    await writeFile(path.join(snapshot, 'src', 'New.java'), 'class New {}');
    assert.notEqual(await projectSnapshot(snapshot, undefined, outputDirs), inputFingerprint);
    await writeFile(path.join(snapshot, 'pom.xml'), 'candidate edit');
    assert.equal(await readFile(path.join(project, 'pom.xml'), 'utf8'), '<project/>');
    await writeFile(path.join(project, 'new.java'), 'class Added {}');
    assert.notEqual(await projectSnapshot(project), fingerprint);
  } finally {
    assert.equal(path.dirname(await realpath(directory)), await realpath(base));
    await rm(directory, { recursive: true, force: true });
  }
});
