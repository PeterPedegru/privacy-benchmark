/**
 * Logical backups (R3-REL-6): an export restores into an empty database with every row and type intact, exports are
 * taken before migrations and daily, and old ones are pruned.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupBeforeMigrating, dailyBackup, exportDatabase, listBackups, pruneBackups, restoreExport } from "../src/db/backup.ts";
import { closeDb, type DB, openDb, schema } from "../src/db/index.ts";
import { searchSources } from "../src/services/kb.ts";

const tmp = mkdtempSync(join(tmpdir(), "pb-backup-"));
const quiet = { log: () => {} };
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let db: DB;
beforeAll(async () => {
  process.env.DB_BACKUP_DIR = join(tmp, "backups");
  db = await openDb(quiet);
  await db.insert(schema.projects).values({ id: "p1", slug: "alpha", name: "Alpha", websiteUrl: "https://alpha.example", githubRepos: ["alpha/core"] });
  await db.insert(schema.sources).values({
    id: "s1",
    projectId: "p1",
    url: "https://docs.alpha.example/a",
    title: "Upgrades",
    contentMd: "Upgrades pass through a seven day timelock controlled by governance.",
    meta: { section: "docs", lane: "docs" },
  });
  await db.insert(schema.evaluations).values({ id: "e1", projectId: "p1", status: "review", settings: { mode: "deep" }, isDemo: false, costUsd: 3.25 });
  await db
    .insert(schema.criterionResults)
    .values({ id: "r1", evaluationId: "e1", criterionId: "governance.upgrades.upgradeability", flags: ["medium_confidence"] });
  await db.insert(schema.runEvents).values([
    { evaluationId: "e1", stage: "judge", message: "one" },
    { evaluationId: "e1", stage: "judge", message: "two" },
  ]);
});

describe("exports", () => {
  it("restores into an empty database with every row, its types, search and the event sequence", async () => {
    const file = join(tmp, "full.jsonl.gz");
    const rows = await exportDatabase(db, file);
    expect(rows).toBeGreaterThanOrEqual(6);
    const fresh = await openDb(quiet);
    const counts = await restoreExport(fresh, file);
    expect(counts).toMatchObject({ projects: 1, sources: 1, evaluations: 1, criterion_results: 1, run_events: 2 });
    const [p] = await fresh.select().from(schema.projects);
    expect(p!.githubRepos).toEqual(["alpha/core"]);
    const [e] = await fresh.select().from(schema.evaluations);
    expect(e).toMatchObject({ settings: { mode: "deep" }, isDemo: false, costUsd: 3.25 });
    expect((await searchSources(fresh, "p1", "seven day timelock"))[0]?.id).toBe("s1");
    const [next] = await fresh.insert(schema.runEvents).values({ evaluationId: "e1", stage: "x", message: "three" }).returning({ id: schema.runEvents.id });
    expect(next!.id).toBe(3);
    await closeDb(fresh);
  });

  it("refuses a file that isn't an export", async () => {
    const bad = join(tmp, "bad.jsonl.gz");
    const { gzipSync } = await import("node:zlib");
    writeFileSync(bad, gzipSync('{"hello":"world"}\n'));
    const fresh = await openDb(quiet);
    await expect(restoreExport(fresh, bad)).rejects.toThrow(/isn't a privacy-benchmark export/);
    await closeDb(fresh);
  });

  it("exports a database that predates this build's tables (the export before the migration that adds them)", async () => {
    const old = await openDb(quiet);
    await old.execute(sql`DROP TABLE weighting_ballots`);
    await old.execute(sql`DROP TABLE weighting_polls`);
    const file = join(tmp, "before-migration.jsonl.gz");
    expect(await exportDatabase(old, file)).toBeGreaterThanOrEqual(0);
    expect(existsSync(file)).toBe(true);
    await closeDb(old);
  });

  it("takes an export before migrating and keeps the newest three", async () => {
    for (const tag of ["0003_a", "0004_b", "0005_c", "0006_d"]) await backupBeforeMigrating(db, [{ idx: 0, when: 0, tag }], () => {});
    expect(listBackups(join(tmp, "backups"), "pre-")).toEqual(["pre-0004_b.jsonl.gz", "pre-0005_c.jsonl.gz", "pre-0006_d.jsonl.gz"]);
  });

  it("writes the day's export once, and keeps the newest seven", async () => {
    const dir = join(tmp, "backups");
    for (let d = 1; d <= 9; d++) await dailyBackup(db, { now: new Date(Date.UTC(2026, 9, d)), log: () => {}, keep: 7 });
    const daily = listBackups(dir, "daily-");
    expect(daily).toHaveLength(7);
    expect(daily[0]).toBe("daily-2026-10-03.jsonl.gz");
    // Today's file exists: nothing is written again.
    expect(await dailyBackup(db, { now: new Date(Date.UTC(2026, 9, 9)), log: () => {} })).toBeNull();
    expect(readdirSync(dir).some((f) => f.endsWith(".partial"))).toBe(false);
  });

  it("prunes by name order, newest first", () => {
    const dir = join(tmp, "prune");
    mkdirSync(dir, { recursive: true });
    for (const n of ["daily-2026-01-01", "daily-2026-01-03", "daily-2026-01-02"]) writeFileSync(join(dir, `${n}.jsonl.gz`), "");
    expect(pruneBackups(dir, "daily-", 1)).toEqual(["daily-2026-01-01.jsonl.gz", "daily-2026-01-02.jsonl.gz"]);
    expect(existsSync(join(dir, "daily-2026-01-03.jsonl.gz"))).toBe(true);
  });
});
