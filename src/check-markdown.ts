import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CheckResult } from './check.ts';
import type { Finding } from './taie.ts';

const conclusions: Record<CheckResult['status'], string> = {
  passed: '自动检查通过，未发现项目告警',
  findings: '发现项目告警，需要复核',
  build_failed: '检查失败：构建未通过',
  test_failed: '检查失败：项目测试未通过',
  tests_not_run: '检查未完成：项目测试未运行',
  analysis_failed: '检查失败：静态分析未完成',
  unsupported: '检查未完成：当前不支持该项目或配置',
  timeout: '检查未完成：超时或取消',
  error: '检查失败：运行错误',
  stale: '结果已过期：项目输入发生变化',
};
const stageNames = { passed: '通过', failed: '失败', not_run: '未运行', completed: '完成', timeout: '超时或取消' };

/** Repository text is data, including Markdown and HTML embedded in names or messages. */
function text(value: string | number): string {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\\`*_\[\]#|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

function block(value: string, language = 'text'): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function fileLink(result: CheckResult, file: string, label: string): string {
  const absolute = path.resolve(result.projectDir, file);
  const relative = path.relative(path.dirname(result.reportPath), absolute);
  const target = path.isAbsolute(relative) ? pathToFileURL(absolute).href
    : relative.split(path.sep).map(segment => encodeURIComponent(segment)
      .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  return `[${text(label)}](<${target}>)`;
}

function findingDetails(result: CheckResult, findings: Finding[]): string[] {
  return findings.flatMap((finding, index) => {
    const location = finding.sourcePath
      ? fileLink(result, finding.sourcePath, path.relative(result.projectDir, path.resolve(result.projectDir, finding.sourcePath)))
      : '未取得源码路径';
    const lines = finding.startLine === undefined ? ''
      : `，第 ${finding.startLine}${finding.endLine !== undefined && finding.endLine !== finding.startLine ? `–${finding.endLine}` : ''} 行`;
    const comparison = result.comparison;
    const change = finding.origin !== 'dependency' && comparison?.status === 'compared'
      ? comparison.added?.some(item => item.id === finding.id) ? '新增'
        : comparison.changed?.some(item => item.after.id === finding.id) ? '变化（候选对应关系，需复核）'
          : comparison.persisting?.some(item => item.after.id === finding.id) ? '延续' : undefined
      : undefined;
    return [
      `### ${index + 1}. ${text(finding.type)}`, '',
      `- 规则：${text(finding.ruleId ?? `${finding.analysis}/${finding.type}`)}`,
      `- 严重程度：${finding.severity === undefined ? '未提供' : text(finding.severity)}`,
      `- 位置：${location}${lines}`,
      ...(finding.className ? [`- 类：${text(finding.className)}`] : []),
      ...(finding.method ? [`- 方法：${text(finding.method)}`] : []),
      `- 告警 ID：${text(finding.id)}`,
      ...(change ? [`- 相对修改前基线：${change}`] : []),
      '- 复核：未运行，尚未判定是真实缺陷还是误报', '',
      '检测器原始说明：', '', block(finding.message), '',
      ...(finding.snippet ? ['源码片段：', '', block(finding.snippet, 'java'), ''] : []),
    ];
  });
}

function comparisonSection(result: CheckResult): string[] {
  const comparison = result.comparison;
  if (!comparison) return [];
  const lines = ['## 与修改前基线对比', '',
    `基线检查状态：${text(comparison.baselineStatus)}；本次检查状态：${text(comparison.currentStatus)}。`, '',
    fileLink(result, comparison.baselineReportPath, '查看修改前基线证据'), ''];
  if (comparison.status !== 'compared' || !comparison.counts) {
    return [...lines, `**无法可靠对比**：${text(comparison.reason ?? comparison.status)}。`, '',
      '未计算新增或消失数量，不能将未完成的检查当作零告警基线。', ''];
  }
  const { counts, stageChanges } = comparison;
  return [...lines,
    '| 项目告警变化 | 数量 |', '| --- | ---: |',
    `| 新增 | ${counts.added} |`, `| 延续 | ${counts.persisting} |`,
    `| 变化 | ${counts.changed} |`, `| 消失（本次未再报告） | ${counts.removed} |`, '',
    ...(stageChanges ? [`阶段状态：构建 ${text(stageChanges.build.before)} → ${text(stageChanges.build.after)}；测试 ${text(stageChanges.test.before)} → ${text(stageChanges.test.after)}；分析 ${text(stageChanges.analysis.before)} → ${text(stageChanges.analysis.after)}。`, ''] : []),
    '对比仅描述告警变化，不改变本次验收结论。遗留告警仍计入项目检查；告警消失不证明修复正确，源码删除等变化也可能使告警消失。', '',
    ...(comparison.removed?.length ? ['本次未再报告的基线告警：', '', ...comparison.removed.map(finding =>
      `- ${text(finding.ruleId ?? `${finding.analysis}/${finding.type}`)} · ${text(finding.method ?? finding.className ?? '位置未提供')} · ID：${text(finding.id)}`), ''] : []),
    ...comparison.limitations.map(limitation => `- ${text(limitation)}`), '',
  ];
}

/** A deterministic, human-readable view of recorded evidence; no model judgments are added. */
export function renderCheckMarkdown(result: CheckResult): string {
  const { stages, findingCounts } = result;
  const stage = (value: keyof typeof stageNames) => `${stageNames[value]}（\`${value}\`）`;
  return [
    '# Tai-e 代码质检报告', '',
    `**${conclusions[result.status]}**（\`${result.status}\`）`, '',
    '本报告由检查结果直接生成。通过仅表示构建、测试与所选分析满足检查条件；零告警不证明程序没有缺陷，误报复核尚未执行。', '',
    `- 项目：${text(result.projectDir)}`,
    `- 检查后端：${text(result.backend)}`,
    `- 后端原始状态：${text(result.backendStatus)}`,
    `- 耗时：${result.durationMs === undefined ? '未记录' : `${(result.durationMs / 1000).toFixed(2)} 秒`}`,
    `- 检测器：${result.analyses?.length ? result.analyses.map(text).join('、') : '未取得检测器信息，详见后端原始报告'}`, '',
    '## 各阶段结果', '',
    '| 阶段 | 结果 |', '| --- | --- |',
    `| 构建 | ${stage(stages.build)} |`,
    `| 项目测试 | ${stage(stages.test.status)} |`,
    `| 静态分析 | ${stage(stages.analysis)} |`,
    `| 误报复核 | ${stage(stages.review)} |`, '',
    `测试记录：共 ${stages.test.tests} 个，失败 ${stages.test.failures} 个，错误 ${stages.test.errors} 个，跳过 ${stages.test.skipped} 个。`, '',
    ...(result.backend === 'javac' ? ['javac 后端不执行项目测试，因此即使编译与分析成功，也不能得到完整检查通过的结论。', ''] : []),
    ...(result.status === 'stale' ? ['本次结果对应的输入已发生变化，应对当前版本重新检查。', ''] : []),
    ...comparisonSection(result),
    '## 已记录告警', '',
    '| 归属 | 数量 |', '| --- | ---: |',
    `| 项目代码 | ${findingCounts.project} |`,
    `| 第三方依赖 | ${findingCounts.dependency} |`,
    `| 合计 | ${findingCounts.total} |`, '',
    '项目检查状态只计入项目告警。依赖告警单独展示和统计，归属分类不等同于误报判定。', '',
    ...(stages.analysis !== 'completed' ? ['**静态分析未完成：上面的数量只是已记录结果，0 条不能解释为没有问题。**', ''] : []),
    '## 项目告警详情', '',
    ...(result.findings.length ? findingDetails(result, result.findings)
      : [stages.analysis === 'completed' ? '所选分析没有报告项目告警。' : '当前没有项目告警记录；分析未完成，不能据此判断项目安全。', '']),
    '## 依赖告警详情', '',
    ...(result.dependencyFindings?.length ? findingDetails(result, result.dependencyFindings)
      : result.dependencyFindings === undefined && findingCounts.dependency > 0
        ? [`已记录 ${findingCounts.dependency} 条依赖告警，本报告未展开详情。下次检查可设置 \`/set include-dependencies on\`。完整原始证据见后端报告。`, '']
        : ['当前没有展开的依赖告警记录；数量以上方计数为准。', '']),
    '## 运行诊断', '',
    ...(result.diagnostics.length ? [block(result.diagnostics.join('\n')), ''] : ['没有额外运行诊断。', '']),
    '## 覆盖范围与限制', '',
    '本次仅覆盖已配置的检测器和分析模型，未执行模型或人工复核。原始限制说明如下：', '',
    ...(result.limitations.length ? [block(result.limitations.join('\n')), ''] : ['未提供其他限制说明。', '']),
    '## 证据文件', '',
    `- ${fileLink(result, result.reportPath, '统一结果 JSON')}`,
    `- ${fileLink(result, result.backendReportPath, '后端原始报告（含日志与分析证据路径）')}`,
    ...stages.test.reportFiles.map((file, index) => `- ${fileLink(result, file, `测试报告 ${index + 1}：${path.basename(file)}`)}`), '',
  ].join('\n');
}
