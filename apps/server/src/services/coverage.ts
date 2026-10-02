import { BADGE_DRIVING, criteria, getCriterion, suites } from "@pb/rubric";
import { eq } from "drizzle-orm";
import { type DB, schema } from "../db/index.ts";
import { isCodeCheckable, OFF_CHAIN_POWERS } from "../eval/absence.ts";

export interface EvidenceCoverage {
  /** Criteria settled by evidence (or an editor override), overall and per suite. */
  covered: number;
  total: number;
  ratio: number;
  suites: { suiteId: string; covered: number; total: number }[];
  notResearched: number;
  /** Badge-driving criteria (Privacy Level, Trust Tier, Walkaway, critical issue) that nothing settles: a blocker. */
  badgeGaps: string[];
  /** Why this evaluation can't be published, if it can't. */
  blocker: string | null;
}

/**
 * Below this share of settled criteria in any suite, a published suite score would describe the evaluation more
 * than the project. Unknown answers score as the riskiest option, so thin evidence publishes as a bad score.
 */
export const MIN_SUITE_COVERAGE = 0.6;

/**
 * Evidence that can settle a criterion: a verified quote taking a side, or a verified code-scope search
 * attestation. A docs-scope attestation can't: docs not mentioning something says little about the system.
 */
export function isEvidencing(e: { verified: boolean; stance: string; verifyNote: string | null; sourceClass?: string; criterionId?: string }): boolean {
  if (!e.verified) return false;
  // A code search can't show that a power held off-chain is absent (R5-1).
  if (e.verifyNote === "search attestation") return e.sourceClass !== "official_docs" && !(e.criterionId && OFF_CHAIN_POWERS.has(e.criterionId));
  return e.stance === "supports" || e.stance === "contradicts";
}

type ResultLike = {
  criterionId: string;
  status: string;
  optionId?: string | null;
  overrideStatus: string | null;
  decisiveEvidenceIds?: string[] | null;
  searchLog?: { searched: string[]; codeChecked?: boolean } | null;
};
type EvidenceLike = { id?: string; criterionId: string; verified: boolean; stance: string; verifyNote: string | null; sourceClass?: string };

/**
 * A criterion is settled when an editor decided it, when its answer rests on evidence that takes a side (the
 * judge's decisive records, or for older results any such record), or when a logged search found nothing: unknown,
 * or the criterion's "nothing published" option (rubric 1.3.0), both shown as "not disclosed". Pure: works on a loaded bundle (snapshots) or rows read from the DB (publish gate).
 */
export function coverageFrom(
  results: ResultLike[],
  evidence: EvidenceLike[],
  suiteFilter?: string[] | null,
  opts: { requireCodeCheck?: boolean } = {},
): EvidenceCoverage {
  const evidencing = evidence.filter(isEvidencing);
  const byCriterion = new Set(evidencing.map((e) => e.criterionId));
  const ids = new Set(evidencing.map((e) => e.id).filter(Boolean));
  const result = new Map(results.map((r) => [r.criterionId, r]));
  const notResearched = results.filter((r) => r.status === "not_researched" && !r.overrideStatus).map((r) => r.criterionId);
  // "Not disclosed" needs a logged search, and where the code could decide the criterion, the code check's search
  // too (evaluations that run it).
  const searched = (r: ResultLike) =>
    !!r.searchLog?.searched?.length && (!opts.requireCodeCheck || !isCodeCheckable(r.criterionId) || !!r.searchLog.codeChecked);
  const settled = (id: string) => {
    const r = result.get(id);
    if (!r) return byCriterion.has(id);
    if (r.overrideStatus) return true;
    if (r.status === "unknown") return searched(r);
    if (r.status === "not_researched") return false;
    if (r.searchLog?.searched?.length && r.optionId && r.optionId === getCriterion(id).noDataOption) return searched(r);
    return r.decisiveEvidenceIds?.length ? r.decisiveEvidenceIds.some((e) => ids.has(e)) : byCriterion.has(id);
  };
  const scoped = suites.filter((s) => !suiteFilter?.length || suiteFilter.includes(s.id));
  const perSuite = scoped.map((s) => {
    const ids = s.benchmarks.flatMap((b) => b.criteria.map((c) => c.id));
    return { suiteId: s.id, name: s.name, covered: ids.filter(settled).length, total: ids.length };
  });
  const scopedIds = new Set(scoped.flatMap((s) => s.benchmarks.flatMap((b) => b.criteria.map((c) => c.id))));
  const covered = criteria.filter((c) => scopedIds.has(c.id) && settled(c.id)).length;
  const total = scopedIds.size;
  const ratio = total ? covered / total : 0;
  // A badge input nobody settled leaves its badge Unrated by default; an editor decides it, or research logs
  // that the project doesn't disclose it.
  const badgeGaps = [...BADGE_DRIVING].filter((id) => scopedIds.has(id) && !settled(id));
  const thin = perSuite.filter((s) => s.covered / s.total < MIN_SUITE_COVERAGE);
  const suiteOf = (id: string) => getCriterion(id).id.split(".")[0];
  const blocker = notResearched.length
    ? `${notResearched.length} criteria were never researched (${[...new Set(notResearched.map(suiteOf))].join(", ")}). Re-run those suites before publishing.`
    : thin.length
      ? `Too few criteria are settled (answered from evidence, or searched and logged as not disclosed) in ${thin.map((s) => `${s.name} (${s.covered}/${s.total})`).join(", ")}; each suite needs at least ${Math.round(MIN_SUITE_COVERAGE * 100)}%. Re-run those suites or settle criteria in review.`
      : badgeGaps.length
        ? `${badgeGaps.length} badge-deciding ${badgeGaps.length === 1 ? "criterion is" : "criteria are"} unsettled (${badgeGaps.join(", ")}): override ${badgeGaps.length === 1 ? "it" : "them"} in review, or re-run the suite so research and the code check log their search.`
        : null;
  return {
    covered,
    total,
    ratio,
    suites: perSuite.map(({ name: _n, ...rest }) => rest),
    notResearched: notResearched.length,
    badgeGaps,
    blocker,
  };
}

/** Coverage across the whole rubric: a partial (suite-filtered) evaluation can't be published on its own. */
export async function evidenceCoverage(db: DB, evaluationId: string): Promise<EvidenceCoverage> {
  const results = await db
    .select({
      criterionId: schema.criterionResults.criterionId,
      status: schema.criterionResults.status,
      optionId: schema.criterionResults.optionId,
      overrideStatus: schema.criterionResults.overrideStatus,
      decisiveEvidenceIds: schema.criterionResults.decisiveEvidenceIds,
      searchLog: schema.criterionResults.searchLog,
    })
    .from(schema.criterionResults)
    .where(eq(schema.criterionResults.evaluationId, evaluationId));
  const evidence = await db
    .select({
      id: schema.evidence.id,
      criterionId: schema.evidence.criterionId,
      verified: schema.evidence.verified,
      stance: schema.evidence.stance,
      verifyNote: schema.evidence.verifyNote,
      sourceClass: schema.evidence.sourceClass,
    })
    .from(schema.evidence)
    .where(eq(schema.evidence.evaluationId, evaluationId));
  const settings = (await db.select({ s: schema.evaluations.settings }).from(schema.evaluations).where(eq(schema.evaluations.id, evaluationId)))[0]?.s as
    | { codeCheck?: boolean }
    | undefined;
  return coverageFrom(results, evidence, null, { requireCodeCheck: !!settings?.codeCheck });
}
