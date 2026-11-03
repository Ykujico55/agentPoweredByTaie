import test from "node:test";
import assert from "node:assert/strict";
import { verifyTask } from "../src/verification.ts";
import type { AnalysisReport } from "../src/taie.ts";

function report(status: AnalysisReport["status"], hasFinding = false): AnalysisReport {
  return {
    status, projectDir: "/test-project", reportPath: "/test-project/report.json",
    findings: hasFinding ? [{ type: "TEST_DEFECT", message: "Test defect evidence" }] : [],
  } as AnalysisReport;
}

test("the host analyzes after the model finishes without calling any tools", async () => {
  const order: string[] = [];
  const result = await verifyTask({
    task: "Write code", maxRepairs: 2,
    prompt: async () => { order.push("model stopped"); },
    analyze: async () => { order.push("host analysis"); return report("completed"); },
  });
  assert.deepEqual(order, ["model stopped", "host analysis"]);
  assert.equal(result.outcome, "verified");
});

test("findings are sent back with evidence and the repaired code receives a fresh host check", async () => {
  const prompts: string[] = [];
  let scans = 0;
  const result = await verifyTask({
    task: "Fix code", maxRepairs: 2,
    prompt: async text => { prompts.push(text); },
    analyze: async () => report("completed", scans++ === 0),
  });
  assert.equal(result.outcome, "verified");
  assert.equal(result.repairRounds, 1);
  assert.equal(scans, 2);
  assert.match(prompts[1], /TEST_DEFECT/);
  assert.match(prompts[1], /report\.json/);
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
  assert.equal(result.outcome, "analysis_error");
  assert.equal(prompts, 1);
});

test("unresolved warnings survive exhaustion of the repair budget", async () => {
  const result = await verifyTask({
    task: "Fix code", maxRepairs: 1,
    prompt: async () => {}, analyze: async () => report("completed", true),
  });
  assert.equal(result.outcome, "unresolved");
  assert.equal(result.checks.length, 2);
  assert.equal(result.checks.at(-1)?.findings.length, 1);
});

test("compilation errors can be repaired but provider errors cannot produce a clean outcome", async () => {
  let scans = 0;
  const repaired = await verifyTask({
    task: "Write code", maxRepairs: 1, prompt: async () => {},
    analyze: async () => report(scans++ === 0 ? "compile_failed" : "completed"),
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
  assert.deepEqual(result, { outcome: "skipped", checks: [], repairRounds: 0 });
  assert.notEqual(result.outcome, "verified");
});

test("a skipped task does not disable normal verification and repair for the next task", async () => {
  const prompts: string[] = [];
  const checked: AnalysisReport[] = [];
  let scans = 0;
  const callbacks = {
    prompt: async (text: string) => { prompts.push(text); },
    analyze: async () => report("completed", scans++ === 0),
    onCheck: (value: AnalysisReport) => { checked.push(value); },
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
  const reports = [report("completed", true), report("compile_failed"), report("completed")];
  const prompts: string[] = [];
  const confirmations: { report: AnalysisReport; nextRound: number }[] = [];
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
  assert.match(prompts[2], /compile_failed/);
});

test("declining a repair preserves unresolved warnings and compilation failures without another prompt", async () => {
  for (const status of ["completed", "compile_failed"] as const) {
    const original = report(status, status === "completed");
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
    assert.equal(result.outcome, status === "completed" ? "unresolved" : "analysis_error");
    assert.deepEqual(result.checks, [original]);
    assert.equal(result.repairRounds, 0);
    assert.equal(prompts, 1);
    assert.equal(confirmations, 1);
  }
});

test("ask mode without a confirmation callback leaves the report unresolved", async () => {
  for (const status of ["completed", "compile_failed"] as const) {
    let prompts = 0;
    let scans = 0;
    const result = await verifyTask({
      task: "Write code", maxRepairs: 2, repairMode: "ask",
      prompt: async () => { prompts++; },
      analyze: async () => { scans++; return report(status, status === "completed"); },
    });
    assert.equal(result.outcome, status === "completed" ? "unresolved" : "analysis_error");
    assert.equal(result.repairRounds, 0);
    assert.equal(result.checks.length, 1);
    assert.equal(prompts, 1);
    assert.equal(scans, 1);
  }
});

test("off mode still analyzes and preserves evidence but never repairs or asks", async () => {
  for (const status of ["completed", "compile_failed"] as const) {
    const original = report(status, status === "completed");
    let prompts = 0;
    let scans = 0;
    let checked: AnalysisReport | undefined;
    const result = await verifyTask({
      task: "Write code", maxRepairs: 5, repairMode: "off",
      prompt: async () => { prompts++; },
      analyze: async () => { scans++; return original; },
      onCheck: value => { checked = value; },
      confirmRepair: async () => { assert.fail("off mode must not request confirmation"); },
    });
    assert.equal(result.outcome, status === "completed" ? "unresolved" : "analysis_error");
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
    analyze: async () => report("completed", scans++ === 0),
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
    analyze: async () => report("completed", true),
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
    analyze: async () => report("compile_failed"),
    confirmRepair: async () => { assert.fail("A zero repair budget must not request confirmation"); },
  });
  assert.equal(zeroBudget.outcome, "analysis_error");
  assert.equal(zeroBudget.repairRounds, 0);
});

test("a failed confirmation returns agent_error and retains the check without spending a repair round", async () => {
  const original = report("completed", true);
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
