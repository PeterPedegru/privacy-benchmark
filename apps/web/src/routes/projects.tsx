import { Link } from "@tanstack/react-router";
import { m } from "motion/react";
import { useMemo, useState } from "react";
import { Bar } from "@/components/bench/viz";
import { PrivacyBadge, WalkawayBadge } from "@/components/ui/badges";
import { Skeleton } from "@/components/ui/misc";
import { Pct } from "@/components/ui/number";
import { ProjectMark } from "@/components/ui/project-mark";
import { Segmented } from "@/components/ui/segmented";
import { focusIn, stagger } from "@/design/motion";
import { useLeaderboard } from "@/lib/queries";

const CATEGORY: Record<string, string> = {
  l1: "L1",
  l2: "L2",
  privacy_pool: "Privacy pool",
  privacy_app: "Privacy app",
  coprocessor: "Coprocessor",
  appchain: "Appchain",
  wallet: "Wallet",
  other: "Other",
};
const MECH: Record<string, string> = {
  pool: "Pool",
  shielded_ledger: "Shielded ledger",
  stealth_address: "Stealth addresses",
  confidential_amounts: "Confidential amounts",
  private_execution: "Private execution",
  none: "None",
};

export function ProjectsPage() {
  const lb = useLeaderboard();
  const [sort, setSort] = useState<"score" | "name">("score");
  const rows = useMemo(() => {
    const r = [...(lb.data?.rows ?? [])];
    return sort === "name" ? r.sort((a, b) => a.name.localeCompare(b.name)) : r;
  }, [lb.data, sort]);
  return (
    <div className="mx-auto max-w-[var(--container-page)] px-4 pt-10 sm:px-6 md:pt-14">
      <m.div variants={focusIn} initial="hidden" animate="show" className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="max-w-2xl">
          <div className="eyebrow mb-3">Projects</div>
          <h1 className="text-[34px] leading-[1.12] font-semibold tracking-[-0.02em] text-balance md:text-5xl md:leading-[1.06]">
            Every system we score. <span className="text-muted">Pinned to the version we evaluated.</span>
          </h1>
        </div>
        <Segmented
          value={sort}
          onChange={setSort}
          options={[
            { value: "score", label: "By score" },
            { value: "name", label: "A–Z" },
          ]}
        />
      </m.div>
      <m.div
        variants={stagger(0.04)}
        initial="hidden"
        animate="show"
        // One explicit column on phones: an implicit one grows to its widest nowrap line and clips the cards.
        className="mt-10 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3"
      >
        {lb.isLoading &&
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-bg p-5">
              <Skeleton className="h-24" />
            </div>
          ))}
        {rows.map((r) => (
          <m.div key={r.slug} variants={focusIn} className="bg-bg">
            <Link to="/projects/$slug" params={{ slug: r.slug }} className="flex h-full flex-col p-5 transition-colors hover:bg-bg-2">
              <div className="flex items-start gap-3">
                <ProjectMark name={r.name} logoUrl={r.logoUrl} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="text-[17px] font-semibold tracking-[-0.01em]">{r.name}</div>
                  <div className="truncate text-xs text-muted">
                    {CATEGORY[r.category]} · {MECH[r.mechanism]}
                    {r.version ? ` · ${r.version.label}` : ""}
                  </div>
                </div>
                <div className="text-right text-xl font-semibold tracking-[-0.02em] tabular">
                  <Pct value={r.overall} />
                </div>
              </div>
              <p className="mt-3 line-clamp-2 text-sm text-muted">{r.tagline}</p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                <PrivacyBadge level={r.level} tier={r.trustTier} />
                <WalkawayBadge walkaway={r.walkaway} />
              </div>
              <Bar value={r.overall} className="mt-auto translate-y-2" />
            </Link>
          </m.div>
        ))}
        {/* Blank cells finish the last row, so the grid's line colour doesn't show through as a grey block. */}
        {Array.from({ length: (2 - (rows.length % 2)) % 2 }, (_, i) => (
          <div key={`fill2-${i}`} className="hidden bg-bg sm:block lg:hidden" />
        ))}
        {Array.from({ length: (3 - (rows.length % 3)) % 3 }, (_, i) => (
          <div key={`fill3-${i}`} className="hidden bg-bg lg:block" />
        ))}
      </m.div>
    </div>
  );
}
