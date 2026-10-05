import type { TrustTier } from "./types.ts";

/**
 * How the privacy level and trust tier read on the site and in cards: what's hidden ("Hides 4/5") and from whom
 * ("from everyone"). The codes behind them (a level stored as L, Z or P plus a digit, a tier A to D) never show.
 */

/** The privacy level as a number, 0 (nothing hidden) to 5, whichever code a result stored it under (L, Z or P). */
export function levelNumber(level: string | null | undefined): number | null {
  const m = /^[A-Z]?([0-5])$/.exec(level ?? "");
  return m ? Number(m[1]) : null;
}

/** "Hides 4/5", "Hides nothing" or "Hides: unrated". */
export function hidesLabel(level: string | null | undefined): string {
  const n = levelNumber(level);
  return n === null ? "Hides: unrated" : n === 0 ? "Hides nothing" : `Hides ${n}/5`;
}

/** Who can still see what's hidden, by trust tier. */
export const HIDDEN_FROM: Record<TrustTier, string> = {
  A: "from everyone",
  B: "from all but trusted hardware",
  C: "from all but a key-holder",
  D: "from all but the operator",
};

/** "from everyone" … "from all but the operator"; null when nothing is hidden. */
export function fromLabel(tier: TrustTier | null, level: string | null | undefined): string | null {
  if (levelNumber(level) === 0) return null;
  return tier ? HIDDEN_FROM[tier] : "from: unrated";
}
