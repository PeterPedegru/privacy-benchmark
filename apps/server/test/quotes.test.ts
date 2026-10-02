import { describe, expect, it } from "vitest";
import { findQuoteSource, verifyQuote } from "../src/services/quotes.ts";

const filler = (n: number) => Array.from({ length: n }, (_, i) => `Filler sentence number ${i} talks about something unrelated.`).join(" ");

describe("quote verification (R3-JDG-12)", () => {
  it("rejects stitched parts from distant passages and labels close ones as stitched", () => {
    const src = `Withdrawals cannot exceed the daily limit set by governance. ${filler(15)} Deposits can be paused by the owner at any time.`;
    const far = verifyQuote("Withdrawals cannot exceed the daily limit … Deposits can be paused by the owner at any time", src);
    expect(far.verified).toBe(false);
    expect(far.reason).toMatch(/too far apart/);
    const near = "The relayer submits the withdrawal proof on behalf of the user. It pays the gas and is reimbursed from the withdrawn amount.";
    const ok = verifyQuote("The relayer submits the withdrawal proof on behalf … reimbursed from the withdrawn amount", near);
    expect(ok.verified).toBe(true);
    expect(ok.method).toBe("stitched");
    // Fragments too short to stand alone can't be stitched into a claim.
    expect(verifyQuote("Withdrawals cannot … be paused by the owner", src).verified).toBe(false);
  });

  it("refuses a stitch whose omitted text carries a negation (R4-9)", () => {
    const src = "Under the current design the owner can not, and never will, pause the withdrawals of every user at once.";
    const r = verifyQuote("Under the current design the owner can … pause the withdrawals of every user at once", src);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/changes the meaning/);
  });

  it("never accepts a near match that flips meaning", () => {
    const src = "Users are unable to withdraw while the bridge is paused by the security council for maintenance.";
    expect(verifyQuote("Users are able to withdraw while the bridge is paused by the security council for maintenance.", src).verified).toBe(false);
    const up = "The verifier contract is non-upgradeable and cannot be replaced by any party after deployment.";
    expect(verifyQuote("The verifier contract is upgradeable and cannot be replaced by any party after deployment.", up).verified).toBe(false);
    const fee = "The protocol fee will increase over the first year of operation as governance decides.";
    expect(verifyQuote("The protocol fee will decrease over the first year of operation as governance decides.", fee).verified).toBe(false);
    // A small spelling difference still verifies, and the stored span is the source's text.
    const typo = verifyQuote("The protocol fee will increse over the first year of operation as governance decides.", fee);
    expect(typo.verified).toBe(true);
    expect(typo.span).toBe(fee.slice(0, -1));
  });

  it("snaps near-match spans to whole words", () => {
    const src = "Background text here. The administrator is a three-of-five multisig controlled by the foundation and two partners. More text.";
    const r = verifyQuote("the administrator is a three of five multisig controlled by the foundation and two partner", src);
    expect(r.verified).toBe(true);
    expect(r.span?.startsWith("The administrator")).toBe(true);
    expect(r.span?.endsWith("partners")).toBe(true);
  });

  it("bounds re-attribution to a few candidates under the size cap", () => {
    const quote = "The pool contract has no owner and no function that can pause withdrawals.";
    const big = { id: "big", contentMd: `${"x ".repeat(300_000)}${quote}` };
    const hits = [{ id: "a", contentMd: "nothing here" }, big, { id: "b", contentMd: `Intro. ${quote}` }];
    expect(findQuoteSource(quote, hits)?.source.id).toBe("b");
    expect(
      findQuoteSource(quote, [
        { id: "1", contentMd: "x" },
        { id: "2", contentMd: "y" },
        { id: "3", contentMd: "z" },
        { id: "4", contentMd: quote },
      ]),
    ).toBeNull();
  });
});
