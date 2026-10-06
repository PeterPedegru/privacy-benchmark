import { rescoreCard, type Weighting } from "@pb/rubric";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo } from "react";
import { Skeleton } from "@/components/ui/misc";
import { ProjectMark } from "@/components/ui/project-mark";
import { defaultRefs, useCompare, useLeaderboard } from "@/lib/queries";
import { cn, fmtNum, fmtPct } from "@/lib/utils";

/**
 * The published results scored again under a ballot's weighting, next to the current one: how the ranking would
 * move if this ballot were the poll's result. Computed here from the published score cards with the site's own
 * scoring code; badges never move (a weighting doesn't change them).
 */
export function ImpactPreview({ base, mine, changed }: { base: Weighting; mine: Weighting; changed: boolean }) {
  const lb = useLeaderboard();
  const refs = defaultRefs(lb.data);
  const cmp = useCompare(refs);
  const before = useMemo(
    () =>
      (cmp.data?.snapshots ?? [])
        .map((s) => ({ s, score: rescoreCard(s.scores, base).overall }))
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
        .map((x, i) => ({ ...x, rank: i + 1 })),
    [cmp.data, base],
  );
  const rows = useMemo(() => {
    const rankBefore = new Map(before.map((x) => [x.s.project.slug + (x.s.version?.version ?? ""), x]));
    return before
      .map(({ s }) => ({ s, was: rankBefore.get(s.project.slug + (s.version?.version ?? ""))!, score: rescoreCard(s.scores, mine).overall }))
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
      .map((x, i) => ({ ...x, rank: i + 1 }));
  }, [before, mine]);

  return (
    <div className="rounded-2xl border border-line bg-bg">
      <div className="border-b border-line px-4 py-3">
        <div className="text-sm font-semibold">If your weights won</div>
        <div className="text-xs text-muted">The leaderboard{rows.length >= 16 ? "'s top 16" : ""}, scored with your ballot. Badges don't change.</div>
      </div>
      {cmp.isLoading || lb.isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-6" />
          ))}
        </div>
      ) : (
        <ol className="flex flex-col">
          {rows.map(({ s, was, score, rank }) => {
            const move = was.rank - rank;
            const delta = score !== null && was.score !== null ? score - was.score : null;
            return (
              <li key={s.project.slug + (s.version?.version ?? "")} className="flex items-center gap-2.5 border-b border-line-weak px-4 py-2 last:border-0">
                <span className="w-4 text-xs text-muted tabular">{rank}</span>
                <ProjectMark name={s.project.name} logoUrl={s.project.logoUrl} size={18} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{s.project.name}</span>
                {move !== 0 && (
                  <span className={cn("inline-flex items-center text-[11px] font-semibold tabular", move > 0 ? "text-strong-fg" : "text-poor-fg")}>
                    {move > 0 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
                    {Math.abs(move)}
                  </span>
                )}
                {changed && delta !== null && Math.abs(delta) >= 0.05 && (
                  <span className={cn("text-[11px] tabular", delta > 0 ? "text-strong-fg" : "text-poor-fg")}>
                    {delta > 0 ? "+" : "−"}
                    {fmtNum(Math.abs(delta), 1)}
                  </span>
                )}
                <span className="w-12 text-right text-[13px] font-semibold tabular">{fmtPct(score)}</span>
              </li>
            );
          })}
          {!rows.length && <li className="px-4 py-6 text-center text-sm text-muted">Nothing published yet.</li>}
        </ol>
      )}
    </div>
  );
}
