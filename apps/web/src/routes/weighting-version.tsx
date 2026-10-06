import type { WeightingChange } from "@pb/core";
import { DEFAULT_WEIGHTING, resolveWeighting, sharesOf } from "@pb/rubric";
import { Link, useParams } from "@tanstack/react-router";
import { m } from "motion/react";
import { useMemo } from "react";
import { Chip } from "@/components/ui/badges";
import { Empty, LoadError, Skeleton } from "@/components/ui/misc";
import { draftFrom } from "@/components/weighting/draft";
import { WeightTree } from "@/components/weighting/tree";
import { focusIn } from "@/design/motion";
import { isNotFound } from "@/lib/api";
import { useWeighting } from "@/lib/queries";
import { cn, fmtDate, fmtNum } from "@/lib/utils";
import { fmtWeight } from "@/lib/weighting";

const KIND_LABEL: Record<WeightingChange["kind"], string> = { suite: "Suite", benchmark: "Benchmark", criterion: "Criterion", credit: "Answer credit" };

/** One weighting version: where it came from, what it changed, its poll's turnout, and every number in it. */
export function WeightingVersionPage() {
  const { ref } = useParams({ from: "/public/weighting/$ref" });
  const q = useWeighting(ref);
  const base = useWeighting(q.data?.base?.label ?? "", { enabled: !!q.data?.base });
  const config = useMemo(() => resolveWeighting(q.data?.config ?? DEFAULT_WEIGHTING), [q.data]);
  const baseShares = useMemo(() => sharesOf(resolveWeighting(base.data?.config ?? q.data?.config ?? DEFAULT_WEIGHTING)), [base.data, q.data]);
  const draft = useMemo(() => draftFrom(sharesOf(config)), [config]);

  if (q.isLoading) return <Skeleton className="mx-auto mt-14 h-40 max-w-[var(--container-page)]" />;
  if (!q.data)
    return (
      <div className="mx-auto max-w-[var(--container-page)] px-4 pt-14 sm:px-6">
        {isNotFound(q.error) ? (
          <Empty title="No such weighting">
            See every version on the{" "}
            <Link to="/weighting" className="underline">
              weighting page
            </Link>
            .
          </Empty>
        ) : (
          <LoadError title="Couldn't load this weighting." busy={q.isFetching} onRetry={() => void q.refetch()} />
        )}
      </div>
    );
  const w = q.data;
  const stats = w.pollStats;
  const days = Object.entries(stats?.perDay ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const peak = Math.max(1, ...days.map(([, n]) => n));
  return (
    <div className="mx-auto max-w-[var(--container-page)] px-4 pt-10 pb-20 sm:px-6 md:pt-14">
      <m.div variants={focusIn} initial="hidden" animate="show" className="max-w-3xl">
        <div className="eyebrow mb-3">
          <Link to="/weighting" className="hover:text-fg">
            Community weighting
          </Link>{" "}
          / {w.label}
        </div>
        <h1 className="text-[34px] leading-[1.12] font-semibold tracking-[-0.02em] text-balance md:text-5xl md:leading-[1.06]">
          {w.label}. <span className="text-muted">{w.title}</span>
        </h1>
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {w.current && <Chip tone="accent">current: new runs use it</Chip>}
          {w.retired && <Chip>retired: no longer used for new runs</Chip>}
          <Chip>{w.source === "poll" ? "Community poll result" : "The rubric's own weights"}</Chip>
          <Chip>Rubric v{w.rubricVersion}</Chip>
          <Chip>{fmtDate(w.createdAt)}</Chip>
          {w.hash && (
            <Chip title={`sha256 of the rubric version and every weight: ${w.hash}`} className="font-mono">
              {w.hash.slice(0, 12)}
            </Chip>
          )}
        </div>
      </m.div>

      <div className="mt-10 grid gap-4 md:grid-cols-3">
        <Stat label="Published results scored with it" value={String(w.results)} />
        <Stat label="Ballots" value={stats ? String(stats.ballots) : "—"} hint={stats ? `${stats.unchanged} kept every weight as it was` : "Not from a poll"} />
        <Stat
          label="Based on"
          value={w.base ? w.base.label : "—"}
          hint={w.base ? w.base.title : "The rubric itself"}
          to={w.base?.number ? w.base.label : undefined}
        />
      </div>

      {days.length > 0 && (
        <div className="mt-4 rounded-2xl border border-line p-4">
          <div className="text-xs text-muted">Ballots by the day they were last saved</div>
          <div className="mt-3 flex h-16 items-end gap-1.5">
            {days.map(([d, n]) => (
              <div key={d} className="flex flex-1 flex-col items-center gap-1" title={`${d}: ${n}`}>
                <div className="w-full rounded-t bg-accent/70" style={{ height: `${(n / peak) * 100}%` }} />
                <span className="text-[10px] text-faint tabular">{d.slice(5)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {w.base && (
        <section className="mt-10">
          <div className="text-xl font-semibold tracking-[-0.015em]">What changed from {w.base.label}</div>
          {w.changes.length ? (
            <div className="mt-4 overflow-hidden rounded-2xl border border-line">
              {w.changes.map((c) => (
                <div key={c.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line-weak px-4 py-2.5 last:border-0">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{c.label}</span>
                    <span className="block truncate text-xs text-muted">
                      {KIND_LABEL[c.kind]} · {c.context}
                      {stats?.changedBy[c.key] ? ` · changed on ${stats.changedBy[c.key]} ballot${stats.changedBy[c.key] === 1 ? "" : "s"}` : ""}
                    </span>
                  </span>
                  <span className="flex items-baseline gap-2 text-sm tabular">
                    <span className="text-muted">{fmtWeight(c.from)}</span>→<span className="font-semibold">{fmtWeight(c.to)}</span>
                    <span className={cn("text-xs", c.to > c.from ? "text-strong-fg" : "text-poor-fg")}>
                      {c.to > c.from ? "+" : "−"}
                      {fmtNum(Math.abs(c.to - c.from), 1)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">Nothing: every weight stayed as it was.</p>
          )}
        </section>
      )}

      <section className="mt-10">
        <div className="text-xl font-semibold tracking-[-0.015em]">Every weight</div>
        <div className="mb-4 text-sm text-muted">
          As a share of its group, and each answer's credit as a share of the best answer's{w.base ? `; changes are against ${w.base.label}` : ""}.
        </div>
        <WeightTree base={baseShares} draft={draft} />
      </section>

      {w.releases.length > 0 && (
        <section className="mt-10">
          <div className="text-xl font-semibold tracking-[-0.015em]">Releases scored with it</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {w.releases.map((r) => (
              <Link key={r.id} to="/releases" className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-bg-2">
                {r.label} <span className="text-muted">· {fmtDate(r.publishedAt)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, hint, to }: { label: string; value: string; hint?: string; to?: string }) {
  const body = (
    <>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-[-0.02em] tabular">{value}</div>
      {hint && <div className="mt-0.5 truncate text-xs text-muted">{hint}</div>}
    </>
  );
  return to ? (
    <Link to="/weighting/$ref" params={{ ref: to }} className="rounded-2xl border border-line p-4 hover:bg-bg-2">
      {body}
    </Link>
  ) : (
    <div className="rounded-2xl border border-line p-4">{body}</div>
  );
}
