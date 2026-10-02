// Checks the drizzle migration journal (R3-REL-13). drizzle applies a migration only when its `when` is newer than
// the newest one already applied, so a migration generated on a branch (or on a machine with a slow clock) and
// merged after a newer one is skipped in production without an error.
//
//   node scripts/check-migrations.mjs                 order and files only
//   node scripts/check-migrations.mjs --base <ref>    also against the journal at <ref> (e.g. origin/main):
//                                                     merged entries are unchanged, new ones are newer than all of them
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(root, "drizzle");
const journalPath = resolve(dir, "meta/_journal.json");
const journal = JSON.parse(readFileSync(journalPath, "utf8"));
const entries = journal.entries;
const errors = [];

entries.forEach((e, i) => {
  if (e.idx !== i) errors.push(`${e.tag}: idx ${e.idx}, expected ${i}`);
  if (i > 0 && !(e.when > entries[i - 1].when)) errors.push(`${e.tag}: when ${e.when} is not newer than ${entries[i - 1].tag} (${entries[i - 1].when})`);
  if (!existsSync(resolve(dir, `${e.tag}.sql`))) errors.push(`${e.tag}: drizzle/${e.tag}.sql is missing`);
});
const tags = new Set(entries.map((e) => e.tag));
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")))
  if (!tags.has(f.slice(0, -4))) errors.push(`drizzle/${f} has no journal entry (generate migrations with drizzle-kit, don't add files by hand)`);

const baseAt = process.argv.indexOf("--base");
const base = baseAt > 0 ? process.argv[baseAt + 1] : null;
let compared = false;
if (base) {
  let baseEntries = null;
  try {
    const repoPath = relative(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim(), journalPath);
    const baseJournal = JSON.parse(execFileSync("git", ["show", `${base}:${repoPath}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    // The move to Postgres (2026-10) started a new journal; the SQLite one lives on in drizzle-sqlite/.
    if (baseJournal.dialect && journal.dialect && baseJournal.dialect !== journal.dialect)
      console.log(`[migrations] ${base} has a ${baseJournal.dialect} journal and this one is ${journal.dialect}; skipping the comparison`);
    else baseEntries = baseJournal.entries;
  } catch {
    console.log(`[migrations] no journal at ${base}; skipping the comparison`);
  }
  if (baseEntries?.length) {
    compared = true;
    const byTag = new Map(entries.map((e) => [e.tag, e]));
    for (const b of baseEntries) {
      const e = byTag.get(b.tag);
      if (!e) errors.push(`${b.tag} is on ${base} but missing here: never remove or rename a merged migration`);
      else if (e.when !== b.when) errors.push(`${b.tag}: when changed from ${b.when} (on ${base}) to ${e.when}; a merged migration must not change`);
    }
    const newest = Math.max(...baseEntries.map((b) => b.when));
    const baseTags = new Set(baseEntries.map((b) => b.tag));
    for (const e of entries.filter((x) => !baseTags.has(x.tag)))
      if (!(e.when > newest))
        errors.push(
          `${e.tag}: when ${e.when} is older than the newest migration on ${base} (${newest}), so production would skip it. Regenerate it on top of ${base}, or raise its when and idx.`,
        );
  }
}

if (errors.length) {
  console.error(`[migrations] ${errors.length} problem(s) in ${relative(process.cwd(), journalPath)}:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  process.exit(1);
}
console.log(`[migrations] ${entries.length} migrations in order${compared ? `, consistent with ${base}` : ""}`);
