import type { AdversaryMatrix, AnswerStatus, ScoreCard, SourceClass } from "@pb/rubric";

export type ProjectCategory = "l1" | "l2" | "privacy_pool" | "privacy_app" | "coprocessor" | "appchain" | "wallet" | "other";
export type Mechanism = "pool" | "shielded_ledger" | "stealth_address" | "confidential_amounts" | "private_execution" | "none";
export type SourceKind =
  | "docs"
  | "website"
  | "code"
  | "changes"
  | "announcement"
  | "audit"
  | "l2beat"
  | "defillama"
  | "governance"
  | "blog"
  | "news"
  | "analysis"
  | "onchain"
  | "attestation"
  | "incident"
  | "forum"
  | "advisory"
  | "registry"
  | "editor_note";

/** What the evaluator had in its knowledge base when it ran (counts per section). */
export interface KnowledgeBaseInfo {
  docs?: number;
  website?: number;
  code?: number;
  changes?: number;
  announcements?: number;
  news?: number;
  analysis?: number;
  data?: number;
  repos?: number;
  bytes?: number;
  refreshedAt: string | null;
}

export interface ProjectInfo {
  slug: string;
  name: string;
  website: string;
  logoUrl: string | null;
  tagline: string;
  description: string;
  category: ProjectCategory;
  mechanism: Mechanism;
  attributes: string[];
  chains: string[];
  l2beatSlug?: string | null;
  defillamaSlug?: string | null;
}

export interface SnapshotSource {
  id: string;
  url: string;
  title: string;
  kind: SourceKind;
  sourceClass: SourceClass;
  date: string | null;
  /** When the evaluator fetched it, and a hash of the text it quoted from (pages change; this pins the version). */
  fetchedAt?: string;
  contentHash?: string;
}

export interface SnapshotEvidence {
  id: string;
  sourceId: string;
  /** Always the source's own text (near matches store the matched span, not the researcher's rendering). */
  quote: string;
  claim: string;
  verified: boolean;
  citedUrl?: string | null;
  /** What the researcher said this quote shows: for or against a favorable answer, or neutral context. */
  stance?: "supports" | "contradicts" | "context";
  /** exact | fuzzy (near match; the stored quote is the source's text) | attestation (reproducible search). */
  match?: "exact" | "fuzzy" | "stitched" | "attestation" | "author" | "none";
  /** Text around the quote in the source, so readers can see what surrounds it. */
  context?: string | null;
  /** Source class when the evidence was recorded. */
  sourceClass?: SourceClass;
  /** The judge named this record as establishing the answer (verifiability is read from these). */
  decisive?: boolean;
}

export type CriterionFlag =
  | "unverified"
  | "low_confidence"
  | "judge_disagreement"
  | "skeptic_changed"
  | "changed_since_published"
  | "change_unexplained"
  | "self_reported"
  | "unsupported_favorable"
  | "needs_quote"
  | "evidence_conflict"
  | "context_only_evidence"
  | "no_evidence"
  | "not_researched"
  | "invalid_na"
  | "invalid_option"
  | "matrix_conflict"
  | "inconsistent_answers"
  | "l2beat_disagrees"
  | "editor_adjusted"
  | "skeptic_checked"
  | "medium_confidence"
  | "attestation_only_favorable"
  | "refused"
  | "evidence_missing"
  | "class_changed"
  | "attestation_offchain";

/** Flags that inform but don't need a reviewer's decision before publishing. */
export const INFO_FLAGS: ReadonlySet<CriterionFlag> = new Set<CriterionFlag>(["skeptic_checked", "editor_adjusted"]);

export interface AnswerChange {
  /**
   * protocol_change: this version changed the system; evidence_change: better evidence; rubric_change: the
   * criterion's definition changed since the earlier result; unexplained: likely evaluator variance.
   */
  kind: "protocol_change" | "evidence_change" | "rubric_change" | "unexplained";
  note: string;
  from: string | null;
  to: string | null;
}

export interface SnapshotCriterion {
  status: AnswerStatus;
  optionId: string | null;
  rationale: string;
  confidence: "high" | "medium" | "low";
  verifiability: SourceClass | null;
  flags: CriterionFlag[];
  override: { reason: string; originalOptionId: string | null } | null;
  evidence: SnapshotEvidence[];
  /** Why the answer differs from the previously published result, when it does. */
  change?: AnswerChange | null;
  /** For an unknown answer: what research searched without finding anything that settles it ("not disclosed"). */
  searchLog?: { searched: string[]; note: string; codeChecked?: boolean } | null;
}

/** How much of the rubric this result's evidence actually settles (published next to the score). */
export interface CoverageInfo {
  covered: number;
  total: number;
  suites: { suiteId: string; covered: number; total: number }[];
}

export interface ReleaseInfo {
  id: string;
  label: string;
  publishedAt: string;
  isDemo: boolean;
  rubricVersion: string;
  /** The weighting every result in the release is scored with (absent on releases from before weightings). */
  weightingId?: string | null;
}

/**
 * The weighting a result was scored with: which version (W1, W2…), where it came from, and a hash of its numbers.
 * The full numbers are at /api/public/weightings/<id>.
 */
export interface WeightingRef {
  id: string;
  /** Sequential per database; null for weights this database never stored (an older rubric's built-in ones). */
  number: number | null;
  /** "W2" */
  label: string;
  /** "Community poll #1", "Rubric 1.3.0 weights" */
  title: string;
  source: "rubric" | "poll";
  hash: string | null;
}

export interface EvalSettings {
  mode: "quick" | "standard" | "deep" | "manual";
  models: Record<string, string>;
  effort: Record<string, string>;
  /** This evaluation's spending cap, when it replaced the mode's (a local run's --cap). */
  costCapUsd?: number;
  /** Where its model calls run: the Anthropic API, or Claude Code sessions on the editor's machine (no API). */
  backend?: "api" | "claude-code";
  votesHighImpact: number;
  votesOther: number;
  maxToolCalls: Record<string, number>;
  promptHashes: Record<string, string>;
  evidenceCutoff: string;
  notes?: string;
  /**
   * Set for evaluations that run the code check: an unknown or "not disclosed" answer to a criterion the code can
   * decide is settled only once the code check searched for it.
   */
  codeCheck?: boolean;
}

export interface VersionInfo {
  id: string;
  version: string;
  label: string;
  releasedAt: string | null;
  source: "github_release" | "github_tag" | "manual";
  sourceUrl: string | null;
  tag: string | null;
  isMajor: boolean;
  summary: string;
}

export interface ProjectSnapshot {
  project: ProjectInfo;
  version: VersionInfo | null;
  release: ReleaseInfo;
  evaluatedAt: string;
  evidenceAsOf: string;
  summary: string;
  powers: string[];
  context: Record<string, string>;
  scores: ScoreCard;
  criteria: Record<string, SnapshotCriterion>;
  sources: SnapshotSource[];
  /** Absent on results published before knowledge bases existed. */
  knowledgeBase?: KnowledgeBaseInfo | null;
  /** Absent on results published before coverage was disclosed. */
  coverage?: CoverageInfo | null;
  matrix: AdversaryMatrix;
  /** The weighting the scores were computed with. Older results read as their rubric's own weighting. */
  weighting?: WeightingRef | null;
}

/** Compact per-project row for leaderboards and the benchmark table. */
export interface LeaderboardRow {
  slug: string;
  name: string;
  version: VersionInfo | null;
  /** Other published versions of this project, newest first. */
  otherVersions: { version: string; label: string }[];
  logoUrl: string | null;
  tagline: string;
  category: ProjectCategory;
  mechanism: Mechanism;
  overall: number | null;
  level: ScoreCard["level"];
  trustTier: ScoreCard["trustTier"];
  walkaway: ScoreCard["walkaway"];
  suites: Record<string, number | null>;
  benchmarks: Record<string, BenchmarkCell>;
  evaluatedAt: string;
  weighting?: WeightingRef | null;
}

export interface BenchmarkCell {
  score: number | null;
  unknownCount: number;
  unverifiedCount: number;
  capped: boolean;
  adjusted: boolean;
  selfReported: boolean;
}
