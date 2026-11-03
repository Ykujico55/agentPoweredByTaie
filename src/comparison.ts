import path from 'node:path';
import type { CheckResult } from './check.ts';
import type { EvidenceLocation, Finding } from './taie.ts';

export interface FindingPair {
  before: Finding;
  after: Finding;
}

export interface FindingComparison {
  schemaVersion: 1;
  status: 'compared' | 'baseline_failed' | 'current_failed' | 'incompatible';
  baselineReportPath: string;
  currentReportPath: string;
  baselineStatus: CheckResult['status'];
  currentStatus: CheckResult['status'];
  reason?: string;
  stageChanges: {
    build: { before: CheckResult['stages']['build']; after: CheckResult['stages']['build'] };
    test: { before: CheckResult['stages']['test']['status']; after: CheckResult['stages']['test']['status'] };
    analysis: { before: CheckResult['stages']['analysis']; after: CheckResult['stages']['analysis'] };
  };
  counts?: { added: number; removed: number; persisting: number; changed: number };
  added?: Finding[];
  removed?: Finding[];
  persisting?: FindingPair[];
  changed?: FindingPair[];
  limitations: string[];
}

const usableStatuses = new Set<CheckResult['status']>(['passed', 'findings', 'tests_not_run', 'test_failed']);
const usable = (report: CheckResult) => usableStatuses.has(report.status)
  && report.stages.build === 'passed' && report.stages.analysis === 'completed';
const detectorSet = (report: CheckResult) => JSON.stringify([...new Set(report.analyses)].sort());
const rule = (finding: Finding) => finding.ruleId ?? `${finding.analysis}/${finding.type}`;

function stableText(value: string, report: CheckResult): string {
  let text = value.replaceAll('\r\n', '\n');
  for (const [directory, replacement] of [[report.runDir, '<run>'], [report.projectDir, '<project>']]) {
    for (const spelling of new Set([directory, directory.replaceAll('\\', '/'), directory.replaceAll('/', '\\')])) {
      if (spelling) text = text.split(spelling).join(replacement);
    }
  }
  return text
    .replace(/\.taie-agent[\\/](?:maven-runs|runs)[\\/][^\\/\s]+/g, '.taie-agent/runs/<run>')
    .replace(/\bLineNumber\s*:\s*(?:\d+(?:---\d+)?|null)/gi, 'LineNumber: <line>')
    .replace(/\b(?:startLine|endLine|line|lines)\s*[:#]\s*\d+(?:\s*[-–:]\s*\d+)?/gi, 'line <line>')
    .replace(/\bat lines?\s+\d+(?:\s*[-–:]\s*\d+)?/gi, 'at line <line>')
    .replace(/@L\d+/g, '@L<line>')
    .replace(/\[\d+@L<line>\]/g, '[<statement>@L<line>]')
    .trim();
}

const locationFields = new Set(['sourcePath', 'line', 'startLine', 'endLine', 'snippet']);

/** Preserve semantic evidence, including constants and path order, but not physical coordinates. */
function semanticEvidence(value: unknown, report: CheckResult): unknown {
  if (typeof value === 'string') return stableText(value, report);
  if (Array.isArray(value)) return value.map(item => semanticEvidence(item, report));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !locationFields.has(key)).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, semanticEvidence(item, report)]));
  return value;
}

function semanticFinding(finding: Finding, report: CheckResult): string {
  return JSON.stringify({
    analysis: finding.analysis, type: finding.type, rule: rule(finding),
    className: finding.className, method: finding.method, severity: finding.severity, confidence: finding.confidence,
    message: stableText(finding.message, report), evidence: semanticEvidence(finding.evidence, report),
  });
}

function logicalAnchor(finding: Finding): string | undefined {
  if (!finding.className || !finding.method) return undefined;
  const endpoint = (value: EvidenceLocation | undefined) => value ? [value.className, value.method] : undefined;
  return JSON.stringify([finding.analysis, rule(finding), finding.type, finding.className, finding.method,
    endpoint(finding.evidence?.source), endpoint(finding.evidence?.sink)]);
}

function groups(findings: Finding[], key: (finding: Finding) => string | undefined): Map<string, Finding[]> {
  const result = new Map<string, Finding[]>();
  for (const finding of findings) {
    const identity = key(finding);
    if (identity === undefined) continue;
    const group = result.get(identity) ?? [];
    group.push(finding);
    result.set(identity, group);
  }
  return result;
}

/** Compare recorded project findings; this never changes the current project's acceptance gate. */
export function compareChecks(baseline: CheckResult, current: CheckResult): FindingComparison {
  const common = {
    schemaVersion: 1 as const,
    baselineReportPath: baseline.reportPath, currentReportPath: current.reportPath,
    baselineStatus: baseline.status, currentStatus: current.status,
    stageChanges: {
      build: { before: baseline.stages.build, after: current.stages.build },
      test: { before: baseline.stages.test.status, after: current.stages.test.status },
      analysis: { before: baseline.stages.analysis, after: current.stages.analysis },
    },
    limitations: [
      '仅比较项目告警；依赖告警单独统计，比较不会改变当前检查状态或认定误报。',
      '消失表示本次未再次报告，不证明缺陷已修复；删除功能或改变覆盖也可能使告警消失。',
      '优先使用稳定 ID；同规则、同类、同方法及相同污点端点下的唯一剩余候选配对为变化，属于启发式匹配。多候选不强行配对。',
      '稳定 ID 的重复告警按出现次序区分；插入相同告警可能改变对应关系。位置和上下文片段变化不单独算作语义变化。',
    ],
  };
  if (!usable(baseline)) return { ...common, status: 'baseline_failed',
    reason: '基线没有完成可用的构建和分析，不能把空告警列表作为修改前状态。' };
  if (!usable(current)) return { ...common, status: 'current_failed',
    reason: '当前检查没有完成可用的构建和分析，不能把未报告的告警当作已消失。' };
  if (path.resolve(baseline.projectDir) !== path.resolve(current.projectDir)
      || baseline.backend !== current.backend || detectorSet(baseline) !== detectorSet(current)
      || !baseline.comparisonKey || !current.comparisonKey || baseline.comparisonKey !== current.comparisonKey) {
    return { ...common, status: 'incompatible',
      reason: '项目、后端、检测器或分析环境指纹不同，或缺少比较指纹；本次不计算告警增减。' };
  }

  const before = baseline.findings.filter(finding => finding.origin !== 'dependency');
  const after = current.findings.filter(finding => finding.origin !== 'dependency');
  const usedBefore = new Set<Finding>();
  const usedAfter = new Set<Finding>();
  const persisting: FindingPair[] = [];
  const changed: FindingPair[] = [];
  const beforeIds = groups(before, finding => finding.id);
  const afterIds = groups(after, finding => finding.id);
  for (const [id, candidates] of beforeIds) {
    const matches = afterIds.get(id);
    if (candidates.length !== 1 || matches?.length !== 1) continue;
    const pair = { before: candidates[0], after: matches[0] };
    usedBefore.add(pair.before);
    usedAfter.add(pair.after);
    (semanticFinding(pair.before, baseline) === semanticFinding(pair.after, current) ? persisting : changed).push(pair);
  }
  const beforeAnchors = groups(before.filter(finding => !usedBefore.has(finding)), logicalAnchor);
  const afterAnchors = groups(after.filter(finding => !usedAfter.has(finding)), logicalAnchor);
  for (const [anchor, candidates] of beforeAnchors) {
    const matches = afterAnchors.get(anchor);
    if (candidates.length !== 1 || matches?.length !== 1) continue;
    const pair = { before: candidates[0], after: matches[0] };
    usedBefore.add(pair.before);
    usedAfter.add(pair.after);
    changed.push(pair);
  }
  const added = after.filter(finding => !usedAfter.has(finding));
  const removed = before.filter(finding => !usedBefore.has(finding));
  return { ...common, status: 'compared', added, removed, persisting, changed,
    counts: { added: added.length, removed: removed.length, persisting: persisting.length, changed: changed.length } };
}
