import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { criteria, rubric, scoreProject } from "@pb/rubric";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, type DB, openDb, schema, setDb } from "../src/db/index.ts";
import { REPO_ROOT } from "../src/env.ts";
import { importContribution, importPublishedBaseline, prepareContribution, readContribution } from "../src/services/contributions.ts";
import { evidenceCoverage } from "../src/services/coverage.ts";
import { answerMapFor, buildSnapshot, loadEvaluation } from "../src/services/snapshots.ts";

const text = "The private chain restricts networking to authenticated participants. No independent measurement is published.";
const source = {
  id: "architecture",
  url: "https://example.org/docs/architecture",
  title: "Architecture",
  kind: "docs",
  sourceClass: "official_docs",
  date: null,
  fetchedAt: "2026-10-07T00:00:00.000Z",
  contentHash: createHash("sha256").update(text).digest("hex"),
  contentMd: text,
  scope: "evaluated",
};
function fixture() {
  return {
    rubricVersion: rubric.version,
    asOf: "2026-10-07",
    attribution: "Independent contributor research; no automated evaluator was run.",
    project: { slug: "contribution-test", name: "Contribution test", website: "https://example.org", category: "privacy_app", mechanism: "private_execution" },
    version: { version: "live-2026-10-07", label: "Live configuration, documented 7 Oct 2026", releasedAt: null, sourceUrl: "https://example.org/docs" },
    summary: "Independent draft. Operator access has not been established.",
    context: { status: "Deployment correspondence unverified" },
    powers: [],
    matrix: {},
    answers: criteria.map((c) => ({
      criterionId: c.id,
      status: "unknown",
      optionId: null,
      rationale: "Documentation and available code were inspected, but the live configuration could not be established.",
      confidence: "low",
      evidence: [],
      searchLog: { searched: ["https://example.org/docs; pinned repository, relevant implementations"], note: "Live linkage unavailable.", codeChecked: true },
    })),
  };
}

describe("sourced manual contributions", () => {
  it("requires every criterion once, valid options, and only permitted N/A", () => {
    const missing = fixture();
    missing.answers.pop();
    expect(() => prepareContribution(missing, [source])).toThrow(/every criterion/i);
    const invalid = fixture();
    Object.assign(invalid.answers[0]!, { status: "answered", optionId: "invented" });
    expect(() => prepareContribution(invalid, [source])).toThrow(/option/i);
    Object.assign(invalid.answers[0]!, { status: "not_applicable", optionId: null });
    expect(() => prepareContribution(invalid, [source])).toThrow(/not applicable/i);
  });

  it("rejects changed archives, fabricated quotes, and context-only favorable evidence", () => {
    expect(() => prepareContribution(fixture(), [{ ...source, contentMd: "Changed" }])).toThrow(/hash/i);
    const input = fixture();
    Object.assign(input.answers[0]!, {
      status: "answered",
      optionId: criteria[0]!.options[0]!.id,
      evidence: [
        { sourceId: source.id, quote: "The public cannot read any state and administrators cannot upgrade the chain.", claim: "Hidden", stance: "supports" },
      ],
    });
    expect(() => prepareContribution(input, [source])).toThrow(/quote/i);
    input.answers[0]!.evidence[0] = {
      sourceId: source.id,
      quote: "The private chain restricts networking to authenticated participants.",
      claim: "Hidden",
      stance: "supports",
    } as never;
    expect(() => prepareContribution(input, [{ ...source, scope: "context" }])).toThrow(/context/i);
  });

  it("requires an actual research log for an unknown answer", () => {
    const input = fixture();
    input.answers[0]!.searchLog.searched = [];
    expect(() => prepareContribution(input, [source])).toThrow();
  });

  it("keeps a missing second code check visible at the normal publication gate", () => {
    const input = fixture();
    input.answers.find((a) => a.criterionId === "custody.pause.halt")!.searchLog.codeChecked = false;
    const prepared = prepareContribution(input, [source]);
    expect(prepared.coverage.badgeGaps).toContain("custody.pause.halt");
    expect(prepared.coverage.blocker).not.toBeNull();
  });

  it("validates the actual NEAR archives and researched unknowns without assigning adverse badges", () => {
    const prepared = readContribution(resolve(REPO_ROOT, "contributions/near-confidential-intents"));
    expect(prepared.data.answers).toHaveLength(106);
    expect(prepared.coverage).toMatchObject({ total: 106, notResearched: 0, badgeGaps: [], blocker: null });
    expect(prepared.scores.level).toBeNull();
    expect(prepared.scores.trustTier).toBeNull();
    expect(prepared.scores.walkaway.passed).toBe(false);
  });

  let db: DB;
  beforeAll(async () => {
    db = await openDb({ log: () => {} });
    setDb(db);
  });
  afterAll(async () => closeDb(db));

  it("rolls back a failure after insertion, including flags, sources and search logs", async () => {
    const input = fixture();
    input.project.slug = "failed-contribution";
    const prepared = prepareContribution(input, [source]);
    const tampered = { ...prepared, scores: { ...prepared.scores, overall: 123 } };
    await expect(importContribution(db, tampered)).rejects.toThrow(/scoring differs/i);
    expect(await db.select().from(schema.projects).where(eq(schema.projects.slug, input.project.slug))).toEqual([]);
    expect(await db.select().from(schema.sources)).toEqual([]);
    expect(await db.select().from(schema.criterionResults)).toEqual([]);
    expect(await db.select().from(schema.searchLogs)).toEqual([]);
    const id = await importContribution(db, prepared);
    expect((await loadEvaluation(db, id))!.evaluation.status).toBe("review");
    // Keep the following import/baseline scenarios independent of this retry.
    await db.delete(schema.projects).where(eq(schema.projects.slug, input.project.slug));
  });

  it("creates a non-demo review draft without publishing or accepting any flags", async () => {
    const prepared = prepareContribution(fixture(), [source]);
    const id = await importContribution(db, prepared);
    const bundle = (await loadEvaluation(db, id))!;
    expect(bundle.evaluation.status).toBe("review");
    expect(bundle.evaluation.isDemo).toBe(false);
    expect(bundle.evaluation.mode).toBe("manual");
    expect(bundle.evaluation.reviewedSuites).toEqual([]);
    expect(bundle.results).toHaveLength(criteria.length);
    expect(bundle.results.every((r) => !r.overrideStatus && !r.reviewedAt && r.flags.includes("unverified"))).toBe(true);
    expect(bundle.evaluation.settings.models).toEqual({});
    expect(await db.select().from(schema.publishedResults)).toEqual([]);
    expect(scoreProject(answerMapFor(bundle))).toEqual(prepared.scores);
    expect(await evidenceCoverage(db, id)).toMatchObject({ notResearched: 0, total: criteria.length, blocker: null });
    await expect(importContribution(db, prepared)).rejects.toThrow(/already exists/i);
    expect(await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, id))).toHaveLength(1);
  });

  it("archives baseline scores, sources and dates unchanged in an empty local database", async () => {
    const bundle = (await loadEvaluation(db, (await db.select().from(schema.evaluations))[0]!.id))!;
    const snapshot = buildSnapshot(bundle, {
      id: "upstream-release",
      label: "Upstream",
      publishedAt: "2026-10-02T12:00:00.000Z",
      isDemo: false,
      rubricVersion: rubric.version,
    });
    const local = await openDb({ log: () => {} });
    try {
      await importPublishedBaseline(local, [snapshot]);
      const rows = await local.select().from(schema.publishedResults);
      expect(rows[0]!.snapshot).toEqual(snapshot);
      expect(rows[0]!.overall).toBe(snapshot.scores.overall);
      expect(rows[0]!.createdAt).toBe(snapshot.release.publishedAt);
      expect(await local.select().from(schema.evaluations)).toEqual([]);
      await expect(importPublishedBaseline(local, [snapshot])).rejects.toThrow(/empty local/i);
      expect(await local.select().from(schema.publishedResults)).toHaveLength(1);
    } finally {
      await closeDb(local);
    }
  });
});
