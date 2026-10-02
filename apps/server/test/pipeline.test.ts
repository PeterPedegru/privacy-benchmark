/**
 * The evaluation state machine against a scripted model (R3-TEST-1 to 4): rerun, resume, cancel, the cost cap,
 * score-stage failures and verify. The real llmCall runs (retries, limiter, reservations); only the API is fake,
 * and it honours abort signals like the SDK does.
 */
import { getCriterion, suites } from "@pb/rubric";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DB } from "../src/db/index.ts";

type P = { system?: { text: string }[]; messages: { role: string; content: unknown }[]; output_config?: { format?: unknown } };
type Handler = (p: P) => Promise<unknown>;
let streamHandler: Handler = async () => {
  throw new Error("no handler");
};
let parseHandler: Handler = async () => ({ parsed_output: null, usage: usage(), stop_reason: "end_turn" });
let streamCalls = 0;

/** Rejects like the SDK when the request's signal aborts. */
const abortable = <T>(promise: Promise<T>, signal?: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Request was aborted."));
    signal?.addEventListener("abort", () => reject(new Error("Request was aborted.")), { once: true });
    promise.then(resolve, reject);
  });

vi.mock("../src/lib/llm.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/llm.ts")>();
  return {
    ...orig,
    hasApiKey: () => true,
    anthropic: () => ({
      beta: {
        messages: {
          stream: (p: P, opts?: { signal?: AbortSignal }) => ({
            finalMessage: () => {
              // Single-shot structured calls (summary, change explanations, code map) have a plain-string system
              // prompt; they're scripted with parseHandler like the non-streamed calls.
              if (typeof (p.system as unknown) === "string") return abortable(parseHandler(p), opts?.signal);
              streamCalls++;
              return abortable(streamHandler({ ...p, messages: structuredClone(p.messages) }), opts?.signal);
            },
          }),
          parse: (p: P, opts?: { signal?: AbortSignal }) => abortable(parseHandler(p), opts?.signal),
        },
      },
    }),
  };
});

const { openDb, schema } = await import("../src/db/index.ts");
const { runEvaluation, STAGES } = await import("../src/eval/pipeline.ts");
const { rerunSuites, resumeEvaluation, kick, isRunning, cancelEvaluation } = await import("../src/eval/queue.ts");

const SOURCE = "The rollup contracts are immutable. There is no pause function in the core contracts.";
const QUOTE = "There is no pause function in the core contracts.";
const usage = (input = 10) => ({ input_tokens: input, output_tokens: 5 });
const text = (t: string, input = 10) => ({ role: "assistant", stop_reason: "end_turn", usage: usage(input), content: [{ type: "text", text: t }] });
const toolUse = (name: string, input: unknown, tokens = 10) => ({
  role: "assistant",
  stop_reason: "tool_use",
  usage: usage(tokens),
  content: [{ type: "tool_use", id: `t${Math.random().toString(36).slice(2)}`, name, input }],
});
const judgeReply = { stop_reason: "end_turn", usage: usage(), content: [], parsed_output: { answers: [] } };
const isJudge = (p: P) => !!p.output_config?.format;
const suiteOf = (p: P) => suites.find((s) => p.system?.[0]?.text.includes(`Your suite is ${s.name}.`))?.id ?? null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await fn()) && Date.now() < end) await sleep(10);
  return fn();
}

let db: DB;
beforeAll(async () => {
  db = await openDb({ log: () => {} });
  const { setDb } = await import("../src/db/index.ts");
  setDb(db);
  await db
    .insert(schema.projects)
    .values({ id: "p1", slug: "alpha", name: "Alpha", websiteUrl: "https://alpha.example.org", kbStatus: "ready", kbRefreshedAt: new Date().toISOString() });
  await db.insert(schema.sources).values({
    id: "s1",
    projectId: "p1",
    url: "https://docs.alpha.example.org/security",
    title: "Security",
    kind: "docs",
    sourceClass: "official_docs",
    contentMd: SOURCE,
    contentHash: "h",
    origin: "kb",
  });
});
const row = async (id: string) => (await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, id)))[0]!;

describe("rerunning a suite that had no evidence (R3-REL-1)", () => {
  it("judges the suite once the rerun finds verified evidence", async () => {
    const all = suites.map((s) => s.id);
    await db.insert(schema.evaluations).values({
      id: "eA",
      projectId: "p1",
      mode: "quick",
      status: "review",
      stage: "review",
      completedStages: [...STAGES],
      settings: { research: all, judge: all, unresearched: ["custody"] },
    });
    streamHandler = async (p) => {
      if (isJudge(p)) return judgeReply;
      if (suiteOf(p) === "custody" && p.messages.length === 1)
        return toolUse("record_evidence", {
          items: [{ criterionId: "custody.pause.pause-fn", sourceId: "s1", quote: QUOTE, claim: "No pause", stance: "supports" }],
        });
      return text("done");
    };
    await rerunSuites(db, "eA", ["custody"]);
    expect(await until(async () => ["review", "failed"].includes((await row("eA")).status) && !isRunning("eA"))).toBe(true);
    const pause = (await db.select().from(schema.criterionResults).where(eq(schema.criterionResults.evaluationId, "eA"))).find(
      (x) => x.criterionId === "custody.pause.pause-fn",
    );
    expect(pause?.status).not.toBe("not_researched");
    expect(((await row("eA")).settings as { unresearched?: string[] }).unresearched ?? []).not.toContain("custody");
  });

  it("refuses to rerun a published evaluation", async () => {
    await db.insert(schema.evaluations).values({ id: "ePub", projectId: "p1", mode: "quick", status: "published", stage: "review" });
    await expect(rerunSuites(db, "ePub", ["custody"])).rejects.toThrow(/review, failed or cancelled/);
  });
});

describe("a failed evaluation with a sibling suite mid-call (R3-REL-2)", () => {
  it("aborts the sibling and settles before it can be resumed, so no orphan keeps working", async () => {
    await db.insert(schema.evaluations).values({
      id: "eB",
      projectId: "p1",
      mode: "quick",
      suiteFilter: ["custody", "governance"],
      status: "queued",
      stage: "research",
      completedStages: ["ingest", "scout", "code"],
      settings: {},
    });
    let releaseOld!: (v: unknown) => void;
    const old = new Promise((r) => {
      releaseOld = r;
    });
    let phase = 1;
    let orphanTurns = 0;
    streamHandler = async (p) => {
      if (isJudge(p)) return judgeReply;
      const s = suiteOf(p);
      if (phase === 1) {
        if (s === "custody") throw new Error("invalid_request_error: something non-retryable");
        if (s === "governance") return old;
      }
      if (s === "governance" && p.messages.length >= 3) orphanTurns++;
      return text("done");
    };
    await kick(db);
    expect(await until(async () => (await row("eB")).status === "failed")).toBe(true);
    // The runner is gone only after its sibling settled (aborted), so Resume can't start a second runner beside it.
    expect(await until(() => !isRunning("eB"))).toBe(true);
    phase = 2;
    await resumeEvaluation(db, "eB");
    releaseOld(toolUse("kb_overview", {}));
    expect(await until(async () => ["review", "failed"].includes((await row("eB")).status) && !isRunning("eB"))).toBe(true);
    expect(orphanTurns).toBe(0);
  });
});

describe("cancel (R3-REL-11)", () => {
  it("aborts calls in flight and ends cancelled", async () => {
    await db.insert(schema.evaluations).values({
      id: "eX",
      projectId: "p1",
      mode: "quick",
      suiteFilter: ["custody"],
      status: "queued",
      stage: "research",
      completedStages: ["ingest", "scout", "code"],
      settings: {},
    });
    let started = false;
    streamHandler = async (p) => {
      if (isJudge(p)) return judgeReply;
      started = true;
      return new Promise(() => {}); // never answers on its own
    };
    await kick(db);
    expect(await until(() => started)).toBe(true);
    await cancelEvaluation(db, "eX");
    expect(await until(() => !isRunning("eX"))).toBe(true);
    expect((await row("eX")).status).toBe("cancelled");
  });
});

describe("score-stage failures (R3-REL-7)", () => {
  it("leaves the evaluation in review with no summary instead of failing it", async () => {
    await db.insert(schema.evaluations).values({
      id: "eD",
      projectId: "p1",
      mode: "quick",
      status: "running",
      stage: "score",
      completedStages: ["ingest", "scout", "code", "research", "judge", "verify"],
      settings: {},
    });
    parseHandler = async () => {
      throw new Error("Failed to parse structured output: SyntaxError: Unexpected end of JSON input");
    };
    await runEvaluation(db, "eD");
    expect((await row("eD")).status).toBe("review");
    expect((await row("eD")).summaryAt).toBeNull();
  });
});

describe("the cost cap with parallel suites (R3-REL-9)", () => {
  it("stays within one call of the cap", async () => {
    await db
      .insert(schema.evaluations)
      .values({ id: "eE", projectId: "p1", mode: "quick", status: "running", stage: "research", completedStages: ["ingest", "scout", "code"], settings: {} });
    // 250k uncached Opus input tokens is $1.00 per call.
    streamHandler = async (p) => {
      if (isJudge(p)) return judgeReply;
      await sleep(10 + Math.random() * 20);
      return toolUse("kb_overview", {}, 250_000);
    };
    await runEvaluation(db, "eE").catch(() => null);
    const e = await row("eE");
    expect(e.status).toBe("failed");
    expect(e.error).toMatch(/Cost cap/);
    expect(e.costUsd).toBeLessThanOrEqual(10 + 1.01);
  });
});

describe("verify resumed after the skeptic recorded counter-evidence (R3-REL-5)", () => {
  it("re-judges instead of stamping the answer skeptic_checked", async () => {
    const c = getCriterion("custody.pause.pause-fn");
    const best = c.options.reduce((a, o) => (o.points > a.points ? o : a));
    parseHandler = async () => ({ parsed_output: null, usage: usage(), stop_reason: "end_turn" });
    await db.insert(schema.evaluations).values({
      id: "eF",
      projectId: "p1",
      mode: "quick",
      status: "running",
      stage: "verify",
      completedStages: ["ingest", "scout", "code", "research", "judge"],
      settings: {},
    });
    const base = {
      evaluationId: "eF",
      criterionId: c.id,
      sourceId: "s1",
      url: "https://docs.alpha.example.org/security",
      sourceClass: "official_docs",
      verified: true,
      verifyMethod: "exact",
    };
    await db.insert(schema.evidence).values({ ...base, id: "evS", quote: QUOTE, claim: "no pause", stance: "supports", createdByStage: "research.custody" });
    // Recorded by the skeptic just before a restart:
    await db
      .insert(schema.evidence)
      .values({ ...base, id: "evX", quote: "The rollup contracts are immutable.", claim: "counter", stance: "contradicts", createdByStage: "skeptic" });
    await db.insert(schema.criterionResults).values({
      id: "crF",
      evaluationId: "eF",
      criterionId: c.id,
      status: "answered",
      optionId: best.id,
      rationale: "r",
      confidence: "high",
      evidenceIds: ["evS"],
    });
    let judged = 0;
    streamHandler = async (p) => {
      if (isJudge(p)) {
        judged++;
        return judgeReply;
      }
      if (p.messages.length === 1)
        return toolUse("record_evidence", {
          items: [{ criterionId: c.id, sourceId: "s1", quote: "The rollup contracts are immutable.", claim: "counter", stance: "contradicts" }],
        });
      // The skeptic even claims the answer holds: the new counter-evidence still means a re-judge, not "checked".
      if (p.messages.length === 3) return toolUse("report_challenge", { criterionId: c.id, outcome: "answer_holds", searched: ["search_sources: pause"] });
      return text("done");
    };
    await runEvaluation(db, "eF");
    const r = (await db.select().from(schema.criterionResults).where(eq(schema.criterionResults.id, "crF")))[0]!;
    expect(judged).toBeGreaterThan(0);
    expect(r.flags).not.toContain("skeptic_checked");
  });
});

describe("reruns keep what answers cite, and never keep a stale summary (R4-1, R4-3)", () => {
  it("keeps the skeptic evidence a re-judged answer cites when another suite is rerun", async () => {
    const all = suites.map((x) => x.id);
    await db.insert(schema.evaluations).values({
      id: "eR",
      projectId: "p1",
      mode: "quick",
      status: "review",
      stage: "review",
      completedStages: [...STAGES],
      settings: { research: all, judge: all },
      summary: "OLD SUMMARY: no protocol-level pause.",
      summaryAt: "2026-09-01T00:00:00Z",
    });
    const c = getCriterion("custody.pause.pause-fn");
    await db.insert(schema.evidence).values({
      id: "evK",
      evaluationId: "eR",
      criterionId: c.id,
      quote: QUOTE,
      sourceId: "s1",
      url: "https://docs.alpha.example.org/security",
      stance: "contradicts",
      verified: true,
      verifyMethod: "exact",
      createdByStage: "skeptic",
    });
    await db.insert(schema.criterionResults).values({
      id: "crR",
      evaluationId: "eR",
      criterionId: c.id,
      status: "answered",
      optionId: "any-single",
      evidenceIds: ["evK"],
      decisiveEvidenceIds: ["evK"],
    });
    parseHandler = async () => {
      throw new Error("Failed to parse structured output");
    };
    streamHandler = async (p) => (isJudge(p) ? judgeReply : text("done"));
    await rerunSuites(db, "eR", ["governance"]);
    expect(await until(async () => ["review", "failed"].includes((await row("eR")).status) && !isRunning("eR"))).toBe(true);
    expect((await db.select().from(schema.evidence).where(eq(schema.evidence.id, "evK")))[0]).toBeTruthy();
    const r = (await db.select().from(schema.criterionResults).where(eq(schema.criterionResults.id, "crR")))[0]!;
    expect(r.decisiveEvidenceIds).toEqual(["evK"]);
    expect(r.flags).not.toContain("evidence_missing");
    // The summary failed after the rerun: the old one is gone, so publishing blocks until it's regenerated.
    expect((await row("eR")).summary).toBe("");
    expect((await row("eR")).summaryAt).toBeNull();
  });
});

describe("a stop during the score stage (R4-5)", () => {
  it("doesn't mark the stage done", async () => {
    await db.insert(schema.evaluations).values({
      id: "eS",
      projectId: "p1",
      mode: "quick",
      status: "running",
      stage: "score",
      completedStages: ["ingest", "scout", "code", "research", "judge", "verify"],
      settings: {},
    });
    let summarizing = false;
    parseHandler = () => {
      summarizing = true;
      return new Promise(() => {}); // aborted below
    };
    const ctl = new AbortController();
    const run = runEvaluation(db, "eS", { signal: ctl.signal }).catch(() => null);
    expect(await until(() => summarizing)).toBe(true);
    await db.update(schema.evaluations).set({ status: "queued" }).where(eq(schema.evaluations.id, "eS"));
    ctl.abort("Server restarting");
    await run;
    expect((await row("eS")).completedStages).not.toContain("score");
  });
});

describe("a rerun keeps change flags the reviewer accepted (R5-2)", () => {
  it("doesn't bring back changed_since_published for an unchanged, accepted answer", async () => {
    await db.insert(schema.releases).values({ id: "rel0", label: "R0", rubricVersion: "1.2.1" });
    await db.insert(schema.publishedResults).values({
      id: "pub0",
      releaseId: "rel0",
      projectId: "p1",
      active: true,
      snapshot: { criteria: { "custody.pause.pause-fn": { status: "answered", optionId: "none", rationale: "", evidence: [] } } } as never,
    });
    const all = suites.map((x) => x.id);
    await db.insert(schema.evaluations).values({
      id: "eC2",
      projectId: "p1",
      mode: "quick",
      status: "review",
      stage: "review",
      completedStages: [...STAGES],
      settings: { research: all, judge: all },
    });
    await db.insert(schema.criterionResults).values({
      id: "crC2",
      evaluationId: "eC2",
      criterionId: "custody.pause.pause-fn",
      status: "answered",
      optionId: "any-single",
      change: { kind: "unexplained", note: "Accepted.", from: "none", to: "any-single", evidenceIds: [] },
      acceptedFlags: { flags: ["changed_since_published", "change_unexplained"], status: "answered", optionId: "any-single" },
    });
    let changeCalls = 0;
    parseHandler = async (p) => {
      if (JSON.stringify(p).includes("Changed answers")) changeCalls++;
      throw new Error("Failed to parse structured output");
    };
    streamHandler = async (p) => (isJudge(p) ? judgeReply : text("done"));
    await rerunSuites(db, "eC2", ["governance"]);
    expect(await until(async () => ["review", "failed"].includes((await row("eC2")).status) && !isRunning("eC2"))).toBe(true);
    const r = (await db.select().from(schema.criterionResults).where(eq(schema.criterionResults.id, "crC2")))[0]!;
    expect(r.flags).not.toContain("changed_since_published");
    expect(r.flags).not.toContain("change_unexplained");
    expect(changeCalls).toBe(0);
  });
});

describe("a logged search answers a criterion's no-data option (rubric 1.3.0)", () => {
  it("records Unclear with the search log, settled for coverage and shown as not disclosed", async () => {
    const all = suites.map((x) => x.id);
    await db.insert(schema.evaluations).values({
      id: "eND",
      projectId: "p1",
      mode: "quick",
      status: "review",
      stage: "review",
      completedStages: [...STAGES],
      settings: { research: all, judge: all },
    });
    const id = "governance.process.concentration";
    streamHandler = async (p) => {
      if (isJudge(p)) return judgeReply;
      // Research verifies something in the suite (else it's "not researched"), and logs a search that found nothing.
      if (suiteOf(p) === "governance" && p.messages.length === 1)
        return toolUse("record_evidence", {
          items: [
            {
              criterionId: "governance.upgrades.upgradeability",
              sourceId: "s1",
              quote: "The rollup contracts are immutable.",
              claim: "Immutable",
              stance: "supports",
            },
          ],
        });
      if (suiteOf(p) === "governance" && p.messages.length === 3)
        return toolUse("record_search", { criterionId: id, searched: ["docs governance pages", "forum delegate lists"], note: "No voting data is published." });
      return text("done");
    };
    await rerunSuites(db, "eND", ["governance"]);
    expect(await until(async () => ["review", "failed"].includes((await row("eND")).status) && !isRunning("eND"))).toBe(true);
    const results = await db.select().from(schema.criterionResults).where(eq(schema.criterionResults.evaluationId, "eND"));
    const r = results.find((x) => x.criterionId === id)!;
    expect(r).toMatchObject({ status: "answered", optionId: getCriterion(id).noDataOption, proposedOptionId: null });
    expect(r.rationale).toMatch(/^Not disclosed/);
    expect(r.searchLog?.searched).toContain("forum delegate lists");
    expect(r.flags).not.toContain("no_evidence");
    // Without a logged search the criterion stays unknown.
    expect(results.find((x) => x.criterionId === "governance.roles.holders")?.status).toBe("unknown");

    const { evidenceCoverage } = await import("../src/services/coverage.ts");
    const { buildSnapshot, loadEvaluation } = await import("../src/services/snapshots.ts");
    const gov = (await evidenceCoverage(db, "eND")).suites.find((s) => s.suiteId === "governance")!;
    expect(gov.covered).toBeGreaterThanOrEqual(1);
    const snap = buildSnapshot((await loadEvaluation(db, "eND"))!, { releaseId: "x", label: "x", rubricVersion: "1.3.0", publishedAt: "2026-10-01" } as never);
    expect(snap.criteria[id]).toMatchObject({ status: "answered", optionId: "unclear" });
    // The project has no code, so the code check logs that, and the answer counts as code-checked.
    expect(snap.criteria[id]!.searchLog?.searched).toEqual(expect.arrayContaining(["docs governance pages", "forum delegate lists"]));
    expect(snap.criteria[id]!.searchLog?.codeChecked).toBe(true);
    expect(snap.criteria[id]!.flags).not.toContain("unverified");
  });
});

describe("the code check settles unknowns from the code (code is the source of truth)", () => {
  it("checks every code-decidable unknown, re-judges with what it finds, and logs the search as code-checked", async () => {
    const CODE = "contract Pool {\n  function blacklist(address account) external onlyOwner {\n    blocked[account] = true;\n  }\n}";
    await db
      .insert(schema.projects)
      .values({ id: "p2", slug: "beta", name: "Beta", websiteUrl: "https://beta.example.org", kbStatus: "ready", kbRefreshedAt: new Date().toISOString() });
    await db.insert(schema.sources).values([
      {
        id: "s2d",
        projectId: "p2",
        url: "https://docs.beta.example.org/security",
        title: "Security",
        kind: "docs",
        sourceClass: "official_docs",
        contentMd: SOURCE,
        contentHash: "h2",
        origin: "kb",
      },
      {
        id: "s2c",
        projectId: "p2",
        url: "https://github.com/beta/core/blob/v1/src/Pool.sol",
        title: "Pool.sol",
        kind: "code",
        sourceClass: "code_onchain",
        contentMd: CODE,
        contentHash: "h3",
        origin: "kb",
      },
    ]);
    const all = suites.map((x) => x.id);
    await db.insert(schema.evaluations).values({
      id: "eCC",
      projectId: "p2",
      mode: "quick",
      status: "review",
      stage: "review",
      completedStages: [...STAGES],
      settings: { research: all, judge: all, codecheck: all, codeCheck: true },
    });
    const blocklist = "custody.freeze.blocklist";
    const prompts: string[] = [];
    streamHandler = async (p) => {
      const system = p.system?.[0]?.text ?? "";
      const user = JSON.stringify(p.messages[0]?.content ?? "");
      if (isJudge(p)) {
        // The re-judge after the code check answers the blocklist from the code it found.
        const ev = (await db.select().from(schema.evidence).where(eq(schema.evidence.evaluationId, "eCC"))).find(
          (e) => e.createdByStage === "codecheck.custody",
        );
        if (!ev || !user.includes(ev.id)) return judgeReply;
        const answer = {
          criterionId: blocklist,
          status: "answered",
          optionId: "protocol-wide",
          rationale: "The owner can blacklist any account.",
          evidenceIds: [ev.id],
          decisiveEvidenceIds: [ev.id],
          confidence: "high",
        };
        return { ...judgeReply, parsed_output: { answers: [answer] } };
      }
      if (system.includes("You are the code checker")) {
        if (p.messages.length === 1) {
          prompts.push(user);
          return toolUse("record_evidence", {
            items: [
              {
                criterionId: blocklist,
                sourceId: "s2c",
                quote: "function blacklist(address account) external onlyOwner",
                claim: "Owner blacklist",
                stance: "contradicts",
              },
            ],
          });
        }
        if (p.messages.length === 3)
          return toolUse("record_search", {
            criterionId: "custody.exit.window",
            searched: ["src/Pool.sol", "evm_read exitDelay() on the pool"],
            note: "No exit delay in the code.",
          });
        return text("done");
      }
      if (suiteOf(p) === "custody" && p.messages.length === 1)
        return toolUse("record_evidence", {
          items: [{ criterionId: "custody.pause.pause-fn", sourceId: "s2d", quote: QUOTE, claim: "No pause", stance: "supports" }],
        });
      if (suiteOf(p) === "custody" && p.messages.length === 3)
        return toolUse("record_search", {
          criterionId: "custody.pause.track-record",
          searched: ["status page", "incident reports"],
          note: "No incident history published.",
        });
      return text("done");
    };
    await rerunSuites(db, "eCC", ["custody"]);
    expect(await until(async () => ["review", "failed"].includes((await row("eCC")).status) && !isRunning("eCC"))).toBe(true);
    expect((await row("eCC")).error ?? null).toBeNull();
    expect((await row("eCC")).completedStages).toContain("codecheck");

    // The checker was asked about code-decidable unknowns only: never a track record, never the custody suite's settled answers.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(blocklist);
    expect(prompts[0]).toContain("custody.exit.window");
    expect(prompts[0]).not.toContain("custody.pause.track-record");

    const results = new Map(
      (await db.select().from(schema.criterionResults).where(eq(schema.criterionResults.evaluationId, "eCC"))).map((r) => [r.criterionId, r]),
    );
    const bl = results.get(blocklist)!;
    expect(bl).toMatchObject({ status: "answered", optionId: "protocol-wide" });
    expect(bl.votes.at(-1)).toMatchObject({ pass: "codecheck", round: 2 });
    const window = results.get("custody.exit.window")!;
    expect(window.status).toBe("unknown");
    expect(window.searchLog?.codeChecked).toBe(true);
    const track = results.get("custody.pause.track-record")!;
    expect(track.searchLog?.codeChecked).toBe(false);

    // Not disclosed counts only once the code was checked, except where code can't decide it (a track record).
    const { evidenceCoverage } = await import("../src/services/coverage.ts");
    const { coverageFrom } = await import("../src/services/coverage.ts");
    const custody = (cov: Awaited<ReturnType<typeof evidenceCoverage>>) => cov.suites.find((s) => s.suiteId === "custody")!.covered;
    const rows = [...results.values()];
    const strict = coverageFrom(rows, [], ["custody"], { requireCodeCheck: true });
    const lax = coverageFrom(rows, [], ["custody"]);
    expect(custody(lax)).toBeGreaterThanOrEqual(custody(strict));
    const unchecked = rows.map((r) => (r.criterionId === "custody.exit.window" ? { ...r, searchLog: { ...r.searchLog!, codeChecked: false } } : r));
    expect(custody(coverageFrom(unchecked, [], ["custody"], { requireCodeCheck: true }))).toBe(custody(strict) - 1);
    expect(custody(coverageFrom(unchecked, [], ["custody"]))).toBe(custody(lax));
    expect(((await row("eCC")).settings as { codecheck?: string[] }).codecheck).toContain("custody");
  });
});

describe("knowledge bases built locally (KB_BUILD=local)", () => {
  it("fails an evaluation with no ready knowledge base for its version, naming the command, before any model call", async () => {
    await db.insert(schema.projects).values({ id: "pL", slug: "lima", name: "Lima", websiteUrl: "https://lima.example.org" });
    await db.insert(schema.evaluations).values({ id: "eL", projectId: "pL", mode: "quick", status: "running", stage: "ingest", settings: {} });
    const calls = streamCalls;
    await runEvaluation(db, "eL", { buildKb: false }).catch(() => {});
    const e = await row("eL");
    expect(e.status).toBe("failed");
    expect(e.error).toMatch(/pnpm bench kb lima/);
    expect(e.completedStages).not.toContain("ingest");
    expect(streamCalls).toBe(calls);
  });

  it("uses the ready knowledge base as it is", async () => {
    await db.insert(schema.evaluations).values({
      id: "eK",
      projectId: "p1",
      mode: "quick",
      status: "running",
      stage: "ingest",
      completedStages: STAGES.filter((s) => s !== "ingest"),
      settings: {},
    });
    await runEvaluation(db, "eK", { buildKb: false });
    expect((await row("eK")).status).toBe("review");
    const events = await db.select().from(schema.runEvents).where(eq(schema.runEvents.evaluationId, "eK"));
    expect(events.map((x) => x.message).join("\n")).toMatch(/Using the knowledge base built today/);
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, "p1")))[0]!.kbStatus).toBe("ready");
  });
});
