import { fromLabel, HIDDEN_FROM, hidesLabel, levelNumber, type PrivacyLevel, type TrustTier, type WalkawayResult } from "@pb/rubric";
import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tip } from "./tooltip";

type Tone = "strong" | "fair" | "weak" | "poor" | "neutral" | "accent";
const tones: Record<Tone, string> = {
  strong: "bg-strong-bg border-strong-bd text-strong-fg",
  fair: "bg-fair-bg border-fair-bd text-fair-fg",
  weak: "bg-weak-bg border-weak-bd text-weak-fg",
  poor: "bg-poor-bg border-poor-bd text-poor-fg",
  neutral: "bg-surface border-line text-fg-3",
  accent: "bg-accent-soft border-accent-line text-accent-fg",
};

export function Chip({ tone = "neutral", className, children, title }: { tone?: Tone; className?: string; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn("inline-flex h-[22px] items-center gap-1 rounded-md border px-1.5 text-xs font-medium whitespace-nowrap tabular", tones[tone], className)}
    >
      {children}
    </span>
  );
}

export function bandTone(v: number | null | undefined): Tone {
  if (v === null || v === undefined) return "neutral";
  if (v >= 75) return "strong";
  if (v >= 50) return "fair";
  if (v >= 25) return "weak";
  return "poor";
}

/** What each number of "Hides n/5" means: what a careful user can keep from the public. */
const LEVEL_TEXT = [
  "Transparent: nothing hidden at protocol level",
  "Partial: hides amounts or links, not both",
  "Private transfers: sender, recipient and amount hidden",
  "Private accounts: private transfers plus anonymous access to public apps",
  "Private execution: general private state and logic",
  "Full-stack private: private execution, hidden call graph, network and read privacy",
] as const;
const TIER_TEXT: Record<TrustTier, string> = {
  A: "no third party can see private data",
  B: "plaintext passes through trusted hardware (TEEs)",
  C: "a designated party or committee can decrypt",
  D: "the operator sees plaintext routinely",
};
const TIER_TONE: Record<TrustTier, Tone> = { A: "strong", B: "accent", C: "fair", D: "poor" };

/**
 * The privacy badge: what's hidden ("Hides 4/5", with a meter) and from whom ("from everyone"), read as one phrase.
 * Without `tier` it shows only what's hidden (a list of versions); `compact` drops the meter.
 */
export function PrivacyBadge({ level, tier, compact }: { level: PrivacyLevel | string | null; tier?: TrustTier | null; compact?: boolean }) {
  const n = levelNumber(level);
  const from = tier === undefined ? null : fromLabel(tier, level);
  const tip = [
    n === null
      ? "What's hidden: unrated. The evidence doesn't establish it (amounts, sender, recipient and history must all be answered)"
      : `What's hidden: ${n}/5, ${LEVEL_TEXT[n]}`,
    tier === undefined || n === 0
      ? null
      : tier
        ? `Hidden ${HIDDEN_FROM[tier]}: ${TIER_TEXT[tier]}`
        : "Hidden from: unrated. The evidence doesn't establish who besides you can see your data",
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <Tip content={tip}>
      <span className="inline-flex h-[22px] items-stretch overflow-hidden rounded-md border border-line bg-bg text-xs font-semibold whitespace-nowrap text-fg tabular">
        <span className="flex items-center gap-1.5 px-1.5">
          {hidesLabel(level)}
          {!compact && n !== null && n > 0 && (
            <span className="flex gap-[2px]" aria-hidden>
              {[1, 2, 3, 4, 5].map((i) => (
                <span key={i} className={cn("h-2.5 w-[3px] rounded-full", i <= n ? "bg-accent" : "bg-line-strong")} />
              ))}
            </span>
          )}
        </span>
        {from && <span className={cn("flex items-center border-l px-1.5 font-medium", tones[tier ? TIER_TONE[tier] : "neutral"])}>{from}</span>}
      </span>
    </Tip>
  );
}

export function WalkawayBadge({ walkaway, compact }: { walkaway: WalkawayResult; compact?: boolean }) {
  const p = walkaway.passed;
  return (
    <Tip
      content={
        p === null
          ? `Walkaway test unrated${walkaway.reasons.length ? `: ${walkaway.reasons.join("; ")}` : ""}`
          : p
            ? `Walkaway test passed: users can keep going if any single party disappears${walkaway.notes?.length ? ` (${walkaway.notes.join("; ")})` : ""}`
            : `Walkaway test failed: ${walkaway.reasons.join("; ")}`
      }
    >
      <span className="inline-flex">
        <Chip tone={p === null ? "neutral" : p ? "strong" : "poor"}>
          {p ? <Check className="size-3" strokeWidth={2.5} /> : p === false ? <X className="size-3" strokeWidth={2.5} /> : null}
          {compact ? "WA" : "Walkaway"}
        </Chip>
      </span>
    </Tip>
  );
}

export function ScoreChip({ value }: { value: number | null }) {
  return <Chip tone={bandTone(value)}>{value === null ? "—" : `${value.toFixed(1)}%`}</Chip>;
}
