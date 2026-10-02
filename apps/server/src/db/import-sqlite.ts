import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { eq, getTableColumns, sql, type Table } from "drizzle-orm";
import { drizzle as sqliteDrizzle } from "drizzle-orm/better-sqlite3";
import { migrate as sqliteMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { SERVER_ROOT } from "../env.ts";
import { type DB, query, schema } from "./index.ts";

/**
 * One-time import of the SQLite database the app ran on before Postgres (2026-10). On the first boot with an empty
 * Postgres, every table is copied in one transaction, row counts are compared table by table, and a marker is
 * recorded in `app_meta`; any mismatch rolls the whole import back and the server doesn't start. The SQLite file is
 * only read, and left where it was.
 */

export const IMPORT_MARKER = "sqlite_import";
const SQLITE_MIGRATIONS = resolve(SERVER_ROOT, "drizzle-sqlite");

/** Parents before children, so foreign keys hold as rows arrive. */
const TABLES: PgTable[] = [
  schema.projects,
  schema.projectVersions,
  schema.versionChecks,
  schema.sources,
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

export interface ImportResult {
  imported: boolean;
  reason?: string;
  counts?: Record<string, number>;
  ms?: number;
}

/** The SQLite migrations this import understands: the database must have every one of them. */
function expectedSqliteMigrations(): number[] {
  const journal = JSON.parse(readFileSync(resolve(SQLITE_MIGRATIONS, "meta/_journal.json"), "utf8")) as { entries: { when: number }[] };
  return journal.entries.map((e) => e.when);
}

/**
 * Applies the journal's migrations at `whens` statement by statement, skipping statements whose table, index or
 * column already exists, and records each one. Only ever run on a temporary copy. Returns the statements skipped.
 */
function replayMissingTolerantly(rw: Database.Database, whens: number[]): number {
  const journal = JSON.parse(readFileSync(resolve(SQLITE_MIGRATIONS, "meta/_journal.json"), "utf8")) as { entries: { when: number; tag: string }[] };
  rw.exec("CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)");
  let skipped = 0;
  for (const e of journal.entries.filter((x) => whens.includes(x.when)).sort((a, b) => a.when - b.when)) {
    const text = readFileSync(resolve(SQLITE_MIGRATIONS, `${e.tag}.sql`), "utf8");
    for (const stmt of text
      .split("--> statement-breakpoint")
      .map((x) => x.trim())
      .filter(Boolean)) {
      try {
        rw.exec(stmt);
      } catch (err) {
        if (!/already exists|duplicate column name/i.test((err as Error).message)) throw new Error(`${e.tag}: ${(err as Error).message}`);
        skipped++;
      }
    }
    rw.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(createHash("sha256").update(text).digest("hex"), e.when);
  }
  return skipped;
}

function missingSqliteMigrations(lite: Database.Database): number[] {
  const has = lite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get();
  const applied = new Set(has ? (lite.prepare("SELECT created_at AS w FROM __drizzle_migrations").all() as { w: number }[]).map((r) => Number(r.w)) : []);
  return expectedSqliteMigrations().filter((w) => !applied.has(w));
}

type Converter = (v: unknown) => unknown;

/** How each column's SQLite value becomes the Postgres value Drizzle expects. */
function convertersFor(table: PgTable): { key: string; name: string; convert: Converter }[] {
  const cols = getTableColumns(table as Table);
  const out: { key: string; name: string; convert: Converter }[] = [];
  for (const [key, col] of Object.entries(cols)) {
    const c = col as unknown as { name: string; columnType: string; generated?: unknown };
    if (c.generated) continue; // content_len: the database computes it
    let convert: Converter = (v) => v;
    if (c.columnType === "PgJsonb") convert = (v) => (typeof v === "string" ? (v === "" ? null : JSON.parse(v)) : (v ?? null));
    else if (c.columnType === "PgBoolean") convert = (v) => (v === null || v === undefined ? null : v === 1 || v === true || v === "1");
    else if (c.columnType === "PgDoublePrecision") convert = (v) => (v === null || v === undefined ? null : Number(v));
    else if (c.columnType === "PgInteger" || c.columnType === "PgSerial") convert = (v) => (v === null || v === undefined ? null : Number(v));
    out.push({ key, name: c.name, convert });
  }
  return out;
}

/**
 * Imports `sqlitePath` into `db` when Postgres has no data and no import marker. Returns what happened; throws (after
 * rolling back) when the copy doesn't match.
 */
export async function importFromSqliteIfNeeded(db: DB, sqlitePath: string, log: (m: string) => void = console.log): Promise<ImportResult> {
  const [marker] = await db.select().from(schema.appMeta).where(eq(schema.appMeta.key, IMPORT_MARKER));
  if (marker) return { imported: false, reason: "already imported" };
  if (!existsSync(sqlitePath)) return { imported: false, reason: "no SQLite database" };
  const [{ n } = { n: 0 }] = await query<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM projects`);
  if (n > 0) return { imported: false, reason: "Postgres already has data" };

  let lite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  let upgraded: string | null = null;
  try {
    const missing = missingSqliteMigrations(lite);
    if (missing.length) {
      // An older copy (a laptop's, say): a copy of it is brought up to date and imported; the original isn't touched.
      upgraded = mkdtempSync(join(tmpdir(), "pb-import-"));
      const copy = join(upgraded, "upgraded.db");
      lite.prepare("VACUUM INTO ?").run(copy);
      lite.close();
      log(`[import] ${sqlitePath} is ${missing.length} SQLite migration(s) behind; importing an upgraded copy`);
      const rw = new Database(copy);
      try {
        try {
          sqliteMigrate(sqliteDrizzle(rw), { migrationsFolder: SQLITE_MIGRATIONS });
        } catch (e) {
          // A development database can record a migration under an earlier draft's timestamp, so drizzle runs it
          // again and stops at "already exists". The copy is replayed statement by statement instead.
          const skipped = replayMissingTolerantly(rw, missingSqliteMigrations(rw));
          log(
            `[import] the SQLite migrator stopped (${(e as Error).message.split("\n")[0]}); replayed the missing migrations, skipping ${skipped} statement(s) whose objects already existed`,
          );
        }
      } finally {
        rw.close();
      }
      lite = new Database(copy, { readonly: true, fileMustExist: true });
      const still = missingSqliteMigrations(lite);
      if (still.length) throw new Error(`the SQLite database at ${sqlitePath} is still missing ${still.length} migration(s) after upgrading a copy`);
    }

    const started = Date.now();
    const counts: Record<string, number> = {};
    log(`[import] copying ${sqlitePath} into Postgres`);
    await db.transaction(async (tx) => {
      for (const table of TABLES) {
        const name = getTableConfig(table).name;
        const convs = convertersFor(table);
        const total = (lite.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n;
        let batch: Record<string, unknown>[] = [];
        let bytes = 0;
        let done = 0;
        const flush = async () => {
          if (!batch.length) return;
          await tx.insert(table).values(batch as never);
          done += batch.length;
          batch = [];
          bytes = 0;
        };
        // Streams rows, so the largest table (sources, with content) never sits in memory whole.
        for (const raw of lite.prepare(`SELECT * FROM "${name}"`).iterate() as Iterable<Record<string, unknown>>) {
          const row: Record<string, unknown> = {};
          for (const c of convs) row[c.key] = c.convert(raw[c.name]);
          batch.push(row);
          bytes += typeof raw.content_md === "string" ? raw.content_md.length : 200;
          if (batch.length >= 500 || bytes >= 8_000_000) await flush();
        }
        await flush();
        const [{ n: got } = { n: -1 }] = await query<{ n: number }>(tx as unknown as DB, sql.raw(`SELECT count(*)::int AS n FROM "${name}"`));
        if (got !== total || done !== total) throw new Error(`import mismatch in ${name}: SQLite has ${total} rows, Postgres received ${got}`);
        counts[name] = total;
        if (total) log(`[import] ${name}: ${total} rows`);
      }
      // run_events ids came along; the sequence continues after them.
      await tx.execute(sql`SELECT setval(pg_get_serial_sequence('run_events', 'id'), coalesce((SELECT max(id) FROM run_events), 0) + 1, false)`);
      await tx.insert(schema.appMeta).values({
        key: IMPORT_MARKER,
        value: { at: new Date().toISOString(), from: sqlitePath, counts, sqliteMigrations: expectedSqliteMigrations().length, upgradedCopy: !!upgraded },
      });
    });
    const ms = Date.now() - started;
    log(`[import] done in ${(ms / 1000).toFixed(1)} s: ${Object.values(counts).reduce((a, b) => a + b, 0)} rows; the SQLite file was left as it was`);
    return { imported: true, counts, ms };
  } finally {
    if (lite.open) lite.close();
    if (upgraded) rmSync(upgraded, { recursive: true, force: true });
  }
}
