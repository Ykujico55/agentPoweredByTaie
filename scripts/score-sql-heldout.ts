import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const dimensions = ['method_or_binding', 'value_or_side_effect', 'line_or_location', 'interprocedural_or_path', 'evidence_or_policy'] as const;
const verdicts = ['correct', 'incorrect', 'unsupported', 'unverifiable'] as const;
const fields = ['ruleClaim', 'rationale', 'assumptions', 'missingEvidence'];
type Verdict = typeof verdicts[number];
interface Claim {
  id: string; semanticId: string; field: string; quote: string;
  category: typeof dimensions[number]; verdict: Verdict; note: string;
  evidence: { path: string; startLine: number; endLine: number }[];
}
interface FactReview {
  caseId: string; findingId: string; responseTextSha256: string; examinedFields: string[];
  claims: Claim[]; anchors: { id: string; claimIds: string[] }[];
}
interface FactFile {
  schemaVersion: 1; reviewResultSha256: string; method: 'agent_assisted'; status: 'provisional'; humanApproval: 'pending';
  reviews: FactReview[];
}
interface Observation {
  caseId: string; findingId: string; truth: string; status: string; rawAssessment?: string;
  normalized?: { assessment: string }; response?: { text: string }; requestPath?: string;
  manifest?: { originalHashes: Record<string, string>; promptSha256?: string };
}
const ratio = (numerator: number, denominator: number) => ({ numerator, denominator, rate: denominator ? numerator / denominator : null });
function countClaims(claims: readonly Claim[]) {
  const counts = Object.fromEntries(verdicts.map(verdict => [verdict, claims.filter(claim => claim.verdict === verdict).length])) as Record<Verdict, number>;
  return { claims: claims.length, ...counts, atomicAccuracy: ratio(counts.correct, claims.length),
    decidedAccuracy: ratio(counts.correct, counts.correct + counts.incorrect) };
}
function rawField(raw: Record<string, unknown>, field: string): string {
  const match = /^(ruleClaim|rationale|assumptions|missingEvidence)(?:\[(\d+)\])?$/.exec(field);
  assert.ok(match, `Unsupported fact field: ${field}`);
  const value = match[2] === undefined ? raw[match[1]] : (raw[match[1]] as unknown[])?.[Number(match[2])];
  assert.equal(typeof value, 'string', `Fact field is not a string: ${field}`);
  return value as string;
}

/** Score explicit, source-linked adjudications. This does not discover or prove semantic facts. */
export async function scoreHeldoutFacts(resultPath: string, factPath: string) {
  const resultBytes = await readFile(resultPath);
  const result = JSON.parse(resultBytes.toString('utf8')) as {
    protocolSha256: string; metrics: unknown; observations: Observation[];
  };
  const factBytes = await readFile(factPath);
  const facts = JSON.parse(factBytes.toString('utf8')) as FactFile;
  assert.equal(facts.schemaVersion, 1);
  assert.equal(facts.reviewResultSha256, digest(resultBytes), 'Fact review belongs to another model run.');
  assert.equal(facts.method, 'agent_assisted'); assert.equal(facts.status, 'provisional'); assert.equal(facts.humanApproval, 'pending');
  const protocolPath = path.join(path.dirname(resultPath), 'protocol.json');
  const protocolBytes = await readFile(protocolPath);
  assert.equal(digest(protocolBytes), result.protocolSha256, 'Recorded scoring protocol changed.');
  const protocol = JSON.parse(protocolBytes.toString('utf8')) as { systemPromptSha256: string; factAnchors: Record<string, { id: string; description: string }[]> };
  assert.ok(protocol.factAnchors, 'Missing predeclared fact anchors.');
  const key = (item: { caseId: string; findingId: string }) => `${item.caseId}/${item.findingId}`;
  assert.equal(new Set(result.observations.map(key)).size, result.observations.length, 'Duplicate observation.');
  const known = new Set(result.observations.map(key));
  const reviews = new Map<string, FactReview>();
  for (const review of facts.reviews) {
    assert.ok(known.has(key(review)), `Unknown reviewed finding: ${key(review)}`);
    assert.ok(!reviews.has(key(review)), `Duplicate fact review: ${key(review)}`);
    reviews.set(key(review), review);
  }
  const fileCache = new Map<string, { sha256: string; lines: string[] }>();
  const readEvidence = async (file: string) => {
    let cached = fileCache.get(file);
    if (!cached) {
      const bytes = await readFile(file);
      cached = { sha256: digest(bytes), lines: bytes.toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') };
      fileCache.set(file, cached);
    }
    return cached;
  };
  const outputs = [];
  for (const row of result.observations) {
    assert.ok(['vulnerable', 'safe_under_stated_assumptions'].includes(row.truth), 'Unknown independent truth.');
    const anchors = protocol.factAnchors[row.caseId];
    assert.ok(Array.isArray(anchors) && anchors.length, `Missing anchors for ${row.caseId}`);
    assert.equal(new Set(anchors.map(anchor => anchor.id)).size, anchors.length, 'Duplicate protocol anchor.');
    const review = reviews.get(key(row));
    const unique = new Map<string, Claim>();
    const claimsById = new Map<string, Claim>();
    const mentioned = new Set<string>();
    const supported = new Set<string>();
    if (review) {
      assert.ok(row.response?.text, 'Cannot review facts without a model response.');
      assert.equal(review.responseTextSha256, digest(row.response.text), 'Raw model response changed.');
      assert.deepEqual([...review.examinedFields].sort(), [...fields].sort(), 'Every explanatory field must be examined.');
      const text = row.response.text.trim();
      const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
      const raw = JSON.parse(fenced ? fenced[1] : text) as Record<string, unknown>;
      const allowedEvidence = new Map(Object.entries(row.manifest?.originalHashes ?? {}).map(([file, sha256]) => [path.resolve(file), sha256]));
      if (row.requestPath) {
        const requestFile = path.resolve(row.requestPath);
        const request = JSON.parse(await readFile(requestFile, 'utf8')) as { prompt: string; systemPrompt: string };
        assert.equal(digest(request.prompt), row.manifest?.promptSha256, 'Recorded request evidence changed.');
        assert.equal(digest(request.systemPrompt), protocol.systemPromptSha256, 'Recorded request system prompt changed.');
        allowedEvidence.set(requestFile, (await readEvidence(requestFile)).sha256);
      }
      for (const claim of review.claims) {
        assert.ok(claim.id?.trim() && claim.semanticId?.trim() && claim.quote?.trim() && claim.note?.trim(), 'Empty claim metadata or quotation.');
        assert.ok(!claimsById.has(claim.id), `Duplicate claim id: ${claim.id}`);
        assert.ok(dimensions.includes(claim.category), `Unsupported dimension: ${claim.category}`);
        assert.ok(verdicts.includes(claim.verdict), `Unsupported verdict: ${claim.verdict}`);
        assert.ok(rawField(raw, claim.field).includes(claim.quote), `Quotation is not in raw model field: ${claim.id}`);
        assert.ok(Array.isArray(claim.evidence) && claim.evidence.length, `Claim lacks evidence: ${claim.id}`);
        for (const evidence of claim.evidence) {
          const file = path.resolve(path.dirname(factPath), evidence.path);
          assert.ok(allowedEvidence.has(file), `Evidence is outside recorded inputs: ${file}`);
          const loaded = await readEvidence(file);
          assert.equal(loaded.sha256, allowedEvidence.get(file), `Recorded fact evidence changed: ${file}`);
          assert.ok(Number.isSafeInteger(evidence.startLine) && Number.isSafeInteger(evidence.endLine)
            && evidence.startLine >= 1 && evidence.endLine >= evidence.startLine && evidence.endLine <= loaded.lines.length,
          `Invalid evidence line range: ${claim.id}`);
        }
        const previous = unique.get(claim.semanticId);
        if (previous) {
          assert.equal(claim.verdict, previous.verdict, `Conflicting duplicate fact verdict: ${claim.semanticId}`);
          assert.equal(claim.category, previous.category, `Conflicting duplicate fact category: ${claim.semanticId}`);
        } else unique.set(claim.semanticId, claim);
        claimsById.set(claim.id, claim);
      }
      for (const anchor of review.anchors) {
        assert.ok(anchors.some(item => item.id === anchor.id), `Unknown anchor: ${anchor.id}`);
        assert.ok(!mentioned.has(anchor.id), `Duplicate covered anchor: ${anchor.id}`);
        assert.ok(anchor.claimIds.length && anchor.claimIds.every(id => claimsById.has(id)), `Anchor lacks known claims: ${anchor.id}`);
        mentioned.add(anchor.id);
        if (anchor.claimIds.every(id => claimsById.get(id)!.verdict === 'correct')) supported.add(anchor.id);
      }
    }
    const claims = [...unique.values()];
    const counts = countClaims(claims);
    const expected = row.truth === 'vulnerable' ? 'true_positive' : 'suspected_false_positive';
    const classificationCorrect = {
      raw: row.status === 'completed' && row.rawAssessment === expected,
      normalized: row.status === 'completed' && row.normalized?.assessment === expected,
    };
    outputs.push({ caseId: row.caseId, findingId: row.findingId, status: review ? 'reviewed' : 'unreviewed',
      modelStatus: row.status, classificationCorrect, counts,
      allFactsSupported: row.status === 'completed' && claims.length > 0 && claims.every(claim => claim.verdict === 'correct'),
      containsErrorOrUnsupported: counts.incorrect + counts.unsupported > 0,
      categories: Object.fromEntries(dimensions.map(dimension => [dimension, countClaims(claims.filter(claim => claim.category === dimension))])),
      anchorCoverage: { mentioned: ratio(mentioned.size, anchors.length), supported: ratio(supported.size, anchors.length),
        missing: anchors.filter(anchor => !mentioned.has(anchor.id)).map(anchor => anchor.id),
        unsupported: [...mentioned].filter(id => !supported.has(id)) },
      uniqueClaims: claims, quotationsSubmitted: review?.claims.length ?? 0 });
  }
  const allClaims = outputs.flatMap(row => row.uniqueClaims);
  const anchorCount = outputs.reduce((sum, row) => sum + row.anchorCoverage.mentioned.denominator, 0);
  const evaluation = {
    schemaVersion: 1, method: 'agent_assisted', status: 'provisional', humanApproval: 'pending',
    resultPath: path.resolve(resultPath), resultSha256: digest(resultBytes), factReviewPath: path.resolve(factPath), factReviewSha256: digest(factBytes),
    protocolSha256: result.protocolSha256, classification: result.metrics,
    facts: { ...countClaims(allClaims), plannedReviewAttempts: outputs.length, reviewedResponses: outputs.filter(row => row.status === 'reviewed').length,
      allFactsSupportedRate: ratio(outputs.filter(row => row.allFactsSupported).length, outputs.length),
      fullSupportedExplanationRate: ratio(outputs.filter(row => row.allFactsSupported && row.anchorCoverage.supported.numerator === row.anchorCoverage.supported.denominator).length, outputs.length),
      categories: Object.fromEntries(dimensions.map(dimension => [dimension, countClaims(allClaims.filter(claim => claim.category === dimension))])),
      anchorsMentioned: ratio(outputs.reduce((sum, row) => sum + row.anchorCoverage.mentioned.numerator, 0), anchorCount),
      anchorsSupported: ratio(outputs.reduce((sum, row) => sum + row.anchorCoverage.supported.numerator, 0), anchorCount),
      unreviewedFindings: outputs.filter(row => row.status === 'unreviewed').map(key),
      classificationCorrectExplanationWrong: outputs.filter(row => row.classificationCorrect.normalized && row.containsErrorOrUnsupported).map(key),
      classificationCorrectExplanationUnresolved: outputs.filter(row => row.classificationCorrect.normalized && row.counts.unverifiable > 0).map(key),
      classificationCorrectMissingAnchors: outputs.filter(row => row.classificationCorrect.normalized && row.anchorCoverage.missing.length > 0).map(key),
    }, observations: outputs,
    limitations: ['Agent-assisted adjudication, provisional until human sign-off; no automatic semantic proof.',
      'Semantic claim grouping and extraction completeness are reviewer judgments. The scorer validates provenance and arithmetic, not truth.',
      'Unsupported is distinct from contradicted. Omitted dimensions are N/A; repeated claims within a response count once.',
      'All planned review attempts remain in the reply-level denominator. Missing findings belong to detection coverage, not invented review attempts.'],
  };
  const display = (value: ReturnType<typeof ratio>) => value.rate === null ? 'N/A' : `${value.numerator}/${value.denominator} (${(value.rate * 100).toFixed(1)}%)`;
  const directory = path.dirname(resultPath);
  const markdown = [
    '# Held-out 分类与解释事实核对', '',
    '**核对方式：agent-assisted；结果：provisional；人工签收：pending。**', '',
    '本表统计逐条源码核对记录，不自动证明解释正确，也不关闭告警。分类完整指标沿用原运行记录，事实评分独立保存。', '',
    `分类正确率（宿主建议，弃权和失败保留在分母）：${display(ratio(outputs.filter(row => row.classificationCorrect.normalized).length, outputs.length))}。`, '',
    `已核实原子事实正确率：${display(evaluation.facts.atomicAccuracy)}；仅已裁定事实正确率：${display(evaluation.facts.decidedAccuracy)}。`, '',
    `回复级全部事实获支持率：${display(evaluation.facts.allFactsSupportedRate)}；同时覆盖全部关键锚点：${display(evaluation.facts.fullSupportedExplanationRate)}。`, '',
    `关键锚点提及：${display(evaluation.facts.anchorsMentioned)}；获支持：${display(evaluation.facts.anchorsSupported)}。`, '',
    '| 案例 / 告警 | 分类正确 | 正确 / 错误 / 无依据 / 无法裁定 | 全部事实获支持 | 锚点获支持 |',
    '| --- | --- | --- | --- | --- |',
    ...outputs.map(row => `| ${row.caseId} / ${row.findingId} | ${row.classificationCorrect.normalized} | ${row.counts.correct} / ${row.counts.incorrect} / ${row.counts.unsupported} / ${row.counts.unverifiable} | ${row.allFactsSupported} (${row.status}) | ${display(row.anchorCoverage.supported)} |`), '',
    '| 事实类别 | 已核实正确率 | 错误 | 无依据 | 无法裁定 |', '| --- | --- | ---: | ---: | ---: |',
    ...dimensions.map(dimension => { const counts = evaluation.facts.categories[dimension]; return `| ${dimension} | ${display(counts.atomicAccuracy)} | ${counts.incorrect} | ${counts.unsupported} | ${counts.unverifiable} |`; }), '',
    `分类正确但解释含错误/无依据：${evaluation.facts.classificationCorrectExplanationWrong.join('、') || '无'}。`, '',
    `尚未核对的回复：${evaluation.facts.unreviewedFindings.join('、') || '无'}；它们仍在回复级分母中。`, '',
    '[完整评分、逐项引述与证据](evaluation.json) · [原始分类运行](result.json)', '',
    '没有声称行号的回复不算行号能力通过；没有谈到关键事实属于解释不充分，与事实错误分开。原子主张划分、覆盖和判定本身仍待人工复核。', '',
  ].join('\n');
  await writeFile(path.join(directory, 'evaluation.json'), JSON.stringify(evaluation, null, 2) + '\n', { flag: 'wx' });
  await writeFile(path.join(directory, 'evaluation.md'), markdown, { flag: 'wx' });
  return evaluation;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/score-sql-heldout.ts <review-result.json> <fact-review.json>');
  scoreHeldoutFacts(path.resolve(process.argv[2]), path.resolve(process.argv[3]))
    .then(result => console.log(JSON.stringify({ status: result.status, facts: result.facts, reportPath: path.join(path.dirname(result.resultPath), 'evaluation.md') })))
    .catch(error => { console.error(String(error)); process.exitCode = 1; });
}
