import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildSourceCatalog, checkSourceCitations, parseCitationSuggestion, renderCitationReport,
  type CitationSource, type CitationSuggestion } from '../src/review-citations.ts';

const source = (content: string, relativePath = 'src/main/java/Example.java'): CitationSource => ({
  relativePath, content, sha256: createHash('sha256').update(content).digest('hex'),
});
const suggestion = (claims: CitationSuggestion['claims']): CitationSuggestion => ({
  findingId: 'finding-1', assessment: 'true_positive', ruleClaim: '输入可能到达 SQL 参数。',
  claims, evidenceRefs: ['finding', 'context'], coverage: 'whole_finding', assumptions: [], missingEvidence: [],
});

test('source catalog preserves real lines and whitespace while checking the original file hash', () => {
  const recorded = source('class Example {\r\n  String query = " a  b ";\r\n}\r\n\r\n');
  const catalog = buildSourceCatalog([recorded], 2);
  assert.deepEqual(catalog.snippets.map(({ startLine, endLine, code }) => ({ startLine, endLine, code })), [
    { startLine: 1, endLine: 2, code: 'class Example {\n  String query = " a  b ";' },
    { startLine: 3, endLine: 4, code: '}\n' },
  ]);
  assert.equal(catalog.snippets[0].sourceSha256, recorded.sha256);
  assert.equal(buildSourceCatalog([source('')]).snippets.length, 0);
  assert.equal(buildSourceCatalog([source('one line\r\n')]).snippets[0].endLine, 1);
  assert.throws(() => buildSourceCatalog([{ ...recorded, content: recorded.content.replace('a  b', 'a b') }]), /recorded hash/);
});

test('the host renders code and locations for selected IDs and rejects model-authored citation metadata', () => {
  const recorded = source('class Example {\n  query = value;\n  executeQuery(query);\n}\n');
  const catalog = buildSourceCatalog([recorded], 2);
  const id = catalog.snippets[1].id;
  const raw = suggestion([{ text: '查询参数直接传入执行方法。', sourceIds: [id] }]);
  const parsed = parseCitationSuggestion(JSON.stringify(raw), raw.findingId);
  const citations = checkSourceCitations(parsed.suggestion.claims, catalog, true);
  assert.equal(citations.status, 'matched');
  assert.deepEqual(citations.resolved, [catalog.snippets[1]]);
  const report = renderCitationReport({ findingId: raw.findingId, status: 'completed', suggestion: parsed.suggestion, citations, catalog });
  assert.match(report, /src\/main\/java\/Example\.java · 第 3–4 行/);
  assert.ok(report.includes('    ' + catalog.snippets[1].code.split('\n').join('\n    ')));
  assert.ok(report.includes(recorded.sha256));
  for (const extra of [{ file: 'Other.java' }, { quote: 'invented code' }, { line: 900 }]) {
    assert.throws(() => parseCitationSuggestion(JSON.stringify({ ...raw, claims: [{ ...raw.claims[0], ...extra }] }), raw.findingId),
      /only text and sourceIds/);
  }
});

test('unknown or old-version snippet IDs remain invalid instead of being guessed', () => {
  const catalog = buildSourceCatalog([source('query = value;\n')]);
  const changed = buildSourceCatalog([source('query = "fixed";\n')]);
  const oldId = catalog.snippets[0].id;
  const typo = oldId + '-typo';
  const unknown = checkSourceCitations([{ text: '引用有误。', sourceIds: [typo] }], catalog, true);
  assert.equal(unknown.status, 'invalid');
  assert.deepEqual(unknown.unknownIds, [typo]);
  assert.deepEqual(unknown.resolved, []);
  const staleId = checkSourceCitations([{ text: '引用了另一版源码。', sourceIds: [oldId] }], changed, true);
  assert.equal(staleId.status, 'invalid');
  assert.deepEqual(staleId.unknownIds, [oldId]);
  assert.deepEqual(staleId.resolved, []);
});

test('uncited claims are visible and a changed snapshot cannot receive a matched result', () => {
  const catalog = buildSourceCatalog([source('query = value;\n')]);
  const claims = [{ text: '源数据写入 query。', sourceIds: [catalog.snippets[0].id] },
    { text: '测试记录显示通过。', sourceIds: [] }];
  const mixed = checkSourceCitations(claims, catalog, true);
  assert.deepEqual(mixed.uncitedClaims, [2]);
  const report = renderCitationReport({ findingId: 'finding-1', status: 'completed', suggestion: suggestion(claims), citations: mixed, catalog });
  assert.match(report, /没有源码引用的解释项：2/);
  assert.match(report, /本项未获得源码引用匹配结果/);
  assert.equal(checkSourceCitations([claims[1]], catalog, true).status, 'missing');
  const stale = checkSourceCitations(claims, catalog, false);
  assert.equal(stale.status, 'stale');
  const staleReport = renderCitationReport({ findingId: 'finding-1', status: 'stale', suggestion: suggestion(claims), citations: stale, catalog });
  assert.match(staleReport, /输入已变化，引用校验失效/);
  assert.doesNotMatch(staleReport, /引用校验：已提交的编号均匹配/);
});

test('a valid citation does not certify a deliberately false interpretation', () => {
  const catalog = buildSourceCatalog([source('if (mode == 0) {\n  query = "fixed";\n}\n')]);
  const raw = suggestion([{ text: 'mode 为 0 时，该条件为假。', sourceIds: [catalog.snippets[0].id] }]);
  const parsed = parseCitationSuggestion(JSON.stringify(raw), raw.findingId);
  const citations = checkSourceCitations(parsed.suggestion.claims, catalog, true);
  assert.equal(citations.status, 'matched');
  assert.equal(citations.semantics, 'not_checked');
  const report = renderCitationReport({ findingId: raw.findingId, status: 'completed', suggestion: parsed.suggestion, citations, catalog });
  assert.match(report, /语义判断：未校验/);
  assert.match(report, /mode 为 0 时，该条件为假/);
});
