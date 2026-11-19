import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactReviewSecrets } from '../src/review-evidence.ts';
import { completeReview, type ReviewCompletion } from '../src/review-model.ts';
import { buildSourceCatalog, checkSourceCitations, parseCitationSuggestion, renderCitationReport,
  type CitationSource, type CitationSuggestion, type CitationCheck, type SourceCatalog } from '../src/review-citations.ts';
import { digest, loadFrozenProtocol, root, type HeldoutProbe } from './probe-sql-heldout.ts';
import { buildHeldoutReviewInput, loadDatasetLock } from './review-sql-heldout.ts';

const experiment = 'source-citations-v1';

/** Replace duplicate source bodies with a complete numbered catalog; never include labels or tests. */
export function prepareCitationInput(input: Awaited<ReturnType<typeof buildHeldoutReviewInput>>) {
  const packet = JSON.parse(input.prompt) as { evidence: { id: string; data: Record<string, unknown> }[] };
  const context = packet.evidence.find(item => item.id === 'context')!.data;
  const sources = context.sourceFiles as CitationSource[];
  const catalog = buildSourceCatalog(sources);
  context.sourceFiles = sources.map(({ relativePath, sha256 }) => ({ relativePath, sha256 }));
  context.sourceCatalog = catalog;
  const prompt = redactReviewSecrets(JSON.stringify(packet, null, 2));
  assert.ok(prompt.length <= 64_000, 'Citation evidence exceeds 64000-character budget.');
  return { catalog, prompt, manifest: { ...input.manifest, promptSha256: digest(prompt),
    originalPromptSha256: input.manifest.promptSha256, sourceCatalogSha256: catalog.sha256 } };
}

export async function runSourceCitationReview(probePath: string, caseId: string, complete = completeReview) {
  assert.ok(['G', 'H', 'I', 'J', 'K', 'L'].includes(caseId), 'Choose one regression case: G, H, I, J, K or L.');
  const frozen = await loadFrozenProtocol();
  const locked = await loadDatasetLock();
  const probeBytes = await readFile(probePath);
  const probe = JSON.parse(probeBytes.toString('utf8')) as HeldoutProbe;
  assert.equal(probe.protocolSha256, frozen.sha256, 'Probe used a different source protocol.');
  const findings = probe.check.findings.filter(finding => finding.className === `example.Case${caseId}` && finding.type === 'TAINT_FLOW');
  assert.equal(findings.length, 1, 'This single-case experiment requires exactly one recorded project finding.');
  const findingId = findings[0].id;
  const started = Date.now();
  const runDir = path.join(root, '.taie-agent/source-citations', `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(runDir, { recursive: true });
  console.log(`[source-citations] Evidence: ${runDir}`);
  const systemPrompt = await readFile(path.join(root, 'evaluations/source-citations-v1/system-prompt.txt'), 'utf8');
  const implementationHashes = Object.fromEntries(await Promise.all([
    'scripts/review-sql-citations.ts', 'src/review-citations.ts', 'evaluations/source-citations-v1/system-prompt.txt',
  ].map(async file => [file, digest(await readFile(path.join(root, file)))])));
  const result: {
    schemaVersion: 1; experiment: string; status: 'completed' | 'failed' | 'stale'; caseId: string; findingId: string;
    runDir: string; affectsCheckStatus: false; disposition: 'unchanged'; currentWorkspace: 'not_checked';
    sourceCatalogSha256?: string; sourceProtocolSha256: string; implementationHashes: Record<string, string>;
    requestAttempted: boolean; response?: ReviewCompletion; suggestion?: CitationSuggestion; citations?: CitationCheck;
    originalsUnchanged?: boolean; frozenInputsUnchanged?: boolean; diagnostics: string[]; error?: string; durationMs?: number;
  } = { schemaVersion: 1, experiment, status: 'failed', caseId, findingId, runDir,
    affectsCheckStatus: false, disposition: 'unchanged', currentWorkspace: 'not_checked',
    sourceProtocolSha256: frozen.sha256, implementationHashes, requestAttempted: false, diagnostics: [] };
  let input: Awaited<ReturnType<typeof buildHeldoutReviewInput>> | undefined;
  let catalog: SourceCatalog | undefined;
  try {
    input = await buildHeldoutReviewInput(probePath, caseId, findingId);
    const prepared = prepareCitationInput(input);
    catalog = prepared.catalog;
    result.sourceCatalogSha256 = catalog.sha256;
    for (const [name, value] of [['catalog.json', catalog], ['input-manifest.json', prepared.manifest], ['request.json', {
      experiment, systemPromptSha256: digest(systemPrompt), sourceCatalogSha256: catalog.sha256,
      systemPrompt, prompt: prepared.prompt,
    }]] as const) await writeFile(path.join(runDir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    assert.ok(await input.verifyUnchanged(), 'Recorded input changed before model request.');
    result.requestAttempted = true;
    result.response = await complete({ provider: frozen.protocol.provider, model: frozen.protocol.model,
      timeoutMs: frozen.protocol.timeoutMs, systemPrompt, prompt: prepared.prompt, runDir });
    const parsed = parseCitationSuggestion(result.response.text, findingId);
    result.suggestion = parsed.suggestion;
    result.diagnostics = parsed.diagnostics;
    result.status = 'completed';
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    if (error && typeof error === 'object' && 'response' in error && error.response) result.response = error.response as ReviewCompletion;
  }
  if (input) {
    result.originalsUnchanged = await input.verifyUnchanged();
    if (!result.originalsUnchanged) result.status = 'stale';
  }
  try {
    await frozen.verify(); await locked.verify();
    assert.equal(digest(await readFile(probePath)), digest(probeBytes), 'Probe changed during request.');
    for (const [file, sha256] of Object.entries(implementationHashes))
      assert.equal(digest(await readFile(path.join(root, file))), sha256, `Experiment implementation changed: ${file}`);
    result.frozenInputsUnchanged = true;
  } catch (error) {
    result.frozenInputsUnchanged = false; result.status = 'stale'; result.error = String(error);
  }
  if (result.suggestion && catalog) {
    result.citations = checkSourceCitations(result.suggestion.claims, catalog, result.originalsUnchanged === true && result.frozenInputsUnchanged === true);
    if (result.citations.status === 'invalid' || result.citations.status === 'missing') result.status = 'failed';
  }
  result.durationMs = Date.now() - started;
  await writeFile(path.join(runDir, 'result.json'), redactReviewSecrets(JSON.stringify(result, null, 2)) + '\n', { flag: 'wx' });
  await writeFile(path.join(runDir, 'report.md'), redactReviewSecrets(renderCitationReport({ ...result, catalog })), { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, citations: result.citations?.status ?? 'not_checked',
    semantics: 'not_checked', resultPath: path.join(runDir, 'result.json'), reportPath: path.join(runDir, 'report.md') }));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/review-sql-citations.ts <heldout-probe-result.json> <G|H|I|J|K|L>');
  runSourceCitationReview(path.resolve(process.argv[2]), process.argv[3])
    .then(result => { if (result.status !== 'completed') process.exitCode = 1; })
    .catch(error => { console.error(redactReviewSecrets(String(error))); process.exitCode = 1; });
}
