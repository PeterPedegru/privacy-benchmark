import { benchmarks, findCriterion, getCriterion, isFavorable, lowestOption, maxPoints, rubric, suites } from "./rubric.ts";
import type {
  AnswerMap,
  AppliedRule,
  BenchmarkDef,
  BenchmarkScore,
  CriterionDef,
  CriterionScore,
  PrivacyLevel,
  ScoreCard,
  SourceClass,
  SuiteId,
  SuiteScore,
  TrustTier,
  WalkawayResult,
} from "./types.ts";

// Criterion ids referenced by rules. Kept in one place so tests can assert they exist.
export const RULE_CRITERIA = {
  upgradeability: "governance.upgrades.upgradeability",
  blocklist: "custody.freeze.blocklist",
  pauseFn: "custody.pause.pause-fn",
  standingAccess: "trust.decryption.standing-access",
  infraVisibility: "trust.decryption.infra-visibility",
  openCritical: "security.soundness.open-critical",
  privateLogic: "coverage.execution.private-logic",
  privateState: "coverage.execution.private-state",
  amounts: "coverage.confidentiality.amounts",
  sender: "coverage.unlinkability.sender",
  recipient: "coverage.unlinkability.recipient",
  history: "coverage.unlinkability.history",
  publicApps: "coverage.unlinkability.public-apps",
  callTargets: "coverage.callstack.targets",
  callStructure: "coverage.callstack.structure",
  network: "coverage.metadata.network",
  reads: "coverage.metadata.reads",
  halt: "custody.pause.halt",
  unilateral: "custody.exit.unilateral",
  gatekeeper: "custody.exit.gatekeeper",
  recoverability: "custody.self-custody.recoverability",
  spending: "custody.self-custody.spending",
} as const;

/**
 * Criteria that decide a badge, cap or gate (Privacy Level, Trust Tier, Walkaway, the critical-issue flag).
 * They get the scrutiny of high-impact criteria: extra votes, the skeptic, the verifiability multiplier.
 */
export const BADGE_DRIVING: ReadonlySet<string> = new Set(Object.values(RULE_CRITERIA));

/** High-impact by benchmark, or badge-driving. */
export function isHighScrutiny(c: CriterionDef): boolean {
  return c.highImpact || BADGE_DRIVING.has(c.id);
}

export const VERIFIABILITY_MULTIPLIER: Record<SourceClass, number> = {
  code_onchain: 1,
  independent: 1,
  official_docs: 0.9,
  third_party: 0.8,
  marketing: 0.7,
};

/** Strength of a source class, strongest first: used to pick an answer's verifiability and to weigh conflicts. */
export const SOURCE_CLASS_RANK: Record<SourceClass, number> = { code_onchain: 5, independent: 4, official_docs: 3, third_party: 2, marketing: 1 };

/** The option that counts for scoring: the chosen one, the lowest one for unknowns, null otherwise. */
export function effectiveOptionId(answers: AnswerMap, criterionId: string): string | null {
  const a = answers[criterionId];
  if (!a) return null;
  if (a.status === "not_applicable" || a.status === "not_researched") return null;
  const c = findCriterion(criterionId);
  if (!c) return null;
  if (a.status === "unknown") return lowestOption(c).id;
  if (a.optionId && c.options.some((o) => o.id === a.optionId)) return a.optionId;
  return lowestOption(c).id;
}

/**
 * The option only when it was established from evidence. Badges, caps and gates use this: an unknown must never
 * turn into a public claim ("critical issue", "operator sees plaintext", "nothing is private").
 */
export function answeredOptionId(answers: AnswerMap, criterionId: string): string | null {
  const a = answers[criterionId];
  if (!a || a.status !== "answered") return null;
  const c = findCriterion(criterionId);
  return a.optionId && c?.options.some((o) => o.id === a.optionId) ? a.optionId : null;
}

function optionPoints(c: CriterionDef, optionId: string): number {
  return c.options.find((o) => o.id === optionId)?.points ?? 0;
}

function scoreCriterion(c: CriterionDef, answers: AnswerMap): CriterionScore {
  const a = answers[c.id];
  const max = maxPoints(c);
  if (!a) {
    return { criterionId: c.id, status: "missing", optionId: null, rawPoints: 0, points: 0, maxPoints: max, multiplier: 1, rules: [] };
  }
  if (a.status === "not_researched") {
    return { criterionId: c.id, status: "not_researched", optionId: null, rawPoints: 0, points: 0, maxPoints: 0, multiplier: 1, rules: [] };
  }
  if (a.status === "not_applicable" && c.naAllowed) {
    return { criterionId: c.id, status: "not_applicable", optionId: null, rawPoints: 0, points: 0, maxPoints: 0, multiplier: 1, rules: [] };
  }
  const rules: AppliedRule[] = [];
  const optionId = effectiveOptionId(answers, c.id) ?? lowestOption(c).id;
  if (a.status !== "answered") rules.push("unknown_lowest");
  const raw = optionPoints(c, optionId);
  let points = raw;

  // Rule 1: a power that can be added instantly already exists (only when instant upgrades are established).
  let cappedTo: string | null = null;
  if (answeredOptionId(answers, RULE_CRITERIA.upgradeability) === "instant") {
    const capOption = c.id === RULE_CRITERIA.blocklist ? "issuer-hooks" : c.id === RULE_CRITERIA.pauseFn ? "fast-path" : null;
    if (capOption && points > optionPoints(c, capOption)) {
      points = optionPoints(c, capOption);
      cappedTo = capOption;
      rules.push("instant_upgrade_power");
    }
  }

  // Verifiability multiplier on favorable answers to high-scrutiny criteria. Favorability is judged after caps
  // (a capped answer isn't discounted twice), and a favorable answer with no supporting class counts as marketing.
  // verifiability: undefined = not assessed (pure scoring, hand labels); null = assessed, no supporting source.
  let multiplier = 1;
  if (a.status === "answered" && isHighScrutiny(c) && isFavorable(c, cappedTo ?? optionId) && a.verifiability !== undefined) {
    multiplier = VERIFIABILITY_MULTIPLIER[a.verifiability ?? "marketing"];
    if (a.verifiability === null) rules.push("unsupported_favorable");
    else if (multiplier < 1) rules.push("verifiability_multiplier");
  }
  points = points * multiplier;

  return {
    criterionId: c.id,
    status: a.status === "not_applicable" ? "unknown" : a.status,
    optionId,
    rawPoints: raw,
    points,
    maxPoints: max,
    multiplier,
    rules,
  };
}

export function scoreBenchmark(b: BenchmarkDef, answers: AnswerMap, level: PrivacyLevel | null): BenchmarkScore {
  const criteria = b.criteria.map((c) => scoreCriterion(c, answers));
  const counted = criteria.filter((c) => c.status !== "missing" && c.status !== "not_applicable" && c.status !== "not_researched");
  const complete = criteria.every((c) => c.status !== "missing" && c.status !== "not_researched");
  const unknownCount = criteria.filter((c) => c.rules.includes("unknown_lowest")).length;
  const notResearchedCount = criteria.filter((c) => c.status === "not_researched").length;
  const rules: AppliedRule[] = [];

  if (counted.length === 0) {
    return { benchmarkId: b.id, score: null, uncapped: null, complete, unknownCount, notResearchedCount, rules, criteria };
  }
  const max = counted.reduce((s, c) => s + c.maxPoints, 0);
  const sum = counted.reduce((s, c) => s + c.points, 0);
  const uncapped = max > 0 ? (sum / max) * 100 : 0;
  let score = uncapped;

  // Caps and gates fire only on established facts. An unknown already scores as the riskiest option on its own
  // criterion; it must not also cap or zero whole benchmarks.
  if (b.id === "trust.decryption" && answeredOptionId(answers, RULE_CRITERIA.standingAccess) === "operator" && score > 15) {
    score = 15;
    rules.push("operator_visibility_cap");
  }
  if (b.id === "coverage.callstack" && answeredOptionId(answers, RULE_CRITERIA.privateLogic) === "none") {
    score = 0;
    rules.push("no_private_logic_gate");
  }
  if ((b.suite === "trust" || b.suite === "programmability") && level === "L0") {
    score = 0;
    rules.push("l0_gate");
  }
  return { benchmarkId: b.id, score, uncapped, complete, unknownCount, notResearchedCount, rules, criteria };
}

/**
 * Privacy Level from established answers only. The four base inputs (amounts, sender, recipient, history) must be
 * answered for any level; a higher level is claimed only when its own inputs are answered too. So an unknown can
 * hold a project at a lower proven level, but can never produce "L0: nothing is private".
 */
export function derivePrivacyLevel(answers: AnswerMap): PrivacyLevel | null {
  const o = (id: string) => answeredOptionId(answers, id);
  const base = [RULE_CRITERIA.amounts, RULE_CRITERIA.sender, RULE_CRITERIA.recipient, RULE_CRITERIA.history];
  if (base.some((id) => o(id) === null)) return null;
  const amountsHidden = o(RULE_CRITERIA.amounts) === "hidden";
  const sender = o(RULE_CRITERIA.sender);
  const recipient = o(RULE_CRITERIA.recipient);
  const linkHidden =
    sender === "hidden" || sender === "mixing" || recipient === "hidden" || recipient === "mixing" || o(RULE_CRITERIA.history) === "unlinkable";
  if (!amountsHidden && !linkHidden) return "L0";
  const l2 = amountsHidden && sender === "hidden" && recipient === "hidden";
  if (!l2) return "L1";
  const l4 = o(RULE_CRITERIA.privateState) === "general" && o(RULE_CRITERIA.privateLogic) === "general-hidden";
  if (l4) {
    const l5 =
      o(RULE_CRITERIA.callTargets) === "hidden" &&
      o(RULE_CRITERIA.callStructure) === "hidden" &&
      o(RULE_CRITERIA.network) === "default" &&
      o(RULE_CRITERIA.reads) === "local";
    return l5 ? "L5" : "L4";
  }
  return o(RULE_CRITERIA.publicApps) === "anonymous" ? "L3" : "L2";
}

/** Trust Tier from established answers only; null ("Unrated") when the deciding inputs aren't answered. */
export function deriveTrustTier(answers: AnswerMap, level: PrivacyLevel | null): TrustTier | null {
  if (level === null || level === "L0") return null;
  const sa = answeredOptionId(answers, RULE_CRITERIA.standingAccess);
  const iv = answeredOptionId(answers, RULE_CRITERIA.infraVisibility);
  // Facts that decide the tier on their own.
  if (sa === "operator" || iv === "plaintext") return "D";
  if (sa === null || iv === null) return null;
  if (sa === "threshold-large" || sa === "threshold-small" || sa === "single" || iv === "default-remote") return "C";
  if (iv === "tee") return "B";
  if (sa === "none" && iv === "none") return "A";
  return null;
}

const WALKAWAY_LABELS: Record<string, string> = {
  [RULE_CRITERIA.halt]: "halt resistance",
  [RULE_CRITERIA.unilateral]: "unilateral exit",
  [RULE_CRITERIA.gatekeeper]: "exit gatekeepers",
  [RULE_CRITERIA.recoverability]: "recoverability",
  [RULE_CRITERIA.spending]: "spending authority",
};

/**
 * The walkaway test: could users leave with their funds if the team disappeared or turned hostile? Fails only on
 * established facts; when an input isn't established the result is null with the missing inputs named.
 */
export function deriveWalkaway(answers: AnswerMap): WalkawayResult {
  const o = (id: string) => answeredOptionId(answers, id);
  const ids = [RULE_CRITERIA.halt, RULE_CRITERIA.unilateral, RULE_CRITERIA.gatekeeper, RULE_CRITERIA.recoverability, RULE_CRITERIA.spending];
  const reasons: string[] = [];
  const halt = o(RULE_CRITERIA.halt);
  const unilateral = o(RULE_CRITERIA.unilateral);
  // "small-set" needs collusion of several independent parties, so no single party can halt.
  if ((halt === "yes" || halt === null) && unilateral !== "permissionless" && halt !== null && unilateral !== null) {
    reasons.push("A single party can halt the system, and there is no live permissionless exit");
  }
  const gate = o(RULE_CRITERIA.gatekeeper);
  // A gated private exit doesn't fail the test (rubric 1.3.0): funds can always leave through the public exit.
  // It's noted on the badge and scored under Custody → Access.
  const notes = gate === "private-gated" ? { notes: ["Leaving privately can be gated by a third party; the public exit always works"] } : {};
  if (gate !== null && gate !== "none" && gate !== "private-gated") reasons.push("Exiting needs someone else's cooperation");
  const recover = o(RULE_CRITERIA.recoverability);
  if (recover !== null && recover !== "yes") reasons.push("Users can't recover funds without the operator");
  const spending = o(RULE_CRITERIA.spending);
  if (spending !== null && spending !== "user-only") reasons.push("Spending needs a party other than the user");
  if (reasons.length) return { passed: false, reasons, ...notes };
  // Halt is settled by either a halt answer or a permissionless exit.
  const missing = ids.filter(
    (id) =>
      o(id) === null &&
      !(id === RULE_CRITERIA.halt && unilateral === "permissionless") &&
      !(id === RULE_CRITERIA.unilateral && (halt === "no" || halt === "small-set")),
  );
  if (missing.length) return { passed: null, reasons: [`Not established: ${missing.map((id) => WALKAWAY_LABELS[id]).join(", ")}`], ...notes };
  return { passed: true, reasons: [], ...notes };
}

export function scoreSuite(suiteId: SuiteId, benchmarkScores: BenchmarkScore[]): SuiteScore {
  const suite = suites.find((s) => s.id === suiteId);
  if (!suite) throw new Error(`Unknown suite ${suiteId}`);
  const mine = suite.benchmarks.map((b) => benchmarkScores.find((s) => s.benchmarkId === b.id)!);
  let wSum = 0;
  let total = 0;
  suite.benchmarks.forEach((b, i) => {
    const s = mine[i]?.score;
    if (s === null || s === undefined) return;
    wSum += b.weight;
    total += b.weight * s;
  });
  const rules = [...new Set(mine.flatMap((m) => m.rules))];
  return {
    suiteId,
    score: wSum > 0 ? total / wSum : null,
    complete: mine.every((m) => m.complete),
    rules,
    benchmarks: mine,
  };
}

export type SuiteWeights = Record<SuiteId, number>;

export const OFFICIAL_WEIGHTS: SuiteWeights = rubric.presets.find((p) => p.official)!.weights;

/** Weighted overall from suite scores. Missing suites are skipped and the rest renormalized. */
export function overallFromSuites(suiteScores: { suiteId: SuiteId; score: number | null }[], weights: SuiteWeights = OFFICIAL_WEIGHTS): number | null {
  let wSum = 0;
  let total = 0;
  for (const s of suiteScores) {
    if (s.score === null) continue;
    const w = weights[s.suiteId] ?? 0;
    wSum += w;
    total += w * s.score;
  }
  return wSum > 0 ? total / wSum : null;
}

export function scoreProject(answers: AnswerMap, weights: SuiteWeights = OFFICIAL_WEIGHTS): ScoreCard {
  const level = derivePrivacyLevel(answers);
  const benchmarkScores = benchmarks.map((b) => scoreBenchmark(b, answers, level));
  const suiteScores = suites.map((s) => scoreSuite(s.id, benchmarkScores));
  return {
    rubricVersion: rubric.version,
    overall: overallFromSuites(suiteScores, weights),
    complete: suiteScores.every((s) => s.complete),
    level,
    trustTier: deriveTrustTier(answers, level),
    walkaway: deriveWalkaway(answers),
    suites: suiteScores,
  };
}

/** Round for display the same way everywhere: one decimal. */
export function fmtScore(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${(Math.round(v * 10) / 10).toFixed(1)}%`;
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export type ScoreBand = "strong" | "fair" | "weak" | "poor";
export function scoreBand(v: number): ScoreBand {
  if (v >= 75) return "strong";
  if (v >= 50) return "fair";
  if (v >= 25) return "weak";
  return "poor";
}

/**
 * Criteria whose answer changed between two answer sets. Compares status as well as option, so "unknown" vs an
 * answered lowest option, and answered vs not applicable, count as changes.
 */
export function diffAnswers(prev: AnswerMap, next: AnswerMap): { criterionId: string; from: string | null; to: string | null }[] {
  const key = (m: AnswerMap, id: string) => {
    const a = m[id];
    if (!a) return null;
    return a.status === "answered" ? (effectiveOptionId(m, id) ?? a.status) : a.status;
  };
  const out: { criterionId: string; from: string | null; to: string | null }[] = [];
  for (const b of benchmarks) {
    for (const c of b.criteria) {
      const from = key(prev, c.id);
      const to = key(next, c.id);
      if (from !== to) out.push({ criterionId: c.id, from, to });
    }
  }
  return out;
}

export function optionLabel(criterionId: string, optionId: string | null): string {
  if (!optionId) return "—";
  const c = getCriterion(criterionId);
  return c.options.find((o) => o.id === optionId)?.label ?? optionId;
}
