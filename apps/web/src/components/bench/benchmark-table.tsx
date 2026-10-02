import type { ProjectSnapshot } from "@pb/core";
import { type BenchmarkDef, getCriterion, type SuiteDef, suites } from "@pb/rubric";
import { ChevronDown, ChevronRight, Crosshair, X } from "lucide-react";
import { LayoutGroup, m } from "motion/react";
import { Fragment, memo, type ReactNode, useMemo, useState } from "react";
import { spring } from "@/design/motion";
import { cn, fmtPct } from "@/lib/utils";
import { bandTone } from "../ui/badges";
import { ProjectMark } from "../ui/project-mark";
import { Tip } from "../ui/tooltip";
import { benchmarkScore, bestIndices, type CellMarks, cellMarks, criterionScore, matchesRef, refOf, suiteScore } from "./model";

/** Callbacks must be stable (useCallback) for the memoized table and cells to skip re-rendering. */
export interface TableProps {
  snapshots: ProjectSnapshot[];
  focus: string | null;
  onFocus: (ref: string) => void;
  onRemove?: (ref: string) => void;
  onVersionChange?: (ref: string, version: string) => void;
  versionsBySlug?: Record<string, { version: string; label: string }[]>;
  open: Set<string>;
  onToggle: (benchmarkId: string) => void;
  onCell: (benchmarkId: string, ref: string) => void;
  heatmap?: boolean;
  suiteFilter?: string[];
}

const GROUP_W = 136;
const NAME_MIN = 232;
const COL_MIN = 118;

const bandBg: Record<string, string> = {
  strong: "bg-strong-bg",
  fair: "bg-fair-bg",
  weak: "bg-weak-bg",
  poor: "bg-poor-bg",
  neutral: "",
  accent: "",
};

type ScoreRow = { values: (number | null)[]; best: number[]; marks?: CellMarks[] };
const scoreRow = (values: (number | null)[], marks?: CellMarks[]): ScoreRow => ({ values, best: bestIndices(values), marks });

/** Every number in the table, computed once per set of snapshots rather than on each focus, heatmap or row toggle. */
function useScores(snapshots: ProjectSnapshot[]) {
  return useMemo(() => {
    const benchmarks = new Map<string, ScoreRow>();
    const bySuite = new Map<string, ScoreRow>();
    for (const su of suites) {
      bySuite.set(su.id, scoreRow(snapshots.map((s) => suiteScore(s, su.id))));
      for (const b of su.benchmarks)
        benchmarks.set(
          b.id,
          scoreRow(
            snapshots.map((s) => benchmarkScore(s, b.id)?.score ?? null),
            snapshots.map((s) => cellMarks(s, b.id)),
          ),
        );
    }
    return { benchmarks, suites: bySuite, overall: scoreRow(snapshots.map((s) => s.scores.overall)) };
  }, [snapshots]);
}

export const BenchmarkTable = memo(function BenchmarkTable(p: TableProps) {
  const n = p.snapshots.length;
  const focusIdx = p.snapshots.findIndex((s) => matchesRef(s, p.focus));
  const refs = useMemo(() => p.snapshots.map(refOf), [p.snapshots]);
  const scores = useScores(p.snapshots);
  // Keyed on the filter's contents: the array itself is new on every parent render.
  const filterKey = p.suiteFilter?.join(",") ?? "";
  const shown = useMemo(() => {
    const only = filterKey ? filterKey.split(",") : [];
    return suites.filter((s) => !only.length || only.includes(s.id));
  }, [filterKey]);
  const heat = !!p.heatmap;

  // Lay every cell out on explicit grid rows so the suite labels can span their rows
  // and the focus outline can be a single grid item spanning the whole column.
  const layout = useMemo(() => {
    let row = 2;
    const groups = shown.map((su) => {
      const start = row;
      const items = su.benchmarks.map((b) => {
        const r = row++;
        const crit = p.open.has(b.id) ? b.criteria.map((c) => ({ id: c.id, label: c.label, row: row++ })) : [];
        return { b, row: r, crit };
      });
      return { su, start, span: row - start, items };
    });
    const summaryStart = row;
    row += shown.length + 1;
    return { groups, summaryStart, total: row };
  }, [shown, p.open]);

  const cols = `${GROUP_W}px minmax(${NAME_MIN}px, 1.35fr) repeat(${n}, minmax(${COL_MIN}px, 1fr))`;
  const minW = GROUP_W + NAME_MIN + n * COL_MIN;
  const overallRow = layout.summaryStart + shown.length;

  return (
    // A single opacity fade for the whole table; cells render without per-cell animation.
    <div className="fade-in relative -mx-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6 lg:mx-0 lg:overflow-visible lg:px-0">
      <LayoutGroup id="bench">
        <div role="table" className="relative grid" style={{ gridTemplateColumns: cols, minWidth: minW }}>
          {/* focus column outline */}
          {focusIdx >= 0 && (
            <m.div
              layout
              layoutId="focus-outline"
              transition={spring}
              aria-hidden
              className="pointer-events-none z-10 rounded-[14px] border-[1.5px] border-accent"
              style={{ gridColumn: focusIdx + 3, gridRow: `1 / ${layout.total}` }}
            />
          )}

          {/* header */}
          <div className="sticky left-0 z-20 bg-bg lg:top-16" style={{ gridColumn: 1, gridRow: 1 }} />
          <div className="sticky z-20 flex items-end bg-bg pb-3 text-sm font-semibold text-fg lg:top-16" style={{ gridColumn: 2, gridRow: 1, left: GROUP_W }}>
            Benchmark
          </div>
          {p.snapshots.map((s, i) => (
            <HeaderCell
              key={refs[i]}
              s={s}
              col={i + 3}
              focused={i === focusIdx}
              versions={p.versionsBySlug?.[s.project.slug]}
              onFocus={p.onFocus}
              onRemove={p.onRemove}
              onVersionChange={p.onVersionChange}
            />
          ))}

          {/* benchmark groups */}
          {layout.groups.map((g) => (
            <Fragment key={g.su.id}>
              <SuiteLabel su={g.su} start={g.start} span={g.span} />
              {g.items.map(({ b, row, crit }, bi) => {
                const sc = scores.benchmarks.get(b.id)!;
                return (
                  <Fragment key={b.id}>
                    <BenchmarkLabel b={b} row={row} first={bi === 0} isOpen={p.open.has(b.id)} onToggle={p.onToggle} />
                    {p.snapshots.map((s, i) => (
                      <ValueCell
                        key={refs[i]}
                        col={i + 3}
                        row={row}
                        border={bi === 0 ? "strong" : "normal"}
                        value={sc.values[i] ?? null}
                        best={sc.best.includes(i)}
                        focusBest={sc.best.includes(i) && i === focusIdx}
                        heatmap={heat}
                        marks={sc.marks?.[i]}
                        benchmarkId={b.id}
                        cellRef={refs[i]}
                        onCell={p.onCell}
                        label={`${s.project.name} · ${b.name}`}
                      />
                    ))}
                    {crit.length > 0 && (
                      <CriteriaRows benchmarkId={b.id} crit={crit} snapshots={p.snapshots} refs={refs} onCell={p.onCell} bulk={p.open.size >= 10} />
                    )}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}

          {/* summary */}
          <div
            className="sticky left-0 z-[5] border-t-2 border-line-strong bg-bg pt-3.5 pr-3 text-[13px] font-medium text-fg"
            style={{ gridColumn: 1, gridRow: `${layout.summaryStart} / span ${shown.length + 1}` }}
          >
            Summary
            <div className="mt-0.5 text-xs font-normal text-muted">Suite scores</div>
          </div>
          {shown.map((su, k) => {
            const row = layout.summaryStart + k;
            const sc = scores.suites.get(su.id)!;
            return (
              <Fragment key={su.id}>
                <div
                  className={cn(
                    "sticky z-[5] flex items-center bg-bg pr-3 text-[15px] font-medium",
                    k === 0 ? "border-t-2 border-line-strong" : "border-t border-line",
                  )}
                  style={{ gridColumn: 2, gridRow: row, left: GROUP_W, minHeight: 48 }}
                >
                  {su.name}
                  <span className="ml-2 text-xs font-normal text-faint tabular">{su.weight}%</span>
                </div>
                {p.snapshots.map((s, i) => (
                  <ValueCell
                    key={refs[i]}
                    col={i + 3}
                    row={row}
                    border={k === 0 ? "double" : "normal"}
                    value={sc.values[i] ?? null}
                    best={sc.best.includes(i)}
                    focusBest={sc.best.includes(i) && i === focusIdx}
                    heatmap={heat}
                    label={`${s.project.name} · ${su.name}`}
                  />
                ))}
              </Fragment>
            );
          })}
          <div
            className="sticky z-[5] flex items-center border-t border-line-strong bg-bg pr-3 text-[15px] font-semibold"
            style={{ gridColumn: 2, gridRow: overallRow, left: GROUP_W, minHeight: 56 }}
          >
            Overall privacy score
          </div>
          {p.snapshots.map((s, i) => (
            <ValueCell
              key={refs[i]}
              col={i + 3}
              row={overallRow}
              border="strong"
              value={scores.overall.values[i] ?? null}
              best={scores.overall.best.includes(i)}
              focusBest={scores.overall.best.includes(i) && i === focusIdx}
              heatmap={heat}
              strong
              label={`${s.project.name} · Overall`}
            />
          ))}
          <div className="border-t border-line-strong" style={{ gridColumn: `1 / ${n + 3}`, gridRow: overallRow + 1 }} />
        </div>
      </LayoutGroup>
    </div>
  );
});

function getOptionLabel(criterionId: string, optionId: string | null) {
  if (!optionId) return "Unknown";
  return getCriterion(criterionId).options.find((o) => o.id === optionId)?.label ?? optionId;
}
const fmtPts = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

const SuiteLabel = memo(function SuiteLabel({ su, start, span }: { su: SuiteDef; start: number; span: number }) {
  return (
    <div
      className="sticky left-0 z-[5] border-t border-line-strong bg-bg pt-3.5 pr-3 text-[13px] leading-[18px] text-fg-3"
      style={{ gridColumn: 1, gridRow: `${start} / span ${span}` }}
    >
      <div className="font-medium text-fg">{su.shortName}</div>
      <div className="mt-0.5 text-xs text-muted">{su.tagline}</div>
    </div>
  );
});

const BenchmarkLabel = memo(function BenchmarkLabel({
  b,
  row,
  first,
  isOpen,
  onToggle,
}: {
  b: BenchmarkDef;
  row: number;
  first: boolean;
  isOpen: boolean;
  onToggle: (benchmarkId: string) => void;
}) {
  return (
    <div
      className={cn("group/row sticky z-[5] flex items-center gap-1.5 bg-bg pr-3", first ? "border-t border-line-strong" : "border-t border-line")}
      style={{ gridColumn: 2, gridRow: row, left: GROUP_W, minHeight: 52 }}
    >
      <button
        type="button"
        onClick={() => onToggle(b.id)}
        aria-expanded={isOpen}
        className="-ml-1.5 flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-left text-[15px] font-medium text-fg transition-colors hover:bg-surface"
      >
        <span className={cn("text-faint transition-transform duration-200 ease-out", isOpen && "rotate-90")}>
          <ChevronRight className="size-3.5" strokeWidth={2} />
        </span>
        <Tip content={b.question}>
          <span className="truncate">{b.name}</span>
        </Tip>
      </button>
    </div>
  );
});

/**
 * A benchmark's criteria, shown when its row is expanded. A row opened on its own fades in with CSS; when every
 * row opens at once (`bulk`, ~1,000 cells) they appear without the fade, which would cost ~80 ms of compositing.
 * Decided once at mount, so rows that are already open never replay it.
 */
const CriteriaRows = memo(function CriteriaRows({
  benchmarkId,
  crit,
  snapshots,
  refs,
  onCell,
  bulk,
}: {
  benchmarkId: string;
  crit: { id: string; label: string; row: number }[];
  snapshots: ProjectSnapshot[];
  refs: string[];
  onCell: (benchmarkId: string, ref: string) => void;
  bulk: boolean;
}) {
  const [fade] = useState(!bulk);
  return crit.map((c) => (
    <Fragment key={c.id}>
      <div
        className={cn("sticky z-[5] flex items-center border-t border-line-weak bg-bg py-2 pr-3 pl-6 text-[13px] text-muted", fade && "fade-in")}
        style={{ gridColumn: 2, gridRow: c.row, left: GROUP_W }}
      >
        {c.label}
      </div>
      {snapshots.map((s, i) => {
        const cs = criterionScore(s, c.id);
        const snap = s.criteria[c.id];
        return (
          <button
            type="button"
            key={refs[i]}
            onClick={() => onCell(benchmarkId, refs[i]!)}
            className={cn("flex flex-col items-center justify-center gap-0.5 border-t border-line-weak px-2 py-2 text-center", fade && "fade-in")}
            style={{ gridColumn: i + 3, gridRow: c.row }}
          >
            <span className={cn("line-clamp-2 text-[12px] leading-[15px] text-fg-3", snap?.flags.includes("unverified") && "unverified")}>
              {getOptionLabel(c.id, cs?.optionId ?? null)}
            </span>
            <span className="text-[11px] text-faint tabular">
              {cs ? (cs.status === "not_applicable" ? "N/A" : `${fmtPts(cs.points)} / ${cs.maxPoints}`) : "—"}
            </span>
          </button>
        );
      })}
    </Fragment>
  ));
});

const HeaderCell = memo(function HeaderCell({
  s,
  col,
  focused,
  versions = [],
  onFocus,
  onRemove,
  onVersionChange,
}: {
  s: ProjectSnapshot;
  col: number;
  focused: boolean;
  versions?: { version: string; label: string }[];
} & Pick<TableProps, "onFocus" | "onRemove" | "onVersionChange">) {
  const ref = refOf(s);
  return (
    <div
      className="group/h sticky z-20 flex flex-col items-center justify-end gap-1 bg-bg px-2 pt-3 pb-3 text-center lg:top-16"
      style={{ gridColumn: col, gridRow: 1 }}
    >
      <button
        type="button"
        onClick={() => onFocus(ref)}
        className="flex flex-col items-center gap-1.5 rounded-lg px-2 py-1 transition-colors hover:bg-surface"
        title="Compare from this project"
      >
        <ProjectMark name={s.project.name} logoUrl={s.project.logoUrl} size={22} />
        <span className="text-[15px] leading-[18px] font-medium text-fg">{s.project.name}</span>
      </button>
      {versions.length > 1 && onVersionChange ? (
        <label className="relative inline-flex items-center">
          <select
            value={s.version?.version ?? ""}
            onChange={(e) => onVersionChange(ref, e.target.value)}
            className="appearance-none rounded-md border border-line bg-bg-2 py-0.5 pr-5 pl-1.5 text-xs text-fg-3 hover:border-line-strong"
            aria-label={`${s.project.name} version`}
          >
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                {v.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1 size-3 text-muted" />
        </label>
      ) : (
        <span className="text-xs text-muted">{s.version?.label ?? " "}</span>
      )}
      <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 transition-opacity group-hover/h:opacity-100">
        {!focused && (
          <button type="button" onClick={() => onFocus(ref)} className="rounded p-1 text-faint hover:bg-surface hover:text-fg" aria-label="Set as focus">
            <Crosshair className="size-3" />
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={() => onRemove(ref)}
            className="rounded p-1 text-faint hover:bg-surface hover:text-fg"
            aria-label={`Remove ${s.project.name}`}
          >
            <X className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
});

/**
 * One score. Plain text (no animated number, no entrance animation, no will-change), memoized on primitive
 * props so a focus or heatmap change only re-renders the cells it affects.
 */
const ValueCell = memo(function ValueCell({
  col,
  row,
  value,
  best,
  focusBest,
  heatmap,
  marks,
  benchmarkId,
  cellRef,
  onCell,
  label,
  border,
  strong,
}: {
  col: number;
  row: number;
  value: number | null;
  best: boolean;
  focusBest: boolean;
  heatmap: boolean;
  marks?: CellMarks;
  benchmarkId?: string;
  cellRef?: string;
  onCell?: (benchmarkId: string, ref: string) => void;
  label: string;
  border: "normal" | "strong" | "double";
  strong?: boolean;
}) {
  const glyphs: ReactNode[] = [];
  if (marks?.adjusted)
    glyphs.push(
      <span key="a" title="Editor-adjusted">
        †
      </span>,
    );
  if (marks?.selfReported)
    glyphs.push(
      <span key="s" title="Rests on self-reported evidence">
        ‡
      </span>,
    );
  if (marks?.capped)
    glyphs.push(
      <span key="c" title="A cap or gate applied">
        ◆
      </span>,
    );
  const clickable = !!(onCell && benchmarkId && cellRef);
  const className = cn(
    "relative flex items-center justify-center px-1.5 py-1.5 outline-offset-[-2px]",
    border === "double" ? "border-t-2 border-line-strong" : border === "strong" ? "border-t border-line-strong" : "border-t border-line",
    clickable && "group/cell cursor-pointer",
  );
  const ariaLabel = `${label}: ${value === null ? "not evaluated" : fmtPct(value)}`;
  const content = (
    <>
      <span
        className={cn(
          "absolute inset-x-1 inset-y-1 rounded-[9px] transition-colors duration-300",
          focusBest ? "bg-accent-fill" : best ? "bg-best" : heatmap ? bandBg[bandTone(value)] : "",
          clickable && !best && "group-hover/cell:bg-surface",
        )}
      />
      <span
        className={cn(
          "relative text-base tabular",
          best || strong ? "font-semibold text-fg" : "font-medium text-fg-2",
          focusBest && "text-accent-fg",
          marks?.unverified ? "unverified" : "",
        )}
      >
        {fmtPct(value)}
      </span>
      {glyphs.length > 0 && <span className="relative ml-0.5 self-start pt-2 text-[10px] text-faint">{glyphs}</span>}
    </>
  );
  const style = { gridColumn: col, gridRow: row };
  if (!clickable)
    return (
      <div className={className} style={style}>
        <span className="sr-only">{label}: </span>
        {content}
      </div>
    );
  return (
    <button type="button" onClick={() => onCell?.(benchmarkId!, cellRef!)} aria-label={ariaLabel} className={className} style={style}>
      {content}
    </button>
  );
});

export function TableLegend({ release, rubricVersion }: { release?: { label: string; publishedAt: string; isDemo: boolean } | null; rubricVersion: string }) {
  return (
    <div className="mt-5 flex flex-col gap-3 text-[13px] text-muted md:flex-row md:items-start md:justify-between">
      <div>
        Methodology:{" "}
        <a href="/methodology" className="text-fg-3 underline decoration-line-strong underline-offset-4 hover:text-fg">
          {location.host}/methodology
        </a>{" "}
        · Rubric v{rubricVersion}
        {release?.label ? ` · Release ${release.label}` : ""}
        {release?.isDemo ? " · Demo data" : ""}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-3 rounded-[4px] bg-accent-fill ring-1 ring-accent/40" /> Best, focus project
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block size-3 rounded-[4px] bg-best ring-1 ring-line-strong" /> Best, another project
        </span>
        <span>
          <span className="unverified">85.0%</span> unverified criteria
        </span>
        <span>† editor-adjusted</span>
        <span>‡ self-reported</span>
        <span>◆ cap or gate applied</span>
        <span>— not evaluated</span>
      </div>
    </div>
  );
}
