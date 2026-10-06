import { httpUrlSchema, INFO_FLAGS, overrideSchema, projectInputSchema, releaseRequestSchema } from "@pb/core";
import { findCriterion, normalizeLevel, rubric, scoreProject, suites } from "@pb/rubric";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type DB, getDb, query, schema } from "../db/index.ts";
import { costCapFor, env, modelFor } from "../env.ts";
import { bus } from "../eval/events.ts";
import { MODES, type Mode, summarize } from "../eval/pipeline.ts";
import { cancelEvaluation, cancelRun, enqueueRun, isRunning, projectBusy, RERUNNABLE, rerunSuites, resumeEvaluation } from "../eval/queue.ts";
import {
  adminConfigured,
  checkPassword,
  clientIp,
  csrfOk,
  endSession,
  isAdmin,
  isKnownDevice,
  loginAllowed,
  recordLoginFailure,
  rememberDevice,
  requireAdmin,
  startSession,
} from "../lib/auth.ts";
import { hasExa, hasNews, hasX, normalizeHandle } from "../lib/externals.ts";
import { fetchPage } from "../lib/extract.ts";
import { newId } from "../lib/ids.ts";
import { emptyUsage, getKeyStatus, hasApiKey, verifyApiKey } from "../lib/llm.ts";
import { stableJson } from "../lib/stable-json.ts";
import { xAuthEnabled } from "../lib/voter.ts";
import { evidenceCoverage } from "../services/coverage.ts";
import { invalidateOffchainAttestations, syncEvidenceClasses } from "../services/evidence-classes.ts";
import { intake, slugify } from "../services/intake.ts";
import { isKbRefreshing, type KbMeta, refreshKnowledgeBase, searchSources } from "../services/kb.ts";
import { answerMapFor, buildSnapshot, bumpSnapshots, loadEvaluation, publishRelease, unpublishProject } from "../services/snapshots.ts";
import { checkAllVersions, checkProjectVersions, normalizeVersion, summarizeAnnouncement, summarizeChecks } from "../services/versions.ts";
import {
  cancelPoll,
  listWeightings,
  openPoll,
  openPollRow,
  PollError,
  pollById,
  pollInfo,
  pollPreview,
  setRetired,
  usableWeighting,
  weightingFor,
  weightingRef,
} from "../services/weighting.ts";

/** INFO_FLAGS as an SQL list, for counting the flags that still need review. */
const INFO_FLAG_SQL = `(${[...INFO_FLAGS].map((f) => `'${f}'`).join(", ")})`;

export const adminRoutes = new Hono();

// ---------- auth ----------

adminRoutes.post("/login", bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
  if (!adminConfigured()) return c.json({ error: "not_configured", message: "Set ADMIN_PASSWORD in apps/server/.env and restart the server." }, 503);
  const ip = clientIp(c);
  // A browser that signed in before skips the global slow-down, so nobody can lock the editor out (R3-SEC-7).
  const allowed = loginAllowed(ip, Date.now(), { knownDevice: await isKnownDevice(c) });
  if (!allowed.ok) {
    c.header("retry-after", String(allowed.retryAfterSeconds));
    return c.json(
      {
        error: allowed.reason === "slowed" ? "login_slowed" : "rate_limited",
        message: `Too many sign-in attempts. Try again in ${allowed.retryAfterSeconds} seconds.`,
      },
      429,
    );
  }
  const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
  if (!(await checkPassword(body?.password))) {
    recordLoginFailure(ip);
    return c.json({ error: "invalid_password" }, 401);
  }
  await startSession(c);
  await rememberDevice(c);
  return c.json({ ok: true });
});

adminRoutes.post("/logout", async (c) => {
  // A cross-site request can't log the editor out: with a live session, the CSRF header is required here too.
  if ((await isAdmin(c)) && !csrfOk(c)) return c.json({ error: "csrf" }, 403);
  await endSession(c);
  return c.json({ ok: true });
});

adminRoutes.get("/me", async (c) => c.json({ admin: await isAdmin(c), configured: adminConfigured() }));

/** Exact paths only: a suffix match let `DELETE /sources/login` and friends skip auth and CSRF (SEC-11). */
const OPEN_ADMIN_ROUTES = new Set(["POST /api/admin/login", "POST /api/admin/logout", "GET /api/admin/me"]);

adminRoutes.use("/*", async (c, next) => {
  if (OPEN_ADMIN_ROUTES.has(`${c.req.method} ${c.req.path}`)) return next();
  return requireAdmin(c, next);
});

// ---------- overview & settings ----------

adminRoutes.get("/overview", async (c) => {
  const db = getDb();
  const count = async (t: typeof schema.projects | typeof schema.releases) => (await db.select({ n: sql<number>`count(*)` }).from(t))[0]?.n ?? 0;
  const spend =
    (
      await db
        .select({ s: sql<number>`coalesce(sum(cost_usd),0)` })
        .from(schema.evaluations)
        .where(sql`created_at >= to_char(date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`)
    )[0]?.s ?? 0;
  const awaiting = (await db.select({ n: sql<number>`count(*)` }).from(schema.evaluations).where(eq(schema.evaluations.status, "review")))[0]?.n ?? 0;
  const running =
    (
      await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.evaluations)
        .where(inArray(schema.evaluations.status, ["queued", "running"]))
    )[0]?.n ?? 0;
  const updates = (await db.select({ n: sql<number>`count(*)` }).from(schema.projectVersions).where(eq(schema.projectVersions.status, "detected")))[0]?.n ?? 0;
  const corrections = (await db.select({ n: sql<number>`count(*)` }).from(schema.corrections).where(eq(schema.corrections.status, "open")))[0]?.n ?? 0;
  const lastRelease = (await db.select().from(schema.releases).orderBy(desc(schema.releases.publishedAt)))[0] ?? null;
  const recentRuns = await db.select().from(schema.runs).orderBy(desc(schema.runs.createdAt)).limit(5);
  const poll = await openPollRow(db);
  return c.json({
    poll: poll ? await pollInfo(db, poll) : null,
    projects: await count(schema.projects),
    releases: await count(schema.releases),
    spendThisMonth: spend,
    awaitingReview: awaiting,
    running,
    updates,
    corrections,
    lastRelease,
    recentRuns,
  });
});

adminRoutes.get("/settings", (c) =>
  c.json({
    anthropicKey: hasApiKey(),
    anthropicKeyPlaceholder: !!env.anthropicKey && !hasApiKey(),
    anthropicStatus: getKeyStatus(),
    anthropicWorkspaceId: !!env.anthropicWorkspaceId,
    seedDemo: env.seedDemo,
    githubToken: !!env.githubToken,
    etherscanKey: !!env.etherscanKey,
    research: {
      exa: { set: hasExa(), placeholder: !!env.exaKey && !hasExa() },
      news: { set: hasNews(), placeholder: !!env.newsApiKey && !hasNews() },
      x: { set: hasX(), placeholder: !!env.xBearer && !hasX() },
    },
    kb: env.kb,
    models: {
      tiers: { gather: env.models.gather, write: env.models.write, reason: env.models.reason },
      stages: Object.fromEntries((["scout", "code", "research", "judge", "skeptic", "summary", "intake", "versions"] as const).map((s) => [s, modelFor(s)])),
    },
    costCapUsd: env.evalCostCapUsd,
    costCaps: env.costCaps,
    maxConcurrentProjects: env.maxConcurrentProjects,
    versionCheckHours: env.versionCheckHours,
    rubricVersion: rubric.version,
    modes: MODES,
  }),
);

adminRoutes.post("/settings/verify-key", async (c) => c.json(await verifyApiKey()));

adminRoutes.get("/version-checks", async (c) => {
  const db = getDb();
  const rows = await db
    .select({ c: schema.versionChecks, slug: schema.projects.slug, name: schema.projects.name })
    .from(schema.versionChecks)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.versionChecks.projectId))
    .orderBy(desc(schema.versionChecks.ranAt))
    .limit(20);
  return c.json(rows.map((r) => ({ ...r.c, projectSlug: r.slug, projectName: r.name })));
});

/** Per-project cost (USD) by mode when there isn't enough history; from the cost model in the efficiency review. */
// Until there's history: deep runs the mechanics audit and a code check of every unknown on top of larger budgets.
const ESTIMATE_DEFAULTS: Record<Mode, [number, number]> = { quick: [5, 10], standard: [14, 25], deep: [45, 80] };
/** Share of a full evaluation's cost that doesn't depend on how many suites run (knowledge base, scout, code audit). */
const FIXED_SHARE = 0.45;

adminRoutes.get("/estimate", async (c) => {
  const mode: Mode = (["quick", "standard", "deep"] as const).find((m) => m === c.req.query("mode")) ?? "deep";
  const n = Math.min(50, Math.max(1, Math.floor(Number(c.req.query("projects") ?? 1)) || 1));
  const suiteCount = Math.min(suites.length, Math.max(1, Math.floor(Number(c.req.query("suites") ?? suites.length)) || suites.length));
  // Calibrated from finished full evaluations in this mode; partial (suite-filtered) runs would skew it low.
  const hist = (
    await getDb()
      .select({ n: sql<number>`count(*)`, avg: sql<number>`avg(${schema.evaluations.costUsd})`, max: sql<number>`max(${schema.evaluations.costUsd})` })
      .from(schema.evaluations)
      .where(
        and(
          eq(schema.evaluations.mode, mode),
          eq(schema.evaluations.isDemo, false),
          inArray(schema.evaluations.status, ["review", "reviewed", "published"]),
          sql`${schema.evaluations.suiteFilter} is null`,
          sql`${schema.evaluations.costUsd} > 0`,
        ),
      )
  )[0];
  const fromHistory = (hist?.n ?? 0) >= 3;
  const perProject: [number, number] = fromHistory ? [hist!.avg * 0.85, Math.max(hist!.max, hist!.avg * 1.25)] : ESTIMATE_DEFAULTS[mode];
  const scale = FIXED_SHARE + (1 - FIXED_SHARE) * (suiteCount / suites.length);
  const cap = costCapFor(mode);
  return c.json({
    low: Math.min(perProject[0] * scale, cap) * n,
    high: Math.min(perProject[1] * scale, cap) * n,
    capPerEvaluation: cap,
    basis: fromHistory ? "history" : "default",
    samples: hist?.n ?? 0,
    note: fromHistory
      ? `Based on ${hist!.n} finished ${mode} evaluations; each evaluation stops at the $${cap} ${mode} cap.`
      : `Rough estimate until a few ${mode} evaluations have finished; each evaluation stops at the $${cap} ${mode} cap.`,
  });
});

// ---------- projects ----------

/** Groups rows by a key in one pass (list endpoints used to filter the whole table once per project or run). */
function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = map.get(k);
    if (arr) arr.push(r);
    else map.set(k, [r]);
  }
  return map;
}

/** Evaluation columns for list views: everything except the large settings/usage blobs. */
const evaluationListColumns = {
  id: schema.evaluations.id,
  runId: schema.evaluations.runId,
  projectId: schema.evaluations.projectId,
  versionId: schema.evaluations.versionId,
  status: schema.evaluations.status,
  stage: schema.evaluations.stage,
  completedStages: schema.evaluations.completedStages,
  mode: schema.evaluations.mode,
  suiteFilter: schema.evaluations.suiteFilter,
  reviewedSuites: schema.evaluations.reviewedSuites,
  error: schema.evaluations.error,
  costUsd: schema.evaluations.costUsd,
  isDemo: schema.evaluations.isDemo,
  createdAt: schema.evaluations.createdAt,
  startedAt: schema.evaluations.startedAt,
  finishedAt: schema.evaluations.finishedAt,
  weightingId: schema.evaluations.weightingId,
};

/**
 * Whether each evaluation's summary can be published: "missing" (none written), "stale" (an answer was re-judged or
 * overridden after it was written, R4-3) or "current". The summary is the most-read text on a project page.
 */
async function summaryStates(db: DB, ids: string[]): Promise<Map<string, "current" | "stale" | "missing">> {
  if (!ids.length) return new Map();
  const evs = await db
    .select({ id: schema.evaluations.id, summary: schema.evaluations.summary, summaryAt: schema.evaluations.summaryAt })
    .from(schema.evaluations)
    .where(inArray(schema.evaluations.id, ids));
  const changed = new Map(
    (
      await db
        .select({
          id: schema.criterionResults.evaluationId,
          at: sql<string | null>`greatest(max(coalesce(overridden_at, '')), max(coalesce(updated_at, '')))`,
        })
        .from(schema.criterionResults)
        .where(inArray(schema.criterionResults.evaluationId, ids))
        .groupBy(schema.criterionResults.evaluationId)
    ).map((r) => [r.id, r.at]),
  );
  return new Map(
    evs.map((e) => {
      if (!e.summaryAt || !e.summary.trim()) return [e.id, "missing"];
      const last = changed.get(e.id);
      return [e.id, last && last > e.summaryAt ? "stale" : "current"];
    }),
  );
}

adminRoutes.get("/projects", async (c) => {
  const db = getDb();
  const projects = await db.select().from(schema.projects).orderBy(schema.projects.name);
  const versions = groupBy(
    await db
      .select({
        id: schema.projectVersions.id,
        projectId: schema.projectVersions.projectId,
        version: schema.projectVersions.version,
        label: schema.projectVersions.label,
        releasedAt: schema.projectVersions.releasedAt,
        source: schema.projectVersions.source,
        tag: schema.projectVersions.tag,
        isMajor: schema.projectVersions.isMajor,
        isPrerelease: schema.projectVersions.isPrerelease,
        status: schema.projectVersions.status,
        privacyRelevant: schema.projectVersions.privacyRelevant,
        createdAt: schema.projectVersions.createdAt,
      })
      .from(schema.projectVersions)
      .orderBy(desc(sql`coalesce(${schema.projectVersions.releasedAt}, '')`)),
    (v) => v.projectId,
  );
  // Latest evaluation per project in SQL, without loading every evaluation's settings blob.
  const ranked = db
    .select({
      ...evaluationListColumns,
      rn: sql<number>`row_number() over (partition by ${schema.evaluations.projectId} order by ${schema.evaluations.createdAt} desc)`.as("rn"),
    })
    .from(schema.evaluations)
    .as("ranked");
  const latest = new Map((await db.select().from(ranked).where(sql`${ranked.rn} = 1`)).map(({ rn: _rn, ...e }) => [e.projectId, e]));
  const published = groupBy(
    await db
      .select({
        id: schema.publishedResults.id,
        projectId: schema.publishedResults.projectId,
        overall: schema.publishedResults.overall,
        versionId: schema.publishedResults.versionId,
        level: schema.publishedResults.level,
      })
      .from(schema.publishedResults)
      .where(eq(schema.publishedResults.active, true)),
    (r) => r.projectId,
  );
  return c.json(
    projects.map((p) => {
      const vs = versions.get(p.id) ?? [];
      return {
        ...p,
        versions: vs,
        latestEvaluation: latest.get(p.id) ?? null,
        published: (published.get(p.id) ?? []).map(({ projectId: _p, ...r }) => ({ ...r, level: normalizeLevel(r.level) })),
        updates: vs.filter((v) => v.status === "detected").length,
      };
    }),
  );
});

adminRoutes.post("/projects/intake", async (c) => {
  const body = z.object({ url: httpUrlSchema }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_url" }, 400);
  try {
    return c.json(await intake(body.data.url));
  } catch (e) {
    return c.json({ error: "intake_failed", message: (e as Error).message }, 422);
  }
});

const FIELD_LABELS: Record<string, string> = {
  slug: "Slug",
  name: "Name",
  websiteUrl: "Website",
  logoUrl: "Logo URL",
  tagline: "Tagline",
  description: "Description",
  category: "Category",
  mechanism: "Mechanism",
  attributes: "Attributes",
  chains: "Chains",
  githubRepos: "GitHub repos",
  xHandle: "X handle",
  docsUrl: "Docs URL",
  versionTagPattern: "Version tag pattern",
};

/** 400 with a readable message (the admin UI toasts `message`) plus the raw issues. */
function invalid(c: Context, error: z.ZodError) {
  const message = error.issues
    .slice(0, 3)
    .map((i) => `${FIELD_LABELS[String(i.path[0])] ?? (i.path.join(".") || "Request")}: ${i.message}`)
    .join(" · ");
  return c.json({ error: "invalid", message, issues: error.issues }, 400);
}

const httpUrl = (v: unknown, max = 2048): string | null => {
  if (typeof v !== "string" || !v.trim() || v.length > max) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
};
const strList = (v: unknown, maxLen: number) =>
  Array.isArray(v)
    ? [
        ...new Set(
          v
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.trim().slice(0, maxLen))
            .filter(Boolean),
        ),
      ].slice(0, 20)
    : v;

/** Coerces form and intake values into what the schema accepts, so cosmetic problems never block a save. */
function cleanProjectInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = { ...(raw as Record<string, unknown>) };
  const has = (k: string) => k in r && r[k] !== undefined;
  if (has("name") && typeof r.name === "string") r.name = r.name.trim().slice(0, 120);
  // An edited slug is normalized ("My Project" → "my-project"); an empty one falls back to the name.
  if (has("slug")) r.slug = slugify(String(r.slug ?? "")) || slugify(String(r.name ?? ""));
  if (has("websiteUrl") && typeof r.websiteUrl === "string") r.websiteUrl = r.websiteUrl.trim();
  if (has("logoUrl")) r.logoUrl = httpUrl(r.logoUrl);
  if (has("docsUrl")) r.docsUrl = httpUrl(r.docsUrl);
  for (const [k, max] of [
    ["tagline", 200],
    ["description", 2000],
  ] as const)
    if (has(k))
      r[k] = String(r[k] ?? "")
        .trim()
        .slice(0, max);
  if (has("attributes")) r.attributes = strList(r.attributes, 32);
  if (has("chains")) r.chains = strList(r.chains, 64);
  if (has("githubRepos") && Array.isArray(r.githubRepos))
    r.githubRepos = [
      ...new Set(
        r.githubRepos
          .filter((x): x is string => typeof x === "string")
          .map((x) =>
            x
              .trim()
              .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
              .replace(/\.git$/i, "")
              .split("/")
              .slice(0, 2)
              .join("/"),
          )
          // owner/name only; "." and ".." segments would walk to other GitHub API endpoints (R3-SEC-13).
          .filter((x) => /^[\w.-]+\/[\w.-]+$/.test(x) && x.split("/").every((seg) => seg !== "." && seg !== "..")),
      ),
    ].slice(0, 10);
  if (has("xHandle")) r.xHandle = typeof r.xHandle === "string" ? normalizeHandle(r.xHandle) : null;
  for (const k of ["l2beatSlug", "defillamaSlug", "versionTagPattern"]) if (has(k) && typeof r[k] === "string" && !(r[k] as string).trim()) r[k] = null;
  if (has("newsAliases")) r.newsAliases = strList(r.newsAliases, 60);
  if (has("extraDomains")) r.extraDomains = strList(r.extraDomains, 120);
  if (has("docsRoots") && Array.isArray(r.docsRoots))
    r.docsRoots = r.docsRoots
      .filter((x): x is { url: unknown; prefix?: unknown } => !!x && typeof x === "object")
      // A prefix is a path on the root's host ("/build/privacy"): anything else could change the host the crawler builds.
      .map((x) => {
        const prefix = typeof x.prefix === "string" ? x.prefix.trim() : "";
        return { url: httpUrl(x.url), ...(/^\/[^?#@\\\s]{0,200}$/.test(prefix) ? { prefix } : {}) };
      })
      .filter((x) => x.url);
  return r;
}

const createProjectSchema = projectInputSchema.extend({
  githubRepos: z
    .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
    .max(10)
    .default([]),
  xHandle: z.string().max(15).nullable().optional(),
  docsUrl: httpUrlSchema.nullable().optional(),
  /** Docs scopes to crawl (umbrella sites: one host, several products). */
  docsRoots: z
    .array(z.object({ url: httpUrlSchema, prefix: z.string().max(200).optional() }))
    .max(10)
    .optional(),
  /** Other names the press uses for the project, for the news lane. */
  newsAliases: z.array(z.string().min(2).max(60)).max(10).optional(),
  /** Extra domains, Medium accounts or GitHub orgs the project owns (classified as the project's own). */
  extraDomains: z.array(z.string().min(3).max(120)).max(20).optional(),
});

adminRoutes.post("/projects", async (c) => {
  const parsed = createProjectSchema.safeParse(cleanProjectInput(await c.req.json().catch(() => null)));
  if (!parsed.success) return invalid(c, parsed.error);
  const db = getDb();
  const d = parsed.data;
  if ((await db.select().from(schema.projects).where(eq(schema.projects.slug, d.slug)))[0]) return c.json({ error: "slug_taken" }, 409);
  const id = newId();
  await db.insert(schema.projects).values({
    id,
    slug: d.slug,
    name: d.name,
    websiteUrl: d.websiteUrl,
    logoUrl: d.logoUrl ?? null,
    tagline: d.tagline,
    description: d.description,
    category: d.category,
    mechanism: d.mechanism,
    attributes: d.attributes,
    chains: d.chains,
    l2beatSlug: d.l2beatSlug ?? null,
    defillamaSlug: d.defillamaSlug ?? null,
    githubRepos: d.githubRepos,
    docsRoots: d.docsRoots ?? [],
    newsAliases: d.newsAliases ?? [],
    extraDomains: d.extraDomains ?? [],
    xHandle: d.xHandle ?? null,
    // Prefilled by intake from the site, so it's verified against the X profile like a discovered handle.
    xHandleSource: d.xHandle ? "auto" : null,
    docsUrl: d.docsUrl ?? null,
  });
  return c.json({ id });
});

adminRoutes.get("/projects/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, id)))[0];
  if (!project) return c.json({ error: "not_found" }, 404);
  const sources = await db
    .select({
      id: schema.sources.id,
      url: schema.sources.url,
      title: schema.sources.title,
      kind: schema.sources.kind,
      sourceClass: schema.sources.sourceClass,
      origin: schema.sources.origin,
      fetchedAt: schema.sources.fetchedAt,
      size: sql<number>`coalesce(${schema.sources.contentLen}, length(content_md))`,
    })
    .from(schema.sources)
    .where(and(eq(schema.sources.projectId, id), sql`${schema.sources.origin} != 'kb'`))
    .orderBy(desc(schema.sources.fetchedAt))
    .limit(500);
  const versions = await db
    .select()
    .from(schema.projectVersions)
    .where(eq(schema.projectVersions.projectId, id))
    .orderBy(desc(schema.projectVersions.releasedAt));
  const evaluations = await db.select().from(schema.evaluations).where(eq(schema.evaluations.projectId, id)).orderBy(desc(schema.evaluations.createdAt));
  const checks = await db.select().from(schema.versionChecks).where(eq(schema.versionChecks.projectId, id)).orderBy(desc(schema.versionChecks.ranAt)).limit(10);
  const published = await db
    .select({
      id: schema.publishedResults.id,
      releaseId: schema.publishedResults.releaseId,
      versionId: schema.publishedResults.versionId,
      overall: schema.publishedResults.overall,
      active: schema.publishedResults.active,
      createdAt: schema.publishedResults.createdAt,
    })
    .from(schema.publishedResults)
    .where(eq(schema.publishedResults.projectId, id))
    .orderBy(desc(schema.publishedResults.createdAt));
  return c.json({
    project,
    sources,
    kb: await kbSummary(id),
    versions,
    evaluations: evaluations.map((e) => ({ ...e, settings: undefined })),
    checks,
    published: published.map((p) => ({
      id: p.id,
      releaseId: p.releaseId,
      versionId: p.versionId,
      overall: p.overall,
      active: p.active,
      createdAt: p.createdAt,
    })),
  });
});

adminRoutes.patch("/projects/:id", async (c) => {
  const parsed = createProjectSchema
    .partial()
    .extend({
      status: z.enum(["active", "archived"]).optional(),
      trackVersions: z.boolean().optional(),
      versionTagPattern: z.string().max(200).nullable().optional(),
    })
    .safeParse(cleanProjectInput(await c.req.json().catch(() => null)));
  if (!parsed.success) return invalid(c, parsed.error);
  const db = getDb();
  const d = parsed.data;
  if (d.slug) {
    const clash = (await db.select().from(schema.projects).where(eq(schema.projects.slug, d.slug)))[0];
    if (clash && clash.id !== c.req.param("id")) return c.json({ error: "slug_taken" }, 409);
  }
  const current = (
    await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, c.req.param("id")))
  )[0];
  if (!current) return c.json({ error: "not_found" }, 404);
  // An editor changing the handle makes it authoritative; re-saving an unchanged auto-detected one doesn't.
  const handleChanged = d.xHandle !== undefined && (d.xHandle ?? null)?.toLowerCase() !== current.xHandle?.toLowerCase();
  // Changing what the knowledge base reads makes it stale, so the next evaluation rebuilds it.
  const same = (a: unknown, b: unknown) => stableJson(a ?? null) === stableJson(b ?? null);
  const sourcesChanged =
    handleChanged ||
    (["githubRepos", "docsUrl", "docsRoots", "newsAliases", "extraDomains", "websiteUrl", "l2beatSlug", "defillamaSlug"] as const).some(
      (k) => d[k] !== undefined && !same(d[k], current[k]),
    );
  await db
    .update(schema.projects)
    .set({
      ...d,
      ...(handleChanged ? { xHandleSource: d.xHandle ? "admin" : null } : {}),
      ...(sourcesChanged ? { kbRefreshedAt: null } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.projects.id, current.id));
  // Archiving or renaming changes what the public site shows.
  if ((d.status !== undefined && d.status !== current.status) || (d.name !== undefined && d.name !== current.name)) bumpSnapshots();
  return c.json({ ok: true });
});

// ---------- knowledge base ----------

async function kbSummary(projectId: string) {
  const db = getDb();
  const p = (await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)))[0];
  if (!p) return null;
  // content_len, not length(content_md): the summary must not read every document (R3-REL-10).
  const byKind = await db
    .select({ kind: schema.sources.kind, n: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(content_len),0)` })
    .from(schema.sources)
    .where(and(eq(schema.sources.projectId, projectId), eq(schema.sources.origin, "kb")))
    .groupBy(schema.sources.kind);
  // A "refreshing" status with nothing in flight was left by a process that stopped mid-refresh.
  const inFlight = isKbRefreshing(projectId);
  const orphaned = !inFlight && p.kbStatus === "refreshing";
  return {
    status: inFlight ? "refreshing" : orphaned ? "error" : p.kbStatus,
    stats: p.kbStats,
    refreshedAt: p.kbRefreshedAt,
    versionId: p.kbVersionId,
    error: orphaned ? (p.kbError ?? "Interrupted by a restart") : p.kbError,
    byKind,
    integrations: { github: !!env.githubToken, exa: hasExa(), news: hasNews(), x: hasX() },
    xHandle: p.xHandle,
    xHandleSource: p.xHandleSource,
    lanes: ((p.kbMeta ?? {}) as KbMeta).lanes ?? {},
    suggestions: ((p.kbMeta ?? {}) as KbMeta).suggestions ?? {},
    repos: ((p.kbMeta ?? {}) as KbMeta).repos ?? [],
  };
}

adminRoutes.get("/projects/:id/kb", async (c) => {
  const kb = await kbSummary(c.req.param("id"));
  return kb ? c.json(kb) : c.json({ error: "not_found" }, 404);
});

adminRoutes.post("/projects/:id/kb/refresh", async (c) => {
  const id = c.req.param("id");
  const db = getDb();
  if (!(await db.select().from(schema.projects).where(eq(schema.projects.id, id)))[0]) return c.json({ error: "not_found" }, 404);
  const body = z.object({ versionId: z.string().nullable().optional() }).safeParse(await c.req.json().catch(() => ({})));
  const versionId = body.success ? (body.data.versionId ?? null) : null;
  if (env.kbBuild === "local") {
    const p = (await db.select({ slug: schema.projects.slug }).from(schema.projects).where(eq(schema.projects.id, id)))[0]!;
    const v = versionId
      ? (
          await db
            .select({ tag: schema.projectVersions.tag, version: schema.projectVersions.version })
            .from(schema.projectVersions)
            .where(eq(schema.projectVersions.id, versionId))
        )[0]
      : undefined;
    return c.json(
      {
        error: "kb_built_locally",
        message: `Knowledge bases are built locally, with every lane: run \`railway run --service bench-cli -- pnpm bench kb ${p.slug}${v ? ` --version ${v.tag ?? v.version}` : ""}\` from the repository. It writes to this database directly.`,
      },
      409,
    );
  }
  if (isKbRefreshing(id)) return c.json({ ok: true, alreadyRunning: true });
  // An evaluation of this project is reading the knowledge base: a refresh would prune or swap sources under it (R4-7).
  if (await projectBusy(getDb(), id))
    return c.json({ error: "project_busy", message: "An evaluation of this project is running. Refresh the knowledge base after it finishes." }, 409);
  refreshKnowledgeBase(db, id, { versionId, progress: (m) => console.log(`[kb ${id}] ${m}`) })
    .then(() => syncEvidenceClasses(db))
    .catch((e) => console.error(`[kb ${id}] failed: ${(e as Error).message}`));
  return c.json({ ok: true });
});

adminRoutes.get("/projects/:id/kb/search", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const kind = c.req.query("kind");
  if (!q) return c.json({ hits: [] });
  return c.json({ hits: await searchSources(getDb(), c.req.param("id"), q, { kinds: kind ? [kind] : [], limit: 25 }) });
});

// ---------- sources ----------

const sourceSchema = z.union([
  z.object({
    type: z.literal("url"),
    url: httpUrlSchema,
    kind: z.string().default("docs"),
    sourceClass: z.enum(["code_onchain", "independent", "official_docs", "third_party", "marketing"]).default("official_docs"),
  }),
  z.object({
    type: z.literal("note"),
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(2_000_000),
    sourceClass: z.enum(["code_onchain", "independent", "official_docs", "third_party", "marketing"]).default("independent"),
  }),
]);

adminRoutes.post("/projects/:id/sources", async (c) => {
  const parsed = sourceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error);
  const db = getDb();
  const projectId = c.req.param("id");
  // Before fetching anything: an unknown project is a 404, not a fetch followed by a foreign-key failure.
  if (!(await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)))[0])
    return c.json({ error: "not_found" }, 404);
  const d = parsed.data;
  try {
    if (d.type === "url") {
      const page = await fetchPage(d.url);
      const existing = (
        await db
          .select()
          .from(schema.sources)
          .where(and(eq(schema.sources.projectId, projectId), eq(schema.sources.url, page.url)))
      )[0];
      const values = {
        title: page.title,
        kind: d.kind,
        sourceClass: d.sourceClass,
        contentMd: page.markdown,
        contentHash: page.hash,
        httpStatus: page.status,
        origin: "admin",
        fetchedAt: new Date().toISOString(),
      };
      if (existing) await db.update(schema.sources).set(values).where(eq(schema.sources.id, existing.id));
      else await db.insert(schema.sources).values({ id: newId(), projectId, url: page.url, ...values });
      return c.json({ ok: true, title: page.title, chars: page.markdown.length });
    }
    const id = newId();
    await db
      .insert(schema.sources)
      .values({ id, projectId, url: `note://${id}`, title: d.title, kind: "editor_note", sourceClass: d.sourceClass, contentMd: d.content, origin: "admin" });
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ error: "fetch_failed", message: (e as Error).message }, 422);
  }
});

adminRoutes.patch("/sources/:id", async (c) => {
  const parsed = z
    .object({
      kind: z.string().max(40).optional(),
      sourceClass: z.enum(["code_onchain", "independent", "official_docs", "third_party", "marketing"]).optional(),
      title: z.string().max(300).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid" }, 400);
  await getDb()
    .update(schema.sources)
    .set({ ...parsed.data, origin: "admin" })
    .where(eq(schema.sources.id, c.req.param("id")));
  return c.json({ ok: true });
});

adminRoutes.delete("/sources/:id", async (c) => {
  const src = (
    await getDb()
      .select({ projectId: schema.sources.projectId })
      .from(schema.sources)
      .where(eq(schema.sources.id, c.req.param("id")))
  )[0];
  if (src && (await projectBusy(getDb(), src.projectId)))
    return c.json(
      { error: "project_busy", message: "An evaluation of this project is running and may be quoting this source. Try again after it finishes." },
      409,
    );
  await getDb()
    .delete(schema.sources)
    .where(eq(schema.sources.id, c.req.param("id")));
  return c.json({ ok: true });
});

// ---------- versions ----------

adminRoutes.get("/updates", async (c) => {
  const db = getDb();
  const rows = await db
    .select({ v: schema.projectVersions, projectName: schema.projects.name, projectSlug: schema.projects.slug })
    .from(schema.projectVersions)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectVersions.projectId))
    .where(c.req.query("all") ? undefined : eq(schema.projectVersions.status, "detected"))
    .orderBy(desc(schema.projectVersions.createdAt))
    .limit(200);
  return c.json(rows.map((r) => ({ ...r.v, projectName: r.projectName, projectSlug: r.projectSlug })));
});

const manualVersionSchema = z.object({
  label: z.string().min(1).max(80),
  version: z.string().max(64).optional(),
  releasedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  sourceUrl: httpUrlSchema.nullable().optional(),
  isMajor: z.boolean().default(true),
  summary: z.string().max(2000).default(""),
  notesMd: z.string().max(10000).default(""),
  privacyRelevant: z.boolean().default(true),
  affectedSuites: z.array(z.string()).default([]),
  status: z.enum(["tracked", "detected", "ignored"]).default("tracked"),
});

adminRoutes.post("/projects/:id/versions", async (c) => {
  const parsed = manualVersionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error);
  const db = getDb();
  const d = parsed.data;
  const version = normalizeVersion(d.version || d.label);
  const projectId = c.req.param("id");
  if (
    (
      await db
        .select()
        .from(schema.projectVersions)
        .where(and(eq(schema.projectVersions.projectId, projectId), eq(schema.projectVersions.version, version)))
    )[0]
  ) {
    return c.json({ error: "version_exists" }, 409);
  }
  const id = newId();
  await db.insert(schema.projectVersions).values({
    id,
    projectId,
    version,
    label: d.label,
    releasedAt: d.releasedAt ?? null,
    source: "manual",
    sourceUrl: d.sourceUrl ?? null,
    isMajor: d.isMajor,
    status: d.status,
    summary: d.summary,
    notesMd: d.notesMd,
    privacyRelevant: d.privacyRelevant,
    affectedSuites: d.affectedSuites,
  });
  return c.json({ id, version });
});

adminRoutes.post("/projects/:id/versions/check", async (c) => {
  try {
    const r = await checkProjectVersions(getDb(), c.req.param("id"));
    return c.json({ ...r, usage: { costUsd: r.usage.costUsd, calls: r.usage.calls } });
  } catch (e) {
    return c.json({ error: "check_failed", message: (e as Error).message }, 422);
  }
});

adminRoutes.post("/versions/check-all", async (c) => {
  const results = await checkAllVersions(getDb());
  console.log(`[versions] manual check: ${summarizeChecks(results)}`);
  return c.json({
    projects: results.length,
    newVersions: results.reduce((s, r) => s + r.newVersions, 0),
    triaged: results.reduce((s, r) => s + r.triaged, 0),
    errors: results.flatMap((r) => r.errors),
    costUsd: results.reduce((s, r) => s + r.usage.costUsd, 0),
  });
});

adminRoutes.patch("/versions/:id", async (c) => {
  const parsed = manualVersionSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid" }, 400);
  const { version: _ignored, ...rest } = parsed.data;
  await getDb()
    .update(schema.projectVersions)
    .set(rest)
    .where(eq(schema.projectVersions.id, c.req.param("id")));
  return c.json({ ok: true });
});

// An editor confirms what a version actually runs (JDG-32); every stage's prompt names these contracts, and
// onchain reads or code for anything else count only as context.
const deploymentSchema = z.object({
  status: z.enum(["mainnet", "testnet", "not_deployed"]),
  contracts: z
    .array(
      z.object({
        chain: z
          .string()
          .trim()
          .regex(/^[a-z0-9][a-z0-9-]{0,39}$/i, "Chain: an id like 1 or a network name like aztec"),
        address: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9_:.-]{3,130}$/, "Address: letters, digits and 0x only"),
        label: z.string().trim().max(120).default(""),
      }),
    )
    .max(60),
  note: z.string().trim().max(1000).default(""),
});

adminRoutes.put("/versions/:id/deployment", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const db = getDb();
  if (body === null) {
    const res = await db
      .update(schema.projectVersions)
      .set({ deployment: null })
      .where(eq(schema.projectVersions.id, c.req.param("id")))
      .returning({ id: schema.projectVersions.id });
    return res.length ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  }
  const parsed = deploymentSchema.safeParse(body);
  if (!parsed.success) return invalid(c, parsed.error);
  if (parsed.data.status !== "not_deployed" && !parsed.data.contracts.length && !parsed.data.note)
    return c.json({ error: "invalid", message: "List the deployed contracts, or explain in the note why there are none to list." }, 400);
  const deployment = { ...parsed.data, confirmedAt: new Date().toISOString() };
  const res = await db
    .update(schema.projectVersions)
    .set({ deployment })
    .where(eq(schema.projectVersions.id, c.req.param("id")))
    .returning({ id: schema.projectVersions.id });
  return res.length ? c.json({ ok: true, deployment }) : c.json({ error: "not_found" }, 404);
});

/** Addresses the knowledge base's registry found (L2BEAT, docs, deployment files), to start a deployment record from. */
adminRoutes.get("/projects/:id/deployment-suggestions", async (c) => {
  const rows = await query<{ chain: string | null; address: string; label: string; verified: boolean }>(
    getDb(),
    sql`SELECT meta->>'chainId' AS chain, meta->>'address' AS address,
              max(coalesce(meta->>'contract', '')) AS label, bool_or((meta->'verified') IS NOT NULL) AS verified
       FROM sources
       WHERE project_id = ${c.req.param("id")} AND (meta->>'address') IS NOT NULL AND NOT coalesce(meta->'stale' = 'true'::jsonb, false)
       GROUP BY 1, 2 ORDER BY verified DESC, (meta->>'chainId') = '1' DESC LIMIT 80`,
  );
  return c.json(rows.map((r) => ({ chain: r.chain === null ? "" : String(r.chain), address: r.address, label: r.label, verified: !!r.verified })));
});

adminRoutes.delete("/versions/:id", async (c) => {
  const v = (
    await getDb()
      .select({ projectId: schema.projectVersions.projectId })
      .from(schema.projectVersions)
      .where(eq(schema.projectVersions.id, c.req.param("id")))
  )[0];
  if (v && (await projectBusy(getDb(), v.projectId)))
    return c.json({ error: "project_busy", message: "An evaluation of this project is running. Try again after it finishes." }, 409);
  await getDb()
    .delete(schema.projectVersions)
    .where(eq(schema.projectVersions.id, c.req.param("id")));
  return c.json({ ok: true });
});

adminRoutes.post("/versions/summarize", async (c) => {
  const parsed = z.object({ url: httpUrlSchema, projectId: z.string() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid" }, 400);
  if (!hasApiKey()) return c.json({ error: "no_api_key", message: "Set ANTHROPIC_API_KEY to summarize announcements with Haiku." }, 503);
  const project = (await getDb().select().from(schema.projects).where(eq(schema.projects.id, parsed.data.projectId)))[0];
  if (!project) return c.json({ error: "not_found" }, 404);
  try {
    const r = await summarizeAnnouncement(project.name, parsed.data.url);
    return c.json({ ...r.assessment, title: r.title, costUsd: r.usage.costUsd });
  } catch (e) {
    return c.json({ error: "summarize_failed", message: (e as Error).message }, 422);
  }
});

// ---------- runs ----------

const runSchema = z.object({
  projectIds: z.array(z.string()).min(1).max(50),
  versions: z.record(z.string(), z.string().nullable()).optional(),
  mode: z.enum(["quick", "standard", "deep"]).default("deep"),
  suites: z.array(z.string()).optional(),
  label: z.string().max(120).optional(),
  /** The weighting to score with (id or "W2"); the current one when omitted. */
  weightingId: z.string().max(64).optional(),
});

adminRoutes.post("/runs", async (c) => {
  const parsed = runSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error);
  const db = getDb();
  const known = new Set(
    (await db.select({ id: schema.projects.id }).from(schema.projects).where(inArray(schema.projects.id, parsed.data.projectIds))).map((p) => p.id),
  );
  const unknown = parsed.data.projectIds.filter((id) => !known.has(id));
  if (unknown.length) return c.json({ error: "unknown_projects", message: `Unknown project id(s): ${unknown.slice(0, 5).join(", ")}` }, 422);
  try {
    const weighting = await usableWeighting(db, parsed.data.weightingId);
    return c.json({ id: await enqueueRun(db, { ...parsed.data, weightingId: weighting.id }) });
  } catch (e) {
    return c.json({ error: "enqueue_failed", message: (e as Error).message }, 422);
  }
});

adminRoutes.get("/runs", async (c) => {
  const db = getDb();
  const runs = await db.select().from(schema.runs).orderBy(desc(schema.runs.createdAt)).limit(100);
  const evs = runs.length
    ? await db
        .select({
          id: schema.evaluations.id,
          runId: schema.evaluations.runId,
          status: schema.evaluations.status,
          stage: schema.evaluations.stage,
          costUsd: schema.evaluations.costUsd,
          projectName: schema.projects.name,
          projectSlug: schema.projects.slug,
        })
        .from(schema.evaluations)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.evaluations.projectId))
        .where(
          inArray(
            schema.evaluations.runId,
            runs.map((r) => r.id),
          ),
        )
    : [];
  const byRun = groupBy(evs, (e) => e.runId);
  return c.json(runs.map((r) => ({ ...r, evaluations: (byRun.get(r.id) ?? []).map(({ runId: _r, ...e }) => e) })));
});

adminRoutes.get("/runs/:id", async (c) => {
  const db = getDb();
  const run = (
    await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, c.req.param("id")))
  )[0];
  if (!run) return c.json({ error: "not_found" }, 404);
  const evs = await db
    .select({
      e: schema.evaluations,
      name: schema.projects.name,
      slug: schema.projects.slug,
      logoUrl: schema.projects.logoUrl,
      version: schema.projectVersions.label,
    })
    .from(schema.evaluations)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.evaluations.projectId))
    .leftJoin(schema.projectVersions, eq(schema.projectVersions.id, schema.evaluations.versionId))
    .where(eq(schema.evaluations.runId, run.id));
  const events = (await db.select().from(schema.runEvents).where(eq(schema.runEvents.runId, run.id)).orderBy(desc(schema.runEvents.id)).limit(400)).reverse();
  return c.json({
    run,
    evaluations: evs.map((x) => ({ ...x.e, settings: undefined, projectName: x.name, projectSlug: x.slug, logoUrl: x.logoUrl, versionLabel: x.version })),
    events,
  });
});

adminRoutes.post("/runs/:id/cancel", async (c) => {
  await cancelRun(getDb(), c.req.param("id"));
  return c.json({ ok: true });
});

const SSE_HEARTBEAT_MS = 15_000;

adminRoutes.get("/runs/:id/events", (c) => {
  const runId = c.req.param("id");
  return streamSSE(c, async (stream) => {
    const queue: unknown[] = [];
    let wake: (() => void) | null = null;
    const onEvent = (ev: unknown) => {
      queue.push(ev);
      wake?.();
    };
    bus.on(`run:${runId}`, onEvent);
    let alive = true;
    stream.onAbort(() => {
      alive = false;
      bus.off(`run:${runId}`, onEvent);
      wake?.();
    });
    // Events are written as they arrive; a heartbeat every 15 s keeps idle proxies from closing the stream (EFF-26).
    await stream.writeSSE({ event: "ping", data: "" });
    while (alive) {
      while (queue.length && alive) await stream.writeSSE({ event: "event", data: JSON.stringify(queue.shift()) });
      if (!alive) break;
      const idle = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), SSE_HEARTBEAT_MS);
        wake = () => {
          clearTimeout(timer);
          resolve(false);
        };
      });
      wake = null;
      if (idle && alive) await stream.writeSSE({ event: "ping", data: "" });
    }
  });
});

// ---------- evaluations & review ----------

adminRoutes.get("/evaluations/:id", async (c) => {
  const db = getDb();
  const bundle = await loadEvaluation(db, c.req.param("id"));
  if (!bundle) return c.json({ error: "not_found" }, 404);
  const answers = answerMapFor(bundle);
  // Scored with the evaluation's own weighting: the numbers its release would publish.
  const scores = scoreProject(answers, bundle.weighting.config);
  const allSources = await db
    .select({
      id: schema.sources.id,
      url: schema.sources.url,
      title: schema.sources.title,
      kind: schema.sources.kind,
      sourceClass: schema.sources.sourceClass,
      date: schema.sources.date,
    })
    .from(schema.sources)
    .where(eq(schema.sources.projectId, bundle.project.id));
  const published = (
    await db
      .select()
      .from(schema.publishedResults)
      .where(and(eq(schema.publishedResults.projectId, bundle.project.id), eq(schema.publishedResults.active, true)))
      .orderBy(desc(schema.publishedResults.createdAt))
  )[0];
  const events = (
    await db.select().from(schema.runEvents).where(eq(schema.runEvents.evaluationId, bundle.evaluation.id)).orderBy(desc(schema.runEvents.id)).limit(300)
  ).reverse();
  return c.json({
    evaluation: bundle.evaluation,
    project: bundle.project,
    version: bundle.version,
    results: bundle.results,
    evidence: bundle.evidence,
    sources: allSources,
    scores,
    weighting: bundle.weighting.ref,
    publishedOverall: published?.overall ?? null,
    publishedCriteria: (published?.snapshot as { criteria?: unknown } | undefined)?.criteria ?? null,
    coverage: bundle.evaluation.isDemo ? null : await evidenceCoverage(db, bundle.evaluation.id),
    events,
  });
});

adminRoutes.get("/evaluations", async (c) => {
  const db = getDb();
  const status = c.req.query("status");
  const rows = await db
    .select({
      e: evaluationListColumns,
      name: schema.projects.name,
      slug: schema.projects.slug,
      logoUrl: schema.projects.logoUrl,
      version: schema.projectVersions.label,
    })
    .from(schema.evaluations)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.evaluations.projectId))
    .leftJoin(schema.projectVersions, eq(schema.projectVersions.id, schema.evaluations.versionId))
    .where(status ? eq(schema.evaluations.status, status) : undefined)
    .orderBy(desc(schema.evaluations.createdAt))
    .limit(200);
  // Flag counts for the listed evaluations only, via the (evaluation_id, criterion_id) unique index.
  const flagged = new Map(
    rows.length
      ? (
          await db
            .select({
              evaluationId: schema.criterionResults.evaluationId,
              // Informational flags (skeptic checked, editor adjusted) don't need review.
              n: sql<number>`sum(case when override_status is null and exists (select 1 from jsonb_array_elements_text(flags) AS f(value) where f.value not in ${sql.raw(INFO_FLAG_SQL)}) then 1 else 0 end)`,
            })
            .from(schema.criterionResults)
            .where(
              inArray(
                schema.criterionResults.evaluationId,
                rows.map((r) => r.e.id),
              ),
            )
            .groupBy(schema.criterionResults.evaluationId)
        ).map((f) => [f.evaluationId, f.n])
      : [],
  );
  const summaries = await summaryStates(
    db,
    rows.filter((r) => ["review", "reviewed"].includes(r.e.status)).map((r) => r.e.id),
  );
  const labels = new Map((await db.select().from(schema.weightings)).map((w) => [w.id, weightingRef(w)]));
  const base = await weightingFor(db, null);
  return c.json(
    rows.map((r) => ({
      ...r.e,
      projectName: r.name,
      projectSlug: r.slug,
      logoUrl: r.logoUrl,
      versionLabel: r.version,
      weighting: (r.e.weightingId ? labels.get(r.e.weightingId) : null) ?? base.ref,
      flagged: flagged.get(r.e.id) ?? 0,
      // For evaluations that can be published: whether their summary can go out as it is.
      summary: summaries.get(r.e.id) ?? null,
    })),
  );
});

// ---------- evaluation state guards (R3-REL-16) ----------

/** Evaluations whose summary is being regenerated right now (a second click, or a rerun meanwhile, waits). */
const summarizing = new Set<string>();

const evaluationState = async (id: string) =>
  (
    await getDb()
      .select({ id: schema.evaluations.id, status: schema.evaluations.status, isDemo: schema.evaluations.isDemo })
      .from(schema.evaluations)
      .where(eq(schema.evaluations.id, id))
  )[0];

/**
 * 409 while this process is still running the evaluation, whatever its status says: a failed or cancelled
 * evaluation's sibling suites can still be inside model calls (R3-REL-2), and a second runner would race them.
 */
function busy(c: Context, id: string) {
  if (isRunning(id))
    return c.json(
      { error: "still_stopping", message: "This evaluation is still stopping: its last model calls haven't returned. Try again in a minute." },
      409,
    );
  if (summarizing.has(id)) return c.json({ error: "summarizing", message: "The summary is being regenerated. Try again when it's done." }, 409);
  return null;
}

adminRoutes.post("/evaluations/:id/rerun", async (c) => {
  const parsed = z.object({ suites: z.array(z.string()).min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid" }, 400);
  const picked = parsed.data.suites.filter((s) => suites.some((x) => x.id === s));
  if (!picked.length) return c.json({ error: "invalid", message: "No known suites to re-run." }, 400);
  const ev = await evaluationState(c.req.param("id"));
  if (!ev) return c.json({ error: "not_found" }, 404);
  if (ev.isDemo) return c.json({ error: "not_rerunnable", message: "Demo evaluations are hand-labelled and can't be re-run." }, 409);
  if (!RERUNNABLE.includes(ev.status))
    return c.json(
      {
        error: "not_rerunnable",
        message: `Only evaluations in review, reviewed, failed or cancelled can be re-run (this one is ${ev.status}). To re-evaluate a published result, start a new evaluation.`,
      },
      409,
    );
  const blocked = busy(c, ev.id);
  if (blocked) return blocked;
  if (!hasApiKey()) return c.json({ error: "no_api_key", message: "Set ANTHROPIC_API_KEY to re-run suites." }, 503);
  await rerunSuites(getDb(), ev.id, picked);
  return c.json({ ok: true });
});

adminRoutes.post("/evaluations/:id/summarize", async (c) => {
  const db = getDb();
  const ev = await evaluationState(c.req.param("id"));
  if (!ev) return c.json({ error: "not_found" }, 404);
  // The pipeline writes the summary itself; a second writer would race it.
  if (ev.status === "queued" || ev.status === "running" || isRunning(ev.id))
    return c.json({ error: "busy", message: "The pipeline is still working on this evaluation. Regenerate the summary once it's in review." }, 409);
  if (summarizing.has(ev.id)) return c.json({ error: "summarizing", message: "The summary is already being regenerated." }, 409);
  if (!hasApiKey()) return c.json({ error: "no_api_key", message: "Set ANTHROPIC_API_KEY to regenerate summaries." }, 503);
  const usage = emptyUsage();
  summarizing.add(ev.id);
  try {
    // summarize() reports a summary it couldn't ground (cut off, or not resting on established answers) as false.
    if (!(await summarize(db, ev.id, usage)))
      return c.json({ error: "summary_failed", message: "Couldn't write a grounded summary from the established answers. Try again." }, 502);
  } catch (e) {
    return c.json({ error: "summary_failed", message: (e as Error).message }, 502);
  } finally {
    summarizing.delete(ev.id);
    // Added in SQL, not read-modify-write around the await: the pipeline or another request may have spent meanwhile.
    // Spend from a failed attempt counts too.
    if (usage.costUsd > 0)
      await db
        .update(schema.evaluations)
        .set({ costUsd: sql`${schema.evaluations.costUsd} + ${usage.costUsd}` })
        .where(eq(schema.evaluations.id, ev.id));
  }
  return c.json({ ok: true, costUsd: usage.costUsd });
});

adminRoutes.post("/evaluations/:id/resume", async (c) => {
  const ev = await evaluationState(c.req.param("id"));
  if (!ev) return c.json({ error: "not_found" }, 404);
  if (!["failed", "cancelled"].includes(ev.status))
    return c.json({ error: "cannot_resume", message: `Only failed or cancelled evaluations can be resumed (this one is ${ev.status}).` }, 409);
  const blocked = busy(c, ev.id);
  if (blocked) return blocked;
  if (!hasApiKey()) return c.json({ error: "no_api_key", message: "Set ANTHROPIC_API_KEY to resume evaluations." }, 503);
  try {
    await resumeEvaluation(getDb(), c.req.param("id"));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: "cannot_resume", message: (e as Error).message }, 409);
  }
});

adminRoutes.post("/evaluations/:id/cancel", async (c) => {
  await cancelEvaluation(getDb(), c.req.param("id"));
  return c.json({ ok: true });
});

/** True when the evaluation's summary was written after this override was made (so it describes the override). */
async function summaryAfterOverride(evaluationId: string, overriddenAt: string | null): Promise<boolean> {
  const summaryAt = (await getDb().select({ at: schema.evaluations.summaryAt }).from(schema.evaluations).where(eq(schema.evaluations.id, evaluationId)))[0]?.at;
  return !!summaryAt && !!overriddenAt && summaryAt >= overriddenAt;
}

adminRoutes.patch("/evaluations/:id/criteria/:criterionId", async (c) => {
  const db = getDb();
  // A decision made while the pipeline still runs would be undone by its re-judge or review flags (R4-26).
  const state = await evaluationState(c.req.param("id"));
  if (state && (state.status === "queued" || state.status === "running" || isRunning(state.id)))
    return c.json({ error: "busy", message: "The pipeline is still working on this evaluation. Review it once it's done." }, 409);
  const criterionId = c.req.param("criterionId");
  const crit = findCriterion(criterionId);
  if (!crit) return c.json({ error: "unknown_criterion" }, 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const r = (
    await db
      .select()
      .from(schema.criterionResults)
      .where(and(eq(schema.criterionResults.evaluationId, c.req.param("id")), eq(schema.criterionResults.criterionId, criterionId)))
  )[0];
  if (!r) return c.json({ error: "not_found" }, 404);
  if (body?.clear) {
    await db
      .update(schema.criterionResults)
      // A summary regenerated after the override describes it; clearing the override makes that summary stale (R5-6).
      // One written before the override describes the restored answer and stays valid.
      .set({
        overrideStatus: null,
        overrideOptionId: null,
        overrideReason: null,
        overriddenAt: null,
        ...((await summaryAfterOverride(c.req.param("id"), r.overriddenAt)) ? { updatedAt: new Date().toISOString() } : {}),
      })
      .where(eq(schema.criterionResults.id, r.id));
    return c.json({ ok: true });
  }
  if (body?.accept) {
    // Accepting keeps the judge's answer and clears its review flags. A reason is optional: it's kept as the reviewer's note.
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    await db
      .update(schema.criterionResults)
      .set({ ...acceptChanges(r), ...(reason ? { reviewNote: reason.slice(0, 1000) } : {}) })
      .where(eq(schema.criterionResults.id, r.id));
    return c.json({ ok: true });
  }
  const parsed = overrideSchema.safeParse(body);
  if (!parsed.success) return invalid(c, parsed.error);
  const d = parsed.data;
  if (d.status === "answered" && !crit.options.some((o) => o.id === d.optionId)) return c.json({ error: "invalid_option" }, 400);
  if (d.status === "not_applicable" && !crit.naAllowed) return c.json({ error: "na_not_allowed" }, 400);
  await db
    .update(schema.criterionResults)
    .set({
      overrideStatus: d.status,
      overrideOptionId: d.status === "answered" ? d.optionId : null,
      overrideReason: d.reason,
      overriddenAt: new Date().toISOString(),
    })
    .where(eq(schema.criterionResults.id, r.id));
  return c.json({ ok: true });
});

/**
 * Accepting a result: its blocking flags are cleared (informational ones stay) and recorded as accepted for this exact
 * answer, so a rerun that changes the answer raises them again while one that keeps it doesn't (R5-3).
 */
function acceptChanges(r: typeof schema.criterionResults.$inferSelect) {
  const blocking = r.flags.filter((f) => !INFO_FLAGS.has(f as never));
  const earlier = r.acceptedFlags && r.acceptedFlags.status === r.status && r.acceptedFlags.optionId === r.optionId ? r.acceptedFlags.flags : [];
  return {
    flags: r.flags.filter((f) => INFO_FLAGS.has(f as never)),
    reviewedAt: new Date().toISOString(),
    acceptedFlags: { flags: [...new Set([...earlier, ...blocking])], status: r.status, optionId: r.optionId },
  };
}

/** Accepts every flagged answer of an evaluation that hasn't been overridden: the review page's "Accept all". */
adminRoutes.post("/evaluations/:id/accept-all", async (c) => {
  const db = getDb();
  const state = await evaluationState(c.req.param("id"));
  if (!state) return c.json({ error: "not_found" }, 404);
  if (state.status === "queued" || state.status === "running" || isRunning(state.id))
    return c.json({ error: "busy", message: "The pipeline is still working on this evaluation. Review it once it's done." }, 409);
  if (state.status === "published") return c.json({ error: "published", message: "This evaluation is published; its answers are frozen in the release." }, 409);
  const open = (await db.select().from(schema.criterionResults).where(eq(schema.criterionResults.evaluationId, state.id))).filter(
    (r) => !r.overrideStatus && r.flags.some((f) => !INFO_FLAGS.has(f as never)),
  );
  await db.transaction(async (tx) => {
    for (const r of open) await tx.update(schema.criterionResults).set(acceptChanges(r)).where(eq(schema.criterionResults.id, r.id));
  });
  return c.json({ ok: true, accepted: open.length });
});

adminRoutes.post("/evaluations/:id/reviewed", async (c) => {
  const suiteIds = suites.map((s) => s.id) as [string, ...string[]];
  const parsed = z.object({ suites: z.array(z.enum(suiteIds)).min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid" }, 400);
  const db = getDb();
  const ev = (
    await db
      .select()
      .from(schema.evaluations)
      .where(eq(schema.evaluations.id, c.req.param("id")))
  )[0];
  if (!ev) return c.json({ error: "not_found" }, 404);
  // Reviewed means reviewed after the pipeline finished (R5-7).
  if (ev.status === "queued" || ev.status === "running" || isRunning(ev.id))
    return c.json({ error: "busy", message: "The pipeline is still working on this evaluation. Mark suites reviewed once it's done." }, 409);
  const reviewed = [...new Set([...ev.reviewedSuites, ...parsed.data.suites])];
  const allReviewed = suites.every((s) => reviewed.includes(s.id));
  await db
    .update(schema.evaluations)
    .set({ reviewedSuites: reviewed, status: allReviewed && ev.status === "review" ? "reviewed" : ev.status })
    .where(eq(schema.evaluations.id, ev.id));
  return c.json({ ok: true, reviewedSuites: reviewed });
});

adminRoutes.get("/evaluations/:id/preview", async (c) => {
  const db = getDb();
  const bundle = await loadEvaluation(db, c.req.param("id"));
  if (!bundle) return c.json({ error: "not_found" }, 404);
  return c.json(
    buildSnapshot(bundle, {
      id: "preview",
      label: "Preview",
      publishedAt: new Date().toISOString(),
      isDemo: bundle.evaluation.isDemo,
      rubricVersion: rubric.version,
      weightingId: bundle.weighting.ref.id,
    }),
  );
});

/**
 * Re-scores an unpublished evaluation with another weighting. Only the scoring changes: answers, evidence, review
 * and summary stay as they are, so nothing needs reviewing again. Recorded in the evaluation's log.
 */
adminRoutes.patch("/evaluations/:id/weighting", async (c) => {
  const parsed = z.object({ weightingId: z.string().min(1).max(64) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid" }, 400);
  const db = getDb();
  const ev = (
    await db
      .select()
      .from(schema.evaluations)
      .where(eq(schema.evaluations.id, c.req.param("id")))
  )[0];
  if (!ev) return c.json({ error: "not_found" }, 404);
  if (!RERUNNABLE.includes(ev.status))
    return c.json({ error: "not_rescorable", message: `Only an unpublished, finished evaluation can be re-scored (this one is ${ev.status}).` }, 409);
  let to: Awaited<ReturnType<typeof usableWeighting>>;
  try {
    to = await usableWeighting(db, parsed.data.weightingId);
  } catch (e) {
    if (e instanceof PollError) return c.json({ error: e.code, message: e.message }, e.code === "not_found" ? 404 : 409);
    throw e;
  }
  const from = await weightingFor(db, ev.weightingId);
  if (from.row.id === to.id) return c.json({ ok: true, weighting: weightingRef(to) });
  // Re-checked in the write: a publish or rerun that commits meanwhile must not end up with another weighting.
  const [done] = await db
    .update(schema.evaluations)
    .set({ weightingId: to.id })
    .where(and(eq(schema.evaluations.id, ev.id), inArray(schema.evaluations.status, RERUNNABLE)))
    .returning({ id: schema.evaluations.id });
  if (!done) return c.json({ error: "not_rescorable", message: "The evaluation changed state meanwhile; reload and try again." }, 409);
  await db.insert(schema.runEvents).values({
    evaluationId: ev.id,
    runId: ev.runId,
    level: "info",
    stage: "score",
    message: `Re-scored with weighting W${to.number} (was ${from.ref.label})`,
    data: { from: from.row.id, to: to.id },
  });
  return c.json({ ok: true, weighting: weightingRef(to) });
});

// ---------- community weighting ----------

function pollErrorResponse(c: Context, e: unknown) {
  if (!(e instanceof PollError)) throw e;
  const status = e.code === "not_found" ? 404 : e.code === "invalid" || e.code === "x_unavailable" ? 422 : 409;
  return c.json({ error: e.code, message: e.message }, status);
}

adminRoutes.get("/weightings", async (c) => {
  const db = getDb();
  const list = await listWeightings(db);
  const evals = new Map(
    (
      await query<{ id: string; n: number }>(db, sql`SELECT weighting_id AS id, count(*)::int AS n FROM evaluations WHERE weighting_id IS NOT NULL GROUP BY 1`)
    ).map((r) => [r.id, Number(r.n)]),
  );
  return c.json(list.map((w) => ({ ...w, evaluations: evals.get(w.id) ?? 0 })));
});

adminRoutes.patch("/weightings/:id", async (c) => {
  const parsed = z.object({ retired: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid" }, 400);
  try {
    const row = await setRetired(getDb(), c.req.param("id"), parsed.data.retired);
    return c.json({ ok: true, retired: !!row.retiredAt });
  } catch (e) {
    return pollErrorResponse(c, e);
  }
});

const pollSchema = z.object({
  baseId: z.string().max(64).optional(),
  title: z.string().trim().max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  /** One ballot per X account. Off only where X sign-in isn't configured (development). */
  requireX: z.boolean().optional(),
  minBallots: z.number().int().min(1).max(100_000).optional(),
});

adminRoutes.get("/polls", async (c) => {
  const db = getDb();
  const rows = await db.select().from(schema.weightingPolls).orderBy(desc(schema.weightingPolls.createdAt)).limit(50);
  return c.json({ xEnabled: xAuthEnabled(), polls: await Promise.all(rows.map((p) => pollInfo(db, p))) });
});

adminRoutes.post("/polls", async (c) => {
  const parsed = pollSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(c, parsed.error);
  const requireX = parsed.data.requireX ?? xAuthEnabled();
  if (requireX && !xAuthEnabled())
    return c.json({ error: "x_unavailable", message: "Sign in with X isn't configured: set X_OAUTH_CLIENT_ID (and its secret) on the server." }, 422);
  try {
    const poll = await openPoll(getDb(), { ...parsed.data, requireX });
    return c.json(await pollInfo(getDb(), poll));
  } catch (e) {
    return pollErrorResponse(c, e);
  }
});

adminRoutes.get("/polls/:id", async (c) => {
  const db = getDb();
  const poll = await pollById(db, c.req.param("id"));
  if (!poll) return c.json({ error: "not_found" }, 404);
  const info = await pollInfo(db, poll);
  // A closed poll's turnout is stored; an open one's is computed now, with the result it would have.
  const preview = poll.status === "open" ? await pollPreview(db, poll) : null;
  return c.json({
    ...info,
    stats: preview?.stats ?? poll.stats,
    networks: preview?.networks ?? null,
    quorum: preview?.quorum ?? null,
    changes: preview?.changes ?? null,
  });
});

adminRoutes.post("/polls/:id/cancel", async (c) => {
  try {
    await cancelPoll(getDb(), c.req.param("id"));
    return c.json({ ok: true });
  } catch (e) {
    return pollErrorResponse(c, e);
  }
});

// ---------- releases ----------

adminRoutes.get("/releases", async (c) => {
  const db = getDb();
  const rows = await db.select().from(schema.releases).orderBy(desc(schema.releases.publishedAt));
  const results = groupBy(
    await db
      .select({
        releaseId: schema.publishedResults.releaseId,
        projectId: schema.publishedResults.projectId,
        active: schema.publishedResults.active,
        overall: schema.publishedResults.overall,
        name: schema.projects.name,
        versionId: schema.publishedResults.versionId,
      })
      .from(schema.publishedResults)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.publishedResults.projectId)),
    (x) => x.releaseId,
  );
  const refs = new Map((await db.select().from(schema.weightings)).map((w) => [w.id, weightingRef(w)]));
  return c.json(
    rows.map(({ evalSettings: _settings, ...r }) => ({
      ...r,
      weighting: r.weightingId ? (refs.get(r.weightingId) ?? null) : null,
      results: results.get(r.id) ?? [],
    })),
  );
});

adminRoutes.post("/releases", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = releaseRequestSchema.safeParse(body);
  if (!parsed.success) return invalid(c, parsed.error);
  const db = getDb();
  const ids = parsed.data.evaluationIds;
  if (new Set(ids).size !== ids.length) return c.json({ error: "duplicate_evaluations", message: "An evaluation is listed more than once." }, 409);
  const evs = await db.select().from(schema.evaluations).where(inArray(schema.evaluations.id, ids));
  const missing = ids.filter((id) => !evs.some((e) => e.id === id));
  if (missing.length) return c.json({ error: "unknown_evaluations", message: `Unknown evaluation(s): ${missing.slice(0, 5).join(", ")}` }, 409);
  // One result per project version per release: two would supersede each other inside the same publish.
  const versions = new Set(evs.map((e) => `${e.projectId}\u0000${e.versionId ?? ""}`));
  if (versions.size !== evs.length)
    return c.json({ error: "same_project_version", message: "Two of these evaluations are of the same project version. Pick one of them." }, 409);
  const notReady = evs.filter((e) => !["review", "reviewed", "published"].includes(e.status));
  if (notReady.length) return c.json({ error: "not_ready", message: `${notReady.length} evaluation(s) haven't finished.` }, 409);
  // A release is scored with one weighting: the leaderboard compares its results with each other.
  const weightingIds = new Set(await Promise.all(evs.map(async (e) => (await weightingFor(db, e.weightingId)).ref.label)));
  if (weightingIds.size > 1)
    return c.json(
      {
        error: "mixed_weightings",
        message: `These evaluations are scored with different weightings (${[...weightingIds].join(", ")}). Re-score them with one in review, or publish them separately.`,
      },
      409,
    );
  // Evidence takes its source's current class, and stored attestations on off-chain powers stop counting; answers
  // affected get flagged and block below (R4-8, R5-1, R5-14).
  await invalidateOffchainAttestations(db);
  for (const e of evs) if (!e.isDemo) await syncEvidenceClasses(db, { evaluationId: e.id });
  // Evidence coverage is a hard gate (force doesn't skip it): an evaluation with no evidence would publish
  // the riskiest answer for every criterion, which describes the evaluation, not the project.
  const thin: { e: (typeof evs)[number]; cov: Awaited<ReturnType<typeof evidenceCoverage>> }[] = [];
  for (const e of evs.filter((x) => !x.isDemo)) {
    const cov = await evidenceCoverage(db, e.id);
    if (cov.blocker) thin.push({ e, cov });
  }
  if (thin.length) {
    const names = new Map((await db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects)).map((p) => [p.id, p.name]));
    return c.json(
      { error: "insufficient_evidence", message: thin.map((x) => `${names.get(x.e.projectId) ?? x.e.projectId}: ${x.cov.blocker}`).join(" ") },
      409,
    );
  }
  // A partial (suite-filtered) evaluation renormalizes over the suites it covers; it can't stand alone publicly.
  const partial = evs.filter((e) => !e.isDemo && e.suiteFilter?.length);
  if (partial.length)
    return c.json({ error: "partial_evaluation", message: "Suite-filtered evaluations can't be published on their own; run every suite." }, 409);
  // The summary is the most-read text on the project page: a live evaluation can't publish without one, and it must
  // reflect the final answers.
  const summaries = await summaryStates(
    db,
    evs.filter((e) => !e.isDemo).map((e) => e.id),
  );
  if ([...summaries.values()].includes("missing"))
    return c.json({ error: "missing_summary", message: "An evaluation has no summary. Regenerate the summary before publishing." }, 409);
  if ([...summaries.values()].includes("stale"))
    return c.json({ error: "stale_summary", message: "Answers were overridden after the summary was written. Regenerate the summary before publishing." }, 409);
  // An answer citing evidence that no longer exists rests on nothing (R4-1).
  let dangling = false;
  for (const e of evs.filter((x) => !x.isDemo)) {
    // Decisive ids when the result has them; results from before decisive ids existed use their citations (R5-5).
    const [row] = await query(
      db,
      sql`SELECT 1 FROM criterion_results r,
           jsonb_array_elements_text(CASE WHEN jsonb_array_length(r.decisive_evidence_ids) > 0 THEN r.decisive_evidence_ids ELSE r.evidence_ids END) AS d(value)
         WHERE r.evaluation_id = ${e.id} AND r.status = 'answered' AND r.override_status IS NULL
           AND NOT EXISTS (SELECT 1 FROM evidence ev WHERE ev.id = d.value) LIMIT 1`,
    );
    if (row) {
      dangling = true;
      break;
    }
  }
  if (dangling)
    return c.json({ error: "evidence_missing", message: "An answer cites evidence that no longer exists. Re-run its suite, or override it in review." }, 409);
  // Block publishing while flagged criteria are unresolved (overrides or reasoned accepts clear them).
  const unresolved = (
    await db
      .select({ flags: schema.criterionResults.flags })
      .from(schema.criterionResults)
      .where(and(inArray(schema.criterionResults.evaluationId, parsed.data.evaluationIds), sql`override_status is null`))
  ).filter((r) => r.flags.some((f) => !INFO_FLAGS.has(f as never))).length;
  const force = c.req.query("force") === "1";
  const forceReason = typeof body?.forceReason === "string" ? body.forceReason.trim() : "";
  // Quick mode runs one judge vote and a short skeptic pass: fine for drafts, not for a public score by default.
  const quick = evs.filter((e) => !e.isDemo && e.mode === "quick").length;
  if (unresolved && !force) return c.json({ error: "unresolved_flags", message: `${unresolved} flagged criteria still need review.`, unresolved }, 409);
  if (quick && !force)
    return c.json(
      {
        error: "quick_mode",
        message: "Quick evaluations use one judge vote and a short skeptic pass. Run standard or deep mode, or publish with a written justification.",
      },
      409,
    );
  if ((unresolved || quick) && forceReason.length < 10)
    return c.json(
      { error: "reason_required", message: "Publishing past the review gates needs a written justification; it's published in the release notes." },
      400,
    );
  const exceptions = [
    unresolved ? `${unresolved} unresolved review flags` : null,
    quick ? `${quick} quick-mode evaluation${quick === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  const notes = exceptions.length ? `${parsed.data.notes}\n\nPublished with ${exceptions.join(" and ")}: ${forceReason}`.trim() : parsed.data.notes;
  try {
    const id = await publishRelease(db, { evaluationIds: parsed.data.evaluationIds, label: parsed.data.label, notes, isDemo: false });
    return c.json({ id });
  } catch (e) {
    return c.json({ error: "publish_failed", message: (e as Error).message }, 422);
  }
});

adminRoutes.post("/projects/:id/unpublish", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { versionId?: string | null };
  await unpublishProject(getDb(), c.req.param("id"), body.versionId ?? null);
  return c.json({ ok: true });
});

// ---------- corrections ----------

adminRoutes.get("/corrections", async (c) => c.json(await getDb().select().from(schema.corrections).orderBy(desc(schema.corrections.createdAt)).limit(200)));

// Every decision carries a public reason: the corrections log and release notes show it (JDG-38). Accepted
// corrections are applied by the next release that includes the project; "done" is for ones settled without one.
const correctionDecisionSchema = z.object({
  status: z.enum(["open", "accepted", "rejected", "done"]),
  note: z.string().trim().max(1000).optional(),
});

adminRoutes.patch("/corrections/:id", async (c) => {
  const parsed = correctionDecisionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid" }, 400);
  const { status, note } = parsed.data;
  if (status !== "open" && (!note || note.length < 10))
    return c.json({ error: "invalid", message: "Give a public reason for the decision (at least 10 characters). It appears in the corrections log." }, 400);
  const res = await getDb()
    .update(schema.corrections)
    .set(status === "open" ? { status, decisionNote: null, decidedAt: null } : { status, decisionNote: note, decidedAt: new Date().toISOString() })
    .where(eq(schema.corrections.id, c.req.param("id")))
    .returning({ id: schema.corrections.id });
  if (!res.length) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});
