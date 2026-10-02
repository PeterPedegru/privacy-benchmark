import { criteria } from "@pb/rubric";
import { describe, expect, it } from "vitest";
import { CODE_UNDECIDABLE, EVENT_CRITERIA, isCodeCheckable } from "../src/eval/absence.ts";
import { promptCatalog } from "../src/eval/prompts.ts";

describe("which unknowns the code check examines", () => {
  it("skips track records, events and measured figures, and checks everything else", () => {
    for (const id of EVENT_CRITERIA) expect(isCodeCheckable(id), id).toBe(false);
    for (const id of ["programmability.developer.sdks", "programmability.performance.proving-time", "trust.crypto.formal-privacy"])
      expect(isCodeCheckable(id), id).toBe(false);
    // The mechanics a code read settles.
    for (const id of [
      "decentralization.censorship.forced-inclusion",
      "decentralization.censorship.indistinguishable",
      "coverage.unlinkability.fees",
      "custody.freeze.blocklist",
      "governance.upgrades.verifier",
      "coverage.metadata.network",
    ])
      expect(isCodeCheckable(id), id).toBe(true);
    // Every listed id is a real criterion, and most of the rubric is code-checkable.
    for (const id of CODE_UNDECIDABLE)
      expect(
        criteria.some((c) => c.id === id),
        id,
      ).toBe(true);
    expect(criteria.filter((c) => isCodeCheckable(c.id)).length).toBeGreaterThan(criteria.length * 0.8);
  });

  it("publishes the mechanics and code-check prompts with the others", () => {
    const catalog = promptCatalog();
    expect(catalog.mechanics).toMatch(/source of truth/);
    expect(catalog["code-check"]).toMatch(/code is the source of truth/i);
  });
});
