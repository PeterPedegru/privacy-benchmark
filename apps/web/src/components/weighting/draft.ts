import type { BallotInput } from "@pb/core";
import { adjustableOptions, type Ballot, benchmarks, criteria, suites, type WeightingShares } from "@pb/rubric";

/**
 * A ballot being edited: an importance (0–100) for every suite, benchmark and criterion, and a credit (0–100) for
 * every in-between answer. It starts at the base weighting's shares, so an untouched slider reads as the current
 * weight; the ballot sent carries only the groups and credits that differ from the base.
 */
export interface Draft {
  suites: Record<string, number>;
  benchmarks: Record<string, number>;
  criteria: Record<string, number>;
  credits: Record<string, Record<string, number>>;
}

/** Changes smaller than this (percentage points) are rounding, not a vote. */
const EPS = 0.05;

export const SUITE_GROUP = suites.map((s) => s.id);
export const BENCHMARK_GROUPS = Object.fromEntries(suites.map((s) => [s.id, s.benchmarks.map((b) => b.id)]));
export const CRITERION_GROUPS = Object.fromEntries(benchmarks.map((b) => [b.id, b.criteria.map((c) => c.id)]));

/** Values as percentages of their group's sum. */
export function normalize(values: Record<string, number>, ids: string[]): Record<string, number> {
  const sum = ids.reduce((s, id) => s + (values[id] ?? 0), 0);
  return Object.fromEntries(ids.map((id) => [id, sum > 0 ? ((values[id] ?? 0) * 100) / sum : 0]));
}

export function groupChanged(values: Record<string, number>, base: Record<string, number>, ids: string[]): boolean {
  const n = normalize(values, ids);
  return ids.some((id) => Math.abs(n[id]! - base[id]!) > EPS);
}

export function draftFrom(base: WeightingShares, ballot?: BallotInput | Ballot | null): Draft {
  const d: Draft = {
    suites: { ...base.suites },
    benchmarks: { ...base.benchmarks },
    criteria: { ...base.criteria },
    credits: Object.fromEntries(criteria.map((c) => [c.id, Object.fromEntries(adjustableOptions(c).map((o) => [o.id, base.credits[c.id]![o.id]!]))])),
  };
  if (!ballot) return d;
  const lay = (target: Record<string, number>, given: Record<string, number> | undefined, groups: string[][]) => {
    for (const ids of groups) if (given && ids.every((id) => typeof given[id] === "number")) for (const id of ids) target[id] = given[id]!;
  };
  lay(d.suites, ballot.suites, [SUITE_GROUP]);
  lay(d.benchmarks, ballot.benchmarks, Object.values(BENCHMARK_GROUPS));
  lay(d.criteria, ballot.criteria, Object.values(CRITERION_GROUPS));
  for (const [cid, opts] of Object.entries(ballot.credits ?? {}))
    for (const [oid, v] of Object.entries(opts ?? {})) if (d.credits[cid] && oid in d.credits[cid]) d.credits[cid][oid] = v;
  return d;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const rounded = (values: Record<string, number>, ids: string[]) => Object.fromEntries(ids.map((id) => [id, r2(values[id] ?? 0)]));

/** The ballot a draft stands for: only what differs from the base (an empty ballot keeps every weight). */
export function ballotFrom(d: Draft, base: WeightingShares): Ballot {
  const b: Ballot = {};
  if (groupChanged(d.suites, base.suites, SUITE_GROUP)) b.suites = rounded(d.suites, SUITE_GROUP);
  for (const ids of Object.values(BENCHMARK_GROUPS))
    if (groupChanged(d.benchmarks, base.benchmarks, ids)) b.benchmarks = { ...b.benchmarks, ...rounded(d.benchmarks, ids) };
  for (const ids of Object.values(CRITERION_GROUPS))
    if (groupChanged(d.criteria, base.criteria, ids)) b.criteria = { ...b.criteria, ...rounded(d.criteria, ids) };
  for (const [cid, opts] of Object.entries(d.credits))
    for (const [oid, v] of Object.entries(opts))
      if (Math.abs(v - base.credits[cid]![oid]!) > EPS) b.credits = { ...b.credits, [cid]: { ...b.credits?.[cid], [oid]: r2(v) } };
  return b;
}

/** How many sliders were moved from where they started (what a voter thinks of as their changes). */
export function movedCount(d: Draft, base: WeightingShares): number {
  let n = 0;
  for (const kind of ["suites", "benchmarks", "criteria"] as const) for (const [id, v] of Object.entries(d[kind])) if (Math.abs(v - base[kind][id]!) > EPS) n++;
  for (const [cid, opts] of Object.entries(d.credits)) for (const [oid, v] of Object.entries(opts)) if (Math.abs(v - base.credits[cid]![oid]!) > EPS) n++;
  return n;
}

/** Restores a group (or a criterion's credits) to the base. */
export function resetGroup(d: Draft, base: WeightingShares, kind: "suites" | "benchmarks" | "criteria" | "credits", ids: string[]): Draft {
  if (kind === "credits") return { ...d, credits: { ...d.credits, ...Object.fromEntries(ids.map((cid) => [cid, draftFrom(base).credits[cid]!])) } };
  return { ...d, [kind]: { ...d[kind], ...Object.fromEntries(ids.map((id) => [id, base[kind][id]!])) } };
}

// ---------- the draft survives a sign-in round trip ----------

const key = (pollId: string) => `pb:ballot-draft:${pollId}`;

export function saveDraft(pollId: string, b: Ballot) {
  try {
    sessionStorage.setItem(key(pollId), JSON.stringify(b));
  } catch {
    // private mode or storage blocked: the draft is only a convenience
  }
}

/** A saved draft with changes in it; an empty one isn't a draft (it would hide the voter's stored ballot). */
export function loadDraft(pollId: string): Ballot | null {
  try {
    const raw = sessionStorage.getItem(key(pollId));
    const b = raw ? (JSON.parse(raw) as Ballot) : null;
    return b && typeof b === "object" && Object.keys(b).length ? b : null;
  } catch {
    return null;
  }
}

export function clearDraft(pollId: string) {
  try {
    sessionStorage.removeItem(key(pollId));
  } catch {
    // nothing to clear
  }
}
