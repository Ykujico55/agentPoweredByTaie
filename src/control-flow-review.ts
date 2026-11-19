import { createHash } from 'node:crypto';
import { parseReviewSuggestion, type ReviewSuggestion } from './review.ts';
import type { SourceCatalog } from './review-citations.ts';

export interface ControlFlowNode {
  id: string; kind: string; text: string; statementIndex?: number; line?: number;
  condition?: string; invokeMethod?: string;
}
export interface ControlFlowEdge { source: string; target: string; kind: string; caseValue?: number }
export interface MethodControlFlow {
  schemaVersion: 1; method: string; className: string; entryId: string; exitId: string;
  nodes: ControlFlowNode[]; edges: ControlFlowEdge[];
  scope: 'normal_intraprocedural'; exceptionEdgesIncluded: false; pathFeasibility: 'not_checked';
}
export interface ControlFlowEvidence extends MethodControlFlow {
  graphId: string; sourceFile: string; sourceCatalogSha256: string; requiredNodeId: string;
  nodes: (ControlFlowNode & { sourceIds: string[] })[];
}
export interface SubmittedPath { nodeIds: string[] }
export interface PathSuggestion extends Omit<ReviewSuggestion, 'rationale'> { graphId: string; paths: SubmittedPath[] }
export interface PathCheck {
  status: 'connected' | 'invalid' | 'stale';
  paths: { index: number; status: 'connected' | 'invalid'; errors: string[]; edges: ControlFlowEdge[] }[];
  pathFeasibility: 'not_checked'; valueFlow: 'not_checked'; allPathsCovered: 'not_checked';
}

/** Bind genuine CFG nodes to the same source catalog; source lines do not determine edges. */
export function bindControlFlow(graph: MethodControlFlow, catalog: SourceCatalog, sourceFile: string, sinkMethod: string): ControlFlowEvidence {
  if (graph.schemaVersion !== 1 || graph.scope !== 'normal_intraprocedural' || graph.exceptionEdgesIncluded !== false)
    throw new Error('Expected a normal intraprocedural CFG.');
  const ids = new Set(graph.nodes.map(node => node.id));
  if (ids.size !== graph.nodes.length || !ids.has(graph.entryId) || !ids.has(graph.exitId)
      || graph.edges.some(edge => !ids.has(edge.source) || !ids.has(edge.target))) throw new Error('CFG has invalid node or edge references.');
  const snippets = catalog.snippets.filter(snippet => snippet.file === sourceFile);
  if (!snippets.length) throw new Error('CFG source file is absent from the source catalog.');
  const sinks = graph.nodes.filter(node => node.invokeMethod === sinkMethod);
  if (sinks.length !== 1) throw new Error('This single-sink experiment requires exactly one matching invoke node.');
  const binding = { graph, sourceCatalogSha256: catalog.sha256, sourceFile, requiredNodeId: sinks[0].id };
  const graphId = 'cfg:' + createHash('sha256').update(JSON.stringify(binding)).digest('hex').slice(0, 16);
  return { ...graph, graphId, sourceCatalogSha256: catalog.sha256, sourceFile, requiredNodeId: sinks[0].id,
    nodes: graph.nodes.map(node => ({ ...node, sourceIds: node.line === undefined ? [] : snippets
      .filter(snippet => node.line! >= snippet.startLine && node.line! <= snippet.endLine).map(snippet => snippet.id) })) };
}

export function parsePathSuggestion(text: string, findingId: string) {
  if (text.length > 32_000) throw new Error('Path response exceeds 32000 characters.');
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const raw = JSON.parse(fenced ? fenced[1] : trimmed) as Record<string, unknown>;
  const keys = ['findingId', 'graphId', 'assessment', 'ruleClaim', 'paths', 'evidenceRefs', 'coverage', 'assumptions', 'missingEvidence'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))
      || keys.some(key => !(key in raw))) throw new Error('Path response has missing or unsupported fields.');
  if (typeof raw.graphId !== 'string' || !raw.graphId.trim()) throw new Error('Missing graph ID.');
  if (!Array.isArray(raw.paths) || !raw.paths.length) throw new Error('Paths must be a nonempty array.');
  for (const item of raw.paths) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 1
        || !Array.isArray(item.nodeIds) || !item.nodeIds.length
        || item.nodeIds.some((id: unknown) => typeof id !== 'string' || !id.trim()))
      throw new Error('Each path must contain only a nonempty nodeIds array.');
  }
  const { graphId, paths, ...fields } = raw;
  const parsed = parseReviewSuggestion(JSON.stringify({ ...fields, rationale: (paths as SubmittedPath[]).map(item => item.nodeIds.join(' -> ')).join('\n') }), findingId);
  const { rationale: _rationale, ...suggestion } = parsed.suggestion;
  return { suggestion: { ...suggestion, graphId, paths } as PathSuggestion, diagnostics: parsed.diagnostics };
}

/** Require complete, adjacent entry-to-exit sequences through the selected sink. No reachability shortcuts. */
export function checkControlFlowPaths(submittedGraphId: string, submitted: readonly SubmittedPath[], graph: ControlFlowEvidence, unchanged: boolean): PathCheck {
  const nodes = new Set(graph.nodes.map(node => node.id));
  const paths = submitted.map((item, index) => {
    const errors: string[] = [];
    const edges: ControlFlowEdge[] = [];
    if (submittedGraphId !== graph.graphId) errors.push('graph_id_mismatch');
    if (item.nodeIds[0] !== graph.entryId) errors.push('missing_entry');
    if (item.nodeIds.at(-1) !== graph.exitId) errors.push('missing_exit');
    if (!item.nodeIds.includes(graph.requiredNodeId)) errors.push('missing_sink');
    for (const id of new Set(item.nodeIds)) if (!nodes.has(id)) errors.push(`unknown_node:${id}`);
    for (let step = 1; step < item.nodeIds.length; step++) {
      const source = item.nodeIds[step - 1], target = item.nodeIds[step];
      const actual = graph.edges.filter(edge => edge.source === source && edge.target === target);
      if (!actual.length) errors.push(`missing_edge:${source}->${target}`);
      else edges.push(...actual);
    }
    return { index: index + 1, status: errors.length ? 'invalid' as const : 'connected' as const, errors, edges };
  });
  return { status: !unchanged ? 'stale' : paths.length && paths.every(item => item.status === 'connected') ? 'connected' : 'invalid',
    paths, pathFeasibility: 'not_checked', valueFlow: 'not_checked', allPathsCovered: 'not_checked' };
}

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;');
export function renderControlFlowReport(options: { status: string; graph?: ControlFlowEvidence; catalog?: SourceCatalog;
  suggestion?: PathSuggestion; check?: PathCheck; error?: string }): string {
  const { graph, catalog, suggestion, check } = options;
  const lines = ['# 单方法执行顺序复核', '', `执行状态：${options.status}；控制流连接：${check?.status ?? '未检查'}。`, '',
    '检查范围：普通控制流中的相邻语句连接、入口/出口和指定 sink。分支条件可满足性、值传播和全部路径覆盖未检查。', '',
    '报告中的语句、条件、边类型及源码引用来自 Tai-e 导出和宿主目录。模型建议不改变原告警。', ''];
  if (graph) lines.push(`方法：${escape(graph.method)}`, '', `图编号：${graph.graphId}；源码：${escape(graph.sourceFile)}`, '');
  if (suggestion && graph) {
    lines.push(`模型建议：${suggestion.assessment}`, '', `规则主张：${escape(suggestion.ruleClaim)}`, '');
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    suggestion.paths.forEach((submitted, index) => {
      const checked = check?.paths[index];
      lines.push(`## 路径 ${index + 1}：${checked?.status ?? '未检查'}`, '',
        '| 节点 | 语句 | 源码行 | 到下一节点的真实边 |', '| --- | --- | ---: | --- |');
      submitted.nodeIds.forEach((id, step) => {
        const node = nodes.get(id);
        const edges = graph.edges.filter(edge => edge.source === id && edge.target === submitted.nodeIds[step + 1]);
        lines.push(`| ${escape(id)} | ${escape(node?.text ?? '未知节点')} | ${node?.line ?? '—'} | ${edges.map(edge => edge.kind).join(', ') || '—'} |`);
      });
      lines.push('', `校验问题：${checked?.errors.map(escape).join('；') || '无'}。`, '');
    });
    const cited = new Set(suggestion.paths.flatMap(item => item.nodeIds.flatMap(id => nodes.get(id)?.sourceIds ?? [])));
    lines.push('## 对应源码', '');
    for (const snippet of catalog?.snippets.filter(item => cited.has(item.id)) ?? []) {
      lines.push(`**${escape(snippet.file)} · 第 ${snippet.startLine}–${snippet.endLine} 行**`, '',
        `片段编号：${snippet.id}`, '', '    ' + snippet.code.split('\n').join('\n    '), '');
    }
    lines.push('## 模型列出的前提与缺失证据', '',
      ...suggestion.assumptions.map(item => `- 前提：${escape(item)}`), ...suggestion.missingEvidence.map(item => `- 缺失：${escape(item)}`), '');
  }
  if (options.error) lines.push(`执行错误：${escape(options.error)}`, '');
  return lines.join('\n');
}
