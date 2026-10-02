/**
 * The "careful user, reference client" standard: privacy criteria score what a careful user gets with the reference
 * client's supported options, opt-in ones included, and only criteria that ask about the default score the default.
 * Aztec's recipient was marked visible because its private handshake is opt-in; the golden labels say hidden.
 */
import { criteria } from "@pb/rubric";
import { describe, expect, it } from "vitest";
import { judgeSystem, researchSystem, SCOPE_RULES, SKEPTIC_SYSTEM } from "../src/eval/prompts.ts";

describe("the careful-user standard in the evaluator's prompts", () => {
  it("doesn't tell any stage to judge the default configuration across the board", () => {
    for (const p of [SCOPE_RULES, judgeSystem("coverage"), SKEPTIC_SYSTEM, researchSystem("coverage")]) {
      expect(p).not.toMatch(/live, default configuration|LIVE, DEFAULT configuration/i);
      expect(p).toMatch(/off by default/);
    }
  });

  it("counts supported opt-in privacy options except where a criterion asks about the default", () => {
    expect(SCOPE_RULES).toMatch(/counts even when it's off by default/);
    expect(SCOPE_RULES).toMatch(/Only a criterion whose question or options say "by default" judges the default/);
    expect(judgeSystem("coverage")).toMatch(/opt-in ones included, unless the criterion asks about the default/);
    expect(SKEPTIC_SYSTEM).toMatch(/counts only against a criterion that asks about the default/);
  });

  it("leaves the criteria that ask about defaults asking about them", () => {
    const byDefault = criteria.filter((c) => /by default/i.test([c.question, c.guidance, ...c.options.map((o) => o.label)].join(" "))).map((c) => c.id);
    // The six the methodology page names: fees, receiving, network privacy, private reads, privacy by default,
    // client-side proving.
    expect(byDefault).toEqual([
      "coverage.unlinkability.fees",
      "coverage.identity.reusable-address",
      "coverage.metadata.network",
      "coverage.metadata.reads",
      "coverage.anonymity-set.default",
      "decentralization.proving.client-side",
    ]);
    expect(byDefault).not.toContain("coverage.unlinkability.recipient");
  });
});
