import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactReviewSecrets } from '../src/review-evidence.ts';
import { completeReview, type ReviewCompletion } from '../src/review-model.ts';
import { parseReviewSuggestion } from '../src/review.ts';
import { digest, loadFrozenProtocol, root, type HeldoutProbe } from './probe-sql-heldout.ts';
import { buildHeldoutReviewInput, loadDatasetLock, summarizeHeldout, type HeldoutObservation } from './review-sql-heldout.ts';

interface RegressionProtocol {
  id: string; promptVersion: string; systemPromptFile: string; systemPromptSha256: string; runnerSha256: string;
  provider: string; model: string; timeoutMs: number; factAnchors: Record<string, { id: string; description: string }[]>;
}
export async function loadRegressionProtocol(file = path.join(root, 'evaluations/sql-regression-v3/protocol.json'), base = root) {
  const bytes = await readFile(file);
  const protocol = JSON.parse(bytes.toString('utf8')) as RegressionProtocol;
  assert.equal(protocol.id, 'sql-regression-v3'); assert.equal(protocol.promptVersion, '3');
  assert.equal(protocol.systemPromptFile, 'evaluations/sql-regression-v3/system-prompt.txt');
  assert.ok(protocol.factAnchors, 'Missing regression fact anchors.');
  const systemPrompt = await readFile(path.join(base, protocol.systemPromptFile), 'utf8');
  const verify = async () => {
    assert.equal(digest(await readFile(file)), digest(bytes), 'Regression protocol changed.');
    assert.equal(digest(await readFile(path.join(base, protocol.systemPromptFile))), protocol.systemPromptSha256, 'Regression prompt changed.');
    assert.equal(digest(await readFile(path.join(base, 'scripts/review-sql-regression.ts'))), protocol.runnerSha256, 'Regression runner changed.');
  };
  assert.equal(digest(systemPrompt), protocol.systemPromptSha256, 'Regression prompt changed.');
  await verify();
  return { protocol, bytes, sha256: digest(bytes), systemPrompt, verify };
}

/** Reuse the recorded evidence and scoring contract; this reused dataset is a regression set. */
export async function runRegressionReview(probePath: string, complete = completeReview) {
  const regression = await loadRegressionProtocol();
  const frozen = await loadFrozenProtocol();
  const locked = await loadDatasetLock();
  const probeBytes = await readFile(probePath);
  const probe = JSON.parse(probeBytes.toString('utf8')) as HeldoutProbe;
  assert.equal(probe.status, 'completed');
  assert.equal(probe.protocolSha256, frozen.sha256, 'Probe used another source protocol.');
  assert.equal(probe.inputs.oracleSha256, locked.lock.oracleSha256, 'Probe oracle differs from dataset lock.');
  assert.equal(probe.inputs.policySha256, locked.lock.fixtureHashes['tests/fixtures/sql-heldout/taint.yml']);
  for (const source of probe.inputs.sourceManifest)
    assert.equal(source.sha256, locked.lock.fixtureHashes[`tests/fixtures/sql-heldout/src/main/java/${source.relativePath}`], 'Probe source differs from dataset lock.');
  assert.deepEqual(probe.cases.map(item => item.id).sort(), [...frozen.protocol.caseIds].sort());
  const rows: HeldoutObservation[] = probe.cases.flatMap(item => {
    const actual = probe.check.findings.filter(finding => finding.className === item.className && finding.type === 'TAINT_FLOW');
    assert.equal(item.actualFindingCount, actual.length); assert.deepEqual(actual.map(finding => finding.id), item.findingIds);
    return actual.map(finding => ({ caseId: item.id, findingId: finding.id, truth: item.truth, status: 'failed' as const, diagnostics: [] }));
  });
  const started = Date.now();
  const directory = path.join(root, '.taie-agent/sql-regression-v3', `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const result: Record<string, unknown> = { schemaVersion: 1, status: 'running', datasetRole: 'regression', startedAt: new Date(started).toISOString(),
    probePath: path.resolve(probePath), probeSha256: digest(probeBytes), sourceProtocolSha256: frozen.sha256, datasetLockSha256: locked.sha256,
    protocolSha256: regression.sha256, promptVersion: '3', systemPromptSha256: regression.protocol.systemPromptSha256,
    runnerSha256: regression.protocol.runnerSha256, provider: regression.protocol.provider, model: regression.protocol.model, observations: rows,
    facts: { status: 'pending_separate_adjudication', rubric: 'protocol.json#factAnchors', report: 'fact-review.json' },
    affectsCheckStatus: false, disposition: 'pending_human', currentWorkspace: 'not_checked' };
  const save = () => writeFile(path.join(directory, 'result.json'), redactReviewSecrets(JSON.stringify(result, null, 2)) + '\n');
  for (const [name, bytes] of [['protocol.json', regression.bytes], ['source-protocol.json', frozen.bytes], ['dataset-lock.json', locked.bytes],
    ['system-prompt.txt', regression.systemPrompt], ['source-probe.json', probeBytes]] as const)
    await writeFile(path.join(directory, name), bytes, { flag: 'wx' });
  const verify = async () => {
    await regression.verify(); await frozen.verify(); await locked.verify();
    assert.equal(digest(await readFile(probePath)), digest(probeBytes), 'Source probe changed.');
  };
  await save(); console.log(`[sql-regression-v3] Evidence: ${directory}`);
  for (const [index, row] of rows.entries()) {
    const rowStarted = Date.now();
    const runDir = path.join(directory, `${row.caseId}-${index + 1}`);
    await mkdir(runDir);
    row.runDir = runDir; row.requestPath = path.join(runDir, 'request.json'); row.responsePath = path.join(runDir, 'response.json');
    let input: Awaited<ReturnType<typeof buildHeldoutReviewInput>> | undefined;
    try {
      await verify(); input = await buildHeldoutReviewInput(probePath, row.caseId, row.findingId);
      row.manifest = input.manifest;
      await writeFile(path.join(runDir, 'input-manifest.json'), JSON.stringify(input.manifest, null, 2) + '\n', { flag: 'wx' });
      await writeFile(row.requestPath, JSON.stringify({ promptVersion: '3', systemPromptSha256: regression.protocol.systemPromptSha256,
        systemPrompt: regression.systemPrompt, prompt: input.prompt }, null, 2) + '\n', { flag: 'wx' });
      row.requestAttempted = true;
      row.response = await complete({ provider: regression.protocol.provider, model: regression.protocol.model,
        timeoutMs: regression.protocol.timeoutMs, runDir, systemPrompt: regression.systemPrompt, prompt: input.prompt });
      const text = row.response.text.trim();
      const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
      row.rawSuggestion = JSON.parse(fenced ? fenced[1] : text);
      row.rawAssessment = (row.rawSuggestion as { assessment?: string })?.assessment;
      const parsed = parseReviewSuggestion(row.response.text, row.findingId);
      row.normalized = parsed.suggestion; row.diagnostics = parsed.diagnostics; row.status = 'completed';
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
      if (error && typeof error === 'object' && 'response' in error && error.response) row.response = error.response as ReviewCompletion;
    }
    if (input) { row.originalsUnchanged = await input.verifyUnchanged(); if (!row.originalsUnchanged) row.status = 'stale'; }
    try { await verify(); row.frozenInputsUnchanged = true; }
    catch (error) { row.status = 'stale'; row.frozenInputsUnchanged = false; row.error = String(error); }
    row.durationMs = Date.now() - rowStarted;
    await writeFile(row.responsePath, redactReviewSecrets(JSON.stringify(row, null, 2)) + '\n', { flag: 'wx' });
    await save(); console.log(`${row.caseId}/${row.findingId}: ${row.status}; raw=${row.rawAssessment ?? 'unavailable'}; normalized=${row.normalized?.assessment ?? 'unavailable'}`);
  }
  result.status = rows.every(row => row.status === 'completed') ? 'completed' : 'failed';
  result.metrics = summarizeHeldout(probe.cases, rows);
  result.finishedAt = new Date().toISOString(); result.durationMs = Date.now() - started;
  await save();
  await writeFile(path.join(directory, 'matrix.md'), ['# SQL v3 回归分类结果', '',
    `数据用途：regression；执行状态：${result.status}；解释事实核对：待逐条核对。`, '',
    '| 案例 | 独立真值 | 原始建议 / 宿主建议 | 状态 |', '| --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.caseId} | ${row.truth} | ${row.rawAssessment ?? '无'} / ${row.normalized?.assessment ?? '无'} | ${row.status} |`), '',
    `复用既有六个案例检验提示改动；分类分母包括全部 ${rows.length} 次计划复核，保留弃权、失败和无效响应。`, '',
    '[分类、用量与失败](result.json) · [v3 协议与事实锚点](protocol.json) · [旧输入记录](source-probe.json)', '',
    ...rows.map((row, index) => `- ${row.caseId}：[请求](${row.caseId}-${index + 1}/request.json) · [回复](${row.caseId}-${index + 1}/response.json)`), '',
  ].join('\n'), { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, datasetRole: 'regression', resultPath: path.join(directory, 'result.json') }));
  return path.join(directory, 'result.json');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/review-sql-regression.ts <heldout-probe-result.json>');
  runRegressionReview(path.resolve(process.argv[2])).then(async file => {
    if (JSON.parse(await readFile(file, 'utf8')).status !== 'completed') process.exitCode = 1;
  }).catch(error => { console.error(redactReviewSecrets(String(error))); process.exitCode = 1; });
}
