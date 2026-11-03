import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setImmediate as nextTick } from "node:timers/promises";
import { createConsoleInput } from "../src/console-input.ts";

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", chunk => { printed += chunk.toString(); });
  return { input, output, printed: () => printed };
}

test("multiple pretyped lines are consumed in order and prompts are printed", { timeout: 2_000 }, async () => {
  const { input, output, printed } = streams();
  input.write("first\r\nsecond\nthird\n");
  const consoleInput = createConsoleInput(input, output);
  try {
    assert.equal(await consoleInput.nextTask("task> "), "first");
    assert.equal(await consoleInput.ask("confirm> "), "second");
    assert.equal(await consoleInput.nextTask("task> "), "third");
    assert.equal(printed(), "task> confirm> task> ");
  } finally { consoleInput.close(); }
});

test("lines entered while there is no consumer survive an asynchronous task", { timeout: 2_000 }, async () => {
  const { input, output } = streams();
  const consoleInput = createConsoleInput(input, output);
  try {
    input.write("queued task\nyes\nnext task\n");
    await nextTick();
    assert.equal(await consoleInput.nextTask("task> "), "queued task");
    await nextTick();
    assert.equal(await consoleInput.ask("confirm> "), "yes");
    assert.equal(await consoleInput.nextTask("task> "), "next task");
  } finally { consoleInput.close(); }
});

test("deferred chat messages do not loop back into confirmation input", { timeout: 2_000 }, async () => {
  const { input, output } = streams();
  const consoleInput = createConsoleInput(input, output);
  input.end("please inspect another file\nno\nlast task\n");
  const message = await consoleInput.ask("repair? ");
  assert.equal(message, "please inspect another file");
  consoleInput.defer(message!);
  assert.equal(await consoleInput.ask("repair? "), "no");
  assert.equal(await consoleInput.nextTask("task> "), message);
  assert.equal(await consoleInput.nextTask("task> "), "last task");
  assert.equal(await consoleInput.ask("repair? "), undefined);
  consoleInput.close();
});

test("EOF preserves a final unterminated line and then returns undefined", { timeout: 2_000 }, async () => {
  const { input, output } = streams();
  const consoleInput = createConsoleInput(input, output);
  input.end("tail without newline");
  assert.equal(await consoleInput.ask("line> "), "tail without newline");
  assert.equal(await consoleInput.nextTask("task> "), undefined);
  assert.equal(await consoleInput.ask("line> "), undefined);
  consoleInput.close();
});

test("explicit close releases pending readers and still permits buffered lines to drain", { timeout: 2_000 }, async () => {
  const { input, output } = streams();
  const consoleInput = createConsoleInput(input, output);
  const pending = consoleInput.ask("waiting> ");
  consoleInput.close();
  assert.equal(await pending, undefined);
  consoleInput.close();
  consoleInput.defer("saved chat");
  assert.equal(await consoleInput.nextTask("task> "), "saved chat");
  assert.equal(await consoleInput.ask("line> "), undefined);

  const buffered = streams();
  const second = createConsoleInput(buffered.input, buffered.output);
  buffered.input.write("one\ntwo\n");
  await nextTick();
  second.close();
  assert.equal(await second.ask("line> "), "one");
  assert.equal(await second.nextTask("task> "), "two");
  assert.equal(await second.ask("line> "), undefined);
});

test("queued readers are released in order when input arrives or closes", { timeout: 2_000 }, async () => {
  const { input, output } = streams();
  const consoleInput = createConsoleInput(input, output);
  const first = consoleInput.ask("one> ");
  const second = consoleInput.ask("two> ");
  const last = consoleInput.nextTask("three> ");
  input.end("a\nb\n");
  assert.deepEqual(await Promise.all([first, second, last]), ["a", "b", undefined]);
  consoleInput.close();
});

test("terminal Ctrl+C cancels active work without closing the following chat prompt", { timeout: 2_000 }, async () => {
  const { input, output } = streams();
  Object.assign(input, { isTTY: true });
  Object.assign(output, { isTTY: true });
  const controller = new AbortController();
  let active = true;
  const consoleInput = createConsoleInput(input, output, () => {
    if (!active) return false;
    controller.abort();
    return true;
  });
  try {
    input.write("\x03");
    await nextTick();
    assert.equal(controller.signal.aborted, true);
    active = false;
    const next = consoleInput.nextTask("task> ");
    input.write("/config\n");
    assert.equal(await next, "/config");
    const pending = consoleInput.nextTask("task> ");
    input.write("\x03");
    assert.equal(await pending, undefined);
  } finally { consoleInput.close(); }
});

test("terminal Ctrl+C without an interrupt handler closes the input", { timeout: 2_000 }, async () => {
  const { input, output } = streams();
  Object.assign(input, { isTTY: true });
  Object.assign(output, { isTTY: true });
  const consoleInput = createConsoleInput(input, output);
  try {
    const pending = consoleInput.nextTask("task> ");
    input.write("\x03");
    assert.equal(await pending, undefined);
  } finally { consoleInput.close(); }
});
