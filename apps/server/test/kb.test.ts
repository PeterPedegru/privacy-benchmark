import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { type DB, openDb, query, schema } from "../src/db/index.ts";
import { newId } from "../src/lib/ids.ts";
import { classifyUrl } from "../src/services/classify.ts";
import { importGoldenAsDemo, upsertProjectFromGolden } from "../src/services/demo.ts";
import { syncEvidenceClasses } from "../src/services/evidence-classes.ts";
import type { GoldenFile } from "../src/services/golden.ts";
import { assertFreeSpace, kbOverview, ownershipFor, searchSources, searchTerms, storeKbSource } from "../src/services/kb.ts";
import {
  cleanupLegacyRowsOnce,
  LEGACY_CLEANUP_VERSION,
  reclassifySeededRowsOnce,
  resetInterruptedRefreshes,
  SEED_RECLASSIFY_VERSION,
} from "../src/services/kb-maintenance.ts";
import {
  assertBudget,
  contentHash,
  KbBudgetError,
  keepAlive,
  keepNewest,
  MAX_PAGE_CHARS,
  maintainAfterRefresh,
  pruneLane,
  purgeWhere,
  resetBudgetCache,
  storeKbSourceEx,
} from "../src/services/kb-store.ts";

let db: DB;
let pid: string;

async function addProject(extra: Partial<typeof schema.projects.$inferInsert> = {}) {
  const id = newId();
  await db
    .insert(schema.projects)
    .values({ id, slug: `p-${id.slice(0, 6)}`, name: "Aztec", websiteUrl: "https://aztec.network", githubRepos: ["AztecProtocol/aztec-packages"], ...extra });
  return id;
}

const row = async (id: string) => (await db.select().from(schema.sources).where(eq(schema.sources.id, id)))[0]!;

async function addEvaluationCiting(sourceId: string) {
  const evaluationId = newId();
  await db.insert(schema.evaluations).values({ id: evaluationId, projectId: pid });
  await db.insert(schema.evidence).values({ id: newId(), evaluationId, criterionId: "custody.pause.pause-fn", quote: "q", sourceId });
}

beforeEach(async () => {
  db = await openDb({ log: () => {} });
  pid = await addProject();
});

describe("storeKbSource", () => {
  const docs = {
    url: "https://docs.aztec.network/participate/governance/upgrades",
    title: "Upgrades",
    kind: "docs",
    sourceClass: "official_docs" as const,
    content: "Upgrades go through governance with a 30 day exit window and a security council veto.",
    meta: { section: "docs" as const, lane: "docs", runId: "r1" },
  };

  it("skips unchanged content: only bookkeeping is written and the search chunks are untouched (EFF-4)", async () => {
    const first = await storeKbSourceEx(db, pid, docs);
    expect(first.status).toBe("inserted");
    const before = await row(first.id);
    // A chunk row's xmin is the transaction that wrote it: unchanged, the chunks weren't rewritten.
    const chunks = async () =>
      query<{ seq: number; x: string }>(db, sql`SELECT seq, xmin::text AS x FROM source_chunks WHERE source_id = ${first.id} ORDER BY seq`);
    const chunksBefore = await chunks();
    expect(chunksBefore.length).toBeGreaterThan(0);
    const again = await storeKbSourceEx(db, pid, { ...docs, meta: { ...docs.meta, runId: "r2" } });
    expect(again).toEqual({ id: first.id, status: "touched" });
    const after = await row(first.id);
    expect((after.meta as { runId: string }).runId).toBe("r2");
    expect(after.fetchedAt >= before.fetchedAt).toBe(true);
    expect(await chunks()).toEqual(chunksBefore);
    // A real change re-indexes.
    const changed = await storeKbSourceEx(db, pid, { ...docs, content: `${docs.content} Changed: the delay is now 7 days.` });
    expect(changed.status).toBe("updated");
    expect((await searchSources(db, pid, "delay now 7 days"))[0]?.id).toBe(first.id);
  });

  it("keeps content_len in step with content for every writer (EFF-9)", async () => {
    const { id } = await storeKbSourceEx(db, pid, docs);
    expect((await row(id)).contentLen).toBe(docs.content.length);
    await db.update(schema.sources).set({ contentMd: "short" }).where(eq(schema.sources.id, id));
    expect((await row(id)).contentLen).toBe(5);
  });

  it("lets a stronger lane own a URL: the website or Exa lane can't relabel docs as marketing (SRC-1)", async () => {
    const { id } = await storeKbSourceEx(db, pid, docs);
    const weaker = await storeKbSourceEx(db, pid, {
      ...docs,
      kind: "website",
      sourceClass: "marketing",
      content: "Exa copy",
      meta: { section: "website", lane: "website", runId: "r9" },
    });
    expect(weaker).toEqual({ id, status: "kept_stronger_lane" });
    expect(await row(id)).toMatchObject({ kind: "docs", sourceClass: "official_docs", contentMd: docs.content });
    // The reverse is allowed: docs take over a page first stored by the website lane.
    const site = await storeKbSourceEx(db, pid, {
      ...docs,
      url: "https://aztec.network/security",
      kind: "website",
      sourceClass: "marketing",
      meta: { section: "website", lane: "website" },
    });
    const promoted = await storeKbSourceEx(db, pid, { ...docs, url: "https://aztec.network/security" });
    expect(promoted).toEqual({ id: site.id, status: "updated" });
    expect((await row(site.id)).sourceClass).toBe("official_docs");
  });

  it("treats www and apex as one URL and skips duplicate bodies in the same section (SRC-13)", async () => {
    const a = await storeKbSourceEx(db, pid, { ...docs, url: "https://www.miden.xyz/security" });
    expect((await storeKbSourceEx(db, pid, { ...docs, url: "https://miden.xyz/security" })).id).toBe(a.id);
    const body = "Identical generated reference page. ".repeat(10);
    const first = await storeKbSourceEx(db, pid, { ...docs, url: "https://docs.x.org/corelib/a", content: body });
    expect(await storeKbSourceEx(db, pid, { ...docs, url: "https://docs.x.org/corelib/b", content: body })).toEqual({
      id: first.id,
      status: "duplicate_content",
    });
  });

  it("never overwrites attestations and keeps agent-stored rows as the agent's", async () => {
    const att = newId();
    await db.insert(schema.sources).values({ id: att, projectId: pid, url: "attestation://x", kind: "attestation", contentMd: "attested", origin: "agent" });
    expect((await storeKbSourceEx(db, pid, { ...docs, url: "attestation://x" })).status).toBe("kept_stronger_lane");
    const agent = newId();
    await db
      .insert(schema.sources)
      .values({ id: agent, projectId: pid, url: "https://blog.example.org/a", kind: "analysis", contentMd: "agent copy", origin: "agent" });
    await storeKbSourceEx(db, pid, { ...docs, url: "https://blog.example.org/a", meta: { section: "analysis", lane: "analysis", runId: "r1" } });
    expect((await row(agent)).origin).toBe("agent");
  });
});

describe("pruning by run id (SRC-15, EFF-7)", () => {
  it("deletes rows a successful lane didn't touch, marks cited ones stale, and spares other lanes, attestations and non-kb rows", async () => {
    const mk = (url: string, lane: string, runId: string) =>
      storeKbSource(db, pid, {
        url,
        title: url,
        kind: "docs",
        sourceClass: "official_docs",
        content: `content of ${url} with some words`,
        meta: { section: "docs", lane, runId },
      });
    const fresh = await mk("https://docs.aztec.network/a", "docs", "run2");
    const old = await mk("https://docs.aztec.network/old", "docs", "run1");
    const cited = await mk("https://docs.aztec.network/cited", "docs", "run1");
    const otherLane = await mk("https://aztec.network/x", "website", "run1");
    const legacy = await storeKbSource(db, pid, {
      url: "https://docs.aztec.network/legacy",
      title: "l",
      kind: "docs",
      sourceClass: "official_docs",
      content: "legacy row",
      meta: { section: "docs" },
    });
    const admin = newId();
    await db
      .insert(schema.sources)
      .values({ id: admin, projectId: pid, url: "https://docs.aztec.network/admin-seed", origin: "admin", meta: { section: "docs", lane: "docs" } });
    const att = newId();
    await db.insert(schema.sources).values({ id: att, projectId: pid, url: "attestation://1", kind: "attestation", origin: "kb", meta: { lane: "docs" } });
    await addEvaluationCiting(cited);

    const r = await pruneLane(db, pid, "docs", "run2", { legacySections: ["docs"] });
    expect(r).toEqual({ deleted: 2, staled: 1 });
    const ids = new Set((await db.select({ id: schema.sources.id }).from(schema.sources)).map((x) => x.id));
    expect(ids.has(fresh)).toBe(true);
    expect(ids.has(old)).toBe(false);
    expect(ids.has(legacy)).toBe(false);
    expect(ids.has(otherLane)).toBe(true);
    expect(ids.has(admin)).toBe(true);
    expect(ids.has(att)).toBe(true);
    expect(((await row(cited)).meta as { stale?: boolean }).stale).toBe(true);
    // Stale rows are hidden from search but evidence still points at them.
    expect((await searchSources(db, pid, "content cited")).some((h) => h.id === cited)).toBe(false);
    // Touching the row again clears the flag.
    await mk("https://docs.aztec.network/cited", "docs", "run3");
    expect(((await row(cited)).meta as { stale?: boolean }).stale).toBeUndefined();
  });

  it("purges by condition and keeps only the newest rows of a lane", async () => {
    for (let i = 0; i < 5; i++)
      await storeKbSource(db, pid, {
        url: `https://news.example/${i}`,
        title: `n${i}`,
        kind: "news",
        sourceClass: "independent",
        content: `article ${i} about Aztec`,
        date: `2026-0${i + 1}-01`,
        meta: { section: "news", lane: "news", runId: "r" },
      });
    expect(await keepNewest(db, pid, "news", 3)).toBe(2);
    const left = await db.select({ title: schema.sources.title }).from(schema.sources).where(eq(schema.sources.kind, "news"));
    expect(left.map((l) => l.title).sort()).toEqual(["n2", "n3", "n4"]);
    expect((await purgeWhere(db, pid, sql`title = ${"n4"}`)).deleted).toBe(1);
  });
});

describe("search and overview (SRC-16)", () => {
  it("merges all-term and any-term matches, collapses duplicates and ranks generated code last", async () => {
    const base = { kind: "code", sourceClass: "code_onchain" as const, meta: { section: "code" as const, lane: "code:x", runId: "r" } };
    const voting = await storeKbSource(db, pid, {
      ...base,
      url: "https://github.com/o/r/blob/v1/src/Voting.sol",
      title: "Voting.sol",
      content: "contract Voting { uint256 quorum; uint256 delay; }",
    });
    const gov = await storeKbSource(db, pid, {
      ...base,
      url: "https://github.com/o/r/blob/v1/src/Governance.sol",
      title: "Governance.sol",
      content: "governance vote quorum delay rules",
    });
    const gen = await storeKbSource(db, pid, {
      ...base,
      url: "https://github.com/o/r/blob/v1/rust_bindings/src/gov.rs",
      title: "gov.rs",
      content: "governance vote quorum delay generated binding",
    });
    await storeKbSource(db, pid, {
      ...base,
      url: "https://github.com/o/r/blob/v1/src/Governance-copy.sol",
      title: "copy",
      content: "governance vote quorum delay rules",
    });
    const hits = await searchSources(db, pid, "governance vote quorum delay");
    expect(hits[0]?.id).toBe(gov);
    expect(hits.map((h) => h.id)).toContain(voting);
    expect(hits.at(-1)?.id).toBe(gen);
    expect(hits.filter((h) => h.title === "copy")).toHaveLength(0);
  });

  it("lists lanes with refs and errors, and leaves out empty rows", async () => {
    await db.insert(schema.sources).values({ id: newId(), projectId: pid, url: "https://seed.example", kind: "l2beat", contentMd: "", origin: "admin" });
    await storeKbSource(db, pid, {
      url: "https://github.com/AztecProtocol/aztec-packages/tree/v5.2.0",
      title: "AztecProtocol/aztec-packages@v5.2.0: repository map",
      kind: "code",
      sourceClass: "code_onchain",
      content: "README.md\nl1-contracts/src/core/Rollup.sol",
      meta: { section: "code", lane: "code:AztecProtocol/aztec-packages", runId: "r", map: true },
    });
    await db
      .update(schema.projects)
      .set({
        kbRefreshedAt: "2026-09-30T12:00:00.000Z",
        kbMeta: {
          lanes: {
            "code:AztecProtocol/aztec-packages": { ok: true, count: 800, ref: "v5.2.0 (0123456789)", note: "pinned", refreshedAt: "2026-09-30T12:00:00Z" },
            news: { ok: false, count: 0, error: "eventregistry.org 503", refreshedAt: "2026-09-30T12:00:00Z" },
          },
        },
      })
      .where(eq(schema.projects.id, pid));
    const text = await kbOverview(db, pid);
    expect(text).toContain("- code:AztecProtocol/aztec-packages: 800 · v5.2.0 (0123456789) · pinned (2026-09-30)");
    expect(text).toContain("- news: FAILED on 2026-09-30: eventregistry.org 503");
    expect(text).toContain("- code: 1 sources");
    expect(text).not.toContain("l2beat:");
    expect(text).toContain("Repository maps");
  });
});

describe("ownershipFor", () => {
  it("combines the persisted registry with current configuration for the tools", async () => {
    await db
      .update(schema.projects)
      .set({
        extraDomains: ["aztec-labs.com"],
        kbMeta: {
          registry: {
            name: "Aztec",
            aliases: ["Aztec"],
            tokens: ["aztec"],
            siteHosts: ["aztec.network"],
            docsRoots: [{ host: "docs.aztec.network", prefix: "" }],
            domains: ["aztec.network"],
            ownedPaths: [],
            githubOwners: ["aztecprotocol"],
            xHandles: ["aztecnetwork"],
            forumHosts: ["forum.aztec.network"],
          },
        },
      })
      .where(eq(schema.projects.id, pid));
    const ctx = await ownershipFor(db, pid);
    expect(classifyUrl("https://docs.aztec.network/x", "agent", ctx)).toMatchObject({ sourceClass: "official_docs", docsRoot: true });
    expect(classifyUrl("https://forum.aztec.network/t/x/1", "agent", { ...ctx, authorRole: "member" })).toMatchObject({
      sourceClass: "third_party",
      kind: "governance",
    });
    expect(ctx.registry.domains).toContain("aztec-labs.com");
    await expect(ownershipFor(db, "nope")).rejects.toThrow();
  });

  it("brings other benchmarked projects along as interested parties", async () => {
    await addProject({ name: "Railgun", slug: "railgun", websiteUrl: "https://railgun.org", githubRepos: ["Railgun-Privacy/contract"] });
    const ctx = await ownershipFor(db, pid);
    expect(ctx.interested?.domains).toContain("railgun.org");
    expect(classifyUrl("https://railgun.org/blog/aztec-vs-railgun", "agent", ctx)).toMatchObject({ owner: "interested_party", sourceClass: "marketing" });
  });
});

describe("legacy rows and adoption (R3-SRC-2)", () => {
  const legacy = async (url: string, extra: Partial<typeof schema.sources.$inferInsert> = {}) => {
    const id = newId();
    await db.insert(schema.sources).values({
      id,
      projectId: pid,
      url,
      kind: "analysis",
      sourceClass: "independent",
      origin: "kb",
      contentMd: "Aztec Aztec notes",
      meta: { section: "analysis" },
      ...extra,
    });
    return id;
  };

  it("reclassifies pre-lane rows, hides them, deletes uncited drops, and runs once", async () => {
    const github = await legacy("https://github.com/AztecProtocol/aztec-packages/blob/main/README.md", { title: "Aztec README" });
    const mirror = await legacy("https://deepwiki.com/AztecProtocol/aztec-packages/2.3-note-management");
    const citedMirror = await legacy("https://deepwiki.com/AztecProtocol/aztec-packages/other");
    const docsTwin = await legacy("https://docs.aztec.network/participate/governance.md", {
      kind: "website",
      sourceClass: "marketing",
      meta: { section: "website" },
    });
    await db
      .update(schema.projects)
      .set({ docsRoots: [{ url: "https://docs.aztec.network/", prefix: "" }] })
      .where(eq(schema.projects.id, pid));
    const laneRow = await storeKbSource(db, pid, {
      url: "https://docs.aztec.network/participate/fees",
      title: "Fees",
      kind: "docs",
      sourceClass: "official_docs",
      content: "fees content",
      meta: { section: "docs", lane: "docs", runId: "r1" },
    });
    await addEvaluationCiting(citedMirror);
    const r = await cleanupLegacyRowsOnce(db);
    expect(r).toMatchObject({ projects: 1, deleted: 1 });
    expect(await row(github)).toMatchObject({ kind: "docs", sourceClass: "official_docs" });
    expect(((await row(github)).meta as { stale?: boolean }).stale).toBe(true);
    expect(await row(docsTwin)).toMatchObject({ kind: "docs", sourceClass: "official_docs" });
    expect((await db.select().from(schema.sources).where(eq(schema.sources.id, mirror)))[0]).toBeUndefined();
    expect(((await row(citedMirror)).meta as { stale?: boolean }).stale).toBe(true);
    expect(((await row(laneRow)).meta as { stale?: boolean }).stale).toBeUndefined();
    const p = (await db.select().from(schema.projects).where(eq(schema.projects.id, pid)))[0]!;
    expect((p.kbMeta as { maintenance?: { legacyCleanup?: string } }).maintenance?.legacyCleanup).toBe(LEGACY_CLEANUP_VERSION);
    // Idempotent: the marker skips the project next time.
    expect((await cleanupLegacyRowsOnce(db)).projects).toBe(0);
  });

  it("lets a lane adopt a legacy duplicate under the canonical URL instead of being blocked by it", async () => {
    const body = "The governance page body, long enough to be de-duplicated by content hash. ".repeat(5);
    const twin = await legacy("https://docs.aztec.network/participate/governance.md", {
      kind: "docs",
      sourceClass: "official_docs",
      contentMd: body,
      contentHash: contentHash(body),
      meta: { section: "docs" },
    });
    const r = await storeKbSourceEx(db, pid, {
      url: "https://docs.aztec.network/participate/governance",
      title: "Governance",
      kind: "docs",
      sourceClass: "official_docs",
      content: body,
      meta: { section: "docs", lane: "docs", runId: "r2" },
    });
    expect(r).toEqual({ id: twin, status: "updated" });
    expect(await row(twin)).toMatchObject({ url: "https://docs.aztec.network/participate/governance", title: "Governance" });
    expect(((await row(twin)).meta as { lane?: string; runId?: string }).lane).toBe("docs");
  });

  it("marks cited legacy rows stale when a lane prunes its legacy sections", async () => {
    const cited = await legacy("https://docs.aztec.network/old-page", { kind: "docs", meta: { section: "docs" } });
    const uncited = await legacy("https://docs.aztec.network/older-page", { kind: "docs", meta: { section: "docs" } });
    await addEvaluationCiting(cited);
    expect(await pruneLane(db, pid, "docs", "r9", { legacySections: ["docs"] })).toEqual({ deleted: 1, staled: 1 });
    expect(((await row(cited)).meta as { stale?: boolean }).stale).toBe(true);
    expect((await db.select().from(schema.sources).where(eq(schema.sources.id, uncited)))[0]).toBeUndefined();
  });
});

describe("demo-seeded sources (R4-12)", () => {
  const NEWS = "https://crypto.news/aztec-sequencer-outage/";
  const AUDIT = "https://github.com/AztecProtocol/aztec-packages/blob/master/audits/zellic-2026.md";
  const KB_PAGE = "https://docs.aztec.network/participate/fees";
  const EDITED = "https://www.theblock.co/post/1/aztec-explained";
  const EDITOR = "https://www.coindesk.com/aztec-review";
  // Seeded before seed marks existed, with the class the golden file gave it before R4-12.
  const OLD_SEED = "https://crypto.news/what-broke-ethereums-fusaka-upgrade/";
  const golden: GoldenFile = {
    project: {
      slug: "aztec",
      name: "Aztec",
      website: "https://aztec.network",
      logoUrl: null,
      tagline: "",
      description: "",
      category: "l2",
      mechanism: "private_execution",
      attributes: [],
      chains: ["Ethereum"],
    } as GoldenFile["project"],
    asOf: "2026-09-30",
    summary: "",
    context: {},
    powers: [],
    sources: [
      { id: "news", url: NEWS, title: "Outage", kind: "news", sourceClass: "independent", date: null },
      { id: "audit", url: AUDIT, title: "Zellic audit", kind: "audit", sourceClass: "independent", date: null },
      { id: "kb", url: KB_PAGE, title: "Fees", kind: "docs", sourceClass: "marketing", date: "2026-09-01" },
      { id: "edited", url: EDITED, title: "Explainer", kind: "news", sourceClass: "independent", date: null },
      { id: "editor", url: EDITOR, title: "Review", kind: "news", sourceClass: "independent", date: null },
      { id: "old", url: OLD_SEED, title: "Fusaka", kind: "news", sourceClass: "third_party", date: null },
    ],
    answers: [
      {
        criterionId: "custody.pause.pause-fn",
        status: "answered",
        optionId: "none",
        rationale: "Fixture rationale.",
        confidence: "high",
        evidence: [
          { sourceId: "news", quote: "q1", claim: "" },
          { sourceId: "kb", quote: "q2", claim: "" },
          { sourceId: "editor", quote: "q3", claim: "" },
        ],
      },
    ],
    matrix: {},
  };
  const byUrl = async (url: string) => (await db.select().from(schema.sources).where(eq(schema.sources.url, url)))[0]!;
  const seedOf = async (url: string) => ((await byUrl(url)).meta as { seed?: { golden: string; sourceClass: string } }).seed;
  const evidenceClass = async (evaluationId: string, url: string) => {
    const sourceId = (await byUrl(url)).id;
    return (await db.select().from(schema.evidence)).find((e) => e.evaluationId === evaluationId && e.sourceId === sourceId)?.sourceClass;
  };

  /** The project with a knowledge-base row, an editor's row and an old unmarked seed at golden URLs, then the import. */
  async function imported(): Promise<{ projectId: string; evaluationId: string }> {
    const projectId = await upsertProjectFromGolden(db, golden);
    await db.insert(schema.sources).values([
      {
        id: newId(),
        projectId,
        url: KB_PAGE,
        kind: "docs",
        sourceClass: "official_docs",
        origin: "kb",
        contentMd: "fees",
        meta: { section: "docs", lane: "docs" },
      },
      // The editor's own class for a URL the golden file also lists (the golden file says independent).
      { id: newId(), projectId, url: EDITOR, kind: "analysis", sourceClass: "official_docs", origin: "admin", httpStatus: 200, contentMd: "review" },
      { id: newId(), projectId, url: OLD_SEED, kind: "news", sourceClass: "independent", origin: "admin" },
    ]);
    const evaluationId = await importGoldenAsDemo(db, golden, null);
    return { projectId, evaluationId };
  }

  it("never overwrites a knowledge-base or editor row's class, and marks the rows it seeds", async () => {
    const { evaluationId } = await imported();
    expect(await byUrl(KB_PAGE)).toMatchObject({ origin: "kb", sourceClass: "official_docs", kind: "docs", date: "2026-09-01" });
    expect(await seedOf(KB_PAGE)).toBeUndefined();
    expect(await byUrl(EDITOR)).toMatchObject({ origin: "admin", sourceClass: "official_docs", kind: "analysis" });
    expect(await seedOf(EDITOR)).toBeUndefined();
    expect(await evidenceClass(evaluationId, EDITOR)).toBe("official_docs");
    expect(await byUrl(NEWS)).toMatchObject({ origin: "admin", sourceClass: "independent" });
    expect(await seedOf(NEWS)).toEqual({ golden: "aztec", sourceClass: "independent" });
    // Evidence takes the class its source row has.
    expect(await evidenceClass(evaluationId, KB_PAGE)).toBe("official_docs");
    expect(await evidenceClass(evaluationId, NEWS)).toBe("independent");
    // A row seeded before marks existed (its pre-R4-12 golden class, no HTTP status) is the import's own: updated.
    expect((await byUrl(OLD_SEED)).sourceClass).toBe("third_party");
    expect(await seedOf(OLD_SEED)).toEqual({ golden: "aztec", sourceClass: "third_party" });
    // A lane refreshing a seeded row keeps the seed mark (and the editor class).
    await storeKbSource(db, (await byUrl(NEWS)).projectId, {
      url: NEWS,
      title: "Outage",
      kind: "news",
      sourceClass: "third_party",
      content: "text",
      meta: { section: "news", lane: "news" },
    });
    expect(await seedOf(NEWS)).toEqual({ golden: "aztec", sourceClass: "independent" });
    expect((await byUrl(NEWS)).sourceClass).toBe("independent");
  });

  it("reclassifies seeded rows with the classifier once, leaving classes editors set by hand", async () => {
    const { projectId, evaluationId } = await imported();
    // An editor reclassified one seeded row by hand (PATCH /sources/:id).
    await db.update(schema.sources).set({ sourceClass: "marketing" }).where(eq(schema.sources.url, EDITED));
    // A database seeded before marks existed and never re-imported: an unmarked row with its pre-R4-12 class.
    await db.update(schema.sources).set({ sourceClass: "independent", meta: {} }).where(eq(schema.sources.url, OLD_SEED));
    // A published evaluation citing a seeded row: its evidence is frozen with the snapshot.
    const published = newId();
    await db.insert(schema.evaluations).values({ id: published, projectId, status: "published" });
    await db.insert(schema.evidence).values({
      id: newId(),
      evaluationId: published,
      criterionId: "custody.pause.pause-fn",
      quote: "q",
      sourceId: (await byUrl(NEWS)).id,
      sourceClass: "independent",
    });

    const r = await reclassifySeededRowsOnce(db, [golden]);
    // Two projects: this one and the empty one every test starts with.
    expect(r).toMatchObject({ projects: 2, marked: 1, reclassified: 3 });
    // News is third-party writing; the project's own copy of an audit is its own document.
    expect((await byUrl(NEWS)).sourceClass).toBe("third_party");
    expect(await seedOf(NEWS)).toEqual({ golden: "aztec", sourceClass: "third_party" });
    expect((await byUrl(AUDIT)).sourceClass).toBe("official_docs");
    // The older seed is recognised by its pre-R4-12 class and reclassified too.
    expect((await byUrl(OLD_SEED)).sourceClass).toBe("third_party");
    expect(await seedOf(OLD_SEED)).toEqual({ golden: "aztec", sourceClass: "third_party" });
    // Hand-set classes and other origins stay.
    expect((await byUrl(EDITED)).sourceClass).toBe("marketing");
    expect((await byUrl(EDITOR)).sourceClass).toBe("official_docs");
    expect((await byUrl(KB_PAGE)).sourceClass).toBe("official_docs");
    // Evidence follows its source through the boot sync (the only writer of evidence classes): in the unpublished
    // demo evaluation, not in the published one.
    expect(await syncEvidenceClasses(db)).toBe(1);
    expect(await evidenceClass(evaluationId, NEWS)).toBe("third_party");
    expect(await evidenceClass(published, NEWS)).toBe("independent");
    // Idempotent: the per-project marker skips the project next time.
    const p = (await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)))[0]!;
    expect((p.kbMeta as { maintenance?: Record<string, string> }).maintenance?.seedReclassify).toBe(SEED_RECLASSIFY_VERSION);
    expect((await reclassifySeededRowsOnce(db, [golden])).projects).toBe(0);
    // A re-import still owns its unchanged seeds and writes the file's class (the real golden files now agree with
    // the classifier, so that is the same class); the editor's hand-set class survives it.
    await importGoldenAsDemo(db, golden, null);
    expect(await seedOf(NEWS)).toEqual({ golden: "aztec", sourceClass: "independent" });
    expect((await byUrl(EDITED)).sourceClass).toBe("marketing");
  });
});

describe("limits and maintenance (R3-SEC-8, R3-REL-10, R3-REL-12)", () => {
  it("caps web pages at 300 KB and enforces the project's byte budget", async () => {
    const { id } = await storeKbSourceEx(db, pid, {
      url: "https://docs.aztec.network/huge",
      title: "Huge",
      kind: "docs",
      sourceClass: "official_docs",
      content: "x".repeat(MAX_PAGE_CHARS + 50_000),
      meta: { section: "docs", lane: "docs", runId: "r" },
    });
    expect((await row(id)).contentLen).toBeLessThan(MAX_PAGE_CHARS + 200);
    expect((await row(id)).contentMd).toContain("(truncated");
    resetBudgetCache();
    await expect(assertBudget(db, pid, 1, 1000)).rejects.toThrow(KbBudgetError);
    await expect(assertBudget(db, pid, -5, 1000)).resolves.toBeUndefined();
    await expect(assertBudget(db, pid, 1)).resolves.toBeUndefined();
    // In-memory databases always pass the free-space check.
    expect(() => assertFreeSpace(db, Number.MAX_SAFE_INTEGER)).not.toThrow();
  });

  it("keeps a failed page's row through the lane's prune", async () => {
    const id = await storeKbSource(db, pid, {
      url: "https://docs.aztec.network/flaky",
      title: "Flaky",
      kind: "docs",
      sourceClass: "official_docs",
      content: "content",
      meta: { section: "docs", lane: "docs", runId: "r1" },
    });
    expect(await keepAlive(db, pid, "docs", "r2", ["https://docs.aztec.network/flaky"])).toBe(1);
    expect((await pruneLane(db, pid, "docs", "r2")).deleted).toBe(0);
    expect(await row(id)).toBeTruthy();
  });

  it("resets refresh statuses left by a stopped process", async () => {
    const fresh = await addProject({ kbStatus: "refreshing" });
    await db.update(schema.projects).set({ kbStatus: "refreshing", kbRefreshedAt: "2026-09-01T00:00:00Z" }).where(eq(schema.projects.id, pid));
    expect(await resetInterruptedRefreshes(db)).toBe(2);
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, pid)))[0]).toMatchObject({
      kbStatus: "error",
      kbError: "Interrupted: the refresh stopped reporting",
    });
    expect((await db.select().from(schema.projects).where(eq(schema.projects.id, fresh)))[0]).toMatchObject({ kbStatus: "empty" });
  });

  it("merges FTS segments in a few bounded steps", async () => {
    for (let i = 0; i < 30; i++)
      await storeKbSource(db, pid, {
        url: `https://docs.aztec.network/p${i}`,
        title: `P${i}`,
        kind: "docs",
        sourceClass: "official_docs",
        content: `page ${i} body`,
        meta: { section: "docs", lane: "docs", runId: "r" },
      });
    await maintainAfterRefresh(db);
    expect((await searchSources(db, pid, "page body")).length).toBeGreaterThan(0);
  });
});

describe("search (R3-SRC-6, R3-REL-4)", () => {
  const put = (url: string, kind: string, content: string, meta: Record<string, unknown> = {}) =>
    storeKbSource(db, pid, { url, title: url, kind, sourceClass: "official_docs", content, meta: { section: "docs", lane: "t", runId: "r", ...meta } });

  it("ignores stop words, so OR mode doesn't match every page with 'the'", async () => {
    expect(searchTerms("who can upgrade the contracts")).toEqual(["upgrade", "contracts"]);
    expect(searchTerms("the")).toEqual(["the"]);
    const target = await put("https://docs.aztec.network/upgrades", "docs", "Governance can upgrade the rollup contracts after a delay.");
    await put("https://docs.aztec.network/noise", "docs", "Who can say what the answer is to any of the questions in the world.");
    const hits = await searchSources(db, pid, "who can upgrade the contracts");
    expect(hits.map((h) => h.id)).toEqual([target]);
    expect(hits[0]!.snippet).toContain("«upgrade»");
  });

  it("hides other evaluations' attestations and shows the current one's", async () => {
    const mine = newId();
    const other = newId();
    await db.insert(schema.sources).values([
      { id: mine, projectId: pid, url: "attestation://evalA/c/1", kind: "attestation", contentMd: "no freeze function found" },
      { id: other, projectId: pid, url: "attestation://evalB/c/1", kind: "attestation", contentMd: "no freeze function found anywhere" },
    ]);
    expect(await searchSources(db, pid, "freeze function")).toEqual([]);
    expect((await searchSources(db, pid, "freeze function", { evaluationId: "evalA" })).map((h) => h.id)).toEqual([mine]);
  });

  it("maps advertised kinds to what rows carry, and keeps records that share a URL apart", async () => {
    const hack1 = await put("https://defillama.com/hacks#aztec-bridge-2026-06-17", "defillama", "Aztec Bridge exploit record", { subkind: "incident" });
    const hack2 = await put("https://defillama.com/hacks#aztec-connect-2026-06-14", "defillama", "Aztec Connect exploit record", { subkind: "incident" });
    const adv = await put("https://github.com/AztecProtocol/aztec-packages/security/advisories/GHSA-1", "changes", "Advisory about an exploit in the prover", {
      subkind: "advisory",
    });
    const forum = await put("https://forum.aztec.network/t/x/1", "governance", "Forum thread on the exploit response");
    const reg = await put("evm://registry/aztec", "onchain", "Registry listing the exploit contracts");
    const q = async (kinds: string[]) => (await searchSources(db, pid, "exploit", { kinds })).map((h) => h.id);
    expect((await q(["incident"])).sort()).toEqual([hack1, hack2].sort());
    expect(await q(["advisory"])).toEqual([adv]);
    expect(await q(["forum"])).toEqual([forum]);
    expect(await q(["registry"])).toEqual([reg]);
    expect((await q(["incident", "registry"])).sort()).toEqual([hack1, hack2, reg].sort());
    // X months: same page, different records.
    const m1 = await put("https://x.com/tempo#2026-08", "announcement", "zones launch");
    const m2 = await put("https://x.com/tempo#2026-09", "announcement", "zones mainnet");
    expect((await searchSources(db, pid, "zones", { kinds: ["announcement"] })).map((h) => h.id).sort()).toEqual([m1, m2].sort());
  });

  it("ranks X posts after real pages when only some terms match", async () => {
    const post = await put("https://x.com/aztec#2026-09", "announcement", "Big week: governance vote, upgrade, escape hatch, and more.");
    const doc = await put("https://docs.aztec.network/escape", "docs", "The escape hatch lets users exit without the sequencer.");
    const hits = await searchSources(db, pid, "escape hatch sequencer upgrade");
    expect(hits.map((h) => h.id)).toEqual([doc, post]);
  });

  it("shows partial lanes in the overview", async () => {
    await db
      .update(schema.projects)
      .set({ kbMeta: { lanes: { docs: { ok: true, count: 40, partial: true, note: "12 fetch failures", refreshedAt: "2026-10-01T00:00:00Z" } } } })
      .where(eq(schema.projects.id, pid));
    expect(await kbOverview(db, pid)).toContain("- docs: 40 (PARTIAL");
  });
});
