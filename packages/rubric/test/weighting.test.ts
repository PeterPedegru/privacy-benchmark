/**
 * Weightings: the rubric's own scores exactly, ballots, the poll's median aggregation, and re-scoring a published
 * score card under another weighting.
 */
import { describe, expect, it } from "vitest";
import type { AnswerMap, Ballot, CriterionAnswer, SourceClass, Weighting } from "../src";
import {
  adjustableOptions,
  aggregateBallots,
  answersFromCard,
  applyBallot,
  ballotChanges,
  benchmarks,
  bestOption,
  criteria,
  DEFAULT_WEIGHTING,
  diffWeightings,
  getCriterion,
  isLockedOption,
  lowestOption,
  PARAMETERS,
  RULE_CRITERIA,
  rescoreCard,
  resolveWeighting,
  scoreProject,
  sharesOf,
  suites,
  validateBallot,
} from "../src";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const CLASSES: (SourceClass | null | undefined)[] = [undefined, null, "code_onchain", "independent", "official_docs", "third_party", "marketing"];

function randomAnswers(r: () => number, opts: { noInstantUpgrade?: boolean } = {}): AnswerMap {
  const out: AnswerMap = {};
  for (const c of criteria) {
    const roll = r();
    let a: CriterionAnswer =
      roll < 0.12
        ? { criterionId: c.id, status: "unknown", optionId: null }
        : roll < 0.16 && c.naAllowed
          ? { criterionId: c.id, status: "not_applicable", optionId: null }
          : roll < 0.19
            ? { criterionId: c.id, status: "not_researched", optionId: null }
            : { criterionId: c.id, status: "answered", optionId: pick(r, c.options).id };
    if (opts.noInstantUpgrade && c.id === RULE_CRITERIA.upgradeability && a.optionId === "instant")
      a = { criterionId: c.id, status: "answered", optionId: lowestOption(c).id };
    a.verifiability = pick(r, CLASSES);
    out[c.id] = a;
  }
  return out;
}

/** A random full ballot: every group touched, every in-between credit set. */
function randomBallot(r: () => number): Ballot {
  const b: Ballot = { suites: {}, benchmarks: {}, criteria: {}, credits: {} };
  for (const s of suites) b.suites![s.id] = Math.round(r() * 100);
  b.suites!.coverage = 50;
  for (const x of benchmarks) b.benchmarks![x.id] = 1 + Math.round(r() * 99);
  for (const c of criteria) b.criteria![c.id] = 1 + Math.round(r() * 99);
  for (const c of criteria) {
    const mids = adjustableOptions(c);
    if (mids.length) b.credits![c.id] = Object.fromEntries(mids.map((o) => [o.id, Math.round(r() * 100)]));
  }
  return b;
}

const SEEDS = Array.from({ length: 25 }, (_, i) => 7000 + i);

describe("the default weighting", () => {
  it("is the rubric's own numbers", () => {
    for (const s of suites) expect(DEFAULT_WEIGHTING.suites[s.id]).toBe(s.weight);
    for (const b of benchmarks) expect(DEFAULT_WEIGHTING.benchmarks[b.id]).toBe(b.weight);
    for (const c of criteria) for (const o of c.options) expect(DEFAULT_WEIGHTING.points[c.id]![o.id]).toBe(o.points);
  });

  it("scores exactly like the rubric, on random answers", () => {
    for (const seed of SEEDS) {
      const a = randomAnswers(rng(seed));
      expect(scoreProject(a, DEFAULT_WEIGHTING)).toEqual(scoreProject(a));
    }
  });

  it("resolves a stored weighting back to itself, and fills in what an older one lacks", () => {
    expect(resolveWeighting(DEFAULT_WEIGHTING)).toEqual(DEFAULT_WEIGHTING);
    expect(resolveWeighting(JSON.parse(JSON.stringify(DEFAULT_WEIGHTING)))).toEqual(DEFAULT_WEIGHTING);
    expect(resolveWeighting({})).toEqual(DEFAULT_WEIGHTING);
    expect(resolveWeighting(null)).toEqual(DEFAULT_WEIGHTING);
    const partial = { suites: { coverage: 50 }, points: { "custody.pause.pause-fn": { nope: 5 } }, extra: 1 };
    const r = resolveWeighting(partial);
    expect(r.suites.coverage).toBe(50);
    expect(r.suites.trust).toBe(DEFAULT_WEIGHTING.suites.trust);
    expect(r.points["custody.pause.pause-fn"]).toEqual(DEFAULT_WEIGHTING.points["custody.pause.pause-fn"]);
  });

  it("keeps the riskiest answer at 0 and no answer above the best", () => {
    const c = criteria.find((x) => adjustableOptions(x).length)!;
    const mid = adjustableOptions(c)[0]!;
    const r = resolveWeighting({ points: { [c.id]: { [lowestOption(c).id]: 9, [mid.id]: 999 } } });
    expect(r.points[c.id]![lowestOption(c).id]).toBe(0);
    expect(r.points[c.id]![mid.id]).toBe(r.points[c.id]![bestOption(c).id]);
  });

  it("keeps a group that would weigh nothing at the rubric's weights", () => {
    const zero = Object.fromEntries(suites.map((s) => [s.id, 0]));
    expect(resolveWeighting({ suites: zero }).suites).toEqual(DEFAULT_WEIGHTING.suites);
  });
});

describe("shares and credits", () => {
  it("express every group as % of itself and every answer as % of the best", () => {
    const s = sharesOf(DEFAULT_WEIGHTING);
    expect(Object.values(s.suites).reduce((a, v) => a + v, 0)).toBeCloseTo(100, 9);
    for (const b of benchmarks) expect(b.criteria.reduce((a, c) => a + s.criteria[c.id]!, 0)).toBeCloseTo(100, 9);
    for (const c of criteria) {
      expect(s.credits[c.id]![bestOption(c).id]).toBe(100);
      expect(s.credits[c.id]![lowestOption(c).id]).toBe(0);
    }
  });

  it("only in-between answers are adjustable", () => {
    for (const c of criteria) {
      expect(isLockedOption(c, bestOption(c).id)).toBe(true);
      expect(isLockedOption(c, lowestOption(c).id)).toBe(true);
      expect(adjustableOptions(c)).toHaveLength(c.options.length - 2);
    }
    // 343 answers, 131 in between (8 criteria are yes/no).
    expect(criteria.reduce((n, c) => n + adjustableOptions(c).length, 0)).toBe(131);
    expect(PARAMETERS).toHaveLength(suites.length + benchmarks.length + criteria.length + 131);
  });
});

describe("ballots", () => {
  it("an empty ballot is a valid vote for the current weights", () => {
    expect(validateBallot({})).toEqual([]);
    expect(ballotChanges(DEFAULT_WEIGHTING, {})).toEqual([]);
    expect(applyBallot(DEFAULT_WEIGHTING, {})).toEqual(DEFAULT_WEIGHTING);
  });

  it("rejects partial groups, unknown ids, locked answers and values out of range", () => {
    expect(validateBallot({ suites: { coverage: 40 } }).join()).toMatch(/every suite/);
    expect(validateBallot({ suites: { ...DEFAULT_WEIGHTING.suites, bogus: 1 } }).join()).toMatch(/Unknown suite/);
    expect(validateBallot({ suites: Object.fromEntries(suites.map((s) => [s.id, 0])) }).join()).toMatch(/at least one/);
    expect(validateBallot({ suites: { ...DEFAULT_WEIGHTING.suites, coverage: 101 } }).join()).toMatch(/between 0 and 100/);
    const pause = getCriterion("custody.pause.pause-fn");
    expect(validateBallot({ credits: { [pause.id]: { [bestOption(pause).id]: 50 } } }).join()).toMatch(/fixed/);
    expect(validateBallot({ credits: { "no.such.criterion": { x: 1 } } }).join()).toMatch(/Unknown criterion/);
    const custody = suites.find((s) => s.id === "custody")!;
    expect(validateBallot({ benchmarks: { [custody.benchmarks[0]!.id]: 10 } }).join()).toMatch(/every benchmark/);
  });

  it("normalizes a touched group and leaves the rest as they are", () => {
    const vote: Ballot = { suites: { ...DEFAULT_WEIGHTING.suites, coverage: 48 } };
    expect(validateBallot(vote)).toEqual([]);
    const w = applyBallot(DEFAULT_WEIGHTING, vote);
    const s = sharesOf(w);
    expect(s.suites.coverage).toBeCloseTo((48 / 124) * 100, 3);
    expect(Object.values(s.suites).reduce((a, v) => a + v, 0)).toBeCloseTo(100, 3);
    expect(w.benchmarks).toEqual(DEFAULT_WEIGHTING.benchmarks);
    expect(w.points).toEqual(DEFAULT_WEIGHTING.points);
    // Every suite's share moved (the group renormalized), and nothing else.
    expect(
      ballotChanges(DEFAULT_WEIGHTING, vote)
        .map((c) => c.kind)
        .every((k) => k === "suite"),
    ).toBe(true);
  });

  it("keeps every criterion weighing something", () => {
    const b = benchmarks.find((x) => x.criteria.length > 1)!;
    const zero = Object.fromEntries(b.criteria.map((c, i) => [c.id, i === 0 ? 0 : 50]));
    expect(validateBallot({ criteria: zero }).join()).toMatch(/between 1 and 100/);
    expect(validateBallot({ criteria: { ...zero, [b.criteria[0]!.id]: 1 } })).toEqual([]);
  });

  it("a credit changes what that answer earns, at the criterion's weight", () => {
    const c = getCriterion("custody.pause.pause-fn");
    const mid = adjustableOptions(c)[0]!;
    const w = applyBallot(DEFAULT_WEIGHTING, { credits: { [c.id]: { [mid.id]: 10 } } });
    expect(w.points[c.id]![mid.id]).toBeCloseTo((DEFAULT_WEIGHTING.points[c.id]![bestOption(c).id]! * 10) / 100, 6);
    expect(diffWeightings(DEFAULT_WEIGHTING, w)).toEqual([expect.objectContaining({ key: `credit:${c.id}:${mid.id}`, to: 10 })]);
  });
});

describe("aggregation", () => {
  const coverageUp: Ballot = { suites: { ...DEFAULT_WEIGHTING.suites, coverage: 60 } };

  it("with no ballots, or only votes for the current weights, is exactly the base", () => {
    expect(aggregateBallots(DEFAULT_WEIGHTING, []).weighting).toEqual(DEFAULT_WEIGHTING);
    const r = aggregateBallots(DEFAULT_WEIGHTING, [{}, {}, {}]);
    expect(r.weighting).toEqual(DEFAULT_WEIGHTING);
    expect(r.unchanged).toBe(3);
    expect(r.changes).toEqual([]);
  });

  it("a minority can't move a weight", () => {
    const r = aggregateBallots(DEFAULT_WEIGHTING, [coverageUp, {}, {}]);
    expect(r.weighting).toEqual(DEFAULT_WEIGHTING);
    expect(r.changedBy["suite:coverage"]).toBe(1);
  });

  it("a majority moves it to its median voter's value, then the group renormalizes", () => {
    const lower: Ballot = { suites: { ...DEFAULT_WEIGHTING.suites, coverage: 40 } };
    const r = aggregateBallots(DEFAULT_WEIGHTING, [coverageUp, coverageUp, lower, {}, {}]);
    const s = sharesOf(r.weighting);
    // Coverage shares: 60/136, 60/136, 40/116, 24, 24 → median is 40/116 = 34.48%; others keep their median.
    expect(s.suites.coverage).toBeGreaterThan(24);
    expect(Object.values(s.suites).reduce((a, v) => a + v, 0)).toBeCloseTo(100, 2);
    expect(r.weighting.benchmarks).toEqual(DEFAULT_WEIGHTING.benchmarks);
    expect(r.weighting.points).toEqual(DEFAULT_WEIGHTING.points);
    expect(r.changes.some((c) => c.key === "suite:coverage")).toBe(true);
  });

  it("counts the weights a ballot moved, not the ones its group's rescaling shifted", () => {
    const r = aggregateBallots(DEFAULT_WEIGHTING, [coverageUp]);
    expect(r.changedBy).toEqual({ "suite:coverage": 1 });
    // Every suite's share moved in the result, though.
    expect(r.changes.filter((c) => c.kind === "suite").length).toBeGreaterThan(1);
  });

  it("credits take the median, untouched ballots counting the base", () => {
    const c = getCriterion("custody.pause.pause-fn");
    const mid = adjustableOptions(c)[0]!;
    const base = sharesOf(DEFAULT_WEIGHTING).credits[c.id]![mid.id]!;
    const vote = (v: number): Ballot => ({ credits: { [c.id]: { [mid.id]: v } } });
    const r = aggregateBallots(DEFAULT_WEIGHTING, [vote(0), vote(10), vote(20), {}]);
    // 0, 10, 20 and the base: the median is (10 + 20) / 2 when the base is above 20.
    expect(base).toBeGreaterThan(20);
    expect(sharesOf(r.weighting).credits[c.id]![mid.id]).toBeCloseTo(15, 6);
  });

  it("stays a valid weighting whatever the ballots, and scores within [0, 100]", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const r = rng(seed);
      const ballots = Array.from({ length: 7 }, () => (r() < 0.3 ? {} : randomBallot(r)));
      for (const b of ballots) expect(validateBallot(b)).toEqual([]);
      const w = aggregateBallots(DEFAULT_WEIGHTING, ballots).weighting;
      expect(resolveWeighting(w)).toEqual(w);
      const s = sharesOf(w);
      expect(Object.values(s.suites).reduce((a, v) => a + v, 0)).toBeCloseTo(100, 2);
      for (const c of criteria) {
        expect(w.points[c.id]![lowestOption(c).id]).toBe(0);
        for (const o of c.options) expect(w.points[c.id]![o.id]!).toBeLessThanOrEqual(w.points[c.id]![bestOption(c).id]! + 1e-9);
      }
      const card = scoreProject(randomAnswers(r), w);
      for (const v of [card.overall, ...card.suites.map((x) => x.score)]) if (v !== null) expect(v >= -1e-9 && v <= 100 + 1e-9).toBe(true);
    }
  });

  it("never changes badges", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const r = rng(seed);
      const a = randomAnswers(r);
      const w = aggregateBallots(DEFAULT_WEIGHTING, [randomBallot(r), randomBallot(r), randomBallot(r)]).weighting;
      const x = scoreProject(a);
      const y = scoreProject(a, w);
      expect([y.level, y.trustTier, y.walkaway]).toEqual([x.level, x.trustTier, x.walkaway]);
    }
  });

  it("a later poll on a voted weighting keeps it exactly when nobody changes anything", () => {
    const w2 = aggregateBallots(DEFAULT_WEIGHTING, [randomBallot(rng(1)), randomBallot(rng(2)), randomBallot(rng(3))]).weighting;
    expect(aggregateBallots(w2, [{}, {}]).weighting).toEqual(w2);
    expect(applyBallot(w2, {})).toEqual(w2);
  });
});

describe("edge weightings", () => {
  it("a benchmark whose counted criteria carry no weight has no score, rather than zero", () => {
    const perf = benchmarks.find((b) => b.id === "programmability.performance")!;
    const w: Weighting = JSON.parse(JSON.stringify(DEFAULT_WEIGHTING));
    const answers: AnswerMap = {};
    for (const c of criteria) answers[c.id] = { criterionId: c.id, status: "answered", optionId: bestOption(c).id };
    for (const c of perf.criteria) {
      if (c.naAllowed) answers[c.id] = { criterionId: c.id, status: "not_applicable" };
      else for (const o of c.options) w.points[c.id]![o.id] = 0;
    }
    const card = scoreProject(answers, w);
    const score = card.suites.flatMap((s) => s.benchmarks).find((b) => b.benchmarkId === perf.id)!.score;
    expect(score).toBeNull();
    expect(card.suites.find((s) => s.suiteId === "programmability")!.score).toBeCloseTo(100, 6);
  });

  it("credits apply to what the best answer earns, whatever scale a weighting's points are on", () => {
    const c = getCriterion("custody.pause.pause-fn");
    const mid = adjustableOptions(c)[0]!;
    // An older weighting stored this benchmark's points on another scale (best answer 70 here).
    const raw: Weighting = JSON.parse(JSON.stringify(DEFAULT_WEIGHTING));
    const scale = 70 / DEFAULT_WEIGHTING.points[c.id]![bestOption(c).id]!;
    for (const o of c.options) raw.points[c.id]![o.id] = DEFAULT_WEIGHTING.points[c.id]![o.id]! * scale;
    const w = applyBallot(raw, { credits: { [c.id]: { [mid.id]: 50 } } });
    expect(w.points[c.id]![mid.id]! / w.points[c.id]![bestOption(c).id]!).toBeCloseTo(0.5, 6);
  });
});

describe("re-scoring a score card", () => {
  it("gives back the same card under the same weighting", () => {
    for (const seed of SEEDS) {
      const card = scoreProject(randomAnswers(rng(seed)));
      expect(rescoreCard(card, DEFAULT_WEIGHTING)).toEqual(card);
    }
  });

  it("matches scoring the answers under another weighting", () => {
    for (const seed of SEEDS) {
      const r = rng(seed);
      const a = randomAnswers(r, { noInstantUpgrade: true });
      const w: Weighting = applyBallot(DEFAULT_WEIGHTING, randomBallot(r));
      const direct = scoreProject(a, w);
      const again = rescoreCard(scoreProject(a), w);
      expect(again.overall ?? -1).toBeCloseTo(direct.overall ?? -1, 9);
      for (const s of direct.suites) expect(again.suites.find((x) => x.suiteId === s.suiteId)!.score ?? -1).toBeCloseTo(s.score ?? -1, 9);
    }
  });

  it("recovers status, option and the class that discounted an answer", () => {
    const a = randomAnswers(rng(42));
    const back = answersFromCard(scoreProject(a));
    for (const c of criteria) {
      const x = a[c.id]!;
      const y = back[c.id]!;
      // not applicable where the criterion doesn't allow it scores as unknown.
      const status = x.status === "not_applicable" && !c.naAllowed ? "unknown" : x.status;
      expect(y.status, c.id).toBe(status);
    }
  });
});
