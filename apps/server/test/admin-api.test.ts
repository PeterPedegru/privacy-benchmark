/**
 * The admin API's write side (R3-TEST-10, R3-REL-16): input validation, evaluation state guards, the release request
 * checks, and source deletion against frozen snapshots. The pipeline is mocked: runEvaluation never settles until the
 * end (so the queue's in-memory running set can be observed) and summarize spends a fixed $0.50 without a model.
 */
import { criteria, getCriterion, suites } from "@pb/rubric";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DB } from "../src/db/index.ts";

const h = vi.hoisted(() => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { gate, release: () => release(), duringSummary: null as null | (() => void) };
});

vi.mock("../src/lib/llm.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/llm.ts")>()), hasApiKey: () => true }));
vi.mock("../src/eval/pipeline.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/eval/pipeline.ts")>()),
  runEvaluation: vi.fn(() => h.gate),
  summarize: vi.fn(async (_db: unknown, _id: string, usage: { costUsd: number }) => {
    h.duringSummary?.();
    usage.costUsd += 0.5;
    return true;
  }),
}));

const { createApp } = await import("../src/app.ts");
const { openDb, schema, setDb } = await import("../src/db/index.ts");
const { isRunning, kick, projectBusy } = await import("../src/eval/queue.ts");

let app: ReturnType<typeof createApp>;
let db: DB;
let cookies = "";
let csrf = "";

const QUOTE = "The core contracts are immutable and there is no pause function anywhere in the protocol code.";

/** An evaluation with a verified supporting quote for every criterion, so it passes the coverage gate. */
async function seedEvaluation(
  id: string,
  opts: { projectId?: string; versionId?: string | null; status?: string; isDemo?: boolean; costUsd?: number; heartbeatAt?: string } = {},
) {
  await db.insert(schema.evaluations).values({
    id,
    projectId: opts.projectId ?? "p1",
    versionId: opts.versionId ?? null,
    mode: "standard",
    status: opts.status ?? "review",
    stage: "review",
    completedStages: ["ingest", "scout", "code", "research", "judge", "verify", "score"],
    settings: { research: suites.map((s) => s.id), judge: suites.map((s) => s.id) } as never,
    summary: "A summary.",
    summaryAt: "2026-09-30T00:00:00Z",
    isDemo: opts.isDemo ?? false,
    costUsd: opts.costUsd ?? 0,
    heartbeatAt: opts.heartbeatAt ?? null,
    runnerId: opts.heartbeatAt ? "another-process" : null,
  });
  for (const c of criteria) {
    await db.insert(schema.criterionResults).values({
      id: `${id}-${c.id}`,
      evaluationId: id,
      criterionId: c.id,
      status: "answered",
      optionId: c.options[0]!.id,
      evidenceIds: [`${id}-e-${c.id}`],
      updatedAt: "2026-09-29T00:00:00Z",
    });
    await db.insert(schema.evidence).values({
      id: `${id}-e-${c.id}`,
      evaluationId: id,
      criterionId: c.id,
      quote: QUOTE,
      sourceId: "s1",
      stance: "supports",
      verified: true,
      verifyMethod: "exact",
    });
  }
}

const send = (path: string, body: unknown, method = "POST") =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", cookie: cookies, "x-csrf-token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
const status = async (id: string) => (await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, id)))[0]!;

beforeAll(async () => {
  db = await openDb({ log: () => {} });
  setDb(db);
  await db.insert(schema.projects).values([
    { id: "p1", slug: "alpha", name: "Alpha", websiteUrl: "https://alpha.example.org" },
    { id: "p2", slug: "beta", name: "Beta", websiteUrl: "https://beta.example.org" },
    { id: "p3", slug: "gamma", name: "Gamma", websiteUrl: "https://gamma.example.org" },
  ]);
  await db.insert(schema.projectVersions).values({ id: "v1", projectId: "p1", version: "v1", label: "V1", status: "tracked" });
  await db
    .insert(schema.sources)
    .values({ id: "s1", projectId: "p1", url: "https://docs.alpha.example.org/security", title: "Security", contentMd: QUOTE, contentHash: "h" });
  await seedEvaluation("e-review", { versionId: "v1" });
  // Running in another (live) process: its heartbeat is fresh, so this one's queue leaves it alone.
  await seedEvaluation("e-running", { status: "running", heartbeatAt: "2999-01-01T00:00:00.000Z", projectId: "p3" });
  await seedEvaluation("e-published", { status: "published" });
  await seedEvaluation("e-failed", { status: "failed" });
  await seedEvaluation("e-demo", { status: "reviewed", isDemo: true });
  await seedEvaluation("e-summary", { costUsd: 1 });
  app = createApp();
  const login = await app.request("/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  cookies = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  csrf = decodeURIComponent(/pb_csrf=([^;]+)/.exec(cookies)?.[1] ?? "");
});

afterAll(() => h.release());

describe("starting runs", () => {
  it("rejects a bad mode (400) and unknown project ids (422, not 500)", async () => {
    expect((await send("/api/admin/runs", { projectIds: ["p1"], mode: "turbo" })).status).toBe(400);
    const unknown = await send("/api/admin/runs", { projectIds: ["p1", "nope"], mode: "quick" });
    expect(unknown.status).toBe(422);
    expect(await errorOf(unknown)).toBe("unknown_projects");
  });

  it("drops unknown suites and starts the evaluation", async () => {
    const res = await send("/api/admin/runs", { projectIds: ["p2"], mode: "quick", suites: ["custody", "astrology"] });
    expect(res.status).toBe(200);
    const runId = ((await res.json()) as { id: string }).id;
    const ev = (await db.select().from(schema.evaluations).where(eq(schema.evaluations.runId, runId)))[0]!;
    expect(ev.suiteFilter).toEqual(["custody"]);
    expect(isRunning(ev.id)).toBe(true);
  });
});

describe("knowledge bases built locally (KB_BUILD=local)", () => {
  it("refuses a refresh from the admin, naming the command that builds it", async () => {
    const { env } = await import("../src/env.ts");
    const was = env.kbBuild;
    (env as { kbBuild: string }).kbBuild = "local";
    try {
      const res = await send("/api/admin/projects/p2/kb/refresh", {});
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("kb_built_locally");
      expect(body.message).toMatch(/pnpm bench kb beta/);
    } finally {
      (env as { kbBuild: string }).kbBuild = was;
    }
  });
});

describe("evaluation state guards (R3-REL-16)", () => {
  it("re-runs only evaluations in review, reviewed, failed or cancelled", async () => {
    for (const id of ["e-running", "e-published"]) {
      const res = await send(`/api/admin/evaluations/${id}/rerun`, { suites: ["custody"] });
      expect(res.status, id).toBe(409);
      expect(await errorOf(res)).toBe("not_rerunnable");
    }
    expect((await status("e-published")).status).toBe("published");
    expect((await send("/api/admin/evaluations/e-demo/rerun", { suites: ["custody"] })).status).toBe(409);
    expect((await send("/api/admin/evaluations/e-review/rerun", { suites: ["astrology"] })).status).toBe(400);
    expect((await send("/api/admin/evaluations/missing/rerun", { suites: ["custody"] })).status).toBe(404);
  });

  it("resumes only failed or cancelled evaluations", async () => {
    for (const id of ["e-running", "e-published", "e-review"]) {
      const res = await send(`/api/admin/evaluations/${id}/resume`, undefined);
      expect(res.status, id).toBe(409);
      expect(await errorOf(res)).toBe("cannot_resume");
    }
  });

  it("refuses resume and rerun while the old runner is still in this process (R3-REL-2)", async () => {
    // A failed evaluation whose sibling suites are still inside model calls: its runner hasn't returned.
    await seedEvaluation("e-orphan", { status: "queued" });
    await kick(db);
    expect(isRunning("e-orphan")).toBe(true);
    await db.update(schema.evaluations).set({ status: "failed" }).where(eq(schema.evaluations.id, "e-orphan"));
    for (const action of ["resume", "rerun"]) {
      const res = await send(`/api/admin/evaluations/e-orphan/${action}`, action === "rerun" ? { suites: ["custody"] } : undefined);
      expect(res.status, action).toBe(409);
      expect(await errorOf(res)).toBe("still_stopping");
    }
    expect((await status("e-orphan")).status).toBe("failed");
  });

  it("re-runs a reviewable evaluation from research, keeping the earlier stages", async () => {
    const res = await send("/api/admin/evaluations/e-review/rerun", { suites: ["custody"] });
    expect(res.status).toBe(200);
    const ev = await status("e-review");
    // Both queue slots are taken by the never-settling runners above, so it waits in the queue.
    expect(ev.status).toBe("queued");
    expect(ev.stage).toBe("research");
    expect(ev.completedStages).toEqual(["ingest", "scout", "code"]);
    expect((ev.settings as { research: string[] }).research).not.toContain("custody");
  });

  it("won't regenerate a summary while the pipeline is on it", async () => {
    for (const id of ["e-running", "e-review"]) {
      const res = await send(`/api/admin/evaluations/${id}/summarize`, undefined);
      expect(res.status, id).toBe(409);
      expect(await errorOf(res)).toBe("busy");
    }
  });

  it("adds the summary's cost in SQL, not over a value read before the await", async () => {
    // The pipeline (or another request) records spend while the summary is being written.
    h.duringSummary = async () => await db.update(schema.evaluations).set({ costUsd: 10 }).where(eq(schema.evaluations.id, "e-summary"));
    try {
      const res = await send("/api/admin/evaluations/e-summary/summarize", undefined);
      expect(res.status).toBe(200);
    } finally {
      h.duringSummary = null;
    }
    expect((await status("e-summary")).costUsd).toBeCloseTo(10.5, 6);
  });
});

describe("summaries in the evaluations list", () => {
  it("says which summaries can be published as they are: current, stale after an override, or missing", async () => {
    await seedEvaluation("e-sum-current", { projectId: "p2" });
    await seedEvaluation("e-sum-stale", { projectId: "p2" });
    await seedEvaluation("e-sum-missing", { projectId: "p2" });
    await db
      .update(schema.criterionResults)
      .set({ overrideStatus: "unknown", overrideReason: "Not settled.", overriddenAt: "2026-10-01T00:00:00Z" })
      .where(eq(schema.criterionResults.id, `e-sum-stale-${criteria[0]!.id}`));
    await db.update(schema.evaluations).set({ summary: "", summaryAt: null }).where(eq(schema.evaluations.id, "e-sum-missing"));
    const res = await app.request("/api/admin/evaluations", { headers: { cookie: cookies } });
    const list = (await res.json()) as { id: string; summary: string | null }[];
    const state = (id: string) => list.find((e) => e.id === id)?.summary;
    expect([state("e-sum-current"), state("e-sum-stale"), state("e-sum-missing")]).toEqual(["current", "stale", "missing"]);
    // Only evaluations that could be published get one.
    expect(state("e-running")).toBeNull();
  });
});

describe("review input", () => {
  const target = criteria.find((c) => !c.naAllowed)!;

  it("rejects an unknown option and a disallowed N/A", async () => {
    const path = `/api/admin/evaluations/e-summary/criteria/${target.id}`;
    const bad = await send(path, { status: "answered", optionId: "made-up", reason: "Because." }, "PATCH");
    expect(bad.status).toBe(400);
    expect(await errorOf(bad)).toBe("invalid_option");
    const na = await send(path, { status: "not_applicable", optionId: null, reason: "Doesn't apply." }, "PATCH");
    expect(na.status).toBe(400);
    expect(await errorOf(na)).toBe("na_not_allowed");
    expect(getCriterion(target.id).id).toBe(target.id);
  });

  it("accepts an answer without a reason, and every open flag at once", async () => {
    await seedEvaluation("e-accept");
    const [a, b, c, d] = criteria;
    const row = async (cid: string) =>
      (
        await db
          .select()
          .from(schema.criterionResults)
          .where(eq(schema.criterionResults.id, `e-accept-${cid}`))
      )[0]!;
    const flag = (cid: string, set: Record<string, unknown>) =>
      db
        .update(schema.criterionResults)
        .set(set)
        .where(eq(schema.criterionResults.id, `e-accept-${cid}`));
    await flag(a!.id, { flags: ["medium_confidence", "skeptic_checked"] });
    await flag(b!.id, { flags: ["judge_disagreement"] });
    await flag(c!.id, { flags: ["unverified"], overrideStatus: "unknown", overrideReason: "Not settled." });
    await flag(d!.id, { flags: ["skeptic_checked"] });

    const one = await send(`/api/admin/evaluations/e-accept/criteria/${a!.id}`, { accept: true }, "PATCH");
    expect(one.status, await one.clone().text()).toBe(200);
    expect(await row(a!.id)).toMatchObject({ flags: ["skeptic_checked"], reviewNote: null, acceptedFlags: { flags: ["medium_confidence"] } });

    // Only answers with a blocking flag and no override: b. a is accepted, c overridden, d only informational.
    const all = await send("/api/admin/evaluations/e-accept/accept-all", undefined);
    expect(await all.json()).toEqual({ ok: true, accepted: 1 });
    expect(await row(b!.id)).toMatchObject({ flags: [], acceptedFlags: { flags: ["judge_disagreement"], optionId: b!.options[0]!.id } });
    expect((await row(c!.id)).flags).toEqual(["unverified"]);
    expect((await row(d!.id)).flags).toEqual(["skeptic_checked"]);

    const busy = await send("/api/admin/evaluations/e-running/accept-all", undefined);
    expect(busy.status).toBe(409);
    expect(await errorOf(busy)).toBe("busy");
  });

  it("answers 404 when adding a source to an unknown project, without fetching anything", async () => {
    const note = await send("/api/admin/projects/nope/sources", { type: "note", title: "Call notes", content: "The team confirmed the council." });
    expect(note.status).toBe(404);
    const url = await send("/api/admin/projects/nope/sources", { type: "url", url: "https://docs.unreachable.invalid/page" });
    expect(url.status).toBe(404);
  });
});

describe("release requests", () => {
  it("refuses duplicate ids, unknown ids, and two evaluations of one project version (409)", async () => {
    await seedEvaluation("e-twin-a", { projectId: "p2" });
    await seedEvaluation("e-twin-b", { projectId: "p2" });
    const dup = await send("/api/admin/releases", { evaluationIds: ["e-twin-a", "e-twin-a"], label: "R", notes: "" });
    expect(dup.status).toBe(409);
    expect(await errorOf(dup)).toBe("duplicate_evaluations");
    const unknown = await send("/api/admin/releases", { evaluationIds: ["e-twin-a", "nope"], label: "R", notes: "" });
    expect(unknown.status).toBe(409);
    expect(await errorOf(unknown)).toBe("unknown_evaluations");
    const twins = await send("/api/admin/releases", { evaluationIds: ["e-twin-a", "e-twin-b"], label: "R", notes: "" });
    expect(twins.status).toBe(409);
    expect(await errorOf(twins)).toBe("same_project_version");
    expect(await db.select().from(schema.releases)).toHaveLength(0);
  });

  it("keeps a published snapshot intact when a cited source is deleted", async () => {
    const pub = await send("/api/admin/releases", { evaluationIds: ["e-twin-a"], label: "R1", notes: "" });
    expect(pub.status, await pub.clone().text()).toBe(200);
    // e-twin-a's evidence cites s1 (a p1 source), which is enough to exercise the delete.
    const before = await app.request("/api/public/projects/beta");
    expect(before.status).toBe(200);
    const etag = before.headers.get("etag");
    const snapshot = await before.json();
    expect(JSON.stringify(snapshot)).toContain("docs.alpha.example.org/security");

    // Deleting a source is refused while an evaluation of its project runs (R4-26); let the gated runners finish.
    expect((await send("/api/admin/sources/s1", undefined, "DELETE")).status).toBe(409);
    h.release();
    for (let i = 0; i < 200 && (await projectBusy(db, "p1")); i++) await new Promise((r) => setTimeout(r, 10));
    expect((await send("/api/admin/sources/s1", undefined, "DELETE")).status).toBe(200);
    expect(
      (
        await db
          .select()
          .from(schema.evidence)
          .where(eq(schema.evidence.id, `e-twin-a-e-${criteria[0]!.id}`))
      )[0]!.sourceId,
    ).toBeNull();

    const after = await app.request("/api/public/projects/beta");
    expect(after.headers.get("etag")).toBe(etag);
    expect(await after.json()).toEqual(snapshot);
  });
});
