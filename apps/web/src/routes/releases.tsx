import { findCriterion } from "@pb/rubric";
import { Link } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { m } from "motion/react";
import { Chip } from "@/components/ui/badges";
import { ButtonLink } from "@/components/ui/button";
import { Empty, Skeleton } from "@/components/ui/misc";
import { focusIn, stagger } from "@/design/motion";
import { type CorrectionsLog, useCorrectionsLog, useReleases, useWeightings } from "@/lib/queries";
import { fmtDate } from "@/lib/utils";

export function ReleasesPage() {
  const q = useReleases();
  const weightings = useWeightings();
  // Releases from an older rubric than weightings name none: they were scored with that rubric's built-in numbers.
  const weightingOf = (id: string | null | undefined) => (id ? (weightings.data?.find((w) => w.id === id) ?? null) : null);
  return (
    <div className="mx-auto max-w-[var(--container-page)] px-4 pt-10 sm:px-6 md:pt-14">
      <m.div variants={focusIn} initial="hidden" animate="show" className="max-w-3xl">
        <div className="eyebrow mb-3">Releases</div>
        <h1 className="text-[34px] leading-[1.12] font-semibold tracking-[-0.02em] text-balance md:text-5xl md:leading-[1.06]">
          Every release, frozen. <span className="text-muted">Download the data and recompute any number.</span>
        </h1>
      </m.div>
      <div className="mt-12 max-w-4xl">
        {q.isLoading && <Skeleton className="h-24" />}
        {q.data && !q.data.length && <Empty title="No releases yet" />}
        <m.div variants={stagger(0.05)} initial="hidden" animate="show" className="relative">
          <div className="absolute top-2 bottom-2 left-[5px] w-px bg-line" />
          {q.data?.map((r) => (
            <m.div key={r.id} variants={focusIn} className="relative pb-10 pl-8">
              <span className="absolute top-2 left-0 size-[11px] rounded-full border-2 border-accent bg-bg" />
              <div className="eyebrow">{fmtDate(r.publishedAt, { month: "long", day: "numeric", year: "numeric" })}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h2 className="text-2xl font-semibold tracking-[-0.015em]">Release {r.label}</h2>
                {r.isDemo && <Chip tone="fair">Demo data</Chip>}
                <Chip>Rubric v{r.rubricVersion}</Chip>
                {weightingOf(r.weightingId) && (
                  <Link to="/weighting/$ref" params={{ ref: weightingOf(r.weightingId)!.label }} title={weightingOf(r.weightingId)!.title}>
                    <Chip className="hover:border-line-strong">Weighting {weightingOf(r.weightingId)!.label}</Chip>
                  </Link>
                )}
                <Chip>{r.projects} projects</Chip>
              </div>
              {r.notes && <p className="mt-3 max-w-2xl text-[15px] leading-[1.6] whitespace-pre-line text-fg-3">{r.notes}</p>}
              <div className="mt-4 flex flex-wrap gap-2">
                <ButtonLink to="/benchmarks" size="sm" variant="secondary">
                  Open table
                </ButtonLink>
                <a
                  href={`/api/public/releases/${encodeURIComponent(r.id)}/export.json`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-bg px-2.5 text-[13px] shadow-1 hover:bg-bg-2"
                >
                  <Download className="size-3.5" /> JSON
                </a>
                <a
                  href={`/api/public/releases/${encodeURIComponent(r.id)}/export.csv`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-bg px-2.5 text-[13px] shadow-1 hover:bg-bg-2"
                >
                  <Download className="size-3.5" /> CSV
                </a>
              </div>
            </m.div>
          ))}
        </m.div>
      </div>
      <CorrectionsSection />
    </div>
  );
}

const DECISION: Record<CorrectionsLog["items"][number]["status"], { label: string; tone: "strong" | "fair" | "neutral" }> = {
  done: { label: "Corrected", tone: "strong" },
  accepted: { label: "Accepted · in the next release", tone: "fair" },
  rejected: { label: "Not changed", tone: "neutral" },
};

/** The public corrections log (JDG-38): every decision with its reason, linked to the release that applied it. */
function CorrectionsSection() {
  const q = useCorrectionsLog();
  if (!q.data) return null;
  const { items, open } = q.data;
  return (
    <section id="corrections" className="mt-6 max-w-4xl scroll-mt-24 border-t border-line pt-10 pb-6">
      <h2 className="text-2xl font-semibold tracking-[-0.015em]">Corrections log</h2>
      <p className="mt-2 max-w-2xl text-[15px] leading-[1.6] text-fg-3">
        Anyone can suggest a correction from a project page. Each one is checked against public evidence; the decision and the reason are listed here, and
        accepted corrections appear in the notes of the release that applies them.
        {open > 0 && ` ${open} ${open === 1 ? "suggestion is" : "suggestions are"} awaiting review.`}
      </p>
      {items.length === 0 ? (
        <p className="mt-6 text-sm text-muted">No corrections decided yet.</p>
      ) : (
        <ul className="mt-6 flex flex-col divide-y divide-line">
          {items.map((c) => {
            const d = DECISION[c.status];
            const criterion = c.criterionId ? findCriterion(c.criterionId)?.label : null;
            return (
              <li key={c.id} className="flex flex-col gap-1.5 py-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{c.projectName}</span>
                  {criterion && <span className="text-muted">· {criterion}</span>}
                  <Chip tone={d.tone}>{c.status === "done" && c.release ? `Corrected in release ${c.release.label}` : d.label}</Chip>
                  {c.decidedAt && (
                    <span className="ml-auto text-xs text-muted">{fmtDate(c.decidedAt, { month: "short", day: "numeric", year: "numeric" })}</span>
                  )}
                </div>
                <p className="text-[15px] leading-[1.55] text-fg-2">{c.note}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
