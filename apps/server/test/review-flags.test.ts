/**
 * Review flags and evidence invariants (R3-JDG-5, R4-1, R4-4, R4-8, R4-10): what reaches a reviewer, what stays
 * accepted, and what can't be published.
 */
import { criteria, getCriterion, isHighScrutiny } from "@pb/rubric";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { type DB, openDb, schema, setDb } from "../src/db/index.ts";
import { silentEmitter } from "../src/eval/events.ts";
import { flagMissingEvidence, storeReviewFlags } from "../src/eval/pipeline.ts";
import { runTool } from "../src/eval/tools.ts";
import { syncEvidenceClasses } from "../src/services/evidence-classes.ts";

let db: DB;
const QUOTE = "The pool contract has no owner and no function that can pause withdrawals at any time.";

beforeAll(async () => {
  db = await openDb({ log: () => {} });
  setDb(db);
  await db.insert(schema.projects).values({ id: "p1", slug: "alpha", name: "Alpha", websiteUrl: "https://alpha.example.org" });
  await db.insert(schema.sources).values({
    id: "s1",
    projectId: "p1",
    url: "https://news.example.org/alpha",
    title: "News",
    contentMd: QUOTE,
    contentHash: "h",
    sourceClass: "independent",
  });
  await db.insert(schema.evaluations).values({ id: "e1", projectId: "p1", mode: "standard", status: "review", stage: "review" });
});

const top = (id: string) => getCriterion(id).options.reduce((a, o) => (o.points > a.points ? o : a));
const result = async (criterionId: string, values: Partial<typeof schema.criterionResults.$inferInsert> = {}) =>
  await db
    .insert(schema.criterionResults)
    .values({ id: `r-${criterionId}`, evaluationId: "e1", criterionId, status: "answered", optionId: top(criterionId).id, confidence: "high", ...values });
const evidence = async (id: string, criterionId: string, values: Partial<typeof schema.evidence.$inferInsert> = {}) =>
  await db.insert(schema.evidence).values({
    id,
    evaluationId: "e1",
    criterionId,
    quote: QUOTE,
    sourceId: "s1",
    stance: "supports",
    verified: true,
    verifyMethod: "exact",
    sourceClass: "independent",
    ...values,
  });
const flagsOf = async (criterionId: string) =>
  (
    await db
      .select()
      .from(schema.criterionResults)
      .where(eq(schema.criterionResults.id, `r-${criterionId}`))
  )[0]!.flags;

describe("stored review flags (R3-JDG-5)", () => {
  it("flags medium confidence where it matters and top answers resting only on searches", async () => {
    await evidence("ev-mc", "custody.pause.pause-fn");
    await result("custody.pause.pause-fn", { confidence: "medium", evidenceIds: ["ev-mc"], decisiveEvidenceIds: ["ev-mc"] });
    await evidence("ev-att", "governance.upgrades.upgradeability", { verifyNote: "search attestation", sourceClass: "code_onchain" });
    await result("governance.upgrades.upgradeability", { evidenceIds: ["ev-att"], decisiveEvidenceIds: ["ev-att"] });
    // A low-stakes criterion at a middle option with medium confidence isn't flagged.
    const low = criteria.find((c) => !isHighScrutiny(c) && c.options.length >= 3 && c.options[1]!.points < top(c.id).points)!;
    await result(low.id, { confidence: "medium", optionId: low.options[1]!.id });
    await storeReviewFlags(db, "e1");
    expect(await flagsOf("custody.pause.pause-fn")).toContain("medium_confidence");
    expect(await flagsOf("governance.upgrades.upgradeability")).toContain("attestation_only_favorable");
    expect(await flagsOf(low.id)).not.toContain("medium_confidence");
  });

  it("keeps a flag a reviewer accepted while the answer is unchanged, and brings it back when the answer changes (R4-4)", async () => {
    const id = "custody.pause.pause-fn";
    await db
      .update(schema.criterionResults)
      .set({ flags: [], acceptedFlags: { flags: ["medium_confidence"], status: "answered", optionId: top(id).id } })
      .where(eq(schema.criterionResults.id, `r-${id}`));
    await storeReviewFlags(db, "e1");
    expect(await flagsOf(id)).not.toContain("medium_confidence");
    const other = getCriterion(id).options.find((o) => o.id !== top(id).id)!;
    await db
      .update(schema.criterionResults)
      .set({ optionId: other.id })
      .where(eq(schema.criterionResults.id, `r-${id}`));
    await storeReviewFlags(db, "e1");
    expect(await flagsOf(id)).toContain("medium_confidence");
  });
});

describe("evidence invariants", () => {
  it("flags an answer whose cited evidence no longer exists (R4-1)", async () => {
    const id = "custody.exit.unilateral";
    await result(id, { evidenceIds: ["gone"], decisiveEvidenceIds: ["gone"] });
    expect(await flagMissingEvidence(db, "e1")).toBeGreaterThan(0);
    expect(await flagsOf(id)).toContain("evidence_missing");
  });

  it("gives evidence its source's new class and flags the answers whose weight moved (R4-8)", async () => {
    const id = "custody.freeze.blocklist";
    await evidence("ev-news", id);
    await result(id, { evidenceIds: ["ev-news"], decisiveEvidenceIds: ["ev-news"] });
    await db.update(schema.sources).set({ sourceClass: "third_party" }).where(eq(schema.sources.id, "s1"));
    expect(await syncEvidenceClasses(db)).toBeGreaterThan(0);
    expect((await db.select().from(schema.evidence).where(eq(schema.evidence.id, "ev-news")))[0]!.sourceClass).toBe("third_party");
    expect(await flagsOf(id)).toContain("class_changed");
    // Search attestations keep their own class, and a second sync changes nothing.
    expect((await db.select().from(schema.evidence).where(eq(schema.evidence.id, "ev-att")))[0]!.sourceClass).toBe("code_onchain");
    expect(await syncEvidenceClasses(db)).toBe(0);
  });
});

describe("absence attestations for powers that live off-chain (R4-10)", () => {
  it("refuses to attest issuer seizure, key custody or screening from a code search", async () => {
    const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, "p1")))[0]!;
    const ctx = {
      db,
      evaluationId: "e1",
      project,
      version: null,
      stage: "research.custody",
      allowedCriteria: new Set(["custody.freeze.seizure", "custody.access.screening", "trust.decryption.standing-access"]),
      emit: silentEmitter(),
      evidenceCount: { n: 0 },
    };
    for (const criterionId of ctx.allowedCriteria) {
      const out = await runTool("record_absence", { criterionId, scope: "code", repos: [], patterns: ["seize"], claim: "none" }, ctx);
      expect(out, criterionId).toMatch(/usually lives off-chain/);
    }
  });
});

describe("round-5 evidence fixes", () => {
  it("stops stored attestations on off-chain powers from counting, and flags the answers (R5-1)", async () => {
    const { invalidateOffchainAttestations } = await import("../src/services/evidence-classes.ts");
    await evidence("ev-seize", "custody.freeze.seizure", { verifyNote: "search attestation", sourceClass: "code_onchain" });
    await result("custody.freeze.seizure", { evidenceIds: ["ev-seize"], decisiveEvidenceIds: ["ev-seize"] });
    expect(await invalidateOffchainAttestations(db)).toBe(1);
    expect((await db.select().from(schema.evidence).where(eq(schema.evidence.id, "ev-seize")))[0]!.verified).toBe(false);
    expect(await flagsOf("custody.freeze.seizure")).toContain("attestation_offchain");
    expect(await invalidateOffchainAttestations(db)).toBe(0);
  });

  it("flags a class change only when the answer's weight moved (R5-4)", async () => {
    const id = "custody.freeze.systemic";
    // Decisive: unchanged onchain code. Also cited: a context news record that gets reclassified.
    await db.insert(schema.sources).values({
      id: "s-code",
      projectId: "p1",
      url: "https://github.com/alpha/core/blob/v1/Pool.sol",
      title: "Pool",
      contentMd: QUOTE,
      contentHash: "hc",
      sourceClass: "code_onchain",
    });
    await db.insert(schema.sources).values({
      id: "s-news2",
      projectId: "p1",
      url: "https://news.example.org/two",
      title: "News 2",
      contentMd: QUOTE,
      contentHash: "hn2",
      sourceClass: "independent",
    });
    await evidence("ev-code", id, { sourceId: "s-code", sourceClass: "code_onchain" });
    await evidence("ev-ctx", id, { sourceId: "s-news2", stance: "context", sourceClass: "independent" });
    await result(id, { evidenceIds: ["ev-code", "ev-ctx"], decisiveEvidenceIds: ["ev-code"] });
    await db.update(schema.sources).set({ sourceClass: "third_party" }).where(eq(schema.sources.id, "s-news2"));
    expect(await syncEvidenceClasses(db)).toBeGreaterThan(0);
    expect((await db.select().from(schema.evidence).where(eq(schema.evidence.id, "ev-ctx")))[0]!.sourceClass).toBe("third_party");
    expect(await flagsOf(id)).not.toContain("class_changed");
  });
});
