/**
 * Knowledge-base storage: one row per (project, URL), with
 * - lane precedence (SRC-1): a stronger lane owns a URL, so the Exa or website lane can't relabel a docs page;
 * - unchanged-content skips (EFF-4): same hash, title and class only refresh `fetched_at` and `meta`, which the
 *   column-limited FTS trigger ignores;
 * - content de-duplication (SRC-13): the same body under another URL in the same section isn't stored twice, and a
 *   duplicate written before lanes existed is adopted by the lane instead of blocking it (R3-SRC-2);
 * - run-id pruning (SRC-15): every row carries `meta.lane` and `meta.runId`; after a lane succeeds, its rows that
 *   this run didn't touch are deleted, or marked `meta.stale` when evidence cites them (EFF-7: done in SQL);
 * - size limits (R3-SEC-8): web pages are capped at 300 KB of text, any row at 2 MB, and a project's whole
 *   knowledge base at a byte budget, so a hostile host can't fill the volume.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { DB } from "../db/index.ts";
import { exec, query, schema } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import { type SourceClass, wwwVariant } from "./classify.ts";

export type Section = "docs" | "website" | "code" | "changes" | "announcements" | "news" | "analysis" | "data" | "audits" | "addresses" | "forum";

/** Higher wins: a URL stored by a stronger lane is never overwritten by a weaker one. */
export const LANE_RANK: Record<Section, number> = {
  code: 9,
  addresses: 9,
  docs: 8,
  audits: 7,
  data: 7,
  changes: 6,
  forum: 5,
  analysis: 4,
  website: 3,
  announcements: 2,
  news: 1,
};

/** Sections where the same body under two URLs is a duplicate (mirrors, `.md` twins, syndication). */
const DEDUPE_SECTIONS = new Set<Section>(["docs", "website", "news", "analysis", "audits", "forum"]);

export interface KbSourceInput {
  url: string;
  title: string;
  kind: string;
  sourceClass: SourceClass;
  content: string;
  date?: string | null;
  meta: Record<string, unknown> & { section: Section; lane?: string; runId?: string };
}

export type StoreStatus = "inserted" | "updated" | "touched" | "kept_stronger_lane" | "duplicate_content";

/** Hard cap on one row's text. */
export const MAX_CONTENT_CHARS = 2_000_000;
/** Web pages (docs, website, blog, news, analyses, forum threads) and agent-fetched pages (R3-SEC-8). */
export const MAX_PAGE_CHARS = 300_000;
/** Audit reports keep more: findings tables run long. */
export const MAX_REPORT_CHARS = 400_000;

const PAGE_SECTIONS = new Set<Section>(["docs", "website", "news", "analysis", "forum"]);

/** The most text a row in this section (or of this kind, for agent-stored sources) may keep. */
export function maxCharsFor(sectionOrKind: string): number {
  if (PAGE_SECTIONS.has(sectionOrKind as Section)) return MAX_PAGE_CHARS;
  if (["blog", "governance", "announcement"].includes(sectionOrKind)) return MAX_PAGE_CHARS;
  if (sectionOrKind === "audits" || sectionOrKind === "audit") return MAX_REPORT_CHARS;
  return MAX_CONTENT_CHARS;
}

/** Cuts text to a limit and says so, so an agent quoting the end of a page knows it was truncated. */
export function capContent(content: string, max: number): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n\n(truncated: the original was ${content.length.toLocaleString("en-US")} characters)`;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

// ---------- byte budget (R3-SEC-8) ----------

function budgetFromEnv(): number {
  const n = Number(process.env.KB_MAX_PROJECT_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 1_500_000_000;
}

/** Characters of stored text one project may hold (KB_MAX_PROJECT_BYTES, default 1.5 GB). */
export const PROJECT_BYTE_BUDGET = budgetFromEnv();

export class KbBudgetError extends Error {
  constructor(
    public projectId: string,
    public bytes: number,
    public budget: number,
  ) {
    super(
      `The project's knowledge base is over its ${Math.round(budget / 1e6)} MB budget (${Math.round(bytes / 1e6)} MB stored); nothing more is stored until it shrinks`,
    );
  }
}

const budgetCache = new Map<string, { bytes: number; at: number }>();

/** Stored characters for a project, cached for a few seconds and kept current by the writers in this module. */
export async function projectBytes(db: DB, projectId: string): Promise<number> {
  const hit = budgetCache.get(projectId);
  if (hit && Date.now() - hit.at < 10_000) return hit.bytes;
  const [row] = await query<{ b: string | number }>(db, sql`SELECT coalesce(sum(content_len), 0) AS b FROM sources WHERE project_id = ${projectId}`);
  const bytes = Number(row?.b ?? 0);
  budgetCache.set(projectId, { bytes, at: Date.now() });
  return bytes;
}

/**
 * Throws KbBudgetError when growing a project's text by `delta` characters would pass its budget. Shrinking or
 * same-size writes always pass. Call before writing; `noteWrite` records the change afterwards.
 */
export async function assertBudget(db: DB, projectId: string, delta: number, budget = PROJECT_BYTE_BUDGET): Promise<void> {
  if (delta <= 0) return;
  const bytes = await projectBytes(db, projectId);
  if (bytes + delta > budget) throw new KbBudgetError(projectId, bytes, budget);
}

export function noteWrite(projectId: string, delta: number): void {
  const hit = budgetCache.get(projectId);
  if (hit) hit.bytes += delta;
}

/** Forget cached totals (tests, and after bulk deletes). */
export function resetBudgetCache(projectId?: string): void {
  if (projectId) budgetCache.delete(projectId);
  else budgetCache.clear();
}

// ---------- storing ----------

/**
 * Upserts one knowledge-base source by (project, URL), treating www and apex as the same URL. Editor
 * classifications on admin-added sources win. Returns what happened, for lane statistics. Throws KbBudgetError
 * when the project's knowledge base is full.
 */
export async function storeKbSourceEx(db: DB, projectId: string, s: KbSourceInput): Promise<{ id: string; status: StoreStatus }> {
  try {
    return await storeOnce(db, projectId, s);
  } catch (e) {
    // Two lanes can store the same URL at once: the loser of the insert race retries, and finds the winner's row.
    if (!isUniqueViolation(e)) throw e;
    return storeOnce(db, projectId, s);
  }
}

/** A Postgres unique-constraint violation (23505), as node-postgres and PGlite report it. */
export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

async function storeOnce(db: DB, projectId: string, s: KbSourceInput): Promise<{ id: string; status: StoreStatus }> {
  const content = capContent(s.content, Math.min(MAX_CONTENT_CHARS, maxCharsFor(s.meta.section)));
  const title = s.title.slice(0, 300);
  const hash = contentHash(content);
  const alt = wwwVariant(s.url);
  const candidates = await db
    .select({
      id: schema.sources.id,
      url: schema.sources.url,
      origin: schema.sources.origin,
      contentHash: schema.sources.contentHash,
      contentLen: schema.sources.contentLen,
      title: schema.sources.title,
      kind: schema.sources.kind,
      sourceClass: schema.sources.sourceClass,
      meta: schema.sources.meta,
    })
    .from(schema.sources)
    .where(and(eq(schema.sources.projectId, projectId), inArray(schema.sources.url, alt ? [s.url, alt] : [s.url])));
  const existing = candidates.find((c) => c.url === s.url) ?? candidates[0];
  const now = new Date().toISOString();
  if (existing) {
    // Attestations are evidence records, never knowledge-base pages.
    if (existing.kind === "attestation") return { id: existing.id, status: "kept_stronger_lane" };
    const prev = (existing.meta as { section?: Section } | null)?.section;
    if (prev && prev !== s.meta.section && (LANE_RANK[prev] ?? 0) > (LANE_RANK[s.meta.section] ?? 0)) {
      return { id: existing.id, status: "kept_stronger_lane" };
    }
    const isAdmin = existing.origin === "admin";
    const sameClass = isAdmin || (existing.kind === s.kind && existing.sourceClass === s.sourceClass);
    // Editor rows keep their classification. Rows an agent stored keep their origin, so pruning never takes them.
    const keep = isAdmin ? {} : { kind: s.kind, sourceClass: s.sourceClass, origin: existing.origin === "agent" ? "agent" : "kb" };
    // A demo-seeded editor row keeps its seed mark, which the seed reclassification needs (R4-12).
    const seed = isAdmin ? (existing.meta as { seed?: unknown } | null)?.seed : undefined;
    const meta = seed ? { ...s.meta, seed } : s.meta;
    if (existing.contentHash === hash && existing.title === title) {
      // Unchanged text: refresh bookkeeping (and the class, if the rules changed it). Title and content stay out
      // of the SET list, so the column-limited FTS trigger doesn't re-index the row.
      await db
        .update(schema.sources)
        .set({ meta, fetchedAt: now, ...(s.date ? { date: s.date } : {}), ...keep })
        .where(eq(schema.sources.id, existing.id));
      return { id: existing.id, status: sameClass ? "touched" : "updated" };
    }
    const delta = content.length - (existing.contentLen ?? 0);
    await assertBudget(db, projectId, delta);
    await db
      .update(schema.sources)
      .set({ title, contentMd: content, contentHash: hash, date: s.date ?? null, meta, fetchedAt: now, ...keep })
      .where(eq(schema.sources.id, existing.id));
    noteWrite(projectId, delta);
    return { id: existing.id, status: "updated" };
  }
  if (DEDUPE_SECTIONS.has(s.meta.section) && content.length >= 200) {
    // Audit reports are de-duplicated across sections too: the code lane may already hold the same report.
    const sectionFilter = s.meta.section === "audits" ? sql`` : sql`AND meta->>'section' = ${s.meta.section}`;
    // Live rows, and rows from before lanes existed even when stale: the lane adopts those instead of adding a twin.
    const [dup] = await query<{ id: string; origin: string; meta: Record<string, unknown> | null; legacy: boolean }>(
      db,
      sql`SELECT id, origin, meta, (meta->>'lane') IS NULL AS legacy FROM sources
         WHERE project_id = ${projectId} AND content_hash = ${hash} AND kind <> 'attestation' ${sectionFilter}
           AND (NOT ${STALE} OR (origin = 'kb' AND (meta->>'lane') IS NULL))
         ORDER BY legacy ASC LIMIT 1`,
    );
    if (dup?.legacy && dup.origin === "kb" && s.meta.lane) {
      // A row written before lanes existed (a `.md` twin, an old copy): the lane takes it over under the canonical
      // URL with its current classification, so it refreshes and prunes like any lane row (R3-SRC-2).
      await db
        .update(schema.sources)
        .set({ url: s.url, title, kind: s.kind, sourceClass: s.sourceClass, date: s.date ?? null, meta: s.meta, fetchedAt: now })
        .where(eq(schema.sources.id, dup.id));
      return { id: dup.id, status: "updated" };
    }
    if (dup) {
      // Keep the duplicate alive for this run when it belongs to the same lane.
      const m = dup.meta ?? {};
      if (s.meta.runId && m.lane === s.meta.lane && m.runId !== s.meta.runId) {
        await db.execute(sql`UPDATE sources SET meta = jsonb_set(meta, '{runId}', to_jsonb(${String(s.meta.runId)}::text)) WHERE id = ${dup.id}`);
      }
      return { id: dup.id, status: "duplicate_content" };
    }
  }
  await assertBudget(db, projectId, content.length);
  const id = newId();
  await db.insert(schema.sources).values({
    id,
    projectId,
    url: s.url,
    kind: s.kind,
    sourceClass: s.sourceClass,
    origin: "kb",
    httpStatus: 200,
    title,
    contentMd: content,
    contentHash: hash,
    date: s.date ?? null,
    meta: s.meta,
    fetchedAt: now,
  });
  noteWrite(projectId, content.length);
  return { id, status: "inserted" };
}

/** Upserts one knowledge-base source by (project, url). Editor classifications on admin-added sources win. */
export async function storeKbSource(db: DB, projectId: string, s: KbSourceInput): Promise<string> {
  return (await storeKbSourceEx(db, projectId, s)).id;
}

/**
 * Keeps an existing lane row alive for this run without rewriting it: a page that failed to fetch after retries
 * isn't pruned just because one run couldn't reach it (R3-SRC-5). Returns true when a row was stamped.
 */
export async function keepAlive(db: DB, projectId: string, lane: string, runId: string, urls: string[]): Promise<number> {
  const all = [...new Set(urls.flatMap((u) => [u, wwwVariant(u)].filter((x): x is string => !!x)))];
  if (!all.length) return 0;
  return exec(
    db,
    sql`UPDATE sources SET meta = jsonb_set(meta, '{runId}', to_jsonb(${runId}::text))
      WHERE project_id = ${projectId} AND origin = 'kb' AND meta->>'lane' = ${lane} AND url IN (${sql.join(
        all.map((u) => sql`${u}`),
        sql`, `,
      )})`,
  );
}

/** "Cited by any evidence" (EFF-7). */
export const CITED = sql`id IN (SELECT source_id FROM evidence WHERE source_id IS NOT NULL)`;
/** A row search hides: replaced by a newer version, kept because evidence cites it. */
export const STALE = sql`coalesce(meta->'stale' = 'true'::jsonb, false)`;
const MARK_STALE = sql`meta = meta || '{"stale": true}'::jsonb`;

/**
 * After a lane succeeds: deletes its rows that this run didn't touch, and marks cited ones stale (search hides
 * stale rows; evidence keeps pointing at them). Rows written before lanes existed (no lane) in the given sections
 * go the same way when `legacySections` is passed: deleted, or marked stale when cited (R3-SRC-2).
 */
export async function pruneLane(
  db: DB,
  projectId: string,
  lane: string,
  runId: string,
  opts: { legacySections?: Section[] } = {},
): Promise<{ deleted: number; staled: number }> {
  const where = sql`project_id = ${projectId} AND origin = 'kb' AND kind <> 'attestation' AND meta->>'lane' = ${lane} AND coalesce(meta->>'runId', '') <> ${runId}`;
  let deleted = await exec(db, sql`DELETE FROM sources WHERE ${where} AND NOT ${CITED}`);
  let staled = await exec(db, sql`UPDATE sources SET ${MARK_STALE} WHERE ${where} AND ${CITED} AND NOT ${STALE}`);
  for (const section of opts.legacySections ?? []) {
    const legacy = sql`project_id = ${projectId} AND origin = 'kb' AND kind <> 'attestation' AND (meta->>'lane') IS NULL AND meta->>'section' = ${section}`;
    deleted += await exec(db, sql`DELETE FROM sources WHERE ${legacy} AND NOT ${CITED}`);
    staled += await exec(db, sql`UPDATE sources SET ${MARK_STALE} WHERE ${legacy} AND ${CITED} AND NOT ${STALE}`);
  }
  if (deleted) resetBudgetCache(projectId);
  return { deleted, staled };
}

/** Deletes (or, when cited, marks stale) the rows a SQL condition selects. Returns both counts. */
export async function purgeWhere(db: DB, projectId: string, condition: SQL): Promise<{ deleted: number; staled: number }> {
  const where = sql`project_id = ${projectId} AND origin = 'kb' AND kind <> 'attestation' AND (${condition})`;
  const deleted = await exec(db, sql`DELETE FROM sources WHERE ${where} AND NOT ${CITED}`);
  const staled = await exec(db, sql`UPDATE sources SET ${MARK_STALE} WHERE ${where} AND ${CITED} AND NOT ${STALE}`);
  if (deleted) resetBudgetCache(projectId);
  return { deleted, staled };
}

/** Keeps the newest `keep` rows of a lane (by date, then fetch time); older uncited rows are deleted. */
export async function keepNewest(db: DB, projectId: string, lane: string, keep: number): Promise<number> {
  const n = await exec(
    db,
    sql`DELETE FROM sources WHERE id IN (
         SELECT id FROM sources WHERE project_id = ${projectId} AND origin = 'kb' AND kind <> 'attestation' AND meta->>'lane' = ${lane}
         ORDER BY coalesce(date, '') DESC, fetched_at DESC OFFSET ${keep}
       ) AND NOT ${CITED}`,
  );
  if (n) resetBudgetCache(projectId);
  return n;
}

// ---------- maintenance ----------

/**
 * After a refresh: refresh the planner's statistics for the tables a refresh rewrites (autovacuum does the rest).
 * Failures are ignored; the next refresh tries again.
 */
export async function maintainAfterRefresh(db: DB): Promise<void> {
  try {
    await db.execute(sql`ANALYZE sources, source_chunks`);
  } catch {
    // another session may hold a conflicting lock; not worth failing a refresh over
  }
}
