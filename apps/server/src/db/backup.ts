import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statfsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { getTableColumns, sql, type Table } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { env } from "../env.ts";
import { type DB, type JournalEntry, query, schema, withAdvisoryLock } from "./index.ts";

/**
 * Logical backups of the Postgres database (R3-REL-6): every table as gzipped JSON lines, readable by `restoreExport`
 * into an empty database. Railway's volume backups of the Postgres service are the primary copy; these are a second,
 * portable one on the web service's volume:
 *
 * - `backups/pre-<migration tag>.jsonl.gz`, before pending migrations run on a database with data (newest 3 kept);
 * - `backups/daily-YYYY-MM-DD.jsonl.gz` (UTC), once a day (newest 7 kept; DB_BACKUP_KEEP_DAILY changes that,
 *   DB_BACKUP_DAILY=0 turns them off).
 *
 * Restoring: `pnpm --filter @pb/server exec tsx src/scripts/restore-export.ts <file>` against an empty database
 * (DATABASE_URL), after which the server starts on it as usual.
 */

export const PRE_MIGRATION_KEEP = 3;
/** An export is written only with this many times the database's size free on the volume (exports are compressed). */
export const SPACE_FACTOR = 1.2;
export class BackupSpaceError extends Error {}

/**
 * What an export leaves out: ballots' network hashes (a /24 can be brute-forced from one with its poll's salt, and
 * they're erased when a poll closes anyway; a restore just starts an open poll's network cap afresh).
 */
export function redactForExport(table: string, row: Record<string, unknown>): Record<string, unknown> {
  return table === "weighting_ballots" ? { ...row, network_hash: null } : row;
}

/** Every table, parents first (the order a restore inserts them in). */
export const EXPORT_TABLES: PgTable[] = [
  schema.appMeta,
  schema.projects,
  schema.projectVersions,
  schema.versionChecks,
  schema.sources,
  schema.weightings,
  schema.weightingPolls,
  schema.weightingBallots,
  schema.runs,
  schema.evaluations,
  schema.evidence,
  schema.searchLogs,
  schema.criterionResults,
  schema.runEvents,
  schema.releases,
  schema.publishedResults,
  schema.cards,
  schema.corrections,
];

export const backupDir = () => process.env.DB_BACKUP_DIR ?? resolve(dirname(env.dbPath), "backups");

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

export function listBackups(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl.gz"))
    .sort();
}

/** Deletes all but the newest `keep` backups with the prefix. Returns the deleted names. */
export function pruneBackups(dir: string, prefix: string, keep: number): string[] {
  const old = listBackups(dir, prefix).slice(0, Math.max(0, listBackups(dir, prefix).length - keep));
  for (const f of old) unlinkSync(join(dir, f));
  return old;
}

function freeBytes(dir: string): number {
  try {
    const st = statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The primary-key column a table is paged by (every table has a single-column key). */
function keyOf(table: PgTable): string {
  const cols = Object.values(getTableColumns(table as Table)) as unknown as { name: string; primary: boolean }[];
  return cols.find((c) => c.primary)?.name ?? "id";
}

/**
 * Writes every table to `file` as gzipped JSON lines: a header, then per table a `{"table": …}` line and one
 * `{"r": row}` line per row. Rows are read in pages by primary key, so memory stays flat. The file appears only when
 * complete (written to `.partial`, then renamed). Returns the row count.
 */
export async function exportDatabase(db: DB, file: string): Promise<number> {
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  const gz = createGzip({ level: 6 });
  const out = createWriteStream(partial);
  const done = pipeline(gz, out);
  const write = (line: unknown) =>
    new Promise<void>((ok) => {
      if (gz.write(`${JSON.stringify(line)}\n`)) ok();
      else gz.once("drain", () => ok());
    });
  let rows = 0;
  try {
    const migrations = await query<{ hash: string; created_at: number }>(
      db,
      sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    );
    await write({ format: "privacy-benchmark-export", version: 1, at: new Date().toISOString(), migrations });
    for (const table of EXPORT_TABLES) {
      const name = getTableConfig(table).name;
      // A table this build adds doesn't exist yet when the export runs before the migration that creates it.
      const [exists] = await query<{ t: string | null }>(db, sql`SELECT to_regclass(${`public.${name}`})::text AS t`);
      if (!exists?.t) continue;
      const key = keyOf(table);
      await write({ table: name });
      let after: unknown = null;
      for (;;) {
        const page: Record<string, unknown>[] = await query(
          db,
          sql`SELECT * FROM ${sql.identifier(name)} ${after === null ? sql`` : sql`WHERE ${sql.identifier(key)} > ${after}`} ORDER BY ${sql.identifier(key)} LIMIT 500`,
        );
        if (!page.length) break;
        for (const r of page) await write({ r: redactForExport(name, r) });
        rows += page.length;
        after = page[page.length - 1]![key];
      }
    }
    gz.end();
    await done;
    renameSync(partial, file);
    return rows;
  } catch (e) {
    gz.destroy();
    await done.catch(() => {});
    if (existsSync(partial)) unlinkSync(partial);
    throw e;
  }
}

/**
 * Loads an export into an empty database (schema already migrated), in one transaction. Generated columns are
 * skipped; the run-events sequence continues after the restored ids. Returns rows per table.
 */
export async function restoreExport(db: DB, file: string): Promise<Record<string, number>> {
  const byName = new Map(EXPORT_TABLES.map((t) => [getTableConfig(t).name, t]));
  const counts: Record<string, number> = {};
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Number.POSITIVE_INFINITY });
  await db.transaction(async (tx) => {
    let table: PgTable | null = null;
    let generated = new Set<string>();
    let batch: Record<string, unknown>[] = [];
    const flush = async () => {
      if (table && batch.length) await tx.insert(table).values(batch as never);
      batch = [];
    };
    let first = true;
    for await (const line of lines) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line) as { format?: string; table?: string; r?: Record<string, unknown> };
      if (first) {
        if (obj.format !== "privacy-benchmark-export") throw new Error(`${file} isn't a privacy-benchmark export`);
        first = false;
        continue;
      }
      if (obj.table) {
        await flush();
        table = byName.get(obj.table) ?? null;
        if (!table) throw new Error(`unknown table ${obj.table} in ${file}`);
        const cols = getTableColumns(table as Table) as unknown as Record<string, { name: string; generated?: unknown }>;
        generated = new Set(
          Object.values(cols)
            .filter((c) => c.generated)
            .map((c) => c.name),
        );
        counts[obj.table] = 0;
        continue;
      }
      if (!table || !obj.r) continue;
      // Rows were exported with column names; Drizzle inserts by property key.
      const cols = getTableColumns(table as Table) as unknown as Record<string, { name: string }>;
      const row: Record<string, unknown> = {};
      for (const [k, c] of Object.entries(cols)) if (!generated.has(c.name) && c.name in obj.r) row[k] = obj.r[c.name];
      batch.push(row);
      counts[getTableConfig(table).name] = (counts[getTableConfig(table).name] ?? 0) + 1;
      if (batch.length >= 500) await flush();
    }
    await flush();
    await tx.execute(sql`SELECT setval(pg_get_serial_sequence('run_events', 'id'), coalesce((SELECT max(id) FROM run_events), 0) + 1, false)`);
  });
  return counts;
}

async function assertRoom(db: DB, dir: string) {
  const [{ b = 0 } = {}] = await query<{ b: number }>(db, sql`SELECT pg_database_size(current_database()) AS b`);
  const free = freeBytes(dir);
  if (free < b * SPACE_FACTOR) throw new BackupSpaceError(`only ${fmtBytes(free)} free in ${dir}; the database is ${fmtBytes(b)}`);
}

/** Before pending migrations run on a database with data: a verified export, or a refusal to migrate. */
export async function backupBeforeMigrating(db: DB, pending: JournalEntry[], log: (m: string) => void = console.log): Promise<void> {
  if (process.env.DB_SKIP_MIGRATION_BACKUP === "1") {
    log("[db] DB_SKIP_MIGRATION_BACKUP=1: migrating without an export");
    return;
  }
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  await assertRoom(db, dir);
  const file = join(dir, `pre-${pending[0]!.tag}.jsonl.gz`);
  const started = Date.now();
  const rows = await exportDatabase(db, file);
  log(`[db] exported ${rows} rows to ${file} before migrating (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  pruneBackups(dir, "pre-", PRE_MIGRATION_KEEP);
}

let daily: NodeJS.Timeout | null = null;
let running: Promise<unknown> | null = null;

/** Takes today's export if it doesn't exist yet (one replica at a time). Returns the file, or null when skipped. */
export async function dailyBackup(db: DB, opts: { now?: Date; log?: (m: string) => void; keep?: number } = {}): Promise<string | null> {
  const log = opts.log ?? console.log;
  const dir = backupDir();
  const file = join(dir, `daily-${(opts.now ?? new Date()).toISOString().slice(0, 10)}.jsonl.gz`);
  if (existsSync(file)) return null;
  let written: string | null = null;
  await withAdvisoryLock(db, "daily-backup", async () => {
    if (existsSync(file)) return;
    mkdirSync(dir, { recursive: true });
    try {
      await assertRoom(db, dir);
    } catch (e) {
      log(`[db] daily export skipped: ${(e as Error).message}`);
      return;
    }
    const rows = await exportDatabase(db, file);
    pruneBackups(dir, "daily-", opts.keep ?? Number(process.env.DB_BACKUP_KEEP_DAILY ?? 7));
    log(`[db] daily export: ${rows} rows to ${file}`);
    written = file;
  });
  return written;
}

/** Checks hourly and takes the day's export when it's missing (on by default when deployed; DB_BACKUP_DAILY=0 turns it off). */
export function startDailyBackups(db: DB, log: (m: string) => void = console.log) {
  const on = process.env.DB_BACKUP_DAILY ? process.env.DB_BACKUP_DAILY === "1" : env.isProd;
  if (!on || daily) return;
  const tick = () => {
    if (running) return;
    running = dailyBackup(db, { log })
      .catch((e) => log(`[db] daily export failed: ${(e as Error).message}`))
      .finally(() => {
        running = null;
      });
  };
  daily = setInterval(tick, 3600_000);
  daily.unref();
  setTimeout(tick, 60_000).unref();
}

export async function stopDailyBackups(): Promise<void> {
  if (daily) clearInterval(daily);
  daily = null;
  if (running) await running.catch(() => {});
}
