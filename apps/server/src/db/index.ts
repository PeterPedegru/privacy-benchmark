import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ConnectionOptions, checkServerIdentity } from "node:tls";
import { PGlite } from "@electric-sql/pglite";
import { type SQL, sql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzleLite } from "drizzle-orm/pglite";
import { migrate as migrateLite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import { env, SERVER_ROOT } from "../env.ts";
import * as schema from "./schema.ts";

export const MIGRATIONS_DIR = resolve(SERVER_ROOT, "drizzle");

/**
 * The database: Postgres through node-postgres in production (and the local knowledge-base CLI), or PGlite (Postgres
 * compiled to WASM, in-process) for tests, e2e and zero-setup development. Both speak the same SQL, so code is
 * written once against Drizzle's pg-core.
 */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
  /** sha256 of `<tag>.sql`, which drizzle records in `drizzle.__drizzle_migrations.hash` (absent when the file is missing). */
  hash?: string;
}

/** drizzle-kit's migration journal: one entry per `drizzle/<tag>.sql`, applied in this order. */
export function readJournal(dir = MIGRATIONS_DIR): JournalEntry[] {
  const entries = (JSON.parse(readFileSync(resolve(dir, "meta/_journal.json"), "utf8")) as { entries: JournalEntry[] }).entries;
  return entries.map((e) => {
    const file = resolve(dir, `${e.tag}.sql`);
    return existsSync(file) ? { ...e, hash: createHash("sha256").update(readFileSync(file, "utf8")).digest("hex") } : e;
  });
}

// ---------- query helpers ----------

/** Rows of a raw SQL statement, whichever driver runs it. */
export async function query<T = Record<string, unknown>>(db: DB, q: SQL): Promise<T[]> {
  const res = (await db.execute(q)) as unknown as { rows: T[] };
  return res.rows;
}

/** Runs a raw SQL statement and returns how many rows it changed, whichever driver runs it. */
export async function exec(db: DB, q: SQL): Promise<number> {
  const res = (await db.execute(q)) as unknown as { rowCount?: number | null; affectedRows?: number };
  return res.rowCount ?? res.affectedRows ?? 0;
}

/** The first row of a query, or undefined (what `.get()` was on SQLite). */
export async function one<T>(rows: Promise<T[]> | T[]): Promise<T | undefined> {
  return (await rows)[0];
}

/**
 * Runs `fn` only if this process gets the named advisory lock (held for the call), so a job meant to run once (the
 * daily export, the version checker, boot maintenance) runs on one replica at a time. Returns false when another
 * process holds it.
 */
export async function withAdvisoryLock(db: DB, name: string, fn: () => Promise<void>): Promise<boolean> {
  const h = handles.get(db);
  // PGlite is one process with one connection: nothing else can run the job.
  if (!h?.pool) {
    await fn();
    return true;
  }
  const key = Number.parseInt(createHash("sha256").update(name).digest("hex").slice(0, 12), 16);
  // A session lock lives on one connection, which is held for the job; the job's own queries use the pool.
  const client = await h.pool.connect();
  try {
    const got = (await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [key])).rows[0]?.ok;
    if (!got) return false;
    try {
      await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [key]).catch(() => {});
    }
    return true;
  } finally {
    client.release();
  }
}

// ---------- migrations ----------

/** A row of `drizzle.__drizzle_migrations`: the SQL file's hash and the journal entry's `when` it ran under. */
export interface MigrationRow {
  hash: string;
  createdAt: number;
}

async function migrationRows(db: DB): Promise<MigrationRow[]> {
  const [t] = await query<{ ok: boolean }>(db, sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS ok`);
  if (!t?.ok) return [];
  const rows = await query<{ hash: unknown; created_at: unknown }>(db, sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations`);
  return rows.map((r) => ({ hash: String(r.hash ?? ""), createdAt: Number(r.created_at) }));
}

/**
 * The database's migrations compared with this build's, as sets of (hash, created_at) (R4-24). A row and a journal
 * entry are the same migration when the row's `created_at` is the entry's `when`; the hash tells a renumbered copy
 * from a stranger and an edited file from the one that ran.
 */
export interface MigrationState {
  /** Journal entries recorded under their `when`. */
  recorded: JournalEntry[];
  /** Not recorded, and newer than every row: drizzle will apply them. */
  pending: JournalEntry[];
  /** Not recorded, and not newer than the newest row: drizzle never will (R3-REL-13). */
  skipped: JournalEntry[];
  /** Recorded under their `when` with another hash: the SQL file was edited after it ran. */
  edited: JournalEntry[];
  /** Rows matching no journal entry and older than its newest one (an old numbering): drizzle ignores them. */
  stray: MigrationRow[];
  /** Rows newer than every journal entry: a newer build migrated this database (a rolled-back deploy). */
  newer: MigrationRow[];
}

export function migrationStateOf(rows: MigrationRow[], journal: JournalEntry[]): MigrationState {
  const newestRow = rows.length ? Math.max(...rows.map((r) => r.createdAt)) : Number.NEGATIVE_INFINITY;
  const newestEntry = journal.length ? Math.max(...journal.map((e) => e.when)) : Number.NEGATIVE_INFINITY;
  const whens = new Set(journal.map((e) => e.when));
  const state: MigrationState = { recorded: [], pending: [], skipped: [], edited: [], stray: [], newer: [] };
  for (const e of journal) {
    const at = rows.filter((r) => r.createdAt === e.when);
    if (at.length) {
      state.recorded.push(e);
      if (e.hash && !at.some((r) => r.hash === e.hash)) state.edited.push(e);
    } else if (e.when > newestRow) state.pending.push(e);
    else state.skipped.push(e);
  }
  for (const r of rows) {
    if (whens.has(r.createdAt)) continue;
    if (r.createdAt > newestEntry) state.newer.push(r);
    else state.stray.push(r);
  }
  return state;
}

export async function migrationState(db: DB, journal = readJournal()): Promise<MigrationState> {
  return migrationStateOf(await migrationRows(db), journal);
}

export class MigrationStateError extends Error {}

/**
 * R3-REL-13: drizzle applies a migration only when its `when` is newer than the newest applied one, so a migration
 * merged with an older timestamp is skipped without a word and the code then queries columns that don't exist.
 * Checked before migrating (R4-24), so a refusal leaves the database as it was, and again after, when every journal
 * entry must be recorded:
 * - a skipped migration refuses, naming it;
 * - a row newer than every journal entry means newer code migrated the database (a rolled-back deploy). That refuses
 *   too, unless DB_ALLOW_NEWER_SCHEMA=1;
 * - a stray row and a migration whose file changed after it ran only warn: drizzle ignores both.
 */
export function verifyMigrationState(
  s: MigrationState,
  journal: JournalEntry[],
  opts: { allowNewer?: boolean; log?: (m: string) => void; beforeMigrating?: boolean; warnings?: boolean } = {},
): { applied: number; expected: number } {
  const warn = (m: string) => {
    if (opts.warnings !== false) (opts.log ?? console.warn)(`[db] warning: ${m}`);
  };
  if (s.skipped.length)
    throw new MigrationStateError(
      `migration${s.skipped.length > 1 ? "s" : ""} ${s.skipped.map((e) => e.tag).join(", ")} never ran: drizzle skips a migration whose "when" ` +
        `(drizzle/meta/_journal.json) is older than the newest applied one. Give it a "when" above every other entry, or apply its SQL by hand ` +
        `and record it in drizzle.__drizzle_migrations, then restart. The database has ${s.recorded.length} of this build's ${journal.length} migrations recorded` +
        `${opts.beforeMigrating ? "; nothing was migrated" : ""}.`,
    );
  if (!opts.beforeMigrating && s.pending.length)
    throw new MigrationStateError(`migration${s.pending.length > 1 ? "s" : ""} ${s.pending.map((e) => e.tag).join(", ")} didn't record after migrating.`);
  if (s.newer.length) {
    const message =
      `the database has ${s.newer.length} migration(s) newer than this build's newest (${journal.at(-1)?.tag ?? "none"}): it was migrated by a newer version ` +
      "(a rolled-back deploy?). Deploy the newer version, restore a backup from before it, or set DB_ALLOW_NEWER_SCHEMA=1 to run this build anyway.";
    if (!opts.allowNewer) throw new MigrationStateError(message);
    warn(message);
  }
  if (s.stray.length)
    warn(
      `drizzle.__drizzle_migrations has ${s.stray.length} row(s) that match no migration in this build (created_at ${s.stray.map((r) => r.createdAt).join(", ")}). ` +
        "They're older than the newest migration, so drizzle ignores them.",
    );
  if (s.edited.length)
    warn(
      `migration${s.edited.length > 1 ? "s" : ""} ${s.edited.map((e) => e.tag).join(", ")} changed after being applied here (the recorded hash differs from the file's). ` +
        "The database has the version that ran; check the difference if it isn't a comment or formatting change.",
    );
  return { applied: s.recorded.length, expected: journal.length };
}

const allowNewer = () => process.env.DB_ALLOW_NEWER_SCHEMA === "1";

// ---------- connections ----------

export interface OpenOptions {
  /** A Postgres connection string. Without one, PGlite is used (`pgliteDir`, or in memory). */
  url?: string | null;
  /** PGlite data directory; omitted or "memory" for an in-memory database. */
  pgliteDir?: string;
  migrationsFolder?: string;
  log?: (m: string) => void;
  /** Called with the pending migrations before they run, when the database already has data (backups). */
  beforeMigrating?: (db: DB, pending: JournalEntry[]) => Promise<void>;
  /**
   * false: never migrate, only check that the schema is this build's (the local CLI writing to production must not
   * migrate it, and must not run against a schema it doesn't match).
   */
  migrate?: boolean;
  /** Pool settings for Postgres (the local CLI keeps more, longer-lived connections across the internet). */
  pool?: { max?: number; idleTimeoutMillis?: number };
}

/**
 * TLS for a connection string: off for the private network and local hosts; verified for public endpoints such as
 * Railway's TCP proxy. Railway's Postgres presents a certificate from its own CA, so the CLI pins that CA
 * (PGSSL_CA, a PEM; `\n` escapes allowed) and checks the certificate is the database's (PGSSL_SERVERNAME, default
 * postgres.railway.internal): nobody on the network path can stand in for the database and collect its password.
 * Without a pin, the system CAs verify it. PGSSL=disable turns TLS off, PGSSL=require forces it on local hosts, and
 * PGSSL=insecure accepts any certificate (never with production credentials).
 */
export function sslFor(url: string): false | ConnectionOptions {
  const mode = process.env.PGSSL ?? "auto";
  if (mode === "disable") return false;
  if (/sslmode=disable/.test(url)) return false;
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (mode !== "require" && (host.endsWith(".railway.internal") || host === "localhost" || host === "127.0.0.1" || host === "::1")) return false;
  if (mode === "insecure") return { rejectUnauthorized: false };
  const ca = process.env.PGSSL_CA?.trim();
  if (ca) {
    const servername = process.env.PGSSL_SERVERNAME || "postgres.railway.internal";
    return { ca: ca.replace(/\\n/g, "\n"), rejectUnauthorized: true, checkServerIdentity: (_host, cert) => checkServerIdentity(servername, cert) };
  }
  return { rejectUnauthorized: true };
}

type Handle = { db: DB; close: () => Promise<void>; kind: "pg" | "pglite"; pool?: pg.Pool; dir?: string };

/**
 * count(*) and integer sums are bigint, and numeric aggregates numeric: both drivers would return strings (or
 * BigInt). Every such value here (counts, byte totals, costs) is far below 2^53, so they're parsed as numbers.
 */
const INT8 = 20;
const NUMERIC = 1700;
const toNumber = (v: string) => Number(v);
pg.types.setTypeParser(INT8, toNumber);
pg.types.setTypeParser(NUMERIC, toNumber);

async function connect(opts: OpenOptions): Promise<Handle> {
  if (opts.url) {
    const ssl = sslFor(opts.url);
    const pool = new pg.Pool({
      connectionString: opts.url,
      ssl,
      // SCRAM bound to the TLS channel where the server supports it.
      ...(ssl ? { enableChannelBinding: true } : {}),
      max: opts.pool?.max ?? env.pgPoolMax,
      idleTimeoutMillis: opts.pool?.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: 30_000,
      keepAlive: true,
      // A runaway query must not hold a connection forever.
      statement_timeout: env.pgStatementTimeoutMs,
      application_name: "privacy-benchmark",
    });
    pool.on("error", (e) => console.error(`[db] idle connection error: ${e.message}`));
    const db = drizzlePg(pool, { schema }) as unknown as DB;
    return { db, close: () => pool.end(), kind: "pg", pool };
  }
  const dir = opts.pgliteDir && opts.pgliteDir !== "memory" ? opts.pgliteDir : undefined;
  if (dir) mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir, { parsers: { [INT8]: toNumber, [NUMERIC]: toNumber } });
  await client.waitReady;
  const db = drizzleLite(client, { schema }) as unknown as DB;
  return { db, close: () => client.close(), kind: "pglite", dir };
}

const handles = new WeakMap<DB, Handle>();

/**
 * Opens the database and brings its schema up to date. The migration state is checked before anything is migrated
 * (R4-24) and after, when every journal entry must be recorded (R3-REL-13). Migrations run in one transaction, so a
 * failure leaves the schema as it was.
 */
export async function openDb(opts: OpenOptions = {}): Promise<DB> {
  const log = opts.log ?? console.log;
  const folder = opts.migrationsFolder ?? MIGRATIONS_DIR;
  const journal = readJournal(folder);
  const h = await connect(opts);
  try {
    const before = await migrationState(h.db, journal);
    // A checkout that doesn't match a server's database is told what to do: here, the server is the one that migrates.
    if (opts.migrate === false && before.newer.length)
      throw new MigrationStateError("the database has migrations this checkout doesn't: pull the latest code first.");
    verifyMigrationState(before, journal, { allowNewer: allowNewer(), log, beforeMigrating: true });
    if (opts.migrate === false) {
      if (before.pending.length)
        throw new MigrationStateError(
          `the database is missing ${before.pending.length} migration(s) this checkout has (${before.pending.map((e) => e.tag).join(", ")}): deploy first, then run this again.`,
        );
      handles.set(h.db, h);
      return h.db;
    }
    if (before.pending.length) {
      if (before.recorded.length && opts.beforeMigrating) await opts.beforeMigrating(h.db, before.pending);
      if (before.recorded.length) log(`[db] applying ${before.pending.length} migration(s): ${before.pending.map((e) => e.tag).join(", ")}`);
      if (h.kind === "pg") await migratePg(h.db as never, { migrationsFolder: folder });
      else await migrateLite(h.db as never, { migrationsFolder: folder });
    }
    verifyMigrationState(await migrationState(h.db, journal), journal, { allowNewer: allowNewer(), log, warnings: false });
    handles.set(h.db, h);
    return h.db;
  } catch (e) {
    await h.close().catch(() => {});
    throw e;
  }
}

/** The connection string from the environment: DATABASE_URL, or for local tools DATABASE_PUBLIC_URL / KB_DATABASE_URL. */
export function databaseUrl(opts: { preferPublic?: boolean } = {}): string | null {
  const pick = opts.preferPublic
    ? (process.env.KB_DATABASE_URL ?? process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL)
    : (process.env.DATABASE_URL ?? process.env.KB_DATABASE_URL);
  return pick?.trim() || null;
}

/** Opens the server's database from the environment: Postgres when a URL is configured, otherwise PGlite on disk. */
export function openDbFromEnv(opts: Omit<OpenOptions, "url" | "pgliteDir"> & { preferPublic?: boolean } = {}): Promise<DB> {
  const url = databaseUrl({ preferPublic: opts.preferPublic });
  return openDb({ ...opts, url, pgliteDir: url ? undefined : env.pgliteDir });
}

/** The data directory of an on-disk PGlite database (null for Postgres servers and in-memory PGlite). */
export function pgliteDirOf(db: DB): string | null {
  return handles.get(db)?.dir ?? null;
}

/** Which driver a database uses. */
export function driverOf(db: DB): "pg" | "pglite" | "unknown" {
  return handles.get(db)?.kind ?? "unknown";
}

let _db: DB | null = null;

/** The server's database; `initDb()` (or `setDb()` in tests) must have run first. */
export function getDb(): DB {
  if (!_db) throw new Error("The database isn't open yet: call initDb() at startup.");
  return _db;
}

export function setDb(db: DB) {
  _db = db;
}

export async function initDb(opts: Omit<OpenOptions, "url" | "pgliteDir"> = {}): Promise<DB> {
  _db = await openDbFromEnv(opts);
  return _db;
}

/** Closes a database opened by `openDb` (and the server's, when given none). */
export async function closeDb(db: DB | null = _db) {
  if (!db) return;
  const h = handles.get(db);
  if (db === _db) _db = null;
  if (h) await h.close();
}

export { schema };
