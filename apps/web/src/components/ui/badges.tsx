import { levelNumber, OPERATOR_SCORE, operatorNumber, type PrivacyLevel, type TrustTier, type WalkawayResult } from "@pb/rubric";
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

/** What each Public score means: what a careful user keeps from everyone watching the chain. */
const PUBLIC_TEXT = [
  "Nothing hidden at protocol level",
  "Hides amounts or links, not both",
  "Private transfers: sender, recipient and amount hidden",
  "Private accounts: private transfers plus anonymous access to public apps",
  "Private execution: general private state and logic",
  "Full-stack private: private execution, hidden call graph, network and read privacy",
] as const;
/** What each Operator score means: who, if anyone, among those running the system can still see it. */
const OPERATOR_TEXT: Record<TrustTier, string> = {
  A: "No third party can see private data",
  B: "Only trusted hardware (TEEs) sees plaintext",
  C: "A designated key-holder or committee can decrypt",
  D: "The operator sees plaintext routinely",
};
const OPERATOR_TONE: Record<TrustTier, Tone> = { A: "strong", B: "accent", C: "fair", D: "poor" };

/** One labelled score out of five with its meter: "Public 4/5 ▮▮▮▮▯". */
function Meter({ label, n, compact }: { label: string; n: number | null; compact?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 px-1.5">
      <span className="font-medium text-muted">{label}</span>
      {n === null ? "—" : `${n}/5`}
      {!compact && n !== null && (
        <span className="flex gap-[2px]" aria-hidden>
          {[1, 2, 3, 4, 5].map((i) => (
            <span key={i} className={cn("h-2.5 w-[3px] rounded-full", i <= n ? "bg-current" : "bg-line-strong")} />
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * The Privacy Level badge: how much is hidden from the public (the privacy level) and from the operator (the trust
 * tier), each out of five with a meter. Without `tier` it shows only the Public part (a list of versions); `compact`
 * drops the meters.
 */
export function PrivacyBadge({ level, tier, compact }: { level: PrivacyLevel | string | null; tier?: TrustTier | null; compact?: boolean }) {
  const pub = levelNumber(level);
  const op = tier === undefined ? undefined : operatorNumber(tier, level);
  const tip = [
    pub === null
      ? "Public: unrated. The evidence doesn't establish what's hidden (amounts, sender, recipient and history must all be answered)"
      : `Public ${pub}/5: ${PUBLIC_TEXT[pub]}`,
    tier === undefined
      ? null
      : pub === 0
        ? "Operator: not applicable, nothing is hidden"
        : tier
          ? `Operator ${OPERATOR_SCORE[tier]}/5: ${OPERATOR_TEXT[tier]}`
          : "Operator: unrated. The evidence doesn't establish who besides you can see your data",
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <Tip content={tip}>
      <span className="inline-flex h-[22px] items-stretch overflow-hidden rounded-md border border-line bg-bg text-xs font-semibold whitespace-nowrap text-fg tabular">
        <span className="flex items-center text-accent-fg">
          <Meter label="Public" n={pub} compact={compact} />
        </span>
        {op !== undefined && (
          <span className={cn("flex items-center border-l", tier && pub !== 0 ? tones[OPERATOR_TONE[tier]] : "border-line text-fg-3")}>
            <Meter label="Operator" n={op} compact={compact} />
          </span>
        )}
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
