import { createHash } from 'node:crypto';
import { parseReviewSuggestion, type ReviewSuggestion } from './review.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export interface CitationSource { relativePath: string; sha256: string; content: string }
export interface SourceSnippet {
  id: string;
  file: string;
  sourceSha256: string;
  startLine: number;
  endLine: number;
  code: string;
}
export interface SourceCatalog {
  schemaVersion: 1;
  sha256: string;
  linesPerSnippet: number;
  snippets: SourceSnippet[];
}
export interface CitedClaim { text: string; sourceIds: string[] }
export interface CitationSuggestion extends Omit<ReviewSuggestion, 'rationale'> { claims: CitedClaim[] }
export interface CitationCheck {
  status: 'matched' | 'invalid' | 'missing' | 'stale';
  referencedIds: string[];
  unknownIds: string[];
  uncitedClaims: number[];
  resolved: SourceSnippet[];
  semantics: 'not_checked';
}

/** Only host-supplied, hash-matched source is catalogued. No model-authored path is opened. */
export function buildSourceCatalog(sources: readonly CitationSource[], linesPerSnippet = 8): SourceCatalog {
  if (!Number.isSafeInteger(linesPerSnippet) || linesPerSnippet < 1) throw new Error('Snippet size must be a positive integer.');
  if (!sources.length) throw new Error('No recorded source files supplied.');
  const ordered = [...sources].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  if (new Set(ordered.map(source => source.relativePath)).size !== ordered.length) throw new Error('Duplicate source file in catalog.');
  for (const source of ordered) {
    if (digest(source.content) !== source.sha256) throw new Error(`Source content differs from recorded hash: ${source.relativePath}`);
  }
  const sha256 = digest(JSON.stringify({ linesPerSnippet, sources: ordered.map(({ relativePath, sha256 }) => ({ relativePath, sha256 })) }));
  const snippets: SourceSnippet[] = [];
  for (const source of ordered) {
    // Normalize line separators only; preserve indentation and string contents.
    const lines = source.content.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (let start = 0; start < lines.length; start += linesPerSnippet) {
      const end = Math.min(start + linesPerSnippet, lines.length);
      snippets.push({ id: `src:${sha256.slice(0, 16)}:${snippets.length + 1}`, file: source.relativePath,
        sourceSha256: source.sha256, startLine: start + 1, endLine: end, code: lines.slice(start, end).join('\n') });
    }
  }
  return { schemaVersion: 1, sha256, linesPerSnippet, snippets };
}

/** Experimental response contract: the host owns locations/quotes; the model selects snippet IDs. */
export function parseCitationSuggestion(text: string, findingId: string) {
  if (text.length > 32_000) throw new Error('Citation response exceeds 32000 characters.');
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const value: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Citation response must be an object.');
  const raw = value as Record<string, unknown>;
  const keys = ['findingId', 'assessment', 'ruleClaim', 'claims', 'evidenceRefs', 'coverage', 'assumptions', 'missingEvidence'];
  if (Object.keys(raw).some(key => !keys.includes(key)) || keys.some(key => !(key in raw)))
    throw new Error('Citation response has missing or unsupported fields.');
  if (!Array.isArray(raw.claims) || !raw.claims.length) throw new Error('Citation claims must be a nonempty array.');
  for (const claim of raw.claims) {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)
        || Object.keys(claim).length !== 2 || typeof claim.text !== 'string' || !claim.text.trim()
        || !Array.isArray(claim.sourceIds) || claim.sourceIds.some((id: unknown) => typeof id !== 'string' || !id.trim()))
      throw new Error('Each claim must contain only text and sourceIds.');
  }
  const claims = raw.claims as CitedClaim[];
  const { claims: _claims, ...fields } = raw;
  const parsed = parseReviewSuggestion(JSON.stringify({ ...fields, rationale: claims.map(claim => claim.text).join('\n') }), findingId);
  const { rationale: _rationale, ...suggestion } = parsed.suggestion;
  return { suggestion: { ...suggestion, claims } as CitationSuggestion, diagnostics: parsed.diagnostics };
}

/** Resolve against this request's catalog, never fuzzy-match an unknown ID. */
export function checkSourceCitations(claims: readonly CitedClaim[], catalog: SourceCatalog, snapshotUnchanged: boolean): CitationCheck {
  const byId = new Map(catalog.snippets.map(snippet => [snippet.id, snippet]));
  const referencedIds = [...new Set(claims.flatMap(claim => claim.sourceIds))];
  const unknownIds = referencedIds.filter(id => !byId.has(id));
  const uncitedClaims = claims.flatMap((claim, index) => claim.sourceIds.length ? [] : [index + 1]);
  const status = !snapshotUnchanged ? 'stale' : unknownIds.length ? 'invalid' : !referencedIds.length ? 'missing' : 'matched';
  return { status, referencedIds, unknownIds, uncitedClaims,
    resolved: referencedIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []), semantics: 'not_checked' };
}

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const block = (text: string) => escape(text).replace(/\r\n/g, '\n').split('\n').map(line => `> ${line}`).join('\n');

export function renderCitationReport(options: {
  findingId: string;
  status: 'completed' | 'failed' | 'stale';
  suggestion?: CitationSuggestion;
  citations?: CitationCheck;
  catalog?: SourceCatalog;
  error?: string;
}): string {
  const { suggestion, citations, catalog } = options;
  const labels = { matched: '已提交的编号均匹配', invalid: '含无效编号', missing: '没有源码引用', stale: '输入已变化，引用校验失效' };
  const lines = ['# 源码引用复核报告', '', `执行状态：${options.status}；告警：${escape(options.findingId)}`, '',
    `引用校验：${citations ? labels[citations.status] : '未完成'}。语义判断：未校验。`, '',
    '此报告解析模型选择的片段编号；文件、行范围和代码由宿主填写。原检查状态与告警处置保持不变。', ''];
  if (catalog) lines.push(`证据目录 SHA-256：${catalog.sha256}`, '');
  if (suggestion) {
    lines.push(`模型建议：${suggestion.assessment}`, '', '## 规则主张', '', block(suggestion.ruleClaim), '', '## 逐项解释与引用', '');
    const resolved = new Map(citations?.resolved.map(snippet => [snippet.id, snippet]) ?? []);
    suggestion.claims.forEach((claim, index) => {
      lines.push(`### 解释 ${index + 1}`, '', block(claim.text), '');
      if (!claim.sourceIds.length) lines.push('未引用源码片段；本项未获得源码引用匹配结果。', '');
      for (const id of new Set(claim.sourceIds)) {
        const snippet = resolved.get(id);
        if (!snippet) { lines.push(`无法解析编号：${escape(id)}`, ''); continue; }
        lines.push(`**${escape(snippet.file)} · 第 ${snippet.startLine}–${snippet.endLine} 行**`, '',
          `片段编号：${snippet.id}；源文件 SHA-256：${snippet.sourceSha256}`, '',
          '    ' + snippet.code.split('\n').join('\n    '), '');
      }
    });
    lines.push('## 适用前提', '', block(suggestion.assumptions.join('\n') || '未列出'), '',
      '## 缺失证据', '', block(suggestion.missingEvidence.join('\n') || '未列出'), '');
  }
  if (citations?.uncitedClaims.length) lines.push(`没有源码引用的解释项：${citations.uncitedClaims.join('、')}。`, '');
  if (options.error) lines.push('## 执行错误', '', block(options.error), '');
  lines.push('模型解释正文的真实性、引用与结论之间的支持关系，以及未引用部分，均不由引用匹配结果证明。', '');
  return lines.join('\n');
}
