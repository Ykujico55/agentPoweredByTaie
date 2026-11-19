import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject } from '../src/check.ts';
import { loadProjectConfig } from '../src/config.ts';
import type { MavenCheckResult } from '../src/docker-maven.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Investigator labels are kept outside the model-visible source and policy. */
export const SQL_CASES = [
  { id: 'A', className: 'example.CaseA', truth: 'vulnerable', mechanism: 'Input concatenated into a quoted SQL value',
    basis: 'An independent H2 execution must demonstrate that the injected input changes the selected rows.' },
  { id: 'B', className: 'example.CaseB', truth: 'safe_under_stated_assumptions', mechanism: 'Context-insensitive identity call merge candidate',
    basis: 'The helper only returns its own argument and has no shared state. The SQL sink receives the second call, whose argument is a constant; the input-derived first result is not used at the sink.' },
  { id: 'C', className: 'example.CaseC', truth: 'safe_under_stated_assumptions', mechanism: 'Mutually exclusive path candidate',
    basis: 'The same unmodified boolean guards the input-derived assignment and the negated sink branch. Whenever the sink executes, only the initial constant SQL can reach it.' },
  { id: 'D', className: 'example.CaseD', truth: 'safe_under_stated_assumptions', mechanism: 'Constant SQL negative control',
    basis: 'The executeQuery argument is a fixed literal, independent of the source return value.' },
  { id: 'E', className: 'example.CaseE', truth: 'vulnerable', mechanism: 'State retained between two calls to the same helper object',
    basis: 'Each execute call creates a fresh helper. Its first apply call stores the input; the second call returns that stored input instead of its constant argument. Independent H2 execution must demonstrate input-controlled SQL and changed result rows.' },
  { id: 'F', className: 'example.CaseF', truth: 'safe_under_stated_assumptions', mechanism: 'Neutral helper name with the same caller shape as the stateful case',
    basis: 'The complete private helper only returns the current argument and has no state. Despite the same caller shape as E, the second call can only return its fixed SQL argument to the unique sink.' },
] as const;

export async function runSqlProbe(dependencyNetwork = false): Promise<string> {
  const runDir = path.join(root, '.taie-agent/sql-probe', `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const projectDir = path.join(runDir, 'project');
  const resultPath = path.join(runDir, 'result.json');
  await mkdir(runDir, { recursive: true });
  await cp(path.join(root, 'tests/fixtures/sql-probe'), projectDir, {
    recursive: true, filter: file => !['target', '.taie-agent'].includes(path.basename(file)),
  });
  const result: Record<string, unknown> = {
    schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), projectDir,
    dependencyNetwork, modelRequests: 0,
    note: 'Development probe: independent SQL observations and actual Tai-e findings. Test success may confirm a deliberately vulnerable case; it does not establish application safety.',
  };
  const save = () => writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
  await save();
  console.log(`[sql-probe] Evidence: ${runDir}`);
  try {
    const config = await loadProjectConfig(projectDir);
    const check = await checkProject({ ...config, projectDir, dependencyNetwork });
    result.check = check;
    await save();
    assert.equal(check.backend, 'maven-docker');
    assert.equal(check.stages.build, 'passed', check.diagnostics.join('\n'));
    assert.equal(check.stages.test.status, 'passed', check.diagnostics.join('\n'));
    assert.equal(check.stages.analysis, 'completed', check.diagnostics.join('\n'));
    assert.ok(['findings', 'passed'].includes(check.status), `Unusable check: ${check.status}`);
    const backend: MavenCheckResult = JSON.parse(await readFile(check.backendReportPath, 'utf8'));
    assert.match(backend.maven?.versions.java ?? '', /^17\./);
    assert.ok(backend.maven?.metadata);
    const oraclePath = path.join(backend.maven.metadata.buildDirectory, 'sql-observations.json');
    const oracleBytes = await readFile(oraclePath);
    const oracle = JSON.parse(oracleBytes.toString('utf8'));
    assert.ok(Array.isArray(oracle.observations) && oracle.observations.length > 0, 'Missing actual SQL observations.');
    result.oracle = { reportPath: oraclePath, sha256: digest(oracleBytes), ...oracle };
    const snapshot = path.join(backend.runDir, 'snapshot/project');
    const sourceDirectory = backend.maven.metadata.sourceDirectory;
    const sourceManifest = [];
    for (const source of backend.maven.metadata.sourceFiles) {
      sourceManifest.push({ relativePath: path.relative(sourceDirectory, source).replaceAll('\\', '/'),
        path: source, sha256: digest(await readFile(source)) });
    }
    result.inputs = {
      imageId: backend.imageId, versions: backend.maven.versions, taiE: backend.analysis?.taiE,
      snapshotFingerprint: backend.snapshotFingerprint, sourceManifest,
      policyPath: path.join(snapshot, 'taint.yml'), policySha256: digest(await readFile(path.join(snapshot, 'taint.yml'))),
      pomSha256: digest(await readFile(path.join(snapshot, 'pom.xml'))),
      independentOracleSource: path.join(snapshot, 'src/test/java/example/QueryBehaviorTest.java'),
      assumptions: [
        'Scope is these fixture methods, the fixed policy and the observed JDK 17/Maven/H2 versions; not general JDBC or SQL injection coverage.',
        'The JDBC sink is matched at call sites in reachable methods. Tai-e does not establish a concrete database connection, executable path or exploit.',
        'Safe classifications use the complete fixture code argument; finite SQL tests corroborate behavior but are not universal safety proofs.',
        'All source/input strings and both boolean values are covered by the stated constant/branch arguments; no reflection, concurrent mutation or changed helper implementation is assumed.',
      ],
    };
    const rows = SQL_CASES.map(candidate => {
      const findings = check.findings.filter(finding => finding.type === 'TAINT_FLOW' && finding.className === candidate.className);
      const observations = oracle.observations.filter((observation: { caseId: string }) => observation.caseId === candidate.id);
      assert.ok(observations.length, `No independent SQL execution for case ${candidate.id}`);
      const classification = findings.length ? candidate.truth === 'vulnerable' ? 'true_positive' : 'false_positive_under_stated_assumptions'
        : candidate.truth === 'vulnerable' ? 'false_negative' : 'true_negative';
      return { ...candidate, classification, actualFindingCount: findings.length, findingIds: findings.map(finding => finding.id), observations };
    });
    const unmappedFindings = check.findings.filter(finding => !SQL_CASES.some(candidate => candidate.className === finding.className));
    result.cases = rows;
    result.unmappedFindings = unmappedFindings;
    result.capabilityInputsAvailable = rows.some(row => row.classification === 'true_positive')
      && rows.some(row => row.classification === 'false_positive_under_stated_assumptions');
    result.status = 'completed';
    const markdown = [
      '# SQL 注入告警能力探针', '',
      '本表记录独立依据与真实分析结果。本次没有调用复核模型；安全代码没有告警时仅算阴性对照。', '',
      `构建：${check.stages.build}；JUnit：${check.stages.test.status}（${check.stages.test.tests} 个）；分析：${check.stages.analysis}。`, '',
      '| 案例 | 独立判断 | 实际项目告警数 | 检测结果 |', '| --- | --- | ---: | --- |',
      ...rows.map(row => `| ${row.id} | ${row.truth} | ${row.actualFindingCount} | ${row.classification} |`), '',
      ...rows.flatMap(row => [`## 案例 ${row.id}`, '', `机制：${row.mechanism}`, '', `独立依据：${row.basis}`, '',
        `告警 ID：${row.findingIds.join('、') || '无'}`, '', '独立 SQL 执行观测：', '', '```json', JSON.stringify(row.observations, null, 2), '```', '']),
      '## 范围与证据', '',
      '测试通过表示预期观测成立，包括复现 A 和 E 的漏洞；不能把测试通过理解成所有案例安全。误报判断依赖完整代码和固定前提，不是因为测试未复现。', '',
      '只有一条最短抽象传播路径的报告不能证明运行时路径可行或排除其他路径。缺少关键证据的复核视图将在选定实际告警后单独建立。', '',
      '[完整结果与版本、指纹、原始报告路径](result.json)', '',
      `未归入案例的项目告警：${unmappedFindings.length}，保留在完整结果中。`, '',
    ].join('\n');
    const humanReportPath = path.join(runDir, 'matrix.md');
    await writeFile(humanReportPath, markdown, { flag: 'wx' });
    result.humanReportPath = humanReportPath;
  } catch (error) {
    result.status = 'failed';
    result.error = error instanceof Error ? error.stack ?? error.message : String(error);
    process.exitCode = 1;
  } finally {
    result.finishedAt = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ status: result.status, resultPath, capabilityInputsAvailable: result.capabilityInputsAvailable }));
    if (result.error) console.error(result.error);
  }
  return resultPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some(value => value !== '--prepare-dependencies')) throw new Error('Usage: npm run test:sql -- [--prepare-dependencies]');
  runSqlProbe(arguments_.includes('--prepare-dependencies')).catch(error => { console.error(error); process.exitCode = 1; });
}
