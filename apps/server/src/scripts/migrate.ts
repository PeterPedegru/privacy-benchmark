import { backupBeforeMigrating } from "../db/backup.ts";
import { closeDb, initDb } from "../db/index.ts";

// Same path as the server's boot: exports a database with data before pending migrations, and checks the result.
try {
  const db = await initDb({ beforeMigrating: (d, pending) => backupBeforeMigrating(d, pending) });
  await closeDb(db);
  console.log("Database migrated.");
} catch (e) {
  console.error(`[db] ${(e as Error).message}`);
  process.exit(1);
}
