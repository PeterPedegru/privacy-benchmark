/**
 * Seeds the e2e database (R3-TEST-14): one finished, non-demo evaluation of a fixture project, in review, with a
 * verified quote for every criterion (so it passes the coverage gate), a summary, and two flagged criteria. The demo
 * release can't exercise the editor's publishing path, because demo evaluations can't be republished.
 *
 * The e2e webServer runs this before booting the server, which then adds the demo release (SEED_DEMO=1). It only
 * writes to a throwaway database: PGLITE_DIR must be set, to a directory whose name contains "e2e".
 */
import { basename } from "node:path";
import { criteria } from "@pb/rubric";
import { eq } from "drizzle-orm";
import { closeDb, openDb, schema } from "../db/index.ts";

export const E2E_PROJECT = { id: "e2e-fixture", slug: "e2e-fixture", name: "E2E Fixture Protocol" };
export const E2E_EVALUATION = "e2e-evaluation";
/** Flagged in review: one to accept with a reason, one to override. */
export const E2E_FLAGGED = { accept: "custody.pause.pause-fn", override: "coverage.confidentiality.amounts" };

const dir = process.env.PGLITE_DIR;
if (!dir || !/e2e/i.test(basename(dir)) || process.env.DATABASE_URL) {
  console.error("[seed:e2e] refusing: set PGLITE_DIR to a throwaway directory whose name contains 'e2e' (and no DATABASE_URL).");
  process.exit(1);
}

const QUOTE = "Withdrawals cannot be paused: the pool contracts are immutable and have no owner or admin role.";
const db = await openDb({ pgliteDir: dir, log: () => {} });
if ((await db.select().from(schema.projects).where(eq(schema.projects.id, E2E_PROJECT.id)))[0]) {
  console.log("[seed:e2e] fixture already present");
  process.exit(0);
}

const now = new Date().toISOString();
await db.transaction(async (tx) => {
  await tx.insert(schema.projects).values({
    ...E2E_PROJECT,
    websiteUrl: "https://e2e-fixture.example.org",
    tagline: "A fixture project for the end-to-end tests",
    description: "Seeded by apps/server/src/scripts/seed-e2e.ts.",
    category: "privacy_pool",
    mechanism: "pool",
    chains: ["Ethereum"],
  });
  await tx
    .insert(schema.projectVersions)
    .values({ id: "e2e-fixture-v1", projectId: E2E_PROJECT.id, version: "v1", label: "V1", releasedAt: "2026-09-01", status: "tracked" });
  await tx.insert(schema.sources).values({
    id: "e2e-fixture-docs",
    projectId: E2E_PROJECT.id,
    url: "https://docs.e2e-fixture.example.org/security",
    title: "Security model",
    kind: "docs",
    sourceClass: "official_docs",
    contentMd: `# Security model\n\n${QUOTE}`,
    contentHash: "e2e-fixture-docs",
    origin: "admin",
  });
  await tx.insert(schema.evaluations).values({
    id: E2E_EVALUATION,
    projectId: E2E_PROJECT.id,
    versionId: "e2e-fixture-v1",
    status: "review",
    stage: "review",
    completedStages: ["ingest", "scout", "code", "research", "judge", "verify", "score"],
    mode: "standard",
    summary: "The fixture protocol keeps amounts and parties private; nobody can pause it.",
    summaryAt: now,
    powers: ["No protocol-level pause"],
    settings: { mode: "standard", evidenceCutoff: now.slice(0, 10) } as never,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
  });
  for (const c of criteria) {
    const best = c.options.reduce((a, b) => (b.points > a.points ? b : a));
    const flags = c.id === E2E_FLAGGED.accept ? ["judge_disagreement"] : c.id === E2E_FLAGGED.override ? ["evidence_conflict"] : [];
    await tx.insert(schema.evidence).values({
      id: `e2e-ev-${c.id}`,
      evaluationId: E2E_EVALUATION,
      criterionId: c.id,
      claim: "The docs state it.",
      quote: QUOTE,
      sourceId: "e2e-fixture-docs",
      url: "https://docs.e2e-fixture.example.org/security",
      stance: "supports",
      sourceClass: "official_docs",
      verified: true,
      verifyMethod: "exact",
      createdByStage: "research",
    });
    await tx.insert(schema.criterionResults).values({
      id: `e2e-cr-${c.id}`,
      evaluationId: E2E_EVALUATION,
      criterionId: c.id,
      status: "answered",
      optionId: best.id,
      rationale: "Seeded for the end-to-end tests.",
      confidence: "high",
      evidenceIds: [`e2e-ev-${c.id}`],
      flags,
      // Judged a minute before the summary was written, as in a real run (a later answer makes the summary stale).
      updatedAt: new Date(Date.parse(now) - 60_000).toISOString(),
    });
  }
});
await closeDb(db);
console.log(`[seed:e2e] seeded ${E2E_PROJECT.name} with evaluation ${E2E_EVALUATION} in review`);
