/**
 * Project knowledge base: everything the evaluator should know about a project, ingested deterministically
 * (no LLM) and stored as full-text-indexed sources. Agents search and read it instead of browsing ad hoc.
 *
 * Lanes (each in services/lanes/*): docs (every docs root, one pooled budget, priority-ordered), website and blog,
 * code (tiered snapshot at the pinned version or latest stable release), releases, diffs and security advisories,
 * X announcements, news, independent analyses and incidents (Exa), audits (repo folders, DefiLlama links, PDF
 * search), L2BEAT and DefiLlama data and hacks, Discourse governance forums, a deployed-address registry with
 * Sourcify sources and onchain inspections, and the URLs editors pinned.
 *
 * Every URL is classified by who publishes it (services/classify.ts), a stronger lane owns a URL against weaker
 * ones, and each lane prunes the rows its last successful run didn't touch (services/kb-store.ts). A lane that
 * loses more than a tenth of its pages to fetch failures is marked partial and doesn't prune (R3-SRC-5); every
 * lane has a deadline and so does the whole refresh (R3-SEC-8).
 */
import { existsSync, statfsSync } from "node:fs";
import { resolve } from "node:path";
import { eq, type SQL, sql } from "drizzle-orm";
import type { DB } from "../db/index.ts";
import { pgliteDirOf, query, schema } from "../db/index.ts";
import { env } from "../env.ts";
import { hasExa, hasNews, hasX } from "../lib/externals.ts";
import { withFetchSignal } from "../lib/fetcher.ts";
import { GithubMemo } from "../lib/github.ts";
import { newId } from "../lib/ids.ts";
import { redact } from "../lib/redact.ts";
import { RUNNER_ID } from "../lib/runner.ts";
import { canonicalKey, createRegistry, registrableDomain } from "./classify.ts";
import { keepAlive, maintainAfterRefresh, pruneLane, purgeWhere, type Section, STALE } from "./kb-store.ts";
import { ingestAddressRegistry } from "./lanes/addresses.ts";
import { ingestAnalysesLane, pruneAnalyses } from "./lanes/analysis.ts";
import { ingestAudits } from "./lanes/audits.ts";
import { discoverRepos, ingestRepoAdvisories, ingestRepoChanges, ingestRepoCode, ingestRepoReleases, previousTagFor, repoBudgets } from "./lanes/code.ts";
import {
  interestedPartiesFor,
  type KbMeta,
  type LaneContext,
  type LaneStatus,
  mapLimit,
  type Progress,
  type ProjectRow,
  type RepoSuggestion,
  type RunShared,
} from "./lanes/context.ts";
import {
  type CrawlRoot,
  describeFetchStats,
  discoverDocsRoots,
  ingestBlog,
  ingestDocs,
  ingestWebsite,
  linkedForumHosts,
  linkedGithubOwners,
  linkedXHandles,
  probeSite,
} from "./lanes/crawl.ts";
import { defillamaProtocol, ingestDefillama, ingestHacks, ingestL2beat } from "./lanes/data.ts";
import { detectForums, ingestForums } from "./lanes/forum.ts";
import { ingestNewsLane, pruneNews } from "./lanes/news.ts";
import { ingestPinned } from "./lanes/pinned.ts";
import { ingestAnnouncements, purgeOtherAnnouncements, resolveXHandle } from "./lanes/x.ts";

export { classifyUrl } from "./classify.ts";
export type { KbSourceInput, Section, StoreStatus } from "./kb-store.ts";
export { LANE_RANK, pruneLane, storeKbSource, storeKbSourceEx } from "./kb-store.ts";
export type { KbMeta, LaneStatus, Progress, RepoSuggestion } from "./lanes/context.ts";
export { crawl, discoverDocsRoots } from "./lanes/crawl.ts";
export { handleConfidence } from "./lanes/x.ts";
export { ownershipFor } from "./ownership.ts";

export type KbStats = Partial<Record<Section, number>> & { bytes?: number; repos?: number; codeRef?: number };

// ---------- orchestration ----------

export function kbIsStale(project: ProjectRow, versionId: string | null): boolean {
  if (project.kbStatus !== "ready" || !project.kbRefreshedAt) return true;
  if ((project.kbVersionId ?? null) !== (versionId ?? null)) return true;
  return Date.now() - new Date(project.kbRefreshedAt).getTime() > env.kb.staleDays * 86_400_000;
}

/**
 * A refresh in progress, shared by every caller asking for the same project and version. It stops (its controller
 * aborts) only once every caller waiting on it has been aborted; a caller without a signal never is (R4-17).
 */
interface Inflight {
  versionId: string | null;
  promise: Promise<KbStats>;
  ctrl: AbortController;
  callers: number;
  stopped: number;
  unstoppable: boolean;
}

const inflight = new Map<string, Inflight>();

export function isKbRefreshing(projectId: string): boolean {
  return inflight.has(projectId);
}

/** A knowledge-base refresh stopped by its caller's signal (R4-17). `cause` is the signal's reason. */
export class KbRefreshAbortedError extends Error {
  override name = "KbRefreshAbortedError";
}

function refreshAborted(signal: AbortSignal): KbRefreshAbortedError {
  const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "aborted");
  return new KbRefreshAbortedError(`Knowledge-base refresh stopped: ${reason}`, { cause: signal.reason });
}

function throwIfRefreshAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw refreshAborted(signal);
}

/** `p`, or a rejection with KbRefreshAbortedError as soon as `signal` aborts (`p` itself carries on). */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(refreshAborted(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(refreshAborted(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** One caller's wait on a shared refresh: it stops waiting when its signal aborts, and the refresh stops with the last one. */
function joinRefresh(entry: Inflight, signal?: AbortSignal): Promise<KbStats> {
  entry.callers++;
  if (!signal) {
    entry.unstoppable = true;
    return entry.promise;
  }
  const onAbort = () => {
    entry.stopped++;
    if (!entry.unstoppable && entry.stopped >= entry.callers) entry.ctrl.abort(signal.reason);
  };
  if (signal.aborted) onAbort();
  else {
    signal.addEventListener("abort", onAbort, { once: true });
    entry.promise.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => {});
  }
  return untilAborted(entry.promise, signal);
}

/**
 * Builds or refreshes a project's knowledge base. Concurrent calls for the same project and version share one refresh.
 *
 * `signal` (R4-17) stops it: the call rejects with KbRefreshAbortedError at once, and the refresh stops between lane
 * pages (every fetch it makes, and every pause between fetches, sees the signal) unless another caller without a
 * signal, or one not yet aborted, is still waiting on it. A stopped refresh prunes nothing and is recorded as failed.
 */
export async function refreshKnowledgeBase(
  db: DB,
  projectId: string,
  /** `full`: every lane's paid searches run in full (the local CLI's builds), not only when they're due. */
  opts: { versionId?: string | null; progress?: Progress; signal?: AbortSignal; full?: boolean } = {},
): Promise<KbStats> {
  throwIfRefreshAborted(opts.signal);
  const versionId = opts.versionId ?? null;
  const current = inflight.get(projectId);
  if (current) {
    opts.progress?.("Waiting for the knowledge-base refresh already in progress");
    if (current.versionId === versionId) return joinRefresh(current, opts.signal);
    await untilAborted(
      current.promise.catch(() => null),
      opts.signal,
    );
    return refreshKnowledgeBase(db, projectId, opts);
  }
  const ctrl = new AbortController();
  const entry: Inflight = { versionId, ctrl, callers: 0, stopped: 0, unstoppable: false, promise: Promise.resolve({} as KbStats) };
  entry.promise = withFetchSignal(ctrl.signal, () =>
    buildKnowledgeBase(db, projectId, { progress: opts.progress, versionId, signal: ctrl.signal, full: opts.full }),
  ).finally(() => inflight.delete(projectId));
  inflight.set(projectId, entry);
  return joinRefresh(entry, opts.signal);
}

const DAY = 86_400_000;
const daysSince = (iso?: string | null) => (iso ? (Date.now() - Date.parse(iso)) / DAY : Number.POSITIVE_INFINITY);

function numFromEnv(name: string, d: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** Deadlines (R3-SEC-8): no lane runs longer than this, and no refresh. */
// Builds run locally and weekly, at their full size: hours, not minutes.
export const LANE_DEADLINE_MS = numFromEnv("KB_LANE_DEADLINE_MS", 2 * 60 * 60_000);
export const REFRESH_DEADLINE_MS = numFromEnv("KB_REFRESH_DEADLINE_MS", 6 * 60 * 60_000);
/** A refresh doesn't start with less free space than this on the database's volume (R3-SEC-8). */
export const MIN_FREE_BYTES = numFromEnv("KB_MIN_FREE_BYTES", 1_000_000_000);

/**
 * Throws when an on-disk PGlite database's volume has less than `min` bytes free. A Postgres server manages its own
 * storage (and from a laptop its disk can't be seen), and in-memory databases always pass.
 */
export function assertFreeSpace(db: DB, min = MIN_FREE_BYTES): void {
  const dir = pgliteDirOf(db);
  if (!dir || !existsSync(dir)) return;
  let free: number;
  try {
    const st = statfsSync(resolve(dir));
    free = Number(st.bavail) * Number(st.bsize);
  } catch {
    return; // can't tell: don't block the refresh
  }
  if (free < min) throw new Error(`Only ${Math.round(free / 1e6)} MB free on the database volume; a refresh needs at least ${Math.round(min / 1e6)} MB`);
}

export class LaneTimeoutError extends Error {}

/** Resolves or rejects with `p`, or rejects with LaneTimeoutError at `deadline` (the work itself can't be cancelled). */
function withDeadline<T>(p: Promise<T>, deadline: number, what: string): Promise<T> {
  const ms = deadline - Date.now();
  if (ms <= 0) return Promise.reject(new LaneTimeoutError(`${what}: the refresh deadline passed before it started`));
  let timer: NodeJS.Timeout | null = null;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LaneTimeoutError(`${what}: stopped after ${Math.round(ms / 60_000)} minutes`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** What a lane returns: a count, or a count with its ref, note, and fetch failures. */
type LaneOutcome = number | { count: number; ref?: string; note?: string; partial?: boolean; failedUrls?: string[] };

/**
 * Builds or refreshes a project's knowledge base. Deterministic; external APIs are used only when configured.
 * `signal` stops it between discovery steps and lanes, and keeps a stopped lane from pruning (R4-17).
 */
async function buildKnowledgeBase(
  db: DB,
  projectId: string,
  opts: { versionId: string | null; progress?: Progress; signal?: AbortSignal; full?: boolean },
): Promise<KbStats> {
  const log = opts.progress ?? (() => {});
  const stopIfAborted = () => throwIfRefreshAborted(opts.signal);
  const startedAt = Date.now();
  const refreshDeadline = startedAt + REFRESH_DEADLINE_MS;
  let project = (await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)))[0];
  if (!project) throw new Error("Project not found");
  const version = opts.versionId ? ((await db.select().from(schema.projectVersions).where(eq(schema.projectVersions.id, opts.versionId)))[0] ?? null) : null;
  // The refresh reports every minute (kb_meta.heartbeatAt), so another process can tell it's alive: a server boot
  // resets only refreshes that stopped reporting (the editor's CLI may be running this one).
  const beat = async () => {
    await db.execute(
      sql`UPDATE projects SET kb_meta = kb_meta || jsonb_build_object('heartbeatAt', ${new Date().toISOString()}::text, 'refreshRunner', ${RUNNER_ID}::text) WHERE id = ${projectId}`,
    );
  };
  await db.update(schema.projects).set({ kbStatus: "refreshing", kbError: null }).where(eq(schema.projects.id, projectId));
  await beat();
  const heartbeat = setInterval(() => void beat().catch(() => {}), 60_000);
  heartbeat.unref();
  const runId = newId();
  const meta: KbMeta = { ...((project.kbMeta ?? {}) as KbMeta) };
  const prev = meta.lanes ?? {};
  const lanes: Record<string, LaneStatus> = {};
  const errors: string[] = [];
  const gh = new GithubMemo();
  const shared: RunShared = { discovered: [], defillama: null, repoRefs: new Map(), repos: [...project.githubRepos] };
  try {
    assertFreeSpace(db);
    // ---- Discovery: one homepage read, docs roots, GitHub org profiles, forums, X account → ownership registry.
    log(`Discovering ${project.websiteUrl}`);
    const site = await probeSite(project.websiteUrl);
    stopIfAborted();
    const roots: CrawlRoot[] = await discoverDocsRoots(project, site);
    stopIfAborted();
    const apex = registrableDomain(new URL(site?.finalUrl ?? project.websiteUrl).hostname);
    const configuredOwners = project.githubRepos.map((r) => r.split("/")[0]!.toLowerCase());
    const linkedOwners = linkedGithubOwners(site?.meta).filter((o) => !configuredOwners.includes(o));
    type Profile = { login: string; blog?: string | null; twitter_username?: string | null };
    const profiles: Profile[] = [];
    // Orgs that are the project's own (named after it, or linking its site): their other repos are monitored too.
    const dedicatedOwners: string[] = [];
    for (const owner of [...new Set([...configuredOwners, ...linkedOwners])].slice(0, 6)) {
      const p = await gh.getOrNull<Profile>(`/users/${encodeURIComponent(owner)}`).catch(() => null);
      if (!p) continue;
      // A linked org counts as the project's only when its profile points back at the project's site or name.
      const blogHost = (() => {
        try {
          return p.blog ? registrableDomain(new URL(/^https?:/.test(p.blog) ? p.blog : `https://${p.blog}`).hostname) : null;
        } catch {
          return null;
        }
      })();
      const tokens = createRegistry({ name: project.name, slug: project.slug, websiteUrl: project.websiteUrl }).tokens;
      const dedicated = blogHost === apex || tokens.some((t) => p.login.toLowerCase().includes(t));
      if (dedicated) dedicatedOwners.push(p.login.toLowerCase());
      if (configuredOwners.includes(owner) || dedicated) profiles.push(p);
    }
    const forumCandidates = [...linkedForumHosts(site?.meta, apex), `forum.${apex}`, `community.${apex}`, `gov.${apex}`, `research.${apex}`];
    const forums = await detectForums(forumCandidates);
    stopIfAborted();
    const registryInput = {
      name: project.name,
      slug: project.slug,
      websiteUrl: project.websiteUrl,
      websiteFinalUrl: site?.finalUrl ?? null,
      docsUrl: project.docsUrl,
      docsRoots: roots.map((r) => ({ url: r.url, prefix: r.prefix })),
      githubRepos: project.githubRepos,
      extraDomains: project.extraDomains ?? [],
      newsAliases: project.newsAliases ?? [],
      githubProfiles: profiles,
      forumHosts: forums,
      xHandles: project.xHandle ? [project.xHandle] : [],
      // Domains named after the project count as its own only when the site links them (R3-SRC-11).
      siteLinks: (site?.meta.links ?? []).map((l) => l.href),
    };
    let registry = createRegistry(registryInput);
    const ctx: LaneContext = {
      db,
      project,
      version,
      runId,
      registry,
      interested: await interestedPartiesFor(db, projectId, registry),
      gh,
      log,
      meta,
      shared,
    };
    // Every repository in the project's GitHub orgs is ranked; the relevant, active ones are read alongside the
    // configured repos (an org like ethereum or AztecProtocol keeps its system across many repos).
    let discovered: RepoSuggestion[] = [];
    try {
      const d = await discoverRepos(ctx, { dedicatedOwners, limit: env.kb.maxDiscoveredRepos });
      discovered = d.monitored;
      meta.suggestions = { ...(meta.suggestions ?? {}), repos: d.ranked.slice(0, 15) };
      if (discovered.length) log(`Also monitoring ${discovered.length} repos from the project's GitHub orgs: ${discovered.map((r) => r.repo).join(", ")}`);
    } catch (e) {
      log(`Couldn't list the project's GitHub repositories: ${(e as Error).message}`);
    }
    shared.repos = [...project.githubRepos, ...discovered.map((r) => r.repo)];
    meta.repos = [
      ...project.githubRepos.map((repo) => ({ repo, source: "configured" as const })),
      ...discovered.map((r) => ({ repo: r.repo, source: "discovered" as const, score: r.score, reasons: r.reasons })),
    ];
    let xHandle: string | null = null;
    let xUserId: string | undefined;
    if (hasX()) {
      try {
        const x = await resolveXHandle(ctx, {
          githubHandles: profiles.map((p) => p.twitter_username ?? "").filter(Boolean),
          siteHandles: linkedXHandles(site?.meta),
        });
        xHandle = x.handle;
        xUserId = x.userId;
        registry = createRegistry({ ...registryInput, xHandles: x.handle ? [x.handle] : [], xProfileUrls: x.urls ?? [] });
        lanes.xAccount = {
          ok: true,
          count: x.handle ? 1 : 0,
          refreshedAt: new Date().toISOString(),
          ref: x.handle ? `@${x.handle} (${x.source})` : "none found",
        };
      } catch (e) {
        const msg = redact((e as Error).message);
        errors.push(`X account: ${msg}`);
        lanes.xAccount = { ok: false, count: 0, refreshedAt: new Date().toISOString(), error: msg };
      }
    }
    stopIfAborted();
    ctx.registry = registry;
    ctx.interested = await interestedPartiesFor(db, projectId, registry);
    project = (await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)))[0] ?? project;
    ctx.project = project;
    meta.registry = registry;
    meta.docsRoots = roots.map((r) => ({ url: r.url, prefix: r.prefix }));
    meta.forums = forums;
    // Persist the registry now so evaluation tools classify consistently even while lanes run.
    await db
      .update(schema.projects)
      .set({ kbMeta: meta as Record<string, unknown> })
      .where(eq(schema.projects.id, projectId));
    log(`Docs roots: ${roots.map((r) => `${r.host}${r.prefix}`).join(", ") || "none"}${forums.length ? ` · forums: ${forums.join(", ")}` : ""}`);

    // ---- Lanes. Independent lanes run concurrently (EFF-12); politeness is per crawler worker and per host.
    const run = async (
      name: string,
      fn: (deadline: number) => Promise<LaneOutcome>,
      o: { prune?: boolean; legacy?: Section[]; full?: boolean } = {},
    ): Promise<number> => {
      // A stopped refresh starts no further lane, and a lane it stopped prunes nothing (R4-17).
      stopIfAborted();
      const t = Date.now();
      const deadline = Math.min(t + LANE_DEADLINE_MS, refreshDeadline);
      try {
        const r = await withDeadline(fn(deadline), deadline + 60_000, name);
        stopIfAborted();
        const count = typeof r === "number" ? r : r.count;
        const partial = typeof r === "object" && !!r.partial;
        // Pages that failed after retries keep their rows for this run instead of being pruned (R3-SRC-5).
        if (typeof r === "object" && r.failedUrls?.length) await keepAlive(db, projectId, name, runId, r.failedUrls);
        // A lane that suddenly finds far less (a host down, a rate limit), or lost over a tenth of its pages, keeps
        // what it had instead of pruning it, unless its scope changed (an editor narrowed the docs roots).
        const before = prev[name]?.ok ? (prev[name]?.count ?? 0) : 0;
        const scopeChanged = typeof r === "object" && !!r.ref && !!prev[name]?.ref && prev[name]!.ref !== r.ref;
        if (o.prune && !partial && count > 0 && (count >= before * 0.5 || scopeChanged)) {
          const p = await pruneLane(db, projectId, name, runId, { legacySections: o.legacy });
          if (p.deleted || p.staled) log(`${name}: removed ${p.deleted} stale sources${p.staled ? `, marked ${p.staled} cited ones stale` : ""}`);
        } else if (o.prune && (before > 0 || partial)) {
          log(`${name}: kept earlier sources (found ${count}, previously ${before}${partial ? ", partial run" : ""})`);
        }
        lanes[name] = {
          ok: true,
          count,
          refreshedAt: new Date().toISOString(),
          ms: Date.now() - t,
          ...(typeof r === "object" && r.ref ? { ref: r.ref } : {}),
          ...(typeof r === "object" && r.note ? { note: r.note } : {}),
          ...(partial ? { partial: true } : {}),
          ...(o.full ? { fullAt: new Date().toISOString() } : prev[name]?.fullAt ? { fullAt: prev[name]!.fullAt } : {}),
        };
        return count;
      } catch (e) {
        stopIfAborted();
        const msg = redact((e as Error).message);
        errors.push(`${name}: ${msg}`);
        log(`${name} failed: ${msg}`);
        lanes[name] = {
          ok: false,
          count: 0,
          refreshedAt: new Date().toISOString(),
          ms: Date.now() - t,
          error: msg.slice(0, 500),
          ...(prev[name]?.fullAt ? { fullAt: prev[name]!.fullAt } : {}),
        };
        return 0;
      }
    };
    /** Fetch statistics as a lane outcome: note, partial flag and the URLs to keep. */
    const crawlOutcome = (count: number, stats: Parameters<typeof describeFetchStats>[0], extra: { ref?: string; note?: string } = {}) => {
      const d = describeFetchStats(stats);
      return {
        count,
        ...(extra.ref ? { ref: extra.ref } : {}),
        note: [extra.note, d.note].filter(Boolean).join("; "),
        partial: d.partial,
        failedUrls: stats.failedUrls,
      };
    };

    const docsP = run(
      "docs",
      async (deadline) => {
        if (!roots.length) return { count: 0, note: "no docs site found; set docs roots in project settings" };
        log(`Crawling docs: ${roots.map((r) => r.url).join(", ")}`);
        const r = await ingestDocs(ctx, roots, { deadline });
        return crawlOutcome(r.count, r.stats, {
          ref: roots.map((x) => `${x.host}${x.prefix}`).join(", "),
          note: [
            Object.entries(r.perRoot)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", "),
            r.skippedCopies ? `${r.skippedCopies} versioned copies skipped` : "",
          ]
            .filter(Boolean)
            .join("; "),
        });
      },
      { prune: true, legacy: ["docs"] },
    );
    const websiteP = run(
      "website",
      async (deadline) => {
        const r = await ingestWebsite(ctx, roots, site, { deadline });
        return crawlOutcome(r.count, r.stats);
      },
      { prune: true, legacy: ["website"] },
    );
    const xP = (async () => {
      if (!hasX()) return;
      const purged = await purgeOtherAnnouncements(db, projectId, xHandle);
      if (purged) log(`Removed ${purged} announcement sources from other X accounts`);
      if (!xHandle) {
        log("No verified X account found; set the handle in project settings to include announcements");
        return;
      }
      await run(
        "x",
        async () => {
          const r = await ingestAnnouncements(ctx, xHandle!, xUserId);
          return { count: r.total, ref: `@${xHandle}`, note: `${r.fetched} new posts` };
        },
        { prune: true, legacy: ["announcements"] },
      );
    })();
    const blogP = run(
      "blog",
      async (deadline) => {
        // Undated posts are ranked by the dates of the X posts that link them: on a first build those are stored
        // by the X lane running alongside, so the ranking waits for it (R4-33).
        const r = await ingestBlog(ctx, site, 150, { deadline, xPostsReady: xP });
        return crawlOutcome(r.count, r.stats);
      },
      { prune: true },
    );
    const pinnedP = run("pinned", (deadline) => ingestPinned(ctx, { deadline }));

    const repos = shared.repos;
    const budgets = repoBudgets(project.githubRepos.length, discovered.length);
    const snapshot = (repo: string, budget: { files: number; bytes: number }) =>
      run(
        `code:${repo}`,
        async () => {
          log(`Snapshotting ${repo}`);
          const snap = await ingestRepoCode(ctx, repo, budget);
          // Rows from the pre-lane knowledge base for this repo.
          await purgeWhere(db, projectId, sql`meta->>'section' = 'code' AND meta->>'repo' = ${repo} AND (meta->>'runId') IS NULL`);
          log(`${repo}@${snap.ref}: ${snap.files} files (${(snap.bytes / 1e6).toFixed(1)} MB, ${snap.reused} reused, ${snap.generated} generated skipped)`);
          return {
            count: snap.files,
            ref: `${snap.ref}${snap.commit ? ` (${snap.commit.slice(0, 10)})` : ""}`,
            note: `${snap.refSource}${snap.truncated ? ", capped" : ""}${snap.failed ? `, ${snap.failed} files unreadable` : ""}`,
            // Files that couldn't be read mustn't take their earlier copies with them.
            ...(snap.failed ? { partial: true } : {}),
          };
        },
        { prune: true },
      );
    const codeP = (async () => {
      for (const repo of project.githubRepos) {
        await snapshot(repo, budgets.configured);
        const base = await previousTagFor(ctx, version, repo);
        await run(`releases:${repo}`, () => ingestRepoReleases(ctx, repo, base?.releasedAt ?? null), { prune: true });
        if (base && version?.tag)
          await run(`changes:${repo}`, async () => ((await ingestRepoChanges(ctx, repo, base.tag, version.tag!)) ? 1 : 0), { prune: true });
        else await purgeWhere(db, projectId, sql`meta->>'lane' = ${`changes:${repo}`}`);
        await run(`advisories:${repo}`, () => ingestRepoAdvisories(ctx, repo), { prune: true });
      }
      // Discovered repos: code at their latest release, the last half year of release notes, and advisories.
      const halfYear = new Date(Date.now() - 182 * DAY).toISOString().slice(0, 10);
      await mapLimit(discovered, 2, async ({ repo }) => {
        await snapshot(repo, budgets.discovered);
        await run(`releases:${repo}`, () => ingestRepoReleases(ctx, repo, halfYear, 8), { prune: true });
        await run(`advisories:${repo}`, () => ingestRepoAdvisories(ctx, repo), { prune: true });
      });
      // Repos no longer configured or monitored: their code, releases, diffs and advisories go (cited rows stay, stale).
      const keep = repos.map((r) => r.toLowerCase());
      const kept = keep.length
        ? sql`AND lower(substr(meta->>'lane', strpos(meta->>'lane', ':') + 1)) NOT IN (${sql.join(
            keep.map((k) => sql`${k}`),
            sql`, `,
          )})`
        : sql``;
      await purgeWhere(db, projectId, sql`meta->>'lane' ~ '^(code|releases|changes|advisories):' ${kept}`);
      // Legacy release/diff rows written before lanes existed.
      await purgeWhere(db, projectId, sql`meta->>'section' = 'changes' AND (meta->>'runId') IS NULL`);
    })();

    const newsP = hasNews()
      ? run("news", async () => {
          const since =
            prev.news?.ok && daysSince(prev.news.refreshedAt) < 30 ? new Date(Date.parse(prev.news.refreshedAt) - 2 * DAY).toISOString().slice(0, 10) : null;
          const r = await ingestNewsLane(ctx, { since });
          const removed = await pruneNews(ctx);
          return {
            count: r.stored,
            note: [
              since ? `since ${since}` : "full year requested",
              r.oldest ? `oldest article ${r.oldest}` : "no articles",
              r.backfilled ? `${r.backfilled} backfilled from Exa (archive under 60 days)` : "",
              `${r.dropped} irrelevant dropped`,
              removed ? `${removed} old removed` : "",
            ]
              .filter(Boolean)
              .join("; "),
          };
        })
      : Promise.resolve(0);

    const analysisFull = !!opts.full || daysSince(prev.analysis?.fullAt) > 30;
    const analysisP = hasExa()
      ? run(
          "analysis",
          async () => {
            const r = await ingestAnalysesLane(ctx, { full: analysisFull, since: prev.analysis?.refreshedAt ?? null });
            const removed = await pruneAnalyses(ctx);
            return {
              count: r.stored,
              note: `${analysisFull ? "full" : "incremental"}; ${r.dropped} dropped by policy or relevance${removed ? `, ${removed} old removed` : ""}`,
            };
          },
          { full: analysisFull },
        )
      : Promise.resolve(0);

    const dataP = Promise.all([
      run("l2beat", () => ingestL2beat(ctx), { prune: true, legacy: ["data"] }),
      run("defillama", () => ingestDefillama(ctx), { prune: true }),
      run("hacks", () => ingestHacks(ctx), { prune: true }),
    ]);

    const forumP = forums.length
      ? run("forum", async () => ({ count: await ingestForums(ctx, forums), ref: forums.join(", ") }), { prune: true })
      : Promise.resolve(0);

    // Audits need the code refs and DefiLlama's audit links; the address registry needs docs, code and L2BEAT.
    const auditsFull = !!opts.full || daysSince(prev.audits?.fullAt) > 14;
    const auditsP = Promise.allSettled([codeP, dataP]).then(() =>
      run(
        "audits",
        async () => {
          const links = shared.defillama?.auditLinks ?? (await defillamaProtocol(ctx).catch(() => null))?.audit_links ?? [];
          const r = await ingestAudits(ctx, { full: auditsFull && hasExa(), auditLinks: links });
          return { count: r.count, note: `${auditsFull ? "full" : "repo folders and DefiLlama links only"}; ${r.note}` };
        },
        { prune: auditsFull, full: auditsFull },
      ),
    );
    const addressesP = Promise.allSettled([docsP, codeP, dataP]).then(() => run("addresses", () => ingestAddressRegistry(ctx), { prune: true }));

    await Promise.allSettled([docsP, websiteP, blogP, pinnedP, codeP, xP, newsP, analysisP, dataP, forumP, auditsP, addressesP]);
    // Stopped: recorded as a failed refresh below, never as a ready knowledge base.
    stopIfAborted();

    const stats = await computeStats(db, projectId, repos.length);
    meta.lanes = lanes;
    meta.runId = runId;
    meta.refreshedAt = new Date().toISOString();
    await db
      .update(schema.projects)
      .set({
        kbStatus: "ready",
        kbStats: stats as Record<string, number>,
        kbRefreshedAt: new Date().toISOString(),
        kbVersionId: version?.id ?? null,
        kbError: errors.length ? redact(errors.join("\n")).slice(0, 4000) : null,
        kbMeta: meta as Record<string, unknown>,
      })
      .where(eq(schema.projects.id, projectId));
    void maintainAfterRefresh(db);
    log(`Knowledge base ready in ${Math.round((Date.now() - startedAt) / 1000)} s: ${describeStats(stats)}`);
    return stats;
  } catch (e) {
    meta.lanes = { ...prev, ...lanes };
    await db
      .update(schema.projects)
      .set({ kbStatus: "error", kbError: redact((e as Error).message), kbMeta: meta as Record<string, unknown> })
      .where(eq(schema.projects.id, projectId));
    throw e;
  } finally {
    clearInterval(heartbeat);
  }
}

/** Counts what the knowledge base holds now (current rows only), by section. */
async function computeStats(db: DB, projectId: string, repos: number): Promise<KbStats> {
  const rows = await query<{ section: string | null; n: number }>(
    db,
    sql`SELECT meta->>'section' AS section, count(*)::int AS n FROM sources
       WHERE project_id = ${projectId} AND (meta->>'lane') IS NOT NULL AND NOT ${STALE} AND coalesce(content_len, 0) > 0
       GROUP BY 1`,
  );
  const stats: KbStats = { repos };
  for (const r of rows) if (r.section) (stats as Record<string, number>)[r.section] = r.n;
  const [posts] = await query<{ n: number }>(
    db,
    sql`SELECT coalesce(sum((meta->>'count')::numeric), 0)::int AS n FROM sources
      WHERE project_id = ${projectId} AND kind = 'announcement' AND origin = 'kb' AND NOT ${STALE}`,
  );
  if (posts?.n) stats.announcements = posts.n;
  const [audits] = await query<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM sources WHERE project_id = ${projectId} AND kind = 'audit' AND coalesce(content_len, 0) > 0 AND NOT ${STALE}`,
  );
  stats.audits = audits?.n ?? 0;
  const [registry] = await query<{ n: number | null }>(
    db,
    sql`SELECT (meta->>'addresses')::int AS n FROM sources WHERE project_id = ${projectId} AND url LIKE 'evm://registry/%' LIMIT 1`,
  );
  stats.addresses = registry?.n ?? 0;
  const [bytes] = await query<{ b: string | number }>(db, sql`SELECT coalesce(sum(content_len), 0) AS b FROM sources WHERE project_id = ${projectId}`);
  stats.bytes = Number(bytes?.b ?? 0);
  return stats;
}

export function describeStats(s: KbStats): string {
  const parts = [
    [s.docs, "docs pages"],
    [s.website, "site pages"],
    [s.code, "code files"],
    [s.changes, "release notes, diffs & advisories"],
    [s.announcements, "X posts"],
    [s.news, "news articles"],
    [s.analysis, "analyses"],
    [s.audits, "audit reports"],
    [s.forum, "forum threads"],
    [s.data, "data sources"],
    [s.addresses, "registry addresses"],
  ] as const;
  return parts
    .filter(([n]) => n)
    .map(([n, l]) => `${n} ${l}`)
    .join(" · ");
}

// ---------- search ----------

export interface SearchHit {
  id: string;
  title: string;
  url: string;
  kind: string;
  sourceClass: string;
  snippet: string;
}

/** Words that carry no meaning in a search ("who can upgrade the contracts"); they made OR mode match everything. */
export const STOP_WORDS = new Set([
  "who",
  "what",
  "how",
  "can",
  "does",
  "do",
  "the",
  "a",
  "an",
  "of",
  "to",
  "is",
  "are",
  "in",
  "on",
  "for",
  "and",
  "or",
  "by",
  "with",
  "which",
  "any",
  "be",
  "it",
  "its",
  "there",
  "this",
  "that",
  "if",
  "when",
]);

/** Search terms: letters and digits, stop words removed unless nothing else is left (R3-SRC-6). */
export function searchTerms(q: string): string[] {
  const all = (q.match(/[\p{L}\p{N}_]{2,}/gu) ?? []).slice(0, 24);
  const kept = all.filter((t) => !STOP_WORDS.has(t.toLowerCase()));
  return (kept.length ? kept : all).slice(0, 12);
}

/**
 * A tsquery for the terms: every term (AND) or any (OR). Terms are letters, digits and underscores only
 * (`searchTerms`), so they can't carry tsquery operators; English stop words drop out as they did in FTS5.
 */
export function tsQueryText(terms: string[], mode: "and" | "or"): string {
  return terms
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter(Boolean)
    .join(mode === "and" ? " & " : " | ");
}

/**
 * The kinds the agent tools advertise, mapped to what rows actually carry (R3-SRC-6): advisories and incidents are
 * subkinds, forum topics are `governance`, the registry is the `evm://registry/` row. Columns use the alias `s`.
 */
const KIND_SQL: Record<string, SQL> = {
  incident: sql`s.meta->>'subkind' = 'incident'`,
  advisory: sql`s.meta->>'subkind' = 'advisory'`,
  forum: sql`s.kind = 'governance'`,
  registry: sql`s.url LIKE 'evm://registry/%'`,
};

/** A SQL condition for a list of tool kinds (alias `s`), or null for "all kinds". */
export function kindFilterSql(kinds: string[] | undefined): SQL | null {
  const ks = [...new Set((kinds ?? []).filter(Boolean))];
  if (!ks.length) return null;
  const plain = ks.filter((k) => !KIND_SQL[k]);
  const parts = ks.filter((k) => KIND_SQL[k]).map((k) => KIND_SQL[k]!);
  if (plain.length)
    parts.unshift(
      sql`s.kind IN (${sql.join(
        plain.map((k) => sql`${k}`),
        sql`, `,
      )})`,
    );
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/**
 * Search attestations from other evaluations are evidence records, not knowledge: only the current evaluation's are
 * searchable, and none when no evaluation is given (R3-SRC-6). Alias `s`.
 */
export function attestationFilterSql(evaluationId?: string | null): SQL {
  if (!evaluationId) return sql`s.kind <> 'attestation'`;
  return sql`(s.kind <> 'attestation' OR starts_with(s.url, ${`attestation://${evaluationId}/`}))`;
}

/** Generated code and bindings rank last. */
const GENERATED_URL = /\/(bindings|rust_bindings|generated|typechain(-types)?|artifacts|abi)\//i;
/** Kinds where the same page lives under several URLs (www, `.md` twins, trailing slashes). */
const PAGE_KINDS = new Set(["docs", "website", "blog"]);

/**
 * Full-text search over a project's knowledge base: chunks ranked by `ts_rank` (every matching word counts, titles more than text), the
 * best chunk per source, with highlighted snippets. Results matching every term come first, then any-term matches
 * with announcements after the rest; stop words are ignored; duplicates (same content, or for pages the same
 * canonical URL) collapse; stale rows and other evaluations' attestations are hidden; generated code goes last
 * (SRC-16, R3-SRC-6). Snippets are computed only for the rows returned (R3-REL-4).
 */
export async function searchSources(
  db: DB,
  projectId: string,
  queryText: string,
  opts: { kinds?: string[]; limit?: number; excludeEditorNotes?: boolean; evaluationId?: string | null } = {},
): Promise<SearchHit[]> {
  const limit = Math.min(opts.limit ?? 12, 30);
  const terms = searchTerms(queryText);
  if (!terms.length) return [];
  type Row = Omit<SearchHit, "snippet"> & { hash: string | null; generated: boolean; mode: "and" | "or" };
  const kf = kindFilterSql(opts.kinds);
  const att = attestationFilterSql(opts.evaluationId);
  const run = async (mode: "and" | "or"): Promise<Row[]> => {
    const tq = tsQueryText(terms, mode);
    if (!tq) return [];
    const rows = await query<Omit<Row, "mode">>(
      db,
      sql`WITH q AS (SELECT to_tsquery('english', ${tq}) AS q),
        hits AS (
          SELECT c.source_id, max(ts_rank(c.tsv, q.q)) AS rank
          FROM source_chunks c, q
          WHERE c.project_id = ${projectId} AND c.tsv @@ q.q
          GROUP BY c.source_id
        )
        SELECT s.id, s.title, s.url, s.kind, s.source_class AS "sourceClass", s.content_hash AS hash,
               coalesce(s.meta->'generated' IN ('true'::jsonb, '1'::jsonb), false) AS generated
        FROM hits h JOIN sources s ON s.id = h.source_id
        WHERE ${kf ?? sql`true`} ${opts.excludeEditorNotes ? sql`AND s.kind <> 'editor_note'` : sql``}
          AND ${att} AND NOT ${STALE}
        ORDER BY h.rank DESC, s.id
        LIMIT ${limit * 3}`,
    );
    return rows.map((r) => ({ ...r, mode }));
  };
  const [and, or] = await Promise.all([run("and"), terms.length > 1 ? run("or") : Promise.resolve([])]);
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const primary: Row[] = [];
  const posts: Row[] = [];
  const generated: Row[] = [];
  for (const r of [...and, ...or]) {
    if (seenIds.has(r.id)) continue;
    seenIds.add(r.id);
    const keys = [...(PAGE_KINDS.has(r.kind) ? [`u:${canonicalKey(r.url)}`] : []), ...(r.hash ? [`h:${r.hash}`] : [])];
    if (keys.some((k) => seenKeys.has(k))) continue;
    for (const k of keys) seenKeys.add(k);
    if (r.generated || GENERATED_URL.test(r.url)) generated.push(r);
    // A month of X posts matches any one word; in any-term mode it ranks after real pages.
    else if (r.mode === "or" && r.kind === "announcement") posts.push(r);
    else primary.push(r);
  }
  const top = [...primary, ...posts, ...generated].slice(0, limit);
  if (!top.length) return [];
  // Snippets for the returned rows only, from each source's best-matching chunk.
  const snippets = new Map<string, string>();
  for (const mode of ["and", "or"] as const) {
    const ids = top.filter((r) => r.mode === mode).map((r) => r.id);
    if (!ids.length) continue;
    const rows = await query<{ id: string; snippet: string }>(
      db,
      sql`WITH q AS (SELECT to_tsquery('english', ${tsQueryText(terms, mode)}) AS q)
        SELECT DISTINCT ON (c.source_id) c.source_id AS id,
          ts_headline('english', c.content, q.q, 'StartSel=«, StopSel=», MaxWords=28, MinWords=10, MaxFragments=2, FragmentDelimiter=" … "') AS snippet
        FROM source_chunks c, q
        WHERE c.source_id IN (${sql.join(
          ids.map((i) => sql`${i}`),
          sql`, `,
        )}) AND c.tsv @@ q.q
        ORDER BY c.source_id, ts_rank(c.tsv, q.q) DESC`,
    );
    for (const r of rows) snippets.set(r.id, r.snippet);
  }
  return top.map(({ id, title, url, kind, sourceClass }) => ({ id, title, url, kind, sourceClass, snippet: snippets.get(id) ?? "" }));
}

/** What the knowledge base holds, per lane (ref, freshness, errors) and per kind, for agents. */
export async function kbOverview(db: DB, projectId: string, opts: { excludeEditorNotes?: boolean } = {}): Promise<string> {
  const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)))[0];
  const meta = ((project?.kbMeta ?? {}) as KbMeta) || {};
  const rows = (
    await db
      .select({ kind: schema.sources.kind, n: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(content_len), 0)` })
      .from(schema.sources)
      .where(
        sql`${schema.sources.projectId} = ${projectId} AND coalesce(${schema.sources.contentLen}, 0) > 0 AND NOT ${STALE} AND ${schema.sources.kind} <> 'attestation'`,
      )
      .groupBy(schema.sources.kind)
  ).filter((r) => !(opts.excludeEditorNotes && r.kind === "editor_note"));
  const maps = await query<{ id: string; title: string }>(
    db,
    sql`SELECT id, title FROM sources WHERE project_id = ${projectId} AND kind = 'code' AND coalesce(meta->'map' IN ('true'::jsonb, '1'::jsonb), false) AND NOT ${STALE}`,
  );
  const [registry] = await query<{ id: string; title: string }>(
    db,
    sql`SELECT id, title FROM sources WHERE project_id = ${projectId} AND url LIKE 'evm://registry/%' LIMIT 1`,
  );
  const laneLines = Object.entries(meta.lanes ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, l]) => {
      const when = l.refreshedAt?.slice(0, 10) ?? "?";
      if (!l.ok) return `- ${name}: FAILED on ${when}: ${l.error ?? "unknown error"}`;
      return `- ${name}: ${l.count}${l.partial ? " (PARTIAL: some pages couldn't be fetched; missing pages may exist)" : ""}${l.ref ? ` · ${l.ref}` : ""}${l.note ? ` · ${l.note}` : ""} (${when})`;
    });
  const suggestions = (meta.suggestions?.repos ?? []).filter((r) => !r.configured && r.score >= 5).slice(0, 5);
  return [
    project?.kbRefreshedAt ? `Knowledge base refreshed ${project.kbRefreshedAt.slice(0, 16).replace("T", " ")} UTC.` : "Knowledge base not refreshed yet.",
    laneLines.length ? `\nLanes (count · ref · notes, last run):\n${laneLines.join("\n")}` : "",
    "\nKnowledge base contents by kind:",
    ...rows.map((r) => `- ${r.kind}: ${r.n} sources (${Math.round((r.bytes ?? 0) / 1000)} KB)`),
    maps.length ? `\nRepository maps (read these first to locate code):\n${maps.map((r) => `- ${r.id} · ${r.title}`).join("\n")}` : "",
    registry ? `\nDeployed address registry (contracts, proxies, admins, Safes): ${registry.id} · ${registry.title}` : "",
    meta.suggestions?.l2beatSlug ? `\nL2BEAT slug suggestion: ${meta.suggestions.l2beatSlug}` : "",
    suggestions.length ? `\nRepositories in the project's GitHub org that aren't in the knowledge base: ${suggestions.map((s) => s.repo).join(", ")}` : "",
    "\nUse search_sources to find passages, then read_source to read a page in full.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
