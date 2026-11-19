import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeReview, type ReviewCompletion } from '../src/review-model.ts';
import { redactReviewSecrets } from '../src/review-evidence.ts';
import { checkControlFlowPaths, parsePathSuggestion, renderControlFlowReport,
  type ControlFlowEvidence, type PathSuggestion, type PathCheck } from '../src/control-flow-review.ts';
import type { SourceCatalog } from '../src/review-citations.ts';
import { digest, loadFrozenProtocol, root } from './probe-sql-heldout.ts';
import { loadDatasetLock } from './review-sql-heldout.ts';

export async function reviewControlFlow(probePath: string, complete = completeReview) {
  const frozen = await loadFrozenProtocol(); const locked = await loadDatasetLock();
  const probeBytes = await readFile(probePath);
  const probe = JSON.parse(probeBytes.toString('utf8')) as { status: string; runDir: string; findingId: string;
    inputHashes: Record<string, string>; artifactHashes: Record<string, string> };
  assert.equal(probe.status, 'passed', 'Requires a successful control-flow probe.');
  const originalHashes = { ...probe.inputHashes, [path.resolve(probePath)]: digest(probeBytes),
    ...Object.fromEntries(Object.entries(probe.artifactHashes).map(([name, hash]) => [path.join(probe.runDir, name), hash])) };
  const verify = async () => {
    await frozen.verify(); await locked.verify();
    for (const [file, hash] of Object.entries(originalHashes)) assert.equal(digest(await readFile(file)), hash, `Evidence changed: ${file}`);
  };
  await verify();
  const graph = JSON.parse(await readFile(path.join(probe.runDir, 'cfg.json'), 'utf8')) as ControlFlowEvidence;
  const catalog = JSON.parse(await readFile(path.join(probe.runDir, 'catalog.json'), 'utf8')) as SourceCatalog;
  assert.equal(graph.sourceCatalogSha256, catalog.sha256);
  const evidence = JSON.parse(await readFile(path.join(probe.runDir, 'evidence.json'), 'utf8'));
  const packet = JSON.parse(evidence.prompt);
  packet.evidence.find((item: { id: string }) => item.id === 'context').data.controlFlow = graph;
  const prompt = redactReviewSecrets(JSON.stringify(packet, null, 2));
  assert.ok(prompt.length <= 64_000, 'Control-flow evidence exceeds 64000-character budget.');
  const systemPrompt = await readFile(path.join(root, 'evaluations/control-flow-v1/system-prompt.txt'), 'utf8');
  const implementationHashes = Object.fromEntries(await Promise.all(['scripts/review-control-flow.ts', 'src/control-flow-review.ts', 'evaluations/control-flow-v1/system-prompt.txt']
    .map(async file => [path.join(root, file), digest(await readFile(path.join(root, file)))])));
  const runDir = path.join(root, '.taie-agent/control-flow-review', `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(runDir, { recursive: true });
  console.log(`[control-flow-review] Evidence: ${runDir}`);
  const started = Date.now();
  const result: { schemaVersion: 1; experiment: string; status: 'completed' | 'failed' | 'stale'; findingId: string; graphId: string;
    affectsCheckStatus: false; originalHashes: Record<string, string>; implementationHashes: Record<string, string>;
    requestAttempted: boolean; response?: ReviewCompletion; suggestion?: PathSuggestion; pathCheck?: PathCheck;
    diagnostics: string[]; error?: string; originalsUnchanged?: boolean; durationMs?: number } = {
    schemaVersion: 1, experiment: 'control-flow-v1', status: 'failed', findingId: probe.findingId, graphId: graph.graphId,
    affectsCheckStatus: false, originalHashes, implementationHashes, requestAttempted: false, diagnostics: [] };
  for (const [name, value] of [['cfg.json', graph], ['catalog.json', catalog], ['request.json', {
    experiment: result.experiment, systemPrompt, systemPromptSha256: digest(systemPrompt), prompt, promptSha256: digest(prompt), graphId: graph.graphId,
  }]] as const) await writeFile(path.join(runDir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  try {
    await verify(); result.requestAttempted = true;
    result.response = await complete({ provider: frozen.protocol.provider, model: frozen.protocol.model, timeoutMs: frozen.protocol.timeoutMs,
      runDir, systemPrompt, prompt });
    const parsed = parsePathSuggestion(result.response.text, probe.findingId);
    result.suggestion = parsed.suggestion; result.diagnostics = parsed.diagnostics; result.status = 'completed';
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    if (error && typeof error === 'object' && 'response' in error && error.response) result.response = error.response as ReviewCompletion;
  }
  try {
    await verify();
    for (const [file, hash] of Object.entries(implementationHashes)) assert.equal(digest(await readFile(file)), hash, `Implementation changed: ${file}`);
    result.originalsUnchanged = true;
  } catch (error) { result.status = 'stale'; result.originalsUnchanged = false; result.error = String(error); }
  if (result.suggestion) {
    result.pathCheck = checkControlFlowPaths(result.suggestion.graphId, result.suggestion.paths, graph, result.originalsUnchanged === true);
    if (result.pathCheck.status === 'invalid') result.status = 'failed';
  }
  result.durationMs = Date.now() - started;
  await writeFile(path.join(runDir, 'result.json'), redactReviewSecrets(JSON.stringify(result, null, 2)) + '\n', { flag: 'wx' });
  await writeFile(path.join(runDir, 'report.md'), redactReviewSecrets(renderControlFlowReport({ ...result, graph, catalog, check: result.pathCheck })), { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, connectivity: result.pathCheck?.status ?? 'not_checked', resultPath: path.join(runDir, 'result.json'), reportPath: path.join(runDir, 'report.md') }));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/review-control-flow.ts <control-flow-probe-result.json>');
  reviewControlFlow(path.resolve(process.argv[2])).then(result => { if (result.status !== 'completed') process.exitCode = 1; })
    .catch(error => { console.error(redactReviewSecrets(String(error))); process.exitCode = 1; });
}
