import type { PrivacyLevel, TrustTier, WalkawayResult } from "@pb/rubric";
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

const LEVEL_TEXT: Record<PrivacyLevel, string> = {
  Z0: "Transparent: nothing hidden at protocol level",
  Z1: "Partial: hides amounts or links, not both",
  Z2: "Private transfers: sender, recipient and amount hidden",
  Z3: "Private accounts: private transfers plus anonymous access to public apps",
  Z4: "Private execution: general private state and logic",
  Z5: "Full-stack private: private execution, hidden call graph, network and read privacy",
};
const TIER_TEXT: Record<TrustTier, string> = {
  A: "Trustless: no third party can see private data",
  B: "Hardware-trusted: plaintext passes through TEEs",
  C: "Key-holder: a designated party or committee can decrypt",
  D: "Operator-visible: the operator sees plaintext routinely",
};
const TIER_TONE: Record<TrustTier, Tone> = { A: "strong", B: "accent", C: "fair", D: "poor" };

export function LevelBadge({ level, compact }: { level: PrivacyLevel | null; compact?: boolean }) {
  const n = level ? Number(level.slice(1)) : -1;
  return (
    <Tip
      content={
        level
          ? `Privacy Level ${level} · ${LEVEL_TEXT[level]}`
          : "Privacy Level unrated: the evidence doesn't establish what's hidden (amounts, sender, recipient and history must all be answered)"
      }
    >
      <span className="inline-flex h-[22px] items-center gap-1.5 rounded-md border border-line bg-bg px-1.5 text-xs font-semibold text-fg tabular">
        {level ?? (compact ? "L?" : "Unrated")}
        {!compact && (
          <span className="flex gap-[2px]" aria-hidden>
            {[1, 2, 3, 4, 5].map((i) => (
              <span key={i} className={cn("h-2.5 w-[3px] rounded-full", i <= n ? "bg-accent" : "bg-line-strong")} />
            ))}
          </span>
        )}
      </span>
    </Tip>
  );
}

export function TierBadge({ tier, level }: { tier: TrustTier | null; level?: PrivacyLevel | null }) {
  return (
    <Tip
      content={
        tier
          ? `Trust Tier ${tier} · ${TIER_TEXT[tier]}`
          : level === "Z0"
            ? "No trust tier: nothing is private (Z0)"
            : "Trust Tier unrated: the evidence doesn't establish who besides you can see your data"
      }
    >
      <span className="inline-flex">
        <Chip tone={tier ? TIER_TONE[tier] : "neutral"} className="font-semibold">
          {tier ? `Tier ${tier}` : "Tier —"}
        </Chip>
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
