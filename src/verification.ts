import type { AnalysisReport } from "./taie.ts";

export type Outcome = "verified" | "skipped" | "unresolved" | "analysis_error" | "agent_error";
export type RepairMode = "ask" | "auto" | "off";
export interface VerificationResult {
  outcome: Outcome;
  checks: AnalysisReport[];
  repairRounds: number;
  error?: string;
}

export interface VerificationOptions {
  prompt: (text: string) => Promise<void>;
  analyze: () => Promise<AnalysisReport>;
  task: string;
  maxRepairs: number;
  /** Existing API callers retain automatic repair when this is omitted. */
  repairMode?: RepairMode;
  confirmRepair?: (report: AnalysisReport, nextRound: number) => Promise<boolean>;
  /** Skip host Tai-e verification for this task; the outcome remains unverified. */
  skipTaie?: boolean;
  onCheck?: (report: AnalysisReport) => void;
}

/** The host, not the model, owns the final fresh build and analysis. */
export async function verifyTask(options: VerificationOptions): Promise<VerificationResult> {
  const checks: AnalysisReport[] = [];
  let repairRounds = 0;
  let nextPrompt = options.task;
  for (;;) {
    try {
      await options.prompt(nextPrompt);
    } catch (error) {
      return { outcome: "agent_error", checks, repairRounds, error: String(error) };
    }
    if (options.skipTaie) {
      return { outcome: "skipped", checks: [], repairRounds: 0 };
    }
    let report: AnalysisReport;
    try {
      report = await options.analyze();
    } catch (error) {
      return { outcome: "analysis_error", checks, repairRounds, error: String(error) };
    }
    checks.push(report);
    options.onCheck?.(report);
    if (report.status === "completed" && report.findings.length === 0) {
      return { outcome: "verified", checks, repairRounds };
    }
    if (report.status !== "completed" && report.status !== "compile_failed") {
      return { outcome: "analysis_error", checks, repairRounds };
    }
    if (repairRounds >= options.maxRepairs) {
      return { outcome: report.status === "completed" ? "unresolved" : "analysis_error", checks, repairRounds };
    }
    const repairMode = options.repairMode ?? "auto";
    if (repairMode === "off") {
      return { outcome: report.status === "completed" ? "unresolved" : "analysis_error", checks, repairRounds };
    }
    if (repairMode === "ask") {
      let approved = false;
      try {
        approved = await options.confirmRepair?.(report, repairRounds + 1) ?? false;
      } catch (error) {
        return { outcome: "agent_error", checks, repairRounds, error: String(error) };
      }
      if (!approved) {
        return { outcome: report.status === "completed" ? "unresolved" : "analysis_error", checks, repairRounds };
      }
    }
    repairRounds++;
    nextPrompt = [
      "The host ran a fresh Java compilation and Tai-e verification after your previous response.",
      "Review the evidence below and fix the reported defects or compilation errors while preserving the requested behavior.",
      "Read the raw report/log files if the summary is insufficient. Do not claim an unverified warning is a false positive.",
      "Do not remove functionality, suppress detectors, alter analysis configuration, or delete tests to make a warning disappear.",
      "You may invoke taie_analyze to inspect your edits. The host will independently verify again after you finish.",
      `Repair round ${repairRounds}/${options.maxRepairs}.`,
      formatReport(report),
    ].join("\n\n");
  }
}

export function formatReport(report: AnalysisReport): string {
  // Keep the complete immutable report on disk even when model context is bounded.
  const summary = JSON.stringify(report, null, 2);
  return summary.length <= 24_000 ? summary : `${summary.slice(0, 24_000)}\n[Truncated; read full report: ${report.reportPath}]`;
}
