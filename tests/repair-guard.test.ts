import test from "node:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { guardRepairTools } from "../src/repair-guard.ts";

type BeforeToolCall = NonNullable<AgentSession["agent"]["beforeToolCall"]>;
type ToolContext = Parameters<BeforeToolCall>[0];

function toolContext(name: string, assistantMessage?: ToolContext["assistantMessage"]): ToolContext {
  return {
    toolCall: { type: "toolCall", id: `call-${name}`, name, arguments: {} },
    args: {},
    assistantMessage: assistantMessage ?? {
      role: "assistant", content: [], api: "openai-completions", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 0,
    },
    context: { systemPrompt: "", messages: [] },
  };
}

test("an analysis can lock a later write in the same batch and authorization unlocks it", async () => {
  let locked = false;
  const previousCalls: string[] = [];
  const guard = guardRepairTools(() => locked, async context => {
    previousCalls.push(context.toolCall.name);
    return undefined;
  });
  const analysis = toolContext("taie_analyze");
  const write = toolContext("write", analysis.assistantMessage);
  analysis.assistantMessage.content.push(analysis.toolCall, write.toolCall);
  assert.equal(write.assistantMessage, analysis.assistantMessage);
  assert.equal(await guard(analysis), undefined);

  // Simulate the preceding analysis returning a report and locking repairs.
  locked = true;
  const denied = await guard(write);
  assert.equal(denied?.block, true);
  assert.equal(denied?.terminate, undefined);
  assert.match(denied?.reason ?? "", /host.*repair round/i);
  assert.deepEqual(previousCalls, ["taie_analyze"]);

  locked = false;
  assert.equal(await guard(write), undefined);
  assert.deepEqual(previousCalls, ["taie_analyze", "write"]);
});

test("a locked guard rejects edit and both shells without delegating to a permissive hook", async () => {
  const guard = guardRepairTools(() => true, async () => {
    assert.fail("Locked modifying tools must not reach the previous hook");
  });
  for (const name of ["edit", "bash", "powershell"]) {
    const denied = await guard(toolContext(name));
    assert.equal(denied?.block, true, name);
    assert.equal(denied?.terminate, undefined, name);
    assert.match(denied?.reason ?? "", /host.*repair round/i, name);
  }
});

test("delegated calls retain the previous hook's context, signal, block and termination result", async () => {
  let locked = false;
  const signal = new AbortController().signal;
  let expectedContext: ToolContext;
  let policy = { block: true, terminate: true, reason: "Existing policy blocks this call" };
  let previousCalls = 0;
  const guard = guardRepairTools(() => locked, async (context, actualSignal) => {
    previousCalls++;
    assert.equal(context, expectedContext);
    assert.equal(actualSignal, signal);
    return policy;
  });
  for (const name of ["write", "edit", "bash", "powershell", "read", "taie_analyze", "taie_get_finding"]) {
    expectedContext = toolContext(name);
    assert.equal(await guard(expectedContext, signal), policy);
  }

  locked = true;
  policy = { block: false, terminate: false, reason: "Existing policy permits this call" };
  for (const name of ["read", "taie_analyze", "taie_get_finding"]) {
    expectedContext = toolContext(name);
    assert.equal(await guard(expectedContext, signal), policy);
  }
  assert.equal(previousCalls, 10);
});

test("an absent previous hook permits delegated tools and does not disable the repair lock", async () => {
  let locked = false;
  const guard = guardRepairTools(() => locked);
  assert.equal(await guard(toolContext("write")), undefined);
  locked = true;
  assert.equal(await guard(toolContext("read")), undefined);
  assert.equal(await guard(toolContext("taie_analyze")), undefined);
  assert.equal((await guard(toolContext("write")))?.block, true);
});

test("previous hook failures are preserved for delegated calls", async () => {
  const failure = new Error("Existing tool policy failed");
  const guard = guardRepairTools(() => true, async () => { throw failure; });
  await assert.rejects(guard(toolContext("read")), error => error === failure);
});
