import test from "node:test";
import assert from "node:assert/strict";
import { formatReport, isCheckPassed, isRepairableCheck, verifyTask as runVerification, type VerificationOptions } from "../src/verification.ts";
import type { CheckResult } from "../src/check.ts";
import type { ReviewResult } from "../src/review.ts";

function locatedReview(check: CheckResult, finding: CheckResult["findings"][number]): ReviewResult {
  const runDir = check.runDir + "/review/" + finding.id;
  return {
    schemaVersion: 1, status: "completed", startedAt: "2026-11-18T00:00:00Z",
    projectDir: check.projectDir, runDir, reportPath: runDir + "/review.json", humanReportPath: runDir + "/review.md",
    input: { reportPath: check.reportPath, reportSha256: "check-hash", findingId: finding.id, evidenceSha256: "evidence-hash" },
    applicability: "recorded_input_only", currentWorkspace: "not_checked", disposition: "pending_human",
    evidenceLevel: "E1_model_explanation", affectsCheckStatus: false, provider: "test", model: "test",
    diagnostics: [], limitations: [],
    suggestion: { findingId: finding.id, assessment: "true_positive", ruleClaim: "Result is discarded",
      rationale: "The normalized value is discarded before returning.", evidenceRefs: ["finding"],
      coverage: "whole_finding", assumptions: [], missingEvidence: [] },
  };
}

const verifyTask = (options: VerificationOptions) => runVerification({
  baselineEnabled: false, reviewFinding: async (check, finding) => locatedReview(check, finding), ...options,
});

function report(status: CheckResult["status"], hasFinding = false): CheckResult {
  return {
    schemaVersion: 1, backend: "maven-docker", statusScope: "project",
    status: status === "passed" && hasFinding ? "findings" : status,
    projectDir: "/test-project", runDir: "/test-project/run", reportPath: "/test-project/check.json",
    humanReportPath: "/test-project/check.md", backendReportPath: "/test-project/report.json", backendStatus: status,
    analyses: ["dead-code"], diagnostics: [], limitations: [],
    stages: {
      build: status === "build_failed" ? "failed" : "passed",
      test: { status: status === "test_failed" ? "failed" : status === "build_failed" || status === "tests_not_run" ? "not_run" : "passed",
        tests: status === "tests_not_run" || status === "build_failed" ? 0 : 1,
        failures: status === "test_failed" ? 1 : 0, errors: 0, skipped: 0, reportFiles: ["/test-project/TEST-example.xml"] },
      analysis: status === "build_failed" ? "not_run" : status === "analysis_failed" ? "failed" : "completed",
      review: "not_run",
    },
    findings: hasFinding ? [{ id: "project-finding", origin: "project", analysis: "dead-code", type: "TEST_DEFECT",
      sourcePath: "src/Example.java", startLine: 12, snippet: "name.trim();", message: "Test defect evidence" }] : [],
    findingCounts: { project: hasFinding ? 1 : 0, dependency: 0, total: hasFinding ? 1 : 0 },
  };
}

test("the default baseline is captured before the original task and stays separate from final checks", async () => {
  const baseline = report("findings", true);
  const final = report("passed");
  const order: string[] = [];
  let scans = 0;
  const result = await runVerification({
    task: "Implement the requested feature", maxRepairs: 1, repairMode: "ask",
    analyze: async previous => {
      if (scans++ === 0) {
        assert.equal(previous, undefined);
        order.push("baseline");
        return baseline;
      }
      assert.equal(previous, baseline);
      order.push("final");
      return final;
    },
    onBaseline: value => {
      assert.deepEqual(value, { status: "completed", check: baseline });
      order.push("baseline callback");
    },
    onStatus: text => { order.push(text); },
    prompt: async text => { assert.equal(text, "Implement the requested feature"); order.push("model"); },
    onCheck: value => { assert.equal(value, final); order.push("check callback"); },
    confirmRepair: async () => { assert.fail("Pre-existing findings do not authorize a repair before the original task"); },
  });
  assert.deepEqual(order, ["正在记录基线（构建/测试/分析）。", "baseline", "baseline callback", "正在等待模型回复。", "model", "正在执行最终检查（构建/测试/分析）。", "final", "check callback"]);
  assert.equal(result.outcome, "verified");
  assert.deepEqual(result.baseline, { status: "completed", check: baseline });
  assert.deepEqual(result.checks, [final]);
  assert.equal(result.repairRounds, 0);
});

test("an already cancelled task starts neither a baseline nor a model request", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runVerification({
    task: "Write code", maxRepairs: 1, signal: controller.signal,
    prompt: async () => { assert.fail("Cancelled tasks must not prompt"); },
    analyze: async () => { assert.fail("Cancelled tasks must not analyze"); },
  });
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.outcome, "agent_error");
  assert.equal(result.error, "Agent task cancelled.");
  assert.deepEqual(result.checks, []);
});

test("cancelling during the baseline preserves its report without starting the model", async () => {
  const controller = new AbortController();
  const baseline = report("findings", true);
  let captured: CheckResult | undefined;
  const result = await runVerification({
    task: "Write code", maxRepairs: 1, signal: controller.signal,
    analyze: async () => { controller.abort(); return baseline; },
    onBaseline: value => { captured = value.check; },
    prompt: async () => { assert.fail("Cancellation after baseline must not prompt"); },
  });
  assert.equal(result.outcome, "agent_error");
  assert.equal(result.error, "Agent task cancelled.");
  assert.equal(result.baseline.check, baseline);
  assert.equal(captured, baseline);
  assert.deepEqual(result.checks, []);
  assert.equal(result.repairRounds, 0);
});

test("cancelling the model stops before host verification, including when the model throws", async () => {
  for (const throws of [false, true]) {
    const controller = new AbortController();
    const result = await verifyTask({
      task: "Write code", maxRepairs: 1, signal: controller.signal,
      prompt: async () => { controller.abort(); if (throws) throw new Error("Request aborted"); },
      analyze: async () => { assert.fail("Cancellation after model must not start another check"); },
    });
    assert.equal(result.outcome, "agent_error");
    assert.equal(result.error, "Agent task cancelled.");
    assert.deepEqual(result.checks, []);
    assert.equal(result.repairRounds, 0);
  }
});

test("cancelling a final check preserves evidence without passing or requesting repair", async () => {
  for (const status of ["passed", "findings"] as const) {
    const controller = new AbortController();
    const original = report(status, status === "findings");
    let prompts = 0;
    let captured: CheckResult | undefined;
    const result = await verifyTask({
      task: "Write code", maxRepairs: 1, repairMode: "ask", signal: controller.signal,
      prompt: async () => { prompts++; },
      analyze: async () => { controller.abort(); return original; },
      onCheck: value => { captured = value; },
      confirmRepair: async () => { assert.fail("Cancelled tasks must not request a repair"); },
    });
    assert.equal(result.outcome, "agent_error");
    assert.equal(result.error, "Agent task cancelled.");
    assert.deepEqual(result.checks, [original]);
    assert.equal(captured, original);
    assert.equal(prompts, 1);
    assert.equal(result.repairRounds, 0);
  }
});

test("cancelling while approving a repair keeps the report without spending a repair round", async () => {
  const controller = new AbortController();
  const original = report("findings", true);
  let prompts = 0;
  const result = await verifyTask({
    task: "Write code", maxRepairs: 1, repairMode: "ask", signal: controller.signal,
    prompt: async () => { prompts++; },
    analyze: async () => original,
    confirmRepair: async () => { controller.abort(); return true; },
  });
  assert.equal(result.outcome, "agent_error");
  assert.equal(result.error, "Agent task cancelled.");
  assert.deepEqual(result.checks, [original]);
  assert.equal(prompts, 1);
  assert.equal(result.repairRounds, 0);
});

test("failed baseline reports are preserved and still allow the original code-creation task", async () => {
  for (const status of ["build_failed", "test_failed", "analysis_failed", "unsupported", "stale", "timeout", "error"] as const) {
    const baseline = report(status, true);
    let scans = 0;
    let createdCode = false;
    const result = await runVerification({
      task: "Create a new Java project", maxRepairs: 0,
      analyze: async previous => {
        if (scans++ === 0) return baseline;
        assert.equal(previous, baseline);
        assert.equal(createdCode, true);
        return report("passed");
      },
      prompt: async () => { createdCode = true; },
    });
    assert.equal(result.outcome, "verified");
    assert.deepEqual(result.baseline, { status: "failed", check: baseline });
    assert.equal(result.baseline.check?.findings.length, 1, "Partial baseline evidence must not become an empty clean baseline");
    assert.equal(result.checks.length, 1);
  }
});

test("a throwing baseline records failure without inventing a clean report or blocking code creation", async () => {
  let scans = 0;
  let prompted = false;
  const result = await runVerification({
    task: "Create the first source file", maxRepairs: 0,
    analyze: async previous => {
      assert.equal(previous, undefined);
      if (scans++ === 0) throw new Error("No Java source files found");
      assert.equal(prompted, true);
      return report("passed");
    },
    prompt: async () => { prompted = true; },
  });
  assert.equal(result.outcome, "verified");
  assert.deepEqual(result.baseline, { status: "failed", error: "Error: No Java source files found" });
  assert.equal(result.checks.length, 1);
  assert.equal(scans, 2);
});

test("all post-task checks receive the original baseline across authorized repair rounds", async () => {
  const baseline = report("tests_not_run", true);
  const first = report("findings", true);
  const second = report("test_failed");
  const final = report("passed");
  const reports = [baseline, first, second, final];
  const comparisons: (CheckResult | undefined)[] = [];
  const approved: CheckResult[] = [];
  let baselineCallbacks = 0;
  const result = await runVerification({
    task: "Add the feature", maxRepairs: 2, repairMode: "ask",
    reviewFinding: async (check, finding) => locatedReview(check, finding),
    analyze: async previous => { comparisons.push(previous); return reports[comparisons.length - 1]; },
    onBaseline: value => { baselineCallbacks++; assert.equal(value.status, "completed"); },
    prompt: async () => {},
    confirmRepair: async value => { approved.push(value); return true; },
  });
  assert.deepEqual(comparisons, [undefined, baseline, baseline, baseline]);
  assert.deepEqual(approved, [first, second]);
  assert.deepEqual(result.checks, [first, second, final]);
  assert.equal(result.baseline.check, baseline);
  assert.equal(baselineCallbacks, 1);
  assert.equal(result.repairRounds, 2);
  assert.equal(result.outcome, "verified");
});

test("baseline off keeps the final check while skip disables both checks", async () => {
  for (const skipTaie of [false, true]) {
    let scans = 0;
    let prompts = 0;
    const statuses: string[] = [];
    const result = await runVerification({
      task: "Write code", maxRepairs: 0, skipTaie,
      ...(skipTaie ? {} : { baselineEnabled: false }),
      prompt: async () => { prompts++; },
      analyze: async previous => { assert.equal(previous, undefined); scans++; return report("passed"); },
      onBaseline: value => { statuses.push(value.status); assert.equal(value.check, undefined); },
    });
    assert.equal(scans, skipTaie ? 0 : 1);
    assert.equal(prompts, 1);
    assert.deepEqual(statuses, [skipTaie ? "skipped" : "disabled"]);
    assert.equal(result.outcome, skipTaie ? "skipped" : "verified");
  }
});

test("the host analyzes after the model finishes without calling any tools", async () => {
  const order: string[] = [];
  const result = await verifyTask({
    task: "Write code", maxRepairs: 2,
    prompt: async () => { order.push("model stopped"); },
    analyze: async () => { order.push("host analysis"); return report("passed"); },
  });
  assert.deepEqual(order, ["model stopped", "host analysis"]);
  assert.equal(result.outcome, "verified");
});

test("business assertions gate verification and hand only the failed behavior to an approved repair", async () => {
  const first = report("passed");
  const second = { ...report("passed"), reportPath: "/test-project/fixed/check.json" };
  const checks = [first, second];
  const inspected: CheckResult[] = [];
  const prompts: string[] = [];
  const failure = "empty order shipping: expected 0, got 600";
  const evidence = "/independent/acceptance-output.txt";
  const result = await verifyTask({
    task: "Price an order", maxRepairs: 1, repairMode: "ask",
    prompt: async text => { prompts.push(text); },
    analyze: async () => checks.shift()!,
    acceptBusiness: async check => {
      inspected.push(check);
      return check === first ? { status: "failed", failures: [failure], reportPath: evidence } : { status: "passed" };
    },
    confirmRepair: async (check, round, findings, failures) => {
      assert.equal(check, first);
      assert.equal(round, 1);
      assert.deepEqual(findings, []);
      assert.deepEqual(failures, [failure]);
      return true;
    },
  });
  assert.equal(result.outcome, "verified");
  assert.equal(result.repairRounds, 1);
  assert.deepEqual(inspected, [first, second]);
  assert.deepEqual(result.businessChecks, [
    { checkReportPath: first.reportPath, status: "failed", failures: [failure], reportPath: evidence },
    { checkReportPath: second.reportPath, status: "passed" },
  ]);
  assert.ok(prompts[1].includes(failure));
  assert.ok(!prompts[1].includes(evidence));
});

test("a failed business assertion blocks a mechanically clean task even with repairs off", async () => {
  const result = await verifyTask({
    task: "Price an order", maxRepairs: 1, repairMode: "off",
    prompt: async () => {}, analyze: async () => report("passed"),
    acceptBusiness: async () => ({ status: "failed", failures: ["empty order charged shipping"] }),
  });
  assert.equal(result.outcome, "unresolved");
  assert.equal(result.repairRounds, 0);
});

test("an unavailable independent runner fails the check without spending a repair round", async () => {
  const result = await verifyTask({
    task: "Price an order", maxRepairs: 1,
    prompt: async () => {}, analyze: async () => report("passed"),
    acceptBusiness: async () => { throw new Error("runner unavailable"); },
  });
  assert.equal(result.outcome, "check_failed");
  assert.equal(result.repairRounds, 0);
  assert.equal(result.businessChecks?.[0].status, "error");
  assert.match(result.error ?? "", /runner unavailable/);
});

test("a reviewed location and its rationale reach the repair before a fresh passing check", async () => {
  const prompts: string[] = [];
  const order: string[] = [];
  let scans = 0;
  const result = await verifyTask({
    task: "Fix code", maxRepairs: 2,
    prompt: async text => { order.push(prompts.length ? "repair" : "write"); prompts.push(text); },
    analyze: async () => { order.push("check"); return report("passed", scans++ === 0); },
    reviewFinding: async (check, finding) => { order.push("review " + finding.id); return locatedReview(check, finding); },
  });
  assert.deepEqual(order, ["write", "check", "review project-finding", "repair", "check"]);
  assert.equal(result.outcome, "verified");
  assert.equal(result.repairRounds, 1);
  assert.deepEqual(result.reviews.map(({ findingId, checkReportPath, repairTarget }) => ({ findingId, checkReportPath, repairTarget })),
    [{ findingId: "project-finding", checkReportPath: result.checks[0].reportPath, repairTarget: true }]);
  assert.match(prompts[1], /project-finding/);
  assert.match(prompts[1], /src\/Example\.java/);
  assert.match(prompts[1], /normalized value is discarded/);
});

test("a mixed report sends only located defects for repair and leaves pending evidence unresolved", async () => {
  const first = report("findings", true);
  const pending = { ...first.findings[0], id: "other-warning", message: "Unverified warning from another method" };
  first.findings.push(pending);
  first.findingCounts.project = first.findingCounts.total = 2;
  const remaining = report("findings", true);
  remaining.reportPath = "/test-project/after-repair/check.json";
  remaining.findings = [pending];
  const reports = [first, remaining];
  const prompts: string[] = [];
  const result = await verifyTask({
    task: "Fix code", maxRepairs: 2, repairMode: "auto",
    analyze: async () => reports.shift()!,
    prompt: async text => { prompts.push(text); },
    reviewFinding: async (check, finding) => {
      const review = locatedReview(check, finding);
      if (finding.id === pending.id)
        review.suggestion = { ...review.suggestion!, assessment: "analysis_incomplete", coverage: "insufficient",
          missingEvidence: ["Caller implementation"] };
      return review;
    },
  });
  assert.equal(result.outcome, "unresolved");
  assert.equal(result.repairRounds, 1);
  assert.deepEqual(result.checks, [first, remaining]);
  assert.deepEqual(first.findings.map(finding => finding.id), ["project-finding", "other-warning"]);
  assert.deepEqual(result.reviews.map(item => [item.checkReportPath, item.findingId, item.repairTarget]),
    [[first.reportPath, "project-finding", true], [first.reportPath, "other-warning", false], [remaining.reportPath, "other-warning", false]]);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /project-finding/);
  assert.doesNotMatch(prompts[1], /Unverified warning from another method/);
});

test("a failed analyzer with no findings is never accepted as verified", async () => {
  let prompts = 0;
  const result = await verifyTask({
    task: "Write code", maxRepairs: 2,
    repairMode: "ask",
    confirmRepair: async () => { assert.fail("An analyzer failure must not request a code repair"); },
    prompt: async () => { prompts++; },
    analyze: async () => report("analysis_failed"),
  });
  assert.equal(result.outcome, "check_failed");
  assert.equal(prompts, 1);
});

test("unresolved warnings survive exhaustion of the repair budget", async () => {
  const result = await verifyTask({
    task: "Fix code", maxRepairs: 1,
    prompt: async () => {}, analyze: async () => report("passed", true),
  });
  assert.equal(result.outcome, "unresolved");
  assert.equal(result.checks.length, 2);
  assert.equal(result.checks.at(-1)?.findings.length, 1);
});

test("compilation errors can be repaired but provider errors cannot produce a clean outcome", async () => {
  let scans = 0;
  const repaired = await verifyTask({
    task: "Write code", maxRepairs: 1, prompt: async () => {},
    analyze: async () => report(scans++ === 0 ? "build_failed" : "passed"),
  });
  assert.equal(repaired.outcome, "verified");
  const failed = await verifyTask({
    task: "Write code", maxRepairs: 1,
    prompt: async () => { throw new Error("provider unavailable"); },
    analyze: async () => { throw new Error("must not run"); },
  });
  assert.equal(failed.outcome, "agent_error");
  assert.equal(failed.checks.length, 0);
  assert.match(failed.error ?? "", /provider unavailable/);
});

test("skipping Tai-e runs the task once without analysis, check callbacks, or repair feedback", async () => {
  const prompts: string[] = [];
  const result = await verifyTask({
    task: "Write code without Tai-e this round", maxRepairs: 3, skipTaie: true,
    repairMode: "ask",
    confirmRepair: async () => { assert.fail("Skipped verification must not ask about a repair"); },
    prompt: async text => { prompts.push(text); },
    analyze: async () => { assert.fail("Skipped verification must not analyze"); },
    onCheck: () => { assert.fail("Skipped verification must not report a host check"); },
  });
  assert.deepEqual(prompts, ["Write code without Tai-e this round"]);
  assert.deepEqual(result, { schemaVersion: 2, outcome: "skipped", checks: [], reviews: [], baseline: { status: "skipped" }, repairRounds: 0 });
  assert.notEqual(result.outcome, "verified");
});

test("a skipped task does not disable normal verification and repair for the next task", async () => {
  const prompts: string[] = [];
  const checked: CheckResult[] = [];
  let scans = 0;
  const callbacks = {
    prompt: async (text: string) => { prompts.push(text); },
    analyze: async () => report("passed", scans++ === 0),
    onCheck: (value: CheckResult) => { checked.push(value); },
  };
  const skipped = await verifyTask({ ...callbacks, task: "Skip this task", maxRepairs: 2, skipTaie: true });
  assert.equal(skipped.outcome, "skipped");
  assert.equal(scans, 0);
  assert.equal(checked.length, 0);

  const verified = await verifyTask({ ...callbacks, task: "Verify this task", maxRepairs: 2 });
  assert.equal(verified.outcome, "verified");
  assert.equal(verified.repairRounds, 1);
  assert.equal(scans, 2);
  assert.deepEqual(checked, verified.checks);
  assert.equal(checked.length, 2);
  assert.equal(prompts.length, 3);
  assert.equal(prompts[1], "Verify this task");
  assert.match(prompts[2], /TEST_DEFECT/);
  assert.match(prompts[2], /Repair round 1\/2/);
});

test("skipping Tai-e does not hide provider failures", async () => {
  let prompts = 0;
  const result = await verifyTask({
    task: "Write code", maxRepairs: 2, skipTaie: true,
    prompt: async () => { prompts++; throw new Error("provider unavailable during skipped task"); },
    analyze: async () => { assert.fail("A failed prompt must not analyze"); },
    onCheck: () => { assert.fail("A failed prompt must not report a host check"); },
  });
  assert.equal(prompts, 1);
  assert.equal(result.outcome, "agent_error");
  assert.deepEqual(result.checks, []);
  assert.equal(result.repairRounds, 0);
  assert.match(result.error ?? "", /provider unavailable during skipped task/);
});

test("ask mode obtains approval for each warning or compilation repair before prompting again", async () => {
  const reports = [report("passed", true), report("build_failed"), report("passed")];
  const prompts: string[] = [];
  const confirmations: { report: CheckResult; nextRound: number }[] = [];
  const events: string[] = [];
  let scans = 0;
  const result = await verifyTask({
    task: "Implement feature", maxRepairs: 2, repairMode: "ask",
    prompt: async text => { prompts.push(text); events.push("prompt"); },
    analyze: async () => { events.push("analyze"); return reports[scans++]; },
    onCheck: () => { events.push("check"); },
    confirmRepair: async (value, nextRound) => {
      confirmations.push({ report: value, nextRound });
      events.push(`confirm ${nextRound}`);
      return true;
    },
  });
  assert.equal(result.outcome, "verified");
  assert.equal(result.repairRounds, 2);
  assert.deepEqual(result.checks, reports);
  assert.deepEqual(confirmations, [{ report: reports[0], nextRound: 1 }, { report: reports[1], nextRound: 2 }]);
  assert.deepEqual(events, ["prompt", "analyze", "check", "confirm 1", "prompt", "analyze", "check", "confirm 2", "prompt", "analyze", "check"]);
  assert.equal(prompts[0], "Implement feature");
  assert.match(prompts[1], /TEST_DEFECT/);
  assert.match(prompts[2], /build_failed/);
});

test("declining a repair preserves unresolved warnings and compilation failures without another prompt", async () => {
  for (const status of ["passed", "build_failed"] as const) {
    const original = report(status, status === "passed");
    let prompts = 0;
    let confirmations = 0;
    const result = await verifyTask({
      task: "Write code", maxRepairs: 2, repairMode: "ask",
      prompt: async () => { prompts++; },
      analyze: async () => original,
      confirmRepair: async (value, nextRound) => {
        confirmations++;
        assert.equal(value, original);
        assert.equal(nextRound, 1);
        return false;
      },
    });
    assert.equal(result.outcome, status === "passed" ? "unresolved" : "check_failed");
    assert.deepEqual(result.checks, [original]);
    assert.equal(result.repairRounds, 0);
    assert.equal(prompts, 1);
    assert.equal(confirmations, 1);
  }
});

test("ask mode without a confirmation callback leaves the report unresolved", async () => {
  for (const status of ["passed", "build_failed"] as const) {
    let prompts = 0;
    let scans = 0;
    const result = await verifyTask({
      task: "Write code", maxRepairs: 2, repairMode: "ask",
      prompt: async () => { prompts++; },
      analyze: async () => { scans++; return report(status, status === "passed"); },
    });
    assert.equal(result.outcome, status === "passed" ? "unresolved" : "check_failed");
    assert.equal(result.repairRounds, 0);
    assert.equal(result.checks.length, 1);
    assert.equal(prompts, 1);
    assert.equal(scans, 1);
  }
});

test("off mode still analyzes and preserves evidence but never repairs or asks", async () => {
  for (const status of ["passed", "build_failed"] as const) {
    const original = report(status, status === "passed");
    let prompts = 0;
    let scans = 0;
    let checked: CheckResult | undefined;
    const result = await verifyTask({
      task: "Write code", maxRepairs: 5, repairMode: "off",
      prompt: async () => { prompts++; },
      analyze: async () => { scans++; return original; },
      onCheck: value => { checked = value; },
      confirmRepair: async () => { assert.fail("off mode must not request confirmation"); },
    });
    assert.equal(result.outcome, status === "passed" ? "unresolved" : "check_failed");
    assert.deepEqual(result.checks, [original]);
    assert.equal(checked, original);
    assert.equal(result.repairRounds, 0);
    assert.equal(prompts, 1);
    assert.equal(scans, 1);
  }
});

test("explicit auto mode repairs without consulting the confirmation callback", async () => {
  let prompts = 0;
  let scans = 0;
  const result = await verifyTask({
    task: "Write code", maxRepairs: 1, repairMode: "auto",
    prompt: async () => { prompts++; },
    analyze: async () => report("passed", scans++ === 0),
    confirmRepair: async () => { assert.fail("auto mode must not request confirmation"); },
  });
  assert.equal(result.outcome, "verified");
  assert.equal(result.repairRounds, 1);
  assert.equal(prompts, 2);
  assert.equal(scans, 2);
});

test("an exhausted repair budget never asks permission for another round", async () => {
  let prompts = 0;
  const rounds: number[] = [];
  const result = await verifyTask({
    task: "Fix code", maxRepairs: 1, repairMode: "ask",
    prompt: async () => { prompts++; },
    analyze: async () => report("passed", true),
    confirmRepair: async (_value, nextRound) => { rounds.push(nextRound); return true; },
  });
  assert.equal(result.outcome, "unresolved");
  assert.equal(result.repairRounds, 1);
  assert.equal(result.checks.length, 2);
  assert.equal(prompts, 2);
  assert.deepEqual(rounds, [1]);

  const zeroBudget = await verifyTask({
    task: "Write code", maxRepairs: 0, repairMode: "ask",
    prompt: async () => {},
    analyze: async () => report("build_failed"),
    confirmRepair: async () => { assert.fail("A zero repair budget must not request confirmation"); },
  });
  assert.equal(zeroBudget.outcome, "check_failed");
  assert.equal(zeroBudget.repairRounds, 0);
});

test("a failed confirmation returns agent_error and retains the check without spending a repair round", async () => {
  const original = report("passed", true);
  let prompts = 0;
  const result = await verifyTask({
    task: "Write code", maxRepairs: 2, repairMode: "ask",
    prompt: async () => { prompts++; },
    analyze: async () => original,
    confirmRepair: async () => { throw new Error("confirmation input failed"); },
  });
  assert.equal(result.outcome, "agent_error");
  assert.match(result.error ?? "", /confirmation input failed/);
  assert.deepEqual(result.checks, [original]);
  assert.equal(result.repairRounds, 0);
  assert.equal(prompts, 1);
});

test("failed Maven tests with zero findings require approval and a fresh passing check", async () => {
  const failed = report("test_failed");
  const preserved = await verifyTask({ task: "Write code", maxRepairs: 1, repairMode: "off",
    prompt: async () => {}, analyze: async () => failed });
  assert.equal(preserved.outcome, "check_failed");
  assert.equal(preserved.schemaVersion, 2);
  assert.equal(preserved.repairRounds, 0);
  assert.deepEqual(preserved.checks[0].findings, []);

  const prompts: string[] = [];
  let scans = 0;
  let decisions = 0;
  const repaired = await verifyTask({ task: "Write code", maxRepairs: 1, repairMode: "ask",
    prompt: async text => { prompts.push(text); },
    analyze: async () => scans++ === 0 ? failed : report("passed"),
    confirmRepair: async (value, round) => {
      assert.equal(value, failed);
      assert.equal(round, 1);
      decisions++;
      return true;
    },
  });
  assert.equal(repaired.outcome, "verified");
  assert.equal(repaired.repairRounds, 1);
  assert.equal(scans, 2);
  assert.equal(decisions, 1);
  assert.match(prompts[1], /test_failed/);
  assert.match(prompts[1], /TEST-example\.xml/);
  assert.match(prompts[1], /modify\/delete\/skip existing tests/);
});

test("javac without tests is incomplete and missing tests alone never start a repair loop", async () => {
  const clean = report("tests_not_run");
  clean.backend = "javac";
  for (const repairMode of ["auto", "ask", "off"] as const) {
    let prompts = 0;
    const result = await verifyTask({ task: "Write code", maxRepairs: 3, repairMode,
      prompt: async () => { prompts++; }, analyze: async () => clean,
      confirmRepair: async () => { assert.fail("Missing tests are not an automatic code repair"); },
    });
    assert.equal(result.outcome, "incomplete");
    assert.equal(result.repairRounds, 0);
    assert.equal(prompts, 1);
  }
  const buggy = report("tests_not_run", true);
  buggy.backend = "javac";
  assert.equal(isRepairableCheck(buggy), true);
  let scans = 0;
  const result = await verifyTask({ task: "Fix code", maxRepairs: 3,
    prompt: async () => {}, analyze: async () => scans++ === 0 ? buggy : clean });
  assert.equal(result.outcome, "incomplete");
  assert.equal(result.repairRounds, 1);
  assert.equal(scans, 2);
  assert.equal(result.checks.at(-1)?.findings.length, 0);
});

test("passed requires actual tests, completed stages and no project findings even if a status is inconsistent", async () => {
  const cases: ((value: CheckResult) => void)[] = [
    value => { value.stages.build = "failed"; },
    value => { value.stages.test.status = "failed"; },
    value => { value.stages.test.status = "not_run"; },
    value => { value.stages.test.tests = 0; },
    value => { value.stages.test.skipped = value.stages.test.tests; },
    value => { value.stages.test.failures = 1; },
    value => { value.stages.test.errors = 1; },
    value => { value.stages.analysis = "failed"; },
    value => { value.findingCounts.project = 1; },
    value => { value.findings = report("findings", true).findings; },
  ];
  for (const change of cases) {
    const inconsistent = report("passed");
    change(inconsistent);
    assert.equal(isCheckPassed(inconsistent), false);
    const result = await verifyTask({ task: "Write code", maxRepairs: 1, repairMode: "ask",
      prompt: async () => {}, analyze: async () => inconsistent,
      confirmRepair: async () => { assert.fail("An inconsistent result must not authorize code repair"); },
    });
    assert.equal(result.outcome, "check_failed");
  }
});

test("stale input and infrastructure failures never trigger code repair even with partial findings", async () => {
  for (const status of ["stale", "timeout", "unsupported", "error", "analysis_failed"] as const) {
    const partial = report(status, true);
    assert.equal(isCheckPassed(partial), false);
    assert.equal(isRepairableCheck(partial), false);
    let prompts = 0;
    const result = await verifyTask({ task: "Write code", maxRepairs: 2, repairMode: "ask",
      prompt: async () => { prompts++; }, analyze: async () => partial,
      confirmRepair: async () => { assert.fail("Infrastructure errors must not authorize code repair"); },
    });
    assert.equal(result.outcome, "check_failed");
    assert.equal(prompts, 1);
    assert.equal(result.repairRounds, 0);
  }
  const preparationFailed = report("build_failed");
  preparationFailed.stages.build = "not_run";
  assert.equal(isRepairableCheck(preparationFailed), false, "dependency preparation failure is not a compilation defect");
  const crashed = await verifyTask({ task: "Write code", maxRepairs: 1, prompt: async () => {},
    analyze: async () => { throw new Error("backend unavailable"); } });
  assert.equal(crashed.outcome, "check_failed");
  assert.equal(crashed.checks.length, 0);
  assert.match(crashed.error ?? "", /backend unavailable/);
});

test("dependency findings remain separate from the project gate and model repair input", async () => {
  const clean = report("passed");
  clean.findingCounts = { project: 0, dependency: 1, total: 1 };
  clean.dependencyFindings = [{ id: "dependency-only", origin: "dependency", analysis: "dead-code",
    type: "LIBRARY_WARNING", message: "Library-only detail" }];
  const snapshot = structuredClone(clean);
  assert.equal(isCheckPassed(clean), true);
  const result = await verifyTask({ task: "Write code", maxRepairs: 1, prompt: async () => {}, analyze: async () => clean });
  assert.equal(result.outcome, "verified");
  const summary = formatReport(clean);
  assert.match(summary, /"dependency": 1/);
  assert.doesNotMatch(summary, /LIBRARY_WARNING|Library-only detail/);
  assert.match(summary, /project findings only/);
  assert.match(summary, /check\.md/);
  assert.deepEqual(clean, snapshot);
});

test("a bounded model summary keeps stage decisions and report paths ahead of long findings", () => {
  const long = report("findings", true);
  long.findings[0].message = "evidence ".repeat(5000);
  long.comparison = {
    schemaVersion: 1, status: "compared", baselineReportPath: "/baseline/check.json", currentReportPath: long.reportPath,
    baselineStatus: "findings", currentStatus: "findings",
    stageChanges: { build: { before: "passed", after: "passed" }, test: { before: "passed", after: "passed" }, analysis: { before: "completed", after: "completed" } },
    counts: { added: 1, removed: 0, persisting: 0, changed: 0 },
    added: long.findings, removed: [], persisting: [], changed: [], limitations: ["A removed finding does not prove a fix."],
  };
  const summary = formatReport(long);
  assert.match(summary, /"test"/);
  assert.match(summary, /"humanReportPath": "\/test-project\/check.md"/);
  assert.match(summary, /"baselineReportPath": "\/baseline\/check.json"/);
  assert.match(summary, /"added": 1/);
  assert.match(summary, /A removed finding does not prove a fix/);
  assert.ok(summary.indexOf('"comparison"') < summary.indexOf('"findings": ['));
  assert.match(summary, /\[Truncated; read full report: \/test-project\/check.json\]/);
  assert.ok(summary.length < 25_000);
  assert.equal(long.findings[0].message.length, 45000);
});
