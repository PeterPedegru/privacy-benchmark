import type Anthropic from "@anthropic-ai/sdk";
import { addUsage, anthropic, capsFor, llmCall, modelExtras, scopeSignal, type Usage } from "../lib/llm.ts";
import { redact } from "../lib/redact.ts";
import { budgetMessage, fence, isDataTool, MAX_RECORD_CALLS, MAX_REJECTED, MAX_TOOL_OUTPUT, RECORDING_LIMIT_MESSAGE, RECORDING_TOOLS } from "./agent-tools.ts";
import { llmBackend, runAgentViaClaudeCode } from "./claude-code.ts";
import { runTool, type ToolContext } from "./tools.ts";

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
type BetaToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export class RefusalError extends Error {
  constructor(public category: string | null) {
    super(`The model declined this request${category ? ` (${category})` : ""}.`);
  }
}
export class BudgetError extends Error {}
export class CancelledError extends Error {}

export interface AgentGuard {
  /** Throws when the evaluation should stop (cancelled or over its cost cap). */
  /** Persists usage, then throws when the evaluation was stopped or reached its cost cap. */
  check(): Promise<void>;
}

export interface AgentOptions {
  model: string;
  system: string;
  user: string;
  tools: Anthropic.Tool[];
  webSearchUses: number;
  maxToolCalls: number;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  ctx: ToolContext;
  usage: Usage;
  guard: AgentGuard;
}

export interface AgentResult {
  text: string;
  /** Research calls (everything except recording evidence). */
  toolCalls: number;
  /** record_evidence calls. */
  recordCalls: number;
  stopReason: string | null;
}

/** Server tool pauses (web search running long) and cut-off replies tolerated, each counted on its own. */
const MAX_PAUSES = 20;
const MAX_TRUNCATIONS = 20;
/** Turns an agent may take: enough for its whole tool budget plus recording and wrap-up. */
export const maxTurnsFor = (maxToolCalls: number) => Math.max(80, maxToolCalls * 3 + 60);

/** Output tokens per agent turn (thinking included): room for xhigh effort before a batch of tool calls. */
const AGENT_MAX_TOKENS = 64_000;
/** Turns allowed after the research budget is spent, for recording what was found. */
const WRAP_UP_TURNS = 8;
const PSEUDO_TOOL_CALL = /<function_calls|<invoke name=|<parameter name=|<\/?antml:|<function_results|<\/?tool_result/i;
/** Research calls in a row without recording anything before the agent is reminded to record. */
const REMIND_AFTER = 4;

/**
 * Removes tool-call markup and anything that imitates tool output from an agent's final notes. Notes are passed
 * to later agents as context, so fabricated "results" must never survive into them.
 */
export function sanitizeNotes(text: string): string {
  return text
    .replace(/<function_results>[\s\S]*?(<\/function_results>|$)/gi, "")
    .replace(/<function_calls>[\s\S]*?(<\/function_calls>|$)/gi, "")
    .replace(/<\/?(invoke|parameter|antml:[a-z_]+|tool_result|function_calls|function_results)\b[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Server tool calls (web search's code execution) are paired with their results inside one assistant message.
 * A call left without a result anywhere but in a trailing, paused message makes the API reject the whole request,
 * so unmatched calls are dropped from earlier messages (nothing refers to them). Returns how many were dropped.
 */
export function dropUnmatchedServerToolUses(messages: BetaMessageParam[]): number {
  let dropped = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    // The last message may be a paused turn the server resumes: its open call is expected.
    if (m.role !== "assistant" || !Array.isArray(m.content) || i === messages.length - 1) continue;
    const blocks = m.content as { type: string; id?: string; tool_use_id?: string }[];
    const answered = new Set(blocks.filter((b) => b.type.endsWith("_tool_result") && b.tool_use_id).map((b) => b.tool_use_id!));
    const kept = blocks.filter((b) => b.type !== "server_tool_use" || (b.id && answered.has(b.id)));
    if (kept.length !== blocks.length) {
      dropped += blocks.length - kept.length;
      m.content = kept as never;
    }
  }
  return dropped;
}

/**
 * Above this many input tokens in one turn, the agent is made to wrap up rather than run into the window: most of
 * a 1M-token window (Opus 5.5, Fable 5, Sonnet 5.5), most of 200k otherwise.
 */
export function contextWrapUp(model: string): number {
  const fixed = Number(process.env.AGENT_CONTEXT_WRAP_UP_TOKENS);
  if (fixed > 0) return fixed;
  return /^claude-(opus-5|fable-5|sonnet-5|mythos-5)/.test(model) ? 850_000 : 170_000;
}
/** Lets a request through after the loop had to edit its history (a trim, a dropped server call). */
const BINDING_BETA = "thinking-binding-controls-2026-08-01";

const isTooLong = (e: unknown) => /prompt is too long|context window|too many tokens/i.test((e as Error)?.message ?? "");

/** Shrinks the oldest tool results (keeping the last few turns intact) so a conversation fits again. */
function trimOldToolResults(messages: BetaMessageParam[], keepLast = 4): boolean {
  let trimmed = false;
  for (let i = 0; i < messages.length - keepLast; i++) {
    const m = messages[i]!;
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content as { type: string; content?: unknown }[]) {
      if (b.type === "tool_result" && typeof b.content === "string" && b.content.length > 600) {
        b.content = `${b.content.slice(0, 500)}\n[older tool output trimmed to fit the context window; re-read the source if you need it]`;
        trimmed = true;
      }
    }
  }
  return trimmed;
}

/**
 * Manual agentic loop. We mix Anthropic's server-side web search with our own client tools, so we handle
 * `pause_turn` (server tool loop hit its limit), `max_tokens`, context limits and `refusal` explicitly, and cap
 * tool calls ourselves. History is append-only (except for the repairs above) so thinking blocks and the prompt
 * cache stay valid.
 */
export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  if (llmBackend() === "claude-code") return runAgentViaClaudeCode(o);
  const client = anthropic();
  const messages: BetaMessageParam[] = [{ role: "user", content: o.user }];
  const tools: Anthropic.Beta.Messages.BetaToolUnion[] = [...(o.tools as Anthropic.Beta.Messages.BetaTool[])];
  if (o.webSearchUses > 0)
    tools.push({ type: capsFor(o.model).webSearch, name: "web_search", max_uses: o.webSearchUses } as Anthropic.Beta.Messages.BetaToolUnion);
  const extras = modelExtras(o.model, o.effort);
  let toolCalls = 0;
  let recordCalls = 0;
  let pauses = 0;
  let truncations = 0;
  // Text from replies that were cut off: part of the notes, kept when the agent continues.
  let carried = "";
  // History was edited (trimmed tool output, a dropped server call): thinking blocks produced before the edit no
  // longer match their conversation. From then on the API is asked to drop those instead of rejecting the request
  // (enforced for accounts created on or after 2026-08-31).
  let historyEdited = false;
  const maxTurns = maxTurnsFor(o.maxToolCalls);
  const wrapUpAt = contextWrapUp(o.model);
  let wrapUpTurns = 0;
  let nudges = 0;
  let finalOnly = false;
  let sinceRecord = 0;
  let rejected = 0;
  let trimmedOnce = false;
  let lastContext = 20_000;
  let lastCost = 0;
  const canRecord = o.tools.some((t) => RECORDING_TOOLS.has(t.name));
  const warn = (msg: string) => o.ctx.emit?.("warn", o.ctx.stage, msg);
  const finish = (text: string, stopReason: string | null): AgentResult => {
    const notes = [carried, text].filter((t) => t.trim()).join("\n\n");
    if (!notes.trim()) warn(`Agent ended without notes (${stopReason ?? "no stop reason"})`);
    return { text: notes, toolCalls, recordCalls, stopReason };
  };
  const textOf = (content: BetaContentBlock[]) =>
    content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  const fallbackBetas = (extras.fallbackParams as { betas?: string[] }).betas ?? [];
  // The loop stopped early (turn limit, too many pauses): one more turn without tools for the notes, instead of
  // returning nothing and leaving later stages without this agent's findings.
  let closing = false;
  const askForNotes = (why: string) => {
    closing = true;
    finalOnly = true;
    const ask = `${why} Stop researching and write your final notes now, in plain prose: everything you found, with sources.`;
    const last = messages[messages.length - 1];
    if (last?.role === "user" && Array.isArray(last.content)) last.content = [...(last.content as never[]), { type: "text", text: ask }] as never;
    else messages.push({ role: "user", content: ask });
  };

  for (let turn = 0; turn < maxTurns + 1; turn++) {
    if (turn === maxTurns) {
      if (closing) break;
      askForNotes("You've reached this task's turn limit.");
    }
    await o.guard.check();
    const dropped = dropUnmatchedServerToolUses(messages);
    if (dropped) {
      historyEdited = true;
      warn(`Dropped ${dropped} server tool call(s) that had no result`);
    }
    const thinking = extras.thinking
      ? historyEdited
        ? { ...extras.thinking, block_binding: { prefix_mismatch_behavior: "drop_block" as const } }
        : extras.thinking
      : undefined;
    const params = {
      model: o.model,
      max_tokens: AGENT_MAX_TOKENS,
      system: [{ type: "text" as const, text: o.system, cache_control: { type: "ephemeral" as const } }],
      messages,
      tools,
      // Automatic caching of the growing conversation on top of the cached system prompt.
      cache_control: { type: "ephemeral" as const },
      ...(thinking ? { thinking: thinking as never } : {}),
      ...(extras.effort ? { output_config: { effort: extras.effort } } : {}),
      // Only after the wrap-up turns are used up: tools stay available so evidence can still be recorded.
      ...(finalOnly ? { tool_choice: { type: "none" as const } } : {}),
      ...extras.fallbackParams,
      ...(historyEdited ? { betas: [...fallbackBetas, BINDING_BETA] } : {}),
    };
    let res: Anthropic.Beta.Messages.BetaMessage;
    try {
      res = await llmCall(
        () => client.beta.messages.stream(params, { signal: scopeSignal() }).finalMessage(),
        (attempt, delay, e) =>
          warn(`Anthropic API busy (${(e as Error).message.slice(0, 80)}); retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1})`),
        { model: o.model, contextTokens: lastContext, maxTokens: AGENT_MAX_TOKENS, minUsd: lastCost },
      );
    } catch (e) {
      // A conversation that outgrew the context window: shrink old tool output once and wrap up.
      if (isTooLong(e) && !trimmedOnce && trimOldToolResults(messages)) {
        trimmedOnce = true;
        historyEdited = true;
        finalOnly = toolCalls >= o.maxToolCalls;
        warn("The conversation outgrew the context window; trimmed older tool output and continuing");
        continue;
      }
      throw e;
    }
    const before = o.usage.costUsd;
    addUsage(o.usage, o.model, res.usage);
    lastCost = o.usage.costUsd - before;
    const contextTokens = (res.usage.input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
    lastContext = contextTokens;
    // A continuation after pause_turn belongs to the same assistant turn: merge it into the paused message, so a
    // server tool call (e.g. web search's code execution) and its result stay in one message. Two consecutive
    // assistant messages leave the first with an unmatched server_tool_use, which the API rejects.
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") last.content = [...(last.content as BetaContentBlock[]), ...(res.content as BetaContentBlock[])] as never;
    else messages.push({ role: "assistant", content: res.content as BetaContentBlock[] as never });

    if (res.stop_reason === "refusal") {
      const details = (res as unknown as { stop_details?: { category?: string | null } }).stop_details;
      throw new RefusalError(details?.category ?? null);
    }
    if (res.stop_reason === "pause_turn") {
      if (++pauses > MAX_PAUSES) {
        if (closing) break;
        warn("Too many server tool pauses; asking the agent for its notes");
        askForNotes("Web search keeps pausing.");
      }
      continue;
    }
    // Cut off mid-reply: drop the incomplete tool calls (their input is truncated) and ask to continue in smaller
    // batches, instead of taking the fragment as final notes and losing the evidence it was recording.
    if ((res.stop_reason === "max_tokens" || (res.stop_reason as string) === "model_context_window_exceeded") && truncations < MAX_TRUNCATIONS) {
      truncations++;
      // A reply cut off while writing prose (no tool calls in it) was writing the notes: keep what it wrote.
      const partial = res.content.some((b) => b.type === "tool_use") ? "" : textOf(res.content as BetaContentBlock[]);
      if (partial) carried = [carried, partial].filter(Boolean).join("\n\n");
      const last = messages[messages.length - 1]!;
      last.content = (last.content as BetaContentBlock[]).filter((b) => b.type !== "tool_use") as never;
      if (!(last.content as BetaContentBlock[]).length) messages.pop();
      if ((res.stop_reason as string) === "model_context_window_exceeded") {
        if (trimOldToolResults(messages)) historyEdited = true;
        finalOnly = true;
      }
      warn(`Reply cut off (${res.stop_reason}); asking the agent to continue`);
      messages.push({
        role: "user",
        content: "Your reply was cut off. Continue where you left off; record evidence in batches of at most 10 items per call.",
      });
      continue;
    }
    if (contextTokens > wrapUpAt && !finalOnly) {
      // Close to the context window: no more research; record what's been found and finish.
      toolCalls = Math.max(toolCalls, o.maxToolCalls);
    }
    const toolUses = res.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = textOf(res.content as BetaContentBlock[]);
      // Models sometimes write tool calls as text (especially when they think tools are unavailable). Those do
      // nothing, so ask for real calls instead of silently losing the evidence.
      if (nudges < 2 && PSEUDO_TOOL_CALL.test(text)) {
        nudges++;
        if (finalOnly) {
          // Tools are off now; ask for clean notes instead of letting fabricated tool output stand.
          messages.push({ role: "user", content: "Rewrite your final notes as plain prose. No tool calls, no XML, no quoted tool output." });
          continue;
        }
        messages.push({
          role: "user",
          content: canRecord
            ? "Your last message wrote tool calls as plain text, which does nothing. Make real tool calls instead: record the evidence you described with record_evidence (several items per call), then finish with a short summary."
            : "Your last message wrote tool calls as plain text, which does nothing. Make real tool calls if you still need them, then finish with your notes in plain prose.",
        });
        continue;
      }
      return finish(sanitizeNotes(text), res.stop_reason);
    }

    // More tool work after a cut-off reply: that reply's prose was narration, not the final notes.
    carried = "";
    const results: BetaToolResult[] = await Promise.all(
      toolUses.map(async (tu): Promise<BetaToolResult> => {
        if (RECORDING_TOOLS.has(tu.name)) {
          sinceRecord = 0;
          if (++recordCalls > MAX_RECORD_CALLS) return { type: "tool_result", tool_use_id: tu.id, content: RECORDING_LIMIT_MESSAGE, is_error: true };
        } else if (++toolCalls > o.maxToolCalls) {
          rejected++;
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            content: budgetMessage(canRecord),
            is_error: true,
          };
        } else sinceRecord++;
        try {
          const out = (await runTool(tu.name, (tu.input ?? {}) as Record<string, unknown>, o.ctx)).slice(0, MAX_TOOL_OUTPUT);
          return { type: "tool_result", tool_use_id: tu.id, content: isDataTool(tu.name) ? fence(tu.name, out) : out };
        } catch (e) {
          return { type: "tool_result", tool_use_id: tu.id, content: `Tool error: ${redact((e as Error).message)}`, is_error: true };
        }
      }),
    );
    if ((toolCalls >= o.maxToolCalls && ++wrapUpTurns > WRAP_UP_TURNS) || rejected >= MAX_REJECTED) finalOnly = true;
    // A nudge to record what's been found so far, appended after the tool results (same user turn).
    const remind = canRecord && sinceRecord >= REMIND_AFTER && toolCalls < o.maxToolCalls;
    if (remind) sinceRecord = 0;
    messages.push({
      role: "user",
      content: remind
        ? [...results, { type: "text", text: "Reminder: record the evidence you've found so far (record_evidence takes a list) before searching further." }]
        : results,
    });
  }
  return finish("", closing ? "max_turns" : "stopped");
}
