import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectConfig } from './config.ts';
import type { MavenCheckResult } from './docker-maven.ts';
import type { MavenTestResult } from './maven.ts';
import type { ProcessResult } from './process.ts';
import type { AnalysisReport, Finding } from './taie.ts';
import { partitionFindings, projectClassNames } from './finding-origin.ts';
import { renderCheckMarkdown } from './check-markdown.ts';
import { buildComparisonKey } from './check-context.ts';
import { compareChecks, type FindingComparison } from './comparison.ts';

export interface CheckResult {
  schemaVersion: 1;
  backend: 'javac' | 'maven-docker';
  /** Passed covers mechanical checks only; review remains a separate stage. */
  status: MavenCheckResult['status'];
  statusScope: 'project';
  projectDir: string;
  runDir: string;
  reportPath: string;
  humanReportPath: string;
  backendReportPath: string;
  backendStatus: AnalysisReport['status'] | MavenCheckResult['status'];
  analyses: string[];
  sourceFingerprint?: string;
  snapshotFingerprint?: string;
  comparisonKey?: string;
  comparison?: FindingComparison;
  analysisReportPath?: string;
  durationMs?: number;
  stages: {
    build: 'not_run' | 'passed' | 'failed' | 'timeout';
    test: MavenTestResult;
    analysis: 'not_run' | 'completed' | 'failed' | 'timeout';
    review: 'not_run';
  };
  findings: Finding[];
  dependencyFindings?: Finding[];
  findingCounts: { project: number; dependency: number; total: number };
  diagnostics: string[];
  limitations: string[];
}

const noTests = (): MavenTestResult => ({ status: 'not_run', tests: 0, failures: 0, errors: 0, skipped: 0, reportFiles: [] });

/** Read only the selected report view; hidden dependency details are not fetched from raw evidence. */
export function findingEvidence(report: CheckResult, query: { id?: string; limit?: number; origin?: 'project' | 'dependency' } = {}) {
  const origin = query.origin ?? 'project';
  const findings = origin === 'project' ? report.findings : report.dependencyFindings;
  const matches = findings?.filter(finding => !query.id || finding.id === query.id) ?? [];
  const comparison = report.comparison;
  return {
    backend: report.backend, status: report.status, stages: report.stages, origin,
    sourceFingerprint: report.sourceFingerprint, snapshotFingerprint: report.snapshotFingerprint,
    reportPath: report.reportPath, humanReportPath: report.humanReportPath,
    backendReportPath: report.backendReportPath, analysisReportPath: report.analysisReportPath,
    comparison: comparison ? {
      schemaVersion: comparison.schemaVersion, status: comparison.status, reason: comparison.reason,
      baselineReportPath: comparison.baselineReportPath, currentReportPath: comparison.currentReportPath,
      baselineStatus: comparison.baselineStatus, currentStatus: comparison.currentStatus,
      stageChanges: comparison.stageChanges, counts: comparison.counts, limitations: comparison.limitations,
    } : undefined,
    detailsIncluded: findings !== undefined, totalRecorded: report.findingCounts[origin], totalMatches: matches.length,
    ...(findings === undefined ? { message: 'Dependency details are hidden by the host. Enable include-dependencies and run a new check to inspect them.' } : {}),
    findings: matches.slice(0, query.limit ?? 5),
  };
}

const analysisStage = (report?: AnalysisReport): CheckResult['stages']['analysis'] =>
  !report || report.status === 'compile_failed' ? 'not_run'
    : report.status === 'completed' ? 'completed' : report.status === 'timeout' ? 'timeout' : 'failed';

/** Keep the backend's failure even when partial output has zero findings. */
export function normalizeMavenCheck(report: MavenCheckResult): CheckResult {
  const analysis = report.analysis;
  const findings = analysis?.findings ?? [];
  const stages: CheckResult['stages'] = {
    build: report.maven?.build ?? 'not_run',
    test: report.maven?.test ?? noTests(),
    analysis: analysisStage(analysis),
    review: 'not_run',
  };
  let status = report.status;
  const diagnostics = [...report.diagnostics];
  if (status === 'passed' || status === 'findings') {
    if (stages.build !== 'passed') status = 'build_failed';
    else if (stages.test.status === 'failed') status = 'test_failed';
    else if (stages.test.status !== 'passed') status = 'tests_not_run';
    else if (stages.analysis !== 'completed') status = 'analysis_failed';
    else if (report.maven?.status !== 'completed' || analysis?.findingScope !== 'project') {
      status = 'error';
      diagnostics.push('Completed Maven execution and a project-scoped analysis report are required.');
    } else status = findings.length ? 'findings' : report.status;
  }
  return {
    schemaVersion: 1, backend: 'maven-docker', status, statusScope: 'project',
    projectDir: report.projectDir, runDir: report.runDir, reportPath: path.join(report.runDir, 'check.json'),
    humanReportPath: path.join(report.runDir, 'check.md'),
    backendReportPath: report.reportPath, backendStatus: report.status, durationMs: report.durationMs,
    analyses: analysis?.analyses ?? [],
    sourceFingerprint: analysis?.sourceFingerprint, snapshotFingerprint: report.snapshotFingerprint,
    analysisReportPath: analysis?.reportPath,
    stages, findings, ...(analysis?.dependencyFindings ? { dependencyFindings: analysis.dependencyFindings } : {}),
    findingCounts: analysis?.findingCounts ?? { project: findings.length, dependency: 0, total: findings.length },
    diagnostics, limitations: analysis?.limitations ?? [],
  };
}

export function normalizeJavacCheck(report: AnalysisReport, compile: ProcessResult | undefined,
  classes: ReadonlySet<string>, includeDependencies = false): CheckResult {
  const build = report.status === 'completed' || (compile?.code === 0 && !compile.stopped && !compile.error) ? 'passed'
    : compile?.stopped ? 'timeout' : report.status === 'compile_failed' || compile ? 'failed' : 'not_run';
  const { projectFindings, dependencyFindings } = partitionFindings(report.findings, classes);
  return {
    schemaVersion: 1, backend: 'javac', statusScope: 'project',
    status: report.status === 'completed' ? 'tests_not_run'
      : report.status === 'compile_failed' ? 'build_failed' : report.status,
    projectDir: report.projectDir, runDir: report.runDir, reportPath: path.join(report.runDir, 'check.json'),
    humanReportPath: path.join(report.runDir, 'check.md'),
    backendReportPath: report.reportPath, backendStatus: report.status, durationMs: report.durationMs,
    analyses: report.analyses,
    sourceFingerprint: report.sourceFingerprint, analysisReportPath: report.reportPath,
    stages: { build, test: noTests(), analysis: report.status === 'analysis_failed' ? 'failed'
      : build === 'passed' ? analysisStage(report) : 'not_run', review: 'not_run' },
    findings: projectFindings, ...(includeDependencies ? { dependencyFindings } : {}),
    findingCounts: { project: projectFindings.length, dependency: dependencyFindings.length, total: report.findings.length },
    diagnostics: [...report.diagnostics],
    limitations: [...report.limitations, 'The javac backend does not execute project tests; zero findings cannot produce passed.'],
  };
}

/** Host-only check. It neither initializes a model nor starts a repair round. */
export async function checkProject(options: ProjectConfig & { projectDir: string; signal?: AbortSignal; taintConfigContent?: string; baseline?: CheckResult }): Promise<CheckResult> {
  const { buildBackend = 'javac', dependencyNetwork, includeDependencies, baseline, baselineEnabled, ...analysisOptions } = options;
  let result: CheckResult;
  let analysis: AnalysisReport | undefined;
  let maven: MavenCheckResult | undefined;
  if (buildBackend === 'maven-docker') {
    const { checkMavenInDocker } = await import('./docker-maven.ts');
    maven = await checkMavenInDocker({ ...analysisOptions, dependencyNetwork, includeDependencies });
    analysis = maven.analysis;
    result = normalizeMavenCheck(maven);
  } else {
    const { analyzeJavaProject } = await import('./taie.ts');
    const report = await analyzeJavaProject(analysisOptions);
    analysis = report;
    const compile: ProcessResult | undefined = report.evidence.compileResult
      ? JSON.parse(await readFile(report.evidence.compileResult, 'utf8')) as ProcessResult : undefined;
    const classes = report.status === 'completed' ? await projectClassNames(path.join(report.runDir, 'classes')) : new Set<string>();
    result = normalizeJavacCheck(report, compile, classes, includeDependencies);
  }
  if (analysis?.status === 'completed') {
    try { result.comparisonKey = await buildComparisonKey(analysis, maven); }
    catch (error) { result.diagnostics.push(`Finding comparison unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (baseline) result.comparison = compareChecks(baseline, result);
  return writeCheckReports(result);
}

/** Publish a readable companion without changing or re-running backend evidence. */
export async function writeCheckReports(result: CheckResult): Promise<CheckResult> {
  await writeFile(result.humanReportPath, renderCheckMarkdown(result), { flag: 'wx' });
  await writeFile(result.reportPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return result;
}

export function renderCheckResult(result: CheckResult): string {
  const { stages, findingCounts } = result;
  return [
    `[检查] ${result.status} · 后端 ${result.backend} · 项目告警 ${findingCounts.project} · 依赖告警 ${findingCounts.dependency}`,
    `构建: ${stages.build}；测试: ${stages.test.status}（${stages.test.tests} 个，失败 ${stages.test.failures}，错误 ${stages.test.errors}，跳过 ${stages.test.skipped}）；分析: ${stages.analysis}；复核: ${stages.review}`,
    ...(result.comparison ? [result.comparison.counts
      ? `相对基线：新增 ${result.comparison.counts.added}；消失 ${result.comparison.counts.removed}；仍存在 ${result.comparison.counts.persisting}；变化 ${result.comparison.counts.changed}`
      : `基线比较：${result.comparison.status}；${result.comparison.reason ?? '无法比较'}`] : []),
    ...result.findings.slice(0, 10).map(finding => `  [project] ${finding.type}: ${finding.className ?? ''}${finding.startLine ? `:${finding.startLine}` : ''}`),
    ...(result.dependencyFindings?.slice(0, 10).map(finding => `  [dependency] ${finding.type}: ${finding.className ?? ''}${finding.startLine ? `:${finding.startLine}` : ''}`) ?? []),
    ...result.diagnostics,
    'passed 仅表示构建、测试与所选分析通过；复核未运行，零告警不证明没有缺陷。',
    `统一报告: ${result.reportPath}`,
    `可读质检报告: ${result.humanReportPath}`,
    `后端报告: ${result.backendReportPath}`,
  ].join('\n');
}
