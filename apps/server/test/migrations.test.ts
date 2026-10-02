/**
 * Migrations run against the only copy of the data (R3-REL-6, R3-REL-13): the journal must be in order and complete,
 * every prefix must upgrade to the latest schema, the migration-state checks must refuse what drizzle would silently
 * skip, and the one-time import of the SQLite database must bring every row across intact.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, describe, expect, it } from "vitest";
import { IMPORT_MARKER, importFromSqliteIfNeeded } from "../src/db/import-sqlite.ts";
import { closeDb, type DB, MIGRATIONS_DIR, MigrationStateError, openDb, query, readJournal, schema } from "../src/db/index.ts";
import { searchSources } from "../src/services/kb.ts";

const journal = readJournal();
const tmp = mkdtempSync(join(tmpdir(), "pb-migrations-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const quiet = { log: () => {} };

/** A migrations folder holding only the first `n` journal entries (a database "at" that migration). */
function prefixFolder(n: number): string {
  const dir = join(tmp, `prefix-${n}`);
  if (existsSync(dir)) return dir;
  mkdirSync(join(dir, "meta"), { recursive: true });
  const entries = journal.slice(0, n);
  for (const e of entries) copyFileSync(join(MIGRATIONS_DIR, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }));
  return dir;
}

const recorded = async (db: DB) => (await query<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`))[0]!.n;

describe("migration journal", () => {
  it("has strictly increasing timestamps and sequential indexes", () => {
    expect(journal.length).toBeGreaterThan(0);
    journal.forEach((e, i) => {
      expect(e.idx, e.tag).toBe(i);
      if (i > 0) expect(e.when, `${e.tag} must be newer than ${journal[i - 1]!.tag}`).toBeGreaterThan(journal[i - 1]!.when);
    });
    expect(new Set(journal.map((e) => e.tag)).size).toBe(journal.length);
  });

  it("has a .sql file for every entry and an entry for every .sql file", () => {
    for (const e of journal) expect(existsSync(join(MIGRATIONS_DIR, `${e.tag}.sql`)), e.tag).toBe(true);
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    expect(files.sort()).toEqual(journal.map((e) => `${e.tag}.sql`).sort());
  });

  it("records one row per journal entry when migrating up from zero", async () => {
    const db = await openDb(quiet);
    expect(await recorded(db)).toBe(journal.length);
    await closeDb(db);
  });

  it("upgrades a database from every earlier migration", async () => {
    for (let n = 1; n < journal.length; n++) {
      const dir = join(tmp, `upgrade-${n}`);
      await closeDb(await openDb({ ...quiet, pgliteDir: dir, migrationsFolder: prefixFolder(n) }));
      const db = await openDb({ ...quiet, pgliteDir: dir });
      expect(await recorded(db), `from ${journal[n - 1]!.tag}`).toBe(journal.length);
      await closeDb(db);
    }
  });
});

describe("migration state checks (R3-REL-13, R4-24)", () => {
  /** A migrations folder with the given entries, each creating its own table. */
  function folder(name: string, entries: { tag: string; when: number }[], body = (tag: string) => `CREATE TABLE "t_${tag}" (x integer);`): string {
    const dir = join(tmp, `state-${name}`);
    mkdirSync(join(dir, "meta"), { recursive: true });
    for (const e of entries) writeFileSync(join(dir, `${e.tag}.sql`), body(e.tag));
    writeFileSync(
      join(dir, "meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: entries.map((e, idx) => ({ idx, version: "7", when: e.when, tag: e.tag, breakpoints: true })),
      }),
    );
    return dir;
  }

  it("refuses to start when a migration with an older timestamp was skipped, before migrating anything newer", async () => {
    const dir = join(tmp, "db-skipped");
    await closeDb(
      await openDb({
        ...quiet,
        pgliteDir: dir,
        migrationsFolder: folder("a", [
          { tag: "0000_a", when: 100 },
          { tag: "0002_c", when: 300 },
        ]),
      }),
    );
    // 0001_b was merged later with an older timestamp: drizzle would never run it.
    const later = folder("b", [
      { tag: "0000_a", when: 100 },
      { tag: "0001_b", when: 200 },
      { tag: "0002_c", when: 300 },
      { tag: "0003_d", when: 400 },
    ]);
    await expect(openDb({ ...quiet, pgliteDir: dir, migrationsFolder: later })).rejects.toThrow(MigrationStateError);
    await expect(openDb({ ...quiet, pgliteDir: dir, migrationsFolder: later })).rejects.toThrow(/0001_b never ran.*nothing was migrated/);
    // 0003_d didn't run either: the refusal came first.
    const db = await openDb({
      ...quiet,
      pgliteDir: dir,
      migrationsFolder: folder("a2", [
        { tag: "0000_a", when: 100 },
        { tag: "0002_c", when: 300 },
      ]),
    });
    expect((await query<{ t: string | null }>(db, sql`SELECT to_regclass('t_0003_d')::text AS t`))[0]!.t).toBeNull();
    await closeDb(db);
  });

  it("warns, without refusing, when a migration's file changed after it ran", async () => {
    const dir = join(tmp, "db-edited");
    await closeDb(await openDb({ ...quiet, pgliteDir: dir, migrationsFolder: folder("e", [{ tag: "0000_a", when: 100 }]) }));
    const warnings: string[] = [];
    const edited = folder("e2", [{ tag: "0000_a", when: 100 }], () => `-- reformatted\nCREATE TABLE "t_0000_a" (x integer);`);
    await closeDb(await openDb({ pgliteDir: dir, migrationsFolder: edited, log: (m) => warnings.push(m) }));
    expect(warnings.join("\n")).toMatch(/0000_a changed after being applied/);
  });

  it("never migrates with migrate: false (the local CLI against a server's database)", async () => {
    const dir = join(tmp, "db-nomigrate");
    const one = folder("m1", [{ tag: "0000_a", when: 100 }]);
    const two = folder("m2", [
      { tag: "0000_a", when: 100 },
      { tag: "0001_b", when: 200 },
    ]);
    await closeDb(await openDb({ ...quiet, pgliteDir: dir, migrationsFolder: one }));
    // This checkout is ahead of the database: deploy first.
    await expect(openDb({ ...quiet, pgliteDir: dir, migrationsFolder: two, migrate: false })).rejects.toThrow(/missing 1 migration.*deploy first/);
    let db = await openDb({ ...quiet, pgliteDir: dir, migrationsFolder: one, migrate: false });
    expect(await recorded(db)).toBe(1);
    await closeDb(db);
    // The database is ahead of this checkout: pull first.
    await closeDb(await openDb({ ...quiet, pgliteDir: dir, migrationsFolder: two }));
    await expect(openDb({ ...quiet, pgliteDir: dir, migrationsFolder: one, migrate: false })).rejects.toThrow(/pull the latest code/);
    db = await openDb({ ...quiet, pgliteDir: dir, migrationsFolder: two, migrate: false });
    expect(await recorded(db)).toBe(2);
    await closeDb(db);
  });

  it("refuses a database migrated by a newer build unless DB_ALLOW_NEWER_SCHEMA=1", async () => {
    const dir = join(tmp, "db-newer");
    await closeDb(
      await openDb({
        ...quiet,
        pgliteDir: dir,
        migrationsFolder: folder("n", [
          { tag: "0000_a", when: 100 },
          { tag: "0001_b", when: 200 },
        ]),
      }),
    );
    const older = folder("n2", [{ tag: "0000_a", when: 100 }]);
    await expect(openDb({ ...quiet, pgliteDir: dir, migrationsFolder: older })).rejects.toThrow(/migrated by a newer version/);
    process.env.DB_ALLOW_NEWER_SCHEMA = "1";
    try {
      await closeDb(await openDb({ ...quiet, pgliteDir: dir, migrationsFolder: older }));
    } finally {
      delete process.env.DB_ALLOW_NEWER_SCHEMA;
    }
  });
});

describe("importing the SQLite database (the move to Postgres, 2026-10)", () => {
  /** A SQLite database at the last SQLite migration, with rows in the tables that carry JSON, booleans and content. */
  function sqliteFixture(): string {
    const file = join(tmp, `legacy-${Math.random().toString(36).slice(2)}.db`);
    const lite = new Database(file);
    migrateSqlite(drizzleSqlite(lite), { migrationsFolder: resolve(import.meta.dirname, "../drizzle-sqlite") });
    lite.exec(`
      INSERT INTO projects (id, slug, name, website_url, github_repos, track_versions) VALUES ('p1', 'alpha', 'Alpha', 'https://alpha.example', '["alpha/core"]', 1);
      INSERT INTO sources (id, project_id, url, title, kind, source_class, content_md, meta, origin)
        VALUES ('s1', 'p1', 'https://docs.alpha.example/security', 'Security', 'docs', 'official_docs',
                'The sequencer can pause withdrawals through an emergency pause function held by a multisig.', '{"section":"docs","lane":"docs","stale":false}', 'kb');
      INSERT INTO evaluations (id, project_id, status, stage, completed_stages, settings, is_demo, cost_usd)
        VALUES ('e1', 'p1', 'review', 'review', '["ingest","scout"]', '{"mode":"deep"}', 0, 12.5);
      INSERT INTO evidence (id, evaluation_id, criterion_id, quote, source_id, verified) VALUES ('ev1', 'e1', 'custody.pause.pause-fn', 'emergency pause function', 's1', 1);
      INSERT INTO criterion_results (id, evaluation_id, criterion_id, status, option_id, evidence_ids, flags, votes)
        VALUES ('r1', 'e1', 'custody.pause.pause-fn', 'answered', 'any-single', '["ev1"]', '["medium_confidence"]', '[{"optionId":"any-single","status":"answered","round":1}]');
      INSERT INTO run_events (id, evaluation_id, stage, message) VALUES (41, 'e1', 'judge', 'judged'), (42, 'e1', 'score', 'scored');
      INSERT INTO releases (id, label, rubric_version, is_demo) VALUES ('rel1', 'R1', '1.3.0', 0);
      INSERT INTO published_results (id, release_id, project_id, evaluation_id, overall, walkaway, active, snapshot)
        VALUES ('pr1', 'rel1', 'p1', 'e1', 61.5, 1, 1, '{"project":{"slug":"alpha"}}');
    `);
    lite.close();
    return file;
  }

  it("copies every row with JSON, booleans and numbers as Postgres types, indexes sources for search, and records a marker", async () => {
    const file = sqliteFixture();
    const db = await openDb(quiet);
    const r = await importFromSqliteIfNeeded(db, file, () => {});
    expect(r.imported).toBe(true);
    expect(r.counts).toMatchObject({ projects: 1, sources: 1, evaluations: 1, evidence: 1, criterion_results: 1, run_events: 2, published_results: 1 });
    const [p] = await db.select().from(schema.projects);
    expect(p).toMatchObject({ githubRepos: ["alpha/core"], trackVersions: true });
    const [e] = await db.select().from(schema.evaluations);
    expect(e).toMatchObject({ completedStages: ["ingest", "scout"], settings: { mode: "deep" }, isDemo: false, costUsd: 12.5 });
    const [cr] = await db.select().from(schema.criterionResults);
    expect(cr!.votes[0]).toMatchObject({ optionId: "any-single", round: 1 });
    const [pub] = await db.select().from(schema.publishedResults);
    expect(pub).toMatchObject({ walkaway: true, active: true, overall: 61.5 });
    const [src] = await db.select().from(schema.sources);
    expect(src!.contentLen).toBe(src!.contentMd.length);
    expect((await searchSources(db, "p1", "pause withdrawals"))[0]?.id).toBe("s1");
    // The event sequence continues after the imported ids.
    const [next] = await db.insert(schema.runEvents).values({ evaluationId: "e1", stage: "x", message: "after" }).returning({ id: schema.runEvents.id });
    expect(next!.id).toBe(43);
    // Done once: a second boot doesn't import again.
    expect((await db.select().from(schema.appMeta)).map((m) => m.key)).toEqual([IMPORT_MARKER]);
    expect(await importFromSqliteIfNeeded(db, file, () => {})).toMatchObject({ imported: false, reason: "already imported" });
    await closeDb(db);
  });

  it("doesn't import into a database that already has data", async () => {
    const file = sqliteFixture();
    const busy = await openDb(quiet);
    await busy.insert(schema.projects).values({ id: "x", slug: "x", name: "X", websiteUrl: "https://x.example" });
    expect(await importFromSqliteIfNeeded(busy, file, () => {})).toMatchObject({ imported: false, reason: "Postgres already has data" });
    await closeDb(busy);
  });

  it("imports an upgraded copy of a SQLite database that missed migrations, leaving the original as it was", async () => {
    const liteDir = resolve(import.meta.dirname, "../drizzle-sqlite");
    const all = JSON.parse(readFileSync(join(liteDir, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const older = join(tmp, "sqlite-prefix");
    mkdirSync(join(older, "meta"), { recursive: true });
    const entries = all.entries.slice(0, all.entries.length - 3);
    for (const e of entries) copyFileSync(join(liteDir, `${e.tag}.sql`), join(older, `${e.tag}.sql`));
    writeFileSync(join(older, "meta/_journal.json"), JSON.stringify({ ...all, entries }));
    const behind = join(tmp, "behind.db");
    const lite = new Database(behind);
    migrateSqlite(drizzleSqlite(lite), { migrationsFolder: older });
    lite.exec(`INSERT INTO projects (id, slug, name, website_url) VALUES ('p1', 'alpha', 'Alpha', 'https://alpha.example')`);
    lite.close();
    const logs: string[] = [];
    const db = await openDb(quiet);
    const r = await importFromSqliteIfNeeded(db, behind, (m) => logs.push(m));
    expect(r).toMatchObject({ imported: true, counts: { projects: 1 } });
    expect(logs.join("\n")).toMatch(/3 SQLite migration\(s\) behind; importing an upgraded copy/);
    expect((await db.select().from(schema.projects))[0]).toMatchObject({ slug: "alpha" });
    await closeDb(db);
    const original = new Database(behind, { readonly: true });
    expect((original.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n).toBe(entries.length);
    original.close();
  });

  it("imports a development database that recorded a draft of a migration under another timestamp", async () => {
    const liteDir = resolve(import.meta.dirname, "../drizzle-sqlite");
    const all = JSON.parse(readFileSync(join(liteDir, "meta/_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
    // Everything applied, then the last migration's row rewritten as an earlier draft would have recorded it.
    const file = join(tmp, "draft.db");
    const lite = new Database(file);
    migrateSqlite(drizzleSqlite(lite), { migrationsFolder: liteDir });
    const last = all.entries.at(-1)!;
    lite.prepare("UPDATE __drizzle_migrations SET created_at = ?, hash = 'draft' WHERE created_at = ?").run(last.when - 1000, last.when);
    lite.exec(`INSERT INTO projects (id, slug, name, website_url) VALUES ('p1', 'alpha', 'Alpha', 'https://alpha.example')`);
    lite.close();
    const logs: string[] = [];
    const db = await openDb(quiet);
    expect(await importFromSqliteIfNeeded(db, file, (m) => logs.push(m))).toMatchObject({ imported: true, counts: { projects: 1 } });
    expect(logs.join("\n")).toMatch(/replayed the missing migrations, skipping \d+ statement/);
    await closeDb(db);
  });

  it("writes nothing when the SQLite database can't be brought up to date", async () => {
    const broken = join(tmp, "broken.db");
    const lite = new Database(broken);
    // No migration recorded, but a table the first migration creates already exists: upgrading the copy fails.
    lite.exec("CREATE TABLE projects (id text primary key)");
    lite.close();
    const fresh = await openDb(quiet);
    await expect(importFromSqliteIfNeeded(fresh, broken, () => {})).rejects.toThrow();
    expect(await db0Count(fresh)).toBe(0);
    expect(await fresh.select().from(schema.appMeta)).toEqual([]);
    await closeDb(fresh);
  });
});

async function db0Count(db: DB): Promise<number> {
  return (await query<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM projects`))[0]!.n;
}
