import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { partitionFindings, projectClassNames } from '../src/finding-origin.ts';
import type { Finding } from '../src/taie.ts';

const finding = (className: string, overrides: Partial<Finding> = {}): Finding => ({
  id: className, className, analysis: 'dropped-exception', type: 'DE_MIGHT_IGNORE', message: 'Observed finding',
  ...overrides,
});

test('actual class outputs distinguish project and dependency origins without changing evidence', async () => {
  const base = path.resolve('.taie-agent', 'origin-tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'classes-'));
  try {
    await mkdir(path.join(directory, 'example'));
    for (const name of ['Greeter.class', 'Greeter$Inner.class', 'Greeter$1.class', 'Generated.class', 'resource.txt']) {
      await writeFile(path.join(directory, 'example', name), '');
    }
    const classes = await projectClassNames(directory);
    assert.deepEqual([...classes].sort(), ['example.Generated', 'example.Greeter', 'example.Greeter$1', 'example.Greeter$Inner']);
    const evidence = {
      source: { className: 'example.Greeter', statement: 'input()' },
      sink: { className: 'library.Greeter', statement: 'sink(value)' },
      path: [{ className: 'example.Greeter' }],
    };
    const input = [
      finding('example.Greeter'), finding('example.Greeter$Inner'), finding('example.Greeter$1'),
      finding('example.Generated'), finding('library.Greeter', { evidence }),
      finding('example.LibraryOnly'),
    ];
    const before = structuredClone(input);
    const { projectFindings, dependencyFindings } = partitionFindings(input, classes);
    assert.deepEqual(projectFindings.map(item => item.id), input.slice(0, 4).map(item => item.id));
    assert.deepEqual(dependencyFindings.map(item => item.id), ['library.Greeter', 'example.LibraryOnly']);
    assert.ok(projectFindings.every(item => item.origin === 'project'));
    assert.ok(dependencyFindings.every(item => item.origin === 'dependency'));
    assert.equal(projectFindings[0].sourcePath, undefined, 'missing source mapping must not hide a project finding');
    assert.equal(dependencyFindings[0].evidence, evidence);
    assert.deepEqual(input, before);
  } finally {
    assert.equal(path.dirname(await realpath(directory)), await realpath(base));
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing primary ownership evidence is not silently classified as dependency', () => {
  assert.throws(() => partitionFindings([finding('example.Greeter', { className: undefined })], new Set()), /no className/);
});
