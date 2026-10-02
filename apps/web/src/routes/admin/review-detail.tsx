import { INFO_FLAGS } from "@pb/core";
import { getCriterion, type ScoreCard, suites } from "@pb/rubric";
import { Link, useParams } from "@tanstack/react-router";
import { BadgeCheck, Check, CircleHelp, ExternalLink, Eye, RefreshCw, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { Input, PageHeader, Panel, Status, useAdmin, useAdminAction } from "@/components/admin/kit";
import { Chip, LevelBadge, TierBadge, WalkawayBadge } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Pct } from "@/components/ui/number";
import { ProjectMark } from "@/components/ui/project-mark";
import { Segmented } from "@/components/ui/segmented";
import { api } from "@/lib/api";
import { cn, fmtUsd, hostOf, sourceLink } from "@/lib/utils";

type Result = {
  id: string;
  criterionId: string;
  status: string;
  optionId: string | null;
  rationale: string;
  confidence: string;
  evidenceIds: string[];
  flags: string[];
  votes: { optionId: string | null; status: string; rationale?: string; round?: number; pass?: "codecheck" | "skeptic" }[];
  searchLog: { searched: string[]; note: string; codeChecked?: boolean } | null;
  overrideStatus: string | null;
  overrideOptionId: string | null;
  overrideReason: string | null;
  proposedOptionId: string | null;
  reviewNote: string | null;
  change: { kind: "protocol_change" | "evidence_change" | "rubric_change" | "unexplained"; note: string; from: string | null; to: string | null } | null;
};

const FLAG_LABEL: Record<string, { text: string; tone: "fair" | "poor" | "neutral" | "strong" }> = {
  unverified: { text: "No verified quote", tone: "fair" },
  needs_quote: { text: "Judge's answer lacks a cited quote", tone: "fair" },
  no_evidence: { text: "No evidence found", tone: "fair" },
  not_researched: { text: "Not researched", tone: "poor" },
  judge_disagreement: { text: "Votes disagreed", tone: "fair" },
  skeptic_changed: { text: "Skeptic changed it", tone: "fair" },
  skeptic_checked: { text: "Skeptic checked", tone: "strong" },
  matrix_conflict: { text: "Matrix conflict", tone: "fair" },
  inconsistent_answers: { text: "Contradicts another answer", tone: "poor" },
  changed_since_published: { text: "Changed since published", tone: "fair" },
  change_unexplained: { text: "Change unexplained", tone: "poor" },
  unsupported_favorable: { text: "Favorable, nothing supports it", tone: "poor" },
  self_reported: { text: "Only the project's own word", tone: "fair" },
  evidence_conflict: { text: "Cited evidence argues against it", tone: "poor" },
  context_only_evidence: { text: "Only context evidence", tone: "fair" },
  low_confidence: { text: "Low confidence", tone: "neutral" },
  invalid_na: { text: "Invalid N/A", tone: "fair" },
  invalid_option: { text: "Invalid option", tone: "fair" },
  medium_confidence: { text: "Medium confidence (about 1 in 4 wrong)", tone: "fair" },
  attestation_only_favorable: { text: "Top answer rests only on a search", tone: "poor" },
  refused: { text: "Model declined to research", tone: "fair" },
  evidence_missing: { text: "Cited evidence is missing", tone: "poor" },
  class_changed: { text: "A source's class changed since judging", tone: "fair" },
  attestation_offchain: { text: "Rests on a code search for an off-chain power", tone: "poor" },
};

type CodeMap = {
  contracts: { name: string; address: string; chainId: number | null; role: string; upgradeable: string }[];
  privileged: { contract: string; fn: string; guard: string; holder: string; delay: string; effect: string }[];
  assets: { asset: string; address: string; issuerPowers: string }[];
  exits: string[];
  versionChanges: string[];
  openQuestions: string[];
};
type Evidence = {
  id: string;
  criterionId: string;
  claim: string;
  quote: string;
  sourceId: string | null;
  url: string;
  citedUrl: string | null;
  stance: string;
  sourceClass: string;
  verified: boolean;
  verifyMethod: string;
  verifyNote: string | null;
  quoteContext: string | null;
  createdByStage: string;
};
type Data = {
  evaluation: {
    id: string;
    status: string;
    mode: string;
    costUsd: number;
    reviewedSuites: string[];
    isDemo: boolean;
    summary: string;
    summaryAt: string | null;
    error: string | null;
    settings: { codeMap?: CodeMap; coverageNotes?: string; codeNotes?: string };
  };
  project: { id: string; name: string; slug: string; logoUrl: string | null };
  version: { label: string } | null;
  results: Result[];
  evidence: Evidence[];
  sources: { id: string; url: string; title: string; sourceClass: string }[];
  scores: ScoreCard;
  publishedOverall: number | null;
  publishedCriteria: Record<string, { optionId: string | null; status: string }> | null;
  coverage: {
    covered: number;
    total: number;
    ratio: number;
    suites: { suiteId: string; covered: number; total: number }[];
    notResearched: number;
    badgeGaps: string[];
    blocker: string | null;
  } | null;
};

export function AdminReviewDetail() {
  const { id } = useParams({ from: "/admin/review/$id" });
  const q = useAdmin<Data>(["evaluation", id], `/api/admin/evaluations/${id}`);
  const [suite, setSuite] = useState<string>("flagged");
  const markReviewed = useAdminAction((s: string[]) => api(`/api/admin/evaluations/${id}/reviewed`, { json: { suites: s } }), {
    success: "Marked reviewed",
    invalidate: [["evaluation", id], ["evaluations"], ["overview"]],
  });
  const rerun = useAdminAction((s: string[]) => api(`/api/admin/evaluations/${id}/rerun`, { json: { suites: s } }), {
    success: "Re-run queued",
    invalidate: [["evaluation", id], ["evaluations"], ["runs"], ["overview"]],
  });
  const resummarize = useAdminAction(() => api(`/api/admin/evaluations/${id}/summarize`, { method: "POST" }), {
    success: "Summary regenerated from the final answers",
  });
  const acceptAll = useAdminAction(() => api<{ accepted: number }>(`/api/admin/evaluations/${id}/accept-all`, { method: "POST" }), {
    success: (r) => `Accepted ${r.accepted} flagged answer${r.accepted === 1 ? "" : "s"}`,
    invalidate: [["evaluation", id], ["evaluations"], ["overview"]],
  });
  // Accepting every flag can't be undone, so the button asks once more before it does.
  const [confirmAll, setConfirmAll] = useState(false);
  const d = q.data;
  // Informational flags (skeptic checked, editor adjusted) don't need review (R4-29).
  const flagged = useMemo(() => (d?.results ?? []).filter((r) => r.flags.some((f) => !INFO_FLAGS.has(f as never)) && !r.overrideStatus), [d]);
  if (!d) return <div className="h-40 shimmer rounded-2xl" />;
  const list =
    suite === "flagged"
      ? flagged
      : d.results.filter((r) => r.criterionId.startsWith(`${suite}.`)).sort((a, b) => allIds.indexOf(a.criterionId) - allIds.indexOf(b.criterionId));
  const delta = d.publishedOverall !== null && d.scores.overall !== null ? d.scores.overall - d.publishedOverall : null;

  return (
    <>
      <div className="mb-2 text-[13px] text-muted">
        <Link to="/admin/review" className="hover:text-fg">
          Review
        </Link>{" "}
        / {d.project.name}
      </div>
      <PageHeader
        title={`${d.project.name}${d.version ? ` · ${d.version.label}` : ""}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <ProjectMark name={d.project.name} logoUrl={d.project.logoUrl} size={16} />
            <Status status={d.evaluation.status} />
            <span className="capitalize">{d.evaluation.mode}</span> · {fmtUsd(d.evaluation.costUsd)}
            {d.evaluation.isDemo && <Chip>demo</Chip>}
          </span>
        }
        actions={
          <>
            <a
              href={`/api/admin/evaluations/${id}/preview`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line-strong bg-bg px-3.5 text-sm shadow-1 hover:bg-bg-2"
            >
              <Eye className="size-4" /> Snapshot JSON
            </a>
            {!d.evaluation.isDemo && (
              <Button icon={<RefreshCw className="size-4" />} disabled={resummarize.isPending} onClick={() => resummarize.mutate()}>
                {resummarize.isPending ? "Writing…" : "Regenerate summary"}
              </Button>
            )}
            <Button variant="primary" onClick={() => markReviewed.mutate(suites.map((s) => s.id))}>
              Mark all reviewed
            </Button>
          </>
        }
      />

      {d.coverage && (
        <div
          className={cn(
            "mb-4 rounded-2xl border px-4 py-3 text-sm",
            d.coverage.blocker ? "border-poor-bd bg-poor-bg text-poor-fg" : "border-line bg-bg-2 text-fg-3",
          )}
        >
          <div className="font-medium">
            Evidence coverage: {d.coverage.covered}/{d.coverage.total} criteria have a verified quote ({Math.round(d.coverage.ratio * 100)}%)
          </div>
          {d.coverage.blocker && (
            <div className="mt-1">{d.coverage.blocker} Unknown answers score as the riskiest option, so this result can't be published as it is.</div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {d.coverage.suites.map((s) => (
              <span
                key={s.suiteId}
                className={cn(
                  "rounded-md border px-1.5 py-0.5 text-xs tabular",
                  s.covered ? "border-line bg-bg text-fg-3" : "border-poor-bd bg-bg text-poor-fg",
                )}
              >
                {suites.find((x) => x.id === s.suiteId)?.name ?? s.suiteId} {s.covered}/{s.total}
              </span>
            ))}
            {d.coverage.blocker && (
              <Button
                size="sm"
                icon={<RefreshCw className="size-3.5" />}
                onClick={() => rerun.mutate(d.coverage!.suites.filter((s) => s.covered / s.total < 0.25).map((s) => s.suiteId))}
              >
                Re-run thin suites
              </Button>
            )}
          </div>
        </div>
      )}

      {d.evaluation.settings?.codeMap && <CodeMapPanel map={d.evaluation.settings.codeMap} />}

      <div className="mb-6 grid gap-3 md:grid-cols-[auto_1fr]">
        <div className="flex items-center gap-4 rounded-2xl border border-line p-4">
          <div>
            <div className="text-xs text-muted">Overall</div>
            <div className="text-3xl font-semibold tracking-[-0.02em] tabular">
              <Pct value={d.scores.overall} />
            </div>
            {delta !== null && (
              <div className={cn("text-xs tabular", delta > 0 ? "text-strong-fg" : delta < 0 ? "text-poor-fg" : "text-muted")}>
                {delta >= 0 ? "+" : ""}
                {delta.toFixed(1)} vs published
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-1.5">
              <LevelBadge level={d.scores.level} />
              <TierBadge tier={d.scores.trustTier} level={d.scores.level} />
            </div>
            <div className="flex gap-1.5">
              <WalkawayBadge walkaway={d.scores.walkaway} />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {d.scores.suites.map((s) => {
            const def = suites.find((x) => x.id === s.suiteId)!;
            const n = flagged.filter((r) => r.criterionId.startsWith(`${s.suiteId}.`)).length;
            const reviewed = d.evaluation.reviewedSuites.includes(s.suiteId);
            return (
              <button
                type="button"
                key={s.suiteId}
                onClick={() => setSuite(s.suiteId)}
                className={cn(
                  "rounded-xl border p-3 text-left transition-colors",
                  suite === s.suiteId ? "border-accent bg-accent-soft" : "border-line hover:bg-bg-2",
                )}
              >
                <div className="truncate text-xs text-muted">{def.shortName}</div>
                <div className="text-lg font-semibold tabular">
                  <Pct value={s.score} />
                </div>
                <div className="mt-0.5 flex gap-1 text-[10px]">
                  {n > 0 && <span className="rounded bg-fair-bg px-1 font-semibold text-fair-fg">{n} flags</span>}
                  {reviewed && <span className="rounded bg-strong-bg px-1 font-semibold text-strong-fg">reviewed</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={suite === "flagged" ? "flagged" : "suite"}
          onChange={(v) => setSuite(v === "flagged" ? "flagged" : (suites[0]?.id ?? "coverage"))}
          options={[
            { value: "flagged", label: `Flag queue (${flagged.length})` },
            { value: "suite", label: "By suite" },
          ]}
        />
        {suite === "flagged" && flagged.length > 0 && (
          <div className="flex gap-2">
            {confirmAll ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Check className="size-3.5" />}
                  disabled={acceptAll.isPending}
                  onClick={() => acceptAll.mutate(undefined, { onSettled: () => setConfirmAll(false) })}
                >
                  {acceptAll.isPending ? "Accepting…" : `Accept all ${flagged.length} as they are`}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmAll(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" icon={<Check className="size-3.5" />} onClick={() => setConfirmAll(true)}>
                Accept all ({flagged.length})
              </Button>
            )}
          </div>
        )}
        {suite !== "flagged" && (
          <div className="flex gap-2">
            <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => rerun.mutate([suite])} disabled={rerun.isPending}>
              Re-run {suites.find((s) => s.id === suite)?.shortName}
            </Button>
            <Button size="sm" onClick={() => markReviewed.mutate([suite])}>
              Mark suite reviewed
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {list.map((r) => (
            <CriterionCard
              key={r.id}
              r={r}
              evaluationId={id}
              evidence={d.evidence.filter((e) => e.criterionId === r.criterionId)}
              sources={d.sources}
              published={d.publishedCriteria?.[r.criterionId] ?? null}
            />
          ))}
        </AnimatePresence>
        {!list.length && (
          <div className="rounded-2xl border border-dashed border-line-strong py-12 text-center text-sm text-muted">
            {suite === "flagged" ? "No open flags. Mark the suites reviewed, then publish from Releases." : "No criteria."}
          </div>
        )}
      </div>
    </>
  );
}

const allIds = suites.flatMap((s) => s.benchmarks.flatMap((b) => b.criteria.map((c) => c.id)));

function CriterionCard({
  r,
  evaluationId,
  evidence,
  sources,
  published,
}: {
  r: Result;
  evaluationId: string;
  evidence: Evidence[];
  sources: Data["sources"];
  published: { optionId: string | null; status: string } | null;
}) {
  const c = getCriterion(r.criterionId);
  const [choice, setChoice] = useState<string>(r.overrideStatus ? (r.overrideOptionId ?? r.overrideStatus) : (r.optionId ?? r.status));
  const [reason, setReason] = useState("");
  const [showEv, setShowEv] = useState(r.flags.length > 0);
  const save = useAdminAction(
    () => {
      const status = choice === "unknown" ? "unknown" : choice === "not_applicable" ? "not_applicable" : "answered";
      return api(`/api/admin/evaluations/${evaluationId}/criteria/${r.criterionId}`, {
        method: "PATCH",
        json: { status, optionId: status === "answered" ? choice : null, reason },
      });
    },
    { success: "Override saved", invalidate: [["evaluation", evaluationId], ["overview"]] },
  );
  const accept = useAdminAction(
    () => api(`/api/admin/evaluations/${evaluationId}/criteria/${r.criterionId}`, { method: "PATCH", json: { accept: true, reason } }),
    { success: "Accepted", invalidate: [["evaluation", evaluationId], ["overview"]] },
  );
  const clear = useAdminAction(() => api(`/api/admin/evaluations/${evaluationId}/criteria/${r.criterionId}`, { method: "PATCH", json: { clear: true } }), {
    success: "Override cleared",
    invalidate: [["evaluation", evaluationId], ["overview"]],
  });
  const label = (id: string | null, status?: string) =>
    status && status !== "answered" ? status.replace("_", " ") : (c.options.find((o) => o.id === id)?.label ?? "Unknown");
  const effectiveId = r.overrideStatus ? (r.overrideOptionId ?? r.overrideStatus) : (r.optionId ?? r.status);
  const changed = published && (published.optionId ?? published.status) !== (r.optionId ?? r.status);
  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 20 }}>
      <Panel className={cn(r.overrideStatus && "border-accent-line")}>
        <div className="p-4">
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{c.label}</span>
                <code className="font-mono text-[11px] text-faint">{c.id}</code>
                {c.highImpact && <Chip tone="accent">High impact</Chip>}
                {r.flags.map((f) => (
                  <Chip key={f} tone={FLAG_LABEL[f]?.tone ?? "neutral"}>
                    {FLAG_LABEL[f]?.text ?? f.replace(/_/g, " ")}
                  </Chip>
                ))}
              </div>
              <div className="mt-0.5 text-sm text-muted">{c.question}</div>
            </div>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr]">
            <div className="rounded-xl bg-bg-2 p-3">
              <div className="text-xs text-muted">Evaluator answer · confidence {r.confidence}</div>
              <div className="mt-0.5 text-sm font-medium">{label(r.optionId, r.status)}</div>
              <div className="mt-1 text-[13px] text-fg-3">{r.rationale}</div>
              {changed && <div className="mt-1.5 text-xs text-fair-fg">Published answer: {label(published!.optionId, published!.status)}</div>}
              {r.change && (
                <div className={cn("mt-1.5 text-xs", r.change.kind === "unexplained" ? "text-poor-fg" : "text-fg-3")}>
                  {r.change.kind === "protocol_change"
                    ? "Changed in this version"
                    : r.change.kind === "evidence_change"
                      ? "New evidence"
                      : r.change.kind === "rubric_change"
                        ? "Rubric changed"
                        : "Unexplained change"}
                  : {r.change.note}
                </div>
              )}
              {r.proposedOptionId && (
                <div className="mt-1.5 text-xs text-fair-fg">
                  {r.flags.includes("judge_disagreement") && !r.flags.includes("needs_quote")
                    ? `The judge's votes disagreed; the most cautious answer was "${label(r.proposedOptionId)}".`
                    : `The judge proposed "${label(r.proposedOptionId)}" but cited no verified quote.`}{" "}
                  <button type="button" className="underline" onClick={() => setChoice(r.proposedOptionId!)}>
                    Use it
                  </button>{" "}
                  if a source below supports it, with the source in the reason.
                </div>
              )}
              {r.votes.length > 1 && (
                <details className="mt-1.5 text-xs text-muted">
                  <summary className="cursor-pointer">Votes: {r.votes.map((v) => label(v.optionId, v.status)).join(" · ")}</summary>
                  <ul className="mt-1 flex flex-col gap-1">
                    {r.votes.map((v, i) => (
                      <li key={`${i}-${v.optionId}`}>
                        {v.pass === "codecheck" ? "After code check: " : v.pass === "skeptic" || (!v.pass && v.round === 2) ? "After skeptic: " : ""}
                        <span className="font-medium text-fg-2">{label(v.optionId, v.status)}</span>
                        {v.rationale ? `: ${v.rationale}` : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {r.searchLog?.searched.length ? (
                <div className="mt-1.5 text-xs text-muted">
                  Not found after searching{r.searchLog.codeChecked ? " (code checked)" : ""}: {r.searchLog.searched.slice(0, 8).join("; ")}
                  {r.searchLog.note ? `. ${r.searchLog.note}` : ""}
                </div>
              ) : null}
              {r.reviewNote && <div className="mt-1.5 text-xs text-muted">Accepted: {r.reviewNote}</div>}
              {r.overrideStatus && (
                <div className="mt-2 rounded-lg border border-accent-line bg-accent-soft px-2.5 py-1.5 text-xs text-accent-fg">
                  Override: {label(r.overrideOptionId, r.overrideStatus)} · {r.overrideReason}
                  <button type="button" onClick={() => clear.mutate()} className="ml-2 inline-flex items-center gap-1 underline">
                    <Undo2 className="size-3" /> clear
                  </button>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <select value={choice} onChange={(e) => setChoice(e.target.value)} className="h-9 rounded-lg border border-line bg-bg px-2 text-sm">
                {c.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label} ({o.points})
                  </option>
                ))}
                <option value="unknown">Unknown (lowest option)</option>
                {c.naAllowed && <option value="not_applicable">Not applicable</option>}
              </select>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required to override, shown publicly)" />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={reason.length < 3 || choice === effectiveId || save.isPending}
                  onClick={() => save.mutate(undefined, { onSuccess: () => setReason("") })}
                >
                  Override
                </Button>
                {r.flags.length > 0 && !r.overrideStatus && (
                  <Button
                    size="sm"
                    disabled={accept.isPending}
                    title="Keep this answer and clear its flags. A reason, if you typed one, is kept as an internal note."
                    onClick={() => accept.mutate(undefined, { onSuccess: () => setReason("") })}
                  >
                    Accept
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setShowEv((x) => !x)}>
                  {showEv ? "Hide" : "Show"} evidence ({evidence.length})
                </Button>
              </div>
            </div>
          </div>
          <AnimatePresence initial={false}>
            {showEv && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="mt-3 flex flex-col gap-2">
                  {evidence.map((e) => {
                    const src = sources.find((s) => s.id === e.sourceId);
                    return (
                      <div
                        key={e.id}
                        className={cn(
                          "rounded-lg border p-2.5 text-[13px]",
                          r.evidenceIds.includes(e.id) ? "border-line-strong" : "border-line-weak opacity-80",
                        )}
                      >
                        <div className="text-fg-2">“{e.quote}”</div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                          {e.verified ? (
                            <Chip tone="strong">
                              <BadgeCheck className="size-3" /> {e.verifyMethod}
                            </Chip>
                          ) : (
                            <Chip tone="fair">
                              <CircleHelp className="size-3" /> unverified
                            </Chip>
                          )}
                          <Chip tone={e.stance === "contradicts" ? "poor" : e.stance === "supports" ? "strong" : "neutral"}>{e.stance}</Chip>
                          <Chip>{e.sourceClass}</Chip>
                          <span>{e.createdByStage}</span>
                          <span className="truncate">· {src?.title ?? e.url}</span>
                          {(e.citedUrl || (src && !src.url.startsWith("note://") && !src.url.includes(".local/"))) && (
                            <a
                              href={sourceLink(e.citedUrl ?? src?.url ?? "") ?? undefined}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 hover:text-fg"
                            >
                              {hostOf(e.citedUrl ?? src?.url ?? "")} <ExternalLink className="size-3" />
                            </a>
                          )}
                        </div>
                        {e.claim && <div className="mt-1 text-xs text-muted">{e.claim}</div>}
                      </div>
                    );
                  })}
                  {!evidence.length && <div className="text-xs text-muted">No evidence recorded for this criterion.</div>}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </Panel>
    </motion.div>
  );
}

function CodeMapPanel({ map }: { map: CodeMap }) {
  const [open, setOpen] = useState(false);
  return (
    <Panel
      className="mb-4"
      title={`Code map · ${map.privileged.length} privileged functions · ${map.contracts.length} contracts · ${map.assets.length} assets`}
      actions={
        <Button size="sm" variant="ghost" onClick={() => setOpen((x) => !x)}>
          {open ? "Hide" : "Show"}
        </Button>
      }
    >
      {open && (
        <div className="flex flex-col gap-4 p-4 text-[13px]">
          {map.privileged.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-left">
                <thead>
                  <tr className="text-xs text-muted">
                    {["Contract", "Function", "Guard", "Holder", "Delay", "Effect"].map((h) => (
                      <th key={h} className="border-b border-line py-1.5 pr-3 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {map.privileged.map((p, i) => (
                    <tr key={`${p.contract}-${p.fn}-${i}`} className="align-top">
                      <td className="border-b border-line-weak py-1.5 pr-3 font-medium">{p.contract}</td>
                      <td className="border-b border-line-weak py-1.5 pr-3 font-mono text-xs">{p.fn}</td>
                      <td className="border-b border-line-weak py-1.5 pr-3">{p.guard}</td>
                      <td className="border-b border-line-weak py-1.5 pr-3">{p.holder}</td>
                      <td className="border-b border-line-weak py-1.5 pr-3">{p.delay}</td>
                      <td className="border-b border-line-weak py-1.5 pr-3 text-fg-3">{p.effect}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {map.assets.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted">Assets held and issuer powers</div>
              <ul className="mt-1 list-disc pl-5">
                {map.assets.map((a) => (
                  <li key={a.asset + a.address}>
                    <span className="font-medium">{a.asset}</span> {a.address && <code className="font-mono text-xs text-faint">{a.address}</code>}:{" "}
                    {a.issuerPowers}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {[
            ["Exit paths", map.exits],
            ["Changed in this version", map.versionChanges],
            ["Open questions", map.openQuestions],
          ].map(([title, items]) =>
            (items as string[]).length ? (
              <div key={title as string}>
                <div className="text-xs font-medium text-muted">{title as string}</div>
                <ul className="mt-1 list-disc pl-5">
                  {(items as string[]).map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </div>
      )}
    </Panel>
  );
}
