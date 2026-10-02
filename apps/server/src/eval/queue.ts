import { rubric, suites } from "@pb/rubric";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type DB, query, schema } from "../db/index.ts";
import { env } from "../env.ts";
import { newId } from "../lib/ids.ts";
import { hasApiKey } from "../lib/llm.ts";
import { redact } from "../lib/redact.ts";
import { RUNNER_ID } from "../lib/runner.ts";
import { isUniqueViolation } from "../services/kb-store.ts";
import { latestTrackedVersion } from "../services/versions.ts";
import { makeEmitter } from "./events.ts";
import { evalSettings, type Mode, runEvaluation } from "./pipeline.ts";

export interface EnqueueInput {
  projectIds: string[];
  /** Optional version per project id; defaults to the latest tracked version. */
  versions?: Record<string, string | null>;
  mode: Mode;
  suites?: string[];
  label?: string;
}

export async function enqueueRun(db: DB, input: EnqueueInput): Promise<string> {
  if (!hasApiKey()) throw new Error("ANTHROPIC_API_KEY is not set. Add it to apps/server/.env to run evaluations.");
  const runId = newId();
  const suiteFilter = input.suites?.filter((s) => suites.some((x) => x.id === s)) ?? null;
  // Versions are resolved before the transaction: a query outside it would wait on it (PGlite has one connection).
  const versionOf = new Map<string, string | null>();
  for (const projectId of input.projectIds) {
    const explicit = input.versions?.[projectId];
    versionOf.set(projectId, explicit === undefined ? ((await latestTrackedVersion(db, projectId))?.id ?? null) : explicit);
  }
  await db.transaction(async (tx) => {
    await tx.insert(schema.runs).values({
      id: runId,
      label: input.label ?? "",
      rubricVersion: rubric.version,
      mode: input.mode,
      suiteFilter: suiteFilter?.length ? suiteFilter : null,
      status: "queued",
    });
    for (const projectId of input.projectIds) {
      const versionId = versionOf.get(projectId) ?? null;
      await tx.insert(schema.evaluations).values({
        id: newId(),
        runId,
        projectId,
        versionId,
        mode: input.mode,
        suiteFilter: suiteFilter?.length ? suiteFilter : null,
        status: "queued",
        stage: "scout",
        settings: evalSettings(input.mode) as never,
      });
    }
  });
  await kick(db);
  return runId;
}

/**
 * Resumes a failed or cancelled evaluation from where it stopped: completed stages and finished suites are kept,
 * so a transient failure (e.g. the API was overloaded) doesn't mean paying for the whole run again.
 */
export async function resumeEvaluation(db: DB, evaluationId: string) {
  const ev = (await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, evaluationId)))[0];
  if (!ev) throw new Error("Evaluation not found");
  if (running.has(evaluationId)) throw new Error("This evaluation is still stopping; try again in a moment.");
  if (!["failed", "cancelled"].includes(ev.status)) throw new Error(`Only failed or cancelled evaluations can be resumed (this one is ${ev.status}).`);
  // Resumed here, it's the server's run now: if this process dies, it's re-queued like any other (not failed as local).
  await db
    .update(schema.evaluations)
    .set({ status: "queued", error: null, finishedAt: null, settings: sql`settings - 'local'` })
    .where(eq(schema.evaluations.id, evaluationId));
  if (ev.runId) await db.update(schema.runs).set({ status: "running", finishedAt: null }).where(eq(schema.runs.id, ev.runId));
  await kick(db);
}

/** Re-runs selected suites of an existing evaluation (research, judge, code check, verify and score for those suites). */
/**
 * Re-running suites rewrites criterion results and evidence, so only finished, unpublished work can be re-run (a
 * published evaluation is frozen in its release).
 */
export const RERUNNABLE = ["review", "reviewed", "failed", "cancelled"];

/**
 * What re-running some suites changes on an evaluation: they're researched, code-checked and judged again, the stages
 * after them run again, and they need reviewing again. Shared by the admin's rerun and `pnpm bench rerun`.
 */
export function rerunChanges(ev: typeof schema.evaluations.$inferSelect, suiteIds: string[]) {
  const settings = { ...(ev.settings as Record<string, unknown>) };
  const keep = (key: string) => ((settings[key] as string[]) ?? []).filter((s) => !suiteIds.includes(s));
  return {
    stage: "research",
    error: null,
    completedStages: ev.completedStages.filter((s) => ["ingest", "scout", "code"].includes(s)),
    settings: {
      ...settings,
      research: keep("research"),
      judge: keep("judge"),
      codecheck: keep("codecheck"),
      // Rerun suites are researched again, so an earlier "not researched" no longer applies (R3-REL-1).
      unresearched: keep("unresearched"),
      // The rerun's own spending allowance on top of what's been spent (R4-2): a quarter of the mode's cap for verify and
      // score, plus a share for the suites researched again.
      capBase: ev.costUsd,
      capScale: 0.25 + (0.75 * suiteIds.length) / suites.length,
    } as Record<string, unknown>,
    // Rerun suites need reviewing again (R4-26).
    reviewedSuites: ev.reviewedSuites.filter((s) => !suiteIds.includes(s)),
  };
}

export async function rerunSuites(db: DB, evaluationId: string, suiteIds: string[]) {
  const ev = (await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, evaluationId)))[0];
  if (!ev) throw new Error("Evaluation not found");
  if (running.has(evaluationId)) throw new Error("This evaluation is still running or stopping; try again when it has stopped.");
  if (!RERUNNABLE.includes(ev.status)) throw new Error(`Suites can only be re-run on an evaluation in review, failed or cancelled (this one is ${ev.status}).`);
  const change = rerunChanges(ev, suiteIds);
  delete change.settings.local; // the server runs it now
  await db
    .update(schema.evaluations)
    .set({ ...change, status: "queued" })
    .where(eq(schema.evaluations.id, evaluationId));
  await kick(db);
}

/** Evaluations this process is running, with their project (one evaluation per project at a time) and abort. */
const running = new Map<string, { projectId: string; ctl: AbortController }>();

/** True while this process is still running the evaluation (its runner hasn't returned yet), whatever its status says. */
export function isRunning(evaluationId: string): boolean {
  return running.has(evaluationId);
}

/**
 * True while an evaluation of this project is running, here or in any other process (a replica, or the local
 * CLI): its knowledge base must not change under it (R4-7). Evaluations whose runner stopped reporting don't count.
 */
export async function projectBusy(db: DB, projectId: string, now = Date.now()): Promise<boolean> {
  if ([...running.values()].some((r) => r.projectId === projectId)) return true;
  const cutoff = new Date(now - HEARTBEAT_STALE_MS).toISOString();
  const [row] = await db
    .select({ id: schema.evaluations.id })
    .from(schema.evaluations)
    .where(and(eq(schema.evaluations.projectId, projectId), eq(schema.evaluations.status, "running"), sql`coalesce(heartbeat_at, '') >= ${cutoff}`))
    .limit(1);
  return !!row;
}

let polling: NodeJS.Timeout | null = null;
/** Set during shutdown: nothing new starts, in-flight evaluations get a short grace period. */
let stopping = false;

/** Derives a run's status and cost from its evaluations. */
export async function updateRunStatus(db: DB, runId: string | null) {
  if (!runId) return;
  const evs = await db.select().from(schema.evaluations).where(eq(schema.evaluations.runId, runId));
  const cost = evs.reduce((s, e) => s + e.costUsd, 0);
  const active = evs.some((e) => e.status === "queued" || e.status === "running");
  const status = active ? "running" : evs.every((e) => e.status === "failed") ? "failed" : evs.every((e) => e.status === "cancelled") ? "cancelled" : "review";
  await db
    .update(schema.runs)
    .set({ status, costUsd: cost, finishedAt: active ? null : new Date().toISOString() })
    .where(eq(schema.runs.id, runId));
}

export { RUNNER_ID };
/** A running evaluation whose runner hasn't reported for this long is taken to be dead (crash, OOM) and re-queued. */
export const HEARTBEAT_STALE_MS = 3 * 60_000;
export const HEARTBEAT_EVERY_MS = 30_000;

/**
 * Claims the oldest queued evaluation of a project with nothing running, for this process. Safe across replicas:
 * the row is locked and skipped by other claimers, and a partial unique index allows one running evaluation per
 * project (a concurrent claim for the same project fails and the next candidate is tried).
 */
async function claimNext(db: DB): Promise<typeof schema.evaluations.$inferSelect | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const now = new Date().toISOString();
      const [row] = await query<{ id: string }>(
        db,
        sql`UPDATE evaluations SET status = 'running', started_at = coalesce(started_at, ${now}), runner_id = ${RUNNER_ID}, heartbeat_at = ${now}
          WHERE id = (
            SELECT e.id FROM evaluations e
            WHERE e.status = 'queued'
              AND NOT EXISTS (SELECT 1 FROM evaluations r WHERE r.project_id = e.project_id AND r.status = 'running')
            ORDER BY e.created_at, e.id
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id`,
      );
      if (!row) return null;
      return (await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, row.id)))[0] ?? null;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  return null;
}

/**
 * The runner returned: releases this process's claim on the evaluation and re-derives its run. A run that returned
 * without a final status (it always writes one) is failed rather than left looking busy.
 */
export async function releaseClaim(db: DB, evaluationId: string, runId: string | null) {
  await db.execute(
    sql`UPDATE evaluations SET
        status = CASE WHEN status = 'running' THEN 'failed' ELSE status END,
        error = CASE WHEN status = 'running' THEN 'The runner stopped without finishing; resume it to continue.' ELSE error END,
        runner_id = NULL, heartbeat_at = NULL
      WHERE id = ${evaluationId} AND runner_id = ${RUNNER_ID}`,
  );
  await updateRunStatus(db, runId);
}

/** Starts queued evaluations up to this process's concurrency limit. */
export async function kick(db: DB) {
  if (stopping) return;
  await requeueInterrupted(db);
  while (!stopping && running.size < env.maxConcurrentProjects) {
    const ev = await claimNext(db);
    if (!ev) break;
    const ctl = new AbortController();
    running.set(ev.id, { projectId: ev.projectId, ctl });
    await updateRunStatus(db, ev.runId);
    const beat = setInterval(() => {
      void db
        .execute(sql`UPDATE evaluations SET heartbeat_at = ${new Date().toISOString()} WHERE id = ${ev.id} AND runner_id = ${RUNNER_ID}`)
        .catch((e) => console.error(`[eval] heartbeat for ${ev.id} failed: ${(e as Error).message}`));
    }, HEARTBEAT_EVERY_MS);
    beat.unref();
    runEvaluation(db, ev.id, { signal: ctl.signal })
      .catch((e) => console.error(`[eval] ${ev.id} failed:`, redact((e as Error).message)))
      .finally(async () => {
        clearInterval(beat);
        running.delete(ev.id);
        try {
          await releaseClaim(db, ev.id, ev.runId);
          await kick(db);
        } catch (e) {
          console.error(`[eval] after ${ev.id}: ${(e as Error).message}`);
        }
      });
  }
}

export async function cancelEvaluation(db: DB, evaluationId: string) {
  await db
    .update(schema.evaluations)
    .set({ status: "cancelled" })
    .where(and(eq(schema.evaluations.id, evaluationId), inArray(schema.evaluations.status, ["queued", "running"])));
  // Stop paying for calls already in flight, not just the next ones (R3-REL-11).
  running.get(evaluationId)?.ctl.abort("Cancelled");
}

export async function cancelRun(db: DB, runId: string) {
  const ids = await db.select({ id: schema.evaluations.id }).from(schema.evaluations).where(eq(schema.evaluations.runId, runId));
  await db
    .update(schema.evaluations)
    .set({ status: "cancelled" })
    .where(and(eq(schema.evaluations.runId, runId), inArray(schema.evaluations.status, ["queued", "running"])));
  for (const { id } of ids) running.get(id)?.ctl.abort("Cancelled");
  await updateRunStatus(db, runId);
}

/**
 * Evaluations marked "running" that this process isn't running were interrupted (deploy, crash, OOM). They go back
 * to the queue and resume from their last completed stage; their runs are re-derived so none stays "running" forever.
 */
/** An evaluation interrupted this many times in a row is failed instead of re-queued: it may be what crashes us. */
const MAX_INTERRUPTIONS = 2;

export async function requeueInterrupted(db: DB, now = Date.now()): Promise<number> {
  // Running here, or reported recently by another process (a replica): not interrupted.
  const cutoff = new Date(now - HEARTBEAT_STALE_MS).toISOString();
  const stuck = (
    await db
      .select({ id: schema.evaluations.id, runId: schema.evaluations.runId, stage: schema.evaluations.stage, settings: schema.evaluations.settings })
      .from(schema.evaluations)
      .where(and(eq(schema.evaluations.status, "running"), sql`coalesce(heartbeat_at, '') < ${cutoff}`))
  ).filter((e) => !running.has(e.id));
  if (!stuck.length) return 0;
  for (const e of stuck) {
    const settings = e.settings as Record<string, unknown>;
    const interruptions = Number(settings.interruptions ?? 0) + 1;
    const emit = makeEmitter(db, e.id, e.runId);
    // A run started from the local CLI stays local: the server doesn't pick it up (and spend on it) when the laptop
    // stops reporting. It's failed, and resumed locally (or from the admin) when wanted.
    if (settings.local) {
      await db
        .update(schema.evaluations)
        .set({
          status: "failed",
          error: "The local run stopped reporting (laptop asleep or the CLI closed). Resume it with `pnpm bench resume`.",
          finishedAt: new Date().toISOString(),
          runnerId: null,
        })
        .where(and(eq(schema.evaluations.id, e.id), eq(schema.evaluations.status, "running")));
      emit("error", e.stage, "The local run stopped reporting; marked failed. Resume it with `pnpm bench resume`.");
      continue;
    }
    // A crash during an evaluation (an out-of-memory page, say) would otherwise restart into the same crash
    // forever, and the hosting platform gives up restarting after a few (R3-SEC-1).
    if (interruptions > MAX_INTERRUPTIONS) {
      await db
        .update(schema.evaluations)
        .set({
          status: "failed",
          error: `Interrupted by ${interruptions} restarts in a row during ${e.stage}; not resumed automatically in case it caused them. Resume it manually.`,
          finishedAt: new Date().toISOString(),
          settings: { ...settings, interruptions: 0 },
        })
        .where(and(eq(schema.evaluations.id, e.id), eq(schema.evaluations.status, "running")));
      emit("error", e.stage, `Interrupted by ${interruptions} restarts in a row; marked failed instead of resuming automatically.`);
      continue;
    }
    await db
      .update(schema.evaluations)
      .set({ status: "queued", runnerId: null, settings: { ...settings, interruptions } })
      .where(and(eq(schema.evaluations.id, e.id), eq(schema.evaluations.status, "running")));
    emit("warn", e.stage, "The process running this evaluation stopped reporting; it was re-queued and resumes from its last completed stage.");
  }
  for (const runId of new Set(stuck.map((e) => e.runId))) await updateRunStatus(db, runId);
  return stuck.length;
}

/** On boot, anything left "running" by a previous process resumes from its last completed stage. */
export async function startWorker(db: DB) {
  stopping = false;
  const n = await requeueInterrupted(db);
  if (n) console.log(`[eval] re-queued ${n} evaluation(s) interrupted by a restart`);
  if (!hasApiKey()) return;
  await kick(db);
  if (!polling) {
    polling = setInterval(() => kick(db), 5000);
    polling.unref();
  }
}

/**
 * Graceful shutdown: start nothing new, give in-flight evaluations up to `graceMs` to finish, then put the rest back
 * in the queue so the next process resumes them from their last completed stage (completed stages and finished
 * suites are already persisted). Returns the evaluations that were interrupted.
 */
export async function stopWorker(db: DB, graceMs = 10_000, opts: { crashed?: boolean } = {}): Promise<string[]> {
  stopping = true;
  if (polling) clearInterval(polling);
  polling = null;
  const deadline = Date.now() + graceMs;
  while (running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  const left = [...running.keys()];
  if (left.length) {
    const rows = await db
      .select({ id: schema.evaluations.id, runId: schema.evaluations.runId, stage: schema.evaluations.stage, settings: schema.evaluations.settings })
      .from(schema.evaluations)
      .where(and(inArray(schema.evaluations.id, left), eq(schema.evaluations.status, "running"), eq(schema.evaluations.runnerId, RUNNER_ID)));
    for (const e of rows) {
      const emit = makeEmitter(db, e.id, e.runId);
      const settings = e.settings as Record<string, unknown>;
      // A crash (uncaught error) counts toward the crash-loop limit like an out-of-memory kill does (R4-6).
      const interruptions = Number(settings.interruptions ?? 0) + (opts.crashed ? 1 : 0);
      if (opts.crashed && interruptions > MAX_INTERRUPTIONS) {
        await db
          .update(schema.evaluations)
          .set({
            status: "failed",
            error: `The server crashed ${interruptions} times in a row during ${e.stage}; not resumed automatically in case this evaluation caused it. Resume it manually.`,
            finishedAt: new Date().toISOString(),
            settings: { ...settings, interruptions: 0 },
          })
          .where(and(eq(schema.evaluations.id, e.id), eq(schema.evaluations.status, "running")));
        emit("error", e.stage, `The server crashed ${interruptions} times in a row; marked failed instead of resuming automatically.`);
        await updateRunStatus(db, e.runId);
        continue;
      }
      await db
        .update(schema.evaluations)
        .set({ status: "queued", runnerId: null, settings: { ...settings, interruptions } })
        .where(and(eq(schema.evaluations.id, e.id), eq(schema.evaluations.status, "running")));
      emit("warn", e.stage, "The server is restarting; this evaluation will resume from its last completed stage.");
    }
    // Re-queued first, so the runner sees "queued" and leaves the status alone; then its in-flight calls stop.
    for (const id of left) running.get(id)?.ctl.abort("Server restarting");
  }
  return left;
}
