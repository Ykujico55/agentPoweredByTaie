import path from 'node:path';
import type { CreateModelRuntimeOptions, ModelRuntime } from '@earendil-works/pi-coding-agent';

export interface ReviewModelOptions {
  provider: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
  runDir: string;
}

export interface ReviewCompletion {
  text: string;
  stopReason: string;
  usage?: unknown;
  provider: string;
  model: string;
}

export class ReviewModelError extends Error {
  readonly code: 'timeout' | 'cancelled' | 'model_error';
  readonly response?: ReviewCompletion;
  constructor(message: string, code: ReviewModelError['code'] = 'model_error', response?: ReviewCompletion) {
    super(message);
    this.name = 'ReviewModelError';
    this.code = code;
    this.response = response;
  }
}

type ReviewRuntime = Pick<ModelRuntime, 'getModel' | 'hasConfiguredAuth' | 'completeSimple'>;
export interface ReviewModelDependencies {
  createRuntime: (options: CreateModelRuntimeOptions) => Promise<ReviewRuntime>;
}

/** One independent completion: no agent session, project resources, history, tools or retries. */
export async function completeReview(options: ReviewModelOptions, dependencies?: ReviewModelDependencies): Promise<ReviewCompletion> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('Review timeout must be a positive integer.');
  const deadline = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const abortError = () => new ReviewModelError(deadline.signal.aborted ? 'Review model request timed out.' : 'Review model request cancelled.',
    deadline.signal.aborted ? 'timeout' : 'cancelled');
  if (signal.aborted) throw abortError();
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs);
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const request = async (): Promise<ReviewCompletion> => {
    const createRuntime = dependencies?.createRuntime ?? (async (config: CreateModelRuntimeOptions) => {
      const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
      if (signal.aborted) throw abortError();
      return ModelRuntime.create(config);
    });
    const runtime = await createRuntime({
      authPath: path.join(options.runDir, 'pi', 'auth.json'), modelsPath: null,
      allowModelNetwork: false, signal,
    });
    if (signal.aborted) throw abortError();
    const model = runtime.getModel(options.provider, options.model);
    if (!model) throw new ReviewModelError(`Unknown model ${options.provider}/${options.model}.`);
    if (!runtime.hasConfiguredAuth(options.provider)) throw new ReviewModelError(`No credentials for ${options.provider}.`);
    const message = await runtime.completeSimple(model, {
      systemPrompt: options.systemPrompt,
      messages: [{ role: 'user', content: options.prompt, timestamp: Date.now() }],
      tools: [],
    }, { signal, timeoutMs: options.timeoutMs, maxRetries: 0, maxTokens: 4096, toolChoice: 'none' });
    const response: ReviewCompletion = {
      text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      stopReason: message.stopReason, usage: message.usage, provider: message.provider, model: message.model,
    };
    if (signal.aborted) throw new ReviewModelError(abortError().message, abortError().code, response);
    if (message.content.some(block => block.type === 'toolCall')) {
      throw new ReviewModelError('Read-only review returned a tool call; no tool was executed.', 'model_error', response);
    }
    if (message.stopReason !== 'stop') {
      throw new ReviewModelError(`Review model stopped: ${message.stopReason}${message.errorMessage ? `: ${message.errorMessage}` : ''}`, 'model_error', response);
    }
    return response;
  };
  try {
    return await Promise.race([request(), cancelled]);
  } catch (error) {
    if (error instanceof ReviewModelError) throw error;
    throw new ReviewModelError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
