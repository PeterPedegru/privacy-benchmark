import { openDb } from "../db/index.ts";
import { upsertProjectFromGolden } from "../services/demo.ts";
import { loadGoldenFiles } from "../services/golden.ts";

const db = await openDb();
const files = loadGoldenFiles();
for (const g of files) await upsertProjectFromGolden(db, g);
console.log(`Seeded ${files.length} projects (metadata only).`);
