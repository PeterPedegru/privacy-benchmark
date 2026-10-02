import { sql } from "drizzle-orm";
import { type DB, query } from "../db/index.ts";
import { type ExtractorState, extractionStatus } from "../lib/extract-pool.ts";

export interface HealthReport {
  /** The server can serve: the database answers. */
  ok: boolean;
  db: "ok" | "error";
  queue: { running: number; queued: number; oldestRunningSeconds: number | null } | null;
  /** "failed" means the boot self-test failed: logged as an error and caught by the post-deploy smoke test. */
  extraction: { html: ExtractorState; pdf: ExtractorState };
}

/**
 * What /api/health reports (R3-REL-15, R3-SEC-11): the database answers a query, the evaluation queue's state, and
 * whether extraction runs where it should. Unhealthy (503) only when the database fails: the volume-backed service
 * stops the old deployment before starting a new one, so failing the healthcheck over an extractor would take the
 * public site down for a problem that only affects knowledge-base refreshes. Counts and states only: no ids, paths,
 * errors or settings.
 */
export async function healthReport(getDb: () => DB, now = Date.now()): Promise<HealthReport> {
  let db: DB | null = null;
  let queue: HealthReport["queue"] = null;
  try {
    db = getDb();
    const rows = await query<{ status: string; n: number; oldest: string | null }>(
      db,
      sql`SELECT status, count(*)::int AS n, min(started_at) AS oldest FROM evaluations WHERE status IN ('queued', 'running') GROUP BY status`,
    );
    const running = rows.find((r) => r.status === "running");
    const oldest = running?.oldest ? Date.parse(running.oldest) : Number.NaN;
    queue = {
      running: running?.n ?? 0,
      queued: rows.find((r) => r.status === "queued")?.n ?? 0,
      oldestRunningSeconds: Number.isFinite(oldest) ? Math.max(0, Math.round((now - oldest) / 1000)) : null,
    };
  } catch {
    db = null;
  }
  const { html, pdf } = extractionStatus();
  return { ok: !!db, db: db ? "ok" : "error", queue, extraction: { html, pdf } };
}
