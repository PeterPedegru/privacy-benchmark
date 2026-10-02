import type { ProjectSnapshot } from "@pb/core";
import { getBenchmark, rubric, suites } from "@pb/rubric";
import * as Popover from "@radix-ui/react-popover";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Check, ChevronsDownUp, ChevronsUpDown, Flame, Image, Link2, SlidersHorizontal } from "lucide-react";
import { m } from "motion/react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { BenchmarkTable, TableLegend } from "@/components/bench/benchmark-table";
import { CalcBreakdown } from "@/components/bench/calc-breakdown";
import { matchesRef, refOf } from "@/components/bench/model";
import { BenchmarkPivot } from "@/components/bench/pivot";
import { ProjectPicker } from "@/components/bench/project-picker";
import { SuggestCorrection } from "@/components/bench/suggest";
import { Button, ButtonLink } from "@/components/ui/button";
import { Empty, LoadError, Skeleton } from "@/components/ui/misc";
import { Pct } from "@/components/ui/number";
import { Sheet, useIsMobile } from "@/components/ui/sheet";
import { focusIn } from "@/design/motion";
import { defaultRefs, useCompare, useLeaderboard, useMeta, useProject } from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { BenchSearch } from "@/router";

function SuiteFilter({ value, onChange }: { value?: string[]; onChange: (next: string[]) => void }) {
  const on = (id: string) => !value?.length || value.includes(id);
  const count = value?.length ? value.length : suites.length;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button size="sm" variant="ghost" icon={<SlidersHorizontal className="size-3.5" />}>
          Suites{" "}
          <span className="text-faint tabular">
            {count}/{suites.length}
          </span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-50 w-64 rounded-xl border border-line bg-bg p-1.5 shadow-5">
          {suites.map((s) => (
            <button
              type="button"
              key={s.id}
              onClick={() => {
                const cur = value?.length ? value : suites.map((x) => x.id);
                onChange(on(s.id) ? cur.filter((x) => x !== s.id) : [...cur, s.id]);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface"
            >
              <span
                className={cn(
                  "flex size-4 items-center justify-center rounded-[4px] border",
                  on(s.id) ? "border-accent bg-accent text-white" : "border-line-strong",
                )}
              >
                {on(s.id) && <Check className="size-3" strokeWidth={3} />}
              </span>
              <span className="flex-1">{s.name}</span>
              <span className="text-xs text-faint tabular">{s.weight}%</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => onChange(suites.map((x) => x.id))}
            className="mt-1 w-full rounded-lg border-t border-line px-2 pt-2 pb-1 text-left text-xs text-muted hover:text-fg"
          >
            Show all suites
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function BenchmarksPage() {
  const search = useSearch({ from: "/public/benchmarks" });
  const navigate = useNavigate({ from: "/benchmarks" });
  const lb = useLeaderboard();
  const meta = useMeta();
  const mobile = useIsMobile();

  // Same default columns as the route loader, so the compare request it started is the one used here.
  const refsKey = search.p ?? defaultRefs(lb.data).join(",");
  const refs = useMemo(() => refsKey.split(",").filter(Boolean), [refsKey]);
  const cmp = useCompare(refs);
  const snaps = useMemo(() => cmp.data?.snapshots ?? [], [cmp.data]);
  const focus = search.focus ?? refs[0] ?? null;
  // Everything handed to the table is memoized or a stable callback, so opening a cell's breakdown (or any other
  // page-level state change) doesn't re-render the table.
  const open = useMemo(() => new Set((search.open ?? "").split(",").filter(Boolean)), [search.open]);
  const suiteFilter = useMemo(() => search.suites?.split(",").filter(Boolean), [search.suites]);
  const [cell, setCell] = useState<{ benchmarkId: string; ref: string } | null>(null);
  const [suggest, setSuggest] = useState<{ slug: string; criterionId: string | null } | null>(null);

  const versionsBySlug = useMemo(() => {
    const out: Record<string, { version: string; label: string }[]> = {};
    for (const r of lb.data?.rows ?? []) {
      const cur = r.version ? [{ version: r.version.version, label: r.version.label }] : [];
      out[r.slug] = [...cur, ...r.otherVersions];
    }
    return out;
  }, [lb.data]);

  const set = useCallback((patch: Partial<BenchSearch>) => navigate({ search: (s) => ({ ...s, ...patch }), replace: true, resetScroll: false }), [navigate]);
  const setRefs = useCallback(
    (next: string[]) =>
      set({ p: next.join(",") || undefined, focus: next.some((r) => r === focus || r.split("@")[0] === focus) ? (focus ?? undefined) : next[0] }),
    [set, focus],
  );
  const toggleRow = useCallback(
    (id: string) =>
      navigate({
        search: (s) => {
          const n = new Set((s.open ?? "").split(",").filter(Boolean));
          n.has(id) ? n.delete(id) : n.add(id);
          return { ...s, open: [...n].join(",") || undefined };
        },
        replace: true,
        resetScroll: false,
      }),
    [navigate],
  );
  const onFocus = useCallback((ref: string) => set({ focus: ref }), [set]);
  const onCell = useCallback((benchmarkId: string, ref: string) => setCell({ benchmarkId, ref }), []);
  const onRemove = useCallback((ref: string) => setRefs(refs.filter((r) => !matchesRef(snaps.find((s) => refOf(s) === ref)!, r))), [setRefs, refs, snaps]);
  const onVersionChange = useCallback(
    (ref: string, version: string) => setRefs(refs.map((r) => (matchesRef(snaps.find((s) => refOf(s) === ref)!, r) ? `${r.split("@")[0]}@${version}` : r))),
    [setRefs, refs, snaps],
  );
  const allOpen = open.size >= 10;
  const cellSnap = cell ? snaps.find((s) => matchesRef(s, cell.ref)) : null;

  const copyLink = async () => {
    const url = new URL(location.href);
    url.searchParams.set("p", refs.join(","));
    if (focus) url.searchParams.set("focus", focus);
    try {
      await navigator.clipboard.writeText(url.toString());
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  const focusSnap = snaps.find((s) => matchesRef(s, focus));

  return (
    <div className="mx-auto max-w-[var(--container-wide)] px-4 pt-10 sm:px-6 md:pt-14">
      <m.div variants={focusIn} initial="hidden" animate="show" className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div className="max-w-2xl">
          <div className="eyebrow mb-3">Benchmark table{meta.data?.release ? ` · Release ${meta.data.release.label}` : ""}</div>
          <h1 className="text-[34px] leading-[1.12] font-semibold tracking-[-0.02em] text-balance md:text-5xl md:leading-[1.06]">
            Compare privacy systems. <span className="text-muted">Every cell is a sourced, checkable calculation.</span>
          </h1>
        </div>
        {focusSnap && (
          <div className="flex items-center gap-4 rounded-2xl border border-line bg-bg-2 px-4 py-3">
            <div>
              <div className="text-xs text-muted">Focus · {focusSnap.project.name}</div>
              <div className="text-2xl font-semibold tracking-[-0.02em] tabular">
                <Pct value={focusSnap.scores.overall} />
              </div>
            </div>
            <div className="h-10 w-px bg-line" />
            <div className="text-xs leading-5 text-muted">
              Level <span className="font-semibold text-fg">{focusSnap.scores.level ?? "—"}</span>
              <br />
              Tier <span className="font-semibold text-fg">{focusSnap.scores.trustTier ?? "—"}</span> · Walkaway{" "}
              <span className="font-semibold text-fg">
                {focusSnap.scores.walkaway.passed === null ? "—" : focusSnap.scores.walkaway.passed ? "pass" : "fail"}
              </span>
            </div>
          </div>
        )}
      </m.div>

      <div className="sticky top-16 z-20 -mx-4 mt-8 flex flex-col gap-3 border-y border-line bg-bg/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:border-x-0 lg:bg-transparent lg:px-0 lg:backdrop-blur-none md:flex-row md:items-center md:justify-between">
        <ProjectPicker rows={lb.data?.rows ?? []} selected={refs} onChange={setRefs} />
        <div className="flex flex-wrap items-center gap-1.5">
          <SuiteFilter value={suiteFilter} onChange={(next) => set({ suites: next.length === suites.length || !next.length ? undefined : next.join(",") })} />
          {!mobile && (
            <>
              <Button
                size="sm"
                variant={search.heat ? "accent" : "ghost"}
                icon={<Flame className="size-3.5" />}
                onClick={() => set({ heat: search.heat ? undefined : true })}
              >
                Heatmap
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={allOpen ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
                onClick={() => set({ open: allOpen ? undefined : suites.flatMap((s) => s.benchmarks.map((b) => b.id)).join(",") })}
              >
                {allOpen ? "Collapse" : "Criteria"}
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" icon={<Link2 className="size-3.5" />} onClick={copyLink}>
            Link
          </Button>
          <ButtonLink
            size="sm"
            variant="primary"
            to="/cards"
            // A card holds five projects: the focused one, then the rest in table order.
            search={{ p: (focus ? [focus, ...refs.filter((r) => r !== focus)] : refs).slice(0, 5).join(","), focus: focus ?? undefined }}
            icon={<Image className="size-3.5" />}
          >
            Make a card
          </ButtonLink>
        </div>
      </div>

      <div className="mt-6">
        {lb.isLoading || (cmp.isLoading && !snaps.length) ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : !snaps.length && ((lb.isError && !lb.data) || cmp.isError) ? (
          <LoadError
            title="Couldn't load the benchmark table."
            busy={lb.isFetching || cmp.isFetching}
            onRetry={() => {
              if (lb.isError) void lb.refetch();
              if (cmp.isError) void cmp.refetch();
            }}
          />
        ) : !snaps.length ? (
          <Empty title="Nothing to compare yet">Add projects above, or publish a release from the admin dashboard.</Empty>
        ) : mobile ? (
          <BenchmarkPivot snapshots={snaps} focus={focus} onCell={onCell} suiteFilter={suiteFilter} />
        ) : (
          <BenchmarkTable
            snapshots={snaps}
            focus={focus}
            onFocus={onFocus}
            onRemove={refs.length > 1 ? onRemove : undefined}
            onVersionChange={onVersionChange}
            versionsBySlug={versionsBySlug}
            open={open}
            onToggle={toggleRow}
            onCell={onCell}
            heatmap={search.heat}
            suiteFilter={suiteFilter}
          />
        )}
        <TableLegend release={cmp.data?.release ?? null} rubricVersion={meta.data?.rubricVersion ?? rubric.version} />
      </div>

      <Sheet
        open={!!cell && !!cellSnap}
        onOpenChange={(o) => !o && setCell(null)}
        title={cell ? `${getBenchmark(cell.benchmarkId).name} · ${cellSnap?.project.name ?? ""}` : ""}
        subtitle={cellSnap ? `How this number was calculated${cellSnap.version ? ` · ${cellSnap.version.label}` : ""}` : undefined}
      >
        {cell && cellSnap && (
          <CellBreakdown
            snapshot={cellSnap}
            benchmarkId={cell.benchmarkId}
            onSuggest={(criterionId) => setSuggest({ slug: cellSnap.project.slug, criterionId })}
          />
        )}
      </Sheet>
      {suggest && (
        <SuggestCorrection open={!!suggest} onOpenChange={(o) => !o && setSuggest(null)} projectSlug={suggest.slug} criterionId={suggest.criterionId} />
      )}
    </div>
  );
}

/** The table's snapshots carry no evidence; the breakdown shows the full published result for that version. */
function CellBreakdown({ snapshot, benchmarkId, onSuggest }: { snapshot: ProjectSnapshot; benchmarkId: string; onSuggest: (criterionId: string) => void }) {
  const full = useProject(snapshot.project.slug, snapshot.version?.version);
  const snap = full.data?.snapshot;
  if (!snap || refOf(snap) !== refOf(snapshot)) {
    return full.isError ? (
      <Empty title="Couldn't load the evidence">Close this panel and try again.</Empty>
    ) : (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  return <CalcBreakdown snapshot={snap} benchmarkId={benchmarkId} onSuggest={onSuggest} />;
}
