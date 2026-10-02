import type { ProjectSnapshot } from "@pb/core";
import { getBenchmark, getCriterion, getSuite } from "@pb/rubric";
import { ChevronRight, MessageSquareWarning } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { easeInOut } from "@/design/motion";
import { cn, fmtPct } from "@/lib/utils";
import { Chip } from "../ui/badges";
import { EvidenceItem } from "./evidence";
import { benchmarkScore, RULE_TEXT } from "./model";

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** The worked arithmetic behind one benchmark cell, with rationale and evidence per criterion. */
export function CalcBreakdown({
  snapshot,
  benchmarkId,
  onSuggest,
}: {
  snapshot: ProjectSnapshot;
  benchmarkId: string;
  onSuggest?: (criterionId: string) => void;
}) {
  const b = getBenchmark(benchmarkId);
  const suite = getSuite(b.suite);
  const score = benchmarkScore(snapshot, benchmarkId);
  const [open, setOpen] = useState<string | null>(null);
  if (!score) return <div className="text-sm text-muted">Not evaluated.</div>;
  const counted = score.criteria.filter((c) => c.status !== "missing" && c.status !== "not_applicable" && c.status !== "not_researched");
  const sum = counted.reduce((s, c) => s + c.points, 0);
  const max = counted.reduce((s, c) => s + c.maxPoints, 0);
  const suiteScore = snapshot.scores.suites.find((s) => s.suiteId === b.suite)?.score ?? null;
  const contribution = score.score !== null ? (score.score * b.weight) / 100 : null;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-fg-3">
        {b.question} {b.description}
      </p>

      <div className="overflow-hidden rounded-xl border border-line">
        <div className="grid grid-cols-[1fr_auto] gap-x-3 border-b border-line bg-bg-2 px-3.5 py-2 text-xs font-medium text-muted">
          <span>Criterion · chosen option</span>
          <span className="text-right">Points</span>
        </div>
        {score.criteria.map((cs) => {
          const def = getCriterion(cs.criterionId);
          const snap = snapshot.criteria[cs.criterionId];
          const opt = def.options.find((o) => o.id === cs.optionId);
          const isOpen = open === cs.criterionId;
          return (
            <div key={cs.criterionId} className="border-b border-line-weak last:border-0">
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : cs.criterionId)}
                className="grid w-full grid-cols-[1fr_auto] items-start gap-x-3 px-3.5 py-2.5 text-left transition-colors hover:bg-bg-2"
                aria-expanded={isOpen}
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                    <motion.span animate={{ rotate: isOpen ? 90 : 0 }} className="text-faint">
                      <ChevronRight className="size-3" />
                    </motion.span>
                    {def.label}
                    {def.highImpact && <span className="text-[10px] font-semibold tracking-wide text-accent-fg uppercase">High impact</span>}
                  </span>
                  <span className={cn("mt-0.5 block pl-[18px] text-[13px] text-fg-3", snap?.flags.includes("unverified") && "unverified")}>
                    {cs.status === "not_applicable"
                      ? "Not applicable"
                      : cs.status === "missing"
                        ? "Not evaluated"
                        : cs.status === "not_researched"
                          ? "Not researched"
                          : cs.status === "unknown"
                            ? "Unknown (scored as the riskiest option)"
                            : (opt?.label ?? "Unknown")}
                    {cs.rules.includes("unknown_lowest") && <span className="text-muted"> · unknown → lowest option</span>}
                  </span>
                </span>
                <span className="pt-0.5 text-right font-mono text-[13px] text-fg tabular">
                  {cs.status === "not_applicable" || cs.status === "not_researched" ? "—" : `${fmt(cs.points)} / ${cs.maxPoints}`}
                  {cs.multiplier < 1 && <span className="block text-[11px] text-muted">×{cs.multiplier.toFixed(2)} verifiability</span>}
                  {cs.rules.includes("instant_upgrade_power") && (
                    <span className="block text-[11px] text-muted">
                      capped ({fmt(cs.rawPoints)} → {fmt(cs.points / cs.multiplier)})
                    </span>
                  )}
                </span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && snap && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3, ease: easeInOut }}
                    className="overflow-hidden"
                  >
                    <div className="flex flex-col gap-3 px-3.5 pt-1 pb-4 pl-[32px]">
                      <div className="text-[13px] leading-[1.5] text-fg-2">{snap.rationale}</div>
                      <div className="flex flex-wrap gap-1.5">
                        <Chip>Confidence: {snap.confidence}</Chip>
                        {snap.flags.map((f) => (
                          <Chip key={f} tone={f === "editor_adjusted" ? "accent" : f === "self_reported" || f === "unverified" ? "fair" : "neutral"}>
                            {f.replace(/_/g, " ")}
                          </Chip>
                        ))}
                      </div>
                      {snap.override && (
                        <div className="rounded-lg border border-accent-line bg-accent-soft px-3 py-2 text-[13px] text-accent-fg">
                          Editor-adjusted: {snap.override.reason}
                          {snap.override.originalOptionId &&
                            ` (the evaluator chose “${def.options.find((o) => o.id === snap.override?.originalOptionId)?.label ?? snap.override.originalOptionId}”)`}
                        </div>
                      )}
                      <div className="text-xs text-muted">Options: {def.options.map((o) => `${o.label} (${o.points})`).join(" · ")}</div>
                      {snap.searchLog?.searched.length ? (
                        <div className="rounded-lg border border-line bg-bg-2 px-3 py-2 text-[13px]">
                          <div className="font-medium">Not disclosed{snap.searchLog.codeChecked ? " · code checked" : ""}</div>
                          {snap.searchLog.note && <div className="mt-0.5 text-fg-2">{snap.searchLog.note}</div>}
                          <div className="mt-1 text-xs text-muted">Searched: {snap.searchLog.searched.slice(0, 8).join("; ")}</div>
                        </div>
                      ) : null}
                      {snap.evidence.length ? (
                        <div className="flex flex-col gap-2">
                          {snap.evidence.map((e) => (
                            <EvidenceItem key={e.id} e={e} snapshot={snapshot} />
                          ))}
                        </div>
                      ) : snap.searchLog?.searched.length ? null : (
                        <div className="text-[13px] text-muted">No quoted evidence recorded; this answer is shown as unverified.</div>
                      )}
                      {onSuggest && (
                        <button
                          type="button"
                          onClick={() => onSuggest(cs.criterionId)}
                          className="inline-flex items-center gap-1.5 self-start text-[13px] text-muted hover:text-fg"
                        >
                          <MessageSquareWarning className="size-3.5" /> Suggest a correction
                        </button>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border border-line bg-bg-2 p-3.5 font-mono text-[12.5px] leading-[1.9] text-fg-2">
        <div className="flex justify-between">
          <span>Sum of points</span>
          <span className="tabular">
            {fmt(sum)} / {max}
          </span>
        </div>
        <div className="flex justify-between">
          <span>Benchmark score</span>
          <span className="tabular">{fmtPct(score.uncapped)}</span>
        </div>
        {score.rules.map((r) => (
          <div key={r} className="text-muted">
            ◆ {RULE_TEXT[r] ?? r} → {fmtPct(score.score)}
          </div>
        ))}
        <div className="my-1 border-t border-dashed border-line-strong" />
        <div className="flex justify-between">
          <span>
            {b.name} weight in {suite.name}
          </span>
          <span className="tabular">{b.weight}%</span>
        </div>
        <div className="flex justify-between">
          <span>Contribution to suite</span>
          <span className="tabular">
            {fmtPct(score.score)} × {b.weight}% = {contribution === null ? "—" : contribution.toFixed(1)}
          </span>
        </div>
        <div className="flex justify-between">
          <span>{suite.name} score</span>
          <span className="tabular">{fmtPct(suiteScore)}</span>
        </div>
        <div className="flex justify-between font-semibold text-fg">
          <span>Suite weight in overall</span>
          <span className="tabular">{suite.weight}%</span>
        </div>
      </div>
      <a href={`/methodology#${b.id}`} className="text-[13px] text-muted underline decoration-line-strong underline-offset-4 hover:text-fg">
        See this benchmark in the methodology →
      </a>
    </div>
  );
}
