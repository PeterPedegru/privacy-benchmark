import type { LeaderboardRow } from "@pb/core";
import { benchmarks, getBenchmark, overallFromSuites, rubric, type SuiteId, suites } from "@pb/rubric";
import * as Slider from "@radix-ui/react-slider";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Info, RotateCcw } from "lucide-react";
import { AnimatePresence, LayoutGroup, m } from "motion/react";
import { useMemo } from "react";
import { PrivacyBadge, WalkawayBadge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { LoadError, Skeleton } from "@/components/ui/misc";
import { Pct } from "@/components/ui/number";
import { ProjectMark } from "@/components/ui/project-mark";
import { focusIn, spring } from "@/design/motion";
import { useLeaderboard } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { usePublishedWeighting } from "@/lib/weighting";

type Weights = Record<SuiteId, number>;

function parseWeights(w?: string): Weights | null {
  if (!w) return null;
  const nums = w.split(",").map(Number);
  if (nums.length !== suites.length || nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return Object.fromEntries(suites.map((s, i) => [s.id, nums[i]!])) as Weights;
}

export function RankingsPage() {
  const search = useSearch({ from: "/public/rankings" });
  const navigate = useNavigate({ from: "/rankings" });
  const lb = useLeaderboard();
  // The official view uses the weighting the published results were scored with (set by the community poll).
  const published = usePublishedWeighting();
  const official = (published.suites ?? (rubric.presets.find((p) => p.official)!.weights as Weights)) as Weights;
  const tab = search.tab ?? "overall";
  const preset = search.preset ?? (search.w ? "custom" : "balanced");
  const weights: Weights =
    preset === "custom"
      ? (parseWeights(search.w) ?? official)
      : preset === "balanced"
        ? official
        : ((rubric.presets.find((p) => p.id === preset)?.weights as Weights) ?? official);
  // For the URL: a weight as people would type it.
  const wParam = (w: Weights) => suites.map((x) => Math.round(w[x.id] * 10) / 10).join(",");
  const isOfficial = preset === "balanced";
  const set = (patch: Partial<typeof search>) => navigate({ search: (s) => ({ ...s, ...patch }), replace: true, resetScroll: false });

  const rows = useMemo(() => {
    const list = (lb.data?.rows ?? []).map((r) => {
      let value: number | null;
      // The official view is each result's own published score (scored with its own weighting); other views re-weight
      // the suite scores.
      if (tab === "overall" && isOfficial) value = r.overall;
      else if (tab === "overall")
        value = overallFromSuites(
          suites.map((s) => ({ suiteId: s.id, score: r.suites[s.id] ?? null })),
          weights,
        );
      else if (suites.some((s) => s.id === tab)) value = r.suites[tab] ?? null;
      else value = r.benchmarks[tab]?.score ?? null;
      return { r, value };
    });
    return list.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  }, [lb.data, tab, weights, isOfficial]);

  const title =
    tab === "overall" ? "Overall" : (suites.find((s) => s.id === tab)?.name ?? (benchmarks.some((b) => b.id === tab) ? getBenchmark(tab).name : "Overall"));
  const subtitle =
    tab === "overall"
      ? "Weighted across all seven suites"
      : (suites.find((s) => s.id === tab)?.tagline ?? (benchmarks.some((b) => b.id === tab) ? getBenchmark(tab).question : ""));

  return (
    <div className="mx-auto max-w-[var(--container-page)] px-4 pt-10 sm:px-6 md:pt-14">
      <m.div variants={focusIn} initial="hidden" animate="show" className="max-w-3xl">
        <div className="eyebrow mb-3">Rankings</div>
        <h1 className="text-[34px] leading-[1.12] font-semibold tracking-[-0.02em] text-balance md:text-5xl md:leading-[1.06]">
          Every suite, every benchmark. <span className="text-muted">Re-weight it and watch the order change.</span>
        </h1>
      </m.div>

      <div className="scrollbar-none -mx-4 mt-10 flex gap-1 overflow-x-auto border-b border-line px-4 sm:-mx-6 sm:px-6">
        {[{ id: "overall", name: "Overall" }, ...suites.map((s) => ({ id: s.id, name: s.shortName }))].map((t) => {
          const active = tab === t.id || (t.id !== "overall" && benchmarks.find((b) => b.id === tab)?.suite === t.id);
          return (
            <button
              type="button"
              key={t.id}
              onClick={() => set({ tab: t.id === "overall" ? undefined : t.id })}
              className={cn("relative shrink-0 px-3 pt-2 pb-3 text-sm transition-colors", active ? "text-fg" : "text-muted hover:text-fg")}
            >
              {t.name}
              {active && <m.span layoutId="rank-tab" transition={spring} className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
            </button>
          );
        })}
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-2xl font-semibold tracking-[-0.015em]">{title}</div>
              <div className="text-sm text-muted">{subtitle}</div>
            </div>
            {suites.some((s) => s.id === tab) && (
              <select
                value=""
                onChange={(e) => e.target.value && set({ tab: e.target.value })}
                className="h-8 rounded-lg border border-line bg-bg px-2 text-[13px] text-fg-3"
                aria-label="Benchmark"
              >
                <option value="">Drill into a benchmark…</option>
                {suites
                  .find((s) => s.id === tab)!
                  .benchmarks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
              </select>
            )}
          </div>
          {tab === "overall" && !isOfficial && (
            <div className="mb-3 flex items-center gap-2 rounded-xl border border-fair-bd bg-fair-bg px-3 py-2 text-[13px] text-fair-fg">
              <Info className="size-4 shrink-0" /> Custom view, not the official score. The official ranking uses the published weighting
              {published.ref ? ` (${published.ref.label})` : ""}.
            </div>
          )}
          <div className="overflow-hidden rounded-2xl border border-line">
            {lb.isLoading &&
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="border-b border-line p-4">
                  <Skeleton className="h-6" />
                </div>
              ))}
            {lb.isError && !lb.data && (
              <div className="p-4">
                <LoadError title="Couldn't load the rankings." busy={lb.isFetching} onRetry={() => void lb.refetch()} />
              </div>
            )}
            <LayoutGroup>
              <AnimatePresence initial={false}>
                {rows.map(({ r, value }, i) => (
                  <RankRow key={r.slug} r={r} i={i} value={value} top={rows[0]?.value ?? 100} />
                ))}
              </AnimatePresence>
            </LayoutGroup>
          </div>
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-2xl border border-line bg-bg-2 p-4">
            <div className="text-sm font-semibold">Weighting</div>
            <div className="mt-0.5 text-xs text-muted">Applies to the Overall tab.</div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {[...rubric.presets.map((p) => ({ id: p.id, name: p.name })), { id: "custom", name: "Custom" }].map((p) => (
                <button
                  type="button"
                  key={p.id}
                  onClick={() =>
                    set({
                      preset: p.id === "balanced" ? undefined : p.id,
                      w: p.id === "custom" ? wParam(weights) : undefined,
                      tab: undefined,
                    })
                  }
                  className={cn(
                    "h-7 rounded-lg border px-2.5 text-xs font-medium transition-colors",
                    preset === p.id ? "border-accent bg-accent-soft text-accent-fg" : "border-line bg-bg text-fg-3 hover:border-line-strong",
                  )}
                >
                  {p.id === "balanced" ? `Official${published.ref ? ` · ${published.ref.label}` : ""}` : p.name}
                </button>
              ))}
            </div>
            <div className="mt-4 flex flex-col gap-3.5">
              {suites.map((s) => {
                const total = suites.reduce((a, x) => a + weights[x.id], 0) || 1;
                return (
                  <div key={s.id}>
                    <div className="mb-1.5 flex justify-between text-xs">
                      <span className="text-fg-2">{s.name}</span>
                      <span className="text-muted tabular">{((weights[s.id] / total) * 100).toFixed(0)}%</span>
                    </div>
                    <Slider.Root
                      value={[weights[s.id]]}
                      min={0}
                      max={50}
                      step={1}
                      onValueChange={([v]) => set({ preset: "custom", tab: undefined, w: wParam({ ...weights, [s.id]: v ?? 0 }) })}
                      className="relative flex h-4 touch-none items-center select-none"
                      aria-label={`${s.name} weight`}
                    >
                      <Slider.Track className="relative h-1 grow rounded-full bg-surface-2">
                        <Slider.Range className="absolute h-full rounded-full bg-accent" />
                      </Slider.Track>
                      <Slider.Thumb className="block size-3.5 rounded-full border border-line-strong bg-bg shadow-3 outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]" />
                    </Slider.Root>
                  </div>
                );
              })}
            </div>
            {!isOfficial && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-4"
                icon={<RotateCcw className="size-3.5" />}
                onClick={() => set({ preset: undefined, w: undefined })}
              >
                Reset to official
              </Button>
            )}
          </div>
          <p className="mt-3 px-1 text-xs leading-5 text-muted">
            Weights are a judgment call. The official ranking uses the published weighting, which a public poll sets before each run;{" "}
            <Link to="/weighting" className="underline decoration-line-strong underline-offset-4">
              vote on the next one
            </Link>
            .
          </p>
        </aside>
      </div>
    </div>
  );
}

function RankRow({ r, i, value, top }: { r: LeaderboardRow; i: number; value: number | null; top: number | null }) {
  return (
    <m.div
      layout
      transition={spring}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="border-b border-line bg-bg last:border-0"
    >
      <Link
        to="/projects/$slug"
        params={{ slug: r.slug }}
        className="grid grid-cols-[28px_1fr_auto] items-center gap-3 px-4 py-3.5 transition-colors hover:bg-bg-2 md:grid-cols-[36px_minmax(130px,1fr)_minmax(190px,1.2fr)_minmax(90px,1fr)_80px]"
      >
        <span className="text-sm text-muted tabular">{i + 1}</span>
        <span className="flex min-w-0 items-center gap-2.5">
          <ProjectMark name={r.name} logoUrl={r.logoUrl} size={24} />
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold">{r.name}</span>
            <span className="block truncate text-xs text-muted">{r.version?.label ?? ""}</span>
          </span>
        </span>
        <span className="col-span-3 flex flex-wrap gap-1.5 md:col-span-1">
          <PrivacyBadge level={r.level} tier={r.trustTier} compact />
          <WalkawayBadge walkaway={r.walkaway} compact />
        </span>
        <span className="col-span-3 hidden md:col-span-1 md:block">
          <span className="block h-1.5 overflow-hidden rounded-full bg-surface">
            <m.span className="block h-full rounded-full bg-accent" initial={false} animate={{ width: `${value ?? 0}%` }} transition={spring} />
          </span>
        </span>
        <span
          className={cn(
            "col-start-3 row-start-1 text-right text-lg font-semibold tracking-[-0.01em] tabular md:col-start-auto md:row-start-auto",
            value === top && "text-accent-fg",
          )}
        >
          <Pct value={value} />
        </span>
      </Link>
    </m.div>
  );
}
