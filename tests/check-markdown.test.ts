import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { renderCheckMarkdown } from '../src/check-markdown.ts';
import type { CheckResult } from '../src/check.ts';
import { compareChecks } from '../src/comparison.ts';

function result(): CheckResult {
  const projectDir = path.resolve('project #中文');
  const runDir = path.join(projectDir, '.taie-agent', 'runs', 'example');
  return {
    schemaVersion: 1, backend: 'maven-docker', status: 'passed', statusScope: 'project',
    projectDir, runDir, reportPath: path.join(runDir, 'check.json'), humanReportPath: path.join(runDir, 'check.md'),
    backendReportPath: path.join(runDir, 'report.json'), backendStatus: 'passed', durationMs: 117871,
    analyses: ['dead-code'],
    stages: { build: 'passed', test: { status: 'passed', tests: 2, failures: 0, errors: 0, skipped: 1,
      reportFiles: [path.join(projectDir, 'target', 'test #中文', 'TEST-[Example](1).xml')] },
    analysis: 'completed', review: 'not_run' },
    findings: [], findingCounts: { project: 0, dependency: 71, total: 71 },
    diagnostics: [], limitations: ['An empty result is not proof of correctness.'],
  };
}

test('baseline differences remain visible without turning disappearance or a failed baseline into a clean result', () => {
  const before = result();
  const after = result();
  before.comparisonKey = after.comparisonKey = 'same-analysis-context';
  before.status = 'findings';
  before.findings = [{ id: 'old', origin: 'project', analysis: 'dead-code', type: 'DEAD_CODE',
    className: 'example.Main', method: '<example.Main: void oldMethod()>', message: 'old finding' }];
  before.findingCounts.project = 1;
  after.status = 'findings';
  after.findings = [{ ...before.findings[0], id: 'new', method: '<example.Main: void newMethod()>' }];
  after.findingCounts.project = 1;
  after.comparison = compareChecks(before, after);
  const markdown = renderCheckMarkdown(after);
  assert.match(markdown, /\| 新增 \| 1 \|/);
  assert.match(markdown, /\| 消失（本次未再报告） \| 1 \|/);
  assert.match(markdown, /相对修改前基线：新增/);
  assert.match(markdown, /告警消失不证明修复正确/);
  assert.match(markdown, /oldMethod/);
  before.status = 'analysis_failed';
  before.stages.analysis = 'failed';
  after.comparison = compareChecks(before, after);
  const unavailable = renderCheckMarkdown(after);
  assert.match(unavailable, /无法可靠对比/);
  assert.doesNotMatch(unavailable, /\| 新增 \|/);
});

test('a readable report distinguishes project pass from hidden dependency findings and unrun review', () => {
  const report = result();
  const before = structuredClone(report);
  const markdown = renderCheckMarkdown(report);
  assert.match(markdown, /自动检查通过/);
  assert.match(markdown, /\| 误报复核 \| 未运行（`not_run`） \|/);
  assert.match(markdown, /共 2 个，失败 0 个，错误 0 个，跳过 1 个/);
  assert.match(markdown, /检测器：dead-code/);
  assert.match(markdown, /已记录 71 条依赖告警，本报告未展开详情/);
  assert.match(markdown, /117\.87 秒/);
  assert.match(markdown, /\[统一结果 JSON\]\(<check.json>\)/);
  assert.ok(markdown.includes('../../../target/test%20%23%E4%B8%AD%E6%96%87/TEST-%5BExample%5D%281%29.xml'));
  assert.deepEqual(report, before, 'rendering must not mutate or reclassify evidence');
});

test('failed, incomplete and stale checks never describe zero recorded findings as a successful check', () => {
  for (const status of ['build_failed', 'test_failed', 'tests_not_run', 'analysis_failed', 'unsupported', 'timeout', 'error', 'stale'] as const) {
    const report = result();
    report.status = status;
    report.backendStatus = status;
    report.stages.analysis = status === 'analysis_failed' ? 'failed' : 'not_run';
    report.findingCounts = { project: 0, dependency: 0, total: 0 };
    const markdown = renderCheckMarkdown(report);
    assert.ok(markdown.includes(`（\`${status}\`）`));
    assert.doesNotMatch(markdown, /自动检查通过/);
    assert.match(markdown, /0 条不能解释为没有问题/);
    assert.doesNotMatch(markdown, /所选分析没有报告项目告警/);
  }
  const javac = result();
  javac.backend = 'javac';
  javac.status = 'tests_not_run';
  javac.stages.test.status = 'not_run';
  assert.match(renderCheckMarkdown(javac), /javac 后端不执行项目测试/);
});

test('all findings retain source details while Markdown, HTML and snippet delimiters remain data', () => {
  const report = result();
  report.status = 'findings';
  const finding = {
    id: 'finding-0', origin: 'project' as const, analysis: 'null-pointer', type: 'NP_ALWAYS_NULL',
    severity: 'BLOCKER', className: 'example.Main', method: '<example.Main: int run()>',
    sourcePath: path.join(report.projectDir, 'src', 'A #中文(1).java'), startLine: 12, endLine: 14,
    message: 'first\n```\n# injected heading\n<script>alert(1)</script>',
    snippet: 'String value = "```";\nreturn value.trim();',
  };
  report.findings = Array.from({ length: 11 }, (_, index) => ({ ...finding, id: `finding-${index}` }));
  report.findingCounts = { project: 11, dependency: 1, total: 12 };
  report.dependencyFindings = [{ ...finding, origin: 'dependency', id: 'library-only', type: '<script>|[title]', snippet: undefined }];
  report.diagnostics = ['## fake diagnostic heading\n```\n</details>'];
  const markdown = renderCheckMarkdown(report);
  assert.match(markdown, /告警 ID：finding-10/);
  assert.match(markdown, /告警 ID：library-only/);
  assert.ok(markdown.includes('src/A%20%23%E4%B8%AD%E6%96%87%281%29.java'));
  assert.match(markdown, /第 12–14 行/);
  assert.ok(markdown.includes('方法：&lt;example.Main: int run()&gt;'));
  assert.ok(markdown.includes('````java\nString value = "```";\nreturn value.trim();\n````'));
  assert.ok(markdown.includes('````text\nfirst\n```\n# injected heading\n<script>alert(1)</script>\n````'));
  assert.ok(markdown.includes('### 1. &lt;script&gt;\\|\\[title\\]'));
  assert.ok(markdown.includes('````text\n## fake diagnostic heading\n```\n</details>\n````'));
  assert.match(markdown, /尚未判定是真实缺陷还是误报/);
});
