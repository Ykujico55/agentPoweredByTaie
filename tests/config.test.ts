import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
