import test from "node:test";
import assert from "node:assert/strict";
import { parseChatTurn } from "../src/turn.ts";

test("a leading chat flag skips only its own message and is removed from the model task", () => {
  assert.deepEqual(parseChatTurn("  --skip-taie 请解释这段代码"), { task: "请解释这段代码", skipTaie: true });
  assert.deepEqual(parseChatTurn("接下来修改代码"), { task: "接下来修改代码", skipTaie: false });
});

test("a command-line or standalone chat flag can arm one submitted message", () => {
  const armed = parseChatTurn("--skip-taie");
  assert.equal(armed.task, "");
  assert.deepEqual(parseChatTurn("只讨论设计", armed.skipTaie), { task: "只讨论设计", skipTaie: true });
  assert.deepEqual(parseChatTurn("开始实现"), { task: "开始实现", skipTaie: false });
});

test("mentioning the flag inside a question or a longer word does not disable analysis", () => {
  for (const task of ["说明 --skip-taie 参数", "--skip-taie-extra", "请保留代码格式\n  class Example {}"]) {
    assert.deepEqual(parseChatTurn(task), { task, skipTaie: false });
  }
});

test("repair can be disabled for one message while analysis remains enabled", () => {
  assert.deepEqual(parseChatTurn("--no-repair 写一个有空指针的示例"), { task: "写一个有空指针的示例", skipTaie: false, repairMode: "off" });
  assert.deepEqual(parseChatTurn("下一轮"), { task: "下一轮", skipTaie: false });
  assert.deepEqual(parseChatTurn("请解释 --no-repair 参数"), { task: "请解释 --no-repair 参数", skipTaie: false });
});

test("combined flags and a standalone repair flag preserve one-message overrides", () => {
  for (const text of ["--no-repair --skip-taie 讨论设计", "--skip-taie --no-repair 讨论设计"]) {
    assert.deepEqual(parseChatTurn(text), { task: "讨论设计", skipTaie: true, repairMode: "off" });
  }
  const pending = parseChatTurn("--no-repair");
  assert.equal(pending.task, "");
  assert.deepEqual(parseChatTurn("保留缺陷", pending.skipTaie, pending.repairMode), { task: "保留缺陷", skipTaie: false, repairMode: "off" });
});
