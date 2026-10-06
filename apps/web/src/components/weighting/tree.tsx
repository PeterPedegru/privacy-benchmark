import { adjustableOptions, bestOption, getBenchmark, getCriterion, lowestOption, MIN_CRITERION_WEIGHT, suites, type WeightingShares } from "@pb/rubric";
import * as Slider from "@radix-ui/react-slider";
import { ChevronRight, Lock, RotateCcw } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { type ReactNode, useState } from "react";
import { easeInOut } from "@/design/motion";
import { cn, fmtNum } from "@/lib/utils";
import { fmtWeight } from "@/lib/weighting";
import { BENCHMARK_GROUPS, CRITERION_GROUPS, type Draft, groupChanged, normalize, resetGroup, SUITE_GROUP } from "./draft";

/**
 * Every weight of a weighting as a tree: suites, then a suite's benchmarks, then a benchmark's criteria and the credit
 * of their in-between answers. Editable (the vote page: a slider per weight, each group renormalizing as you move
 * one) or read-only (a weighting's page: its values against its base).
 */
export function WeightTree({ base, draft, onChange }: { base: WeightingShares; draft: Draft; onChange?: (d: Draft) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const suiteShares = normalize(draft.suites, SUITE_GROUP);
  const suitesChanged = groupChanged(draft.suites, base.suites, SUITE_GROUP);
  return (
    <div className="overflow-hidden rounded-2xl border border-line">
      <GroupHeader
        title="Suites"
        hint="How much each suite counts in the overall score"
        changed={suitesChanged}
        onReset={onChange ? () => onChange(resetGroup(draft, base, "suites", SUITE_GROUP)) : undefined}
      />
      {suites.map((s) => {
        const ids = BENCHMARK_GROUPS[s.id]!;
        const isOpen = open.has(s.id);
        const inner = groupChanged(draft.benchmarks, base.benchmarks, ids) || ids.some((b) => subtreeChanged(draft, base, b));
        return (
          <div key={s.id} className="border-t border-line first:border-0">
            <WeightRow
              depth={0}
              label={s.name}
              sub={s.tagline}
              value={draft.suites[s.id]!}
              share={suiteShares[s.id]!}
              baseShare={base.suites[s.id]!}
              onValue={onChange ? (v) => onChange({ ...draft, suites: { ...draft.suites, [s.id]: v } }) : undefined}
              expand={{ open: isOpen, onToggle: () => toggle(s.id), label: `${ids.length} benchmarks`, changed: inner }}
            />
            <Collapse open={isOpen}>
              <BenchmarkGroup suiteId={s.id} base={base} draft={draft} onChange={onChange} open={open} toggle={toggle} />
            </Collapse>
          </div>
        );
      })}
    </div>
  );
}

function subtreeChanged(d: Draft, base: WeightingShares, benchmarkId: string): boolean {
  const ids = CRITERION_GROUPS[benchmarkId]!;
  return (
    groupChanged(d.criteria, base.criteria, ids) ||
    ids.some((c) => Object.entries(d.credits[c] ?? {}).some(([o, v]) => Math.abs(v - base.credits[c]![o]!) > 0.05))
  );
}

function BenchmarkGroup({
  suiteId,
  base,
  draft,
  onChange,
  open,
  toggle,
}: {
  suiteId: string;
  base: WeightingShares;
  draft: Draft;
  onChange?: (d: Draft) => void;
  open: Set<string>;
  toggle: (id: string) => void;
}) {
  const ids = BENCHMARK_GROUPS[suiteId]!;
  const shares = normalize(draft.benchmarks, ids);
  return (
    <div className="border-t border-line-weak bg-bg-2/60">
      <GroupHeader
        depth={1}
        title="Benchmarks"
        hint="Share of the suite"
        changed={groupChanged(draft.benchmarks, base.benchmarks, ids)}
        onReset={onChange ? () => onChange(resetGroup(draft, base, "benchmarks", ids)) : undefined}
      />
      {ids.map((id) => {
        const b = getBenchmark(id);
        const isOpen = open.has(id);
        return (
          <div key={id} className="border-t border-line-weak">
            <WeightRow
              depth={1}
              label={b.name}
              sub={b.question}
              value={draft.benchmarks[id]!}
              share={shares[id]!}
              baseShare={base.benchmarks[id]!}
              onValue={onChange ? (v) => onChange({ ...draft, benchmarks: { ...draft.benchmarks, [id]: v } }) : undefined}
              expand={{ open: isOpen, onToggle: () => toggle(id), label: `${b.criteria.length} criteria`, changed: subtreeChanged(draft, base, id) }}
            />
            <Collapse open={isOpen}>
              <CriterionGroup benchmarkId={id} base={base} draft={draft} onChange={onChange} />
            </Collapse>
          </div>
        );
      })}
    </div>
  );
}

function CriterionGroup({ benchmarkId, base, draft, onChange }: { benchmarkId: string; base: WeightingShares; draft: Draft; onChange?: (d: Draft) => void }) {
  const ids = CRITERION_GROUPS[benchmarkId]!;
  const shares = normalize(draft.criteria, ids);
  return (
    <div className="border-t border-line-weak bg-bg-2">
      <GroupHeader
        depth={2}
        title="Criteria"
        hint="Share of the benchmark, and credit for answers in between"
        changed={groupChanged(draft.criteria, base.criteria, ids)}
        onReset={onChange ? () => onChange(resetGroup(draft, base, "criteria", ids)) : undefined}
      />
      {ids.map((id) => {
        const c = getCriterion(id);
        const mids = adjustableOptions(c);
        const creditsChanged = mids.some((o) => Math.abs((draft.credits[id]?.[o.id] ?? 0) - base.credits[id]![o.id]!) > 0.05);
        return (
          <div key={id} className="border-t border-line-weak">
            <WeightRow
              depth={2}
              label={c.label}
              sub={c.question}
              value={draft.criteria[id]!}
              share={shares[id]!}
              baseShare={base.criteria[id]!}
              // A criterion always counts a little: dropping one is a rubric change, not a weighting.
              min={MIN_CRITERION_WEIGHT}
              onValue={onChange ? (v) => onChange({ ...draft, criteria: { ...draft.criteria, [id]: v } }) : undefined}
            />
            <div className="pb-3 pl-[4.25rem] pr-4 sm:pl-[5.25rem]">
              <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-faint">
                <span>Credit for each answer</span>
                {creditsChanged && onChange && (
                  <button type="button" onClick={() => onChange(resetGroup(draft, base, "credits", [id]))} className="text-muted hover:text-fg">
                    Reset credits
                  </button>
                )}
              </div>
              <div className="mt-1 flex flex-col gap-1">
                {c.options.map((o) => {
                  const locked = o.id === bestOption(c).id || o.id === lowestOption(c).id;
                  if (locked)
                    return (
                      <div key={o.id} className="flex items-center gap-3 text-[13px]">
                        <span className="min-w-0 flex-1 text-fg-3">{o.label}</span>
                        <span className="inline-flex items-center gap-1 text-xs text-faint tabular" title="Fixed in every weighting">
                          <Lock className="size-3" />
                          {o.id === bestOption(c).id ? "100%" : "0%"}
                        </span>
                      </div>
                    );
                  const v = draft.credits[id]?.[o.id] ?? base.credits[id]![o.id]!;
                  return (
                    <div
                      key={o.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-[13px] sm:grid-cols-[minmax(0,1fr)_minmax(120px,180px)_auto]"
                    >
                      <span className="min-w-0 text-fg-2">{o.label}</span>
                      {onChange && (
                        <WeightSlider
                          className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto"
                          value={v}
                          label={`Credit for "${o.label}" (${c.label})`}
                          onValue={(x) => onChange({ ...draft, credits: { ...draft.credits, [id]: { ...draft.credits[id], [o.id]: x } } })}
                        />
                      )}
                      <Value value={v} base={base.credits[id]![o.id]!} />
                    </div>
                  );
                })}
                {!mids.length && <div className="text-xs text-faint">A yes/no criterion: only its weight can change.</div>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GroupHeader({ title, hint, changed, onReset, depth = 0 }: { title: string; hint: string; changed: boolean; onReset?: () => void; depth?: number }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 py-2 pr-4 text-xs",
        depth === 0 ? "bg-bg-2 pl-4" : depth === 1 ? "pl-8 sm:pl-10" : "pl-12 sm:pl-16",
      )}
    >
      <span>
        <span className="font-semibold text-fg-3">{title}</span> <span className="text-muted">· {hint}</span>
      </span>
      {changed && onReset && (
        <button type="button" onClick={onReset} className="inline-flex items-center gap-1 text-muted hover:text-fg">
          <RotateCcw className="size-3" /> Reset
        </button>
      )}
    </div>
  );
}

function WeightRow({
  depth,
  label,
  sub,
  value,
  share,
  baseShare,
  onValue,
  expand,
  min = 0,
}: {
  depth: number;
  label: string;
  sub?: string;
  value: number;
  share: number;
  baseShare: number;
  min?: number;
  onValue?: (v: number) => void;
  expand?: { open: boolean; onToggle: () => void; label: string; changed: boolean };
}) {
  const pad = depth === 0 ? "pl-4" : depth === 1 ? "pl-8 sm:pl-10" : "pl-12 sm:pl-16";
  return (
    <div
      className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-3 pr-4 md:grid-cols-[minmax(0,1fr)_minmax(160px,240px)_auto]", pad)}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          {expand ? (
            <button
              type="button"
              onClick={expand.onToggle}
              aria-expanded={expand.open}
              className="flex min-w-0 items-center gap-1.5 text-left text-[14px] font-medium text-fg hover:text-accent-fg"
            >
              <ChevronRight className={cn("size-3.5 shrink-0 text-muted transition-transform duration-200", expand.open && "rotate-90")} />
              <span className="truncate">{label}</span>
            </button>
          ) : (
            <span className="truncate pl-5 text-[14px] text-fg">{label}</span>
          )}
          {expand?.changed && <span className="size-1.5 shrink-0 rounded-full bg-accent" title="Changed inside" />}
        </div>
        {sub && <div className="mt-0.5 line-clamp-2 pl-5 text-xs text-muted md:line-clamp-1">{sub}</div>}
        {expand && (
          <button type="button" onClick={expand.onToggle} className="mt-0.5 pl-5 text-[11px] text-faint hover:text-fg">
            {expand.open ? "Hide" : "Show"} {expand.label}
          </button>
        )}
      </div>
      {onValue && (
        <WeightSlider className="col-span-2 row-start-2 md:col-span-1 md:row-start-auto" value={value} min={min} label={`${label} weight`} onValue={onValue} />
      )}
      <Value value={share} base={baseShare} />
    </div>
  );
}

function Value({ value, base }: { value: number; base: number }) {
  const d = value - base;
  return (
    <span className="flex min-w-[92px] items-baseline justify-end gap-1.5 text-right tabular">
      {Math.abs(d) > 0.05 && (
        <span className={cn("text-[11px] font-medium", d > 0 ? "text-strong-fg" : "text-poor-fg")}>{`${d > 0 ? "+" : "−"}${fmtNum(Math.abs(d), 1)}`}</span>
      )}
      <span className={cn("text-[14px] font-semibold", Math.abs(d) > 0.05 ? "text-fg" : "text-fg-3")}>{fmtWeight(value)}</span>
    </span>
  );
}

function WeightSlider({
  value,
  onValue,
  label,
  className,
  min = 0,
}: {
  value: number;
  onValue: (v: number) => void;
  label: string;
  className?: string;
  min?: number;
}) {
  return (
    <Slider.Root
      value={[Math.max(min, value)]}
      min={min}
      max={100}
      step={1}
      onValueChange={([v]) => onValue(v ?? 0)}
      className={cn("relative flex h-5 touch-none items-center select-none", className)}
    >
      <Slider.Track className="relative h-1 grow rounded-full bg-surface-2">
        <Slider.Range className="absolute h-full rounded-full bg-accent" />
      </Slider.Track>
      {/* The thumb is the control a screen reader announces, so it carries the name. */}
      <Slider.Thumb
        aria-label={label}
        className="block size-4 rounded-full border border-line-strong bg-bg shadow-3 outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]"
      />
    </Slider.Root>
  );
}

function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <m.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.25, ease: easeInOut }}
          className="overflow-hidden"
        >
          {children}
        </m.div>
      )}
    </AnimatePresence>
  );
}
