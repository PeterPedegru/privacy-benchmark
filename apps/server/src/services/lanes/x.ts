/**
 * Announcements from the project's own X account (SRC-11, EFF-11).
 *
 * Candidates come from the GitHub org's `twitter_username` (the strongest signal), links on the website and docs,
 * and name patterns. Every candidate's profile must link one of the project's verified domains; a guessed handle
 * additionally needs at least 1,000 followers or a verified badge. Posts are fetched incrementally with `since_id`
 * and grouped by quarter, with t.co links expanded.
 */
import { eq, sql } from "drizzle-orm";
import { type DB, query, schema } from "../../db/index.ts";
import { normalizeHandle, type Post, postsToMarkdown, xPosts, xUser } from "../../lib/externals.ts";
import { hostKey, nameTokens } from "../classify.ts";
import { purgeWhere } from "../kb-store.ts";
import { type LaneContext, type Progress, type ProjectRow, storeFor } from "./context.ts";

export type CandidateSource = "github" | "site" | "guess";

/** Handle guesses from name tokens: plain, joined, `_project`, `0x` prefix and the usual suffixes. Pure. */
export function guessHandles(name: string, slug: string): string[] {
  const tokens = nameTokens(name, slug);
  const words = name
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const joined = words.join("");
  const out = new Set<string>();
  for (const t of [...tokens.slice(0, 2), ...(joined.length >= 4 ? [joined] : [])]) {
    for (const g of [t, `${t}network`, `${t}protocol`, `${t}labs`, `${t}_xyz`, `get${t}`, `${t}_project`, `0x${t}`, `${t}hq`, `${t}_io`]) out.add(g);
  }
  return [...out].filter((h) => /^[a-z0-9_]{1,15}$/.test(h));
}

/**
 * How sure we are that an X account is the project's own. Only a profile that links to one of the project's
 * domains (or names it in the bio) counts as official. Score: link 3, bio mention 1, name match 2, handle starts
 * with the name 1.
 */
export async function handleConfidence(
  project: ProjectRow,
  handle: string,
  domains?: string[],
): Promise<{
  score: number;
  official: boolean;
  reason: string;
  followers?: number;
  verifiedType?: string | null;
  userId?: string;
  username?: string;
  urls?: string[];
}> {
  const user = await xUser(handle);
  if (!user) return { score: -1, official: false, reason: `@${handle} doesn't exist` };
  const own = domains?.length ? domains : ownDomains(project);
  const linksHome = user.urls.some((u) => {
    try {
      const host = hostKey(new URL(u).hostname);
      return own.some((d) => host === d || host.endsWith(`.${d}`) || d.endsWith(`.${host}`));
    } catch {
      return false;
    }
  });
  const mentionsHome = own.some((d) => user.description.toLowerCase().includes(d));
  const tokens = nameTokens(project.name, project.slug);
  const nameMatch = tokens.some((t) => user.username.toLowerCase().includes(t) || user.name.toLowerCase().includes(t));
  const handleStartsWithName = tokens.some((t) => user.username.toLowerCase().replace(/_/g, "").startsWith(t));
  const score = (linksHome ? 3 : 0) + (mentionsHome ? 1 : 0) + (nameMatch ? 2 : 0) + (handleStartsWithName ? 1 : 0);
  const official = linksHome || mentionsHome;
  const why = [linksHome && "profile links to the project's site", mentionsHome && "bio mentions its domain", nameMatch && "name matches"]
    .filter(Boolean)
    .join(", ");
  return {
    score,
    official,
    reason: official
      ? `@${user.username}: ${why}`
      : `@${user.username}: ${why || "different name"}, but the profile doesn't link to ${own[0] ?? "the project"}`,
    followers: user.followers,
    verifiedType: user.verifiedType,
    userId: user.id,
    username: user.username,
    urls: user.urls,
  };
}

/** The project's website and docs domains (used when no registry is available). */
export function ownDomains(project: ProjectRow): string[] {
  const hosts = new Set<string>();
  for (const u of [project.websiteUrl, project.docsUrl]) {
    if (!u) continue;
    try {
      hosts.add(hostKey(new URL(u).hostname));
    } catch {
      // ignore
    }
  }
  return [...hosts];
}

/** Whether a candidate is acceptable: official always; guesses also need reach or a verified badge. Pure. */
export function acceptCandidate(source: CandidateSource, c: { official: boolean; followers?: number; verifiedType?: string | null }): boolean {
  if (!c.official) return false;
  if (source !== "guess") return true;
  return (c.followers ?? 0) >= 1000 || (!!c.verifiedType && c.verifiedType !== "none");
}

export interface XDiscovery {
  handle: string | null;
  userId?: string;
  urls?: string[];
  reason?: string;
}

/** Finds the project's own X account from GitHub, site links and name patterns. */
export async function discoverXHandle(
  project: ProjectRow,
  log: Progress = () => {},
  opts: { githubHandles?: string[]; siteHandles?: string[]; domains?: string[] } = {},
): Promise<XDiscovery> {
  const counts = new Map<string, number>();
  for (const h of opts.siteHandles ?? []) counts.set(h.toLowerCase(), (counts.get(h.toLowerCase()) ?? 0) + 1);
  const candidates: { h: string; source: CandidateSource }[] = [];
  const add = (h: string, source: CandidateSource) => {
    const n = normalizeHandle(h)?.toLowerCase();
    if (n && !candidates.some((c) => c.h === n)) candidates.push({ h: n, source });
  };
  for (const h of opts.githubHandles ?? []) add(h, "github");
  for (const [h] of [...counts.entries()].sort((a, b) => b[1] - a[1])) add(h, "site");
  for (const g of guessHandles(project.name, project.slug)) add(g, "guess");
  let best: (XDiscovery & { score: number }) | null = null;
  for (const c of candidates.slice(0, 14)) {
    try {
      const r = await handleConfidence(project, c.h, opts.domains);
      if (r.score < 0) continue;
      const ok = acceptCandidate(c.source, r);
      log(
        `X candidate (${c.source}) ${r.reason}${ok ? "" : r.official ? " (rejected: guessed handle without 1,000 followers or a verified badge)" : " (rejected)"}`,
      );
      const score = r.score + (c.source === "github" ? 3 : c.source === "site" ? 2 : 0);
      if (ok && (!best || score > best.score)) best = { handle: r.username ?? c.h, userId: r.userId, urls: r.urls, reason: r.reason, score };
      if (best && best.score >= 9) break;
    } catch (e) {
      log(`X lookup failed for @${c.h}: ${(e as Error).message}`);
    }
  }
  return best ? { handle: best.handle, userId: best.userId, urls: best.urls, reason: best.reason } : { handle: null };
}

/** Deletes announcement sources from any other account (cited ones are marked stale instead). */
export async function purgeOtherAnnouncements(db: DB, projectId: string, keepHandle: string | null): Promise<number> {
  return (await purgeWhere(db, projectId, sql`kind = 'announcement' AND lower(coalesce(meta->>'handle', '')) <> ${(keepHandle ?? "").toLowerCase()}`)).deleted;
}

/**
 * The handle to read: an editor's choice as-is; otherwise the best verified account. A verified auto handle is
 * reused for 7 days before being checked again (EFF-11).
 */
export async function resolveXHandle(
  ctx: LaneContext,
  opts: { githubHandles: string[]; siteHandles: string[] },
): Promise<XDiscovery & { source: "admin" | "auto" | "cached" }> {
  const { project, db, log } = ctx;
  if (project.xHandle && project.xHandleSource !== "auto") {
    const h = normalizeHandle(project.xHandle);
    const u = h ? await xUser(h).catch(() => null) : null;
    return { handle: h, userId: u?.id, urls: u?.urls, source: "admin" };
  }
  const cached = ctx.meta.x;
  if (
    cached &&
    project.xHandle &&
    cached.handle.toLowerCase() === project.xHandle.toLowerCase() &&
    Date.now() - Date.parse(cached.verifiedAt) < 7 * 86_400_000
  ) {
    return { handle: cached.handle, userId: cached.userId, urls: cached.urls, source: "cached" };
  }
  const found = await discoverXHandle(project, log, { ...opts, domains: ctx.registry.domains });
  if (project.xHandle && found.handle?.toLowerCase() !== project.xHandle.toLowerCase())
    log(
      `Replaced auto-detected X account @${project.xHandle} with ${found.handle ? `@${found.handle}` : "none"}. Set the handle in project settings to override.`,
    );
  await db
    .update(schema.projects)
    .set({ xHandle: found.handle, xHandleSource: found.handle ? "auto" : null })
    .where(eq(schema.projects.id, project.id));
  ctx.meta.x = found.handle
    ? { handle: found.handle, userId: found.userId, verifiedAt: new Date().toISOString(), reason: found.reason, urls: found.urls }
    : undefined;
  return { ...found, source: "auto" };
}

/** Posts are stored one source per month (R3-SRC-6): a quarter of a busy account was one 185-post row that won every search. */
export const monthOf = (iso: string) => iso.slice(0, 7);

/** Parses stored quarter content back into posts (one per paragraph). Pure. */
export function parseStoredPosts(content: string): Post[] {
  const out: Post[] = [];
  for (const para of content.split(/\n\n+/)) {
    const m = para.match(/^\[(\d{4}-\d{2}-\d{2})\] @([A-Za-z0-9_]+): ([\s\S]*) \((https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/(\d+))\)$/);
    if (m) out.push({ id: m[5]!, text: m[3]!, createdAt: `${m[1]}T00:00:00.000Z`, url: m[4]!, author: m[2]! });
  }
  return out;
}

const byIdDesc = (a: Post, b: Post) => (BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0);

/**
 * Reads new posts since the newest stored one (or 18 months on the first read) and merges them into month sources.
 * Posts from every stored row of the account (older quarter rows included) are regrouped by month, so the switch
 * from quarters loses nothing; rows no longer written are pruned with the lane.
 */
export async function ingestAnnouncements(ctx: LaneContext, handle: string, userId?: string): Promise<{ fetched: number; total: number }> {
  const rows = await query<{ url: string; content: string; newestId: string | null }>(
    ctx.db,
    sql`SELECT url, content_md AS content, meta->>'newestId' AS "newestId" FROM sources
      WHERE project_id = ${ctx.project.id} AND kind = 'announcement' AND lower(meta->>'handle') = ${handle.toLowerCase()}`,
  );
  const newest = rows
    .map((r) => r.newestId)
    .filter((x): x is string => !!x && /^\d+$/.test(x))
    .sort((a, b) => (BigInt(a) > BigInt(b) ? -1 : 1))[0];
  const since = new Date(Date.now() - 548 * 86_400_000).toISOString();
  const posts = await xPosts(handle, { max: 600, ...(newest ? { sinceId: newest } : { sinceIso: since }), userId });
  const all = new Map<string, Post>();
  for (const r of rows) for (const p of parseStoredPosts(r.content)) all.set(p.id, p);
  for (const p of posts) all.set(p.id, p);
  const byMonth = new Map<string, Post[]>();
  for (const p of all.values()) {
    // Months older than the 18-month window are dropped.
    if (Date.parse(p.createdAt) < Date.parse(since)) continue;
    const m = monthOf(p.createdAt);
    byMonth.set(m, [...(byMonth.get(m) ?? []), p]);
  }
  let total = 0;
  for (const [m, list] of byMonth) {
    const sorted = list.sort(byIdDesc);
    total += sorted.length;
    await storeFor(ctx, "x", "announcements", {
      url: `https://x.com/${handle}#${m}`,
      title: `X posts by @${handle}, ${m} (${sorted.length})`,
      kind: "announcement",
      sourceClass: "marketing",
      content: postsToMarkdown(sorted),
      date: sorted[0]!.createdAt.slice(0, 10),
      meta: { handle, month: m, newestId: sorted[0]!.id, count: sorted.length },
    });
  }
  return { fetched: posts.length, total };
}
