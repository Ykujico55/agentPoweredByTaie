import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createTaieAgent } from '../src/agent.ts';

test('cancelling a pending model request returns and the same agent can run another task', { timeout: 15_000 }, async () => {
  const parent = path.resolve('.taie-agent', 'agent-cancel-tests');
  await mkdir(parent, { recursive: true });
  const projectDir = await mkdtemp(path.join(parent, 'run-'));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const controller = new AbortController();
  let agent: Awaited<ReturnType<typeof createTaieAgent>> | undefined;
  let requestCount = 0;
  let abortedRequests = 0;
  let firstSignal: AbortSignal | undefined;
  let secondSignal: AbortSignal | undefined;
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });

  // Exercise the real Pi session and provider adapter with an offline transport.
  // Every request is intercepted; none can fall through to the network.
  globalThis.fetch = async (input, init) => {
    requestCount++;
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(new URL(url).origin, 'https://api.deepseek.com');
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    assert.ok(signal, 'the provider must pass an abort signal to fetch');
    if (requestCount === 1) {
      firstSignal = signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          abortedRequests++;
          reject(new DOMException('Offline model request aborted.', 'AbortError'));
        };
        signal.addEventListener('abort', abort, { once: true });
        requestStarted();
        if (signal.aborted) abort();
      });
    }
    assert.equal(requestCount, 2, 'unexpected extra model request');
    secondSignal = signal;
    const chunk = (delta: object, finishReason: string | null) => `data: ${JSON.stringify({
      id: 'offline-recovery', object: 'chat.completion.chunk', created: 1,
      model: 'deepseek-v4-flash', choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
    return new Response(chunk({ role: 'assistant', content: 'TAIE_CANCEL_RECOVERED' }, null)
      + chunk({}, 'stop') + 'data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  process.env.DEEPSEEK_API_KEY = 'taie-offline-cancel-test-key';
  try {
    agent = await createTaieAgent({
      projectDir, config: {}, provider: 'deepseek', model: 'deepseek-v4-flash',
      maxRepairs: 0, maxTurns: 2, timeoutMs: 5_000, repairMode: 'off',
    });
    const pending = agent.run('Wait for cancellation.', {
      skipTaie: true, repairMode: 'off', signal: controller.signal,
    });
    await Promise.race([started, pending.then(() => assert.fail('model request did not start'))]);
    controller.abort();
    const cancelled = await pending;
    assert.equal(firstSignal?.aborted, true);
    assert.equal(abortedRequests, 1);
    assert.equal(cancelled.outcome, 'agent_error');
    assert.equal(cancelled.error, 'Agent task cancelled.');
    assert.deepEqual(cancelled.checks, []);

    const recovered = await agent.run('Reply without using tools.', { skipTaie: true, repairMode: 'off' });
    assert.equal(recovered.outcome, 'skipped');
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.finalText, 'TAIE_CANCEL_RECOVERED');
    assert.deepEqual(recovered.checks, []);
    assert.equal(secondSignal?.aborted, false);
    assert.equal(requestCount, 2);
  } finally {
    controller.abort();
    await agent?.dispose();
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
});
