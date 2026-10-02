/**
 * The sections under the benchmark table on the landing page: suite leaders, how a number is made, and the card
 * builder's call to action.
 */
import type { LeaderboardRow } from "@pb/core";
import { suites } from "@pb/rubric";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Image } from "lucide-react";
import { useMemo } from "react";
import { ButtonLink } from "@/components/ui/button";
import { Reveal, SectionHeading } from "@/components/ui/misc";
import { Pct } from "@/components/ui/number";
import { ProjectMark } from "@/components/ui/project-mark";
import { cn } from "@/lib/utils";

export function SuiteLeaders({ rows }: { rows: LeaderboardRow[] }) {
  const leaders = useMemo(
    () =>
      suites.map((s) => {
        const sorted = [...rows]
          .filter((r) => r.suites[s.id] !== null && r.suites[s.id] !== undefined)
          .sort((a, b) => (b.suites[s.id] ?? 0) - (a.suites[s.id] ?? 0));
        return { s, top: sorted.slice(0, 3) };
      }),
    [rows],
  );
  return (
    <section className="mx-auto max-w-[var(--container-wide)] px-4 pt-24 sm:px-6 md:pt-32">
      <Reveal>
        <SectionHeading eyebrow="Suite leaders" title="Seven suites." muted="No system leads them all." />
      </Reveal>
      {/* Phones swipe through the suites (stacked, they ran over two screens); wider screens get the grid. The row reveals
          as one: per card, a card peeking in from the right never counted as in view, and the peek is the swipe cue. */}
      <Reveal className="scrollbar-none -mx-4 mt-8 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:scroll-px-0 sm:mt-10 sm:grid sm:snap-none sm:grid-cols-2 sm:gap-px sm:overflow-hidden sm:rounded-2xl sm:border sm:border-line sm:bg-line sm:px-0 sm:pb-0 lg:grid-cols-4">
        {leaders.map(({ s, top }) => (
          <div key={s.id} className="flex w-[78%] shrink-0 snap-start flex-col rounded-2xl border border-line bg-bg p-5 sm:w-auto sm:rounded-none sm:border-0">
            <Link to="/rankings" search={{ tab: s.id }} className="group flex h-full flex-col">
              <div className="flex items-baseline justify-between">
                <span className="text-[17px] font-semibold tracking-[-0.01em]">{s.name}</span>
                <span className="text-xs text-faint tabular">{s.weight}%</span>
              </div>
              <span className="mt-0.5 text-sm text-muted">{s.tagline}</span>
              <div className="mt-5 flex flex-col gap-2.5">
                {top.map((r, k) => (
                  <div key={r.slug} className="flex items-center gap-2">
                    <ProjectMark name={r.name} logoUrl={r.logoUrl} size={16} />
                    <span className={cn("flex-1 truncate text-[13px]", k === 0 ? "font-semibold" : "text-fg-3")}>{r.name}</span>
                    <span className={cn("text-[13px] tabular", k === 0 ? "font-semibold" : "text-muted")}>
                      <Pct value={r.suites[s.id]} />
                    </span>
                  </div>
                ))}
              </div>
              <span className="mt-auto pt-5 text-xs text-muted transition-colors group-hover:text-fg">
                See ranking <ArrowRight className="inline size-3" />
              </span>
            </Link>
          </div>
        ))}
        <div className="flex w-[78%] shrink-0 snap-start flex-col justify-between rounded-2xl border border-line bg-bg-2 p-5 sm:w-auto sm:rounded-none sm:border-0">
          <div>
            <div className="text-[17px] font-semibold tracking-[-0.01em]">Weigh it your way</div>
            <div className="mt-1 text-sm text-muted">Re-rank with the Privacy-first, Sovereignty-first or Builder presets, or set your own weights.</div>
          </div>
          <ButtonLink to="/rankings" search={{ preset: "privacy-first" }} variant="secondary" size="sm" className="mt-5 self-start">
            Try presets
          </ButtonLink>
        </div>
      </Reveal>
    </section>
  );
}

const STEPS = [
  {
    t: "Read everything",
    d: "Full docs, open-source code at the pinned version, release diffs, the project's posts on X, news and independent analyses are indexed first.",
  },
  { t: "Audit the code", d: "Claude Opus 5.5 maps every privileged function and who holds it, then checks the deployed contracts onchain." },
  { t: "Research", d: "Seven parallel researchers record verbatim evidence for and against each criterion, searching the index first." },
  {
    t: "Judge",
    d: "A separate Claude Opus 5.5 judge picks one anchored option per criterion from verified evidence only, with majority votes on high-impact items.",
  },
  { t: "Verify", d: "Every quote is checked against its source; a skeptic hunts for counter-evidence to favorable answers." },
  { t: "Score", d: "Code, not the model, computes every percentage from the published rubric." },
  { t: "Review", d: "Editors resolve flags; overrides are shown publicly with reasons." },
  { t: "Publish", d: "Immutable, dated releases with downloadable data, pinned to a protocol version." },
];

export function HowItWorks() {
  return (
    <section className="dark mt-24 bg-bg text-fg md:mt-32">
      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 pinstripes opacity-40" />
        <div className="relative mx-auto max-w-[var(--container-wide)] px-4 py-20 sm:px-6 md:py-28">
          <Reveal>
            <SectionHeading eyebrow="How a number is made" title="Models gather and judge." muted="Code computes. Humans publish." />
          </Reveal>
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <Reveal key={s.t} delay={i * 0.05} className="relative bg-bg p-5">
                <div className="flex items-center gap-2">
                  <span className="inline-flex size-6 items-center justify-center rounded-md border border-line font-mono text-[11px] text-muted">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-[15px] font-semibold">{s.t}</span>
                </div>
                <p className="mt-3 text-[13px] leading-[1.55] text-muted">{s.d}</p>
              </Reveal>
            ))}
          </div>
          <div className="mt-8 flex flex-wrap gap-2">
            <ButtonLink to="/methodology" variant="primary">
              Read the methodology
            </ButtonLink>
            <ButtonLink to="/methodology" hash="prompts" variant="secondary" className="!bg-transparent !text-fg">
              See the evaluator prompts
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}

export function CardCta() {
  return (
    <section className="mx-auto max-w-[var(--container-wide)] px-4 pt-24 sm:px-6 md:pt-32">
      <Reveal className="relative overflow-hidden rounded-3xl border border-line bg-bg-2 px-6 py-12 text-center md:py-16">
        <div className="pointer-events-none absolute inset-0 dot-grid opacity-50 [mask-image:radial-gradient(60%_80%_at_50%_50%,#000,transparent)]" />
        <div className="relative">
          <Image className="mx-auto size-6 text-accent" strokeWidth={1.75} />
          <h2 className="mx-auto mt-4 max-w-xl text-3xl font-medium tracking-[-0.01em] md:text-4xl">
            Share a comparison. <span className="text-muted">Any set of projects, every number sourced and dated.</span>
          </h2>
          <ButtonLink to="/cards" variant="primary" size="lg" className="mt-7">
            Make a card
          </ButtonLink>
        </div>
      </Reveal>
    </section>
  );
}
