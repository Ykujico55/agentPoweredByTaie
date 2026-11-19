import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckResult } from '../src/check.ts';
import type { MavenCheckResult } from '../src/docker-maven.ts';
import { loadReviewEvidence, redactReviewSecrets } from '../src/review-evidence.ts';
import { completeReview, type ReviewCompletion } from '../src/review-model.ts';
import { parseReviewSuggestion, REVIEW_PROMPT_VERSION, REVIEW_SYSTEM_PROMPT, type ReviewSuggestion } from '../src/review.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export type SqlEvidenceMode = 'full' | 'recorded_only';
type SqlCaseId = 'A' | 'B' | 'E' | 'F';
export type SqlReviewSuite = 'v1' | 'v2';
interface ProbeInput {
  status: string;
  projectDir: string;
  check: CheckResult;
  inputs: {
    sourceManifest: { relativePath: string; sha256: string }[];
    policySha256: string;
  };
}

/** Build model-visible evidence from recorded input only; probe labels and oracle stay outside. */
export async function buildSqlReviewInput(probePath: string, caseId: SqlCaseId, evidenceMode: SqlEvidenceMode) {
  assert.ok(['A', 'B', 'E', 'F'].includes(caseId) && ['full', 'recorded_only'].includes(evidenceMode), 'Unsupported case or evidence mode.');
  const hashes: Record<string, string> = {};
  const recorded = async (file: string) => {
    const bytes = await readFile(file);
    hashes[path.resolve(file)] = digest(bytes);
    return bytes;
  };
  const probe = JSON.parse((await recorded(probePath)).toString('utf8')) as ProbeInput;
  assert.equal(probe.status, 'completed', 'SQL probe must have completed before review.');
  const candidates = probe.check.findings.filter(finding => finding.className === `example.Case${caseId}` && finding.type === 'TAINT_FLOW');
  assert.equal(candidates.length, 1, 'This probe requires exactly one recorded taint finding for the selected case.');
  const loaded = await loadReviewEvidence({ projectDir: probe.projectDir, reportPath: probe.check.reportPath, findingId: candidates[0].id });
  assert.deepEqual(loaded.check, probe.check, 'Stored check differs from the check captured by the probe.');
  hashes[path.resolve(probe.check.reportPath)] = loaded.reportSha256;
  const backend = JSON.parse((await recorded(loaded.check.backendReportPath)).toString('utf8')) as MavenCheckResult;
  assert.equal(backend.schemaVersion, 2);
  assert.equal(backend.runDir, loaded.check.runDir);
  assert.equal(backend.snapshotFingerprint, loaded.check.snapshotFingerprint);
  assert.equal(backend.analysis?.sourceFingerprint, loaded.check.sourceFingerprint);
  const snapshot = path.join(backend.runDir, 'snapshot', 'project');
  const policyBytes = await recorded(path.join(snapshot, 'taint.yml'));
  assert.equal(digest(policyBytes), probe.inputs.policySha256, 'Snapshot policy does not match the probe manifest.');
  if (backend.analysis?.taintConfiguration?.sha256)
    assert.equal(digest(policyBytes), backend.analysis.taintConfiguration.sha256, 'Snapshot policy differs from the analyzed policy.');
  const selectedSources = evidenceMode === 'full' ? [`example/Case${caseId}.java`, 'example/Main.java'] : [];
  const sources = [];
  for (const relativePath of selectedSources) {
    const entries = probe.inputs.sourceManifest.filter(entry => entry.relativePath === relativePath);
    assert.equal(entries.length, 1, `Missing or ambiguous source manifest entry: ${relativePath}`);
    const bytes = await recorded(path.join(snapshot, 'src', 'main', 'java', relativePath));
    assert.equal(digest(bytes), entries[0].sha256, `Snapshot differs from analyzed source: ${relativePath}`);
    sources.push({ relativePath: `src/main/java/${relativePath}`, sha256: entries[0].sha256, content: bytes.toString('utf8') });
  }
  const packet = structuredClone(loaded.packet);
  const items = packet.evidence as { id: string; data: Record<string, unknown> }[];
  const context = items.find(item => item.id === 'context')!.data;
  context.policy = { relativePath: 'taint.yml', sha256: digest(policyBytes), content: policyBytes.toString('utf8') };
  context.sourceFiles = sources;
  context.availableContext = evidenceMode === 'full'
    ? 'The selected class and entry class are supplied in full from the analyzed input snapshot. Other classes and library implementations are not supplied.'
    : 'Only the original recorded finding, snippet, abstract path and policy are supplied. Full helper and caller source implementations are not supplied.';
  // Replace only the generic packet's availability description; keep the original finding and analysis evidence intact.
  packet.limitations = [
    '仅针对已保存的分析输入，未读取或验证当前工作区。具体可见文件列在 context 中；未列出的实现不能假定已知。',
    ...(loaded.packet.limitations as string[]).slice(2),
  ];
  const prompt = redactReviewSecrets(JSON.stringify(packet, null, 2));
  assert.ok(prompt.length <= 64_000, 'SQL review evidence exceeds the fixed 64000-character budget.');
  const manifest = {
    caseId, evidenceMode, findingId: loaded.finding.id,
    probePath: path.resolve(probePath), probeSha256: hashes[path.resolve(probePath)],
    reportPath: loaded.check.reportPath, reportSha256: loaded.reportSha256,
    sourceFingerprint: loaded.check.sourceFingerprint, snapshotFingerprint: loaded.check.snapshotFingerprint,
    includedSourceFiles: sources.map(({ relativePath, sha256 }) => ({ relativePath, sha256 })),
    omittedSourceFiles: probe.inputs.sourceManifest.filter(entry => !selectedSources.includes(entry.relativePath))
      .map(entry => `src/main/java/${entry.relativePath}`),
    policySha256: digest(policyBytes), promptSha256: digest(prompt),
    promptVersion: REVIEW_PROMPT_VERSION, systemPromptSha256: digest(REVIEW_SYSTEM_PROMPT),
    excluded: ['investigator labels and expected answers', 'oracle observations', 'test source and assertions', 'other findings'],
    applicability: 'recorded_input_only', currentWorkspace: 'not_checked', originalHashes: hashes,
  };
  return { prompt, systemPrompt: REVIEW_SYSTEM_PROMPT, manifest, findingId: loaded.finding.id,
    async verifyUnchanged() {
      for (const [file, sha256] of Object.entries(hashes)) {
        try { if (digest(await readFile(file)) !== sha256) return false; } catch { return false; }
      }
      return true;
    },
  };
}

const originalScenarios = [
  { name: 'A_full', caseId: 'A', evidenceMode: 'full', expected: ['true_positive'] },
  { name: 'B_full', caseId: 'B', evidenceMode: 'full', expected: ['suspected_false_positive'] },
  { name: 'B_recorded_only', caseId: 'B', evidenceMode: 'recorded_only', expected: ['unknown', 'analysis_incomplete'] },
] as const;

export const SQL_REVIEW_SUITES = {
  v1: originalScenarios,
  v2: [
    ...originalScenarios,
    { name: 'E_full', caseId: 'E', evidenceMode: 'full', expected: ['true_positive'] },
    // The actual recorded path includes instance store/load evidence, unlike B/F's call merge.
    // Retaining a suspected defect or abstaining is acceptable; inventing feasible guards is not.
    { name: 'E_recorded_only', caseId: 'E', evidenceMode: 'recorded_only', expected: ['true_positive', 'unknown', 'analysis_incomplete'] },
    { name: 'F_full', caseId: 'F', evidenceMode: 'full', expected: ['suspected_false_positive'] },
    { name: 'F_recorded_only', caseId: 'F', evidenceMode: 'recorded_only', expected: ['unknown', 'analysis_incomplete'] },
  ],
} as const;

export interface Observation {
  name: string;
  caseId: SqlCaseId;
  status: 'completed' | 'failed' | 'stale';
  expected: readonly string[];
  manifest?: Awaited<ReturnType<typeof buildSqlReviewInput>>['manifest'];
  response?: ReviewCompletion;
  rawSuggestion?: unknown;
  rawAssessment?: string;
  normalized?: ReviewSuggestion;
  diagnostics: string[];
  rawMatchesExpected?: boolean;
  normalizedMatchesExpected?: boolean;
  originalsUnchanged?: boolean;
  error?: string;
  durationMs?: number;
  requestAttempted?: boolean;
  requestDurationMs?: number;
}

/** Grading data never enters the model request. A/E remain vulnerable in partial evidence views. */
export function summarizeSqlReviewObservations(observations: readonly Observation[]) {
  const counts = (normalized: boolean) => Object.fromEntries(['true_positive', 'suspected_false_positive', 'unknown', 'analysis_incomplete', 'accepted_risk', 'out_of_scope']
    .map(assessment => [assessment, observations.filter(row => (normalized ? row.normalized?.assessment : row.rawAssessment) === assessment).length]));
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 };
  let responsesWithUsage = 0;
  for (const row of observations) {
    const usage = row.response?.usage;
    if (!usage || typeof usage !== 'object') continue;
    responsesWithUsage++;
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      const value = (usage as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value)) totals[key] += value;
    }
  }
  return {
    attemptedViews: observations.length, requestsAttempted: observations.filter(row => row.requestAttempted).length,
    responsesReceived: observations.filter(row => row.response).length,
    completed: observations.filter(row => row.status === 'completed').length,
    raw: counts(false), normalized: counts(true), rawExpectedMatches: observations.filter(row => row.rawMatchesExpected).length,
    normalizedExpectedMatches: observations.filter(row => row.normalizedMatchesExpected).length,
    trueFindingFalsePositiveSuggestions: observations.filter(row => ['A', 'E'].includes(row.caseId) && row.rawAssessment === 'suspected_false_positive').length,
    usage: { responsesWithUsage, totals, scope: 'SDK-reported usage, including failed or rejected replies; missing values are not estimated.' },
  };
}

export async function runSqlReviewProbe(probePath: string, suite: SqlReviewSuite = 'v2') {
  const overallStarted = Date.now();
  const scenarios = SQL_REVIEW_SUITES[suite];
  const directory = path.join(root, '.taie-agent/sql-review-probe', `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { recursive: true });
  const observations: Observation[] = [];
  const result: Record<string, unknown> = {
    schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), probePath: path.resolve(probePath),
    provider: 'deepseek', model: 'deepseek-v4-flash', timeoutMs: 180_000, requestsPlanned: scenarios.length,
    suite, promptVersion: REVIEW_PROMPT_VERSION, systemPromptSha256: digest(REVIEW_SYSTEM_PROMPT), scenarios,
    observations, note: 'Development capability probe; independent requests, no retries or prompt changes. The suite selects views, not historical prompt versions. Expected answers are scoring data and are not sent to the model. E partial retains actual instance store/load evidence, so retaining a suspected true finding or abstaining is acceptable; rationale must not invent missing guards.',
  };
  const save = () => writeFile(path.join(directory, 'result.json'), redactReviewSecrets(JSON.stringify(result, null, 2)) + '\n');
  await save();
  console.log(`[sql-review-probe] Evidence: ${directory}`);
  for (const scenario of scenarios) {
    const started = Date.now();
    const runDir = path.join(directory, scenario.name);
    await mkdir(runDir);
    const observation: Observation = { name: scenario.name, caseId: scenario.caseId, status: 'failed', expected: scenario.expected, diagnostics: [] };
    observations.push(observation);
    let input: Awaited<ReturnType<typeof buildSqlReviewInput>> | undefined;
    try {
      input = await buildSqlReviewInput(probePath, scenario.caseId, scenario.evidenceMode);
      observation.manifest = input.manifest;
      await writeFile(path.join(runDir, 'input-manifest.json'), JSON.stringify(input.manifest, null, 2) + '\n', { flag: 'wx' });
      await writeFile(path.join(runDir, 'request.json'), JSON.stringify({ systemPrompt: input.systemPrompt, prompt: input.prompt }, null, 2) + '\n', { flag: 'wx' });
      observation.requestAttempted = true;
      const requestStarted = Date.now();
      try {
        observation.response = await completeReview({ provider: 'deepseek', model: 'deepseek-v4-flash', timeoutMs: 180_000,
          runDir, systemPrompt: input.systemPrompt, prompt: input.prompt });
      } finally {
        observation.requestDurationMs = Date.now() - requestStarted;
      }
      const text = observation.response.text.trim();
      const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
      observation.rawSuggestion = JSON.parse(fenced ? fenced[1] : text);
      observation.rawAssessment = (observation.rawSuggestion as { assessment?: string })?.assessment;
      observation.rawMatchesExpected = (scenario.expected as readonly string[]).includes(observation.rawAssessment ?? '');
      const parsed = parseReviewSuggestion(observation.response.text, input.findingId);
      observation.normalized = parsed.suggestion;
      observation.diagnostics = parsed.diagnostics;
      observation.normalizedMatchesExpected = (scenario.expected as readonly string[]).includes(parsed.suggestion.assessment);
      observation.status = 'completed';
    } catch (error) {
      observation.error = error instanceof Error ? error.message : String(error);
      if (error && typeof error === 'object' && 'response' in error && error.response)
        observation.response = error.response as ReviewCompletion;
    }
    if (input) {
      observation.originalsUnchanged = await input.verifyUnchanged();
      if (!observation.originalsUnchanged) observation.status = 'stale';
    }
    observation.durationMs = Date.now() - started;
    await writeFile(path.join(runDir, 'response.json'), redactReviewSecrets(JSON.stringify(observation, null, 2)) + '\n', { flag: 'wx' });
    await save();
    console.log(`${scenario.name}: ${observation.status}; model=${observation.rawAssessment ?? 'unavailable'}; normalized=${observation.normalized?.assessment ?? 'unavailable'}`);
  }
  result.status = observations.every(row => row.status === 'completed') ? 'completed' : 'failed';
  result.capability = observations.every(row => row.status === 'completed' && row.rawMatchesExpected && row.normalizedMatchesExpected)
    ? 'expected_classifications_observed' : 'gap_observed';
  result.rationaleValidation = 'pending_independent_review';
  result.counts = summarizeSqlReviewObservations(observations);
  result.finishedAt = new Date().toISOString();
  result.durationMs = Date.now() - overallStarted;
  await save();
  await writeFile(path.join(directory, 'matrix.md'), [
    '# SQL 告警复核能力探针', '',
    `机械执行：${result.status}；选定视图上的能力结果：${result.capability}。`, '',
    `视图集合：${suite}；提示版本：${REVIEW_PROMPT_VERSION}；计划请求 ${scenarios.length} 次，实际调用模型接口 ${observations.filter(row => row.requestAttempted).length} 次。`, '',
    '请求独立、无工具、无重试；模型不可见标签和 SQL oracle。此表的预期仅用于运行后评分。', '',
    '| 视图 | 预定目标 | 原始模型建议 | 宿主规范化 | 原始/规范化符合目标 | 状态 |', '| --- | --- | --- | --- | --- | --- |',
    ...observations.map(row => `| ${row.name} | ${row.expected.join(' / ')} | ${row.rawAssessment ?? '无有效建议'} | ${row.normalized?.assessment ?? '无有效建议'} | ${row.rawMatchesExpected ?? false} / ${row.normalizedMatchesExpected ?? false} | ${row.status} |`), '',
    '模型建议与宿主降级分开统计，不能把宿主强制 unknown 当作模型主动弃权。分类符合预期也不自动证明理由成立，仍需逐条检查 rationale、assumptions 和 missingEvidence。', '',
    '本步骤没有关闭告警、改写项目或原报告；当前工作区未核验。同一案例的完整/局部视图共享程序真值，不能作为独立样本估计准确率、成本收益或通用 SQL 注入能力。', '',
    '[完整结果、建议与用量](result.json)', '',
    ...scenarios.map(scenario => `- ${scenario.name}：[实际请求](${scenario.name}/request.json) · [输入清单](${scenario.name}/input-manifest.json) · [原始回复与解析结果](${scenario.name}/response.json)`), '',
  ].join('\n'), { flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, capability: result.capability, resultPath: path.join(directory, 'result.json') }));
  if (result.status !== 'completed') process.exitCode = 1;
  return path.join(directory, 'result.json');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!(args.length === 1 || args.length === 3 && args[1] === '--suite' && ['v1', 'v2'].includes(args[2])))
    throw new Error('Usage: node scripts/review-sql-probe.ts <sql-probe/result.json> [--suite v1|v2]');
  runSqlReviewProbe(path.resolve(args[0]), (args[2] ?? 'v2') as SqlReviewSuite)
    .catch(error => { console.error(redactReviewSecrets(String(error))); process.exitCode = 1; });
}
