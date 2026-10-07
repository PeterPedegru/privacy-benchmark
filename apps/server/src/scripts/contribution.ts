/** Offline validation / explicit local import. No production URL, model call, review acceptance or publication. */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectSnapshot } from "@pb/core";
import { closeDb, openDb } from "../db/index.ts";
import { REPO_ROOT } from "../env.ts";
import { importContribution, importPublishedBaseline, readContribution } from "../services/contributions.ts";

const [command, path, ...args] = process.argv.slice(2);
if (!["check", "import"].includes(command ?? "") || !path) {
  console.error("Usage: contribution.ts check <package> | import <package> --local-dir <PGlite directory> [--baseline <snapshot directory>]");
  process.exit(1);
}
const prepared = readContribution(resolve(REPO_ROOT, path));
const report = {
  project: prepared.data.project.name,
  rubricVersion: prepared.data.rubricVersion,
  asOf: prepared.data.asOf,
  sources: prepared.sources.length,
  answered: prepared.data.answers.filter((a) => a.status === "answered").length,
  unknown: prepared.data.answers.filter((a) => a.status === "unknown").length,
  notApplicable: prepared.data.answers.filter((a) => a.status === "not_applicable").length,
  scores: prepared.scores,
  coverage: prepared.coverage,
};
if (command === "check") console.log(JSON.stringify(report, null, 2));
else {
  const localDir = args[args.indexOf("--local-dir") + 1];
  if (!args.includes("--local-dir") || !localDir || localDir.startsWith("--"))
    throw new Error("An explicit --local-dir is required; production databases are never imported");
  const db = await openDb({ pgliteDir: resolve(REPO_ROOT, localDir) });
  try {
    if (args.includes("--baseline")) {
      const folder = args[args.indexOf("--baseline") + 1];
      if (!folder || folder.startsWith("--")) throw new Error("Missing --baseline directory");
      const dir = resolve(REPO_ROOT, folder);
      const snapshots = readdirSync(dir)
        .filter((file) => file.endsWith(".json") && file !== "projects.json")
        .map((file) => (JSON.parse(readFileSync(resolve(dir, file), "utf8")) as { snapshot: ProjectSnapshot }).snapshot);
      await importPublishedBaseline(db, snapshots);
    }
    const evaluationId = await importContribution(db, prepared);
    console.log(JSON.stringify({ evaluationId, state: "review", published: false, ...report }, null, 2));
  } finally {
    await closeDb(db);
  }
}
