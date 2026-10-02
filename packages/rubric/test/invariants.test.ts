/**
 * Scoring invariants on seeded random answer maps (R3-TEST-11), and a pinned score for every golden file. A change
 * to scoring should be a deliberate, reviewed diff: when one is intended, update the pin with `vitest -u` and read
 * the snapshot diff.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AnswerMap, CriterionAnswer, ScoreCard, SourceClass } from "../src";
import { criteria, getCriterion, lowestOption, scoreProject } from "../src";

/** mulberry32: small, fast, and the same sequence everywhere. */
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

const CLASSES: (SourceClass | null | undefined)[] = [undefined, null, "code_onchain", "independent", "official_docs", "marketing"];
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** A random but valid answer map. `withVerifiability` also draws the source class behind each answer. */
function randomAnswers(r: () => number, withVerifiability: boolean): AnswerMap {
  const out: AnswerMap = {};
  for (const c of criteria) {
    const roll = r();
    const a: CriterionAnswer =
      roll < 0.12
        ? { criterionId: c.id, status: "unknown", optionId: null }
        : roll < 0.16 && c.naAllowed
          ? { criterionId: c.id, status: "not_applicable", optionId: null }
          : roll < 0.19
            ? { criterionId: c.id, status: "not_researched", optionId: null }
            : { criterionId: c.id, status: "answered", optionId: pick(r, c.options).id };
    if (withVerifiability) a.verifiability = pick(r, CLASSES);
    out[c.id] = a;
  }
  return out;
}

const suiteOf = (criterionId: string) => criterionId.split(".")[0]!;
const suiteScore = (s: ScoreCard, suiteId: string) => s.suites.find((x) => x.suiteId === suiteId)!.score;
const points = (criterionId: string, a: CriterionAnswer | undefined) => {
  const c = getCriterion(criterionId);
  return a?.status === "answered" ? (c.options.find((o) => o.id === a.optionId)?.points ?? 0) : lowestOption(c).points;
};
const EPS = 1e-9;
const SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i);

describe("scoring invariants", () => {
  it("keeps overall, suite and benchmark scores within [0, 100]", () => {
    for (const seed of SEEDS) {
      const s = scoreProject(randomAnswers(rng(seed), true));
      const all = [s.overall, ...s.suites.map((x) => x.score), ...s.suites.flatMap((x) => x.benchmarks.map((b) => b.score))];
      for (const v of all) if (v !== null) expect(v >= -EPS && v <= 100 + EPS, `seed ${seed}: ${v}`).toBe(true);
    }
  });

  it("never lowers the suite or the overall when one answer is raised to a better option", () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const r = rng(seed);
      const base = randomAnswers(r, false);
      const before = scoreProject(base);
      for (let k = 0; k < 15; k++) {
        const c = pick(r, criteria);
        const cur = base[c.id];
        if (cur?.status !== "answered" && cur?.status !== "unknown") continue;
        const better = c.options.filter((o) => o.points > points(c.id, cur));
        if (!better.length) continue;
        const raised = { ...base, [c.id]: { criterionId: c.id, status: "answered" as const, optionId: pick(r, better).id } };
        const after = scoreProject(raised);
        const where = `seed ${seed}, ${c.id}: ${cur.optionId ?? cur.status} -> ${raised[c.id]!.optionId}`;
        expect((suiteScore(after, suiteOf(c.id)) ?? 0) + EPS, where).toBeGreaterThanOrEqual(suiteScore(before, suiteOf(c.id)) ?? 0);
        expect((after.overall ?? 0) + EPS, where).toBeGreaterThanOrEqual(before.overall ?? 0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  /**
   * Unknown scores as the riskiest option on its own criterion. Caps and gates (no private logic, L0, operator
   * visibility, open critical bug, instant upgrades) fire only on established answers, by design (scoring.ts), so an
   * established worst answer that trips one scores below unknown at the suite level. Outside those, unknown is never
   * above the lowest option anywhere.
   */
  it("never scores an unknown answer above the lowest option, except where the established answer trips a gate", () => {
    const criterionOf = (s: ScoreCard, id: string) => s.suites.flatMap((x) => x.benchmarks.flatMap((b) => b.criteria)).find((x) => x.criterionId === id)!;
    const benchmarkOf = (s: ScoreCard, id: string) => s.suites.flatMap((x) => x.benchmarks).find((b) => b.criteria.some((x) => x.criterionId === id))!;
    const SCORING_ONLY = new Set(["unknown_lowest", "verifiability_multiplier", "unsupported_favorable"]);
    const gates = (s: ScoreCard) =>
      new Set(
        s.suites
          .flatMap((x) => x.benchmarks)
          .flatMap((b) => [...b.rules.map((g) => `${b.benchmarkId}:${g}`), ...b.criteria.flatMap((x) => x.rules.map((g) => `${x.criterionId}:${g}`))])
          .filter((g) => !SCORING_ONLY.has(g.slice(g.lastIndexOf(":") + 1))),
      );
    let strict = 0;
    let gated = 0;
    for (const seed of SEEDS) {
      const r = rng(seed);
      const base = randomAnswers(r, false);
      for (let k = 0; k < 10; k++) {
        const c = pick(r, criteria);
        const unknown = scoreProject({ ...base, [c.id]: { criterionId: c.id, status: "unknown", optionId: null } });
        const lowest = scoreProject({ ...base, [c.id]: { criterionId: c.id, status: "answered", optionId: lowestOption(c).id } });
        const where = `seed ${seed}, ${c.id}`;
        expect(criterionOf(unknown, c.id).points, where).toBeLessThanOrEqual(criterionOf(lowest, c.id).points + EPS);
        expect(benchmarkOf(unknown, c.id).uncapped ?? 0, where).toBeLessThanOrEqual((benchmarkOf(lowest, c.id).uncapped ?? 0) + EPS);
        const tripped = [...gates(lowest)].some((g) => !gates(unknown).has(g)) || lowest.level !== unknown.level;
        if (tripped) {
          gated++;
          continue;
        }
        expect(suiteScore(unknown, suiteOf(c.id)) ?? 0, where).toBeLessThanOrEqual((suiteScore(lowest, suiteOf(c.id)) ?? 0) + EPS);
        expect(unknown.overall ?? 0, where).toBeLessThanOrEqual((lowest.overall ?? 0) + EPS);
        strict++;
      }
    }
    expect(strict).toBeGreaterThan(300);
    expect(gated).toBeGreaterThan(0);
  });

  it("gates only on established answers: an unknown private-logic answer doesn't zero call-stack hiding", () => {
    const base = randomAnswers(rng(7), false);
    const callstack = (s: ScoreCard) => s.suites.flatMap((x) => x.benchmarks).find((b) => b.benchmarkId === "coverage.callstack")!;
    const none = scoreProject({
      ...base,
      "coverage.execution.private-logic": { criterionId: "coverage.execution.private-logic", status: "answered", optionId: "none" },
    });
    const unknown = scoreProject({
      ...base,
      "coverage.execution.private-logic": { criterionId: "coverage.execution.private-logic", status: "unknown", optionId: null },
    });
    expect(callstack(none).rules).toContain("no_private_logic_gate");
    expect(callstack(none).score).toBe(0);
    expect(callstack(unknown).rules).not.toContain("no_private_logic_gate");
  });

  it("is deterministic, whatever order the answers arrive in", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const answers = randomAnswers(rng(seed), true);
      const once = scoreProject(answers);
      expect(scoreProject(answers)).toEqual(once);
      const reversed = Object.fromEntries(Object.entries(answers).reverse());
      expect(scoreProject(reversed)).toEqual(once);
    }
  });
});

// ---------- sample dataset ----------

interface GoldenFile {
  project: { slug: string };
  answers: { criterionId: string; status: CriterionAnswer["status"]; optionId: string | null }[];
}

/** The fictional sample projects (evals/sample): pinning their scores catches unintended changes to scoring. */
const SAMPLE_DIR = resolve(import.meta.dirname, "../../../evals/sample");
const r6 = (v: number | null) => (v === null ? null : Math.round(v * 1e6) / 1e6);

/** Every aggregate the public site shows, rounded to absorb float noise; criterion detail shows through benchmarks. */
function pinned(s: ScoreCard) {
  return {
    rubricVersion: s.rubricVersion,
    overall: r6(s.overall),
    complete: s.complete,
    level: s.level,
    trustTier: s.trustTier,
    walkaway: s.walkaway,
    suites: Object.fromEntries(
      s.suites.map((x) => [
        x.suiteId,
        {
          score: r6(x.score),
          rules: x.rules,
          benchmarks: Object.fromEntries(x.benchmarks.map((b) => [b.benchmarkId, { score: r6(b.score), unknown: b.unknownCount, rules: b.rules }])),
        },
      ]),
    ),
  };
}

describe("sample dataset (pinned scores)", () => {
  const files = readdirSync(SAMPLE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  it("finds the sample files", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  // As published from the demo data: the file's answers, every other criterion unknown, verifiability not assessed.
  for (const f of files) {
    it(`scores ${f} as pinned`, () => {
      const g = JSON.parse(readFileSync(resolve(SAMPLE_DIR, f), "utf8")) as GoldenFile;
      const answers: AnswerMap = Object.fromEntries(criteria.map((c) => [c.id, { criterionId: c.id, status: "unknown" as const, optionId: null }]));
      for (const a of g.answers)
        answers[a.criterionId] = { criterionId: a.criterionId, status: a.status, optionId: a.status === "answered" ? a.optionId : null };
      expect(pinned(scoreProject(answers))).toMatchSnapshot(g.project.slug);
    });
  }
});
