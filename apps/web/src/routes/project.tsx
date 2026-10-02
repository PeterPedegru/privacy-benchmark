import type { ProjectSnapshot } from "@pb/core";
import { getCriterion, suites } from "@pb/rubric";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ArrowRight, ExternalLink, Image, MessageSquareWarning, Scale } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { CalcBreakdown } from "@/components/bench/calc-breakdown";
import { benchmarkScore, cellMarks } from "@/components/bench/model";
import { SuggestCorrection } from "@/components/bench/suggest";
import { AdversaryMatrixView, Bar, Rosette, ScoreRing } from "@/components/bench/viz";
import { Chip, LevelBadge, TierBadge, WalkawayBadge } from "@/components/ui/badges";
import { Button, ButtonLink } from "@/components/ui/button";
import { Empty, LoadError, Reveal, Skeleton } from "@/components/ui/misc";
import { Pct } from "@/components/ui/number";
import { ProjectMark } from "@/components/ui/project-mark";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { focusIn, stagger } from "@/design/motion";
import { isNotFound } from "@/lib/api";
import { type ProjectPage as ProjectPageData, useLeaderboard, useProject } from "@/lib/queries";
import { cn, fmtDate, hostOf, safeHref, sourceLink } from "@/lib/utils";

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
const MECH: Record<string, string> = {
  pool: "Pool",
  shielded_ledger: "Shielded ledger",
  stealth_address: "Stealth addresses",
  confidential_amounts: "Confidential amounts",
  private_execution: "Private execution",
  none: "No privacy mechanism",
};
const CONTEXT_LABEL: Record<string, string> = {
  status: "Status",
  valueSecured: "Value secured",
  typicalCost: "Typical private tx cost",
  feeModel: "Fee model",
  throughput: "Throughput",
  launched: "Launched",
  programmability: "Programmability",
  token: "Token",
};

type Tab = "benchmarks" | "matrix" | "sources" | "history";

export function ProjectPage() {
  const { slug } = useParams({ from: "/public/projects/$slug" });
  const search = useSearch({ from: "/public/projects/$slug" });
  const navigate = useNavigate({ from: "/projects/$slug" });
  const q = useProject(slug, search.version);
  const lb = useLeaderboard();
  const [cell, setCell] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<string | null | undefined>(undefined);
  const tab = (search.tab as Tab) ?? "benchmarks";

  if (q.isLoading) {
    return (
      <div className="mx-auto max-w-[var(--container-page)] px-4 pt-14 sm:px-6">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="mt-6 h-40" />
      </div>
    );
  }
  if (!q.data) {
    // Only a 404 means the project isn't published; a network error or a deploy in progress gets a retry (R3-REL-14).
    return (
      <div className="mx-auto max-w-[var(--container-page)] px-4 pt-14 sm:px-6">
        {isNotFound(q.error) ? (
          <Empty title="Project not found">It may not have a published evaluation yet.</Empty>
        ) : (
          <LoadError title="Couldn't load this project." busy={q.isFetching} onRetry={() => void q.refetch()} />
        )}
      </div>
    );
  }
  const d = q.data;
  const s = d.snapshot;
  const others = (lb.data?.rows ?? [])
    .filter((r) => r.slug !== slug)
    .slice(0, 3)
    .map((r) => r.slug);
  const context = Object.entries(s.context).filter(([, v]) => v);

  return (
    <div className="mx-auto max-w-[var(--container-page)] px-4 pt-10 sm:px-6 md:pt-14">
      <motion.div variants={stagger(0.06)} initial="hidden" animate="show" className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <motion.div variants={focusIn} className="flex items-center gap-2 text-[13px] text-muted">
            <Link to="/projects" className="hover:text-fg">
              Projects
            </Link>
            <span>/</span>
            <span className="text-fg-3">{s.project.name}</span>
          </motion.div>
          <motion.div variants={focusIn} className="mt-5 flex items-center gap-4">
            <ProjectMark name={s.project.name} logoUrl={s.project.logoUrl} size={52} />
            <div className="min-w-0">
              <h1 className="text-4xl font-semibold tracking-[-0.025em] md:text-5xl">{s.project.name}</h1>
              <div className="mt-1 text-[15px] text-muted">{s.project.tagline}</div>
            </div>
          </motion.div>
          <motion.div variants={focusIn} className="mt-5 flex flex-wrap items-center gap-1.5">
            <LevelBadge level={s.scores.level} />
            <TierBadge tier={s.scores.trustTier} level={s.scores.level} />
            <WalkawayBadge walkaway={s.scores.walkaway} />
            <span className="mx-1 h-4 w-px bg-line" />
            <Chip>{CATEGORY[s.project.category] ?? s.project.category}</Chip>
            <Chip>{MECH[s.project.mechanism] ?? s.project.mechanism}</Chip>
            {s.project.chains.slice(0, 3).map((c) => (
              <Chip key={c}>{c}</Chip>
            ))}
            <a
              href={safeHref(s.project.website) ?? undefined}
              target="_blank"
              rel="noreferrer noopener"
              className="ml-1 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg"
            >
              {hostOf(s.project.website)} <ExternalLink className="size-3" />
            </a>
          </motion.div>
          {d.versions.length > 0 && (
            <motion.div variants={focusIn} className="mt-6 flex flex-wrap items-center gap-3">
              <span className="text-xs text-muted">Version</span>
              {d.versions.length <= 4 ? (
                <Segmented
                  size="sm"
                  value={s.version?.version ?? ""}
                  onChange={(v) => navigate({ search: (x) => ({ ...x, version: v }), replace: true, resetScroll: false })}
                  options={d.versions.map((v) => ({ value: v.version ?? "", label: v.label ?? "" }))}
                />
              ) : (
                <select
                  value={s.version?.version ?? ""}
                  onChange={(e) => navigate({ search: (x) => ({ ...x, version: e.target.value }), replace: true })}
                  className="h-8 rounded-lg border border-line bg-bg px-2 text-[13px]"
                >
                  {d.versions.map((v) => (
                    <option key={v.version} value={v.version ?? ""}>
                      {v.label}
                    </option>
                  ))}
                </select>
              )}
              {s.version?.releasedAt && <span className="text-xs text-muted">Released {fmtDate(s.version.releasedAt)}</span>}
            </motion.div>
          )}
        </div>
        <motion.div variants={focusIn} className="flex items-center gap-5 rounded-2xl border border-line bg-bg-2 p-5">
          <ScoreRing value={s.scores.overall} size={132} />
          <div className="flex flex-col gap-1.5 text-[13px]">
            <span className="text-muted">Evaluated {fmtDate(s.evaluatedAt)}</span>
            <span className="text-muted">Evidence as of {fmtDate(s.evidenceAsOf)}</span>
            <span className="text-muted">
              {s.release.isDemo ? "Demo" : "Release"} {s.release.label} · Rubric v{s.release.rubricVersion}
            </span>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <ButtonLink
                size="sm"
                variant="primary"
                to="/"
                search={{ p: [s.version ? `${slug}@${s.version.version}` : slug, ...others].join(","), focus: slug }}
                icon={<Scale className="size-3.5" />}
              >
                Compare
              </ButtonLink>
              <ButtonLink
                size="sm"
                variant="secondary"
                to="/cards"
                search={{ p: s.version ? `${slug}@${s.version.version}` : slug, t: "spotlight" }}
                icon={<Image className="size-3.5" />}
              >
                Card
              </ButtonLink>
            </div>
          </div>
        </motion.div>
      </motion.div>

      {s.summary && <Reveal className="mt-10 border-l-2 border-accent pl-4 text-lg leading-[1.45] text-fg-2 md:text-xl">{s.summary}</Reveal>}

      {/* Rosette and suite bars side by side; the powers get a full-width row so a long list leaves no gap beside them.
          Phones skip the rosette: the bars below give the same numbers, and it took a screen of height. */}
      <div className="mt-12 grid items-stretch gap-6 lg:grid-cols-[380px_1fr]">
        <Reveal className="hidden flex-col items-center rounded-2xl border border-line p-5 sm:flex">
          <div className="self-start text-sm font-semibold">Suite rosette</div>
          <div className="self-start text-xs text-muted">Petal length = suite score</div>
          <div className="my-auto pt-4">
            <Rosette snapshot={s} />
          </div>
        </Reveal>
        <Reveal delay={0.05} className="rounded-2xl border border-line p-5">
          <div className="text-sm font-semibold">Suites</div>
          <div className="mt-4 flex flex-col gap-3.5">
            {s.scores.suites.map((su, i) => {
              const def = suites.find((x) => x.id === su.suiteId)!;
              return (
                <div key={su.suiteId}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span>
                      {def.name} <span className="text-xs text-faint">{def.weight}%</span>
                    </span>
                    <span className="font-semibold tabular">
                      <Pct value={su.score} />
                    </span>
                  </div>
                  <Bar value={su.score} delay={i * 0.05} className="mt-1.5" />
                </div>
              );
            })}
          </div>
        </Reveal>
      </div>
      <Reveal delay={0.1} className="mt-6 rounded-2xl border border-line p-5">
        <div className="text-sm font-semibold">Who holds power</div>
        <ul className="mt-3 gap-x-10 md:columns-2">
          {s.powers.map((p) => (
            <li key={p} className="mb-2.5 flex break-inside-avoid gap-2 text-[13px] leading-[1.45] text-fg-2">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
              {p}
            </li>
          ))}
          {!s.powers.length && <li className="text-[13px] text-muted">Not summarized.</li>}
        </ul>
      </Reveal>

      <div className="scrollbar-none mt-14 flex gap-1 overflow-x-auto border-b border-line">
        {(["benchmarks", "matrix", "sources", "history"] as Tab[]).map((t) => (
          <button
            type="button"
            key={t}
            onClick={() => navigate({ search: (x) => ({ ...x, tab: t === "benchmarks" ? undefined : t }), replace: true, resetScroll: false })}
            className={cn("relative shrink-0 px-3 pt-2 pb-3 text-sm capitalize transition-colors", tab === t ? "text-fg" : "text-muted hover:text-fg")}
          >
            {t === "matrix" ? "Adversary matrix" : t === "history" ? "Versions & changes" : t}
            {tab === t && <motion.span layoutId="proj-tab" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === "benchmarks" && <BenchmarksList s={s} onOpen={setCell} />}
        {tab === "matrix" && (
          <div className="max-w-4xl">
            <p className="mb-4 max-w-2xl text-sm text-muted">
              What each adversary can learn, L2BEAT-style. Hover a cell for the note. The matrix isn't scored separately; it's checked for consistency against
              the criteria.
            </p>
            <AdversaryMatrixView snapshot={s} />
          </div>
        )}
        {tab === "sources" && <SourcesList s={s} />}
        {tab === "history" && <History d={d} />}
      </div>

      {context.length > 0 && (
        <section className="mt-12 border-t border-line pt-6">
          <h2 className="text-sm font-semibold">
            Context <span className="font-normal text-muted">· not scored</span>
          </h2>
          <dl className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {context.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[110px_1fr] gap-2 text-[13px]">
                <dt className="text-muted">{CONTEXT_LABEL[k] ?? k}</dt>
                <dd className="text-fg-2">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <div className="mt-12 flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" icon={<MessageSquareWarning className="size-3.5" />} onClick={() => setSuggest(null)}>
          Suggest a correction
        </Button>
        <Link to="/methodology" className="text-sm text-muted hover:text-fg">
          How scores are calculated <ArrowRight className="inline size-3.5" />
        </Link>
      </div>

      <Sheet
        open={!!cell}
        onOpenChange={(o) => !o && setCell(null)}
        title={cell ? `${suites.flatMap((x) => x.benchmarks).find((b) => b.id === cell)?.name} · ${s.project.name}` : ""}
        subtitle="How this number was calculated"
      >
        {cell && <CalcBreakdown snapshot={s} benchmarkId={cell} onSuggest={(c) => setSuggest(c)} />}
      </Sheet>
      {suggest !== undefined && <SuggestCorrection open onOpenChange={(o) => !o && setSuggest(undefined)} projectSlug={slug} criterionId={suggest} />}
    </div>
  );
}

/**
 * Suites in two columns of about equal length, in reading order: paired row by row, a short suite beside a long one
 * left a gap under it. The split falls where the two columns' rows (a suite header counting as two) come closest.
 */
const SUITE_COLUMNS = (() => {
  const rows = suites.map((su) => su.benchmarks.length + 2);
  const total = rows.reduce((a, b) => a + b, 0);
  let best = 1;
  let acc = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    acc += rows[i]!;
    const prev = rows.slice(0, best).reduce((a, b) => a + b, 0);
    if (Math.abs(total - 2 * acc) < Math.abs(total - 2 * prev)) best = i + 1;
  }
  return [suites.slice(0, best), suites.slice(best)];
})();

function BenchmarksList({ s, onOpen }: { s: ProjectSnapshot; onOpen: (id: string) => void }) {
  return (
    // minmax(0,1fr): a bare grid column grows to its widest unbreakable line, which pushed this list past the screen
    // on phones and made the browser zoom the whole page out.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-10 md:grid-cols-2">
      {SUITE_COLUMNS.map((col) => (
        <div key={col[0]?.id} className="flex min-w-0 flex-col gap-10">
          {col.map((su) => (
            <Reveal key={su.id} className="min-w-0">
              <div className="flex items-baseline justify-between border-b border-line-strong pb-2">
                <span className="text-[15px] font-semibold">{su.name}</span>
                <span className="text-sm font-semibold tabular">
                  <Pct value={s.scores.suites.find((x) => x.suiteId === su.id)?.score} />
                </span>
              </div>
              {su.benchmarks.map((b) => {
                const sc = benchmarkScore(s, b.id);
                const m = cellMarks(s, b.id);
                return (
                  <button
                    type="button"
                    key={b.id}
                    onClick={() => onOpen(b.id)}
                    className="group flex w-full items-center gap-4 border-b border-line py-3 text-left"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-fg group-hover:text-accent-fg">{b.name}</span>
                      {/* Phones wrap the question (no room for the bar there); wider screens keep one line. */}
                      <span className="block text-xs text-muted sm:truncate">{b.question}</span>
                    </span>
                    <span className="hidden w-28 shrink-0 sm:block">
                      <Bar value={sc?.score ?? null} />
                    </span>
                    <span className={cn("w-16 shrink-0 text-right text-sm font-semibold tabular", m.unverified > 0 && "unverified")}>
                      <Pct value={sc?.score} />
                    </span>
                  </button>
                );
              })}
            </Reveal>
          ))}
        </div>
      ))}
    </div>
  );
}

const CLASS_LABEL: Record<string, string> = {
  code_onchain: "Code / onchain",
  independent: "Independent",
  official_docs: "Official docs",
  third_party: "News / third party",
  marketing: "Marketing",
};

const KB_PARTS = [
  ["docs", "docs pages"],
  ["code", "source files"],
  ["changes", "release notes & diffs"],
  ["website", "site pages"],
  ["announcements", "X posts"],
  ["news", "news articles"],
  ["analysis", "analyses & audits"],
  ["data", "data feeds"],
] as const;

function KnowledgeBaseNote({
  kb,
  version,
  coverage,
}: {
  kb: NonNullable<ProjectSnapshot["knowledgeBase"]>;
  version: ProjectSnapshot["version"];
  coverage?: ProjectSnapshot["coverage"];
}) {
  const parts = KB_PARTS.filter(([k]) => kb[k]);
  if (!parts.length) return null;
  return (
    <div className="mb-4 rounded-2xl border border-line bg-bg-2 p-4">
      <div className="text-sm font-medium">What the evaluator read</div>
      {coverage && (
        <p className="mt-1 text-sm text-fg-3">
          Verified evidence settles {coverage.covered} of {coverage.total} criteria. The rest score as the riskiest option until evidence settles them.
        </p>
      )}
      <p className="mt-1 text-sm text-muted">
        Before judging, the evaluator indexed the project's public material{version ? ` with code pinned to ${version.label}` : ""}
        {kb.refreshedAt ? `, as of ${fmtDate(kb.refreshedAt)}` : ""}. Only the sources below were quoted as evidence.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {parts.map(([k, label]) => (
          <span key={k} className="inline-flex items-baseline gap-1 rounded-lg border border-line bg-bg px-2 py-1 text-xs text-muted">
            <span className="font-semibold text-fg tabular">{kb[k]!.toLocaleString()}</span> {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function SourcesList({ s }: { s: ProjectSnapshot }) {
  const counts = new Map<string, number>();
  for (const c of Object.values(s.criteria)) for (const e of c.evidence) counts.set(e.sourceId, (counts.get(e.sourceId) ?? 0) + 1);
  const list = [...s.sources].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
  return (
    <>
      {s.knowledgeBase && <KnowledgeBaseNote kb={s.knowledgeBase} version={s.version} coverage={s.coverage} />}
      <div className="overflow-hidden rounded-2xl border border-line">
        {list.map((src) => {
          const link = sourceLink(src.url);
          return (
            <div key={src.id} className="flex flex-col gap-1 border-b border-line px-4 py-3 last:border-0 md:flex-row md:items-center md:gap-4">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{src.title}</span>
              <span className="flex items-center gap-2 text-xs text-muted">
                <Chip>{CLASS_LABEL[src.sourceClass] ?? src.sourceClass}</Chip>
                {src.date && <span>{fmtDate(src.date)}</span>}
                <span className="tabular">{counts.get(src.id) ?? 0} quotes</span>
                {link ? (
                  <a href={link} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-fg">
                    {hostOf(link)} <ExternalLink className="size-3" />
                  </a>
                ) : (
                  <span>{src.url.startsWith("evm://") ? "Onchain read" : "Editor note"}</span>
                )}
              </span>
            </div>
          );
        })}
        {!list.length && <div className="p-6 text-sm text-muted">No sources.</div>}
      </div>
    </>
  );
}

function History({ d }: { d: ProjectPageData }) {
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr]">
      <div>
        <div className="text-sm font-semibold">Published versions</div>
        <div className="mt-3 flex flex-col">
          {d.versions.map((v) => (
            <div key={v.version} className="flex items-center gap-3 border-b border-line py-2.5 text-sm">
              <span className="flex-1">
                <span className="font-medium">{v.label}</span> <span className="text-xs text-muted">{fmtDate(v.releasedAt)}</span>
              </span>
              <LevelBadge level={(v.level as never) ?? null} compact />
              <span className="w-16 text-right font-semibold tabular">
                <Pct value={v.overall} />
              </span>
            </div>
          ))}
        </div>
        <div className="mt-6 text-sm font-semibold">Release history</div>
        <div className="mt-3 flex items-end gap-1" role="img" aria-label="Score per release">
          {[...d.history].reverse().map((h) => (
            <div
              key={`${h.release.id}-${h.version?.version}`}
              className="flex flex-col items-center gap-1"
              title={`${h.release.label}: ${h.overall?.toFixed(1)}%`}
            >
              <div className="w-3 rounded-sm bg-accent/80" style={{ height: `${Math.max(4, (h.overall ?? 0) * 0.8)}px` }} />
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="text-sm font-semibold">
          {d.comparedTo ? `What changed since ${d.comparedTo.version?.label ?? "the previous version"}` : "What changed"}
        </div>
        {d.changes.length ? (
          <div className="mt-3 overflow-hidden rounded-xl border border-line">
            {d.changes.map((c) => {
              const def = getCriterion(c.criterionId);
              const STATUS_LABEL: Record<string, string> = { unknown: "Unknown", not_researched: "Not researched", not_applicable: "Not applicable" };
              const lab = (id: string | null) => (id ? (STATUS_LABEL[id] ?? def.options.find((o) => o.id === id)?.label ?? id) : "—");
              const why = d.snapshot.criteria[c.criterionId]?.change;
              return (
                <div key={c.criterionId} className="border-b border-line px-3.5 py-2.5 text-[13px] last:border-0">
                  <div className="font-medium">{def.label}</div>
                  <div className="text-muted">
                    <span className="line-through">{lab(c.from)}</span> → <span className="text-fg-2">{lab(c.to)}</span>
                  </div>
                  {why && (
                    <div className="mt-1 text-xs text-muted">
                      <span
                        className={cn("font-medium", why.kind === "protocol_change" ? "text-fg-3" : why.kind === "unexplained" ? "text-fair-fg" : "text-fg-3")}
                      >
                        {why.kind === "protocol_change"
                          ? "Changed in this version"
                          : why.kind === "evidence_change"
                            ? "New evidence"
                            : why.kind === "rubric_change"
                              ? "Rubric changed"
                              : "Unexplained"}
                      </span>
                      : {why.note}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mt-3 text-sm text-muted">{d.comparedTo ? "No criterion answers changed." : "Only one version has been evaluated so far."}</div>
        )}
      </div>
    </div>
  );
}
