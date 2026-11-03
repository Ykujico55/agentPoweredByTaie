import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface ConsoleInput {
  /** Read the next raw input line, including lines typed before this prompt. */
  ask(prompt: string): Promise<string | undefined>;
  /** Save a non-confirmation line for the next chat task. */
  defer(text: string): void;
  /** Prefer deferred chat messages, then consume the raw input queue. */
  nextTask(prompt: string): Promise<string | undefined>;
  /** Stop reading and release pending readers; existing buffered lines remain. */
  close(): void;
}

interface Waiter {
  kind: "raw" | "task";
  resolve: (line: string | undefined) => void;
}

export function createConsoleInput(input: Readable, output: Writable, onInterrupt?: () => boolean): ConsoleInput {
  const terminal = Boolean(
    (input as Readable & { isTTY?: boolean }).isTTY
    && (output as Writable & { isTTY?: boolean }).isTTY,
  );
  const reader = createInterface({ input, output, terminal, crlfDelay: Infinity });
  const raw: string[] = [];
  const deferred: string[] = [];
  const waiters: Waiter[] = [];
  let closed = false;

  const drain = () => {
    while (waiters.length) {
      const waiter = waiters[0];
      if (waiter.kind === "task" && deferred.length) {
        waiters.shift()!.resolve(deferred.shift()!);
      } else if (raw.length) {
        waiters.shift()!.resolve(raw.shift()!);
      } else if (closed) {
        waiters.shift()!.resolve(undefined);
      } else {
        return;
      }
    }
  };
  const markClosed = () => {
    closed = true;
    drain();
  };

  // Keep this listener installed while the agent works. readline.question()
  // alone would have no waiting consumer for lines entered during that time.
  reader.on("line", (line: string) => {
    raw.push(line);
    drain();
  });
  reader.on("close", markClosed);
  // Readline consumes terminal Ctrl+C; let the host cancel active work while
  // retaining the input queue. Unhandled interrupts keep the usual close behavior.
  reader.on("SIGINT", () => {
    if (!onInterrupt?.()) reader.close();
  });
  reader.on("error", () => {
    markClosed();
    reader.close();
  });
  if (input.readableEnded || input.destroyed) queueMicrotask(markClosed);

  const request = (kind: Waiter["kind"], prompt: string): Promise<string | undefined> => {
    if (terminal && !closed) {
      reader.setPrompt(prompt);
      reader.prompt(true);
    } else {
      output.write(prompt);
    }
    return new Promise(resolve => {
      waiters.push({ kind, resolve });
      drain();
    });
  };

  return {
    ask: prompt => request("raw", prompt),
    nextTask: prompt => request("task", prompt),
    defer(text) {
      deferred.push(text);
      drain();
    },
    close() {
      markClosed();
      reader.close();
    },
  };
}
