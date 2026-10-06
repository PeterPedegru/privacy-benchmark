import type { LeaderboardWeighting, WeightingRef } from "@pb/core";
import { DEFAULT_WEIGHTING, rubric, sharesOf, type Weighting, type WeightingShares } from "@pb/rubric";
import { useLeaderboard, useWeighting } from "./queries";
import { fmtNum } from "./utils";

/** The current rubric's own weighting, which needs no request. */
export const RUBRIC_WEIGHTING_ID = `rubric-${rubric.version}`;

const isRubricOwn = (ref: Pick<WeightingRef, "id" | "number"> | null | undefined) => !ref || ref.id === RUBRIC_WEIGHTING_ID || ref.number === null;

/**
 * The numbers a result was scored with: the rubric's own, or another weighting's, fetched once (a weighting never
 * changes). Null while those load or if they can't: callers show no weight rather than the wrong one.
 */
export function useWeightingConfig(ref: Pick<WeightingRef, "id" | "number"> | null | undefined): Weighting | null {
  const own = isRubricOwn(ref);
  const q = useWeighting(ref?.id ?? "", { enabled: !own });
  if (own) return DEFAULT_WEIGHTING;
  return (q.data?.config as Weighting | undefined) ?? null;
}

/** Every weight of a result's weighting as a share of its group, or null while it loads. */
export function useWeightingShares(ref: Pick<WeightingRef, "id" | "number"> | null | undefined): WeightingShares | null {
  const w = useWeightingConfig(ref);
  return w ? sharesFor(w) : null;
}

/**
 * The weighting most of the leaderboard is scored with (the published one) and its suite shares, straight from the
 * leaderboard response: no request of its own, so pages don't render the rubric's numbers first. Null until loaded.
 */
export function usePublishedWeighting(): { ref: LeaderboardWeighting | null; suites: Record<string, number> | null; mixed: boolean } {
  const lb = useLeaderboard();
  const list = lb.data?.weightings ?? [];
  const top = list[0] ?? null;
  const raw = top?.suites ?? (lb.data ? DEFAULT_WEIGHTING.suites : null);
  const sum = raw ? Object.values(raw).reduce((a, v) => a + v, 0) : 0;
  const suites = raw && sum > 0 ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, (v * 100) / sum])) : null;
  return { ref: top, suites, mixed: list.length > 1 };
}

const sharesCache = new WeakMap<Weighting, WeightingShares>();
/** Every weight as a percentage of its group (memoized per weighting). */
export function sharesFor(w: Weighting): WeightingShares {
  let s = sharesCache.get(w);
  if (!s) {
    s = sharesOf(w);
    sharesCache.set(w, s);
  }
  return s;
}

/** A weight as people read it: "24%", or "24.6%" when it isn't whole. */
export function fmtWeight(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : fmtNum(v, 1)}%`;
}
