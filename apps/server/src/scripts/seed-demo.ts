import { openDb } from "../db/index.ts";
import { seedDemo } from "../services/demo.ts";

const db = await openDb();
const { releaseId, projects } = await seedDemo(db);
console.log(releaseId ? `Demo release ${releaseId} published with ${projects} projects.` : "No dataset found (evals/golden or evals/sample).");
