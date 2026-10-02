/**
 * Knowledge-base maintenance that runs once at boot, before the evaluation worker starts:
 *
 * - R3-REL-10: a refresh can't survive a restart, so a `refreshing` status left by the previous process becomes
 *   `error` ("Interrupted by a restart"), or `empty` when the project never had a knowledge base.
 * - R3-SRC-2: rows written before the lane rewrite (`origin = 'kb'` with no `meta.lane`) kept the classes of the
 *   old rules, and cited ones were never marked stale. Each is run through today's classifier: drops are deleted
 *   (or marked stale when evidence cites them), the rest get the current kind and class, and every one is marked
 *   stale so search hides it while evidence still resolves. Lanes re-fetch what is still needed, and a lane that
 *   meets one of these rows as a duplicate adopts it. Idempotent: a per-project marker in `kb_meta.maintenance`
 *   records that the cleanup ran, and a later run only touches legacy rows that are still unprocessed.
 * - R4-12: the demo import wrote golden files' classes as editor rows, which outrank the knowledge base. Seeded rows
 *   no editor has reclassified get today's class from the classifier, once per project and SEED_RECLASSIFY_VERSION.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../db/index.ts";
import { exec, query, schema } from "../db/index.ts";
import { classifyUrl, type Lane } from "./classify.ts";
import { type GoldenFile, loadGoldenFiles, seedMarkOf } from "./golden.ts";
import { CITED, resetBudgetCache, type Section } from "./kb-store.ts";
import type { KbMeta } from "./lanes/context.ts";
import { ownershipFor } from "./ownership.ts";

/** Bump to re-run the legacy cleanup after a classifier change that legacy rows must see. */
export const LEGACY_CLEANUP_VERSION = "r3-src-2";
/** Bump to reclassify demo-seeded rows again after a classifier change they must see (R4-12). */
export const SEED_RECLASSIFY_VERSION = "r4-12";

type MaintenanceMeta = KbMeta & { maintenance?: Record<string, string> };

/** Whether a project has had this version of a once-per-project maintenance task. */
function maintained(p: { kbMeta: unknown }, task: string, version: string): boolean {
  return ((p.kbMeta ?? {}) as MaintenanceMeta).maintenance?.[task] === version;
}

/** Records in `kb_meta.maintenance` that a task ran for a project, in one statement (a refresh may write kb_meta too). */
async function markMaintained(db: DB, projectId: string, task: string, version: string): Promise<void> {
  await db.execute(
    sql`UPDATE projects SET kb_meta = jsonb_set(kb_meta, '{maintenance}', coalesce(kb_meta->'maintenance', '{}'::jsonb) || jsonb_build_object(${task}::text, ${version}::text))
      WHERE id = ${projectId}`,
  );
}

const LANE_FOR_SECTION: Record<Section, Lane> = {
  docs: "docs",
  website: "website",
  code: "code",
  changes: "changes",
  announcements: "announcements",
  news: "news",
  analysis: "analysis",
  data: "data",
  audits: "audits",
  addresses: "addresses",
  forum: "forum",
};

/** Third-party sections, where a page must still be about the project to be kept. */
const GATED = new Set<string>(["news", "analysis", "audits"]);

/** A refresh whose runner hasn't reported for this long is taken to be dead. */
export const REFRESH_HEARTBEAT_STALE_MS = 10 * 60_000;

/**
 * Resets refresh statuses no process is working on (R3-REL-10). A refresh can run in another process, such as the
 * editor's local knowledge-base CLI writing to production, so only refreshes whose heartbeat (`kb_meta.heartbeatAt`,
 * written every minute while a refresh runs) has gone stale are reset. Returns how many projects were reset.
 */
export async function resetInterruptedRefreshes(db: DB, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - REFRESH_HEARTBEAT_STALE_MS).toISOString();
  return exec(
    db,
    sql`UPDATE projects SET kb_status = CASE WHEN kb_refreshed_at IS NULL THEN 'empty' ELSE 'error' END, kb_error = 'Interrupted: the refresh stopped reporting'
       WHERE kb_status = 'refreshing' AND coalesce(kb_meta->>'heartbeatAt', '') < ${cutoff}`,
  );
}

export interface LegacyCleanup {
  projects: number;
  reclassified: number;
  deleted: number;
  staled: number;
}

/** Reclassifies and hides one project's pre-lane rows (R3-SRC-2). Pure SQL plus the classifier; no network. */
export async function cleanupLegacyRows(db: DB, projectId: string): Promise<Omit<LegacyCleanup, "projects">> {
  const own = await ownershipFor(db, projectId);
  const rows = await query<{ id: string; url: string; title: string; kind: string; sourceClass: string; text: string; section: string | null; cited: boolean }>(
    db,
    sql`SELECT id, url, title, kind, source_class AS "sourceClass", substr(content_md, 1, 4000) AS text, meta->>'section' AS section,
              ${CITED} AS cited
       FROM sources WHERE project_id = ${projectId} AND origin = 'kb' AND kind <> 'attestation' AND (meta->>'lane') IS NULL`,
  );
  let reclassified = 0;
  let deleted = 0;
  let staled = 0;
  await db.transaction(async (tx) => {
    for (const r of rows) {
      let kind = r.kind;
      let sourceClass = r.sourceClass;
      let drop = false;
      if (/^https?:\/\//i.test(r.url)) {
        const section = (r.section ?? "analysis") as Section;
        const c = classifyUrl(r.url, LANE_FOR_SECTION[section] ?? "analysis", {
          ...own,
          title: r.title,
          text: r.text,
          requireRelevance: GATED.has(section),
        });
        if (c.drop) drop = true;
        else {
          kind = c.kind;
          sourceClass = c.sourceClass;
        }
      }
      if (drop && !r.cited) {
        deleted += await exec(tx as unknown as DB, sql`DELETE FROM sources WHERE id = ${r.id}`);
        continue;
      }
      if (kind !== r.kind || sourceClass !== r.sourceClass) reclassified++;
      staled += await exec(
        tx as unknown as DB,
        sql`UPDATE sources SET kind = ${kind}, source_class = ${sourceClass}, meta = meta || '{"stale": true, "legacy": true}'::jsonb WHERE id = ${r.id}`,
      );
    }
  });
  if (deleted) resetBudgetCache(projectId);
  return { reclassified, deleted, staled };
}

/** Runs the legacy cleanup for every project that hasn't had this version of it. */
export async function cleanupLegacyRowsOnce(db: DB): Promise<LegacyCleanup> {
  const out: LegacyCleanup = { projects: 0, reclassified: 0, deleted: 0, staled: 0 };
  for (const p of await db.select({ id: schema.projects.id, kbMeta: schema.projects.kbMeta }).from(schema.projects)) {
    if (maintained(p, "legacyCleanup", LEGACY_CLEANUP_VERSION)) continue;
    const r = await cleanupLegacyRows(db, p.id);
    out.projects++;
    out.reclassified += r.reclassified;
    out.deleted += r.deleted;
    out.staled += r.staled;
    await markMaintained(db, p.id, "legacyCleanup", LEGACY_CLEANUP_VERSION);
  }
  return out;
}

export interface SeedReclassify {
  projects: number;
  /** Rows seeded before seed marks existed, recognised and marked now. */
  marked: number;
  reclassified: number;
  /** Evidence rows in unpublished evaluations that took their source's new class. */
  evidence: number;
}

/**
 * Brings one project's demo-seeded editor rows in line with today's classifier (R4-12). Rows an editor added or
 * reclassified by hand keep their class (seedMarkOf tells them apart), and so does a page the classifier would
 * drop: the golden file chose it. Evidence citing a reclassified row in an evaluation that isn't published takes the
 * new class, so evidence and source agree (R4-8); published snapshots stay as they are. SQL plus the classifier.
 */
export async function reclassifySeededRows(db: DB, projectId: string, golden?: GoldenFile): Promise<Omit<SeedReclassify, "projects">> {
  const out = { marked: 0, reclassified: 0, evidence: 0 };
  const project = (await db.select({ slug: schema.projects.slug }).from(schema.projects).where(eq(schema.projects.id, projectId)))[0];
  if (!project) return out;
  const own = await ownershipFor(db, projectId);
  const goldenByUrl = new Map((golden?.sources ?? []).map((s) => [s.url, s]));
  const rows = await db
    .select({
      id: schema.sources.id,
      url: schema.sources.url,
      title: schema.sources.title,
      kind: schema.sources.kind,
      origin: schema.sources.origin,
      sourceClass: schema.sources.sourceClass,
      meta: schema.sources.meta,
    })
    .from(schema.sources)
    .where(and(eq(schema.sources.projectId, projectId), eq(schema.sources.origin, "admin")));
  await db.transaction(async (tx) => {
    for (const r of rows) {
      if (r.kind === "editor_note") continue;
      const mark = seedMarkOf(r, project.slug, goldenByUrl.get(r.url));
      if (!mark) continue;
      let next = r.sourceClass;
      if (/^https?:\/\//i.test(r.url)) {
        const c = classifyUrl(r.url, "agent", { ...own, title: r.title });
        if (!c.drop) next = c.sourceClass;
      }
      const hadMark = !!(r.meta as { seed?: unknown } | null)?.seed;
      if (next === r.sourceClass && hadMark) continue;
      await tx.execute(
        sql`UPDATE sources SET source_class = ${next}, meta = jsonb_set(meta, '{seed}', ${JSON.stringify({ ...mark, sourceClass: next })}::jsonb) WHERE id = ${r.id}`,
      );
      if (!hadMark) out.marked++;
      if (next === r.sourceClass) continue;
      out.reclassified++;
      // Evidence follows in syncEvidenceClasses (run at boot right after), which flags answers whose weight moved.
    }
  });
  return out;
}

/** Runs the seed reclassification for every project that hasn't had this version of it (R4-12). */
export async function reclassifySeededRowsOnce(db: DB, goldens: GoldenFile[] = loadGoldenFiles()): Promise<SeedReclassify> {
  const out: SeedReclassify = { projects: 0, marked: 0, reclassified: 0, evidence: 0 };
  const bySlug = new Map(goldens.map((g) => [g.project.slug, g]));
  for (const p of await db.select({ id: schema.projects.id, slug: schema.projects.slug, kbMeta: schema.projects.kbMeta }).from(schema.projects)) {
    if (maintained(p, "seedReclassify", SEED_RECLASSIFY_VERSION)) continue;
    const r = await reclassifySeededRows(db, p.id, bySlug.get(p.slug));
    out.projects++;
    out.marked += r.marked;
    out.reclassified += r.reclassified;
    out.evidence += r.evidence;
    await markMaintained(db, p.id, "seedReclassify", SEED_RECLASSIFY_VERSION);
  }
  return out;
}

/** Boot-time knowledge-base maintenance. Never throws: a failure is logged and the server starts anyway. */
/**
 * L2BEAT's GitHub configs are independent L2BEAT data (R4-28); rows stored before the classifier knew that keep a
 * weaker class, which the evidence sync would then copy into evidence (R5-8). Idempotent; editor rows untouched.
 */
export async function reclassifyL2beatRows(db: DB): Promise<number> {
  return exec(
    db,
    sql`UPDATE sources SET kind = 'l2beat', source_class = 'independent'
       WHERE origin <> 'admin' AND (source_class <> 'independent' OR kind <> 'l2beat')
         AND (url LIKE 'https://github.com/l2beat/l2beat/%' OR url LIKE 'https://raw.githubusercontent.com/l2beat/l2beat/%')`,
  );
}

export async function runKbBootMaintenance(db: DB, log: (m: string) => void = console.log): Promise<void> {
  try {
    const l2 = await reclassifyL2beatRows(db);
    if (l2) log(`[kb] ${l2} L2BEAT GitHub row(s) reclassified as independent L2BEAT data`);
  } catch (e) {
    log(`[kb] couldn't reclassify L2BEAT rows: ${(e as Error).message}`);
  }
  try {
    const reset = await resetInterruptedRefreshes(db);
    if (reset) log(`[kb] ${reset} knowledge-base refresh(es) were interrupted by a restart; marked as failed`);
  } catch (e) {
    log(`[kb] couldn't reset interrupted refreshes: ${(e as Error).message}`);
  }
  try {
    const r = await cleanupLegacyRowsOnce(db);
    if (r.projects && (r.reclassified || r.deleted || r.staled))
      log(`[kb] legacy cleanup: ${r.reclassified} rows reclassified, ${r.deleted} deleted, ${r.staled} hidden (marked stale) across ${r.projects} project(s)`);
  } catch (e) {
    log(`[kb] legacy cleanup failed: ${(e as Error).message}`);
  }
  try {
    const r = await reclassifySeededRowsOnce(db);
    if (r.marked || r.reclassified)
      log(`[kb] demo-seeded sources: ${r.reclassified} reclassified, ${r.marked} older seeds recognised, across ${r.projects} project(s)`);
  } catch (e) {
    log(`[kb] seeded-source reclassification failed: ${(e as Error).message}`);
  }
}
