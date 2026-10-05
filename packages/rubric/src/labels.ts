import type { TrustTier } from "./types.ts";

/**
 * How privacy reads on the site and in cards: two scores out of five, both with a meter.
 *   Public:   what a careful user keeps from everyone watching the chain (the privacy level, 0 to 5).
 *   Operator: what stays hidden from those who run it (the trust tier: A 5, B 4, C 2, D 0).
 * The codes behind them (a level stored as L, Z or P plus a digit, a tier A to D) never show.
 */

/** The privacy level as a number, 0 (nothing hidden) to 5, whichever code a result stored it under (L, Z or P). */
export function levelNumber(level: string | null | undefined): number | null {
  const m = /^[A-Z]?([0-5])$/.exec(level ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * How much stays hidden from the operator, out of five. The gaps mark where the trust needed jumps: only trusted
 * hardware sees plaintext (4), a key-holder or committee can decrypt at will (2), the operator sees it routinely (0).
 */
export const OPERATOR_SCORE: Record<TrustTier, number> = { A: 5, B: 4, C: 2, D: 0 };

/** The operator score, or null when it isn't established or nothing is hidden at all (nothing to protect). */
export function operatorNumber(tier: TrustTier | null, level: string | null | undefined): number | null {
  if (levelNumber(level) === 0 || !tier) return null;
  return OPERATOR_SCORE[tier];
}

/** "Public 4/5 · Operator 5/5", for cards and summaries; "—" for a part that isn't established or doesn't apply. */
export function privacyText(level: string | null | undefined, tier: TrustTier | null): string {
  const pub = levelNumber(level);
  const op = operatorNumber(tier, level);
  return `Public ${pub === null ? "—" : `${pub}/5`} · Operator ${op === null ? "—" : `${op}/5`}`;
}
