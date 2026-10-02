/**
 * The Claude Code backend: every model step of an evaluation runs as a headless Claude Code session (`claude -p`) on
 * the editor's machine, under their Claude Code login. No Anthropic API key is read or sent: the sessions start
 * without one in their environment, so Claude Code uses the login.
 *
 * - Agents (scout, code auditors, research, code check, skeptic) get the pipeline's own tools through an MCP server
 *   (scripts/bench-mcp.mjs) that forwards every call to a tool bridge in this process. The bridge runs the same
 *   tools with the same context, budgets, recording limits and fencing as the API loop (agent.ts), and checks the
 *   evaluation's state before each call, so a cancel stops a session within one tool call.
 * - Structured steps (judge votes, code map, change explanations, summary) use `--json-schema`, validated again here.
 * - The system prompts are the pipeline's own; Claude Code's default prompt, settings, hooks, CLAUDE.md files and
 *   other MCP servers are left out (`--system-prompt-file`, `--restricted`, `--strict-mcp-config`, an empty working
 *   directory), and the only built-in tool a session may use is web search, where the stage allows it.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { SERVER_ROOT } from "../env.ts";
import { addUsage, callScope, type Effort, limiter, scopeSignal, type Usage } from "../lib/llm.ts";
import { redact } from "../lib/redact.ts";
import type { AgentGuard, AgentOptions, AgentResult } from "./agent.ts";
import { budgetMessage, fence, isDataTool, MAX_RECORD_CALLS, MAX_REJECTED, MAX_TOOL_OUTPUT, RECORDING_LIMIT_MESSAGE, RECORDING_TOOLS } from "./agent-tools.ts";
import { runTool, type ToolContext } from "./tools.ts";

export type LlmBackend = "api" | "claude-code";

/** The backend for the evaluation in scope: its recorded setting, else LLM_BACKEND, else the API. */
export function llmBackend(): LlmBackend {
  const b = callScope.getStore()?.backend ?? process.env.LLM_BACKEND;
  return b === "claude-code" ? "claude-code" : "api";
}

const MCP_SCRIPT = resolve(SERVER_ROOT, "scripts/bench-mcp.mjs");
/** The `claude` executable (BENCH_CLAUDE_BIN for a non-default install, or a test double). */
const claudeBin = () => process.env.BENCH_CLAUDE_BIN || "claude";
/** Sessions running at once (each is a Claude Code process with its own tool calls). */
const sessionLimit = limiter(Number(process.env.BENCH_CLAUDE_CONCURRENCY) || 8);
/** An agent session can run long (a deep research pass is well over a hundred tool calls). */
const AGENT_TIMEOUT_MS = Number(process.env.BENCH_CLAUDE_AGENT_TIMEOUT_MS) || 4 * 60 * 60_000;
const STRUCTURED_TIMEOUT_MS = Number(process.env.BENCH_CLAUDE_STRUCTURED_TIMEOUT_MS) || 60 * 60_000;

/** The Claude Code plan's usage limit was reached: nothing more runs until it resets (the evaluation is resumable). */
export class ClaudeCodeLimitError extends Error {}

/** The message a usage-limit stop leaves on the evaluation, so the CLI can tell it from other failures. */
const LIMIT_MESSAGE = "Claude Code's usage limit was reached";
export const isClaudeCodeLimit = (error: string | null | undefined) => !!error?.includes(LIMIT_MESSAGE);

// ---------- tool bridge ----------

interface Session {
  ctx: ToolContext;
  tools: Anthropic.Tool[];
  maxToolCalls: number;
  toolCalls: number;
  recordCalls: number;
  rejected: number;
  canRecord: boolean;
  guard: AgentGuard;
  stopped: unknown;
}

let bridge: Promise<{ url: string; token: string; sessions: Map<string, Session>; server: Server }> | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      body += c;
      if (body.length > 5_000_000) req.destroy(new Error("body too large"));
    });
    req.on("end", () => ok(body));
    req.on("error", fail);
  });
}

/** One tool call from a session: the API loop's rules, applied to calls arriving through MCP. */
async function callTool(s: Session, name: string, input: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  if (!s.tools.some((t) => t.name === name)) return { text: `Unknown tool ${name}.`, isError: true };
  try {
    await s.guard.check();
  } catch (e) {
    s.stopped = e;
    return { text: "The evaluation was stopped. Stop now.", isError: true };
  }
  if (RECORDING_TOOLS.has(name)) {
    if (++s.recordCalls > MAX_RECORD_CALLS) return { text: RECORDING_LIMIT_MESSAGE, isError: true };
  } else if (++s.toolCalls > s.maxToolCalls) {
    s.rejected++;
    return {
      text: s.rejected >= MAX_REJECTED ? "Budget used up. Stop calling tools and write your final notes now." : budgetMessage(s.canRecord),
      isError: true,
    };
  }
  try {
    const out = (await runTool(name, input, s.ctx)).slice(0, MAX_TOOL_OUTPUT);
    return { text: isDataTool(name) ? fence(name, out) : out };
  } catch (e) {
    return { text: `Tool error: ${redact((e as Error).message)}`, isError: true };
  }
}

/** The bridge on 127.0.0.1, behind a random bearer token; started on first use, never keeps the process alive. */
function startBridge() {
  bridge ??= new Promise((ok, fail) => {
    const token = randomBytes(32).toString("hex");
    const sessions = new Map<string, Session>();
    const server = createServer((req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: "unauthorized" });
      const s = sessions.get(String(req.headers["x-bench-session"] ?? ""));
      if (!s) return reply(404, { error: "unknown session" });
      if (req.method === "GET" && req.url === "/tools")
        return reply(200, { tools: s.tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.input_schema })) });
      if (req.method === "POST" && req.url === "/call") {
        void readBody(req)
          .then(async (raw) => {
            const { name, input } = JSON.parse(raw) as { name: string; input?: Record<string, unknown> };
            reply(200, await callTool(s, String(name), input ?? {}));
          })
          .catch((e) => reply(400, { error: (e as Error).message }));
        return;
      }
      reply(404, { error: "not found" });
    });
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      const addr = server.address() as { port: number };
      ok({ url: `http://127.0.0.1:${addr.port}`, token, sessions, server });
    });
  });
  return bridge;
}

// ---------- sessions ----------

interface ClaudeResult {
  result: string;
  structured: unknown;
  stopReason: string | null;
  isError: boolean;
  usage: Parameters<typeof addUsage>[2];
}

/** The environment a session gets: enough to run Claude Code under the login, and no secrets or keys. */
function sessionEnv(extra: Record<string, string>): Record<string, string> {
  const keep = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return {
    ...env,
    // Long tool calls (a PDF, a big code read) and a slow MCP start shouldn't time out.
    MCP_TOOL_TIMEOUT: "900000",
    MCP_TIMEOUT: "60000",
    DISABLE_AUTOUPDATER: "1",
    ...extra,
  };
}

/** A plan limit, in any of Claude Code's wordings ("You've hit your session limit · resets 10:40pm", "usage limit reached"). */
export const isLimit = (t: string) =>
  /usage limit|limit reached|limit will reset|resets (at |\d)|out of (extra )?usage|hit your [\w -]{0,20}limit|(session|weekly|daily|hourly|5-hour) limit/i.test(
    t,
  );
const isTransient = (t: string) => /overloaded|529|rate.?limit|429|5\d\d|ECONNRESET|socket hang up|timed? ?out|temporarily/i.test(t);

/** Runs one headless Claude Code session; retries transient failures, stops on a plan usage limit. */
async function runClaude(o: {
  system: string;
  prompt: string;
  model: string;
  effort?: Effort;
  builtinTools: string;
  mcp?: { url: string; token: string; session: string };
  jsonSchema?: unknown;
  timeoutMs: number;
}): Promise<ClaudeResult> {
  const dir = mkdtempSync(join(tmpdir(), "pb-claude-"));
  try {
    writeFileSync(join(dir, "system.md"), o.system);
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      o.model,
      ...(o.effort && !/haiku/.test(o.model) ? ["--effort", o.effort] : []),
      "--system-prompt-file",
      join(dir, "system.md"),
      "--tools",
      o.builtinTools,
      "--restricted",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--exclude-dynamic-system-prompt-sections",
      "--permission-mode",
      "dontAsk",
    ];
    if (o.mcp) {
      writeFileSync(
        join(dir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            bench: {
              command: process.execPath,
              args: [MCP_SCRIPT],
              env: { BENCH_BRIDGE_URL: o.mcp.url, BENCH_BRIDGE_TOKEN: o.mcp.token, BENCH_SESSION: o.mcp.session },
            },
          },
        }),
      );
      args.push("--mcp-config", join(dir, "mcp.json"), "--allowedTools", "mcp__bench", ...(o.builtinTools ? [o.builtinTools] : []));
    }
    if (o.jsonSchema) args.push("--json-schema", JSON.stringify(o.jsonSchema));
    for (let attempt = 1; ; attempt++) {
      const r = await sessionLimit(() => spawnOnce(args, o.prompt, dir, o.timeoutMs));
      const text = `${r.result} ${r.stderr}`;
      if (!r.isError) return r;
      if (isLimit(text)) throw new ClaudeCodeLimitError(`${LIMIT_MESSAGE} (${text.trim().slice(0, 200)}). Resume when it resets.`);
      if (attempt < 4 && isTransient(text) && !scopeSignal()?.aborted) {
        await new Promise((ok) => setTimeout(ok, 15_000 * attempt));
        continue;
      }
      throw new Error(`Claude Code session failed: ${redact(text.trim().slice(0, 400))}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function spawnOnce(args: string[], prompt: string, cwd: string, timeoutMs: number): Promise<ClaudeResult & { stderr: string }> {
  return new Promise((ok, fail) => {
    const signal = scopeSignal();
    if (signal?.aborted) return fail(new Error("Stopped"));
    const child = spawn(claudeBin(), args, { cwd, env: sessionEnv({}), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (err = (err + c).slice(-20_000)));
    const kill = () => child.kill("SIGTERM");
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(new Error(`Couldn't start Claude Code (${claudeBin()}): ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (signal?.aborted) return fail(new Error("Stopped"));
      const line = out
        .trim()
        .split("\n")
        .reverse()
        .find((l) => l.startsWith("{"));
      let d: Record<string, unknown> = {};
      try {
        d = line ? (JSON.parse(line) as Record<string, unknown>) : {};
      } catch {
        // reported below
      }
      const result = typeof d.result === "string" ? d.result : "";
      ok({
        result,
        structured: d.structured_output ?? null,
        stopReason: (d.stop_reason as string) ?? null,
        isError: code !== 0 || d.is_error === true || d.type !== "result",
        usage: (d.usage as ClaudeResult["usage"]) ?? null,
        stderr: line ? err : `${err}\n${out.slice(0, 2000)}`,
      });
    });
    child.stdin.end(prompt);
  });
}

/** Strips tool-call markup from notes (later agents read them as context). */
function clean(text: string): string {
  return text
    .replace(/<\/?(function_calls|function_results|invoke|parameter|tool_result)\b[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** An agent, as a Claude Code session with the pipeline's tools. */
export async function runAgentViaClaudeCode(o: AgentOptions): Promise<AgentResult> {
  await o.guard.check();
  const b = await startBridge();
  const id = randomBytes(12).toString("hex");
  const session: Session = {
    ctx: o.ctx,
    tools: o.tools,
    maxToolCalls: o.maxToolCalls,
    toolCalls: 0,
    recordCalls: 0,
    rejected: 0,
    canRecord: o.tools.some((t) => RECORDING_TOOLS.has(t.name)),
    guard: o.guard,
    stopped: null,
  };
  b.sessions.set(id, session);
  const web = o.webSearchUses > 0 ? "WebSearch" : "";
  try {
    const r = await runClaude({
      system: `${o.system}\n\n## Tools\nYour tools are the evaluation's own, from the "bench" MCP server (shown as mcp__bench__<name>; the names in these instructions are the part after the prefix)${web ? `, plus WebSearch (about ${o.webSearchUses} searches)` : ""}. Use only these.`,
      prompt: o.user,
      model: o.model,
      effort: o.effort,
      builtinTools: web,
      mcp: { url: b.url, token: b.token, session: id },
      timeoutMs: AGENT_TIMEOUT_MS,
    });
    addUsage(o.usage, o.model, r.usage);
    if (session.stopped) throw session.stopped;
    await o.guard.check();
    if (r.stopReason === "refusal") {
      const { RefusalError } = await import("./agent.ts");
      throw new RefusalError(null);
    }
    const text = clean(r.result);
    if (!text) o.ctx.emit?.("warn", o.ctx.stage, "Agent ended without notes");
    return { text, toolCalls: Math.min(session.toolCalls, o.maxToolCalls), recordCalls: session.recordCalls, stopReason: r.stopReason };
  } finally {
    b.sessions.delete(id);
  }
}

/** A structured step (a judge vote, the code map, the summary) as a Claude Code session with a JSON schema. */
export async function structuredViaClaudeCode<T>(o: {
  model: string;
  effort?: Effort;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  usage: Usage;
}): Promise<{ parsed_output: T | null; stop_reason: string | null }> {
  const r = await runClaude({
    system: o.system,
    prompt: o.user,
    model: o.model,
    effort: o.effort,
    builtinTools: "",
    jsonSchema: z.toJSONSchema(o.schema, { target: "draft-7", unrepresentable: "any" }),
    timeoutMs: STRUCTURED_TIMEOUT_MS,
  });
  addUsage(o.usage, o.model, r.usage);
  const parsed = o.schema.safeParse(
    r.structured ??
      (() => {
        try {
          return JSON.parse(r.result);
        } catch {
          return null;
        }
      })(),
  );
  return { parsed_output: parsed.success ? parsed.data : null, stop_reason: r.stopReason };
}

/**
 * Whether Claude Code runs here under a login (no API key): a one-line session. Null when it does, else why not.
 */
export async function verifyClaudeCode(): Promise<string | null> {
  try {
    const r = await runClaude({
      system: "Reply with exactly: ok",
      prompt: "ok?",
      model: "claude-haiku-4-5",
      builtinTools: "",
      timeoutMs: 120_000,
    });
    return /ok/i.test(r.result) ? null : `unexpected reply: ${r.result.slice(0, 80)}`;
  } catch (e) {
    return (e as Error).message;
  }
}
