import type { LeaderboardRow } from "@pb/core";
import { suites } from "@pb/rubric";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Check, Eye, Image, KeyRound, Snowflake } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useMemo, useState } from "react";
import { Bar } from "@/components/bench/viz";
import { LevelBadge, TierBadge, WalkawayBadge } from "@/components/ui/badges";
import { Button, ButtonLink } from "@/components/ui/button";
import { LoadError, Reveal, SectionHeading, Skeleton } from "@/components/ui/misc";
import { Pct } from "@/components/ui/number";
import { ProjectMark } from "@/components/ui/project-mark";
import { focusIn, stagger } from "@/design/motion";
import { useLeaderboard, useMeta } from "@/lib/queries";
import { cn } from "@/lib/utils";

const CATEGORY: Record<string, string> = {
  l1: "L1",
  l2: "L2",
  privacy_pool: "Privacy pool",
  privacy_app: "Privacy app",
  coprocessor: "Coprocessor",
  appchain: "Appchain",
  wallet: "Wallet",
  other: "Other",
};

export function HomePage() {
  const lb = useLeaderboard();
  const meta = useMeta();
  const rows = lb.data?.rows ?? [];
  const release = meta.data?.release;
  return (
    <>
      {/* A title in the benchmark table's style, then the leaderboard. */}
      <div className="mx-auto max-w-[var(--container-page)] px-4 pt-10 sm:px-6 md:pt-14">
        <m.div variants={focusIn} initial="hidden" animate="show" className="max-w-2xl">
          <div className="eyebrow mb-3">Leaderboard{release ? ` · Release ${release.label}` : ""}</div>
          <h1 className="text-[34px] leading-[1.12] font-semibold tracking-[-0.02em] text-balance md:text-5xl md:leading-[1.06]">
            Privacy systems, ranked. <span className="text-muted">Every score is a sourced, checkable calculation.</span>
          </h1>
        </m.div>
      </div>
      <Leaderboard rows={rows} loading={lb.isLoading} failed={lb.isError && !lb.data} retrying={lb.isFetching} onRetry={() => void lb.refetch()} />
      <SuiteLeaders rows={rows} />
      <Explainers />
      <HowItWorks />
      <CardCta />
    </>
  );
}

function Leaderboard({
  rows,
  loading,
  failed,
  retrying,
  onRetry,
}: {
  rows: LeaderboardRow[];
  loading: boolean;
  failed: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const nav = useNavigate();
  const toggle = (slug: string) => setPicked((p) => (p.includes(slug) ? p.filter((x) => x !== slug) : p.length >= 6 ? p : [...p, slug]));
  return (
    <section className="mx-auto max-w-[var(--container-page)] px-4 pt-6 sm:px-6 md:pt-8">
      <div className="overflow-hidden rounded-2xl border border-line">
        <div className="hidden grid-cols-[40px_32px_minmax(180px,1.4fr)_minmax(250px,1.2fr)_minmax(180px,1fr)_88px] items-center gap-3 border-b border-line bg-bg-2 px-4 py-2.5 text-xs font-medium text-muted md:grid">
          <span>#</span>
          <span />
          <span>Project</span>
          <span>Badges</span>
          <span>Overall</span>
          <span className="text-right">Score</span>
        </div>
        {loading &&
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="border-b border-line p-4 last:border-0">
              <Skeleton className="h-6" />
            </div>
          ))}
        {failed && (
          <div className="p-4">
            <LoadError title="Couldn't load the rankings." busy={retrying} onRetry={onRetry} />
          </div>
        )}
        {!loading && !failed && rows.length === 0 && (
          <div className="px-4 py-10 text-center">
            <p className="text-[15px] font-semibold">No published results yet.</p>
            <p className="mt-1 text-sm text-muted">Projects appear here once their evaluations are reviewed and published.</p>
          </div>
        )}
        {/* Animates on mount, remounted when the rows arrive: with whileInView, rows that loaded after the table came
            into view never animated in and stayed invisible. */}
        <m.div key={rows.length ? "rows" : "empty"} variants={stagger(0.05)} initial="hidden" animate="show">
          {rows.map((r, i) => (
            <m.div
              key={r.slug}
              variants={focusIn}
              className="group grid grid-cols-[28px_1fr_auto] items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3.5 transition-colors last:border-0 hover:bg-bg-2 md:grid-cols-[40px_32px_minmax(180px,1.4fr)_minmax(250px,1.2fr)_minmax(180px,1fr)_88px]"
            >
              <span className="text-sm text-muted tabular">{i + 1}</span>
              <button
                type="button"
                onClick={() => toggle(r.slug)}
                aria-label={`Compare ${r.name}`}
                className={cn(
                  "hidden size-[18px] items-center justify-center rounded-[5px] border transition-colors md:flex",
                  picked.includes(r.slug) ? "border-accent bg-accent text-white" : "border-line-strong bg-bg hover:border-accent",
                )}
              >
                {picked.includes(r.slug) && <Check className="size-3" strokeWidth={3} />}
              </button>
              <Link to="/projects/$slug" params={{ slug: r.slug }} className="flex min-w-0 items-center gap-2.5">
                <ProjectMark name={r.name} logoUrl={r.logoUrl} size={26} />
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-semibold">{r.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {CATEGORY[r.category] ?? r.category}
                    {r.version ? ` · ${r.version.label}` : ""}
                  </span>
                </span>
              </Link>
              <div className="col-span-3 flex flex-wrap items-center gap-1.5 md:col-span-1">
                <LevelBadge level={r.level} />
                <TierBadge tier={r.trustTier} level={r.level} />
                <WalkawayBadge walkaway={r.walkaway} />
              </div>
              <div className="col-span-3 hidden md:col-span-1 md:block">
                <Bar value={r.overall} delay={0.1 + i * 0.05} />
                <div className="mt-1.5 flex gap-[3px]">
                  {suites.map((s) => (
                    <div key={s.id} className="h-1 flex-1 overflow-hidden rounded-full bg-surface" title={`${s.name}: ${r.suites[s.id]?.toFixed(1) ?? "—"}%`}>
                      <div className="h-full rounded-full bg-fg-3/40" style={{ width: `${r.suites[s.id] ?? 0}%` }} />
                    </div>
                  ))}
                </div>
              </div>
              <span className="col-start-3 row-start-1 text-right text-lg font-semibold tracking-[-0.01em] tabular md:col-start-auto md:row-start-auto">
                <Pct value={r.overall} />
              </span>
            </m.div>
          ))}
        </m.div>
      </div>
      <div className="mt-3 flex justify-end">
        <ButtonLink to="/rankings" variant="ghost" size="sm">
          All rankings <ArrowRight className="size-3.5" />
        </ButtonLink>
      </div>
      <AnimatePresence>
        {picked.length > 0 && (
          <m.div
            initial={{ opacity: 0, y: 16, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: 16 }}
            className="fixed inset-x-0 bottom-5 z-30 mx-auto flex w-fit items-center gap-3 rounded-2xl border border-line bg-bg py-2 pr-2 pl-4 shadow-5"
          >
            <span className="text-sm text-fg-3">{picked.length} selected</span>
            <Button size="sm" variant="ghost" onClick={() => setPicked([])}>
              Clear
            </Button>
            <Button size="sm" variant="primary" onClick={() => nav({ to: "/benchmarks", search: { p: picked.join(","), focus: picked[0] } })}>
              Compare in table
            </Button>
          </m.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function SuiteLeaders({ rows }: { rows: LeaderboardRow[] }) {
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
    <section className="mx-auto max-w-[var(--container-page)] px-4 pt-24 sm:px-6 md:pt-32">
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

function Explainers() {
  const items = [
    {
      icon: Eye,
      title: "What's hidden",
      body: "Amounts, identities, which contract ran, the call stack, and the metadata around it, judged against public observers, chain analysts and network observers.",
    },
    {
      icon: KeyRound,
      title: "Who can see",
      body: "Master viewing keys, key committees, operators that read plaintext, trusted hardware. Level Z0–Z5 says what's hidden; Tier A–D says from whom.",
    },
    {
      icon: Snowflake,
      title: "Who can stop you",
      body: "Pause switches, freezes, forced transfers, admin keys, instant upgrades and gatekeepers on exit. The Walkaway test asks if you can leave if anyone turns hostile.",
    },
  ];
  return (
    <section className="mx-auto max-w-[var(--container-page)] px-4 pt-24 sm:px-6 md:pt-32">
      <div className="grid gap-4 md:grid-cols-3">
        {items.map((it, i) => (
          <Reveal key={it.title} delay={i * 0.06} className="rounded-2xl border border-line bg-bg p-6 shadow-1">
            <it.icon className="size-5 text-accent" strokeWidth={1.75} />
            <div className="mt-5 text-lg font-semibold tracking-[-0.01em]">{it.title}</div>
            <p className="mt-2 text-sm leading-[1.55] text-muted">{it.body}</p>
          </Reveal>
        ))}
      </div>
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

function HowItWorks() {
  return (
    <section className="dark mt-24 bg-bg text-fg md:mt-32">
      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 pinstripes opacity-40" />
        <div className="relative mx-auto max-w-[var(--container-page)] px-4 py-20 sm:px-6 md:py-28">
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

function CardCta() {
  return (
    <section className="mx-auto max-w-[var(--container-page)] px-4 pt-24 sm:px-6 md:pt-32">
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
