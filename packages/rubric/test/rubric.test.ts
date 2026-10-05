import { describe, expect, it } from "vitest";
import type { AnswerMap } from "../src";
import {
  BADGE_DRIVING,
  benchmarks,
  criteria,
  derivePrivacyLevel,
  deriveTrustTier,
  deriveWalkaway,
  diffAnswers,
  findCriterion,
  fromLabel,
  getCriterion,
  hidesLabel,
  isHighScrutiny,
  levelNumber,
  lowestOption,
  matrixConflicts,
  maxPoints,
  normalizeLevel,
  overallFromSuites,
  RULE_CRITERIA,
  rubric,
  scoreProject,
  suites,
} from "../src";

/** Answer every criterion with its best option, then apply overrides. */
function answers(overrides: Record<string, string> = {}, base: "best" | "worst" = "best"): AnswerMap {
  const out: AnswerMap = {};
  for (const c of criteria) {
    const opt = base === "best" ? c.options.reduce((a, b) => (b.points > a.points ? b : a)) : lowestOption(c);
    out[c.id] = { criterionId: c.id, status: "answered", optionId: opt.id };
  }
  for (const [id, optionId] of Object.entries(overrides)) {
    getCriterion(id);
    out[id] = { criterionId: id, status: "answered", optionId };
  }
  return out;
}

describe("rubric integrity", () => {
  it("has 7 suites, 31 benchmarks, 106 criteria", () => {
    expect(suites).toHaveLength(7);
    expect(benchmarks).toHaveLength(31);
    expect(criteria).toHaveLength(106);
  });

  it("suite weights sum to 100 and benchmark weights sum to 100 within each suite", () => {
    expect(suites.reduce((s, x) => s + x.weight, 0)).toBe(100);
    for (const s of suites)
      expect(
        s.benchmarks.reduce((a, b) => a + b.weight, 0),
        s.id,
      ).toBe(100);
  });

  it("every benchmark's criteria max points sum to 100", () => {
    for (const b of benchmarks)
      expect(
        b.criteria.reduce((s, c) => s + maxPoints(c), 0),
        b.id,
      ).toBe(100);
  });

  it("every preset sums to 100 and matches the official suite weights", () => {
    for (const p of rubric.presets)
      expect(
        Object.values(p.weights).reduce((a, b) => a + b, 0),
        p.id,
      ).toBe(100);
    const official = rubric.presets.find((p) => p.official)!;
    for (const s of suites) expect(official.weights[s.id]).toBe(s.weight);
  });

  it("ids are unique and options are well-formed", () => {
    const ids = criteria.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of criteria) {
      const optIds = c.options.map((o) => o.id);
      expect(new Set(optIds).size, c.id).toBe(optIds.length);
      expect(c.options.length, c.id).toBeGreaterThanOrEqual(2);
      expect(lowestOption(c).points, c.id).toBe(0);
      for (const o of c.options) expect(o.label.length, `${c.id}.${o.id}`).toBeGreaterThan(0);
    }
  });

  it("every criterion referenced by a rule exists", () => {
    for (const id of Object.values(RULE_CRITERIA)) expect(findCriterion(id), id).toBeDefined();
  });

  it("stays project-neutral: no evaluated project is named in rubric text", () => {
    // Ethereum is excluded on purpose: it's named as a settlement layer, not as a competitor.
    const names = ["aztec", "zama", "railgun", "starknet", "strk20", "miden", "tempo", "tornado", "privacy pools", "0xbow", "zcash", "monero", "noir", "cairo"];
    const text = JSON.stringify(rubric).toLowerCase();
    for (const n of names) expect(text.includes(n), n).toBe(false);
  });
});

describe("scoring", () => {
  it("best answers score 100 everywhere with level Z5, tier A, walkaway pass", () => {
    const card = scoreProject(answers());
    expect(card.overall).toBeCloseTo(100, 6);
    expect(card.level).toBe("Z5");
    expect(card.trustTier).toBe("A");
    expect(card.walkaway.passed).toBe(true);
  });

  it("worst answers score 0 with level Z0 and no trust tier", () => {
    const card = scoreProject(answers({}, "worst"));
    expect(card.overall).toBe(0);
    expect(card.level).toBe("Z0");
    expect(card.trustTier).toBeNull();
    expect(card.walkaway.passed).toBe(false);
  });

  it("unknown scores as the lowest option and is flagged", () => {
    const a = answers();
    a["custody.pause.pause-fn"] = { criterionId: "custody.pause.pause-fn", status: "unknown" };
    const card = scoreProject(a);
    const pause = card.suites.find((s) => s.suiteId === "custody")!.benchmarks.find((b) => b.benchmarkId === "custody.pause")!;
    expect(pause.score).toBeCloseTo(65, 6);
    expect(pause.unknownCount).toBe(1);
    expect(pause.criteria[0]!.rules).toContain("unknown_lowest");
  });

  it("not-applicable is excluded from the denominator only where allowed", () => {
    const a = answers({ "programmability.performance.throughput": "10" });
    a["programmability.performance.proving-time"] = { criterionId: "programmability.performance.proving-time", status: "not_applicable" };
    const perf = scoreProject(a)
      .suites.find((s) => s.suiteId === "programmability")!
      .benchmarks.find((b) => b.benchmarkId === "programmability.performance")!;
    // (22 + 30) / (35 + 30)
    expect(perf.score).toBeCloseTo((52 / 65) * 100, 6);

    const b = answers();
    b["custody.pause.halt"] = { criterionId: "custody.pause.halt", status: "not_applicable" };
    const pause = scoreProject(b)
      .suites.find((s) => s.suiteId === "custody")!
      .benchmarks.find((x) => x.benchmarkId === "custody.pause")!;
    expect(pause.score).toBeCloseTo(75, 6);
  });

  it("instant upgrades cap pause and freeze criteria", () => {
    const card = scoreProject(answers({ "governance.upgrades.upgradeability": "instant" }));
    const custody = card.suites.find((s) => s.suiteId === "custody")!;
    const freeze = custody.benchmarks.find((b) => b.benchmarkId === "custody.freeze")!;
    const pause = custody.benchmarks.find((b) => b.benchmarkId === "custody.pause")!;
    expect(freeze.score).toBeCloseTo(15 + 40 + 20, 6);
    expect(pause.score).toBeCloseTo(8 + 25 + 25 + 15, 6);
    expect(freeze.criteria[0]!.rules).toContain("instant_upgrade_power");
  });

  it("operator visibility caps decryption power at 15 and forces tier D", () => {
    const card = scoreProject(answers({ "trust.decryption.standing-access": "operator" }));
    const dec = card.suites.find((s) => s.suiteId === "trust")!.benchmarks.find((b) => b.benchmarkId === "trust.decryption")!;
    expect(dec.uncapped).toBeCloseTo(50, 6);
    expect(dec.score).toBe(15);
    expect(dec.rules).toContain("operator_visibility_cap");
    expect(card.trustTier).toBe("D");
  });

  it("an unpatched critical bug scores on its own criterion, with no benchmark cap or badge (rubric 1.3.0)", () => {
    const card = scoreProject(answers({ "security.soundness.open-critical": "unpatched" }));
    const sound = card.suites.find((s) => s.suiteId === "security")!.benchmarks.find((b) => b.benchmarkId === "security.soundness")!;
    expect(sound.rules).not.toContain("critical_bug_cap");
    expect(sound.score).toBeGreaterThan(30);
    expect(sound.criteria.find((c) => c.criterionId === "security.soundness.open-critical")!.points).toBe(0);
  });

  it("no private logic zeroes call-stack privacy", () => {
    const card = scoreProject(answers({ "coverage.execution.private-logic": "none" }));
    const cs = card.suites.find((s) => s.suiteId === "coverage")!.benchmarks.find((b) => b.benchmarkId === "coverage.callstack")!;
    expect(cs.score).toBe(0);
    expect(cs.rules).toContain("no_private_logic_gate");
  });

  it("Z0 zeroes the trust and programmability suites", () => {
    const card = scoreProject(
      answers({
        "coverage.confidentiality.amounts": "visible",
        "coverage.unlinkability.sender": "visible",
        "coverage.unlinkability.recipient": "visible",
        "coverage.unlinkability.history": "linkable",
      }),
    );
    expect(card.level).toBe("Z0");
    expect(card.suites.find((s) => s.suiteId === "trust")!.score).toBe(0);
    expect(card.suites.find((s) => s.suiteId === "programmability")!.score).toBe(0);
    expect(card.suites.find((s) => s.suiteId === "custody")!.score).toBeCloseTo(100, 6);
  });

  it("verifiability multiplier applies to favorable high-impact answers only", () => {
    const a = answers();
    a["custody.pause.pause-fn"] = { criterionId: "custody.pause.pause-fn", status: "answered", optionId: "none", verifiability: "marketing" };
    a["custody.pause.halt"] = { criterionId: "custody.pause.halt", status: "answered", optionId: "no", verifiability: "official_docs" };
    const pause = scoreProject(a)
      .suites.find((s) => s.suiteId === "custody")!
      .benchmarks.find((b) => b.benchmarkId === "custody.pause")!;
    expect(pause.score).toBeCloseTo(35 * 0.7 + 25 * 0.9 + 25 + 15, 6);

    // Unfavorable answers keep full weight even if self-reported.
    const b = answers();
    b["custody.pause.pause-fn"] = { criterionId: "custody.pause.pause-fn", status: "answered", optionId: "fast-path", verifiability: "marketing" };
    const pause2 = scoreProject(b)
      .suites.find((s) => s.suiteId === "custody")!
      .benchmarks.find((x) => x.benchmarkId === "custody.pause")!;
    expect(pause2.score).toBeCloseTo(8 + 25 + 25 + 15, 6);
  });

  it("missing benchmarks are skipped and the suite marked incomplete", () => {
    const a = answers();
    for (const c of criteria.filter((c) => c.benchmarkId === "coverage.metadata")) delete a[c.id];
    const card = scoreProject(a);
    const cov = card.suites.find((s) => s.suiteId === "coverage")!;
    expect(cov.complete).toBe(false);
    expect(cov.score).toBeCloseTo(100, 6);
    expect(card.complete).toBe(false);
  });

  it("overallFromSuites reweights", () => {
    const suitesScores = suites.map((s) => ({ suiteId: s.id, score: s.id === "coverage" ? 100 : 0 }));
    expect(overallFromSuites(suitesScores)).toBeCloseTo(24, 6);
    const custom = Object.fromEntries(suites.map((s) => [s.id, s.id === "coverage" ? 50 : 50 / 6])) as never;
    expect(overallFromSuites(suitesScores, custom)).toBeCloseTo(50, 6);
  });
});

describe("badges", () => {
  it("derives the level ladder", () => {
    expect(
      derivePrivacyLevel(
        answers({ "coverage.unlinkability.sender": "visible", "coverage.unlinkability.recipient": "visible", "coverage.unlinkability.history": "linkable" }),
      ),
    ).toBe("Z1");
    expect(derivePrivacyLevel(answers({ "coverage.confidentiality.amounts": "visible", "coverage.unlinkability.sender": "mixing" }))).toBe("Z1");
    expect(derivePrivacyLevel(answers({ "coverage.execution.private-state": "balances-only", "coverage.unlinkability.public-apps": "must-exit" }))).toBe("Z2");
    expect(derivePrivacyLevel(answers({ "coverage.execution.private-logic": "limited" }))).toBe("Z3");
    expect(derivePrivacyLevel(answers({ "coverage.metadata.network": "none" }))).toBe("Z4");
    expect(derivePrivacyLevel({})).toBeNull();
  });

  it("derives trust tiers", () => {
    const lvl = "Z4" as const;
    expect(deriveTrustTier(answers(), lvl)).toBe("A");
    expect(deriveTrustTier(answers({ "trust.decryption.infra-visibility": "tee" }), lvl)).toBe("B");
    expect(deriveTrustTier(answers({ "trust.decryption.standing-access": "single" }), lvl)).toBe("C");
    expect(deriveTrustTier(answers({ "trust.decryption.infra-visibility": "plaintext" }), lvl)).toBe("D");
    expect(deriveTrustTier(answers(), "Z0")).toBeNull();
  });

  it("derives the walkaway test with reasons", () => {
    expect(deriveWalkaway(answers()).passed).toBe(true);
    // A gated private exit passes (the public exit always works) with a note (rubric 1.3.0).
    const gated = deriveWalkaway(answers({ "custody.exit.gatekeeper": "private-gated" }));
    expect(gated.passed).toBe(true);
    expect(gated.notes?.[0]).toMatch(/gated by a third party/);
    expect(deriveWalkaway(answers({ "custody.exit.gatekeeper": "can-refuse" })).passed).toBe(false);
    // A halt-capable operator is fine if a permissionless exit exists.
    expect(deriveWalkaway(answers({ "custody.pause.halt": "yes" })).passed).toBe(true);
    expect(deriveWalkaway(answers({ "custody.pause.halt": "yes", "custody.exit.unilateral": "costly" })).passed).toBe(false);
    expect(deriveWalkaway({}).passed).toBeNull();
  });

  it("flags matrix conflicts", () => {
    const a = answers({ "coverage.confidentiality.amounts": "visible" });
    const conflicts = matrixConflicts({ public_observer: { amount: { state: "private" }, sender: { state: "private" } } }, a);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.field).toBe("amount");
  });
});

describe("unknowns never become public claims", () => {
  const unknown = (a: AnswerMap, ...ids: string[]) => {
    for (const id of ids) a[id] = { criterionId: id, status: "unknown", optionId: null };
    return a;
  };

  it("an unknown critical-bug criterion scores as its riskiest option and nothing more", () => {
    const card = scoreProject(unknown(answers(), RULE_CRITERIA.openCritical));
    const soundness = card.suites.flatMap((s) => s.benchmarks).find((b) => b.benchmarkId === "security.soundness")!;
    expect(soundness.rules).not.toContain("critical_bug_cap");
    expect(soundness.criteria.find((c) => c.criterionId === RULE_CRITERIA.openCritical)!.rules).toContain("unknown_lowest");
  });

  it("unknown visibility inputs give no trust tier and no operator cap", () => {
    const a = unknown(answers(), RULE_CRITERIA.standingAccess);
    expect(deriveTrustTier(a, "Z4")).toBeNull();
    const card = scoreProject(a);
    expect(card.suites.flatMap((s) => s.rules)).not.toContain("operator_visibility_cap");
    expect(deriveTrustTier(answers({ [RULE_CRITERIA.standingAccess]: "operator" }), "Z4")).toBe("D");
  });

  it("reads stored levels from before the rename (L0 to L5) as Z0 to Z5", () => {
    expect(["L0", "L4", "Z2", "Z5"].map(normalizeLevel)).toEqual(["Z0", "Z4", "Z2", "Z5"]);
    expect([null, "", "L6", "Layer 1"].map(normalizeLevel)).toEqual([null, null, null, null]);
  });

  it("reads as what's hidden and from whom, whatever code the level was stored under", () => {
    expect(["L4", "Z4", "P4", "Z0", null].map(levelNumber)).toEqual([4, 4, 4, 0, null]);
    expect(["Z4", "Z0", null].map(hidesLabel)).toEqual(["Hides 4/5", "Hides nothing", "Hides: unrated"]);
    expect(fromLabel("A", "Z4")).toBe("from everyone");
    expect(fromLabel("D", "Z1")).toBe("from all but the operator");
    expect(fromLabel(null, "Z2")).toBe("from: unrated");
    // Nothing hidden: nothing to be hidden from.
    expect(fromLabel(null, "Z0")).toBeNull();
  });

  it("unknown coverage inputs leave the privacy level unrated instead of Z0", () => {
    const a = unknown(answers(), RULE_CRITERIA.amounts, RULE_CRITERIA.sender, RULE_CRITERIA.recipient, RULE_CRITERIA.history);
    expect(derivePrivacyLevel(a)).toBeNull();
    const card = scoreProject(a);
    expect(card.suites.flatMap((s) => s.rules)).not.toContain("l0_gate");
    // Higher levels need their own inputs answered: unknown private state holds the level below Z4.
    expect(derivePrivacyLevel(unknown(answers(), RULE_CRITERIA.privateState))).toMatch(/^Z[23]$/);
  });

  it("walkaway fails only on established facts, and names what's missing", () => {
    const a = unknown(answers(), RULE_CRITERIA.recoverability);
    expect(deriveWalkaway(a)).toEqual({ passed: null, reasons: ["Not established: recoverability"] });
    expect(deriveWalkaway(answers({ [RULE_CRITERIA.recoverability]: "no" })).passed).toBe(false);
    // Several independent parties are needed to halt: no single party can.
    expect(deriveWalkaway(answers({ [RULE_CRITERIA.halt]: "small-set", [RULE_CRITERIA.unilateral]: "none" })).passed).toBe(true);
    expect(deriveWalkaway(answers({ [RULE_CRITERIA.halt]: "yes", [RULE_CRITERIA.unilateral]: "none" })).passed).toBe(false);
  });

  it("not-researched criteria are excluded from points and make the card incomplete", () => {
    const a = answers();
    a[RULE_CRITERIA.pauseFn] = { criterionId: RULE_CRITERIA.pauseFn, status: "not_researched" };
    const card = scoreProject(a);
    expect(card.complete).toBe(false);
    const pause = card.suites.flatMap((s) => s.benchmarks).find((b) => b.benchmarkId === "custody.pause")!;
    expect(pause.notResearchedCount).toBe(1);
    expect(pause.score).toBeCloseTo(100, 4);
  });

  it("favorable badge-driving answers with no supporting source are discounted like marketing", () => {
    const a = answers();
    a[RULE_CRITERIA.openCritical] = { criterionId: RULE_CRITERIA.openCritical, status: "answered", optionId: "none", verifiability: null };
    const crit = scoreProject(a)
      .suites.flatMap((s) => s.benchmarks)
      .flatMap((b) => b.criteria)
      .find((c) => c.criterionId === RULE_CRITERIA.openCritical)!;
    expect(crit.multiplier).toBe(0.7);
    expect(crit.rules).toContain("unsupported_favorable");
    expect(BADGE_DRIVING.has(RULE_CRITERIA.openCritical)).toBe(true);
    expect(isHighScrutiny(getCriterion(RULE_CRITERIA.openCritical))).toBe(true);
  });

  it("diffs see status changes, not just option changes", () => {
    const prev = answers();
    const lowest = lowestOption(getCriterion(RULE_CRITERIA.pauseFn)).id;
    prev[RULE_CRITERIA.pauseFn] = { criterionId: RULE_CRITERIA.pauseFn, status: "answered", optionId: lowest };
    const next = unknown(answers(), RULE_CRITERIA.pauseFn);
    expect(diffAnswers(prev, next).map((d) => d.criterionId)).toContain(RULE_CRITERIA.pauseFn);
  });
});

describe("answer consistency", () => {
  it("flags answers that can't both be true, only when both are established", async () => {
    const { consistencyConflicts, CONSISTENCY_RULES } = await import("../src");
    for (const r of CONSISTENCY_RULES) {
      expect(findCriterion(r.a), r.a).toBeTruthy();
      expect(findCriterion(r.b), r.b).toBeTruthy();
    }
    expect(consistencyConflicts(answers())).toEqual([]);
    const bad = answers({ "governance.upgrades.upgradeability": "immutable", "custody.exit.window": "7d" });
    expect(consistencyConflicts(bad).map((c) => c.criterionIds)).toContainEqual(["governance.upgrades.upgradeability", "custody.exit.window"]);
    bad["custody.exit.window"] = { criterionId: "custody.exit.window", status: "unknown" };
    expect(consistencyConflicts(bad)).toEqual([]);
  });
});

describe("fact links and matrix checks", () => {
  it("relates a criterion to its benchmark and its linked criteria, never itself", async () => {
    const { relatedCriteria } = await import("../src");
    const halt = relatedCriteria("custody.pause.halt");
    expect(halt).toContain("custody.pause.track-record");
    expect(halt).toContain("decentralization.operators.producers");
    expect(halt).not.toContain("custody.pause.halt");
    expect(relatedCriteria("custody.exit.window")).toContain("governance.upgrades.upgradeability");
    expect(relatedCriteria("governance.upgrades.upgradeability")).toContain("custody.exit.window");
    for (const c of criteria) for (const id of relatedCriteria(c.id)) expect(findCriterion(id), `${c.id} → ${id}`).toBeTruthy();
  });

  it("catches a gatekeeper answered none while the private exit has a gate with a public fallback", async () => {
    const { consistencyConflicts } = await import("../src");
    const a = answers({ "custody.exit.gatekeeper": "none", "custody.access.private-exit": "gate-fallback" });
    expect(consistencyConflicts(a).map((c) => c.criterionIds)).toContainEqual(["custody.exit.gatekeeper", "custody.access.private-exit"]);
  });

  it("doesn't call a mixer's public depositor a conflict, and skips unknowns", () => {
    const pool = answers({
      "coverage.unlinkability.sender": "mixing",
      "coverage.unlinkability.recipient": "mixing",
      "coverage.confidentiality.amounts": "visible",
    });
    const matrix = {
      public_observer: { sender: { state: "exposed" as const, note: "" }, link: { state: "private" as const, note: "" } },
      privileged_insider: { amount: { state: "exposed" as const, note: "" } },
    };
    expect(matrixConflicts(matrix as never, pool)).toEqual([]);
    const linkExposed = { public_observer: { link: { state: "exposed" as const, note: "" } } };
    expect(matrixConflicts(linkExposed as never, pool).map((c) => c.field)).toEqual(["link"]);
    pool["coverage.unlinkability.sender"] = { criterionId: "coverage.unlinkability.sender", status: "unknown" };
    expect(matrixConflicts(linkExposed as never, pool)).toEqual([]);
  });
});

describe("source classes and consistency rules (R4 weak tests)", () => {
  it("weighs third-party sources below official docs and above marketing", async () => {
    const { SOURCE_CLASS_RANK, VERIFIABILITY_MULTIPLIER } = await import("../src");
    expect(VERIFIABILITY_MULTIPLIER.third_party).toBe(0.8);
    const order = Object.entries(SOURCE_CLASS_RANK)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
    expect(order).toEqual(["code_onchain", "independent", "official_docs", "third_party", "marketing"]);
  });

  it("fires every consistency rule on a pair that can't both be true", async () => {
    const { consistencyConflicts, CONSISTENCY_RULES } = await import("../src");
    // For each rule, find an answer pair that conflicts, starting from all-best answers.
    for (const rule of CONSISTENCY_RULES) {
      const a = getCriterion(rule.a);
      const b = getCriterion(rule.b);
      let fired = false;
      for (const oa of a.options) {
        for (const ob of b.options) {
          const map = answers({ [rule.a]: oa.id, [rule.b]: ob.id });
          if (consistencyConflicts(map).some((c) => c.criterionIds[0] === rule.a && c.criterionIds[1] === rule.b)) fired = true;
        }
      }
      expect(fired, `${rule.a} vs ${rule.b}`).toBe(true);
    }
  });
});
