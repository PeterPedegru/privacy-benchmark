/**
 * The Claude Code backend: agents run as headless Claude Code sessions that reach the pipeline's tools through the
 * MCP proxy and the tool bridge, with the API loop's budgets, and never with an API key. A stand-in `claude`
 * (fixtures/fake-claude.mjs) speaks real MCP to the bridge.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { DB } from "../src/db/index.ts";

process.env.BENCH_CLAUDE_BIN = resolve(import.meta.dirname, "fixtures/fake-claude.mjs");
const { openDb, schema, setDb } = await import("../src/db/index.ts");
const { ClaudeCodeLimitError, isClaudeCodeLimit, isLimit, llmBackend, runAgentViaClaudeCode, structuredViaClaudeCode } = await import(
  "../src/eval/claude-code.ts"
);
const { CancelledError } = await import("../src/eval/agent.ts");
const { silentEmitter } = await import("../src/eval/events.ts");
const { toolDefinitions } = await import("../src/eval/tools.ts");
const { callScope, emptyUsage } = await import("../src/lib/llm.ts");

let db: DB;
let project: typeof schema.projects.$inferSelect;
beforeAll(async () => {
  db = await openDb({ log: () => {} });
  setDb(db);
  const [row] = await db.insert(schema.projects).values({ id: "p1", slug: "alpha", name: "Alpha", websiteUrl: "https://alpha.example.org" }).returning();
  project = row!;
  await db.insert(schema.evaluations).values({ id: "e1", projectId: "p1", mode: "quick", status: "running", settings: {} });
});

const ctxFor = () => ({
  db,
  evaluationId: "e1",
  project,
  version: null,
  stage: "research.custody",
  allowedCriteria: new Set(["custody.pause.pause-fn"]),
  emit: silentEmitter(),
  evidenceCount: { n: 0 },
});
const agent = (user: string, maxToolCalls: number, check: () => Promise<void> = async () => {}) =>
  runAgentViaClaudeCode({
    model: "claude-opus-5-5",
    system: "You research.",
    user,
    tools: toolDefinitions(["kb_overview", "search_sources", "record_search"], ["custody.pause.pause-fn"]),
    webSearchUses: 0,
    maxToolCalls,
    effort: "xhigh",
    ctx: ctxFor(),
    usage: emptyUsage(),
    guard: { check },
  });

describe("agents as Claude Code sessions", () => {
  it("serve the pipeline's tools over MCP, record usage, and never pass an API key", async () => {
    const log = join(process.env.TMPDIR || tmpdir(), "fake-claude-last.json");
    process.env.ANTHROPIC_API_KEY = "sk-ant-must-not-reach-the-session";
    try {
      const r = await agent("CALL kb_overview\nresearch the pause powers", 5);
      expect(r.text).toContain("tools=kb_overview,search_sources,record_search");
      expect(r.text).toMatch(/kb_overview:ok:/);
      expect(r.toolCalls).toBe(1);
      const seen = JSON.parse(readFileSync(log, "utf8")) as { args: string[]; env: string[]; prompt: string };
      expect(seen.env).not.toContain("ANTHROPIC_API_KEY");
      expect(seen.env).not.toContain("DATABASE_URL");
      for (const a of ["-p", "--strict-mcp-config", "--restricted", "--no-session-persistence", "--system-prompt-file", "--mcp-config"])
        expect(seen.args).toContain(a);
      expect(seen.args.slice(seen.args.indexOf("--effort"), seen.args.indexOf("--effort") + 2)).toEqual(["--effort", "xhigh"]);
      expect(seen.args.slice(seen.args.indexOf("--tools"), seen.args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
      expect(seen.prompt).toContain("research the pause powers");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("refuse calls past the session's budget, as the API loop does", async () => {
    const r = await agent("CALL kb_overview kb_overview", 1);
    expect(r.text).toMatch(/kb_overview:ok:/);
    expect(r.text).toMatch(/kb_overview:error:.*budget/i);
    expect(r.toolCalls).toBe(1);
  });

  it("stop when the evaluation is stopped", async () => {
    let calls = 0;
    const check = async () => {
      if (++calls > 1) throw new CancelledError("Cancelled");
    };
    await expect(agent("CALL kb_overview", 5, check)).rejects.toThrow(CancelledError);
  });
});

describe("structured steps through Claude Code", () => {
  const schemaOf = z.object({ answer: z.number() });
  it("return the session's structured output when it fits the schema, and nothing when it doesn't", async () => {
    const ok = await structuredViaClaudeCode({ model: "claude-opus-5-5", system: "s", user: 'JSON {"answer":4}', schema: schemaOf, usage: emptyUsage() });
    expect(ok.parsed_output).toEqual({ answer: 4 });
    const bad = await structuredViaClaudeCode({ model: "claude-opus-5-5", system: "s", user: 'JSON {"answer":"four"}', schema: schemaOf, usage: emptyUsage() });
    expect(bad.parsed_output).toBeNull();
  });

  it("stop on a plan limit in any of its wordings, without retrying, and leave a message the CLI recognises", async () => {
    for (const t of [
      "You've hit your session limit · resets 10:40pm",
      "You've hit your weekly limit · resets Oct 7, 9am",
      "Claude AI usage limit reached|1759420800",
      "5-hour limit reached ∙ resets 3pm",
      "You're out of extra usage · resets at 11pm",
    ])
      expect(isLimit(t), t).toBe(true);
    // Rate limits and overloads are transient, not plan limits.
    for (const t of ["API Error: 429 rate limit exceeded", "Overloaded", "request timed out"]) expect(isLimit(t), t).toBe(false);

    const started = Date.now();
    const err = await structuredViaClaudeCode({
      model: "claude-opus-5-5",
      system: "s",
      user: "FAIL You've hit your session limit · resets 10:40pm",
      schema: schemaOf,
      usage: emptyUsage(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeCodeLimitError);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(isClaudeCodeLimit(err.message)).toBe(true);
    expect(isClaudeCodeLimit("Claude Code session failed: boom")).toBe(false);
  });

  it("follow the evaluation's recorded backend", async () => {
    expect(llmBackend()).toBe("api");
    await callScope.run({ signal: new AbortController().signal, backend: "claude-code" }, async () => {
      expect(llmBackend()).toBe("claude-code");
    });
  });
});
