export type SuiteId = "coverage" | "trust" | "custody" | "programmability" | "governance" | "decentralization" | "security";

export type AdversaryId = "public_observer" | "chain_analyst" | "network_observer" | "privileged_insider" | "future_adversary";

export type MatrixField = "sender" | "recipient" | "amount" | "asset" | "link" | "function" | "metadata";
export type MatrixState = "private" | "at_risk" | "exposed" | "unverifiable" | "n_a";

/**
 * Who stands behind a source. independent: auditors, L2BEAT, academic work, data providers, incident trackers.
 * third_party: news, blogs and aggregators (they often restate the project). marketing: the project's own
 * promotional pages and anyone with a stake in the result (a competitor's blog).
 */
export type SourceClass = "code_onchain" | "independent" | "official_docs" | "third_party" | "marketing";

export interface OptionDef {
  id: string;
  label: string;
  points: number;
}

export interface CriterionDef {
  /** Fully qualified id: `${suite}.${benchmark}.${key}` */
  id: string;
  key: string;
  benchmarkId: string;
  label: string;
  question: string;
  guidance: string;
  highImpact: boolean;
  naAllowed: boolean;
  options: OptionDef[];
  evidenceHints: string[];
  /**
   * The option that means "nothing is published" (Unclear, No independent study yet, No published figure). When
   * research logs a genuine search that found nothing, the answer is this option rather than unknown (rubric 1.3.0).
   */
  noDataOption: string | null;
}

export interface BenchmarkDef {
  /** `${suite}.${key}` */
  id: string;
  key: string;
  suite: SuiteId;
  name: string;
  question: string;
  description: string;
  /** Weight within the suite, 0–100; weights in a suite sum to 100. */
  weight: number;
  highImpact: boolean;
  notes: string[];
  criteria: CriterionDef[];
}

export interface SuiteDef {
  id: SuiteId;
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  /** Weight in the overall score, 0–100; suite weights sum to 100. */
  weight: number;
  adversaries: AdversaryId[];
  benchmarks: BenchmarkDef[];
}

export interface WeightPreset {
  id: string;
  name: string;
  description: string;
  official: boolean;
  weights: Record<SuiteId, number>;
}

export interface Rubric {
  version: string;
  releasedAt: string;
  suites: SuiteDef[];
  presets: WeightPreset[];
}

// ---------- evaluation inputs ----------

/**
 * answered: an option was chosen from verified evidence.
 * unknown: researched, but the evidence couldn't settle it (scores as the riskiest option).
 * not_researched: the evaluation never gathered evidence for it (excluded from points; blocks publishing).
 * not_applicable: only where the criterion allows it.
 */
export type AnswerStatus = "answered" | "unknown" | "not_researched" | "not_applicable";

export interface CriterionAnswer {
  criterionId: string;
  status: AnswerStatus;
  optionId?: string | null;
  /**
   * Best verified source class supporting this answer (drives the verifiability multiplier on favorable answers).
   * undefined = not assessed; null = assessed and nothing supports it (discounted like marketing).
   */
  verifiability?: SourceClass | null;
}

export type AnswerMap = Record<string, CriterionAnswer>;

// ---------- scoring outputs ----------

export type AppliedRule =
  | "instant_upgrade_power"
  | "operator_visibility_cap"
  | "critical_bug_cap"
  | "no_private_logic_gate"
  | "l0_gate"
  | "verifiability_multiplier"
  | "unsupported_favorable"
  | "unknown_lowest";

export interface CriterionScore {
  criterionId: string;
  status: AnswerStatus | "missing";
  optionId: string | null;
  /** Points before multipliers/caps. */
  rawPoints: number;
  /** Points after multipliers/caps. */
  points: number;
  maxPoints: number;
  multiplier: number;
  rules: AppliedRule[];
}

export interface BenchmarkScore {
  benchmarkId: string;
  /** 0–100, or null when no criterion was evaluated. */
  score: number | null;
  /** Sum of points / sum of max points before benchmark-level caps/gates, 0–100. */
  uncapped: number | null;
  complete: boolean;
  unknownCount: number;
  /** Criteria with no research at all (excluded from points). */
  notResearchedCount: number;
  rules: AppliedRule[];
  criteria: CriterionScore[];
}

export interface SuiteScore {
  suiteId: SuiteId;
  score: number | null;
  complete: boolean;
  rules: AppliedRule[];
  benchmarks: BenchmarkScore[];
}

/**
 * Privacy Level Z0 (nothing hidden) to Z5 (full-stack private). Named Z rather than L so it isn't read as a chain's
 * layer (L1, L2). Results published before the rename stored L0 to L5; normalizeLevel reads either.
 */
export type PrivacyLevel = "Z0" | "Z1" | "Z2" | "Z3" | "Z4" | "Z5";
export type TrustTier = "A" | "B" | "C" | "D";

export interface WalkawayResult {
  /** null when the criteria it depends on haven't been established (answered from evidence). */
  passed: boolean | null;
  reasons: string[];
  /** Caveats that don't fail the test (a gated private exit). */
  notes?: string[];
}

export interface ScoreCard {
  rubricVersion: string;
  overall: number | null;
  complete: boolean;
  level: PrivacyLevel | null;
  trustTier: TrustTier | null;
  walkaway: WalkawayResult;
  suites: SuiteScore[];
}

export interface MatrixCell {
  state: MatrixState;
  note?: string;
  evidenceIds?: string[];
}

export type AdversaryMatrix = Partial<Record<AdversaryId, Partial<Record<MatrixField, MatrixCell>>>>;
