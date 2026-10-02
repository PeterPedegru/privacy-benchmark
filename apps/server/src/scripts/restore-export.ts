/**
 * Restores a logical backup (backups/pre-*.jsonl.gz or daily-*.jsonl.gz) into an EMPTY database, migrating it first.
 *
 *   KB_DATABASE_URL=<empty database> pnpm --filter @pb/server exec tsx src/scripts/restore-export.ts <file> --target-host <host>
 *
 * The target is KB_DATABASE_URL, else DATABASE_PUBLIC_URL, else DATABASE_URL (PGlite when none is set), and
 * `--target-host` must name its host: a restore never lands on a database by default. The database is checked to be
 * empty before anything is migrated or written. Then switch the web service's DATABASE_URL to it.
 */
import { existsSync } from "node:fs";
import pg from "pg";
import { restoreExport } from "../db/backup.ts";
import { closeDb, databaseUrl, openDbFromEnv, sslFor } from "../db/index.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--target-host");
const targetHost = args.includes("--target-host") ? args[args.indexOf("--target-host") + 1] : undefined;
if (!file || !existsSync(file)) {
  console.error("Usage: tsx src/scripts/restore-export.ts <backup .jsonl.gz> --target-host <host of the empty database>");
  process.exit(1);
}

const url = databaseUrl({ preferPublic: true });
if (url) {
  const host = new URL(url).hostname;
  if (targetHost !== host) {
    console.error(`Refusing: the target database is ${host}. Pass --target-host ${host} if that's the empty database to restore into.`);
    process.exit(1);
  }
  // Empty before anything is migrated: a restore must never apply this checkout's migrations to a live database.
  const client = new pg.Client({ connectionString: url, ssl: sslFor(url) });
  await client.connect();
  try {
    const { rows } = await client.query<{ t: string | null }>("SELECT to_regclass('public.projects')::text AS t");
    if (rows[0]?.t) {
      const { rows: n } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM projects");
      if ((n[0]?.n ?? 0) > 0) {
        console.error(`Refusing: ${host} already has ${n[0]!.n} project(s). Restore into an empty database.`);
        process.exit(1);
      }
    }
  } finally {
    await client.end();
  }
}

const db = await openDbFromEnv({ preferPublic: true });
try {
  const counts = await restoreExport(db, file);
  console.log(`Restored ${Object.values(counts).reduce((a, b) => a + b, 0)} rows:`, counts);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await closeDb(db);
}
