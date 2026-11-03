import type { CheckResult } from "./check.ts";

export type Outcome = "verified" | "skipped" | "unresolved" | "check_failed" | "incomplete" | "agent_error";
export type RepairMode = "ask" | "auto" | "off";
export interface VerificationResult {
  schemaVersion: 2;
  outcome: Outcome;
  checks: CheckResult[];
  repairRounds: number;
  error?: string;
}

export interface VerificationOptions {
  prompt: (text: string) => Promise<void>;
  analyze: () => Promise<CheckResult>;
  task: string;
  maxRepairs: number;
  /** Existing API callers retain automatic repair when this is omitted. */
  repairMode?: RepairMode;
  confirmRepair?: (report: CheckResult, nextRound: number) => Promise<boolean>;
  /** Skip the complete host check for this task; the outcome remains unverified. */
  skipTaie?: boolean;
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

/** The host owns a fresh build, project test and analysis check after each model response. */
export async function verifyTask(options: VerificationOptions): Promise<VerificationResult> {
  const checks: CheckResult[] = [];
  let repairRounds = 0;
  let nextPrompt = options.task;
  const finish = (outcome: Outcome, error?: unknown): VerificationResult => ({
    schemaVersion: 2, outcome, checks, repairRounds, ...(error === undefined ? {} : { error: String(error) }),
  });
  for (;;) {
    try {
      await options.prompt(nextPrompt);
    } catch (error) {
      return finish("agent_error", error);
    }
    if (options.skipTaie) {
      return finish("skipped");
    }
    let report: CheckResult;
    try {
      report = await options.analyze();
    } catch (error) {
      return finish("check_failed", error);
    }
    checks.push(report);
    options.onCheck?.(report);
    if (isCheckPassed(report)) return finish("verified");
    const outcome = unfinishedOutcome(report);
    const repairMode = options.repairMode ?? "auto";
    if (!isRepairableCheck(report) || repairRounds >= options.maxRepairs || repairMode === "off") return finish(outcome);
    if (repairMode === "ask") {
      let approved = false;
      try {
        approved = await options.confirmRepair?.(report, repairRounds + 1) ?? false;
      } catch (error) {
        return finish("agent_error", error);
      }
      if (!approved) {
        return finish(outcome);
      }
    }
    repairRounds++;
    nextPrompt = [
      "The host ran a fresh project check after your previous response, using the configured build backend.",
      "Review the build, test and static-analysis evidence below. Fix the reported code defects, compilation errors or failing behavior while preserving the requested functionality.",
      "Read the report and test/log evidence if this summary is insufficient. Do not claim an unreviewed warning is a false positive.",
      "Project findings and dependency findings have different origins. Do not change third-party libraries to clear project checks.",
      "Do not remove functionality, suppress detectors, alter analysis or build configuration, modify/delete/skip existing tests, or fabricate passing test results to make a check pass.",
      "Missing tests are not a passing result. The javac backend does not execute project tests; do not repeatedly repair code merely because its test stage is not_run.",
      "You may invoke taie_analyze to inspect your edits. The host will independently verify again after you finish.",
      `Repair round ${repairRounds}/${options.maxRepairs}.`,
      formatReport(report),
    ].join("\n\n");
  }
}

export function formatReport(report: CheckResult): string {
  // Keep stage decisions and evidence paths ahead of potentially large finding descriptions.
  // Dependency details stay in the immutable full report, outside project repair input.
  const summary = JSON.stringify({
    schemaVersion: report.schemaVersion, backend: report.backend, status: report.status,
    stages: report.stages, findingCounts: report.findingCounts,
    reportPath: report.reportPath, humanReportPath: report.humanReportPath,
    backendReportPath: report.backendReportPath, backendStatus: report.backendStatus,
    analyses: report.analyses, diagnostics: report.diagnostics, findings: report.findings,
    limitations: report.limitations,
  }, null, 2);
  const scope = "The findings array contains project findings only; dependency counts are separate and do not determine project status. Review has not run; do not infer correctness or a false-positive verdict from zero findings.";
  return `${scope}\n${summary.length <= 24_000 ? summary : `${summary.slice(0, 24_000)}\n[Truncated; read full report: ${report.reportPath}]`}`;
}
