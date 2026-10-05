import type { ProjectSnapshot } from "@pb/core";
import { type BenchmarkScore, benchmarks, type CriterionScore, suites } from "@pb/rubric";

export const refOf = (s: ProjectSnapshot) => (s.version ? `${s.project.slug}@${s.version.version}` : s.project.slug);
export const labelOf = (s: ProjectSnapshot) => s.project.name;

export function matchesRef(s: ProjectSnapshot, ref: string | null | undefined) {
  if (!ref) return false;
  return ref === refOf(s) || ref === s.project.slug;
}

export function benchmarkScore(s: ProjectSnapshot, benchmarkId: string): BenchmarkScore | undefined {
  for (const su of s.scores.suites) {
    const b = su.benchmarks.find((x) => x.benchmarkId === benchmarkId);
    if (b) return b;
  }
  return undefined;
}

export function suiteScore(s: ProjectSnapshot, suiteId: string): number | null {
  return s.scores.suites.find((x) => x.suiteId === suiteId)?.score ?? null;
}

export function criterionScore(s: ProjectSnapshot, criterionId: string): CriterionScore | undefined {
  for (const su of s.scores.suites) for (const b of su.benchmarks) for (const c of b.criteria) if (c.criterionId === criterionId) return c;
  return undefined;
}

/** Indices of the best value(s) in a row, comparing at display precision. */
export function bestIndices(values: (number | null | undefined)[]): number[] {
  const r = values.map((v) => (v === null || v === undefined ? Number.NEGATIVE_INFINITY : Math.round(v * 10) / 10));
  const max = Math.max(...r);
  if (!Number.isFinite(max)) return [];
  return r.flatMap((v, i) => (v === max ? [i] : []));
}

export interface CellMarks {
  unverified: number;
  adjusted: boolean;
  selfReported: boolean;
  capped: boolean;
}

export function cellMarks(s: ProjectSnapshot, benchmarkId: string): CellMarks {
  const b = benchmarkScore(s, benchmarkId);
  if (!b) return { unverified: 0, adjusted: false, selfReported: false, capped: false };
  const crits = b.criteria.map((c) => s.criteria[c.criterionId]);
  return {
    unverified: crits.filter((c) => c?.flags.includes("unverified")).length,
    adjusted: crits.some((c) => c?.flags.includes("editor_adjusted")),
    selfReported: crits.some((c) => c?.flags.includes("self_reported")),
    capped: b.rules.length > 0 || b.criteria.some((c) => c.rules.includes("instant_upgrade_power")),
  };
}

export const RULE_TEXT: Record<string, string> = {
  instant_upgrade_power: "Instant upgrades: a power that can be added instantly already exists, so this option is capped.",
  operator_visibility_cap: "The operator sees plaintext routinely, so Decryption power is capped at 15%.",
  critical_bug_cap: "A disclosed, unpatched critical vulnerability caps Soundness record at 30%.",
  no_private_logic_gate: "No private logic, so there's no private call stack: this benchmark scores 0.",
  l0_gate: "Nothing is hidden: the Trust and Programmability suites score 0.",
  verifiability_multiplier:
    "Favorable answer whose strongest source is the project's docs, a news or third-party page, or its marketing: points multiplied by 0.9, 0.8 or 0.7.",
  unknown_lowest: "Unknown: the evidence couldn't settle it, so it scores as the riskiest option.",
  unsupported_favorable: "Favorable answer with no supporting source recorded: points multiplied by 0.7, like marketing.",
};

export const ALL_BENCHMARK_IDS = benchmarks.map((b) => b.id);
export const SUITE_IDS = suites.map((s) => s.id);
