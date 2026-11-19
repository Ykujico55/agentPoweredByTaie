import type { CheckResult } from "./check.ts";
import type { ReviewResult, ReviewSuggestion } from "./review.ts";
import type { Finding } from "./taie.ts";

export type Outcome = "verified" | "skipped" | "unresolved" | "check_failed" | "incomplete" | "agent_error";
export type RepairMode = "ask" | "auto" | "off";
export type BusinessAcceptance =
  | { status: "passed"; reportPath?: string }
  | { status: "failed"; failures: string[]; reportPath?: string };
export interface BaselineResult {
  /** completed means the baseline was captured, not that every quality gate passed. */
  status: "completed" | "failed" | "disabled" | "skipped";
  check?: CheckResult;
  error?: string;
}
export interface VerificationResult {
  schemaVersion: 2;
  outcome: Outcome;
  checks: CheckResult[];
  businessChecks?: ({ checkReportPath: string } & (BusinessAcceptance | { status: "error"; error: string }))[];
  reviews: {
    checkReportPath: string;
    findingId: string;
    reportPath: string;
    status: ReviewResult["status"];
    assessment?: ReviewSuggestion["assessment"];
    repairTarget: boolean;
  }[];
  baseline: BaselineResult;
  repairRounds: number;
  error?: string;
}

export interface VerificationOptions {
  prompt: (text: string) => Promise<void>;
  analyze: (baseline?: CheckResult) => Promise<CheckResult>;
  /** Evaluate the checked build against the caller's independent business assertions. */
  acceptBusiness?: (check: CheckResult, signal?: AbortSignal) => Promise<BusinessAcceptance>;
  reviewFinding?: (check: CheckResult, finding: Finding) => Promise<ReviewResult>;
  task: string;
  maxRepairs: number;
  /** Existing API callers retain automatic repair when this is omitted. */
  repairMode?: RepairMode;
  confirmRepair?: (report: CheckResult, nextRound: number, targets: Finding[], businessFailures?: string[]) => Promise<boolean>;
  /** Skip the complete host check for this task; the outcome remains unverified. */
  skipTaie?: boolean;
  /** Capture the unmodified project before the first prompt. Enabled by default. */
  baselineEnabled?: boolean;
  signal?: AbortSignal;
  onStatus?: (text: string) => void;
  onBaseline?: (baseline: BaselineResult) => void;
  onCheck?: (report: CheckResult) => void;
}

/** A zero-finding analysis alone cannot establish that the project passed its checks. */
export function isCheckPassed(report: CheckResult): boolean {
  const { stages } = report;
  return report.status === "passed" && stages.build === "passed"
    && stages.test.status === "passed" && stages.test.tests - stages.test.skipped > 0
    && stages.test.failures === 0 && stages.test.errors === 0
    && stages.analysis === "completed" && report.findings.length === 0 && report.findingCounts.project === 0;
}

/** Code repair is distinct from unavailable tools, missing tests, stale input or failed analysis. */
export function isRepairableCheck(report: CheckResult): boolean {
  if (report.status === "build_failed") return report.stages.build === "failed";
  if (report.status === "test_failed") return report.stages.build === "passed" && report.stages.test.status === "failed";
  return (report.status === "findings" || report.status === "tests_not_run")
    && report.stages.build === "passed" && report.stages.analysis === "completed" && report.findings.length > 0;
}

function unfinishedOutcome(report: CheckResult): Outcome {
  if ((report.status === "findings" || report.status === "tests_not_run")
      && report.stages.build === "passed" && report.stages.analysis === "completed") {
    if (report.findings.length || report.findingCounts.project) return "unresolved";
    if (report.status === "tests_not_run" && report.stages.test.status === "not_run") return "incomplete";
  }
  return "check_failed";
}

interface LocatedFinding {
  finding: Finding;
  review: ReviewSuggestion;
}

function locateDefect(finding: Finding, result: ReviewResult): LocatedFinding | undefined {
  const review = result.suggestion;
  return result.status === "completed" && review?.assessment === "true_positive"
    && review.coverage !== "insufficient" && review.missingEvidence.length === 0
    && review.evidenceRefs.includes("finding") && (finding.sourcePath || finding.method || finding.className)
    ? { finding, review } : undefined;
}

/** The host owns a fresh build, project test and analysis check after each model response. */
export async function verifyTask(options: VerificationOptions): Promise<VerificationResult> {
  const checks: CheckResult[] = [];
  const reviews: VerificationResult["reviews"] = [];
  const businessChecks: NonNullable<VerificationResult["businessChecks"]> = [];
  let baseline: BaselineResult = { status: options.skipTaie ? "skipped" : "disabled" };
  let repairRounds = 0;
  let nextPrompt = options.task;
  const finish = (outcome: Outcome, error?: unknown): VerificationResult => ({
    schemaVersion: 2, outcome, checks, reviews, baseline, repairRounds,
    ...(options.acceptBusiness && { businessChecks }), ...(error === undefined ? {} : { error: String(error) }),
  });
  const cancelled = () => finish("agent_error", "Agent task cancelled.");
  if (options.signal?.aborted) return cancelled();
  if (!options.skipTaie && options.baselineEnabled !== false) {
    options.onStatus?.("正在记录基线（构建/测试/分析）。");
    if (options.signal?.aborted) return cancelled();
    try {
      const check = await options.analyze();
      baseline = { status: ["passed", "findings", "tests_not_run"].includes(check.status) ? "completed" : "failed", check };
    } catch (error) {
      baseline = { status: "failed", error: String(error) };
    }
  }
  options.onBaseline?.(baseline);
  for (;;) {
    if (options.signal?.aborted) return cancelled();
    options.onStatus?.("正在等待模型回复。");
    if (options.signal?.aborted) return cancelled();
    try {
      await options.prompt(nextPrompt);
    } catch (error) {
      if (options.signal?.aborted) return cancelled();
      return finish("agent_error", error);
    }
    if (options.signal?.aborted) return cancelled();
    if (options.skipTaie) {
      return finish("skipped");
    }
    let report: CheckResult;
    options.onStatus?.("正在执行最终检查（构建/测试/分析）。");
    if (options.signal?.aborted) return cancelled();
    try {
      report = await options.analyze(baseline.check);
    } catch (error) {
      if (options.signal?.aborted) return cancelled();
      return finish("check_failed", error);
    }
    checks.push(report);
    options.onCheck?.(report);
    if (options.signal?.aborted) return cancelled();
    let businessFailures: string[] | undefined;
    if (isCheckPassed(report)) {
      if (!options.acceptBusiness) return finish("verified");
      options.onStatus?.("正在对本次构建产物执行业务验收。");
      try {
        const acceptance = await options.acceptBusiness(report, options.signal);
        businessChecks.push({ checkReportPath: report.reportPath, ...acceptance });
        if (options.signal?.aborted) return cancelled();
        if (acceptance.status === "passed") return finish("verified");
        businessFailures = acceptance.failures;
        options.onStatus?.(`业务验收未通过：\n${businessFailures.join("\n")}`);
      } catch (error) {
        if (options.signal?.aborted) return cancelled();
        businessChecks.push({ checkReportPath: report.reportPath, status: "error", error: String(error) });
        return finish("check_failed", error);
      }
    }
    const outcome = businessFailures ? "unresolved" : unfinishedOutcome(report);
    const repairMode = options.repairMode ?? "auto";
    if ((!businessFailures && !isRepairableCheck(report)) || repairRounds >= options.maxRepairs || repairMode === "off") return finish(outcome);
    const targets: LocatedFinding[] = [];
    if (options.reviewFinding && report.stages.analysis === "completed") {
      for (const finding of report.findings) {
        options.onStatus?.(`正在只读核对 ${finding.type}（${finding.id}）。`);
        let review: ReviewResult;
        try {
          review = await options.reviewFinding(report, finding);
        } catch (error) {
          return options.signal?.aborted ? cancelled() : finish("agent_error", error);
        }
        const located = locateDefect(finding, review);
        reviews.push({ checkReportPath: report.reportPath, findingId: finding.id, reportPath: review.reportPath,
          status: review.status, assessment: review.suggestion?.assessment, repairTarget: Boolean(located) });
        if (options.signal?.aborted) return cancelled();
        if (review.status === "stale") return finish("check_failed", "复核期间检查报告已改变，请重新检查。");
        if (located) targets.push(located);
        options.onStatus?.(`${finding.id} · ${review.suggestion?.assessment ?? review.status} · ${located ? "已定位，列入修复目标" : "保留告警，本轮不据此修复"} · ${review.humanReportPath}`);
      }
    }
    if (!businessFailures && !targets.length && report.status !== "build_failed" && report.status !== "test_failed") return finish(outcome);
    if (repairMode === "ask") {
      let approved = false;
      try {
        approved = await options.confirmRepair?.(report, repairRounds + 1, targets.map(target => target.finding), businessFailures) ?? false;
      } catch (error) {
        if (options.signal?.aborted) return cancelled();
        return finish("agent_error", error);
      }
      if (options.signal?.aborted) return cancelled();
      if (!approved) {
        return finish(outcome);
      }
    }
    repairRounds++;
    nextPrompt = [
      "The host ran a fresh project check after your previous response, using the configured build backend.",
      "Repair only the listed locatedFindings and reported compilation, test or business-acceptance failures. Use each finding's location and review rationale to preserve the requested behavior. Leave other warnings for review.",
      ...(businessFailures ? [`Independent business assertions failed for this build:\n${businessFailures.join("\n")}`] : []),
      "Project findings and dependency findings have different origins. Do not change third-party libraries to clear project checks.",
      "When a comparison is present, it is against the project before this task. Existing findings still count; a removed finding is not proof of a correct fix or a false-positive decision.",
      "Do not remove functionality, suppress detectors, alter analysis or build configuration, modify/delete/skip existing tests, or fabricate passing test results to make a check pass.",
      "Missing tests are not a passing result. The javac backend does not execute project tests; do not repeatedly repair code merely because its test stage is not_run.",
      "You may invoke taie_analyze to inspect your edits. The host will independently verify again after you finish.",
      `Repair round ${repairRounds}/${options.maxRepairs}.`,
      formatReport(report, targets),
    ].join("\n\n");
  }
}

export function formatReport(report: CheckResult, targets?: LocatedFinding[]): string {
  // Keep stage decisions and evidence paths ahead of potentially large finding descriptions.
  // Dependency details stay in the immutable full report, outside project repair input.
  const summary = JSON.stringify({
    schemaVersion: report.schemaVersion, backend: report.backend, status: report.status,
    stages: report.stages, findingCounts: report.findingCounts,
    reportPath: report.reportPath, humanReportPath: report.humanReportPath,
    backendReportPath: report.backendReportPath, backendStatus: report.backendStatus,
    comparison: report.comparison && {
      status: report.comparison.status, reason: report.comparison.reason,
      baselineReportPath: report.comparison.baselineReportPath, currentReportPath: report.comparison.currentReportPath,
      baselineStatus: report.comparison.baselineStatus, currentStatus: report.comparison.currentStatus,
      stageChanges: report.comparison.stageChanges, counts: report.comparison.counts,
      limitations: report.comparison.limitations,
    },
    analyses: report.analyses, diagnostics: report.diagnostics,
    ...(targets ? { locatedFindings: targets.map(({ finding, review }) => ({
      id: finding.id, type: finding.type, sourcePath: finding.sourcePath, className: finding.className,
      method: finding.method, startLine: finding.startLine, snippet: finding.snippet,
      ruleClaim: review.ruleClaim, rationale: review.rationale, assumptions: review.assumptions,
    })) } : { findings: report.findings }),
    limitations: report.limitations,
  }, null, 2);
  const scope = targets ? "locatedFindings contains only the repair targets from this check's read-only reviews."
    : "The findings array contains project findings only; dependency counts are separate and do not determine project status. Review has not run; do not infer correctness or a false-positive verdict from zero findings.";
  return `${scope}\n${summary.length <= 24_000 ? summary : `${summary.slice(0, 24_000)}\n[Truncated; read full report: ${report.reportPath}]`}`;
}
