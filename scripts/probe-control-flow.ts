import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJavaExecutables } from '../src/taie.ts';
import { runProcess } from '../src/process.ts';
import { bindControlFlow, checkControlFlowPaths, type ControlFlowEvidence, type MethodControlFlow } from '../src/control-flow-review.ts';
import { digest, loadFrozenProtocol, root, type HeldoutProbe } from './probe-sql-heldout.ts';
import { buildHeldoutReviewInput, loadDatasetLock } from './review-sql-heldout.ts';
import { prepareCitationInput } from './review-sql-citations.ts';

/** Case J is an acyclic fixture with two normal branches; this is a fixture check, not a general path enumerator. */
export function checkCaseJSequences(graph: ControlFlowEvidence) {
  const paths: string[][] = [];
  const visit = (sequence: string[]) => {
    const last = sequence.at(-1)!;
    if (last === graph.exitId) { paths.push(sequence); return; }
    for (const next of new Set(graph.edges.filter(edge => edge.source === last).map(edge => edge.target))) {
      assert.ok(!sequence.includes(next), 'Case J fixture unexpectedly contains a cycle.');
      visit([...sequence, next]);
    }
  };
  visit([graph.entryId]);
  assert.equal(paths.length, 2, 'Expected exactly two normal Case J paths.');
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const stores = (sequence: string[]) => sequence.filter(id => byId.get(id)?.kind === 'StoreArray');
  const storeLines = (sequence: string[]) => stores(sequence).map(id => byId.get(id)!.line);
  const negative = paths.find(sequence => storeLines(sequence).join(',') === '14,15');
  const nonnegative = paths.find(sequence => storeLines(sequence).join(',') === '17,18');
  assert.ok(negative && nonnegative, 'Actual CFG write order differs from independently inspected CaseJ.java.');
  const reversed = [...negative];
  const [first, second] = stores(negative).map(id => reversed.indexOf(id));
  [reversed[first], reversed[second]] = [reversed[second], reversed[first]];
  const spliced = [...negative];
  spliced[second] = stores(nonnegative)[0];
  const cases = [
    { name: 'negative_branch', sequence: negative, expected: 'connected' },
    { name: 'nonnegative_branch', sequence: nonnegative, expected: 'connected' },
    { name: 'reversed_writes', sequence: reversed, expected: 'invalid' },
    { name: 'cross_branch_splice', sequence: spliced, expected: 'invalid' },
  ].map(item => ({ ...item, check: checkControlFlowPaths(graph.graphId, [{ nodeIds: item.sequence }], graph, true) }));
  for (const item of cases) assert.equal(item.check.status, item.expected, item.name);
  return { status: 'passed', cases, scope: 'Case J normal-flow structure only; no feasibility or taint proof.' };
}

export async function probeControlFlow(probePath: string) {
  const frozen = await loadFrozenProtocol(); const locked = await loadDatasetLock();
  const probeBytes = await readFile(probePath);
  const probe = JSON.parse(probeBytes.toString('utf8')) as HeldoutProbe;
  assert.equal(probe.protocolSha256, frozen.sha256);
  const findings = probe.check.findings.filter(f => f.className === 'example.CaseJ' && f.type === 'TAINT_FLOW');
  assert.equal(findings.length, 1, 'Expected one recorded Case J finding.');
  const finding = findings[0];
  const input = await buildHeldoutReviewInput(probePath, 'J', finding.id);
  const prepared = prepareCitationInput(input);
  const sourceFile = 'src/main/java/example/CaseJ.java';
  const rawContext = JSON.parse(input.prompt).evidence.find((item: { id: string }) => item.id === 'context').data;
  const source = rawContext.sourceFiles.find((item: { relativePath: string }) => item.relativePath === sourceFile);
  assert.ok(source && digest(source.content) === source.sha256);
  const backend = JSON.parse(await readFile(probe.check.backendReportPath, 'utf8'));
  const jarPath = backend.analysis.taiE.jarPath as string;
  assert.equal(digest(await readFile(jarPath)), backend.analysis.taiE.sha256);
  const method = finding.method!;
  const sinkMethod = (finding.evidence!.sink as { configuredMethod: string }).configuredMethod;
  const runDir = path.join(root, '.taie-agent/control-flow', `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const started = Date.now();
  await mkdir(path.join(runDir, 'source/example'), { recursive: true });
  const sourcePath = path.join(runDir, 'source/example/CaseJ.java');
  await writeFile(sourcePath, source.content);
  const classes = path.join(runDir, 'classes'), adapter = path.join(runDir, 'adapter');
  await mkdir(classes); await mkdir(adapter);
  console.log(`[control-flow] Evidence: ${runDir}`);
  const exporterPath = path.join(root, 'java-adapter/AgentControlFlowExporter.java');
  const inputs = { ...input.manifest.originalHashes, [jarPath]: backend.analysis.taiE.sha256,
    [exporterPath]: digest(await readFile(exporterPath)),
    [path.join(root, 'src/control-flow-review.ts')]: digest(await readFile(path.join(root, 'src/control-flow-review.ts'))),
    [path.join(root, 'scripts/probe-control-flow.ts')]: digest(await readFile(path.join(root, 'scripts/probe-control-flow.ts'))) };
  const java = getJavaExecutables();
  const result: Record<string, unknown> = { schemaVersion: 1, status: 'running', runDir, probePath: path.resolve(probePath),
    findingId: finding.id, caseId: 'J', method, modelRequests: 0, affectsCheckStatus: false,
    sourceFile, sourceSha256: source.sha256, inputHashes: inputs, java,
    compilation: 'fresh supplemental bytecode from the hash-matched analyzed source; not the historical class file' };
  const save = () => writeFile(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  await save();
  try {
    const run = async (name: string, command: string, args: string[]) => {
      console.log(`[control-flow] ${name}`);
      const execution = await runProcess(command, args, runDir, path.join(runDir, name), Date.now() + 180_000);
      assert.equal(execution.code, 0, `${name}: ${execution.tail}`);
    };
    await run('java-version', java.java, ['-version']);
    await run('compile-source', java.javac, ['-encoding', 'UTF-8', '-g', '-proc:none', '--release', '17', '-d', classes, sourcePath]);
    await run('compile-exporter', java.javac, ['-encoding', 'UTF-8', '-proc:none', '--release', '17', '-cp', jarPath, '-d', adapter, exporterPath]);
    await run('export-cfg', java.java, ['-Xmx1g', '-Dfile.encoding=UTF-8', '-cp', [adapter, jarPath].join(path.delimiter),
      'AgentControlFlowExporter', path.join(runDir, 'cfg.raw.json'), method,
      '-acp', classes, '--input-classes', 'example.CaseJ', '-scope', 'APP', '--output-dir', path.join(runDir, 'tai-e-output')]);
    const raw = JSON.parse(await readFile(path.join(runDir, 'cfg.raw.json'), 'utf8')) as MethodControlFlow;
    assert.equal(raw.method, method);
    const graph = bindControlFlow(raw, prepared.catalog, sourceFile, sinkMethod);
    const validation = checkCaseJSequences(graph);
    for (const [name, value] of [['cfg.json', graph], ['catalog.json', prepared.catalog], ['evidence.json', prepared], ['sequence-tests.json', validation]] as const)
      await writeFile(path.join(runDir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    assert.equal(digest(await readFile(sourcePath)), source.sha256, 'Supplemental compilation source changed.');
    result.artifactHashes = Object.fromEntries(await Promise.all(['cfg.raw.json', 'cfg.json', 'catalog.json', 'evidence.json', 'sequence-tests.json', 'source/example/CaseJ.java', 'classes/example/CaseJ.class']
      .map(async name => [name, digest(await readFile(path.join(runDir, name)))])));
    result.graphId = graph.graphId; result.nodes = graph.nodes.length; result.edges = graph.edges.length;
    result.sequenceTests = validation; result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = error instanceof Error ? error.message : String(error); }
  try {
    await frozen.verify(); await locked.verify();
    for (const [file, hash] of Object.entries(inputs)) assert.equal(digest(await readFile(file)), hash, `Input changed: ${file}`);
    assert.ok(await input.verifyUnchanged()); result.originalsUnchanged = true;
  } catch (error) { result.status = 'stale'; result.originalsUnchanged = false; result.error = String(error); }
  result.durationMs = Date.now() - started;
  await save();
  console.log(JSON.stringify({ status: result.status, resultPath: path.join(runDir, 'result.json'), error: result.error }));
  return path.join(runDir, 'result.json');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/probe-control-flow.ts <heldout-probe-result.json>');
  probeControlFlow(path.resolve(process.argv[2])).then(async file => {
    if (JSON.parse(await readFile(file, 'utf8')).status !== 'passed') process.exitCode = 1;
  }).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
