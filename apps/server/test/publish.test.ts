import { criteria, isHighScrutiny, suites } from "@pb/rubric";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { type DB, openDb, schema, setDb } from "../src/db/index.ts";
import { snapshotMemoPeek, snapshotMemoStats } from "../src/services/snapshots.ts";

let app: ReturnType<typeof createApp>;
let db: DB;
let cookies = "";
let csrf = "";

const SOURCE = "The core contracts are immutable and there is no pause function anywhere in the protocol code.";

/** An evaluation in review with one verified supporting quote per criterion in the given suites. */
async function seedEvaluation(
  id: string,
  opts: { evidencedSuites: string[]; suiteFilter?: string[] | null; summaryAt?: string | null; projectId?: string; versionId?: string | null; option?: number },
) {
  await db.insert(schema.evaluations).values({
    id,
    projectId: opts.projectId ?? "p1",
    versionId: opts.versionId ?? null,
    mode: "standard",
    status: "review",
    stage: "review",
    suiteFilter: opts.suiteFilter ?? null,
    summaryAt: opts.summaryAt === undefined ? "2026-09-30T00:00:00Z" : opts.summaryAt,
    summary: "Alpha hides amounts and links in a shared pool; its contracts are immutable.",
  });
  for (const c of criteria) {
    const evidenced = opts.evidencedSuites.includes(c.id.split(".")[0]!);
    await db.insert(schema.criterionResults).values({
      id: `${id}-${c.id}`,
      evaluationId: id,
      criterionId: c.id,
      status: evidenced ? "answered" : "unknown",
      optionId: evidenced ? (c.options[opts.option ?? 0] ?? c.options[0]!).id : null,
      evidenceIds: evidenced ? [`${id}-e-${c.id}`] : [],
      // Judged before the summary was written, as in a real run.
      updatedAt: "2026-09-29T00:00:00Z",
    });
    if (evidenced)
      await db.insert(schema.evidence).values({
        id: `${id}-e-${c.id}`,
        evaluationId: id,
        criterionId: c.id,
        quote: SOURCE,
        sourceId: "s1",
        stance: "supports",
        verified: true,
        verifyMethod: "exact",
      });
  }
}

const post = (path: string, body: unknown, method = "POST") =>
  app.request(path, { method, headers: { "content-type": "application/json", cookie: cookies, "x-csrf-token": csrf }, body: JSON.stringify(body) });

beforeAll(async () => {
  db = await openDb({ log: () => {} });
  setDb(db);
  await db.insert(schema.projects).values({ id: "p1", slug: "alpha", name: "Alpha", websiteUrl: "https://alpha.example.org" });
  await db
    .insert(schema.sources)
    .values({ id: "s1", projectId: "p1", url: "https://docs.alpha.example.org", title: "Docs", contentMd: SOURCE, contentHash: "h" });
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

describe("publishing gates", () => {
  it("blocks evaluations whose evidence settles too little of a suite", async () => {
    await seedEvaluation("thin", { evidencedSuites: ["coverage", "trust", "custody"] });
    const res = await post("/api/admin/releases", { evaluationIds: ["thin"], label: "R1", notes: "" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("insufficient_evidence");
    expect(body.message).toMatch(/Programmability/);
  });

  it("blocks partial (suite-filtered) evaluations", async () => {
    await seedEvaluation("partial", { evidencedSuites: suites.map((s) => s.id), suiteFilter: ["custody"] });
    const res = await post("/api/admin/releases", { evaluationIds: ["partial"], label: "R1", notes: "" });
    expect(((await res.json()) as { error: string }).error).toBe("partial_evaluation");
  });

  it("blocks an evaluation without a summary", async () => {
    await seedEvaluation("nosummary", { evidencedSuites: suites.map((s) => s.id), summaryAt: null });
    const res = await post("/api/admin/releases", { evaluationIds: ["nosummary"], label: "R0", notes: "" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("missing_summary");
  });

  it("blocks quick-mode evaluations unless published with a written justification", async () => {
    await seedEvaluation("quick", { evidencedSuites: suites.map((s) => s.id) });
    await db.update(schema.evaluations).set({ mode: "quick" }).where(eq(schema.evaluations.id, "quick"));
    const res = await post("/api/admin/releases", { evaluationIds: ["quick"], label: "Q", notes: "" });
    expect(((await res.json()) as { error: string }).error).toBe("quick_mode");
    expect((await post("/api/admin/releases?force=1", { evaluationIds: ["quick"], label: "Q", notes: "", forceReason: "ok" })).status).toBe(400);
    await db.update(schema.evaluations).set({ status: "review" }).where(eq(schema.evaluations.id, "quick"));
  });

  it("blocks a summary written before the last override", async () => {
    await seedEvaluation("stale", { evidencedSuites: suites.map((s) => s.id), summaryAt: "2026-09-01T00:00:00Z" });
    const target = criteria[0]!;
    const o = await post(
      `/api/admin/evaluations/stale/criteria/${target.id}`,
      { status: "answered", optionId: target.options[1]!.id, reason: "Docs say otherwise" },
      "PATCH",
    );
    expect(o.status).toBe(200);
    const res = await post("/api/admin/releases", { evaluationIds: ["stale"], label: "R1", notes: "" });
    expect(((await res.json()) as { error: string }).error).toBe("stale_summary");
  });

  it("blocks publishing until flagged answers are accepted, keeping an accept's note, and needs a public justification to publish past them", async () => {
    await seedEvaluation("flagged", { evidencedSuites: suites.map((s) => s.id) });
    const flagged = criteria[1]!;
    await db
      .update(schema.criterionResults)
      .set({ flags: ["judge_disagreement", "skeptic_checked"] })
      .where(eq(schema.criterionResults.id, `flagged-${flagged.id}`));
    // Informational flags alone don't block.
    const other = criteria[2]!;
    await db
      .update(schema.criterionResults)
      .set({ flags: ["skeptic_checked"] })
      .where(eq(schema.criterionResults.id, `flagged-${other.id}`));

    const blocked = await post("/api/admin/releases", { evaluationIds: ["flagged"], label: "R1", notes: "" });
    expect(((await blocked.json()) as { error: string; unresolved: number }).unresolved).toBe(1);
    expect((await post("/api/admin/releases?force=1", { evaluationIds: ["flagged"], label: "R1", notes: "", forceReason: "ok" })).status).toBe(400);

    const accepted = await post(
      `/api/admin/evaluations/flagged/criteria/${flagged.id}`,
      { accept: true, reason: "Both votes cite the same audit; the split was wording." },
      "PATCH",
    );
    expect(accepted.status).toBe(200);
    const row = (
      await db
        .select()
        .from(schema.criterionResults)
        .where(eq(schema.criterionResults.id, `flagged-${flagged.id}`))
    )[0]!;
    expect(row.flags).toEqual(["skeptic_checked"]);
    expect(row.reviewNote).toMatch(/same audit/);
    const ok = await post("/api/admin/releases", { evaluationIds: ["flagged"], label: "R1", notes: "First release" });
    expect(ok.status).toBe(200);
  });
});

describe("corrections loop", () => {
  it("needs a public reason, lists accepted corrections in the next release, and logs decisions without private text", async () => {
    const submitted = await app.request("/api/public/corrections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectSlug: "alpha",
        criterionId: criteria[0]!.id,
        message: "The pause function was removed in v2; see the audit. Reach me at someone@example.org",
        contact: "someone@example.org",
      }),
    });
    expect(submitted.status).toBe(200);
    const id = (await db.select().from(schema.corrections).where(eq(schema.corrections.projectSlug, "alpha")))[0]!.id;

    expect((await post(`/api/admin/corrections/${id}`, { status: "accepted" }, "PATCH")).status).toBe(400);
    expect((await post(`/api/admin/corrections/${id}`, { status: "accepted", note: "Verified: v2 has no pause function." }, "PATCH")).status).toBe(200);

    await seedEvaluation("corrected", { evidencedSuites: suites.map((s) => s.id) });
    const res = await post("/api/admin/releases", { evaluationIds: ["corrected"], label: "R2", notes: "Second release" });
    expect(res.status).toBe(200);
    const release = (await db.select().from(schema.releases).where(eq(schema.releases.label, "R2")))[0]!;
    expect(release.notesMd).toContain("Second release");
    expect(release.notesMd).toContain("Corrections applied in this release");
    expect(release.notesMd).toContain("Verified: v2 has no pause function.");
    const row = (await db.select().from(schema.corrections).where(eq(schema.corrections.id, id)))[0]!;
    expect(row.status).toBe("done");
    expect(row.releaseId).toBe(release.id);

    const log = (await (await app.request("/api/public/corrections")).json()) as { items: Record<string, unknown>[] };
    expect(log.items).toHaveLength(1);
    expect(log.items[0]).toMatchObject({ projectName: "Alpha", status: "done", note: "Verified: v2 has no pause function.", release: { label: "R2" } });
    const text = JSON.stringify(log);
    expect(text).not.toContain("someone@example.org");
    expect(text).not.toContain("Reach me");
  });
});

describe("version deployment (JDG-32)", () => {
  it("validates, stores and renders the confirmed deployment into every stage's version block", async () => {
    await db.insert(schema.projectVersions).values({ id: "v1", projectId: "p1", version: "v2", label: "V2", status: "tracked" });
    await db.insert(schema.sources).values({
      id: "s-addr",
      projectId: "p1",
      url: "https://sourcify.dev/#/lookup/0x00000000000000000000000000000000000000aa",
      title: "Pool",
      contentMd: "contract Pool {}",
      contentHash: "h2",
      meta: { chainId: 1, address: "0x00000000000000000000000000000000000000aa", contract: "Pool", verified: "exact_match" },
    });
    const suggestions = (await (await app.request("/api/admin/projects/p1/deployment-suggestions", { headers: { cookie: cookies } })).json()) as {
      address: string;
      chain: string;
      verified: boolean;
    }[];
    expect(suggestions).toEqual([expect.objectContaining({ chain: "1", address: "0x00000000000000000000000000000000000000aa", verified: true })]);

    expect((await post("/api/admin/versions/v1/deployment", { status: "mainnet", contracts: [{ chain: "1", address: "0x<script>" }] }, "PUT")).status).toBe(
      400,
    );
    expect((await post("/api/admin/versions/v1/deployment", { status: "mainnet", contracts: [] }, "PUT")).status).toBe(400);
    const ok = await post(
      "/api/admin/versions/v1/deployment",
      {
        status: "mainnet",
        contracts: [{ chain: "1", address: "0x00000000000000000000000000000000000000aa", label: "Pool" }],
        note: "From the v2 deployment docs.",
      },
      "PUT",
    );
    expect(ok.status).toBe(200);

    const { versionBlock } = await import("../src/eval/prompts.ts");
    const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, "p1")))[0]!;
    const version = (await db.select().from(schema.projectVersions).where(eq(schema.projectVersions.id, "v1")))[0]!;
    const block = versionBlock(project, version, "2026-10-01");
    expect(block).toContain("live on mainnet");
    expect(block).toContain("1:0x00000000000000000000000000000000000000aa (Pool)");
    expect(block).toMatch(/Other addresses.*context only/);

    expect((await post("/api/admin/versions/v1/deployment", null, "PUT")).status).toBe(200);
    const cleared = (await db.select().from(schema.projectVersions).where(eq(schema.projectVersions.id, "v1")))[0]!;
    expect(cleared.deployment).toBeNull();
    expect(versionBlock(project, cleared, "2026-10-01")).toContain("not confirmed by an editor");
  });
});

// ---------- R3-TEST-12: the publish lifecycle ----------

const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
const etagOf = async (path: string) => (await get(path)).headers.get("etag");
const leaderboardSlugs = async () => ((await (await get("/api/public/leaderboard")).json()) as { rows: { slug: string }[] }).rows.map((r) => r.slug);
const publish = async (evaluationIds: string[], label: string) => {
  const res = await post("/api/admin/releases", { evaluationIds, label, notes: "" });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { id: string }).id;
};
const everySuite = suites.map((s) => s.id);

describe("publish lifecycle (R3-TEST-12)", () => {
  beforeAll(async () => {
    await db.insert(schema.projects).values([
      { id: "p3", slug: "gamma", name: "Gamma", websiteUrl: "https://gamma.example.org" },
      { id: "p4", slug: "delta", name: "Delta", websiteUrl: "https://delta.example.org" },
    ]);
    await db.insert(schema.projectVersions).values([
      { id: "d-v1", projectId: "p4", version: "v1", label: "V1", releasedAt: "2026-01-01", status: "tracked" },
      { id: "d-v2", projectId: "p4", version: "v2", label: "V2", releasedAt: "2026-06-01", status: "tracked" },
    ]);
  });

  it("publish then unpublish restores the previous active result and changes the ETag", async () => {
    await seedEvaluation("g-first", { evidencedSuites: everySuite, projectId: "p3" });
    await seedEvaluation("g-second", { evidencedSuites: everySuite, projectId: "p3", option: 1 });
    await publish(["g-first"], "G1");
    const first = (await (await get("/api/public/projects/gamma")).json()) as { snapshot: { scores: { overall: number } } };
    const etag1 = await etagOf("/api/public/projects/gamma");

    await publish(["g-second"], "G2");
    const second = (await (await get("/api/public/projects/gamma")).json()) as { snapshot: { scores: { overall: number } } };
    expect(second.snapshot.scores.overall).not.toBe(first.snapshot.scores.overall);
    const etag2 = await etagOf("/api/public/projects/gamma");
    expect(etag2).not.toBe(etag1);

    expect((await post("/api/admin/projects/p3/unpublish", { versionId: null })).status).toBe(200);
    const active = await db.select().from(schema.publishedResults).where(eq(schema.publishedResults.projectId, "p3"));
    expect(active.filter((r) => r.active).map((r) => r.evaluationId)).toEqual(["g-first"]);
    const restored = await get("/api/public/projects/gamma", { "if-none-match": etag2! });
    expect(restored.status).toBe(200);
    expect(restored.headers.get("etag")).not.toBe(etag2);
    expect(((await restored.json()) as typeof first).snapshot.scores.overall).toBe(first.snapshot.scores.overall);
  });

  it("archiving a project drops it from the leaderboard and the release exports", async () => {
    const releaseId = (await db.select().from(schema.releases).where(eq(schema.releases.label, "G1")))[0]!.id;
    expect(await leaderboardSlugs()).toContain("gamma");
    expect((await get(`/api/public/releases/${releaseId}/export.json`)).status).toBe(200);
    const etag = await etagOf(`/api/public/releases/${releaseId}/export.csv`);

    expect((await post("/api/admin/projects/p3", { status: "archived" }, "PATCH")).status).toBe(200);
    try {
      expect(await leaderboardSlugs()).not.toContain("gamma");
      // G1 held only Gamma, so its exports are gone; the ETag changed, so a cached copy isn't revalidated as fresh.
      expect((await get(`/api/public/releases/${releaseId}/export.json`)).status).toBe(404);
      const csv = await get(`/api/public/releases/${releaseId}/export.csv`, { "if-none-match": etag! });
      expect(csv.status).toBe(404);
      expect((await get("/api/public/projects/gamma")).status).toBe(404);
    } finally {
      expect((await post("/api/admin/projects/p3", { status: "active" }, "PATCH")).status).toBe(200);
    }
    expect(await leaderboardSlugs()).toContain("gamma");
  });

  it("publishing two versions of one project keeps both active", async () => {
    await seedEvaluation("d-old", { evidencedSuites: everySuite, projectId: "p4", versionId: "d-v1" });
    await seedEvaluation("d-new", { evidencedSuites: everySuite, projectId: "p4", versionId: "d-v2", option: 1 });
    await publish(["d-old"], "D1");
    await publish(["d-new"], "D2");
    const rows = await db.select().from(schema.publishedResults).where(eq(schema.publishedResults.projectId, "p4"));
    expect(
      rows
        .filter((r) => r.active)
        .map((r) => r.versionId)
        .sort(),
    ).toEqual(["d-v1", "d-v2"]);
    const page = (await (await get("/api/public/projects/delta")).json()) as { snapshot: { version: { version: string } }; versions: { version: string }[] };
    // Newest version first; the older one stays published and addressable.
    expect(page.snapshot.version.version).toBe("v2");
    expect(page.versions.map((v) => v.version)).toEqual(["v2", "v1"]);
    expect((await get("/api/public/projects/delta?version=v1")).status).toBe(200);
  });
});

// ---------- R3-REL-20, R3-SEC-6: exports and compare ----------

describe("release exports (R3-REL-20)", () => {
  it("answers a matching ETag with 304 and builds each export once per publish generation", async () => {
    const releaseId = (await db.select().from(schema.releases).where(eq(schema.releases.label, "D1")))[0]!.id;
    const path = `/api/public/releases/${releaseId}/export.json`;
    const first = await get(path);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-disposition")).toContain("privacy-benchmark-D1.json");
    expect(await snapshotMemoPeek<string>(db, `export:${releaseId}:json`)).toBe(await first.clone().text());
    expect(((await first.json()) as { snapshots: unknown[] }).snapshots).toHaveLength(1);
    const again = await get(path, { "if-none-match": first.headers.get("etag")! });
    expect(again.status).toBe(304);
    const csv = await get(`/api/public/releases/${releaseId}/export.csv`);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toMatch(/^project,version,overall/);
  });

  it("404s unknown releases without memoizing them", async () => {
    const before = (await snapshotMemoStats(db)).entries;
    for (let i = 0; i < 20; i++) expect((await get(`/api/public/releases/nope-${i}/export.json`)).status).toBe(404);
    expect((await snapshotMemoStats(db)).entries).toBe(before);
  });
});

describe("compare (R3-SEC-6)", () => {
  it("drops unknown and duplicate refs and keys the memo on what resolved", async () => {
    const before = (await snapshotMemoStats(db)).entries;
    const a = (await (await get("/api/public/compare?fields=table&p=gamma,gamma,nope-1,delta")).json()) as { snapshots: { project: { slug: string } }[] };
    expect(a.snapshots.map((s) => s.project.slug)).toEqual(["gamma", "delta"]);
    // Random refs land on the same entry instead of minting new ones.
    for (let i = 0; i < 10; i++) await get(`/api/public/compare?fields=table&p=gamma,nope-${i},delta,gamma`);
    expect((await snapshotMemoStats(db)).entries).toBe(before + 1);
    expect(await snapshotMemoPeek(db, "compare:table:gamma@,delta@v2")).toBeTypeOf("string");
  });

  it("doesn't memoize the full mode, and rate-limits building per client", async () => {
    const before = (await snapshotMemoStats(db)).entries;
    const statuses: number[] = [];
    for (let i = 0; i < 65; i++) statuses.push((await get("/api/public/compare?p=gamma,delta", { "x-real-ip": "203.0.113.77" })).status);
    expect((await snapshotMemoStats(db)).entries).toBe(before);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Another client is unaffected.
    expect((await get("/api/public/compare?p=gamma,delta", { "x-real-ip": "203.0.113.78" })).status).toBe(200);
  });
});

describe("round-5 review fixes", () => {
  it("treats clearing an override as a change the summary must reflect (R5-6)", async () => {
    await seedEvaluation("clr", { evidencedSuites: suites.map((s) => s.id) });
    const c = criteria[5]!;
    const ov = await post(`/api/admin/evaluations/clr/criteria/${c.id}`, { status: "unknown", optionId: null, reason: "Testing the override path." }, "PATCH");
    expect(ov.status).toBe(200);
    // The summary is regenerated after the override...
    await db
      .update(schema.evaluations)
      .set({ summaryAt: new Date(Date.now() + 1000).toISOString() })
      .where(eq(schema.evaluations.id, "clr"));
    await new Promise((r) => setTimeout(r, 1100));
    // ...then the override is cleared: the summary describes an answer that no longer stands.
    expect((await post(`/api/admin/evaluations/clr/criteria/${c.id}`, { clear: true }, "PATCH")).status).toBe(200);
    const res = await post("/api/admin/releases", { evaluationIds: ["clr"], label: "RC", notes: "" });
    expect(await res.text()).toContain("stale_summary");
  });

  it("carries accepted flags over only for the same answer (R5-3)", async () => {
    await seedEvaluation("acc", { evidencedSuites: suites.map((s) => s.id) });
    const c = criteria.find((x) => x.options.length >= 2 && !isHighScrutiny(x))!;
    const id = `acc-${c.id}`;
    await db
      .update(schema.criterionResults)
      .set({ flags: ["self_reported"] })
      .where(eq(schema.criterionResults.id, id));
    await post(`/api/admin/evaluations/acc/criteria/${c.id}`, { accept: true, reason: "The docs are the only source and they are clear." }, "PATCH");
    await db
      .update(schema.criterionResults)
      .set({ optionId: c.options[1]!.id, flags: ["medium_confidence"] })
      .where(eq(schema.criterionResults.id, id));
    await post(`/api/admin/evaluations/acc/criteria/${c.id}`, { accept: true, reason: "Medium confidence, but the quote settles it." }, "PATCH");
    const r = (await db.select().from(schema.criterionResults).where(eq(schema.criterionResults.id, id)))[0]!;
    expect(r.acceptedFlags?.flags).toEqual(["medium_confidence"]);
  });

  it("marks suites reviewed only after the pipeline finished, and only real suites (R5-7)", async () => {
    await seedEvaluation("rev", { evidencedSuites: suites.map((s) => s.id) });
    expect((await post("/api/admin/evaluations/rev/reviewed", { suites: ["not-a-suite"] })).status).toBe(400);
    await db.update(schema.evaluations).set({ status: "running" }).where(eq(schema.evaluations.id, "rev"));
    expect((await post("/api/admin/evaluations/rev/reviewed", { suites: ["custody"] })).status).toBe(409);
    await db.update(schema.evaluations).set({ status: "review" }).where(eq(schema.evaluations.id, "rev"));
    expect((await post("/api/admin/evaluations/rev/reviewed", { suites: ["custody"] })).status).toBe(200);
  });
});
