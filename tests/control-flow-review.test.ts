import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bindControlFlow, checkControlFlowPaths, parsePathSuggestion, renderControlFlowReport,
  type MethodControlFlow, type PathSuggestion } from '../src/control-flow-review.ts';
import { buildSourceCatalog } from '../src/review-citations.ts';

const sourceFile = 'src/main/java/Example.java';
const sinkMethod = '<java.sql.Statement: java.sql.ResultSet executeQuery(java.lang.String)>';
const source = [
  'if (mode < 0) {', '  slots[0] = value;', '  slots[1] = "fixed";', '} else {',
  '  slots[1] = "fixed";', '  slots[0] = value;', '}', 'return statement.executeQuery(slots[1]);',
].join('\n') + '\n';
const catalog = buildSourceCatalog([{ relativePath: sourceFile, content: source,
  sha256: createHash('sha256').update(source).digest('hex') }], 4);
const method: MethodControlFlow = {
  schemaVersion: 1, method: '<Example: java.sql.ResultSet execute(int)>', className: 'Example',
  entryId: 'entry', exitId: 'exit', scope: 'normal_intraprocedural', exceptionEdgesIncluded: false, pathFeasibility: 'not_checked',
  nodes: [
    { id: 'entry', kind: 'Entry', text: 'ENTRY' },
    { id: 'branch', kind: 'If', text: 'if mode < 0', condition: 'mode < 0', line: 1 },
    { id: 'negative0', kind: 'StoreArray', text: 'slots[0] = value', line: 2 },
    { id: 'negative1', kind: 'StoreArray', text: 'slots[1] = "fixed"', line: 3 },
    { id: 'other1', kind: 'StoreArray', text: 'slots[1] = "fixed"', line: 5 },
    { id: 'other0', kind: 'StoreArray', text: 'slots[0] = value', line: 6 },
    { id: 'sink', kind: 'Invoke', text: 'result = statement.executeQuery(slots[1])', line: 8, invokeMethod: sinkMethod },
    { id: 'return', kind: 'Return', text: 'return result', line: 8 },
    { id: 'exit', kind: 'Exit', text: 'EXIT' },
  ],
  edges: [
    { source: 'entry', target: 'branch', kind: 'ENTRY' },
    { source: 'branch', target: 'negative0', kind: 'IF_TRUE' },
    { source: 'branch', target: 'other1', kind: 'IF_FALSE' },
    { source: 'negative0', target: 'negative1', kind: 'FALL_THROUGH' },
    { source: 'negative1', target: 'sink', kind: 'GOTO' },
    { source: 'other1', target: 'other0', kind: 'FALL_THROUGH' },
    { source: 'other0', target: 'sink', kind: 'FALL_THROUGH' },
    { source: 'sink', target: 'return', kind: 'FALL_THROUGH' },
    { source: 'return', target: 'exit', kind: 'RETURN' },
  ],
};
const negative = ['entry', 'branch', 'negative0', 'negative1', 'sink', 'return', 'exit'];
const other = ['entry', 'branch', 'other1', 'other0', 'sink', 'return', 'exit'];
const graph = () => bindControlFlow(method, catalog, sourceFile, sinkMethod);
const suggestion = (graphId: string): PathSuggestion => ({
  findingId: 'finding-J', graphId, assessment: 'suspected_false_positive', ruleClaim: '源值可能流入 SQL 参数。',
  paths: [{ nodeIds: negative }, { nodeIds: other }], evidenceRefs: ['finding', 'context'],
  coverage: 'whole_finding', assumptions: [], missingEvidence: [],
});

test('both complete branch sequences connect through the sink with their actual branch edges', () => {
  const evidence = graph();
  const checked = checkControlFlowPaths(evidence.graphId, [{ nodeIds: negative }, { nodeIds: other }], evidence, true);
  assert.equal(checked.status, 'connected');
  assert.deepEqual(checked.paths.map(item => item.errors), [[], []]);
  assert.equal(checked.paths[0].edges[1].kind, 'IF_TRUE');
  assert.equal(checked.paths[1].edges[1].kind, 'IF_FALSE');
  assert.deepEqual(evidence.nodes.find(node => node.id === 'negative0')!.sourceIds, [catalog.snippets[0].id]);
  assert.deepEqual(evidence.nodes.find(node => node.id === 'other0')!.sourceIds, [catalog.snippets[1].id]);
});

test('reversed writes, cross-branch splices and skipped intermediate statements fail adjacency checks', () => {
  const evidence = graph();
  const wrong = [
    { nodeIds: ['entry', 'branch', 'negative1', 'negative0', 'sink', 'return', 'exit'], broken: 'negative1->negative0' },
    { nodeIds: ['entry', 'branch', 'negative0', 'other0', 'sink', 'return', 'exit'], broken: 'negative0->other0' },
    { nodeIds: ['entry', 'branch', 'negative0', 'negative1', 'sink', 'exit'], broken: 'sink->exit' },
  ];
  for (const item of wrong) {
    const checked = checkControlFlowPaths(evidence.graphId, [item], evidence, true);
    assert.equal(checked.status, 'invalid');
    assert.ok(checked.paths[0].errors.includes(`missing_edge:${item.broken}`));
  }
});

test('unknown IDs, incomplete routes and another graph version cannot pass; stale inputs take priority', () => {
  const evidence = graph();
  const cases = [
    { nodeIds: [...negative.slice(0, -1), 'invented', 'exit'], error: 'unknown_node:invented' },
    { nodeIds: negative.slice(1), error: 'missing_entry' },
    { nodeIds: negative.slice(0, -1), error: 'missing_exit' },
    { nodeIds: negative.filter(id => id !== 'sink'), error: 'missing_sink' },
  ];
  for (const item of cases) {
    const checked = checkControlFlowPaths(evidence.graphId, [item], evidence, true);
    assert.equal(checked.status, 'invalid');
    assert.ok(checked.paths[0].errors.includes(item.error));
  }
  const changedMethod = structuredClone(method);
  changedMethod.nodes.find(node => node.id === 'branch')!.condition = 'mode <= 0';
  const changedGraph = bindControlFlow(changedMethod, catalog, sourceFile, sinkMethod);
  const wrongVersion = checkControlFlowPaths(evidence.graphId, [{ nodeIds: negative }], changedGraph, true);
  assert.equal(wrongVersion.status, 'invalid');
  assert.ok(wrongVersion.paths[0].errors.includes('graph_id_mismatch'));
  assert.equal(checkControlFlowPaths(evidence.graphId, [{ nodeIds: negative }], evidence, false).status, 'stale');
  assert.equal(checkControlFlowPaths('wrong-version', [{ nodeIds: ['unknown'] }], evidence, false).status, 'stale');
});

test('connected graphs with contradictory guards do not acquire feasibility, value or coverage proof', () => {
  const contradictory = structuredClone(method);
  contradictory.nodes.push({ id: 'contradiction', kind: 'If', text: 'if mode >= 0', condition: 'mode >= 0', line: 2 });
  contradictory.edges = contradictory.edges.filter(edge => !(edge.source === 'branch' && edge.target === 'negative0'));
  contradictory.edges.push(
    { source: 'branch', target: 'contradiction', kind: 'IF_TRUE' },
    { source: 'contradiction', target: 'negative0', kind: 'IF_TRUE' },
    { source: 'contradiction', target: 'sink', kind: 'IF_FALSE' },
  );
  const evidence = bindControlFlow(contradictory, catalog, sourceFile, sinkMethod);
  const route = ['entry', 'branch', 'contradiction', 'negative0', 'negative1', 'sink', 'return', 'exit'];
  const checked = checkControlFlowPaths(evidence.graphId, [{ nodeIds: route }], evidence, true);
  assert.equal(checked.status, 'connected');
  assert.equal(checked.pathFeasibility, 'not_checked');
  assert.equal(checked.valueFlow, 'not_checked');
  assert.equal(checked.allPathsCovered, 'not_checked');
});

test('the model submits only node IDs while the host renders statements, edges and source locations', () => {
  const evidence = graph();
  const raw = suggestion(evidence.graphId);
  const parsed = parsePathSuggestion(JSON.stringify(raw), raw.findingId);
  const checked = checkControlFlowPaths(parsed.suggestion.graphId, parsed.suggestion.paths, evidence, true);
  const report = renderControlFlowReport({ status: 'completed', graph: evidence, catalog, suggestion: parsed.suggestion, check: checked });
  assert.match(report, /IF_TRUE/);
  assert.match(report, /IF_FALSE/);
  assert.ok(report.includes('slots[0] = value'));
  assert.ok(report.includes('src/main/java/Example.java · 第 1–4 行'));
  assert.ok(report.includes(catalog.snippets[0].id));
  assert.ok(report.includes('    ' + catalog.snippets[0].code.split('\n').join('\n    ')));
  assert.match(report, /分支条件可满足性、值传播和全部路径覆盖未检查/);
  for (const extra of [{ text: 'Model-authored execution order' }, { line: 999 }]) {
    assert.throws(() => parsePathSuggestion(JSON.stringify({ ...raw, paths: [{ nodeIds: negative, ...extra }] }), raw.findingId), /only a nonempty nodeIds array/);
  }
});

test('path response parsing retains the existing false-positive scope downgrade', () => {
  const raw = { ...suggestion(graph().graphId), coverage: 'single_path' };
  const parsed = parsePathSuggestion(JSON.stringify(raw), raw.findingId);
  assert.equal(parsed.suggestion.assessment, 'unknown');
  assert.equal(parsed.diagnostics.length, 1);
  assert.deepEqual(parsed.suggestion.paths, raw.paths);
});
