import type { ProjectSnapshot } from "@pb/core";
import { suites } from "@pb/rubric";
import { ChevronDown } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { memo, useMemo, useState } from "react";
import { easeOut } from "@/design/motion";
import { cn, fmtPct } from "@/lib/utils";
import { Pct } from "../ui/number";
import { ProjectMark } from "../ui/project-mark";
import { benchmarkScore, bestIndices, cellMarks, matchesRef, refOf, suiteScore } from "./model";

/** Phone layout: each benchmark pivots into a card listing the selected projects. `onCell` must be stable. */
export const BenchmarkPivot = memo(function BenchmarkPivot({
  snapshots,
  focus,
  onCell,
  suiteFilter,
}: {
  snapshots: ProjectSnapshot[];
  focus: string | null;
  onCell: (benchmarkId: string, ref: string) => void;
  suiteFilter?: string[];
}) {
  const focusIdx = snapshots.findIndex((s) => matchesRef(s, focus));
  const filterKey = suiteFilter?.join(",") ?? "";
  const shown = useMemo(() => {
    const only = filterKey ? filterKey.split(",") : [];
    return suites.filter((s) => !only.length || only.includes(s.id));
  }, [filterKey]);
  const shownIds = useMemo(() => shown.map((s) => s.id), [shown]);
  // Scores per benchmark, once per set of snapshots.
  const rows = useMemo(() => {
    const out = new Map<string, { values: (number | null)[]; best: number[]; unverified: boolean[] }>();
    for (const su of suites)
      for (const b of su.benchmarks) {
        const values = snapshots.map((s) => benchmarkScore(s, b.id)?.score ?? null);
        out.set(b.id, { values, best: bestIndices(values), unverified: snapshots.map((s) => cellMarks(s, b.id).unverified > 0) });
      }
    return out;
  }, [snapshots]);
  return (
    <div className="flex flex-col gap-8">
      <SummaryCard snapshots={snapshots} focusIdx={focusIdx} shown={shownIds} />
      {shown.map((su) => (
        <section key={su.id}>
          <div className="sticky top-16 z-10 -mx-4 mb-2 border-b border-line bg-bg/95 px-4 py-2.5 backdrop-blur-sm">
            <div className="text-[15px] font-semibold">{su.name}</div>
            <div className="text-xs text-muted">{su.tagline}</div>
          </div>
          <div className="flex flex-col gap-2">
            {su.benchmarks.map((b) => (
              <PivotRow
                key={b.id}
                benchmarkId={b.id}
                title={b.name}
                question={b.question}
                snapshots={snapshots}
                focusIdx={focusIdx}
                scores={rows.get(b.id)!}
                onCell={onCell}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
});

const SummaryCard = memo(function SummaryCard({ snapshots, focusIdx, shown }: { snapshots: ProjectSnapshot[]; focusIdx: number; shown: string[] }) {
  const values = snapshots.map((s) => s.scores.overall);
  const best = bestIndices(values);
  return (
    <div className="rounded-2xl border border-line bg-bg p-4 shadow-1">
      <div className="eyebrow mb-3">Overall privacy score</div>
      <div className="flex flex-col gap-2.5">
        {snapshots.map((s, i) => (
          <div key={refOf(s)} className="flex items-center gap-2.5">
            <ProjectMark name={s.project.name} logoUrl={s.project.logoUrl} size={20} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium">
                  {s.project.name} <span className="text-xs font-normal text-muted">{s.version?.label}</span>
                </span>
                <span
                  className={cn(
                    "text-[15px] tabular",
                    best.includes(i) ? "font-semibold" : "font-medium text-fg-2",
                    best.includes(i) && i === focusIdx && "text-accent-fg",
                  )}
                >
                  <Pct value={values[i]} />
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface">
                <m.div
                  className={cn("h-full rounded-full", i === focusIdx ? "bg-accent" : "bg-fg-3/60")}
                  initial={{ width: 0 }}
                  animate={{ width: `${values[i] ?? 0}%` }}
                  transition={{ duration: 0.8, ease: easeOut, delay: i * 0.05 }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-line pt-3 text-xs">
        {suites
          .filter((s) => shown.includes(s.id))
          .map((su) => {
            const v = snapshots.map((s) => suiteScore(s, su.id));
            const b = bestIndices(v);
            return (
              <div key={su.id} className="flex justify-between gap-2 text-muted">
                {/* The suite's name stays whole; a long project name gives way. */}
                <span className="shrink-0">{su.shortName}</span>
                <span className="min-w-0 truncate text-right text-fg-2 tabular">{b.length ? snapshots[b[0]!]!.project.name : "—"}</span>
              </div>
            );
          })}
      </div>
    </div>
  );
});

const PivotRow = memo(function PivotRow({
  benchmarkId,
  title,
  question,
  snapshots,
  focusIdx,
  scores,
  onCell,
}: {
  benchmarkId: string;
  title: string;
  question: string;
  snapshots: ProjectSnapshot[];
  focusIdx: number;
  scores: { values: (number | null)[]; best: number[]; unverified: boolean[] };
  onCell: (benchmarkId: string, ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { values, best } = scores;
  const leader = best.length ? snapshots[best[0]!] : null;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-bg">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-3.5 py-3 text-left" aria-expanded={open}>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium">{title}</div>
          <div className="truncate text-xs text-muted">{question}</div>
        </div>
        {leader && (
          <span className="shrink-0 text-right">
            <span className="block text-[15px] font-semibold tabular">{fmtPct(values[best[0]!])}</span>
            <span className="block text-[11px] text-muted">{leader.project.name}</span>
          </span>
        )}
        <span className={cn("text-faint transition-transform duration-300 ease-out", open && "rotate-180")}>
          <ChevronDown className="size-4" />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <m.div
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            transition={{ duration: 0.3, ease: [0.65, 0, 0.35, 1] }}
            className="overflow-hidden"
          >
            <div className="flex flex-col border-t border-line px-3.5 py-1.5">
              {snapshots.map((s, i) => (
                <button type="button" key={refOf(s)} onClick={() => onCell(benchmarkId, refOf(s))} className="flex items-center gap-2.5 py-2 text-left">
                  <ProjectMark name={s.project.name} logoUrl={s.project.logoUrl} size={18} />
                  <span className="flex-1 truncate text-sm">{s.project.name}</span>
                  <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface">
                    <div
                      className={cn("h-full rounded-full", best.includes(i) ? (i === focusIdx ? "bg-accent" : "bg-fg-3") : "bg-line-strong")}
                      style={{ width: `${values[i] ?? 0}%` }}
                    />
                  </div>
                  <span
                    className={cn("w-14 text-right text-sm tabular", best.includes(i) ? "font-semibold" : "text-fg-3", scores.unverified[i] && "unverified")}
                  >
                    {fmtPct(values[i])}
                  </span>
                </button>
              ))}
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
});
