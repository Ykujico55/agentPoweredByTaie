import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject, type CheckResult } from '../src/check.ts';
import { loadProjectConfig } from '../src/config.ts';
import type { MavenCheckResult } from '../src/docker-maven.ts';
import { REVIEW_PROMPT_VERSION, REVIEW_SYSTEM_PROMPT } from '../src/review.ts';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const protocolPath = path.join(root, 'evaluations/sql-heldout-v1/protocol.json');
export interface HeldoutProtocol {
  id: string; promptVersion: string; systemPromptSha256: string; systemPromptFile: string;
  frozenFiles: Record<string, string>; provider: string; model: string;
  timeoutMs: number; maxRetries: number; maxTokens: number; caseIds: string[];
}
export interface HeldoutCase {
  id: string; className: string; truth: 'vulnerable' | 'safe_under_stated_assumptions'; basis: unknown;
  actualFindingCount: number; findingIds: string[]; reviewEligibility: 'eligible' | 'not_reported';
}
export interface HeldoutProbe {
  status: string; projectDir: string; protocolSha256: string; check: CheckResult; cases: HeldoutCase[];
  inputs: { sourceManifest: { relativePath: string; sha256: string }[]; policySha256: string; oracleSha256: string };
}

export async function loadFrozenProtocol(file = protocolPath, base = root) {
  const bytes = await readFile(file);
  const protocol = JSON.parse(bytes.toString('utf8')) as HeldoutProtocol;
  const systemPrompt = await readFile(path.join(base, protocol.systemPromptFile), 'utf8');
  assert.equal(protocol.promptVersion, REVIEW_PROMPT_VERSION, 'Frozen prompt version changed.');
  assert.equal(digest(systemPrompt), protocol.systemPromptSha256, 'Frozen prompt bytes changed.');
  assert.equal(systemPrompt, REVIEW_SYSTEM_PROMPT, 'Current prompt differs from frozen prompt.');
  assert.equal(protocol.maxRetries, 0);
  assert.equal(protocol.maxTokens, 4096);
  const verify = async () => {
    assert.equal(digest(await readFile(file)), digest(bytes), 'Frozen protocol changed.');
    assert.equal(digest(await readFile(path.join(base, protocol.systemPromptFile))), protocol.systemPromptSha256, 'Frozen prompt changed.');
    for (const [relativePath, sha256] of Object.entries(protocol.frozenFiles))
      assert.equal(digest(await readFile(path.join(base, relativePath))), sha256, `Frozen implementation changed: ${relativePath}`);
  };
  await verify();
  return { protocol, bytes, sha256: digest(bytes), systemPrompt, verify };
}

export async function runHeldoutProbe(dependencyNetwork = false) {
  const frozen = await loadFrozenProtocol();
  const runDir = path.join(root, '.taie-agent/sql-heldout', `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const projectDir = path.join(runDir, 'project');
  await mkdir(runDir, { recursive: true });
  await cp(path.join(root, 'tests/fixtures/sql-heldout'), projectDir, {
    recursive: true, filter: file => !['target', '.taie-agent'].includes(path.basename(file)),
  });
  const result: Record<string, unknown> = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(),
    projectDir, modelRequests: 0, protocolSha256: frozen.sha256, dependencyNetwork };
  const resultPath = path.join(runDir, 'result.json');
  const save = () => writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
  await writeFile(path.join(runDir, 'protocol.json'), frozen.bytes, { flag: 'wx' });
  await save();
  console.log(`[sql-heldout] Evidence: ${runDir}`);
  try {
    const check = await checkProject({ ...await loadProjectConfig(projectDir), projectDir, dependencyNetwork });
    result.check = check;
    await save();
    assert.equal(check.backend, 'maven-docker');
    assert.equal(check.stages.build, 'passed', check.diagnostics.join('\n'));
    assert.equal(check.stages.test.status, 'passed', check.diagnostics.join('\n'));
    assert.equal(check.stages.analysis, 'completed', check.diagnostics.join('\n'));
    assert.ok(['findings', 'passed'].includes(check.status), `Unusable check: ${check.status}`);
    const backend = JSON.parse(await readFile(check.backendReportPath, 'utf8')) as MavenCheckResult;
    assert.match(backend.maven?.versions.java ?? '', /^17\./);
    assert.ok(backend.maven?.metadata);
    const snapshot = path.join(backend.runDir, 'snapshot/project');
    const oracleBytes = await readFile(path.join(snapshot, 'oracle.json'));
    const labels = JSON.parse(oracleBytes.toString('utf8')).cases as HeldoutCase[];
    assert.deepEqual(labels.map(item => item.id).sort(), [...frozen.protocol.caseIds].sort(), 'Oracle must include every predeclared case.');
    const observationsPath = path.join(backend.maven.metadata.buildDirectory, 'sql-observations.json');
    const observationBytes = await readFile(observationsPath);
    const observations = JSON.parse(observationBytes.toString('utf8'));
    result.oracle = { reportPath: observationsPath, sha256: digest(observationBytes), ...observations };
    const sourceManifest = [];
    for (const file of backend.maven.metadata.sourceFiles) sourceManifest.push({
      relativePath: path.relative(backend.maven.metadata.sourceDirectory, file).replaceAll('\\', '/'),
      path: file, sha256: digest(await readFile(file)),
    });
    result.inputs = { imageId: backend.imageId, versions: backend.maven.versions, taiE: backend.analysis?.taiE,
      sourceManifest, policySha256: digest(await readFile(path.join(snapshot, 'taint.yml'))),
      oracleSha256: digest(oracleBytes), pomSha256: digest(await readFile(path.join(snapshot, 'pom.xml'))) };
    const cases = labels.map(candidate => {
      const findings = check.findings.filter(item => item.type === 'TAINT_FLOW' && item.className === candidate.className);
      const observed = observations.observations.filter((item: { caseId: string }) => item.caseId === candidate.id);
      assert.ok(observed.length, `Missing SQL observations for ${candidate.id}`);
      return { ...candidate, actualFindingCount: findings.length, findingIds: findings.map(item => item.id),
        reviewEligibility: findings.length ? 'eligible' : 'not_reported', observations: observed };
    });
    result.cases = cases;
    result.unmappedFindings = check.findings.filter(item => !labels.some(candidate => candidate.className === item.className));
    result.status = 'completed';
    await writeFile(path.join(runDir, 'matrix.md'), [
      '# Held-out SQL 实际分析矩阵', '',
      `构建 ${check.stages.build}；测试 ${check.stages.test.status}（${check.stages.test.tests} 项）；分析 ${check.stages.analysis}。`, '',
      '以下标签来自冻结的独立 oracle；没有调用模型。安全案例没有告警时仅记录未报告，不计作模型识别误报。', '',
      '| 案例 | 独立真值 | 实际项目告警 | 复核可用性 |', '| --- | --- | ---: | --- |',
      ...cases.map(item => `| ${item.id} | ${item.truth} | ${item.actualFindingCount} | ${item.reviewEligibility} |`), '',
      '[完整结果、独立依据、SQL 观测及版本](result.json)', '',
      '真实缺陷的测试通过表示成功复现目标行为；安全结论来自完整代码论证，有限测试仅作佐证。全部未报告、未映射和失败记录保留。', '',
    ].join('\n'), { flag: 'wx' });
  } catch (error) {
    result.status = 'failed';
    result.error = error instanceof Error ? error.stack ?? error.message : String(error);
    process.exitCode = 1;
  } finally {
    try { await frozen.verify(); result.frozenProtocolUnchanged = true; }
    catch (error) { result.status = 'failed'; result.error = String(error); process.exitCode = 1; }
    result.finishedAt = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ status: result.status, resultPath, error: result.error }));
  }
  return resultPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(value => value !== '--prepare-dependencies')) throw new Error('Usage: node scripts/probe-sql-heldout.ts [--prepare-dependencies]');
  runHeldoutProbe(args.includes('--prepare-dependencies')).catch(error => { console.error(error); process.exitCode = 1; });
}
