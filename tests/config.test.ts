import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { freezeProjectConfig, loadProjectConfig } from "../src/config.ts";

test("adding a Maven layout during a task cannot remove legacy sources from configured coverage", async () => {
  const project = await mkdtemp(join(tmpdir(), "taie-coverage-"));
  try {
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "Legacy.java"), "class Legacy {}\n");
    const frozen = await freezeProjectConfig(project, {});
    await mkdir(join(project, "src", "main", "java"), { recursive: true });
    await writeFile(join(project, "src", "main", "java", "New.java"), "class New {}\n");
    assert.deepEqual(frozen.sourceRoots, ["src"]);
    assert.deepEqual((await freezeProjectConfig(project, frozen)).sourceRoots, ["src"]);
    const reconfigured = await freezeProjectConfig(project, { analyses: ['dead-code'], dependencyNetwork: true }, frozen.sourceRoots);
    assert.deepEqual(reconfigured.sourceRoots, ['src'], 'unrelated settings must not narrow previously inferred coverage');
    assert.notEqual(reconfigured.sourceRoots, frozen.sourceRoots, 'inferred roots must be cloned');
    assert.deepEqual((await freezeProjectConfig(project, {})).sourceRoots, ['src/main/java'], 'resetting inference discovers the current layout');
    assert.deepEqual((await freezeProjectConfig(project, { sourceRoots: ['explicit'] }, frozen.sourceRoots)).sourceRoots, ['explicit']);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test("explicit configuration is preserved and invalid empty detector lists are rejected", async () => {
  const project = await mkdtemp(join(tmpdir(), "taie-config-"));
  try {
    const config = { sourceRoots: ["custom"], analyses: ["dead-code"] };
    const frozen = await freezeProjectConfig(project, config);
    config.sourceRoots.push("mutated");
    assert.deepEqual(frozen.sourceRoots, ["custom"]);
    await writeFile(join(project, "taie-agent.json"), JSON.stringify({ analyses: [] }));
    await assert.rejects(loadProjectConfig(project), /must not be empty/);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('Maven configuration validates backend choices and keeps source discovery owned by the build', async () => {
  const project = await mkdtemp(join(tmpdir(), 'taie-config-backend-'));
  try {
    await mkdir(join(project, 'src', 'main', 'java'), { recursive: true });
    const config = { buildBackend: 'maven-docker' as const, dependencyNetwork: true, includeDependencies: false };
    await writeFile(join(project, 'taie-agent.json'), JSON.stringify(config));
    assert.deepEqual(await loadProjectConfig(project), config);
    assert.deepEqual(await freezeProjectConfig(project, config, ['src']), config, 'Maven must ignore prior javac inference');
    assert.deepEqual((await freezeProjectConfig(project, { buildBackend: 'javac' })).sourceRoots, ['src/main/java']);
    for (const invalid of [{ buildBackend: 'gradle' }, { buildBackend: null }, { dependencyNetwork: 'on' }, { includeDependencies: 1 }]) {
      await writeFile(join(project, 'taie-agent.json'), JSON.stringify(invalid));
      await assert.rejects(loadProjectConfig(project), new RegExp(Object.keys(invalid)[0]));
    }
  } finally {
    assert.equal(dirname(resolve(project)), resolve(tmpdir()));
    await rm(project, { recursive: true, force: true });
  }
});
