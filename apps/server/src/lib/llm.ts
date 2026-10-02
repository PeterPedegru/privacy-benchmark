import { AsyncLocalStorage } from "node:async_hooks";
import Anthropic from "@anthropic-ai/sdk";
import { env, isRealSecret, modelFor, type Stage } from "../env.ts";

/** Per-million-token prices (USD) used to meter spend. Cache reads/writes priced per Anthropic's published rates. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};
const WEB_SEARCH_PER_CALL = 0.01;

export const HAIKU = "claude-haiku-4-5";
export const OPUS = "claude-opus-5-5";

let client: Anthropic | null = null;
/** A placeholder (e.g. set while provisioning, replaced later in the dashboard) counts as "not configured". */
export function hasApiKey(): boolean {
  return isRealSecret(env.anthropicKey);
}
export function anthropic(): Anthropic {
  if (!hasApiKey()) throw new Error("ANTHROPIC_API_KEY is not set. Add it to the server environment to run evaluations and update checks.");
  if (!client) {
    client = new Anthropic({
      apiKey: env.anthropicKey,
      // Every model call goes through withRetry/llmCall, which already retries transient errors with backoff.
      // SDK retries underneath it multiplied the attempts (6 × 3 = 18 tries against a 15-minute timeout).
      maxRetries: 0,
      timeout: 15 * 60 * 1000,
      ...(env.anthropicWorkspaceId ? { defaultHeaders: { "anthropic-workspace-id": env.anthropicWorkspaceId } } : {}),
    });
  }
  return client;
}

export interface KeyStatus {
  state: "missing" | "ok" | "rejected" | "unchecked";
  message: string;
  checkedAt: string | null;
}

let keyStatus: KeyStatus = { state: "unchecked", message: "", checkedAt: null };

export function getKeyStatus(): KeyStatus {
  if (!hasApiKey()) return { state: "missing", message: "ANTHROPIC_API_KEY is not set.", checkedAt: null };
  return keyStatus;
}

/** Cheap credential check (lists one model; uses no tokens) so the admin can show a real error instead of guessing. */
export async function verifyApiKey(): Promise<KeyStatus> {
  if (!hasApiKey()) return getKeyStatus();
  try {
    // Not wrapped in withRetry, so let the SDK retry a transient failure before reporting the key as rejected.
    await anthropic().models.list({ limit: 1 }, { maxRetries: 2 });
    keyStatus = { state: "ok", message: "Anthropic API key accepted.", checkedAt: new Date().toISOString() };
  } catch (e) {
    const raw = (e as Error).message ?? String(e);
    const inner = raw.match(/"message":"([^"]+)"/)?.[1] ?? raw;
    const hint = /workspace/i.test(inner) ? " Set ANTHROPIC_WORKSPACE_ID to your Anthropic workspace ID, or create an API key scoped to a workspace." : "";
    keyStatus = { state: "rejected", message: `${inner}${hint}`, checkedAt: new Date().toISOString() };
  }
  return keyStatus;
}

/** The account can't spend: out of credits, or the key was rejected. Retrying won't help; topping up will. */
export function isBillingError(e: unknown): boolean {
  return /credit balance is too low|purchase credits|plans & billing|insufficient (credit|funds)|invalid x-api-key|authentication_error/i.test(
    (e as Error)?.message ?? String(e),
  );
}

/**
 * Whether the account can spend: a one-token request (listing models works with an empty balance). Null when it
 * can, else the API's reason. Costs a fraction of a cent.
 */
export async function verifyCanSpend(): Promise<string | null> {
  if (!hasApiKey()) return "ANTHROPIC_API_KEY is not set.";
  try {
    await anthropic().messages.create({ model: HAIKU, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }, { maxRetries: 2 });
    return null;
  } catch (e) {
    const raw = (e as Error).message ?? String(e);
    return raw.match(/"message":"([^"]+)"/)?.[1] ?? raw;
  }
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  webSearches: number;
  costUsd: number;
  calls: number;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, costUsd: 0, calls: 0 };
}

type ApiUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
};

export function addUsage(acc: Usage, model: string, u: ApiUsage | null | undefined): Usage {
  if (!u) return acc;
  const p = PRICES[model] ?? PRICES[OPUS]!;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  acc.input += input;
  acc.output += output;
  acc.cacheRead += cacheRead;
  acc.cacheWrite += cacheWrite;
  acc.webSearches += searches;
  acc.calls += 1;
  acc.costUsd += (input * p.input + output * p.output + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite) / 1_000_000 + searches * WEB_SEARCH_PER_CALL;
  return acc;
}

export function mergeUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    webSearches: a.webSearches + b.webSearches,
    costUsd: a.costUsd + b.costUsd,
    calls: a.calls + b.calls,
  };
}

/** Beta flag for the server-side refusal fallback (`fallbacks: "default"`). */
export const OPUS_BETAS = ["server-side-fallback-2026-07-01"];

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelCaps {
  /** Accepts `thinking: {type: "adaptive"}` (Haiku 4.5 does not). */
  adaptive: boolean;
  /** Accepts `output_config.effort` (Haiku 4.5 does not). */
  effort: boolean;
  /** Accepts the server-side refusal fallback. */
  fallbacks: boolean;
  /** Newest web search tool version the model supports. */
  webSearch: "web_search_20260209" | "web_search_20250305";
}

export function capsFor(model: string): ModelCaps {
  if (/haiku|sonnet-4-5|opus-4-5|opus-4-1|claude-3/.test(model)) {
    return { adaptive: false, effort: false, fallbacks: false, webSearch: "web_search_20250305" };
  }
  return {
    adaptive: true,
    effort: true,
    fallbacks: /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model),
    webSearch: "web_search_20260209",
  };
}

/** The most output (thinking included) a model can return: 128K for current models, 64K for Haiku 4.5 and older. */
export function maxOutputFor(model: string): number {
  return /haiku|claude-3|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0/.test(model) ? 64_000 : 128_000;
}

/** Request fields a model accepts for the given effort: adaptive thinking, effort, refusal fallback. */
export function modelExtras(model: string, effort: Effort) {
  const c = capsFor(model);
  return {
    thinking: c.adaptive ? ({ type: "adaptive" } as const) : undefined,
    effort: c.effort ? effort : undefined,
    fallbackParams: c.fallbacks ? { betas: OPUS_BETAS, fallbacks: "default" as const } : {},
  };
}

/**
 * A tiny FIFO concurrency limiter shared by all LLM calls. A finishing call hands its slot straight to the next
 * waiter, so a newcomer can't slip in during the handoff and push the count above `max`.
 */
export function limiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const run = async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    else active++;
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
  return Object.assign(run, { stats: () => ({ active, waiting: queue.length }) });
}

export const llmLimit = limiter(env.maxInflightCalls);

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/**
 * Transient API failures: overloaded (529), rate limits, 5xx, dropped connections. Errors that arrive
 * mid-stream as SSE `error` events carry no HTTP status, so the error type in the body is checked too.
 */
export function isRetryableLlmError(e: unknown): boolean {
  if (e instanceof Anthropic.APIConnectionError) return true;
  if (e instanceof Anthropic.APIError) {
    if (e.status && RETRYABLE_STATUS.has(e.status)) return true;
    const type = (e.error as { error?: { type?: string } } | undefined)?.error?.type ?? "";
    if (/overloaded_error|api_error|rate_limit_error|timeout_error/.test(type)) return true;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /overloaded_error|"type":"api_error"|rate_limit_error|ECONNRESET|socket hang up|ETIMEDOUT|other side closed|terminated/i.test(msg);
}

/** The API is overloaded (529): it clears in minutes, not seconds, so it gets more patience than other failures. */
export function isOverloadedError(e: unknown): boolean {
  if (e instanceof Anthropic.APIError && e.status === 529) return true;
  return /overloaded_error/i.test(e instanceof Error ? e.message : String(e));
}

/** Attempts and backoff cap for an overload: about 8 minutes of waiting before an evaluation gives up. */
export const OVERLOAD_ATTEMPTS = 10;
const OVERLOAD_MAX_DELAY_MS = 120_000;

/** Thrown when an evaluation's calls are aborted (cancel, a failure elsewhere in it, a newer runner). */
export class LlmAbortedError extends Error {}

/**
 * The evaluation a model call belongs to (R3-REL-2, R3-REL-9, R3-REL-11): its abort signal, which cancels
 * in-flight calls and retries, and a cost reservation, so calls in parallel can't all pass the cap check against
 * the same stale total.
 */
export interface CallScope {
  signal: AbortSignal;
  /** Reserves an estimated cost before a call; throws when it would cross the cap. Returns the release. */
  reserve?(estimateUsd: number): () => void;
  /** The evaluation's recorded model and effort per stage (its settings), so a resumed run keeps them. */
  models?: Partial<Record<string, string>>;
  effort?: Partial<Record<string, string>>;
  /** Where its model calls run: the Anthropic API, or headless Claude Code sessions on the editor's machine. */
  backend?: string;
}
export const callScope = new AsyncLocalStorage<CallScope>();
/** The current evaluation's abort signal, for the SDK's per-request options. */
export const scopeSignal = (): AbortSignal | undefined => callScope.getStore()?.signal;

const EFFORTS = new Set<Effort>(["low", "medium", "high", "xhigh", "max"]);
/** The model for a stage of the evaluation in scope: its recorded settings, else the configured model. */
export function stageModel(stage: Stage): string {
  return callScope.getStore()?.models?.[stage] || modelFor(stage);
}
/** The effort for a stage of the evaluation in scope: its recorded settings, else `fallback`. */
export function stageEffort(stage: string, fallback: Effort): Effort {
  const e = callScope.getStore()?.effort?.[stage];
  return e && EFFORTS.has(e as Effort) ? (e as Effort) : fallback;
}

/** A conservative cost estimate for one call: the context mostly read from cache, a typical reply. */
export function estimateCallUsd(model: string, contextTokens: number, maxTokens: number): number {
  const p = PRICES[model] ?? PRICES[OPUS]!;
  return (contextTokens * p.cacheRead + 20_000 * p.input + Math.min(maxTokens, 8000) * p.output) / 1_000_000;
}

function abortIfNeeded() {
  const signal = callScope.getStore()?.signal;
  if (signal?.aborted) throw new LlmAbortedError(String(signal.reason ?? "Evaluation stopped"));
}

function sleep(ms: number): Promise<void> {
  const signal = callScope.getStore()?.signal;
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new LlmAbortedError(String(signal.reason ?? "Evaluation stopped")));
      },
      { once: true },
    );
  });
}

/**
 * Retries transient failures with exponential backoff and jitter (2s, 4s, 8s, ... capped at 60s). An overloaded API
 * gets at least OVERLOAD_ATTEMPTS tries with delays up to two minutes: a weekly evaluation shouldn't fail because
 * the API was busy for a few minutes.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; onRetry?: (attempt: number, delayMs: number, error: unknown) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 6;
  for (let attempt = 1; ; attempt++) {
    abortIfNeeded();
    try {
      return await fn();
    } catch (e) {
      // An aborted evaluation doesn't retry: its in-flight call was cancelled on purpose.
      abortIfNeeded();
      const overloaded = isOverloadedError(e);
      if (attempt >= (overloaded ? Math.max(attempts, OVERLOAD_ATTEMPTS) : attempts) || !isRetryableLlmError(e)) throw e;
      const maxDelay = overloaded ? OVERLOAD_MAX_DELAY_MS : 60_000;
      const retryAfter = Number((e as { headers?: Headers }).headers?.get?.("retry-after"));
      const backoff = Math.min(maxDelay, (opts.baseMs ?? 2000) * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(maxDelay, retryAfter * 1000) : backoff;
      opts.onRetry?.(attempt, delay, e);
      await sleep(delay);
    }
  }
}

/** One retrying, concurrency-limited model call; the limiter slot is released while backing off. */
export function llmCall<T>(
  fn: () => Promise<T>,
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void,
  /** For the cost reservation; minUsd is a floor (an agent's next call costs about what its last one did). */
  estimate?: { model: string; contextTokens: number; maxTokens: number; minUsd?: number },
): Promise<T> {
  return withRetry(
    () =>
      llmLimit(async () => {
        abortIfNeeded();
        // Reserved per attempt and released when it settles: the cost cap counts calls in flight.
        const release = estimate
          ? callScope.getStore()?.reserve?.(Math.max(estimate.minUsd ?? 0, estimateCallUsd(estimate.model, estimate.contextTokens, estimate.maxTokens)))
          : undefined;
        try {
          return await fn();
        } finally {
          release?.();
        }
      }),
    { onRetry },
  );
}
