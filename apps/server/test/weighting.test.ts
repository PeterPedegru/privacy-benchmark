/**
 * Community weighting (plans/11): the rubric's own weighting at first use, polls from open to close, ballots and
 * their protections, Sign in with X (X's API mocked), and the link from runs to reviews to releases.
 */
import { adjustableOptions, type Ballot, criteria, DEFAULT_WEIGHTING, getCriterion, scoreProject, suites } from "@pb/rubric";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DB } from "../src/db/index.ts";

vi.mock("../src/lib/llm.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/llm.ts")>()), hasApiKey: () => true }));
vi.mock("../src/eval/pipeline.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/eval/pipeline.ts")>()),
  // Runs never start working: these tests only look at what they're linked to.
  runEvaluation: vi.fn(() => new Promise(() => {})),
}));

const { createApp, PUBLIC_BODY_LIMIT } = await import("../src/app.ts");
const { openDb, schema, setDb } = await import("../src/db/index.ts");
const { env } = await import("../src/env.ts");
const { cliWeighting } = await import("../src/scripts/bench.ts");
const w = await import("../src/services/weighting.ts");
const { answerMapFor, loadEvaluation } = await import("../src/services/snapshots.ts");

let app: ReturnType<typeof createApp>;
let db: DB;
let cookies = "";
let csrf = "";

const QUOTE = "The core contracts are immutable and there is no pause function anywhere in the protocol code.";

async function seedEvaluation(id: string, opts: { projectId?: string; weightingId?: string | null; option?: number } = {}) {
  await db.insert(schema.evaluations).values({
    id,
    projectId: opts.projectId ?? "p1",
    mode: "standard",
    status: "review",
    stage: "review",
    summary: "A summary.",
    summaryAt: "2026-09-30T00:00:00Z",
    weightingId: opts.weightingId ?? null,
  });
  for (const c of criteria) {
    await db.insert(schema.criterionResults).values({
      id: `${id}-${c.id}`,
      evaluationId: id,
      criterionId: c.id,
      status: "answered",
      optionId: (c.options[opts.option ?? 1] ?? c.options[0]!).id,
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

const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", cookie: cookies, "x-csrf-token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A public visitor: their own cookie jar and address. */
function visitor(ip = "203.0.113.7") {
  let jar = "";
  const take = (res: Response) => {
    const set = res.headers.getSetCookie().map((c) => c.split(";")[0]!);
    const kept = new Map(jar ? jar.split("; ").map((c) => [c.split("=")[0]!, c] as const) : []);
    for (const c of set) {
      const [name, value] = [c.split("=")[0]!, c.slice(c.indexOf("=") + 1)];
      if (value) kept.set(name, c);
      else kept.delete(name);
    }
    jar = [...kept.values()].join("; ");
    return res;
  };
  return {
    get cookie() {
      return jar;
    },
    set cookie(v: string) {
      jar = v;
    },
    get: async (path: string) => take(await app.request(path, { headers: { cookie: jar, "x-real-ip": ip } })),
    send: async (path: string, body: unknown, init: { method?: string; headers?: Record<string, string> } = {}) =>
      take(
        await app.request(path, {
          method: init.method ?? "POST",
          headers: { "content-type": "application/json", cookie: jar, "x-real-ip": ip, ...init.headers },
          body: JSON.stringify(body),
        }),
      ),
  };
}

const coverageUp: Ballot = { suites: { ...DEFAULT_WEIGHTING.suites, coverage: 60 } };

beforeAll(async () => {
  db = await openDb({ log: () => {} });
  setDb(db);
  await db.insert(schema.projects).values([
    { id: "p1", slug: "alpha", name: "Alpha", websiteUrl: "https://alpha.example.org" },
    { id: "p2", slug: "beta", name: "Beta", websiteUrl: "https://beta.example.org" },
  ]);
  await db
    .insert(schema.sources)
    .values({ id: "s1", projectId: "p1", url: "https://docs.alpha.example.org", title: "Docs", contentMd: QUOTE, contentHash: "h" });
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

afterEach(() => {
  vi.restoreAllMocks();
  env.xOAuthClientId = "";
  env.xOAuthClientSecret = "";
});

/** Ends the open poll's five days, then lets the next read close it. */
async function closeOpenPoll() {
  const open = await w.openPollRow(db);
  if (!open) return null;
  await db.update(schema.weightingPolls).set({ closesAt: "2000-01-01T00:00:00.000Z" }).where(eq(schema.weightingPolls.id, open.id));
  await app.request("/api/public/poll");
  return (await w.pollById(db, open.id))!;
}

describe("the rubric's own weighting", () => {
  it("is created on first use as W1, with the rubric's numbers and a content hash, and is the default", async () => {
    const res = await app.request("/api/public/weightings");
    expect(res.status).toBe(200);
    const list = (await res.json()) as { id: string; label: string; source: string; current: boolean; hash: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: w.BASELINE_ID, label: "W1", source: "rubric", current: true });
    expect(list[0]!.hash).toBe(w.weightingHash(list[0]!.id.replace("rubric-", ""), DEFAULT_WEIGHTING));
    const detail = (await (await app.request("/api/public/weightings/W1")).json()) as { config: unknown; changes: unknown[] };
    expect(detail.config).toEqual(DEFAULT_WEIGHTING);
    expect(detail.changes).toEqual([]);
    expect((await app.request("/api/public/weightings/W9")).status).toBe(404);
  });

  it("links what this rubric version created before weightings, and leaves an older rubric's work alone", async () => {
    await seedEvaluation("old");
    await db.insert(schema.releases).values([
      { id: "rel-old-rubric", label: "Old", rubricVersion: "0.9.0" },
      { id: "rel-this-rubric", label: "This", rubricVersion: w.BASELINE_ID.replace("rubric-", "") },
    ]);
    expect(await w.linkUnweighted(db)).toBeGreaterThan(0);
    const [ev] = await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, "old"));
    expect(ev!.weightingId).toBe(w.BASELINE_ID);
    const rels = Object.fromEntries((await db.select().from(schema.releases)).map((r) => [r.id, r.weightingId]));
    expect(rels).toMatchObject({ "rel-old-rubric": null, "rel-this-rubric": w.BASELINE_ID });
    await db.delete(schema.releases);
    expect(await w.baselineDrift(db)).toBeNull();
  });
});

describe("opening a poll", () => {
  it("needs X sign-in configured for an X poll, and takes one open poll at a time", async () => {
    const x = await admin("/api/admin/polls", { requireX: true });
    expect(x.status).toBe(422);
    expect(((await x.json()) as { error: string }).error).toBe("x_unavailable");
    const ok = await admin("/api/admin/polls", { requireX: false, minBallots: 3, title: "Test poll" });
    expect(ok.status).toBe(200);
    const poll = (await ok.json()) as { id: string; opensAt: string; closesAt: string; base: { label: string }; status: string };
    expect(poll.status).toBe("open");
    expect(poll.base.label).toBe("W1");
    expect(Date.parse(poll.closesAt) - Date.parse(poll.opensAt)).toBe(5 * 24 * 3600_000);
    const again = await admin("/api/admin/polls", { requireX: false });
    expect(again.status).toBe(409);
  });

  it("is public with its base's numbers, and never exposes its salt", async () => {
    const res = await app.request("/api/public/poll");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { poll: { title: string; baseConfig: unknown; ballots: number }; voter: { signedIn: boolean; ballot: unknown } };
    expect(body.poll.title).toBe("Test poll");
    expect(body.poll.baseConfig).toEqual(DEFAULT_WEIGHTING);
    expect(body.voter).toMatchObject({ signedIn: false, ballot: null });
    const salt = (await w.openPollRow(db))!.salt;
    expect(JSON.stringify(body)).not.toContain(salt);
  });
});

describe("ballots", () => {
  it("only take same-origin JSON", async () => {
    const id = (await w.openPollRow(db))!.id;
    const v = visitor("198.51.100.1");
    const text = await app.request(`/api/public/polls/${id}/ballot`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(text.status).toBe(415);
    const cross = await v.send(`/api/public/polls/${id}/ballot`, {}, { headers: { origin: "https://evil.example" } });
    expect(cross.status).toBe(403);
  });

  it("reject invalid ballots with a reason", async () => {
    const id = (await w.openPollRow(db))!.id;
    const v = visitor("198.51.100.2");
    const partial = await v.send(`/api/public/polls/${id}/ballot`, { suites: { coverage: 40 } });
    expect(partial.status).toBe(422);
    expect(((await partial.json()) as { message: string }).message).toMatch(/every suite/);
    const locked = getCriterion("custody.pause.pause-fn");
    const lockedRes = await v.send(`/api/public/polls/${id}/ballot`, { credits: { [locked.id]: { [locked.options[0]!.id]: 10 } } });
    expect(lockedRes.status).toBe(422);
    expect((await v.send(`/api/public/polls/${id}/ballot`, { suites: { coverage: 500 } })).status).toBe(400);
    expect((await v.send(`/api/public/polls/${id}/ballot`, { other: 1 })).status).toBe(400);
  });

  it("one per browser: the first sets a voter cookie, later ones replace it, and it can be withdrawn", async () => {
    const id = (await w.openPollRow(db))!.id;
    const v = visitor("198.51.100.3");
    const first = await v.send(`/api/public/polls/${id}/ballot`, {});
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, created: true, ballots: 1 });
    expect(v.cookie).toMatch(/pb_voter=/);
    const second = await v.send(`/api/public/polls/${id}/ballot`, coverageUp);
    expect(await second.json()).toMatchObject({ created: false, ballots: 1 });
    const state = (await (await v.get("/api/public/poll")).json()) as { voter: { signedIn: boolean; ballot: Ballot; revisionsLeft: number } };
    expect(state.voter.signedIn).toBe(true);
    expect(state.voter.ballot).toEqual(coverageUp);
    expect(state.voter.revisionsLeft).toBe(w.POLL_LIMITS.revisions - 1);
    const gone = await v.send(`/api/public/polls/${id}/ballot`, null, { method: "DELETE" });
    expect(await gone.json()).toMatchObject({ removed: true });
    expect(((await (await v.get("/api/public/poll")).json()) as { poll: { ballots: number } }).poll.ballots).toBe(0);
  });

  it("can't be changed more than the revision limit", async () => {
    const id = (await w.openPollRow(db))!.id;
    const v = visitor("198.51.100.4");
    await v.send(`/api/public/polls/${id}/ballot`, {});
    const hash = (await db.select().from(schema.weightingBallots)).find((b) => b.voterKind === "browser" && b.revisions === 0)!;
    await db.update(schema.weightingBallots).set({ revisions: w.POLL_LIMITS.revisions }).where(eq(schema.weightingBallots.id, hash.id));
    const res = await v.send(`/api/public/polls/${id}/ballot`, coverageUp);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("revision_limit");
    await v.send(`/api/public/polls/${id}/ballot`, null, { method: "DELETE" });
  });

  it("cap the voters on one network, without storing addresses", async () => {
    const id = (await w.openPollRow(db))!.id;
    const statuses: number[] = [];
    for (let i = 0; i < w.POLL_LIMITS.networkVotersBrowser + 1; i++)
      statuses.push((await visitor(`192.0.2.${10 + i}`).send(`/api/public/polls/${id}/ballot`, {})).status);
    expect(statuses).toEqual([...Array(w.POLL_LIMITS.networkVotersBrowser).fill(200), 429]);
    // Another network still votes.
    expect((await visitor("192.0.3.10").send(`/api/public/polls/${id}/ballot`, {})).status).toBe(200);
    const stored = JSON.stringify(await db.select().from(schema.weightingBallots));
    expect(stored).not.toContain("192.0.2");
    expect(w.networkOf("192.0.2.77")).toBe("192.0.2.0/24");
    expect(w.networkOf("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48");
  });

  it("are rate limited per address (an IPv6 client per /64), without locking anyone else out", async () => {
    const id = (await w.openPollRow(db))!.id;
    const v = visitor("198.51.100.99");
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await v.send(`/api/public/polls/${id}/ballot`, {})).status;
    expect(last).toBe(429);
    expect((await visitor("198.51.101.1").send(`/api/public/polls/${id}/ballot`, {})).status).toBe(200);
    expect(w.rateKey("2001:db8:aa:bb:1::1")).toBe(w.rateKey("2001:db8:aa:bb:ffff::9"));
    expect(w.rateKey("2001:db8:aa:bc::1")).not.toBe(w.rateKey("2001:db8:aa:bb::1"));
  });

  it("don't cap addresses that aren't the voter's own (unknown, or a proxy inside the platform)", async () => {
    const id = (await w.openPollRow(db))!.id;
    const statuses: number[] = [];
    for (let i = 0; i < w.POLL_LIMITS.networkVotersBrowser + 2; i++)
      statuses.push((await visitor(`10.77.0.${i + 1}`).send(`/api/public/polls/${id}/ballot`, {})).status);
    expect(statuses.every((x) => x === 200)).toBe(true);
    expect(w.cappable("10.0.0.1")).toBe(false);
    expect(w.cappable("unknown")).toBe(false);
    expect(w.cappable("203.0.113.9")).toBe(true);
  });

  it("withdrawing keeps the ballot's revisions and its network slot", async () => {
    const id = (await w.openPollRow(db))!.id;
    const v = visitor("198.51.102.1");
    const before = new Set((await db.select().from(schema.weightingBallots)).map((b) => b.id));
    await v.send(`/api/public/polls/${id}/ballot`, {});
    const row = (await db.select().from(schema.weightingBallots)).find((b) => !before.has(b.id))!;
    await db
      .update(schema.weightingBallots)
      .set({ revisions: w.POLL_LIMITS.revisions - 1 })
      .where(eq(schema.weightingBallots.id, row.id));
    expect(await (await v.send(`/api/public/polls/${id}/ballot`, null, { method: "DELETE" })).json()).toMatchObject({ removed: true });
    const state = (await (await v.get("/api/public/poll")).json()) as { voter: { ballot: unknown; revisionsLeft: number } };
    expect(state.voter).toMatchObject({ ballot: null, revisionsLeft: 1 });
    // Voting again uses the last revision; then the ballot stands.
    expect((await v.send(`/api/public/polls/${id}/ballot`, coverageUp)).status).toBe(200);
    expect((await v.send(`/api/public/polls/${id}/ballot`, {})).status).toBe(429);
    // Still holding its network's slot.
    expect((await db.select().from(schema.weightingBallots).where(eq(schema.weightingBallots.id, row.id)))[0]!.networkHash).toBeTruthy();
  });

  it("take a ballot that changes every weight and credit, within the public body limit", async () => {
    const id = (await w.openPollRow(db))!.id;
    const v = 100 / 3;
    const all: Ballot = {
      suites: Object.fromEntries(suites.map((s) => [s.id, v])),
      benchmarks: Object.fromEntries(suites.flatMap((s) => s.benchmarks.map((b) => [b.id, v]))),
      criteria: Object.fromEntries(criteria.map((c) => [c.id, v])),
      credits: Object.fromEntries(
        criteria.filter((c) => adjustableOptions(c).length).map((c) => [c.id, Object.fromEntries(adjustableOptions(c).map((o) => [o.id, v]))]),
      ),
    };
    expect(JSON.stringify(all).length).toBeLessThan(PUBLIC_BODY_LIMIT);
    const res = await visitor("100.64.9.9").send(`/api/public/polls/${id}/ballot`, all);
    expect(res.status).toBe(200);
  });
});

describe("closing a poll", () => {
  it("with a quorum, adopts the median as the next weighting, the default for new runs", async () => {
    const poll = (await w.openPollRow(db))!;
    await db.delete(schema.weightingBallots).where(eq(schema.weightingBallots.pollId, poll.id));
    for (const [i, b] of [coverageUp, coverageUp, {}].entries())
      expect((await visitor(`203.0.${100 + i}.9`).send(`/api/public/polls/${poll.id}/ballot`, b)).status).toBe(200);
    const preview = (await (await admin(`/api/admin/polls/${poll.id}`)).json()) as { quorum: boolean; networks: number; changes: { key: string }[] };
    expect(preview.quorum).toBe(true);
    expect(preview.networks).toBe(3);
    expect(preview.changes.some((c) => c.key === "suite:coverage")).toBe(true);

    const closed = (await closeOpenPoll())!;
    expect(closed).toMatchObject({ status: "closed", outcome: "adopted", ballots: 3, salt: "" });
    // Nothing that could tell who voted outlives the poll.
    const ballots = await db.select().from(schema.weightingBallots).where(eq(schema.weightingBallots.pollId, poll.id));
    expect(ballots.every((b) => b.networkHash === null && b.voterHash.startsWith("closed:"))).toBe(true);

    const list = (await (await app.request("/api/public/weightings")).json()) as { label: string; current: boolean; poll: { ballots: number } | null }[];
    expect(list.map((x) => x.label)).toEqual(["W2", "W1"]);
    expect(list[0]).toMatchObject({ current: true, poll: { ballots: 3 } });
    const w2 = (await (await app.request("/api/public/weightings/W2")).json()) as {
      base: { label: string };
      changes: { key: string; from: number; to: number }[];
      pollStats: { ballots: number; unchanged: number; changedBy: Record<string, number> };
    };
    expect(w2.base.label).toBe("W1");
    const cov = w2.changes.find((c) => c.key === "suite:coverage")!;
    expect(cov.to).toBeGreaterThan(cov.from);
    expect(w2.pollStats).toMatchObject({ ballots: 3, unchanged: 1 });
    expect(w2.pollStats.changedBy["suite:coverage"]).toBe(2);
    const state = (await (await app.request("/api/public/poll")).json()) as { poll: unknown; lastClosed: { outcome: string; result: { label: string } } };
    expect(state.poll).toBeNull();
    expect(state.lastClosed).toMatchObject({ outcome: "adopted", result: { label: "W2" } });
  });

  it("without a quorum, changes nothing", async () => {
    expect((await admin("/api/admin/polls", { requireX: false, minBallots: 5 })).status).toBe(200);
    const poll = (await w.openPollRow(db))!;
    expect((await visitor("10.9.0.1").send(`/api/public/polls/${poll.id}/ballot`, coverageUp)).status).toBe(200);
    const closed = (await closeOpenPoll())!;
    expect(closed).toMatchObject({ outcome: "no_quorum", resultId: null, ballots: 1 });
    expect((await w.defaultWeighting(db))!.number).toBe(2);
  });

  it("can be cancelled, which deletes its ballots; the public summary follows", async () => {
    expect((await admin("/api/admin/polls", { requireX: false })).status).toBe(200);
    const poll = (await w.openPollRow(db))!;
    const open = (await (await app.request("/api/public/poll/summary")).json()) as { poll: { id: string } | null };
    expect(open.poll?.id).toBe(poll.id);
    await visitor("10.8.0.1").send(`/api/public/polls/${poll.id}/ballot`, {});
    expect((await admin(`/api/admin/polls/${poll.id}/cancel`, {})).status).toBe(200);
    expect((await w.pollById(db, poll.id))!.status).toBe("cancelled");
    expect(await db.select().from(schema.weightingBallots).where(eq(schema.weightingBallots.pollId, poll.id))).toEqual([]);
    expect((await visitor("10.8.0.2").send(`/api/public/polls/${poll.id}/ballot`, {})).status).toBe(409);
    expect(((await (await app.request("/api/public/poll/summary")).json()) as { poll: unknown }).poll).toBeNull();
    expect((await w.pollById(db, poll.id))!.salt).toBe("");
  });

  it("backups leave out ballots' network hashes", async () => {
    const { redactForExport } = await import("../src/db/backup.ts");
    expect(redactForExport("weighting_ballots", { id: "b", network_hash: "abc" })).toEqual({ id: "b", network_hash: null });
    expect(redactForExport("projects", { id: "p", network_hash: "x" })).toEqual({ id: "p", network_hash: "x" });
  });
});

describe("Sign in with X", () => {
  function mockX(createdAt: string) {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://api.x.com/2/oauth2/token")) {
        expect(String(init?.body)).toContain("code_verifier=");
        return new Response(JSON.stringify({ access_token: "token-1", token_type: "bearer" }), { headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("https://api.x.com/2/users/me"))
        return new Response(JSON.stringify({ data: { id: "1234567", created_at: createdAt, username: "never-stored" } }), {
          headers: { "content-type": "application/json" },
        });
      if (url.startsWith("https://api.x.com/2/oauth2/revoke")) return new Response("{}");
      throw new Error(`unexpected fetch ${url}`);
    });
    return calls;
  }

  async function signIn(v: ReturnType<typeof visitor>, opts: { state?: string } = {}) {
    const start = await v.get("/api/public/auth/x/start?next=/weighting");
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("redirect_uri")).toBe(`${env.publicUrl}/api/public/auth/x/callback`);
    const state = opts.state ?? to.searchParams.get("state")!;
    return v.get(`/api/public/auth/x/callback?code=abc&state=${state}`);
  }

  it("is unavailable until configured", async () => {
    const res = await visitor().get("/api/public/auth/x/start");
    expect(res.headers.get("location")).toBe("/weighting?x=unavailable");
  });

  it("signs a voter in with their X account id only, and revokes the token", async () => {
    env.xOAuthClientId = "test-client-id";
    env.xOAuthClientSecret = "test-client-secret";
    const calls = mockX("2015-01-01T00:00:00.000Z");
    const v = visitor("10.20.0.1");
    const back = await signIn(v);
    expect(back.headers.get("location")).toBe("/weighting?x=ok");
    expect(v.cookie).toMatch(/pb_voter=x\.1234567\./);
    expect(v.cookie).not.toContain("never-stored");
    await vi.waitFor(() => expect(calls.some((u) => u.includes("/oauth2/revoke"))).toBe(true));
  });

  it("turns away young accounts and stale or forged state", async () => {
    env.xOAuthClientId = "test-client-id";
    mockX(new Date(Date.now() - 2 * 86_400_000).toISOString());
    const young = await signIn(visitor("10.21.0.1"));
    expect(young.headers.get("location")).toBe("/weighting?x=young");
    const forged = await signIn(visitor("10.21.0.2"), { state: "not-the-state" });
    expect(forged.headers.get("location")).toBe("/weighting?x=expired");
    const noCookie = await visitor("10.21.0.3").get("/api/public/auth/x/callback?code=abc&state=x");
    expect(noCookie.headers.get("location")).toBe("/weighting?x=expired");
  });

  it("an X poll takes X voters only, one ballot per account", async () => {
    env.xOAuthClientId = "test-client-id";
    expect((await admin("/api/admin/polls", { minBallots: 1 })).status).toBe(200);
    const poll = (await w.openPollRow(db))!;
    expect(poll.requireX).toBe(true);
    const anon = await visitor("10.30.0.1").send(`/api/public/polls/${poll.id}/ballot`, {});
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error: string }).error).toBe("sign_in_required");

    mockX("2015-01-01T00:00:00.000Z");
    const a = visitor("10.30.0.2");
    await signIn(a);
    expect((await a.send(`/api/public/polls/${poll.id}/ballot`, coverageUp)).status).toBe(200);
    // The same account from another browser and network replaces its ballot rather than adding one.
    const b = visitor("10.31.0.2");
    await signIn(b);
    const again = await b.send(`/api/public/polls/${poll.id}/ballot`, {});
    expect(await again.json()).toMatchObject({ created: false, ballots: 1 });
    const stored = await db.select().from(schema.weightingBallots).where(eq(schema.weightingBallots.pollId, poll.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.voterKind).toBe("x");
    expect(JSON.stringify(stored)).not.toContain("1234567");
    await closeOpenPoll();
    // W3: one ballot, the defaults.
    expect((await w.defaultWeighting(db))!.number).toBe(3);
  });
});

describe("share images", () => {
  it("/weighting has its own Open Graph and X images, and each version one of its own", async () => {
    for (const [path, height] of [
      ["/og/weighting.png", 630],
      ["/og/weighting-x.png", 600],
      ["/og/weighting/W1.png", 630],
    ] as const) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      const png = Buffer.from(await res.arrayBuffer());
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], path).toEqual([1200, height]);
    }
    expect((await app.request("/og/weighting/W404.png")).status).toBe(404);
  });
});

describe("runs, review and releases", () => {
  it("a run is linked to the weighting it picks, or the current one", async () => {
    const cur = (await admin("/api/admin/runs", { projectIds: ["p1"], mode: "quick" })).status;
    expect(cur).toBe(200);
    const picked = await admin("/api/admin/runs", { projectIds: ["p2"], mode: "quick", weightingId: "W1" });
    expect(picked.status).toBe(200);
    const runs = await db.select().from(schema.evaluations).where(eq(schema.evaluations.stage, "scout"));
    const by = Object.fromEntries(runs.map((e) => [e.projectId, e.weightingId]));
    expect(by.p1).toBe((await w.defaultWeighting(db))!.id);
    expect(by.p2).toBe(w.BASELINE_ID);
    expect((await admin("/api/admin/runs", { projectIds: ["p1"], mode: "quick", weightingId: "W77" })).status).toBe(422);
    // Not running anything in the background for the rest of this file.
    await db.update(schema.evaluations).set({ status: "cancelled" }).where(eq(schema.evaluations.stage, "scout"));
  });

  it("the CLI picks a weighting by its label, and refuses unknown or retired ones", async () => {
    expect((await cliWeighting(db, { weighting: "W2" }))!.number).toBe(2);
    expect((await cliWeighting(db, {}))!.id).toBe((await w.defaultWeighting(db))!.id);
    await expect(cliWeighting(db, { weighting: "W42" })).rejects.toThrow(/No weighting/);
    const w2 = (await w.findWeighting(db, "W2"))!;
    await w.setRetired(db, w2.id, true);
    await expect(cliWeighting(db, { weighting: "W2" })).rejects.toThrow(/retired/);
    await w.setRetired(db, w2.id, false);
  });

  it("review scores with the evaluation's weighting, and re-scoring switches it", async () => {
    await seedEvaluation("ev1", { weightingId: w.BASELINE_ID });
    const before = (await (await admin("/api/admin/evaluations/ev1")).json()) as { scores: { overall: number }; weighting: { label: string } };
    expect(before.weighting.label).toBe("W1");
    const res = await admin("/api/admin/evaluations/ev1/weighting", { weightingId: "W2" }, "PATCH");
    expect(res.status).toBe(200);
    const after = (await (await admin("/api/admin/evaluations/ev1")).json()) as { scores: { overall: number; level: string }; weighting: { label: string } };
    expect(after.weighting.label).toBe("W2");
    const bundle = (await loadEvaluation(db, "ev1"))!;
    expect(after.scores.overall).toBeCloseTo(scoreProject(answerMapFor(bundle), bundle.weighting.config).overall!, 9);
    expect(after.scores.overall).not.toBeCloseTo(before.scores.overall, 3);
    const events = await db.select().from(schema.runEvents).where(eq(schema.runEvents.evaluationId, "ev1"));
    expect(events.map((e) => e.message).join()).toMatch(/Re-scored with weighting W2 \(was W1\)/);
    expect((await admin("/api/admin/evaluations/ev1/weighting", { weightingId: "nope" }, "PATCH")).status).toBe(404);
  });

  it("a release is scored with one weighting, which its results and exports name", async () => {
    await seedEvaluation("ev2", { projectId: "p2", weightingId: w.BASELINE_ID });
    const mixed = await admin("/api/admin/releases", { evaluationIds: ["ev1", "ev2"], label: "R1", notes: "" });
    expect(mixed.status).toBe(409);
    expect(((await mixed.json()) as { error: string }).error).toBe("mixed_weightings");
    expect((await admin("/api/admin/evaluations/ev2/weighting", { weightingId: "W2" }, "PATCH")).status).toBe(200);
    const pub = await admin("/api/admin/releases", { evaluationIds: ["ev1", "ev2"], label: "R1", notes: "" });
    expect(pub.status).toBe(200);
    const { id } = (await pub.json()) as { id: string };
    const w2 = (await w.findWeighting(db, "W2"))!;
    const [rel] = await db.select().from(schema.releases).where(eq(schema.releases.id, id));
    expect(rel!.weightingId).toBe(w2.id);
    const results = await db.select().from(schema.publishedResults).where(eq(schema.publishedResults.releaseId, id));
    expect(results.every((r) => r.weightingId === w2.id)).toBe(true);
    expect((results[0]!.snapshot as { weighting: { label: string; hash: string } }).weighting).toMatchObject({ label: "W2", hash: w2.hash });

    const page = (await (await app.request("/api/public/projects/alpha")).json()) as { snapshot: { weighting: { label: string } } };
    expect(page.snapshot.weighting.label).toBe("W2");
    const lb = (await (await app.request("/api/public/leaderboard")).json()) as {
      rows: { weighting: { label: string } }[];
      weightings: { label: string; projects: number; suites: Record<string, number> }[];
    };
    expect(lb.rows.every((r) => r.weighting.label === "W2")).toBe(true);
    expect(lb.weightings).toEqual([expect.objectContaining({ label: "W2", projects: 2 })]);
    expect(lb.weightings[0]!.suites.coverage).toBeGreaterThan(DEFAULT_WEIGHTING.suites.coverage);
    const csv = await (await app.request(`/api/public/releases/${id}/export.csv`)).text();
    expect(csv.split("\n")[0]).toContain("weighting");
    expect(csv.split("\n")[1]).toContain("W2");
    const json = (await (await app.request(`/api/public/releases/${id}/export.json`)).json()) as { weightings: Record<string, { config: unknown }> };
    expect(Object.keys(json.weightings)).toEqual([w2.id]);
    // The weighting's page lists the release.
    const detail = (await (await app.request("/api/public/weightings/W2")).json()) as { results: number; releases: { id: string }[] };
    expect(detail.results).toBe(2);
    expect(detail.releases.map((r) => r.id)).toEqual([id]);
    // Published evaluations are frozen: no re-scoring.
    expect((await admin("/api/admin/evaluations/ev1/weighting", { weightingId: "W1" }, "PATCH")).status).toBe(409);
  });

  it("results published before weightings read as their rubric's own", async () => {
    const [r] = await db.select().from(schema.publishedResults).limit(1);
    const legacy = { ...(r!.snapshot as Record<string, unknown>) };
    delete legacy.weighting;
    await db
      .update(schema.publishedResults)
      .set({ snapshot: legacy as never })
      .where(eq(schema.publishedResults.id, r!.id));
    const { bumpSnapshots } = await import("../src/services/snapshots.ts");
    bumpSnapshots();
    const lb = (await (await app.request("/api/public/leaderboard")).json()) as { rows: { weighting: { label: string } }[] };
    expect(lb.rows.map((x) => x.weighting.label).sort()).toEqual(["W1", "W2"]);
  });

  it("the last weighting in use can't be retired", async () => {
    for (const x of await db.select().from(schema.weightings)) if (x.number !== 1) await w.setRetired(db, x.id, true);
    expect((await w.defaultWeighting(db))!.number).toBe(1);
    const res = await admin(`/api/admin/weightings/${w.BASELINE_ID}`, { retired: true }, "PATCH");
    expect(res.status).toBe(409);
    for (const x of await db.select().from(schema.weightings)) await w.setRetired(db, x.id, false);
    expect((await w.defaultWeighting(db))!.number).toBe(3);
  });

  it("a newer rubric weighting doesn't displace the community's as the default", async () => {
    await db.insert(schema.weightings).values({
      id: "rubric-next",
      number: 99,
      title: "Rubric next weights",
      source: "rubric",
      rubricVersion: "9.9.9",
      config: DEFAULT_WEIGHTING as never,
      hash: "h",
    });
    expect((await w.defaultWeighting(db))!.number).toBe(3);
  });
});
