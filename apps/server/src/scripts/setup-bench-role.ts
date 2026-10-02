/**
 * Creates (or updates) the `bench_cli` database role the local CLI connects as, through the public TCP proxy.
 *
 *   BENCH_DB_PASSWORD=<hex> SETUP_DATABASE_URL=<superuser URL> PGSSL_CA=<pem> tsx src/scripts/setup-bench-role.ts
 *
 * The role can read everything and write what knowledge-base builds and evaluations write, but not the published
 * record (releases, published results, cards, corrections), and it isn't a superuser: a leaked CLI URL can't
 * change the public site or reach the database's host. Tables created later by migrations (as the owner) get the
 * same grants through default privileges; the publish tables are re-revoked each time this runs.
 */
import pg from "pg";
import { sslFor } from "../db/index.ts";

const PUBLISHED = ["releases", "published_results", "cards", "corrections"];

const url = process.env.SETUP_DATABASE_URL;
const password = process.env.BENCH_DB_PASSWORD;
if (!url || !password) {
  console.error("Set SETUP_DATABASE_URL (a superuser URL) and BENCH_DB_PASSWORD.");
  process.exit(1);
}
if (!/^[A-Za-z0-9]{32,}$/.test(password)) {
  console.error("BENCH_DB_PASSWORD must be at least 32 letters or digits (it goes into a URL).");
  process.exit(1);
}
const client = new pg.Client({ connectionString: url, ssl: sslFor(url) });
await client.connect();
try {
  const owner = (await client.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u;
  const db = (await client.query<{ d: string }>("SELECT current_database() AS d")).rows[0]!.d;
  const ident = (s: string) => client.escapeIdentifier(s);
  await client.query("BEGIN");
  await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bench_cli') THEN CREATE ROLE bench_cli LOGIN; END IF; END $$`);
  await client.query(
    `ALTER ROLE bench_cli WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${client.escapeLiteral(password)}`,
  );
  await client.query(`GRANT CONNECT ON DATABASE ${ident(db)} TO bench_cli`);
  await client.query("GRANT USAGE ON SCHEMA public TO bench_cli");
  await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bench_cli");
  await client.query("GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO bench_cli");
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bench_cli`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO bench_cli`);
  // The CLI checks the migration state (it never migrates).
  await client.query("GRANT USAGE ON SCHEMA drizzle TO bench_cli");
  await client.query("GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO bench_cli");
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA drizzle GRANT SELECT ON TABLES TO bench_cli`);
  for (const t of PUBLISHED) {
    const exists = (await client.query<{ t: string | null }>("SELECT to_regclass($1)::text AS t", [`public.${t}`])).rows[0]?.t;
    if (exists) await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${ident(t)} FROM bench_cli`);
  }
  await client.query("COMMIT");
  console.log(`bench_cli is set up on ${db}: reads everything, writes all but ${PUBLISHED.join(", ")}.`);
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
