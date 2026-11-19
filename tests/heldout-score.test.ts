import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scoreHeldoutFacts } from '../scripts/score-sql-heldout.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: TestContext) {
  const base = path.resolve('.taie-agent/heldout-score-tests');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'case-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(directory)), await realpath(base));
    await rm(directory, { recursive: true, force: true });
  });
  const source = 'String value = read(input);\nString query = select(value);\nstatement.executeQuery(query);\n';
  const sourcePath = path.join(directory, 'Case.java');
  await writeFile(sourcePath, source);
  const protocol = { systemPromptSha256: digest('frozen'), factAnchors: Object.fromEntries(['G', 'H', 'I'].map(caseId => [caseId,
    [{ id: 'source_to_sink', description: 'Relevant source and sink relationship' }, { id: 'state_or_values', description: 'Value behavior' }]])) };
  const protocolBytes = JSON.stringify(protocol);
  await writeFile(path.join(directory, 'protocol.json'), protocolBytes);
  const requestPath = path.join(directory, 'request.json');
  const prompt = JSON.stringify({ source });
  await writeFile(requestPath, JSON.stringify({ prompt, systemPrompt: 'frozen' }));
  const reply = (text: string) => JSON.stringify({ findingId: 'id', assessment: 'true_positive', ruleClaim: 'A rule claim.',
    rationale: text, evidenceRefs: ['finding'], coverage: 'whole_finding', assumptions: [], missingEvidence: [] });
  const gText = reply('The source result is passed to select. The source result is used.');
  const hText = reply('The source result is discarded. Main was not supplied.');
  const result = { protocolSha256: digest(protocolBytes), metrics: { sentinel: 'preserved classification metrics' }, observations: [
    { caseId: 'G', findingId: 'g', truth: 'vulnerable', status: 'completed', rawAssessment: 'true_positive', normalized: { assessment: 'true_positive' },
      response: { text: gText }, requestPath, manifest: { promptSha256: digest(prompt), originalHashes: { [sourcePath]: digest(source) } } },
    { caseId: 'H', findingId: 'h', truth: 'safe_under_stated_assumptions', status: 'completed', rawAssessment: 'suspected_false_positive', normalized: { assessment: 'suspected_false_positive' },
      response: { text: hText }, manifest: { originalHashes: { [sourcePath]: digest(source) } } },
    { caseId: 'I', findingId: 'i', truth: 'vulnerable', status: 'failed' },
  ] };
  const resultBytes = JSON.stringify(result);
  const resultPath = path.join(directory, 'result.json');
  await writeFile(resultPath, resultBytes);
  const evidence = [{ path: sourcePath, startLine: 1, endLine: 3 }];
  const makeClaim = (id: string, semanticId: string, quote: string, verdict: string) => ({ id, semanticId, quote, verdict,
    category: 'value_or_side_effect', field: 'rationale', evidence, note: 'Compared with the recorded assignments.' });
  const facts = { schemaVersion: 1, method: 'agent_assisted', status: 'provisional', humanApproval: 'pending',
    reviewResultSha256: digest(resultBytes), reviews: [
      { caseId: 'G', findingId: 'g', responseTextSha256: digest(gText), examinedFields: ['ruleClaim', 'rationale', 'assumptions', 'missingEvidence'],
        claims: [makeClaim('g1', 'value-used', 'The source result is passed to select.', 'correct'),
          makeClaim('g2', 'value-used', 'The source result is used.', 'correct')],
        anchors: [{ id: 'source_to_sink', claimIds: ['g1', 'g2'] }] },
      { caseId: 'H', findingId: 'h', responseTextSha256: digest(hText), examinedFields: ['ruleClaim', 'rationale', 'assumptions', 'missingEvidence'],
        claims: [makeClaim('h1', 'value-discarded', 'The source result is discarded.', 'incorrect'),
          { ...makeClaim('h2', 'main-missing', 'Main was not supplied.', 'unsupported'), category: 'evidence_or_policy' }],
        anchors: [{ id: 'state_or_values', claimIds: ['h1'] }] },
    ] };
  const factPath = path.join(directory, 'fact-review.json');
  const saveFacts = () => writeFile(factPath, JSON.stringify(facts));
  await saveFacts();
  return { resultPath, resultBytes, sourcePath, requestPath, factPath, facts, saveFacts };
}

test('fact scoring deduplicates claims, keeps failures in denominator, and separates classification from explanation errors', async t => {
  const f = await fixture(t);
  const result = await scoreHeldoutFacts(f.resultPath, f.factPath);
  assert.deepEqual(result.classification, { sentinel: 'preserved classification metrics' });
  assert.equal(result.facts.claims, 3);
  assert.equal(result.facts.correct, 1);
  assert.equal(result.facts.incorrect, 1);
  assert.equal(result.facts.unsupported, 1);
  assert.deepEqual(result.facts.atomicAccuracy, { numerator: 1, denominator: 3, rate: 1 / 3 });
  assert.deepEqual(result.facts.decidedAccuracy, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.equal(result.facts.allFactsSupportedRate.numerator, 1);
  assert.equal(result.facts.allFactsSupportedRate.denominator, 3);
  assert.equal(result.facts.fullSupportedExplanationRate.numerator, 0);
  assert.equal(result.facts.categories.line_or_location.atomicAccuracy.rate, null);
  assert.deepEqual(result.facts.classificationCorrectExplanationWrong, ['H/h']);
  assert.deepEqual(result.facts.unreviewedFindings, ['I/i']);
  assert.equal(result.facts.anchorsSupported.numerator, 1);
  assert.equal(result.facts.anchorsSupported.denominator, 6);
  assert.equal(await readFile(f.resultPath, 'utf8'), f.resultBytes);
});

test('fact scoring rejects mismatched responses, invented quotations and out-of-range evidence locations', async t => {
  const f = await fixture(t);
  const review = f.facts.reviews[0];
  const originalHash = review.responseTextSha256;
  review.responseTextSha256 = 'wrong'; await f.saveFacts();
  await assert.rejects(scoreHeldoutFacts(f.resultPath, f.factPath), /response changed/);
  review.responseTextSha256 = originalHash;
  const originalQuote = review.claims[0].quote;
  review.claims[0].quote = 'The model never said this.'; await f.saveFacts();
  await assert.rejects(scoreHeldoutFacts(f.resultPath, f.factPath), /Quotation/);
  review.claims[0].quote = originalQuote;
  review.claims[0].evidence[0].endLine = 999; await f.saveFacts();
  await assert.rejects(scoreHeldoutFacts(f.resultPath, f.factPath), /line range/);
});

test('fact scoring rejects changed evidence, conflicting duplicate judgments and unplanned anchors', async t => {
  const f = await fixture(t);
  const source = await readFile(f.sourcePath, 'utf8');
  await writeFile(f.sourcePath, source + '// changed\n');
  await assert.rejects(scoreHeldoutFacts(f.resultPath, f.factPath), /evidence changed/);
  await writeFile(f.sourcePath, source);
  f.facts.reviews[0].claims[1].verdict = 'incorrect'; await f.saveFacts();
  await assert.rejects(scoreHeldoutFacts(f.resultPath, f.factPath), /Conflicting duplicate/);
  f.facts.reviews[0].claims[1].verdict = 'correct';
  f.facts.reviews[0].anchors[0].id = 'after-the-fact-anchor'; await f.saveFacts();
  await assert.rejects(scoreHeldoutFacts(f.resultPath, f.factPath), /Unknown anchor/);
});
