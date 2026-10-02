import "./boot.ts";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { backupBeforeMigrating, startDailyBackups, stopDailyBackups } from "./db/backup.ts";
import { importFromSqliteIfNeeded } from "./db/import-sqlite.ts";
import { closeDb, type DB, databaseUrl, initDb, schema, withAdvisoryLock } from "./db/index.ts";
import { env } from "./env.ts";
import { startWorker, stopWorker } from "./eval/queue.ts";
import { checkSecretsAtBoot } from "./lib/auth.ts";
import { hasExa, hasNews, hasX } from "./lib/externals.ts";
import { checkExtraction } from "./lib/extract-pool.ts";
import { hasApiKey, verifyApiKey } from "./lib/llm.ts";
import { redact } from "./lib/redact.ts";
import { ensureSeedVersion, purgeDemo, seedDemo, upsertProjectFromGolden } from "./services/demo.ts";
import { invalidateOffchainAttestations, syncEvidenceClasses } from "./services/evidence-classes.ts";
import { loadGoldenFiles } from "./services/golden.ts";
import { runKbBootMaintenance } from "./services/kb-maintenance.ts";
import { startVersionScheduler, stopVersionScheduler } from "./services/versions.ts";

if (!checkSecretsAtBoot()) process.exit(1);

// Postgres in production; PGlite (in-process, on disk under data/pglite) for local development without a server, or
// when PGLITE_DIR is set explicitly (the production-bundle test).
if (env.isProd && !databaseUrl() && !process.env.PGLITE_DIR) {
  console.error("[db] DATABASE_URL is not set: production runs on Postgres (set PGLITE_DIR to run on PGlite deliberately). Not starting.");
  process.exit(1);
}
// Migrations run here, after an export when the database has data, in one transaction, and are verified before and
// after (R3-REL-6, R3-REL-13). Refusing to start leaves the data as it was.
let db: DB;
try {
  db = await initDb({ beforeMigrating: (d, pending) => backupBeforeMigrating(d, pending) });
  // First boot on Postgres: the SQLite database the app ran on before is copied in, once (2026-10).
  const imported = await importFromSqliteIfNeeded(db, env.dbPath);
  if (!imported.imported && imported.reason !== "already imported" && imported.reason !== "no SQLite database")
    console.log(`[import] not importing ${env.dbPath}: ${imported.reason}`);
} catch (e) {
  console.error(`[db] ${(e as Error).message}`);
  console.error("[db] not starting: the database was left as it was.");
  process.exit(1);
}
// Extraction self-test (R3-SEC-11), in parallel with the rest of boot: a bundle missing its worker or PDF child is a
// startup error, reported by /api/health and failed by the post-deploy smoke test, never a silent fallback.
const extractionCheck = checkExtraction();

// One replica runs the boot maintenance; others starting at the same time skip it.
await withAdvisoryLock(db, "boot-maintenance", async () => {
  if (env.seedDemo) {
    // Opt-in (SEED_DEMO=1): load the hand-labelled demo release when the database has no releases yet.
    if (!(await db.select().from(schema.releases).limit(1))[0]) {
      const r = await seedDemo(db);
      if (r.releaseId) console.log(`[seed] demo release published with ${r.projects} projects`);
    }
  } else {
    const purged = await purgeDemo(db);
    if (purged.releases || purged.evaluations)
      console.log(`[demo] removed ${purged.releases} demo release(s) and ${purged.evaluations} demo evaluation(s); only live evaluations are shown`);
    // Projects stay; they need a live evaluation before anything is published.
    if (!(await db.select().from(schema.projects).limit(1))[0]) {
      for (const g of loadGoldenFiles()) {
        const id = await upsertProjectFromGolden(db, g);
        await ensureSeedVersion(db, id, g.project.slug);
      }
    }
  }
  // Before the worker starts: refreshes nobody is running are reset (R3-REL-10), and pre-lane rows get today's classes (R3-SRC-2).
  await runKbBootMaintenance(db);
  // Evidence in unpublished evaluations takes its source's current class (R4-8).
  const offchain = await invalidateOffchainAttestations(db);
  if (offchain) console.log(`[kb] ${offchain} search attestation(s) on off-chain powers are no longer evidence; affected answers are flagged for review`);
  const reclassified = await syncEvidenceClasses(db);
  if (reclassified) console.log(`[kb] ${reclassified} evidence record(s) took their source's new class; affected answers are flagged for review`);
});
startDailyBackups(db);
await startWorker(db);
await startVersionScheduler(db);
void verifyApiKey().then((k) => {
  if (k.state === "ok") console.log("[anthropic] API key accepted");
  else if (k.state === "rejected") console.log(`[anthropic] API key rejected: ${k.message}`);
});

const extraction = await extractionCheck;
console.log(`[extract] html: ${extraction.html} · pdf: ${extraction.pdf}`);

const server = serve({ fetch: createApp().fetch, port: env.port }, (info) => {
  console.log(`Privacy Benchmark API on http://localhost:${info.port}`);
  if (!hasApiKey()) console.log("  ANTHROPIC_API_KEY not set: evaluations, release triage and summaries are disabled.");
  console.log(
    `  Knowledge-base sources: GitHub ${env.githubToken ? "token" : "anonymous (60 req/h)"} · Exa ${hasExa() ? "on" : "off"} · NewsAPI.ai ${hasNews() ? "on" : "off"} · X ${hasX() ? "on" : "off"}`,
  );
  if (!env.adminPassword) console.log("  ADMIN_PASSWORD not set: the admin dashboard is locked. Add it to apps/server/.env.");
});

/**
 * Graceful shutdown (EFF-34). Deploys send SIGTERM: stop accepting requests and starting evaluations, give running
 * evaluations a few seconds, re-queue the rest (they resume from their last completed stage on the next boot),
 * close the database, and exit well inside Railway's draining window (`drainingSeconds` in .railway/railway.ts).
 */
const SHUTDOWN_DEADLINE_MS = 20_000;
let shuttingDown = false;

/** Exit code 0 for a requested stop (deploys); non-zero after a crash, so Railway's ON_FAILURE policy restarts it. */
async function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received; finishing up`);
  const force = setTimeout(() => {
    console.error("[shutdown] deadline reached; exiting now");
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  force.unref();
  try {
    stopVersionScheduler();
    server.close();
    const http = server as unknown as { closeIdleConnections?: () => void; closeAllConnections?: () => void };
    http.closeIdleConnections?.();
    const interrupted = await stopWorker(db, 8_000, { crashed: exitCode !== 0 });
    if (interrupted.length) console.log(`[shutdown] re-queued ${interrupted.length} running evaluation(s); they resume on the next start`);
    // Long-lived admin event streams would otherwise hold the process open.
    http.closeAllConnections?.();
    await stopDailyBackups();
    await closeDb();
  } catch (e) {
    console.error(`[shutdown] ${(e as Error).message}`);
  }
  process.exit(exitCode);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

/**
 * A stray rejection or exception would otherwise kill the process on the spot (Node's default), skipping the re-queue
 * (R3-REL-15). Log it and take the same path as a deploy, then exit non-zero so the platform
 * restarts the service. A second error while shutting down is only logged; the shutdown deadline still applies.
 */
function fatal(kind: string, err: unknown) {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[fatal] ${kind}: ${redact(detail)}`);
  void shutdown(kind, 1);
}
process.on("unhandledRejection", (reason) => fatal("unhandledRejection", reason));
process.on("uncaughtException", (err, origin) => fatal(origin, err));
