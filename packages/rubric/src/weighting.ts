import { benchmarks, criteria, findCriterion, getBenchmark, lowestOption, maxPoints, suites } from "./rubric.ts";
import type { CriterionDef, OptionDef, SuiteId } from "./types.ts";

/**
 * A weighting: how much each part of the rubric counts and how much each answer earns. These are the numbers the
 * rubric itself carries (suite weights, benchmark weights, option points), kept apart so they can be versioned and
 * voted on. Answers, badges, caps, gates and what counts as a favorable answer stay the rubric's: a weighting
 * changes how answers are scored, never what they are.
 */
export interface Weighting {
  /** Suite → its weight in the overall score. Weights in a group are shares: scoring divides by their sum. */
  suites: Record<SuiteId, number>;
  /** Benchmark → its weight within its suite. */
  benchmarks: Record<string, number>;
  /**
   * Criterion → option → points. A criterion's best option earns its weight within the benchmark (a benchmark's add
   * up to 100); its riskiest option always earns 0.
   */
  points: Record<string, Record<string, number>>;
}

/** The rubric's own weighting: scoring with it gives exactly the rubric's scores. */
export const DEFAULT_WEIGHTING: Weighting = {
  suites: Object.fromEntries(suites.map((s) => [s.id, s.weight])) as Record<SuiteId, number>,
  benchmarks: Object.fromEntries(benchmarks.map((b) => [b.id, b.weight])),
  points: Object.fromEntries(criteria.map((c) => [c.id, Object.fromEntries(c.options.map((o) => [o.id, o.points]))])),
};

/** The option that earns a criterion's full weight in the rubric (its first, if several tie). */
export function bestOption(c: CriterionDef): OptionDef {
  return c.options.reduce((hi, o) => (o.points > hi.points ? o : hi));
}

/**
 * The best answer always earns full credit and the riskiest none, in every weighting: unknowns keep scoring as the
 * riskiest answer, and a criterion's weight stays what its best answer earns. Only the answers in between take
 * voted credit.
 */
export function isLockedOption(c: CriterionDef, optionId: string): boolean {
  return optionId === bestOption(c).id || optionId === lowestOption(c).id;
}

export function adjustableOptions(c: CriterionDef): OptionDef[] {
  return c.options.filter((o) => !isLockedOption(c, o.id));
}

const finiteNonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/**
 * A weighting as stored (possibly for an older rubric) made complete for this rubric: missing suites, benchmarks,
 * criteria and options take the rubric's values, unknown ones are dropped, the riskiest option is 0 and no option
 * earns more than the best one.
 */
export function resolveWeighting(raw: unknown): Weighting {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Weighting, Record<string, unknown>>>;
  const group = <K extends string>(ids: K[], given: Record<string, unknown> | undefined, fallback: Record<string, number>) => {
    const vals = ids.map((id) => (finiteNonNegative(given?.[id]) ? (given![id] as number) : fallback[id]!));
    // A group that would weigh nothing can't be normalized: it keeps the rubric's weights.
    return Object.fromEntries(ids.map((id, i) => [id, vals.some((v) => v > 0) ? vals[i]! : fallback[id]!])) as Record<K, number>;
  };
  const suiteWeights = group(
    suites.map((s) => s.id),
    r.suites,
    DEFAULT_WEIGHTING.suites,
  );
  const benchmarkWeights: Record<string, number> = {};
  for (const s of suites)
    Object.assign(
      benchmarkWeights,
      group(
        s.benchmarks.map((b) => b.id),
        r.benchmarks,
        DEFAULT_WEIGHTING.benchmarks,
      ),
    );
  const points: Record<string, Record<string, number>> = {};
  for (const b of benchmarks) {
    const given = (id: string) => (r.points?.[id] && typeof r.points[id] === "object" ? (r.points[id] as Record<string, unknown>) : undefined);
    const bestOf = (c: CriterionDef) => {
      const v = given(c.id)?.[bestOption(c).id];
      return finiteNonNegative(v) ? v : maxPoints(c);
    };
    // A benchmark whose criteria would all weigh nothing keeps the rubric's points.
    const usable = b.criteria.some((c) => bestOf(c) > 0);
    for (const c of b.criteria) {
      const best = usable ? bestOf(c) : maxPoints(c);
      const g = usable ? given(c.id) : undefined;
      points[c.id] = Object.fromEntries(
        c.options.map((o) => {
          if (o.id === lowestOption(c).id) return [o.id, 0];
          if (o.id === bestOption(c).id) return [o.id, best];
          const v = g?.[o.id];
          if (finiteNonNegative(v)) return [o.id, Math.min(v, best)];
          // No usable value: the rubric's credit for this answer, at this weighting's scale.
          return [o.id, best === maxPoints(c) ? o.points : round4((best * o.points) / maxPoints(c))];
        }),
      );
    }
  }
  return { suites: suiteWeights, benchmarks: benchmarkWeights, points };
}

// ---------- the voter's view: shares and credits ----------

/** A weighting as voters see it: every weight as a percentage of its group, every answer's credit as a % of the best. */
export interface WeightingShares {
  /** Suite → % of the overall score. */
  suites: Record<string, number>;
  /** Benchmark → % of its suite. */
  benchmarks: Record<string, number>;
  /** Criterion → % of its benchmark. */
  criteria: Record<string, number>;
  /** Criterion → option → % of the best answer's points (the best is 100, the riskiest 0). */
  credits: Record<string, Record<string, number>>;
}

/** Each value as a percentage of the group's sum (an all-zero group stays zero). */
function asShares(ids: string[], value: (id: string) => number): Record<string, number> {
  const sum = ids.reduce((s, id) => s + value(id), 0);
  return Object.fromEntries(ids.map((id) => [id, sum > 0 ? (value(id) * 100) / sum : 0]));
}

const criterionWeight = (w: Weighting, c: CriterionDef) => w.points[c.id]?.[bestOption(c).id] ?? maxPoints(c);

export function sharesOf(w: Weighting): WeightingShares {
  const out: WeightingShares = { suites: {}, benchmarks: {}, criteria: {}, credits: {} };
  out.suites = asShares(
    suites.map((s) => s.id),
    (id) => w.suites[id as SuiteId] ?? 0,
  );
  for (const s of suites)
    Object.assign(
      out.benchmarks,
      asShares(
        s.benchmarks.map((b) => b.id),
        (id) => w.benchmarks[id] ?? 0,
      ),
    );
  for (const b of benchmarks) {
    Object.assign(
      out.criteria,
      asShares(
        b.criteria.map((c) => c.id),
        (id) => criterionWeight(w, findCriterion(id)!),
      ),
    );
    for (const c of b.criteria) {
      const best = criterionWeight(w, c);
      out.credits[c.id] = Object.fromEntries(c.options.map((o) => [o.id, best > 0 ? ((w.points[c.id]?.[o.id] ?? 0) * 100) / best : 0]));
    }
  }
  return out;
}

/**
 * Builds a weighting from shares and credits. Where a share or credit is the base's, the base's own number is kept
 * exactly, so an unchanged weighting scores exactly like its base.
 */
function fromShares(shares: WeightingShares, base: Weighting, baseShares: WeightingShares): Weighting {
  const keep = (ids: string[], given: Record<string, number>, baseGiven: Record<string, number>, raw: Record<string, number>) =>
    Object.fromEntries(ids.map((id) => [id, given[id] === baseGiven[id] ? raw[id]! : given[id]!]));
  const suiteWeights = keep(
    suites.map((s) => s.id),
    shares.suites,
    baseShares.suites,
    base.suites,
  ) as Record<SuiteId, number>;
  const benchmarkWeights = keep(
    benchmarks.map((b) => b.id),
    shares.benchmarks,
    baseShares.benchmarks,
    base.benchmarks,
  );
  const points: Record<string, Record<string, number>> = {};
  for (const c of criteria) {
    const share = shares.criteria[c.id]!;
    const sameShare = share === baseShares.criteria[c.id];
    const best = sameShare ? base.points[c.id]![bestOption(c).id]! : round4(share);
    points[c.id] = Object.fromEntries(
      c.options.map((o) => {
        if (o.id === lowestOption(c).id) return [o.id, 0];
        if (o.id === bestOption(c).id) return [o.id, best];
        const credit = shares.credits[c.id]![o.id]!;
        if (sameShare && credit === baseShares.credits[c.id]![o.id]) return [o.id, base.points[c.id]![o.id]!];
        // A share of what the best answer earns here (raw points when the share didn't change).
        return [o.id, round4((best * credit) / 100)];
      }),
    );
  }
  return { suites: suiteWeights, benchmarks: benchmarkWeights, points };
}

// ---------- ballots ----------

/**
 * One voter's changes. A group (the suites, one suite's benchmarks, one benchmark's criteria) is either left out,
 * meaning "keep the current weights", or given whole: relative importances, 0 to 100, normalized to the group.
 * Credits are per answer, for answers between the best and the riskiest only (0 to 100, % of the best).
 */
export interface Ballot {
  suites?: Record<string, number>;
  benchmarks?: Record<string, number>;
  criteria?: Record<string, number>;
  credits?: Record<string, Record<string, number>>;
}

const inRange = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

/**
 * A criterion always keeps some weight: at zero its answers' points would all be zero, losing their credit for every
 * later weighting built on this one. Dropping a criterion is a rubric change, not a weighting.
 */
export const MIN_CRITERION_WEIGHT = 1;

/** Checks a group: every member of each touched group given, nothing else, in range, not all zero. */
function checkGroups(
  values: Record<string, number> | undefined,
  groups: { id: string; name: string; members: string[] }[],
  kind: string,
  errors: string[],
  min = 0,
) {
  if (!values) return;
  const known = new Set(groups.flatMap((g) => g.members));
  for (const k of Object.keys(values)) if (!known.has(k)) errors.push(`Unknown ${kind} "${k}"`);
  for (const g of groups) {
    const given = g.members.filter((m) => m in values);
    if (!given.length) continue;
    if (given.length !== g.members.length) {
      errors.push(`${g.name}: give every ${kind} in the group, or none`);
      continue;
    }
    if (g.members.some((m) => !inRange(values[m]) || values[m]! < min)) errors.push(`${g.name}: ${kind} weights must be between ${min} and 100`);
    else if (g.members.every((m) => values[m] === 0)) errors.push(`${g.name}: at least one ${kind} must count`);
  }
}

/** Problems with a ballot, in words a voter can act on; empty when it's valid. */
export function validateBallot(b: Ballot): string[] {
  const errors: string[] = [];
  checkGroups(b.suites, [{ id: "overall", name: "Suites", members: suites.map((s) => s.id) }], "suite", errors);
  checkGroups(
    b.benchmarks,
    suites.map((s) => ({ id: s.id, name: s.name, members: s.benchmarks.map((x) => x.id) })),
    "benchmark",
    errors,
  );
  checkGroups(
    b.criteria,
    benchmarks.map((x) => ({ id: x.id, name: x.name, members: x.criteria.map((c) => c.id) })),
    "criterion",
    errors,
    MIN_CRITERION_WEIGHT,
  );
  for (const [cid, opts] of Object.entries(b.credits ?? {})) {
    const c = findCriterion(cid);
    if (!c) {
      errors.push(`Unknown criterion "${cid}"`);
      continue;
    }
    for (const [oid, v] of Object.entries(opts ?? {})) {
      if (!c.options.some((o) => o.id === oid)) errors.push(`${c.label}: unknown answer "${oid}"`);
      else if (isLockedOption(c, oid)) errors.push(`${c.label}: the best and riskiest answers' credit is fixed`);
      else if (!inRange(v)) errors.push(`${c.label}: credit must be between 0 and 100`);
    }
  }
  return errors;
}

/** The ballot's groups and credits laid over the base's shares (groups normalized to 100). */
function ballotShares(baseShares: WeightingShares, b: Ballot): WeightingShares {
  const out: WeightingShares = {
    suites: { ...baseShares.suites },
    benchmarks: { ...baseShares.benchmarks },
    criteria: { ...baseShares.criteria },
    credits: Object.fromEntries(Object.entries(baseShares.credits).map(([k, v]) => [k, { ...v }])),
  };
  const lay = (target: Record<string, number>, values: Record<string, number> | undefined, groups: string[][]) => {
    if (!values) return;
    for (const members of groups) {
      if (!members.every((m) => m in values)) continue;
      Object.assign(
        target,
        asShares(members, (id) => values[id]!),
      );
    }
  };
  lay(out.suites, b.suites, [suites.map((s) => s.id)]);
  lay(
    out.benchmarks,
    b.benchmarks,
    suites.map((s) => s.benchmarks.map((x) => x.id)),
  );
  lay(
    out.criteria,
    b.criteria,
    benchmarks.map((x) => x.criteria.map((c) => c.id)),
  );
  for (const [cid, opts] of Object.entries(b.credits ?? {})) {
    const c = findCriterion(cid);
    if (!c) continue;
    for (const [oid, v] of Object.entries(opts ?? {})) if (out.credits[cid] && !isLockedOption(c, oid) && oid in out.credits[cid]) out.credits[cid][oid] = v;
  }
  return out;
}

/** The weighting a single ballot asks for (what the vote page previews). */
export function applyBallot(base: Weighting, b: Ballot): Weighting {
  const baseShares = sharesOf(base);
  return fromShares(ballotShares(baseShares, b), base, baseShares);
}

// ---------- parameters and differences ----------

export type ParameterKind = "suite" | "benchmark" | "criterion" | "credit";

/** One weight or credit: its key ("credit:<criterion>:<option>"), what it is, and its value as voters see it (%). */
export interface ParameterChange {
  key: string;
  kind: ParameterKind;
  id: string;
  optionId?: string;
  label: string;
  /** Where it sits: the suite of a benchmark, the benchmark of a criterion, the criterion of a credit. */
  context: string;
  from: number;
  to: number;
}

/** Changes smaller than this (percentage points) are rounding, not changes. */
export const CHANGE_EPSILON = 0.005;

interface Parameter {
  key: string;
  kind: ParameterKind;
  id: string;
  optionId?: string;
  label: string;
  context: string;
  get: (s: WeightingShares) => number;
}

/** Every parameter a voter can set, in rubric order. */
export const PARAMETERS: Parameter[] = [
  ...suites.map((s): Parameter => ({ key: `suite:${s.id}`, kind: "suite", id: s.id, label: s.name, context: "Overall", get: (x) => x.suites[s.id]! })),
  ...benchmarks.map(
    (b): Parameter => ({
      key: `benchmark:${b.id}`,
      kind: "benchmark",
      id: b.id,
      label: b.name,
      context: suites.find((s) => s.id === b.suite)!.name,
      get: (x) => x.benchmarks[b.id]!,
    }),
  ),
  ...criteria.map(
    (c): Parameter => ({
      key: `criterion:${c.id}`,
      kind: "criterion",
      id: c.id,
      label: c.label,
      context: getBenchmark(c.benchmarkId).name,
      get: (x) => x.criteria[c.id]!,
    }),
  ),
  ...criteria.flatMap((c) =>
    adjustableOptions(c).map(
      (o): Parameter => ({
        key: `credit:${c.id}:${o.id}`,
        kind: "credit",
        id: c.id,
        optionId: o.id,
        label: o.label,
        context: c.label,
        get: (x) => x.credits[c.id]![o.id]!,
      }),
    ),
  ),
];

function changesBetween(a: WeightingShares, b: WeightingShares): ParameterChange[] {
  const out: ParameterChange[] = [];
  for (const p of PARAMETERS) {
    const from = p.get(a);
    const to = p.get(b);
    if (Math.abs(from - to) > CHANGE_EPSILON)
      out.push({ key: p.key, kind: p.kind, id: p.id, optionId: p.optionId, label: p.label, context: p.context, from, to });
  }
  return out;
}

/** What differs between two weightings, as voters see it (% of group, % credit). */
export function diffWeightings(from: Weighting, to: Weighting): ParameterChange[] {
  return changesBetween(sharesOf(from), sharesOf(to));
}

/**
 * The weights and credits a ballot actually moved (its own values against the base's): what a voter changed, before
 * a group's renormalization shifts the rest of it.
 */
export function movedParameters(base: Weighting, b: Ballot): string[] {
  const s = sharesOf(base);
  const out: string[] = [];
  const moved = (kind: ParameterKind, given: Record<string, number> | undefined, baseVals: Record<string, number>) => {
    for (const [id, v] of Object.entries(given ?? {})) if (id in baseVals && Math.abs(v - baseVals[id]!) > CHANGE_EPSILON) out.push(`${kind}:${id}`);
  };
  moved("suite", b.suites, s.suites);
  moved("benchmark", b.benchmarks, s.benchmarks);
  moved("criterion", b.criteria, s.criteria);
  for (const [cid, opts] of Object.entries(b.credits ?? {}))
    for (const [oid, v] of Object.entries(opts ?? {}))
      if (s.credits[cid] && oid in s.credits[cid] && Math.abs(v - s.credits[cid][oid]!) > CHANGE_EPSILON) out.push(`credit:${cid}:${oid}`);
  return out;
}

/** What a ballot changes against the base. */
export function ballotChanges(base: Weighting, b: Ballot): ParameterChange[] {
  const baseShares = sharesOf(base);
  return changesBetween(baseShares, ballotShares(baseShares, b));
}

// ---------- aggregation ----------

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface AggregateResult {
  weighting: Weighting;
  ballots: number;
  /** Ballots that changed nothing: votes for the base as it is. */
  unchanged: number;
  /** Parameters whose result differs from the base. */
  changes: ParameterChange[];
  /** Parameter key → how many ballots moved it themselves (not through a group's renormalization). */
  changedBy: Record<string, number>;
}

/**
 * The poll's result. For every weight, the median across ballots, where a ballot that left the weight's group
 * alone counts as a vote for the base; each group is then renormalized to 100. For every in-between answer, the
 * median credit, untouched ballots counting the base. A minority can't move a weight; a majority moves it only as
 * far as its middle voter. A group whose medians all equal the base stays exactly the base.
 */
export function aggregateBallots(base: Weighting, ballots: Ballot[]): AggregateResult {
  const baseShares = sharesOf(base);
  if (!ballots.length) return { weighting: base, ballots: 0, unchanged: 0, changes: [], changedBy: {} };
  const each = ballots.map((b) => ballotShares(baseShares, b));
  const changedBy: Record<string, number> = {};
  let unchanged = 0;
  each.forEach((s, i) => {
    if (!changesBetween(baseShares, s).length) unchanged++;
    for (const key of movedParameters(base, ballots[i]!)) changedBy[key] = (changedBy[key] ?? 0) + 1;
  });
  const result: WeightingShares = { suites: {}, benchmarks: {}, criteria: {}, credits: {} };
  const settle = (target: Record<string, number>, pick: (s: WeightingShares) => Record<string, number>, members: string[]) => {
    const medians = members.map((m) => median(each.map((s) => pick(s)[m]!)));
    const baseVals = members.map((m) => pick(baseShares)[m]!);
    const same = medians.every((v, i) => v === baseVals[i]);
    const sum = medians.reduce((a, v) => a + v, 0);
    members.forEach((m, i) => {
      target[m] = same || sum <= 0 ? baseVals[i]! : round4((medians[i]! * 100) / sum);
    });
  };
  settle(
    result.suites,
    (s) => s.suites,
    suites.map((s) => s.id),
  );
  for (const s of suites)
    settle(
      result.benchmarks,
      (x) => x.benchmarks,
      s.benchmarks.map((b) => b.id),
    );
  for (const b of benchmarks)
    settle(
      result.criteria,
      (x) => x.criteria,
      b.criteria.map((c) => c.id),
    );
  for (const c of criteria) {
    result.credits[c.id] = { ...baseShares.credits[c.id]! };
    for (const o of adjustableOptions(c)) {
      const m = median(each.map((s) => s.credits[c.id]![o.id]!));
      result.credits[c.id]![o.id] = m === baseShares.credits[c.id]![o.id] ? m : round4(Math.min(100, Math.max(0, m)));
    }
  }
  const weighting = fromShares(result, base, baseShares);
  return { weighting, ballots: ballots.length, unchanged, changes: changesBetween(baseShares, sharesOf(weighting)), changedBy };
}
