import { createHash } from "node:crypto";
import type { CompareResponse, LeaderboardResponse, ProjectSnapshot } from "@pb/core";
import { cardConfigSchema, httpUrlSchema } from "@pb/core";
import { benchmarks, diffAnswers, fmtScore, levelNumber, operatorNumber, rubric, suites } from "@pb/rubric";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { getDb, schema } from "../db/index.ts";
import { promptCatalog, promptHashes } from "../eval/prompts.ts";
import { clientIp, windowLimiter } from "../lib/auth.ts";
import { shortId } from "../lib/ids.ts";
import { stableJson } from "../lib/stable-json.ts";
import { getLogo, isProjectLogoUrl, logoUrlForSlug } from "../services/logos.ts";
import {
  leaderboardRow,
  publicSettings,
  publishedDataVersion,
  readSnapshot,
  releaseInfo,
  resolveSnapshot,
  snapshotEtag,
  snapshotMemo,
  snapshotMemoPeek,
  visibleByProject,
  visibleSnapshots,
} from "../services/snapshots.ts";

export const publicRoutes = new Hono();

// ---------- caching (EFF-1, EFF-2) ----------

/**
 * Public JSON is revalidated on every use: the ETag makes that a 304 until something published or visible changes,
 * and a change (a release, a rollback, an editor hiding a project) shows on the next load, not minutes later.
 */
export const PUBLIC_CACHE_CONTROL = "public, no-cache";

function etagMatches(c: Context, etag: string): boolean {
  const inm = c.req.header("if-none-match");
  if (!inm) return false;
  const bare = etag.replace(/^W\//, "");
  return inm.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v.replace(/^W\//, "") === bare;
  });
}

/**
 * Responds with JSON derived only from published data. `memoKey` caches the serialized body for the current publish
 * generation; omit it for bodies keyed by arbitrary input.
 */
async function publishedJson(c: Context, build: () => Promise<unknown> | unknown, memoKey?: string) {
  const db = getDb();
  const etag = await snapshotEtag(db);
  c.header("etag", etag);
  c.header("cache-control", PUBLIC_CACHE_CONTROL);
  if (etagMatches(c, etag)) return c.body(null, 304);
  const body = memoKey ? await snapshotMemo(db, memoKey, async () => JSON.stringify(await build())) : JSON.stringify(await build());
  return c.body(body, 200, { "content-type": "application/json; charset=UTF-8" });
}

// ---------- published data ----------

async function latestRelease(list: ProjectSnapshot[]) {
  const top = list.reduce<ProjectSnapshot | null>((a, s) => (!a || s.release.publishedAt > a.release.publishedAt ? s : a), null);
  if (!top) return null;
  return (await getDb().select().from(schema.releases).where(eq(schema.releases.id, top.release.id)))[0] ?? null;
}

publicRoutes.get("/meta", (c) =>
  publishedJson(
    c,
    async () => {
      const list = await visibleSnapshots(getDb());
      const rel = await latestRelease(list);
      return {
        rubricVersion: rubric.version,
        // Changes with anything published or visible (a hidden project too), so clients refetch what they hold.
        dataVersion: await publishedDataVersion(getDb()),
        projects: new Set(list.map((s) => s.project.slug)).size,
        release: rel ? { ...releaseInfo(rel), notes: rel.notesMd } : null,
        isDemo: list.length > 0 && list.every((s) => s.release.isDemo),
      };
    },
    "meta",
  ),
);

publicRoutes.get("/rubric", (c) => publishedJson(c, () => rubric, "rubric"));

publicRoutes.get("/prompts", (c) => publishedJson(c, () => ({ hashes: promptHashes(), prompts: promptCatalog() }), "prompts"));

publicRoutes.get("/leaderboard", (c) =>
  publishedJson(
    c,
    async () => {
      const db = getDb();
      const rows = [...(await visibleByProject(db)).values()].map((arr) => {
        const row = leaderboardRow(arr[0]!);
        row.otherVersions = arr.slice(1).map((s) => ({ version: s.version?.version ?? "", label: s.version?.label ?? "" }));
        return row;
      });
      rows.sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));
      const rel = await latestRelease(await visibleSnapshots(db));
      const body: LeaderboardResponse = {
        release: rel
          ? { ...releaseInfo(rel), notes: rel.notesMd, settings: publicSettings(rel.evalSettings) }
          : { id: "", label: "", publishedAt: "", isDemo: false, rubricVersion: rubric.version, notes: "", settings: null },
        rows,
      };
      return body;
    },
    "leaderboard",
  ),
);

publicRoutes.get("/projects", (c) =>
  publishedJson(
    c,
    async () =>
      [...(await visibleByProject(getDb())).values()].map((arr) => ({
        ...leaderboardRow(arr[0]!),
        versions: arr.map((s) => s.version),
      })),
    "projects",
  ),
);

/**
 * A published result that was withdrawn (unpublished) rather than superseded: inactive, with no newer active result
 * for the same project version. Superseded results stay in history and old release exports; withdrawn ones don't.
 */
const pr = schema.publishedResults;
const notWithdrawn = or(
  eq(pr.active, true),
  sql`exists (select 1 from published_results newer where newer.active and newer.project_id = ${pr.projectId} and newer.version_id IS NOT DISTINCT FROM ${pr.versionId} and newer.created_at >= ${pr.createdAt} and newer.id != ${pr.id})`,
);

publicRoutes.get("/projects/:slug", async (c) => {
  const slug = c.req.param("slug");
  const version = c.req.query("version");
  const db = getDb();
  const arr = (await visibleByProject(db)).get(slug) ?? [];
  if (!arr.length) return c.json({ error: "not_found" }, 404);
  const snapshot = version ? arr.find((s) => s.version?.version === version) : arr[0];
  if (!snapshot) return c.json({ error: "version_not_found" }, 404);
  return publishedJson(
    c,
    async () => {
      const idx = arr.indexOf(snapshot);
      const prev = arr[idx + 1];
      const toMap = (s: ProjectSnapshot) =>
        Object.fromEntries(Object.entries(s.criteria).map(([id, cr]) => [id, { criterionId: id, status: cr.status, optionId: cr.optionId }]));
      // History across published results for this project (all releases), newest first. Withdrawn results are excluded.
      const hist = (
        await db
          .select({ snapshot: schema.publishedResults.snapshot })
          .from(schema.publishedResults)
          .innerJoin(schema.projects, eq(schema.projects.id, schema.publishedResults.projectId))
          .where(and(eq(schema.projects.slug, slug), eq(schema.projects.status, "active"), notWithdrawn))
          .orderBy(desc(schema.publishedResults.createdAt))
      )
        .map((r) => readSnapshot(r.snapshot))
        .filter((s) => s.release.isDemo === snapshot.release.isDemo);
      return {
        snapshot,
        versions: arr.map((s) => ({ ...s.version, overall: s.scores.overall, level: s.scores.level })),
        history: hist.map((s) => ({ release: s.release, version: s.version, overall: s.scores.overall, level: s.scores.level })),
        changes: prev ? diffAnswers(toMap(prev), toMap(snapshot)) : [],
        comparedTo: prev ? { version: prev.version, overall: prev.scores.overall } : null,
      };
    },
    `project:${slug}@${version ?? ""}`,
  );
});

/**
 * The table needs answers, flags and scores, not the evidence behind them (EFF-29): `fields=table` drops quotes,
 * rationales and sources, which are most of a snapshot's size. The cell breakdown loads the full project page.
 */
function tableOnly(s: ProjectSnapshot): ProjectSnapshot {
  const criteria = Object.fromEntries(Object.entries(s.criteria).map(([id, c]) => [id, { ...c, rationale: "", evidence: [] }]));
  return { ...s, summary: "", powers: [], context: {}, sources: [], criteria };
}

/** Bodies built per IP per minute (memo misses and the unmemoized full mode); 304s and memo hits don't count. */
const compareBuilds = windowLimiter({ limit: 60, windowMs: 60_000 });

/**
 * Up to 8 published snapshots side by side. Refs are resolved first: unknown ones and duplicates are dropped, so the
 * memo key names snapshots that exist and random refs can't mint new entries (R3-SEC-6). Only `fields=table` (what
 * the web app asks for) is memoized; the full mode serializes every quote and is built per request, and building
 * is rate-limited per IP.
 */
publicRoutes.get("/compare", async (c) => {
  const db = getDb();
  const table = c.req.query("fields") === "table";
  const snapshots: ProjectSnapshot[] = [];
  const seen = new Set<string>();
  for (const ref of (c.req.query("p") ?? "").split(",").slice(0, 32)) {
    const s = ref.trim() ? await resolveSnapshot(db, ref.trim(), { visibleOnly: true }) : null;
    const id = s ? `${s.project.slug}@${s.version?.version ?? ""}` : "";
    if (!s || seen.has(id)) continue;
    seen.add(id);
    snapshots.push(s);
    // The benchmark table opens on every project in the latest release.
    if (snapshots.length === 16) break;
  }
  const etag = await snapshotEtag(db);
  c.header("etag", etag);
  c.header("cache-control", PUBLIC_CACHE_CONTROL);
  if (etagMatches(c, etag)) return c.body(null, 304);
  const key = `compare:table:${[...seen].join(",")}`;
  let body = table ? await snapshotMemoPeek<string>(db, key) : undefined;
  if (body === undefined) {
    if (!compareBuilds.hit(clientIp(c))) return c.json({ error: "rate_limited" }, 429, { "retry-after": "60", "cache-control": "no-store" });
    const build = () => {
      const release = snapshots[0]?.release ?? { id: "", label: "", publishedAt: "", isDemo: false, rubricVersion: rubric.version };
      const out: CompareResponse = { release, snapshots: table ? snapshots.map(tableOnly) : snapshots };
      return JSON.stringify(out);
    };
    body = table ? await snapshotMemo(db, key, build) : build();
  }
  return c.body(body, 200, { "content-type": "application/json; charset=UTF-8" });
});

publicRoutes.get("/releases", (c) =>
  publishedJson(
    c,
    async () => {
      const db = getDb();
      const rows = await db.select().from(schema.releases).orderBy(desc(schema.releases.publishedAt));
      const counts = new Map(
        (
          await db
            .select({ releaseId: schema.publishedResults.releaseId, n: sql<number>`count(*)` })
            .from(schema.publishedResults)
            .innerJoin(schema.projects, eq(schema.projects.id, schema.publishedResults.projectId))
            .where(and(eq(schema.projects.status, "active"), notWithdrawn))
            .groupBy(schema.publishedResults.releaseId)
        ).map((r) => [r.releaseId, r.n]),
      );
      // Same rule as the leaderboard: demo releases are hidden while a real release still has a visible result. Once
      // every real result is withdrawn or archived, the site shows the demo again, and so does this list.
      const hasLiveReal = rows.some((r) => !r.isDemo && (counts.get(r.id) ?? 0) > 0);
      return rows.filter((r) => !hasLiveReal || !r.isDemo).map((r) => ({ ...releaseInfo(r), notes: r.notesMd, projects: counts.get(r.id) ?? 0 }));
    },
    "releases",
  ),
);

publicRoutes.get("/releases/:id/settings", async (c) => {
  const r = (
    await getDb()
      .select()
      .from(schema.releases)
      .where(eq(schema.releases.id, c.req.param("id")))
  )[0];
  if (!r) return c.json({ error: "not_found" }, 404);
  // Filtered at read time too, so rows written before the publish-time filter never leak internal notes (SEC-5).
  return publishedJson(c, () => ({ release: releaseInfo(r), settings: publicSettings(r.evalSettings), prompts: promptCatalog() }));
});

/** A release's results that are still published: not withdrawn, and the project isn't archived (SEC-10). */
async function releaseSnapshots(id: string): Promise<ProjectSnapshot[]> {
  return (
    await getDb()
      .select({ snapshot: schema.publishedResults.snapshot })
      .from(schema.publishedResults)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.publishedResults.projectId))
      .where(and(eq(schema.publishedResults.releaseId, id), eq(schema.projects.status, "active"), notWithdrawn))
  ).map((r) => readSnapshot(r.snapshot));
}

/**
 * A release export (R3-REL-20). The ETag is checked first, so a revalidation never reads or parses the release's
 * snapshots, and the body is built once per publish generation. Only releases that exist get a memo entry, so random
 * ids can't fill it. Withdrawing a result or archiving a project changes the generation, hence the ETag.
 */
async function releaseExport(c: Context, kind: "json" | "csv", build: (snaps: ProjectSnapshot[]) => string) {
  const db = getDb();
  const id = c.req.param("id") ?? "";
  const etag = await snapshotEtag(db);
  if (etagMatches(c, etag)) return c.body(null, 304, { etag, "cache-control": PUBLIC_CACHE_CONTROL });
  const notFound = () => (kind === "json" ? c.json({ error: "not_found" }, 404) : c.text("not found", 404));
  const release = (await db.select({ label: schema.releases.label }).from(schema.releases).where(eq(schema.releases.id, id)))[0];
  if (!release) return notFound();
  const body = await snapshotMemo(db, `export:${id}:${kind}`, async () => {
    const snaps = await releaseSnapshots(id);
    return snaps.length ? build(snaps) : "";
  });
  if (!body) return notFound();
  return c.body(body, 200, {
    etag,
    "cache-control": PUBLIC_CACHE_CONTROL,
    "content-type": kind === "json" ? "application/json; charset=UTF-8" : "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="privacy-benchmark-${release.label.replace(/\W+/g, "-")}.${kind}"`,
  });
}

publicRoutes.get("/releases/:id/export.json", (c) => releaseExport(c, "json", (snapshots) => JSON.stringify({ rubric, snapshots })));

/**
 * One CSV field. Values starting with a formula trigger (= + - @, tab, CR) are prefixed with a quote so spreadsheets
 * show them as text (SEC-15); project names and version labels come from scraped titles and release notes. Plain
 * negative numbers are left alone.
 */
export function csvField(raw: string): string {
  let v = raw;
  if (/^[=+\-@\t\r]/.test(v) && !/^-\d+(\.\d+)?$/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

publicRoutes.get("/releases/:id/export.csv", (c) => releaseExport(c, "csv", releaseCsv));

function releaseCsv(snaps: ProjectSnapshot[]): string {
  const header = [
    "project",
    "version",
    "overall",
    "privacy_public",
    "privacy_operator",
    "walkaway",
    ...suites.map((s) => `suite:${s.id}`),
    ...benchmarks.map((b) => b.id),
  ];
  const lines = [header.map(csvField).join(",")];
  for (const s of snaps) {
    const bm = new Map(s.scores.suites.flatMap((x) => x.benchmarks.map((b) => [b.benchmarkId, b.score] as const)));
    lines.push(
      [
        s.project.name,
        s.version?.label ?? "",
        fmtScore(s.scores.overall),
        // The privacy scores as numbers, 0 to 5, as the badge shows them (Public, Operator).
        levelNumber(s.scores.level) ?? "",
        operatorNumber(s.scores.trustTier, s.scores.level) ?? "",
        s.scores.walkaway.passed === null ? "" : s.scores.walkaway.passed ? "pass" : "fail",
        ...s.scores.suites.map((x) => fmtScore(x.score)),
        ...benchmarks.map((b) => fmtScore(bm.get(b.id) ?? null)),
      ]
        .map((v) => csvField(String(v)))
        .join(","),
    );
  }
  return lines.join("\n");
}

// ---------- cards ----------

/** Card ids are derived from the normalized config, so sharing the same card twice returns the same id. */
export function cardIdFor(config: unknown): string {
  const h = createHash("sha256").update(stableJson(config)).digest();
  return h.readBigUInt64BE(0).toString(36).padStart(13, "0").slice(0, 12);
}

const cardCreates = windowLimiter({ limit: 60, windowMs: 60 * 60_000 });

publicRoutes.post("/cards", async (c) => {
  if (!cardCreates.hit(clientIp(c))) return c.json({ error: "rate_limited" }, 429);
  const parsed = cardConfigSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const cfg = parsed.data;
  const db = getDb();
  const unknown: string[] = [];
  for (const r of cfg.projects) if (!(await resolveSnapshot(db, r, { visibleOnly: true }))) unknown.push(r);
  if (unknown.length) return c.json({ error: "unknown_projects", message: `Not published: ${unknown.join(", ")}`, refs: unknown }, 400);
  const id = cardIdFor(cfg);
  await db.insert(schema.cards).values({ id, config: cfg }).onConflictDoNothing();
  return c.json({ id });
});

publicRoutes.get("/cards/:id", async (c) => {
  const row = (
    await getDb()
      .select()
      .from(schema.cards)
      .where(eq(schema.cards.id, c.req.param("id")))
  )[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  // A card's config never changes once stored.
  c.header("cache-control", "public, max-age=86400");
  return c.json(row.config);
});

// ---------- logos (SEC-17) ----------

async function logoResponse(c: Context, url: string | null, cacheControl: string) {
  const logo = url ? await getLogo(url) : null;
  if (!logo) {
    c.header("cache-control", "public, max-age=300");
    return c.text("not found", 404);
  }
  if (etagMatches(c, logo.etag)) return c.body(null, 304, { etag: logo.etag, "cache-control": cacheControl });
  return c.body(new Uint8Array(logo.body), 200, { "content-type": logo.contentType, etag: logo.etag, "cache-control": cacheControl });
}

/** `?u=` is the logo URL itself (what the web app has); only URLs that are a project's logo are fetched. */
publicRoutes.get("/logo", async (c) => {
  const u = c.req.query("u") ?? "";
  if (u.length > 2048 || !(await isProjectLogoUrl(getDb(), u))) return logoResponse(c, null, "");
  // Keyed by the upstream URL, which changes when an editor changes the logo, so the response is immutable.
  return logoResponse(c, u, "public, max-age=2592000, immutable");
});

publicRoutes.get("/logo/:slug", async (c) => {
  const slug = c.req.param("slug").replace(/\.\w+$/, "");
  // Only published projects: otherwise slugs of unpublished projects could be probed (R3-SEC-14).
  if (!(await visibleByProject(getDb())).has(slug)) return c.json({ error: "not_found" }, 404);
  return logoResponse(c, await logoUrlForSlug(getDb(), slug), "public, max-age=86400, stale-while-revalidate=604800");
});

// ---------- corrections ----------

const correctionSchema = z.object({
  projectSlug: z.string().max(64),
  criterionId: z.string().max(120).nullable().optional(),
  message: z.string().min(10).max(4000),
  evidenceUrl: httpUrlSchema.nullable().optional(),
  contact: z.string().max(200).nullable().optional(),
});
const correctionHits = windowLimiter({ limit: 10, windowMs: 3600_000 });

/**
 * The public corrections log (JDG-38): every decided correction with the editor's reason and the release that
 * applied it. The submitter's message and contact stay private; they may hold personal details.
 */
publicRoutes.get("/corrections", async (c) => {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.corrections.id,
      projectSlug: schema.corrections.projectSlug,
      projectName: schema.projects.name,
      criterionId: schema.corrections.criterionId,
      status: schema.corrections.status,
      note: schema.corrections.decisionNote,
      submittedAt: schema.corrections.createdAt,
      decidedAt: schema.corrections.decidedAt,
      releaseId: schema.releases.id,
      releaseLabel: schema.releases.label,
    })
    .from(schema.corrections)
    .innerJoin(schema.projects, eq(schema.projects.slug, schema.corrections.projectSlug))
    .leftJoin(schema.releases, eq(schema.releases.id, schema.corrections.releaseId))
    .where(
      and(
        eq(schema.projects.status, "active"),
        inArray(schema.corrections.status, ["accepted", "rejected", "done"]),
        isNotNull(schema.corrections.decisionNote),
      ),
    )
    .orderBy(desc(schema.corrections.decidedAt))
    .limit(200);
  const open = (await db.select({ n: sql<number>`count(*)` }).from(schema.corrections).where(eq(schema.corrections.status, "open")))[0]?.n ?? 0;
  // Only projects with a published result appear publicly (R3-SEC-14).
  const visible = await visibleByProject(db);
  c.header("cache-control", "public, max-age=60");
  return c.json({
    open,
    items: rows
      .filter((r) => visible.has(r.projectSlug))
      .map(({ releaseId, releaseLabel, ...r }) => ({ ...r, release: releaseId ? { id: releaseId, label: releaseLabel } : null })),
  });
});

publicRoutes.post("/corrections", async (c) => {
  if (!correctionHits.hit(clientIp(c))) return c.json({ error: "rate_limited" }, 429);
  const parsed = correctionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid" }, 400);
  await getDb()
    .insert(schema.corrections)
    .values({
      id: shortId(),
      ...parsed.data,
      criterionId: parsed.data.criterionId ?? null,
      evidenceUrl: parsed.data.evidenceUrl ?? null,
      contact: parsed.data.contact ?? null,
    });
  return c.json({ ok: true });
});
