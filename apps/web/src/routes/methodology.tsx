import type { EvalSettings } from "@pb/core";
import { rubric, suites } from "@pb/rubric";
import { ChevronRight, Download, ExternalLink } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { Chip } from "@/components/ui/badges";
import { Reveal } from "@/components/ui/misc";
import { Pct } from "@/components/ui/number";
import { ProjectMark } from "@/components/ui/project-mark";
import { easeInOut, focusIn } from "@/design/motion";
import { useLeaderboard, useMeta, usePrompts } from "@/lib/queries";
import { cn, fmtDate } from "@/lib/utils";

const SECTIONS = [
  ["overview", "Overview"],
  ["formula", "The formula"],
  ["weights", "Weights"],
  ["rules", "Scoring rules"],
  ["badges", "Level, Tier, Walkaway"],
  ["rubric", "Full rubric"],
  ["evaluation", "How evaluation works"],
  ["versions", "Versions"],
  ["prompts", "Evaluator prompts"],
  ["accuracy", "Evaluator accuracy"],
  ["frameworks", "Frameworks we build on"],
  ["limitations", "Limitations"],
  ["data", "Data & changelog"],
] as const;

/**
 * The section being read: the last one whose top has passed under the header, the first above them all, and the last
 * at the bottom of the page (a short final section never reaches the top). Recomputed on scroll, so scrolling back up
 * never leaves an earlier highlight behind.
 */
function useScrollSpy(ids: readonly string[]) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 120) current = id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = ids[ids.length - 1];
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [ids]);
  return active;
}

function Section({ id, title, muted, children }: { id: string; title: string; muted?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-line pt-10 pb-14 first:border-0 first:pt-0">
      <Reveal>
        <h2 className="text-[28px] leading-[34px] font-medium tracking-[-0.012em]">
          {title}
          {muted && <span className="text-muted"> {muted}</span>}
        </h2>
      </Reveal>
      <div className="mt-6 text-[15px] leading-[1.65] text-fg-2 [&_p+p]:mt-3">{children}</div>
    </section>
  );
}

export function MethodologyPage() {
  const active = useScrollSpy(SECTIONS.map((s) => s[0]));
  const meta = useMeta();
  useEffect(() => {
    if (location.hash) setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" }), 300);
  }, []);
  return (
    <div className="mx-auto max-w-[var(--container-page)] px-4 pt-10 sm:px-6 md:pt-14">
      <motion.div variants={focusIn} initial="hidden" animate="show" className="max-w-3xl">
        <div className="eyebrow mb-3">Methodology · Rubric v{rubric.version}</div>
        <h1 className="text-[34px] leading-[1.12] font-semibold tracking-[-0.02em] text-balance md:text-5xl md:leading-[1.06]">
          How every number is made. <span className="text-muted">Published in full, so anyone can check or recompute it.</span>
        </h1>
      </motion.div>

      <div className="scrollbar-none sticky top-16 z-10 -mx-4 mt-8 flex gap-1 overflow-x-auto border-b border-line bg-bg/95 px-4 py-2 backdrop-blur-sm lg:hidden">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className={cn("shrink-0 rounded-lg px-2.5 py-1 text-[13px]", active === id ? "bg-surface text-fg" : "text-muted")}>
            {label}
          </a>
        ))}
      </div>

      <div className="mt-10 grid gap-12 lg:grid-cols-[220px_1fr]">
        <nav className="sticky top-24 hidden self-start lg:block" aria-label="Sections">
          {SECTIONS.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className={cn("relative block py-1.5 pl-4 text-[13px] transition-colors", active === id ? "text-fg" : "text-muted hover:text-fg-3")}
            >
              {active === id && <motion.span layoutId="spy" className="absolute top-1.5 bottom-1.5 left-0 w-px bg-accent" />}
              {label}
            </a>
          ))}
        </nav>

        <div className="min-w-0 max-w-3xl">
          <Section id="overview" title="What the benchmark measures.">
            <p>
              The Privacy Benchmark scores crypto privacy systems on named benchmarks grouped into suites, with a percentage for each project on each benchmark
              and the best result per row highlighted. Behind every percentage is a short list of multiple-choice criteria, an answer chosen from published
              options, a rationale, and verbatim evidence from cited sources.
            </p>
            <p>Five principles keep it credible:</p>
            <ul className="mt-3 flex flex-col gap-2">
              {[
                "Same rules for everyone. There are no project-specific criteria or weights, and an automated check fails the build if the rubric names any evaluated project.",
                "Every number is traceable: cell → benchmark → criteria → chosen option → rationale → quotes → sources.",
                "Unknown is visible. Answers the evidence can't settle score as the riskiest option and are marked unverified, but never become a badge or a warning.",
                "Dated and versioned. Every result is pinned to a protocol version, a rubric version and a release date.",
                "Open source. The rubric, the evaluator's prompts and pipeline, the scoring code and this site are MIT-licensed on GitHub, so anyone can rerun or audit them.",
              ].map((t) => (
                <li key={t} className="flex gap-2.5">
                  <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-accent" />
                  {t}
                </li>
              ))}
            </ul>
          </Section>

          <Section id="formula" title="The formula." muted="Code computes every percentage; the model never does.">
            <div className="rounded-xl border border-line bg-bg-2 p-4 font-mono text-[13px] leading-[2] text-fg">
              <div>criterion points = option points × verifiability multiplier (after caps)</div>
              <div>benchmark % = Σ criterion points ÷ Σ max points of counted criteria × 100</div>
              <div>suite % = Σ (benchmark % × benchmark weight) ÷ Σ weights</div>
              <div>overall % = Σ (suite % × suite weight) ÷ Σ weights</div>
            </div>
            <p className="mt-4">
              Within each benchmark the criteria's maximum points add up to 100, so a benchmark's percentage is simply its points. Scores display to one
              decimal. Try it with a real project:
            </p>
            <WorkedExample />
          </Section>

          <Section id="weights" title="Weights." muted="A judgment call, published in full.">
            <p>
              The two privacy suites (40%) measure how private a system is. Custody, governance and decentralization (38%) measure how sovereign.
              Programmability (12%) measures how much you can build privately, and security (10%) whether the design holds up in practice. The Rankings page
              lets you try other presets, labelled as custom views.
            </p>
            <div className="mt-5 overflow-hidden rounded-xl border border-line">
              {suites.map((s) => (
                <div key={s.id} className="border-b border-line px-4 py-3 last:border-0">
                  <div className="flex items-baseline justify-between">
                    <span className="font-semibold">
                      {s.name} <span className="font-normal text-muted">· {s.tagline}</span>
                    </span>
                    <span className="font-semibold tabular">{s.weight}%</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
                    {s.benchmarks.map((b) => (
                      <a key={b.id} href={`#${b.id}`} className="hover:text-fg">
                        {b.name} <span className="tabular">{b.weight}</span>
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2 text-[13px]">
              {rubric.presets.map((p) => (
                <Chip key={p.id} tone={p.official ? "accent" : "neutral"}>
                  {p.name}: {suites.map((s) => p.weights[s.id]).join(" / ")}
                </Chip>
              ))}
            </div>
          </Section>

          <Section id="rules" title="Scoring rules.">
            <Rules />
          </Section>

          <Section id="badges" title="Level, Tier, Walkaway." muted="Three badges an average can't hide.">
            <Badges />
          </Section>

          <Section
            id="rubric"
            title="The full rubric."
            muted={`${suites.length} suites, ${suites.reduce((n, s) => n + s.benchmarks.length, 0)} benchmarks, ${suites.reduce((n, s) => n + s.benchmarks.reduce((m, b) => m + b.criteria.length, 0), 0)} criteria.`}
          >
            <FullRubric />
          </Section>

          <Section id="evaluation" title="How evaluation works." muted="Models gather and judge; code computes; humans publish.">
            <Evaluation releaseId={meta.data?.release?.id ?? null} isDemo={!!meta.data?.isDemo} />
          </Section>

          <Section id="versions" title="Versions.">
            <p>
              Privacy systems change fast, so every evaluation is pinned to a protocol version. Where a public GitHub repository exists, Claude Sonnet 5.5
              checks its releases and triages new ones (major or minor, privacy-relevant or not, which suites might move). Otherwise editors add versions from
              announcements. When a version is evaluated, the researchers and judge are told to assess the protocol as of that version, and GitHub code is read
              at that version's tag. The code auditor reads every changed file that touches a privileged function, a verifier, an upgrade path or key handling.
            </p>
            <p>
              When a new evaluation's answer differs from the published one, Claude Opus 5.5 explains each difference against the release notes and code diff: a
              change in this version, new evidence, or unexplained. Unexplained differences are treated as possible evaluator variance and must be resolved by
              an editor before publishing. The explanation is shown next to each change on the project page.
            </p>
            <p>You can pick a version for each project on its page and in the benchmark table, and put two versions of the same project side by side.</p>
          </Section>

          <Section id="prompts" title="Evaluator prompts." muted="Every system prompt the evaluator uses, verbatim.">
            <Prompts />
          </Section>

          <Section id="accuracy" title="Evaluator accuracy.">
            <p>
              A benchmark is only as credible as its grader, so the evaluator has its own evaluation. A hand-labelled golden set covers every criterion for the
              eight launch systems, and the evaluator is run against it with the editors' notes hidden. The targets are Cohen's κ ≥ 0.75 on high-impact and
              badge-driving criteria and ≥ 0.65 overall, with zero dangerous errors in either direction on pause, freeze, key, upgrade and critical-bug
              criteria. Accuracy runs are made whenever the prompts or models change, and their results are reported in the release notes.
            </p>
            <p>
              The golden labels were written by the benchmark's editors from a single internal review, so they are a consistency check, not ground truth.
              Independent double labelling is planned before the golden set is used as a release gate.
            </p>
            <div className="mt-4 rounded-xl border border-dashed border-line-strong px-4 py-3 text-sm text-muted">
              {meta.data?.isDemo
                ? "The current data is hand-labelled demo data, so no automated accuracy figures apply yet. Golden-set results will be published with the first automated release."
                : "Golden-set results for this release are listed in the release notes."}
            </div>
          </Section>

          <Section id="frameworks" title="Frameworks we build on.">
            <ul className="flex flex-col gap-2.5">
              {[
                [
                  "L2BEAT",
                  "Stages, risk rosette, exit-window scale, trusted-setup ratings, and the privacy dashboard's adversary model and walkaway test.",
                  "https://l2beat.com/privacy",
                ],
                ["WalletBeat", "Verifiability-weighted ratings and handling of unrated attributes.", "https://beta.walletbeat.eth.limo"],
                ["DeFiScan", "Judging upgrade powers by what they can damage.", "https://www.defiscan.info/framework"],
                ["EF CROPS", "Censorship resistance, open source, privacy, security as non-negotiables.", "https://github.com/ethsystems/map"],
                ["The Trustless Manifesto", "The walkaway test.", "https://trustlessness.eth.limo/general/2025/11/11/the-trustless-manifesto.html"],
                ["SoK: Mixing and Anonymity", "Adversary taxonomy; effective versus nominal anonymity.", "https://arxiv.org/html/2504.20296"],
                [
                  "CheckEval, TICK, Rating Roulette",
                  "Evidence for decomposed criteria, majority voting and chance-corrected agreement in LLM judging.",
                  "https://arxiv.org/abs/2403.18771",
                ],
              ].map(([name, what, url]) => (
                <li key={name} className="flex gap-3">
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex shrink-0 items-center gap-1 font-medium text-fg hover:text-accent-fg"
                  >
                    {name} <ExternalLink className="size-3" />
                  </a>
                  <span className="text-muted">{what}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section id="limitations" title="Limitations.">
            <ul className="flex flex-col gap-2">
              {[
                "Weights are a judgment call. Presets and custom weights are there to show how much the order depends on them.",
                "Measured usage relies on public dashboards, which undercount value held in some bridges and apps.",
                "Independent effective-anonymity studies exist for only a few systems; the rest score “no independent study yet”.",
                "Scores describe protocols, not the apps built on them. App-level screening or co-signing shows up only as context.",
                "Evidence is as of the date shown. Systems change between releases; check the version and date on each result.",
                "Model-assisted research can miss facts. Human review, public evidence and the correction form exist to catch that.",
                "Not financial, legal or security advice.",
              ].map((t) => (
                <li key={t} className="flex gap-2.5">
                  <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-line-strong" />
                  {t}
                </li>
              ))}
            </ul>
          </Section>

          <Section id="data" title="Data & changelog.">
            <div className="flex flex-wrap gap-2">
              <a
                href="/api/public/rubric"
                download="privacy-benchmark-rubric.json"
                className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line-strong bg-bg px-3.5 text-sm shadow-1 hover:bg-bg-2"
              >
                <Download className="size-4" /> Rubric JSON
              </a>
              {meta.data?.release && (
                <>
                  <a
                    href={`/api/public/releases/${meta.data.release.id}/export.json`}
                    className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line-strong bg-bg px-3.5 text-sm shadow-1 hover:bg-bg-2"
                  >
                    <Download className="size-4" /> Release data (JSON)
                  </a>
                  <a
                    href={`/api/public/releases/${meta.data.release.id}/export.csv`}
                    className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line-strong bg-bg px-3.5 text-sm shadow-1 hover:bg-bg-2"
                  >
                    <Download className="size-4" /> Score table (CSV)
                  </a>
                </>
              )}
            </div>
            <div className="mt-6 overflow-hidden rounded-xl border border-line">
              <div className="border-b border-line bg-bg-2 px-4 py-2 text-xs font-medium text-muted">Rubric changelog</div>
              <div className="px-4 py-3 text-sm">
                <span className="font-semibold">v{rubric.version}</span> <span className="text-muted">· {fmtDate(rubric.releasedAt)}</span>
                <div className="mt-1 text-muted">
                  A disclosed, unpatched critical bug scores on its own criterion; it no longer caps Soundness record at 30% or adds a warning badge. A gated
                  private exit passes the walkaway test with a note, since the public exit always works. Where a criterion has an option for "nothing published"
                  (governance and producer concentration, effective anonymity, measured usage, proving time), a logged search that found nothing answers it
                  instead of leaving it unknown.
                </div>
                <div className="mt-3">
                  <span className="font-semibold">v1.2.1</span> <span className="text-muted">· {fmtDate("2026-10-01")}</span>
                </div>
                <div className="mt-1 text-muted">
                  Wording aligned with the 1.2.0 guidance: the network-privacy question no longer lists relayers as a way to hide the IP; the public-boundary
                  option now describes a system that has private calls; a default relayer that one operator dominates is the middle fee option; upgrade delays
                  don't subtract the time users need to exit.
                </div>
                <div className="mt-3">
                  <span className="font-semibold">v1.2.0</span> <span className="text-muted">· {fmtDate("2026-10-01")}</span>
                </div>
                <div className="mt-1 text-muted">
                  Guidance clarified where careful evaluators reached different answers: a pool's public deposit and withdrawal addresses are a public
                  identifier; screening a deposit differs from gating a private exit; IP privacy is judged against every network party; exit windows and upgrade
                  delays run from when an upgrade is visible onchain; bugs in the official client or SDK count as security issues; only released wallet
                  integrations count. Without censorship data the censorship answer is unknown, not the best score. News and blogs form their own source class
                  (80%), below official docs. A split judge vote is no longer published as the harshest answer: it goes to a reviewer.
                </div>
                <div className="mt-3">
                  <span className="font-semibold">v1.1.0</span> <span className="text-muted">· {fmtDate("2026-10-01")}</span>
                </div>
                <div className="mt-1 text-muted">
                  Badges, caps and gates use established answers only; unknown inputs leave a badge unrated instead of producing a claim. New "not researched"
                  status, which blocks publishing. The verifiability multiplier also covers badge-driving criteria, and a favorable answer with no supporting
                  source counts like marketing. Call-stack guidance clarified for systems without private calls between contracts.
                </div>
                <div className="mt-3">
                  <span className="font-semibold">v1.0.0</span> <span className="text-muted">· {fmtDate("2026-09-30")}</span>
                </div>
                <div className="mt-1 text-muted">
                  First public rubric: 7 suites, 31 benchmarks, 106 criteria; Privacy Level, Trust Tier and Walkaway badges; verifiability multiplier;
                  version-pinned evaluation.
                </div>
              </div>
            </div>
            <p className="mt-4 text-sm text-muted">
              Versioning: a major version changes criteria or weights, so scores aren't comparable across majors. Minor versions clarify guidance; patches fix
              typos. Corrections to published results are listed in the notes of the release that applies them, and every decision on a suggested correction,
              with its reason, is in the{" "}
              <a href="/releases#corrections" className="underline decoration-line-strong underline-offset-2 hover:text-fg">
                corrections log
              </a>
              .
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}

function WorkedExample() {
  const lb = useLeaderboard();
  const rows = lb.data?.rows ?? [];
  const [slug, setSlug] = useState<string | null>(null);
  const r = rows.find((x) => x.slug === slug) ?? rows[0];
  if (!r) return null;
  const total = suites.reduce((s, su) => s + (r.suites[su.id] ?? 0) * su.weight, 0) / 100;
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-line">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-bg-2 px-3 py-2">
        {rows.map((x) => (
          <button
            type="button"
            key={x.slug}
            onClick={() => setSlug(x.slug)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium",
              x.slug === r.slug ? "bg-bg text-fg shadow-hairline" : "text-muted hover:text-fg",
            )}
          >
            <ProjectMark name={x.name} logoUrl={x.logoUrl} size={14} />
            {x.name}
          </button>
        ))}
      </div>
      <div className="p-4 font-mono text-[12.5px] leading-[1.9]">
        {suites.map((su) => (
          <div key={su.id} className="grid grid-cols-[1fr_auto] gap-4">
            <span className="text-fg-3">
              {su.name}{" "}
              <span className="text-faint">
                {(r.suites[su.id] ?? 0).toFixed(1)}% × {su.weight}%
              </span>
            </span>
            <span className="text-right tabular">{(((r.suites[su.id] ?? 0) * su.weight) / 100).toFixed(2)}</span>
          </div>
        ))}
        <div className="mt-1 grid grid-cols-[1fr_auto] gap-4 border-t border-dashed border-line-strong pt-1 font-semibold text-fg">
          <span>{r.name} overall</span>
          <span className="tabular">
            <Pct value={total} />
          </span>
        </div>
      </div>
    </div>
  );
}

function Rules() {
  const rules: [string, ReactNode][] = [
    [
      "Unknown = riskiest option",
      "If the evidence can't establish an answer, the criterion scores its lowest option and is shown as unverified (dotted underline). Transparency is part of trust; opacity can't earn points. An unknown never turns into a badge or a warning: the Privacy Level, Trust Tier, Walkaway test, caps and gates read established answers only, and show as unrated otherwise.",
    ],
    [
      "Not disclosed",
      'Where a criterion has an option for "nothing published" (Unclear, No independent study yet, No published figure), a genuine search that found nothing answers it, and the page lists what was searched. Elsewhere the answer stays unknown, with the same search log. Where the code could decide a criterion, the search must include the code and onchain state before either counts.',
    ],
    [
      "Evidence coverage",
      "A result is published only when at least 60% of the criteria in every suite are settled (by verified evidence, or by a logged search that found nothing), and nothing went unresearched. The share it settles is shown on each project's page.",
    ],
    [
      "Answers must agree",
      "Some answers can't both be true (immutable contracts with a short exit window; no pause function, yet exits blocked during a pause). When an evaluation produces such a pair, both answers go to an editor before publishing.",
    ],
    [
      "Proving a negative",
      '"No pause function" or "no blocklist" can\'t be quoted from silence. Those answers need an explicit statement, or a reproducible search attestation: the exact files, refs and terms searched, with zero matches.',
    ],
    [
      "Not applicable",
      "Excluded from the benchmark's denominator, so the rest rescale to 100. Allowed only where a criterion says so (currently client proving time, for systems where users don't prove).",
    ],
    [
      "Verifiability multiplier",
      "On high-impact and badge-driving criteria, a favorable answer is only as strong as the best verified source that establishes it: code, onchain data or independent analysis (audits, L2BEAT, research) 100%; the project's technical docs 90%; news, blogs and aggregators 80%; marketing, pages by interested parties, or no establishing source, 70% (marked ‡). Unfavorable answers always count in full.",
    ],
    [
      "A power that can be added instantly already exists",
      "If core contracts can be upgraded instantly, Blocklist/freeze scores at most the issuer-hooks option and Pause function at most the fast-path option.",
    ],
    ["Nothing hidden, nothing to trust or build", "Privacy Level Z0 sets the Trust and Programmability suites to 0."],
    ["No private logic, no call stack", "If private execution is impossible, Call-stack privacy scores 0."],
    ["Operator sees everything", "If an operator reads plaintext routinely, Decryption power is capped at 15% and the Trust Tier is D."],
    [
      "Scope",
      "Scores describe the live, deployed configuration of the pinned version. Roadmap items never count. Controls held by independent apps, bridges or stablecoin issuers are context, unless a criterion covers them (e.g. freeze hooks in a native token standard, or one blacklist freezing a pooled contract).",
    ],
    [
      "Careful user, reference client",
      "Privacy criteria ask what a careful user gets with the protocol and its reference client's supported options, including ones that are off by default. Only criteria that ask about defaults (privacy by default, network privacy, private reads, fees, receiving, client-side proving) score the default. User mistakes never lower a grade; facts about the deployment do.",
    ],
  ];
  return (
    <div className="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line">
      {rules.map(([t, d]) => (
        <div key={t} className="px-4 py-3">
          <div className="text-[14px] font-semibold text-fg">{t}</div>
          <div className="mt-0.5 text-[14px] text-muted">{d}</div>
        </div>
      ))}
    </div>
  );
}

function Badges() {
  const levels = [
    ["Z0", "Transparent", "Amounts visible and sender/recipient visible."],
    ["Z1", "Partial", "Hides amounts or links, not both."],
    ["Z2", "Private transfers", "Sender, recipient and amount all hidden."],
    ["Z3", "Private accounts", "Z2 + anonymous access to public apps."],
    ["Z4", "Private execution", "Z2 + general private state and private logic."],
    ["Z5", "Full-stack private", "Z4 + call graph hidden + network-layer protection + private reads."],
  ];
  const tiers = [
    ["A", "Trustless", "No standing access, and infrastructure sees nothing."],
    ["B", "Hardware-trusted", "No standing key, but plaintext passes through TEEs."],
    ["C", "Key-holder", "A designated entity, committee or default hosted service can see."],
    ["D", "Operator-visible", "The operator or validators see plaintext routinely."],
  ];
  const table = (rows: string[][]) => (
    <div className="overflow-hidden rounded-xl border border-line">
      {rows.map(([k, n, d]) => (
        <div key={k} className="grid grid-cols-[48px_150px_1fr] gap-3 border-b border-line px-4 py-2.5 text-sm last:border-0">
          <span className="font-semibold tabular">{k}</span>
          <span className="font-medium">{n}</span>
          <span className="text-muted">{d}</span>
        </div>
      ))}
    </div>
  );
  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="mb-2 font-semibold">Privacy Level: what is hidden</div>
        {table(levels)}
      </div>
      <div>
        <div className="mb-2 font-semibold">Trust Tier: from whom</div>
        {table(tiers)}
      </div>
      <div>
        <div className="mb-2 font-semibold">Walkaway test: can users carry on if any single party disappears or turns hostile?</div>
        <p className="text-muted">
          It passes only if all four hold: no single party can halt the system (or a permissionless exit is live); exiting needs nobody's permission; funds can
          be recovered from public data and the user's own keys; and nobody else is needed to spend. If the public exit always works but a third party can gate
          the private exit, the test passes with a note, and the gate is scored under Custody. A failed test shows its reason. If any input isn't established by
          evidence, the test shows as unrated and names what's missing. The test adapts L2BEAT's walkaway test to private systems.
        </p>
      </div>
    </div>
  );
}

function FullRubric() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-8">
      {suites.map((s) => (
        <div key={s.id}>
          <div className="flex items-baseline justify-between border-b border-line-strong pb-2">
            <span className="text-lg font-semibold">
              {s.name} <span className="text-sm font-normal text-muted">· {s.tagline}</span>
            </span>
            <span className="text-sm text-muted tabular">{s.weight}%</span>
          </div>
          {s.adversaries.length > 0 && (
            <div className="mt-2 text-[13px] text-muted">Judged against: {s.adversaries.map((a) => a.replace("_", " ")).join(", ")}.</div>
          )}
          {s.benchmarks.map((b) => {
            const isOpen = open === b.id;
            return (
              <div key={b.id} id={b.id} className="scroll-mt-28 border-b border-line">
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : b.id)}
                  className="flex w-full items-center gap-2 py-3 text-left"
                  aria-expanded={isOpen}
                >
                  <motion.span animate={{ rotate: isOpen ? 90 : 0 }} className="text-faint">
                    <ChevronRight className="size-4" />
                  </motion.span>
                  <span className="flex-1">
                    <span className="font-medium">{b.name}</span> <span className="text-sm text-muted">{b.question}</span>
                  </span>
                  {b.highImpact && <Chip tone="accent">High impact</Chip>}
                  <span className="text-sm text-muted tabular">{b.weight}</span>
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3, ease: easeInOut }}
                      className="overflow-hidden"
                    >
                      <div className="flex flex-col gap-4 pb-5 pl-6">
                        {b.notes.map((n) => (
                          <div key={n} className="text-[13px] text-muted">
                            Note: {n}
                          </div>
                        ))}
                        {b.criteria.map((c) => (
                          <div key={c.id} className="rounded-xl border border-line p-3.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold">{c.label}</span>
                              <code className="font-mono text-[11px] text-faint">{c.id}</code>
                              {c.highImpact && <Chip tone="accent">High impact</Chip>}
                              {c.naAllowed && <Chip>N/A allowed</Chip>}
                            </div>
                            <div className="mt-1 text-[14px]">{c.question}</div>
                            <div className="mt-1 text-[13px] text-muted">{c.guidance}</div>
                            <div className="mt-2.5 flex flex-col gap-1">
                              {c.options.map((o) => (
                                <div key={o.id} className="flex items-center justify-between gap-3 rounded-md bg-bg-2 px-2.5 py-1 text-[13px]">
                                  <span>{o.label}</span>
                                  <span className="font-mono text-fg tabular">{o.points}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Evaluation({ releaseId, isDemo }: { releaseId: string | null; isDemo: boolean }) {
  const [settings, setSettings] = useState<EvalSettings | null>(null);
  useEffect(() => {
    if (!releaseId) return;
    fetch(`/api/public/releases/${releaseId}/settings`)
      .then((r) => r.json())
      .then((j) => setSettings(j.settings))
      .catch(() => {});
  }, [releaseId]);
  const steps = [
    [
      "Intake",
      "An editor adds a project by its website. Metadata is extracted automatically and reviewed. Versions are tracked from GitHub releases or announcements.",
    ],
    [
      "Knowledge base",
      "Before any model runs, the project's public material is indexed for full-text search: the complete docs site, the open-source code at the pinned version's tag, release notes and the diff from the previous version, the website and blog, the project's own posts on X, news coverage, independent analyses and audits (via Exa), and L2BEAT and DefiLlama data. It's refreshed when the pinned version changes or after a few days.",
    ],
    [
      "Scout",
      "Claude Sonnet 5.5 reviews the knowledge base, fills gaps (audits, incident reports, governance forums), and lists deployed contract addresses and the assets the system holds.",
    ],
    [
      "Code audit",
      "Two Claude Opus 5.5 auditors build a model of the system from its code and live onchain state. One maps every privileged function (upgrade, pause, freeze, mint, key rotation, verifier changes) and who can call it: proxy admins, owners, multisig thresholds, timelock delays, issuer powers over pooled assets, and what changed since the previous version. The other works out how the system runs end to end: each actor and what it can do and see, how a transaction travels and who orders and includes it, forced-inclusion and escape paths with their live parameters, who pays fees and what that reveals, and the reference client's defaults. The code is the source of truth: what the code does counts more than what the docs say.",
    ],
    [
      "Research",
      "Seven Claude Opus 5.5 researchers, one per suite, run in parallel with the code audit's findings. They search the knowledge base first and record quotes for and against each criterion. Every quote is checked against its stored source on the spot. A near match is stored in the source's own words, never the researcher's, along with the surrounding text, and a near match that changes a negation, number or qualifier is rejected. Criteria still unsettled get a second, targeted research pass.",
    ],
    [
      "Code check",
      'After judging, every answer that is still unknown or "not disclosed", where the code can decide it, goes back to a code checker with the repositories at the pinned version and onchain reads, and is judged again with what it finds. An answer can only be published as not disclosed once the code check has searched too; its search log says what was checked. Track records, usage and audit lists are excluded, since code can\'t establish them.',
    ],
    [
      "Judge",
      "A separate Claude Opus 5.5 judge, with no browsing, picks exactly one published option per criterion using only verified evidence, and must cite the quotes it relies on. High-impact and badge-driving criteria get independent votes with differently shuffled evidence; a third vote breaks ties.",
    ],
    [
      "Verify",
      "A skeptic sees each answer with the quotes it rests on, and searches the code, onchain state, news and X for counter-evidence or quotes taken out of context. It covers every high-impact and badge-driving answer that isn't already the riskiest option, and triggers a re-judge if it finds anything. The adversary matrix is checked against the criteria.",
    ],
    ["Score", "Deterministic code applies the rubric: points, multipliers, caps, gates, weights, badges."],
    [
      "Review",
      "Editors resolve every flag (unverified, disagreement, skeptic change, self-reported, changed since the last release). Overrides require a public reason, and accepting a flagged answer requires a recorded reason. Publishing past unresolved flags requires a justification that is printed in the release notes. Summaries are regenerated from the final answers.",
    ],
    ["Publish", "Immutable, dated release snapshots with downloadable data."],
  ];
  return (
    <div>
      <div className="relative">
        <div className="absolute top-3 bottom-3 left-[11px] w-px bg-line" />
        {steps.map(([t, d], i) => (
          <Reveal key={t} delay={i * 0.03} className="relative flex gap-4 pb-5">
            <span className="relative z-10 mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-bg font-mono text-[10px] text-muted">
              {i + 1}
            </span>
            <div>
              <div className="font-semibold">{t}</div>
              <div className="text-[14px] text-muted">{d}</div>
            </div>
          </Reveal>
        ))}
      </div>
      <p className="mt-2 text-[14px] text-muted">
        Models are matched to their jobs. Claude Sonnet 5.5 scouts sources and writes (release triage, summaries). Claude Opus 5.5 does everything that decides
        an answer: the code audit, research, judging, the skeptic pass and explaining version changes. The judge never browses, and code computes every number.
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-line">
        <div className="border-b border-line bg-bg-2 px-4 py-2 text-xs font-medium text-muted">Evaluation settings for the current release</div>
        {isDemo || !settings || settings.mode === "manual" ? (
          <div className="px-4 py-3 text-sm text-muted">
            The current release is hand-labelled by editors ({settings?.evidenceCutoff ? `evidence as of ${fmtDate(settings.evidenceCutoff)}` : "demo data"});
            no automated evaluation was run. Automated releases list the models, effort, votes, tool budgets and prompt hashes here.
          </div>
        ) : (
          <dl className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-1.5 px-4 py-3 text-sm">
            <dt className="text-muted">Mode</dt>
            <dd>{settings.mode}</dd>
            {Object.entries(settings.models).map(([k, v]) => (
              <Fragment2 key={k} k={`Model · ${k}`} v={`${v}${settings.effort[k] ? ` · effort ${settings.effort[k]}` : ""}`} />
            ))}
            <dt className="text-muted">Votes</dt>
            <dd>
              {settings.votesHighImpact} on high-impact criteria, {settings.votesOther} on others
            </dd>
            <dt className="text-muted">Tool budgets</dt>
            <dd>
              {Object.entries(settings.maxToolCalls)
                .map(([k, v]) => `${k} ${v}`)
                .join(" · ")}
            </dd>
            <dt className="text-muted">Evidence cutoff</dt>
            <dd>{fmtDate(settings.evidenceCutoff)}</dd>
          </dl>
        )}
      </div>
    </div>
  );
}

function Fragment2({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="font-mono text-[13px]">{v}</dd>
    </>
  );
}

function Prompts() {
  const q = usePrompts();
  const [open, setOpen] = useState<string | null>(null);
  if (!q.data) return <div className="text-sm text-muted">Loading…</div>;
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      {Object.entries(q.data.prompts).map(([k, text]) => (
        <div key={k} className="border-b border-line last:border-0">
          <button
            type="button"
            onClick={() => setOpen(open === k ? null : k)}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-bg-2"
          >
            <motion.span animate={{ rotate: open === k ? 90 : 0 }} className="text-faint">
              <ChevronRight className="size-3.5" />
            </motion.span>
            <span className="flex-1 font-medium">{k}</span>
            <code className="font-mono text-[11px] text-faint">{q.data.hashes[k]}</code>
          </button>
          <AnimatePresence initial={false}>
            {open === k && (
              <motion.pre
                initial={{ height: 0 }}
                animate={{ height: "auto" }}
                exit={{ height: 0 }}
                className="max-h-[480px] overflow-auto border-t border-line bg-bg-2 px-4 py-3 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap text-fg-3"
              >
                {text}
              </motion.pre>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}
