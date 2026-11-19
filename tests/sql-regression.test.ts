import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest } from '../scripts/probe-sql-heldout.ts';
import { loadRegressionProtocol } from '../scripts/review-sql-regression.ts';

test('v3 regression freezes its own prompt, runner and protocol without changing the production prompt', async t => {
  const base = path.resolve('.taie-agent/regression-tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'case-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(directory)), await realpath(base));
    await rm(directory, { recursive: true });
  });
  const write = async (relative: string, content: string) => {
    const file = path.join(directory, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content); return file;
  };
  const systemPromptFile = 'evaluations/sql-regression-v3/system-prompt.txt';
  const runnerFile = 'scripts/review-sql-regression.ts';
  const prompt = 'An experimental v3 prompt independent of the production v2 prompt.';
  const runner = 'ORIGINAL_REGRESSION_RUNNER';
  await write(systemPromptFile, prompt); await write(runnerFile, runner);
  const protocol = { id: 'sql-regression-v3', promptVersion: '3', systemPromptFile,
    systemPromptSha256: digest(prompt), runnerSha256: digest(runner), factAnchors: { G: [{ id: 'source', description: 'source' }] } };
  const protocolFile = await write('evaluations/sql-regression-v3/protocol.json', JSON.stringify(protocol));
  const frozen = await loadRegressionProtocol(protocolFile, directory);
  assert.equal(frozen.systemPrompt, prompt); await frozen.verify();
  await write(systemPromptFile, prompt + '\n');
  await assert.rejects(frozen.verify(), /Regression prompt changed/);
  await assert.rejects(loadRegressionProtocol(protocolFile, directory), /Regression prompt changed/);
  await write(systemPromptFile, prompt); await write(runnerFile, runner + '\n');
  await assert.rejects(frozen.verify(), /Regression runner changed/);
  await assert.rejects(loadRegressionProtocol(protocolFile, directory), /Regression runner changed/);
  await write(runnerFile, runner); await writeFile(protocolFile, JSON.stringify({ ...protocol, promptVersion: '4' }));
  await assert.rejects(frozen.verify(), /Regression protocol changed/);
  await assert.rejects(loadRegressionProtocol(protocolFile, directory), /'4' !== '3'/);
});
