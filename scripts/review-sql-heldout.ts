import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MavenCheckResult } from '../src/docker-maven.ts';
import { loadReviewEvidence, redactReviewSecrets } from '../src/review-evidence.ts';
import { completeReview, type ReviewCompletion } from '../src/review-model.ts';
import { parseReviewSuggestion, type ReviewSuggestion } from '../src/review.ts';
import { digest, loadFrozenProtocol, root, type HeldoutCase, type HeldoutProbe } from './probe-sql-heldout.ts';

const lockPath = path.join(root, 'evaluations/sql-heldout-v1/dataset-lock.json');
interface DatasetLock { fixtureHashes: Record<string, string>; runnerHashes: Record<string, string>; oracleSha256: string }
export async function loadDatasetLock(file = lockPath, base = root) {
  const bytes = await readFile(file);
  const lock = JSON.parse(bytes.toString('utf8')) as DatasetLock;
  const verify = async () => {
    assert.equal(digest(await readFile(file)), digest(bytes), 'Dataset lock changed.');
    for (const [relativePath, sha256] of Object.entries({ ...lock.fixtureHashes, ...lock.runnerHashes }))
      assert.equal(digest(await readFile(path.join(base, relativePath))), sha256, `Locked dataset or runner changed: ${relativePath}`);
  };
  await verify();
  return { lock, bytes, sha256: digest(bytes), verify };
}

/** Same full-evidence template as the frozen development runner; only the selected case differs. */
export async function buildHeldoutReviewInput(probePath: string, caseId: string, findingId: string) {
  assert.ok(['G', 'H', 'I', 'J', 'K', 'L'].includes(caseId), 'Unknown held-out case.');
  const hashes: Record<string, string> = {};
  const recorded = async (file: string) => {
    const bytes = await readFile(file);
    hashes[path.resolve(file)] = digest(bytes);
    return bytes;
  };
  const probe = JSON.parse((await recorded(probePath)).toString('utf8')) as HeldoutProbe;
  assert.equal(probe.status, 'completed');
  const loaded = await loadReviewEvidence({ projectDir: probe.projectDir, reportPath: probe.check.reportPath, findingId });
  assert.deepEqual(loaded.check, probe.check, 'Stored check differs from probe.');
  assert.equal(loaded.finding.type, 'TAINT_FLOW');
  assert.equal(loaded.finding.className, `example.Case${caseId}`);
  hashes[path.resolve(probe.check.reportPath)] = loaded.reportSha256;
  const backend = JSON.parse((await recorded(loaded.check.backendReportPath)).toString('utf8')) as MavenCheckResult;
  assert.equal(backend.schemaVersion, 2);
  assert.equal(backend.runDir, loaded.check.runDir);
  assert.equal(backend.snapshotFingerprint, loaded.check.snapshotFingerprint);
  assert.equal(backend.analysis?.sourceFingerprint, loaded.check.sourceFingerprint);
  const snapshot = path.join(backend.runDir, 'snapshot/project');
  const policyBytes = await recorded(path.join(snapshot, 'taint.yml'));
  assert.equal(digest(policyBytes), probe.inputs.policySha256, 'Snapshot policy changed.');
  if (backend.analysis?.taintConfiguration?.sha256)
    assert.equal(digest(policyBytes), backend.analysis.taintConfiguration.sha256, 'Snapshot policy differs from analyzed policy.');
  const selectedSources = [`example/Case${caseId}.java`, 'example/Main.java'];
  const sources = [];
  for (const relativePath of selectedSources) {
    const matches = probe.inputs.sourceManifest.filter(item => item.relativePath === relativePath);
    assert.equal(matches.length, 1, `Missing or ambiguous manifest: ${relativePath}`);
    const bytes = await recorded(path.join(snapshot, 'src/main/java', relativePath));
    assert.equal(digest(bytes), matches[0].sha256, `Snapshot source changed: ${relativePath}`);
    sources.push({ relativePath: `src/main/java/${relativePath}`, sha256: matches[0].sha256, content: bytes.toString('utf8') });
  }
  const packet = structuredClone(loaded.packet);
  const context = (packet.evidence as { id: string; data: Record<string, unknown> }[]).find(item => item.id === 'context')!.data;
  context.policy = { relativePath: 'taint.yml', sha256: digest(policyBytes), content: policyBytes.toString('utf8') };
  context.sourceFiles = sources;
  context.availableContext = 'The selected class and entry class are supplied in full from the analyzed input snapshot. Other classes and library implementations are not supplied.';
  packet.limitations = [
    '仅针对已保存的分析输入，未读取或验证当前工作区。具体可见文件列在 context 中；未列出的实现不能假定已知。',
    ...(loaded.packet.limitations as string[]).slice(2),
  ];
  const prompt = redactReviewSecrets(JSON.stringify(packet, null, 2));
  assert.ok(prompt.length <= 64_000, 'Evidence exceeds frozen 64000-character budget.');
  return { prompt, manifest: { caseId, findingId, reportPath: loaded.check.reportPath, reportSha256: loaded.reportSha256,
    sourceFingerprint: loaded.check.sourceFingerprint, snapshotFingerprint: loaded.check.snapshotFingerprint,
    includedSourceFiles: sources.map(({ relativePath, sha256 }) => ({ relativePath, sha256 })),
    policySha256: digest(policyBytes), promptSha256: digest(prompt), originalHashes: hashes,
    applicability: 'recorded_input_only', currentWorkspace: 'not_checked',
    excluded: ['oracle labels and code arguments', 'SQL observations', 'test assertions', 'other findings', 'grading rubric'] },
  async verifyUnchanged() {
    for (const [file, sha256] of Object.entries(hashes)) {
      try { if (digest(await readFile(file)) !== sha256) return false; } catch { return false; }
    }
    return true;
  } };
}

export interface HeldoutObservation {
  caseId: string; findingId: string; truth: HeldoutCase['truth']; status: 'failed' | 'completed' | 'stale';
  rawAssessment?: string; rawSuggestion?: unknown; normalized?: ReviewSuggestion; response?: ReviewCompletion;
  requestAttempted?: boolean; diagnostics: string[]; error?: string; durationMs?: number;
  runDir?: string; requestPath?: string; responsePath?: string;
  originalsUnchanged?: boolean; frozenInputsUnchanged?: boolean;
  manifest?: Awaited<ReturnType<typeof buildHeldoutReviewInput>>['manifest'];
}
const isBinary = (value?: string) => value === 'true_positive' || value === 'suspected_false_positive';
const expected = (truth: HeldoutCase['truth']) => truth === 'vulnerable' ? 'true_positive' : 'suspected_false_positive';
const ratio = (numerator: number, denominator: number) => ({ numerator, denominator, rate: denominator ? numerator / denominator : null });

export function summarizeHeldout(cases: readonly HeldoutCase[], rows: readonly HeldoutObservation[]) {
  const score = (normalized: boolean) => {
    const value = (row: HeldoutObservation) => normalized ? row.normalized?.assessment : row.rawAssessment;
    const valid = rows.filter(row => row.status === 'completed');
    const binary = valid.filter(row => isBinary(value(row)));
    const correct = binary.filter(row => value(row) === expected(row.truth)).length;
    const confusion = { trueAsTrue: 0, trueAsFalse: 0, falseAsTrue: 0, falseAsFalse: 0 };
    for (const row of binary) {
      const key = row.truth === 'vulnerable' ? value(row) === 'true_positive' ? 'trueAsTrue' : 'trueAsFalse'
        : value(row) === 'true_positive' ? 'falseAsTrue' : 'falseAsFalse';
      confusion[key]++;
    }
    return { primaryAccuracy: ratio(correct, rows.length), decisionAccuracy: ratio(correct, binary.length),
      decisionCoverage: ratio(binary.length, rows.length), confusion,
      abstentions: valid.filter(row => ['unknown', 'analysis_incomplete'].includes(value(row) ?? '')).length,
      otherSuggestions: valid.filter(row => ['accepted_risk', 'out_of_scope'].includes(value(row) ?? '')).length };
  };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 };
  let responsesWithUsage = 0;
  for (const row of rows) if (row.response?.usage && typeof row.response.usage === 'object') {
    responsesWithUsage++;
    for (const key of Object.keys(usage) as (keyof typeof usage)[]) {
      const amount = (row.response.usage as Record<string, unknown>)[key];
      if (typeof amount === 'number' && Number.isFinite(amount)) usage[key] += amount;
    }
  }
  return { plannedCases: cases.length, eligibleCases: cases.filter(item => item.actualFindingCount > 0).length,
    notReportedCases: cases.filter(item => !item.actualFindingCount).map(item => item.id),
    eligibleFindings: cases.reduce((sum, item) => sum + item.actualFindingCount, 0), plannedReviewAttempts: rows.length,
    requestsAttempted: rows.filter(row => row.requestAttempted).length, responsesReceived: rows.filter(row => row.response).length,
    validResponses: rows.filter(row => row.status === 'completed').length,
    failed: rows.filter(row => row.status === 'failed').length, stale: rows.filter(row => row.status === 'stale').length,
    raw: score(false), normalized: score(true),
    rawFalsePositiveSuggestionsOnVulnerable: rows.filter(row => row.truth === 'vulnerable' && row.rawAssessment === 'suspected_false_positive').length,
    perCase: cases.map(item => ({ caseId: item.id, truth: item.truth, findings: item.actualFindingCount,
      predictions: rows.filter(row => row.caseId === item.id).map(row => ({ findingId: row.findingId, status: row.status,
        raw: row.rawAssessment, normalized: row.normalized?.assessment })) })),
    usage: { responsesWithUsage, totals: usage, scope: 'SDK reported; rejected replies retained, missing usage not estimated.' } };
}

export async function runHeldoutReview(probePath: string) {
  const frozen = await loadFrozenProtocol();
  const locked = await loadDatasetLock();
  const probeBytes = await readFile(probePath);
  const probe = JSON.parse(probeBytes.toString('utf8')) as HeldoutProbe;
  assert.equal(probe.status, 'completed');
  assert.equal(probe.protocolSha256, frozen.sha256, 'Probe used another protocol.');
  assert.equal(probe.inputs.oracleSha256, locked.lock.oracleSha256, 'Probe oracle differs from dataset lock.');
  assert.deepEqual(probe.cases.map(item => item.id).sort(), [...frozen.protocol.caseIds].sort());
  const rows: HeldoutObservation[] = probe.cases.flatMap(item => {
    const actual = probe.check.findings.filter(finding => finding.className === item.className && finding.type === 'TAINT_FLOW');
    assert.deepEqual(actual.map(finding => finding.id), item.findingIds);
    return actual.map(finding => ({ caseId: item.id, findingId: finding.id, truth: item.truth, status: 'failed' as const, diagnostics: [] }));
  });
  const started = Date.now();
  const directory = path.join(root, '.taie-agent/sql-heldout-review', `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { recursive: true });
  const result: Record<string, unknown> = { schemaVersion: 1, status: 'running', startedAt: new Date(started).toISOString(),
    probePath: path.resolve(probePath), probeSha256: digest(probeBytes), protocolSha256: frozen.sha256, datasetLockSha256: locked.sha256,
    promptVersion: frozen.protocol.promptVersion, systemPromptSha256: frozen.protocol.systemPromptSha256,
    provider: frozen.protocol.provider, model: frozen.protocol.model, observations: rows,
    facts: { status: 'pending_separate_adjudication', rubric: 'protocol.json#facts', report: 'fact-review.json' },
    affectsCheckStatus: false, disposition: 'pending_human', currentWorkspace: 'not_checked' };
  const save = () => writeFile(path.join(directory, 'result.json'), redactReviewSecrets(JSON.stringify(result, null, 2)) + '\n');
  await writeFile(path.join(directory, 'protocol.json'), frozen.bytes, { flag: 'wx' });
  await writeFile(path.join(directory, 'dataset-lock.json'), locked.bytes, { flag: 'wx' });
  await writeFile(path.join(directory, 'system-prompt.txt'), frozen.systemPrompt, { flag: 'wx' });
  await save();
  console.log(`[sql-heldout-review] Evidence: ${directory}`);
  for (const [index, row] of rows.entries()) {
    const rowStarted = Date.now();
    const runDir = path.join(directory, `${row.caseId}-${index + 1}`);
    await mkdir(runDir);
    row.runDir = runDir; row.requestPath = path.join(runDir, 'request.json'); row.responsePath = path.join(runDir, 'response.json');
    let input: Awaited<ReturnType<typeof buildHeldoutReviewInput>> | undefined;
    try {
      await frozen.verify(); await locked.verify();
      assert.equal(digest(await readFile(probePath)), digest(probeBytes), 'Probe changed during held-out run.');
      input = await buildHeldoutReviewInput(probePath, row.caseId, row.findingId);
      row.manifest = input.manifest;
      await writeFile(path.join(runDir, 'input-manifest.json'), JSON.stringify(input.manifest, null, 2) + '\n', { flag: 'wx' });
      await writeFile(path.join(runDir, 'request.json'), JSON.stringify({ promptVersion: frozen.protocol.promptVersion,
        systemPromptSha256: frozen.protocol.systemPromptSha256, systemPrompt: frozen.systemPrompt, prompt: input.prompt }, null, 2) + '\n', { flag: 'wx' });
      row.requestAttempted = true;
      row.response = await completeReview({ provider: frozen.protocol.provider, model: frozen.protocol.model,
        timeoutMs: frozen.protocol.timeoutMs, runDir, systemPrompt: frozen.systemPrompt, prompt: input.prompt });
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
    try { await frozen.verify(); await locked.verify(); row.frozenInputsUnchanged = true; }
    catch (error) { row.status = 'stale'; row.frozenInputsUnchanged = false; row.error = String(error); }
    row.durationMs = Date.now() - rowStarted;
    await writeFile(path.join(runDir, 'response.json'), redactReviewSecrets(JSON.stringify(row, null, 2)) + '\n', { flag: 'wx' });
    await save();
    console.log(`${row.caseId}/${row.findingId}: ${row.status}; raw=${row.rawAssessment ?? 'unavailable'}; normalized=${row.normalized?.assessment ?? 'unavailable'}`);
  }
  result.status = rows.every(row => row.status === 'completed') ? 'completed' : 'failed';
  result.metrics = summarizeHeldout(probe.cases, rows);
  result.finishedAt = new Date().toISOString(); result.durationMs = Date.now() - started;
  await save();
  await writeFile(path.join(directory, 'matrix.md'), [
    '# Held-out SQL 分类结果', '',
    `执行状态：${result.status}；解释事实核对：待单独逐条核对。提示与实现保持冻结，不自动关闭告警。`, '',
    '| 案例 | 独立真值 | 实际告警 | 原始建议 / 宿主建议 | 状态 |', '| --- | --- | ---: | --- | --- |',
    ...probe.cases.flatMap(item => item.findingIds.length ? rows.filter(row => row.caseId === item.id).map(row =>
      `| ${item.id} | ${item.truth} | ${item.actualFindingCount} | ${row.rawAssessment ?? '无'} / ${row.normalized?.assessment ?? '无'} | ${row.status} |`)
      : [`| ${item.id} | ${item.truth} | 0 | 未报告，无模型请求 | not_reported |`]), '',
    '主分类正确率分母为全部实际可复核告警，弃权、失败和无效响应不能从分母删除。无告警案例单列；同一程序多个告警不是独立程序。', '',
    '[分类分母、原始响应、用量及失败](result.json) · [冻结协议与事实评分口径](protocol.json)', '',
    ...rows.map((row, index) => `- ${row.caseId}/${row.findingId}：[实际提示](${row.caseId}-${index + 1}/request.json) · [原始回复](${row.caseId}-${index + 1}/response.json)`), '',
  ].join('\n'), { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, resultPath: path.join(directory, 'result.json') }));
  if (result.status !== 'completed') process.exitCode = 1;
  return path.join(directory, 'result.json');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/review-sql-heldout.ts <heldout-result.json>');
  runHeldoutReview(path.resolve(process.argv[2])).catch(error => { console.error(redactReviewSecrets(String(error))); process.exitCode = 1; });
}
