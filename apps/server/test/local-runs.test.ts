/**
 * Runs from the local CLI (`pnpm bench`): the server never takes one over and spends on it when the laptop stops
 * reporting, a run resumed from the admin becomes the server's, and the CLI's arguments parse as documented.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DB } from "../src/db/index.ts";

vi.mock("../src/lib/llm.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/llm.ts")>()), hasApiKey: () => true }));
vi.mock("../src/eval/pipeline.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/eval/pipeline.ts")>()),
  runEvaluation: vi.fn(async () => {}),
  // The scope the summary was written in: its backend, models and effort.
  summarize: vi.fn(async () => {
    const s = (await import("../src/lib/llm.ts")).callScope.getStore();
    summaryScope = { backend: s?.backend, models: s?.models, effort: s?.effort };
    return true;
  }),
}));
let summaryScope: Record<string, unknown> | null = null;

const { openDb, schema, setDb } = await import("../src/db/index.ts");
const { requeueInterrupted, resumeEvaluation, isRunning, HEARTBEAT_STALE_MS } = await import("../src/eval/queue.ts");
const { parseArgs, cliSettings, rerun, summarizeAgain } = await import("../src/scripts/bench.ts");
const { evalSettings } = await import("../src/eval/pipeline.ts");
const { callScope, stageEffort, stageModel } = await import("../src/lib/llm.ts");
const { env } = await import("../src/env.ts");

let db: DB;
const row = async (id: string) => (await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, id)))[0]!;
beforeAll(async () => {
  db = await openDb({ log: () => {} });
  setDb(db);
  await db.insert(schema.projects).values([
    { id: "p1", slug: "alpha", name: "Alpha", websiteUrl: "https://alpha.example.org" },
    { id: "p2", slug: "beta", name: "Beta", websiteUrl: "https://beta.example.org" },
    { id: "p3", slug: "gamma", name: "Gamma", websiteUrl: "https://gamma.example.org" },
  ]);
  const stale = new Date(Date.now() - HEARTBEAT_STALE_MS - 60_000).toISOString();
  const base = { mode: "deep", status: "running", stage: "research", runnerId: "laptop:1:abc" } as const;
  await db.insert(schema.evaluations).values([
    { ...base, id: "eLocal", projectId: "p1", heartbeatAt: stale, settings: { local: true } },
    { ...base, id: "eServer", projectId: "p2", heartbeatAt: stale, settings: {}, runnerId: "web:1:def" },
    { ...base, id: "eAwake", projectId: "p3", heartbeatAt: new Date().toISOString(), settings: { local: true } },
  ]);
});

describe("a local run that stops reporting", () => {
  it("is failed, to be resumed, instead of being re-queued on the server", async () => {
    await requeueInterrupted(db);
    const local = await row("eLocal");
    expect(local).toMatchObject({ status: "failed", runnerId: null });
    expect(local.error).toMatch(/pnpm bench resume/);
    expect((await row("eServer")).status).toBe("queued");
    expect(await row("eAwake")).toMatchObject({ status: "running", runnerId: "laptop:1:abc" });
  });

  it("becomes the server's run when resumed from the admin", async () => {
    await resumeEvaluation(db, "eLocal");
    for (let i = 0; i < 200 && isRunning("eLocal"); i++) await new Promise((r) => setTimeout(r, 10));
    expect((await row("eLocal")).settings).not.toHaveProperty("local");
  });
});

describe("the bench CLI's arguments", () => {
  it("parses positionals, flags with values and switches", () => {
    expect(parseArgs(["run", "aztec", "--mode", "standard", "--skip-kb", "--suites", "custody,exit"])).toEqual({
      command: "run",
      positional: ["aztec"],
      flags: { mode: "standard", "skip-kb": true, suites: "custody,exit" },
    });
    expect(parseArgs(["kb", "--version", "v2.0.0", "railgun"])).toEqual({ command: "kb", positional: ["railgun"], flags: { version: "v2.0.0" } });
    expect(parseArgs(["status"])).toEqual({ command: "status", positional: [], flags: {} });
  });

  it("refuses a flag without its value", () => {
    expect(() => parseArgs(["kb", "aztec", "--version"])).toThrow(/--version needs a value/);
    expect(() => parseArgs(["run", "aztec", "--mode", "--skip-kb"])).toThrow(/--mode needs a value/);
  });
});

describe("models, effort and cap for a run", () => {
  it("thinks at xhigh effort in deep mode, and high elsewhere", () => {
    const deep = evalSettings("deep");
    for (const s of ["scout", "code", "research", "judge", "skeptic"]) expect(deep.effort[s], s).toBe("xhigh");
    expect(evalSettings("standard").effort.judge).toBe("high");
  });

  it("runs every stage on the reasoning model from the CLI, with --model, --effort and --cap applied", () => {
    const d = cliSettings("deep", {});
    expect(new Set(Object.values(d.models))).toEqual(new Set([env.models.reason]));
    expect(d.effort.judge).toBe("xhigh");
    expect(d.local).toBe(true);
    // Through Claude Code (the default) nothing is billed to the API: no cap unless one is given.
    expect(d.backend).toBe("claude-code");
    expect(d.costCapUsd).toBeUndefined();
    const api = cliSettings("deep", { backend: "api" });
    expect(api.backend).toBe("api");
    expect(api.costCapUsd).toBe(300);
    expect(cliSettings("standard", { backend: "api" }).costCapUsd).toBeUndefined();
    expect(() => cliSettings("deep", { backend: "openai" })).toThrow(/--backend must be/);
    const t = cliSettings("deep", { model: "tiered", effort: "max", cap: "180" });
    expect(t.models.scout).toBe(evalSettings("deep").models.scout);
    expect(t.effort.research).toBe("max");
    expect(t.costCapUsd).toBe(180);
    expect(() => cliSettings("deep", { effort: "extreme" })).toThrow(/--effort must be one of/);
    expect(() => cliSettings("deep", { cap: "lots" })).toThrow(/--cap must be a dollar amount/);
  });

  it("uses the evaluation's recorded model and effort for every call in its scope", async () => {
    const signal = new AbortController().signal;
    expect(stageEffort("judge", "high")).toBe("high");
    await callScope.run({ signal, models: { judge: "claude-test-model" }, effort: { judge: "xhigh", research: "bogus" } }, async () => {
      expect(stageModel("judge")).toBe("claude-test-model");
      expect(stageEffort("judge", "high")).toBe("xhigh");
      // An unknown recorded value falls back.
      expect(stageEffort("research", "high")).toBe("high");
      expect(stageModel("scout")).toBe(evalSettings("deep").models.scout);
    });
  });
});

describe("re-running suites and the summary from the CLI", () => {
  const finished = {
    projectId: "p1",
    mode: "deep",
    stage: "score",
    completedStages: ["ingest", "scout", "code", "research", "judge", "verify", "skeptic", "score"],
    reviewedSuites: ["custody", "coverage"],
    costUsd: 120,
    settings: {
      local: true,
      backend: "claude-code",
      research: ["custody", "coverage"],
      judge: ["custody", "coverage"],
      codecheck: ["custody"],
      models: { summary: "claude-opus-5-5" },
      effort: { summary: "xhigh" },
    },
  } as const;
  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await db.insert(schema.projects).values([
      { id: "p4", slug: "delta", name: "Delta", websiteUrl: "https://delta.example.org" },
      { id: "p5", slug: "epsilon", name: "Epsilon", websiteUrl: "https://epsilon.example.org" },
    ]);
    await db.insert(schema.evaluations).values([
      { ...finished, id: "eRev", status: "review", projectId: "p4" },
      { ...finished, id: "ePubd", status: "published", projectId: "p4" },
      { ...finished, id: "eOne", status: "review", suiteFilter: ["custody"], projectId: "p4" },
      { ...finished, id: "eBusy", status: "running", projectId: "p5" },
      { ...finished, id: "eTwo", status: "review", projectId: "p5" },
    ] as never);
  });

  it("resets the named suites and the stages after them, as the admin's rerun does, and runs them on this machine", async () => {
    await rerun(db, "eRev", { suites: "coverage" });
    const ev = await row("eRev");
    expect(ev.completedStages).toEqual(["ingest", "scout", "code"]);
    expect(ev.reviewedSuites).toEqual(["custody"]);
    expect(ev.settings).toMatchObject({ local: true, backend: "claude-code", research: ["custody"], judge: ["custody"], codecheck: ["custody"] });
    expect(ev.settings).not.toHaveProperty("costCapUsd");
  });

  it("refuses published evaluations, unknown suites and suites the evaluation never ran", async () => {
    await expect(rerun(db, "ePubd", { suites: "custody" })).rejects.toThrow(/review, reviewed, failed or cancelled/);
    await expect(rerun(db, "eRev", { suites: "privacy" })).rejects.toThrow(/Unknown suite/);
    await expect(rerun(db, "eRev", {})).rejects.toThrow(/Name the suites/);
    await expect(rerun(db, "eOne", { suites: "coverage" })).rejects.toThrow(/covers only custody/);
    // eBusy holds its project's one running slot.
    await expect(rerun(db, "eTwo", { suites: "custody" })).rejects.toThrow(/epsilon is already running/);
    expect((await row("eTwo")).status).toBe("review");
  });

  it("writes the summary through Claude Code with the evaluation's recorded models, never while the pipeline runs", async () => {
    await summarizeAgain(db, "eOne", {});
    expect(summaryScope).toEqual({ backend: "claude-code", models: { summary: "claude-opus-5-5" }, effort: { summary: "xhigh" } });
    await expect(summarizeAgain(db, "eBusy", {})).rejects.toThrow(/pipeline writes its summary/);
  });
});
