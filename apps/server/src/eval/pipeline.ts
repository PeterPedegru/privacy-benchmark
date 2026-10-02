import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { EvalSettings, KnowledgeBaseInfo } from "@pb/core";
import {
  type AdversaryId,
  criteria as allCriteria,
  BADGE_DRIVING,
  type CriterionDef,
  consistencyConflicts,
  criterionChangedSince,
  diffAnswers,
  getSuite,
  isFavorable,
  isHighScrutiny,
  lowestOption,
  matrixConflicts,
  optionLabel,
  relatedCriteria,
  type SuiteId,
  suites,
} from "@pb/rubric";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { type DB, query, schema } from "../db/index.ts";
import type { SearchLog } from "../db/schema.ts";
import { costCapFor, env, type Stage as ModelStage, modelFor } from "../env.ts";
import { newId } from "../lib/ids.ts";
import {
  addUsage,
  anthropic,
  type CallScope,
  callScope,
  capsFor,
  type Effort,
  emptyUsage,
  LlmAbortedError,
  llmCall,
  maxOutputFor,
  mergeUsage,
  modelExtras,
  scopeSignal,
  stageEffort,
  stageModel,
  type Usage,
} from "../lib/llm.ts";
import { redact } from "../lib/redact.ts";
import { RUNNER_ID } from "../lib/runner.ts";
import { isEvidencing } from "../services/coverage.ts";
import { syncEvidenceClasses } from "../services/evidence-classes.ts";
import { describeStats, KbRefreshAbortedError, kbIsStale, refreshKnowledgeBase } from "../services/kb.ts";
import { normalizeText } from "../services/quotes.ts";
import { answerMapFor, loadEvaluation } from "../services/snapshots.ts";
import { ABSENCE_POLICY, isCodeCheckable, OFF_CHAIN_POWERS } from "./absence.ts";
import { BudgetError, CancelledError, RefusalError, runAgent } from "./agent.ts";
import { ClaudeCodeLimitError, llmBackend, structuredViaClaudeCode } from "./claude-code.ts";
import { type Emit, makeEmitter } from "./events.ts";
import { type JudgeAnswer, judgeSuite, majority, type Validated, validateAnswer } from "./judge.ts";
import {
  CHANGE_SYSTEM,
  CODE_MAP_SYSTEM,
  CODE_SYSTEM,
  CODECHECK_SYSTEM,
  MECHANICS_SYSTEM,
  projectBlock,
  promptHashes,
  releaseNotesBlock,
  renderSuiteRubric,
  researchSystem,
  SCOUT_SYSTEM,
  SKEPTIC_SYSTEM,
  type Supersession,
  versionBlock,
} from "./prompts.ts";
import { type ChallengeOutcome, runTool, type ToolContext, type ToolName, toolDefinitions } from "./tools.ts";

export type Mode = "quick" | "standard" | "deep";

export const MODES: Record<
  Mode,
  {
    scoutCalls: number;
    scoutSearches: number;
    /** The code auditor (contracts and privileged powers). */
    codeCalls: number;
    /** The mechanics auditor (how the system works end to end), run alongside the code auditor. */
    mechanicsCalls: number;
    /** Per suite: settling unknowns from the code and onchain state after judging. */
    codeCheckCalls: number;
    researchCalls: number;
    /** Per criterion in the suite: a suite's budget is the larger of researchCalls and this times its criteria. */
    researchCallsPerCriterion: number;
    researchSearches: number;
    /** Targeted research passes for criteria still missing evidence after the first pass. */
    gapFillRounds: number;
    /** Suite coverage below which the gap-fill runs (1: until every criterion is settled). */
    gapFillThreshold: number;
    /** Criteria resting only on marketing pages or search attestations count as missing for the gap-fill. */
    gapFillStrict: boolean;
    /** Per criterion the code check handles; its budget is the larger of codeCheckCalls and this times them. */
    codeCheckCallsPerCriterion: number;
    /** Also code-check answered high-scrutiny criteria whose decisive evidence holds no code or onchain record. */
    codeCheckAnswered: boolean;
    skepticCalls: number;
    /** Per challenged answer; each suite's skeptic gets the larger of skepticCalls and this times its targets. */
    skepticCallsPerTarget: number;
    skepticSearches: number;
    /** A second skeptic pass over answers the first left not examined. */
    skepticSecondPass: boolean;
    votesHighImpact: number;
    votesOther: number;
    /** Votes on badge-deciding criteria (the answers that move a project's badges and caps). */
    votesBadge: number;
    /** Every vote is cast, not only a tie-breaker when the first two disagree. */
    allVotes: boolean;
    skepticAllFavorable: boolean;
  }
> = {
  quick: {
    scoutCalls: 12,
    scoutSearches: 4,
    codeCalls: 20,
    mechanicsCalls: 15,
    codeCheckCalls: 8,
    codeCheckCallsPerCriterion: 0,
    codeCheckAnswered: false,
    researchCalls: 10,
    researchCallsPerCriterion: 0,
    researchSearches: 3,
    gapFillRounds: 1,
    gapFillThreshold: 0.8,
    gapFillStrict: false,
    skepticCalls: 8,
    skepticCallsPerTarget: 0,
    skepticSearches: 3,
    skepticSecondPass: false,
    votesHighImpact: 1,
    votesOther: 1,
    votesBadge: 1,
    allVotes: false,
    skepticAllFavorable: false,
  },
  standard: {
    scoutCalls: 25,
    scoutSearches: 8,
    codeCalls: 45,
    mechanicsCalls: 35,
    codeCheckCalls: 16,
    codeCheckCallsPerCriterion: 0,
    codeCheckAnswered: false,
    researchCalls: 22,
    researchCallsPerCriterion: 0,
    researchSearches: 6,
    gapFillRounds: 1,
    gapFillThreshold: 0.8,
    gapFillStrict: false,
    skepticCalls: 14,
    skepticCallsPerTarget: 0,
    skepticSearches: 6,
    skepticSecondPass: false,
    votesHighImpact: 3,
    votesOther: 1,
    votesBadge: 3,
    allVotes: false,
    skepticAllFavorable: false,
  },
  // Deep is the mode for published results: evaluations run about weekly, locally, on the reasoning model at xhigh
  // effort, so each is exhaustive. Budgets scale with what each stage has to settle.
  deep: {
    scoutCalls: 100,
    scoutSearches: 30,
    codeCalls: 250,
    mechanicsCalls: 220,
    codeCheckCalls: 60,
    codeCheckCallsPerCriterion: 8,
    codeCheckAnswered: true,
    researchCalls: 60,
    researchCallsPerCriterion: 5,
    researchSearches: 30,
    gapFillRounds: 3,
    gapFillThreshold: 1,
    gapFillStrict: true,
    skepticCalls: 40,
    skepticCallsPerTarget: 4,
    skepticSearches: 25,
    skepticSecondPass: true,
    votesHighImpact: 3,
    votesOther: 3,
    votesBadge: 5,
    allVotes: true,
    skepticAllFavorable: true,
  },
};

/**
 * The tools each agent stage gets. The API accepts at most 20 strict tools per request (a test enforces it), so
 * each list is chosen deliberately: no stage needs everything.
 */
export const STAGE_TOOLS = {
  scout: [
    "kb_overview",
    "search_sources",
    "exa_search",
    "news_search",
    "x_posts",
    "fetch_page",
    "read_source",
    "list_sources",
    "github_repo",
    "github_list_files",
    "github_read_file",
    "sourcify_contract",
    "defillama_protocol",
    "l2beat_scaling",
    "l2beat_privacy",
  ],
  code: [
    "kb_overview",
    "search_sources",
    "read_source",
    "list_sources",
    "github_repo",
    "github_list_files",
    "github_read_file",
    "github_search_code",
    "sourcify_contract",
    "evm_inspect",
    "evm_read",
    "fetch_page",
    "record_evidence",
    "record_absence",
  ],
  research: [
    "kb_overview",
    "search_sources",
    "read_source",
    "exa_search",
    "news_search",
    "x_posts",
    "evm_inspect",
    "evm_read",
    "fetch_page",
    "github_repo",
    "github_list_files",
    "github_read_file",
    "github_search_code",
    "sourcify_contract",
    "defillama_protocol",
    "l2beat_scaling",
    "l2beat_privacy",
    "record_evidence",
    "record_absence",
    "record_search",
  ],
  codecheck: [
    "kb_overview",
    "search_sources",
    "read_source",
    "list_sources",
    "github_repo",
    "github_list_files",
    "github_read_file",
    "github_search_code",
    "sourcify_contract",
    "evm_inspect",
    "evm_read",
    "l2beat_scaling",
    "record_evidence",
    "record_absence",
    "record_search",
  ],
  skeptic: [
    "search_sources",
    "read_source",
    "fetch_page",
    "github_read_file",
    "github_search_code",
    "evm_inspect",
    "evm_read",
    "exa_search",
    "news_search",
    "x_search",
    "x_posts",
    "record_evidence",
    "report_challenge",
  ],
} as const satisfies Record<string, readonly ToolName[]>;

/**
 * With knowledge bases built locally, an evaluation needs one that's ready, for its version, and not being rebuilt.
 * Otherwise it fails (resumable), saying what to run.
 */
function assertKbReady(p: { kbStatus: string; kbVersionId: string | null }, slug: string, version: { id: string; label: string; tag: string | null } | null) {
  const cmd = `railway run --service bench-cli -- pnpm bench kb ${slug}${version?.tag ? ` --version ${version.tag}` : ""}`;
  if (p.kbStatus === "refreshing") throw new Error(`The knowledge base for ${slug} is being rebuilt; resume this evaluation when it's done.`);
  if (p.kbStatus !== "ready" || (p.kbVersionId ?? null) !== (version?.id ?? null))
    throw new Error(
      `There's no ready knowledge base for ${slug}${version ? ` ${version.label}` : ""}. Knowledge bases are built locally: run \`${cmd}\`, then resume this evaluation.`,
    );
}

/** Deletes evidence a stage recorded that no answer cites (a resumed stage starts clean, R3-REL-5, R4-1). */
async function deleteUncitedEvidence(db: DB, evaluationId: string, stages: string[]) {
  await db.execute(
    sql`DELETE FROM evidence WHERE evaluation_id = ${evaluationId} AND created_by_stage IN (${sql.join(
      stages.map((s) => sql`${s}`),
      sql`, `,
    )})
      AND id NOT IN (
        SELECT jsonb_array_elements_text(r.evidence_ids || r.decisive_evidence_ids) FROM criterion_results r WHERE r.evaluation_id = ${evaluationId}
      )`,
  );
}

/** A stop that must end the stage: cancel, the cost cap, an aborted call, or the evaluation's scope aborting. */
function isStop(e: unknown): boolean {
  // A usage limit stops everything after it too: carrying on would only fail the next session.
  return (
    e instanceof CancelledError || e instanceof BudgetError || e instanceof LlmAbortedError || e instanceof ClaudeCodeLimitError || !!scopeSignal()?.aborted
  );
}

/** Suite coverage below this (or any high-scrutiny criterion missing) triggers a targeted gap-fill pass. */
const GAP_FILL_THRESHOLD = 0.8;
/** Sources too weak to settle a criterion on their own in an exhaustive run: the project's marketing, and code-search attestations. */
const isWeakEvidence = (e: EvidenceRow) => e.sourceClass === "marketing" || e.verifyNote === "search attestation";

export const STAGES = ["ingest", "scout", "code", "research", "judge", "codecheck", "verify", "score"] as const;
type Stage = (typeof STAGES)[number];

type EvalRow = typeof schema.evaluations.$inferSelect;
type EvidenceRow = typeof schema.evidence.$inferSelect;

export interface CodeMap {
  contracts: { name: string; address: string; chainId: number | null; role: string; upgradeable: string }[];
  privileged: { contract: string; fn: string; guard: string; holder: string; delay: string; effect: string }[];
  assets: { asset: string; address: string; issuerPowers: string }[];
  exits: string[];
  versionChanges: string[];
  openQuestions: string[];
  // The mechanics auditor's model (absent in maps made before it existed).
  actors?: { actor: string; can: string; cannot: string; sees: string }[];
  lifecycle?: string[];
  inclusion?: string[];
  fees?: string[];
  clientDefaults?: string[];
}

type Progress = {
  research?: string[];
  judge?: string[];
  /** Suites whose unknowns the code check has examined. */
  codecheck?: string[];
  coverageNotes?: string;
  codeNotes?: string;
  codeMap?: CodeMap;
  /** Suites whose research produced no verified evidence at all (their criteria are not_researched). */
  unresearched?: string[];
  knowledgeBase?: KnowledgeBaseInfo;
};

/** Effort per stage. Deep runs are the published ones, run about weekly: every judgment-bearing stage thinks hardest. */
const EFFORT: Record<"deep" | "other", Record<string, Effort>> = {
  other: { scout: "high", code: "high", research: "high", judge: "high", skeptic: "high", changes: "medium", codemap: "low", summary: "medium" },
  deep: { scout: "xhigh", code: "xhigh", research: "xhigh", judge: "xhigh", skeptic: "xhigh", changes: "xhigh", codemap: "xhigh", summary: "xhigh" },
};
const SETTINGS_STAGES = ["scout", "code", "research", "judge", "skeptic", "changes", "codemap", "summary"] as const satisfies readonly ModelStage[];

/**
 * An evaluation's settings, recorded on it so a resume runs the same way. `model` puts every stage on one model
 * (the local CLI runs everything on the reasoning model), `effort` overrides every stage's effort, and `costCapUsd`
 * replaces the mode's cap.
 */
export function evalSettings(mode: Mode, o: { model?: string; effort?: Effort; costCapUsd?: number; backend?: "api" | "claude-code" } = {}): EvalSettings {
  const m = MODES[mode];
  const base = EFFORT[mode === "deep" ? "deep" : "other"];
  const models = Object.fromEntries(SETTINGS_STAGES.map((s) => [s, o.model ?? modelFor(s)]));
  return {
    mode,
    models,
    effort: Object.fromEntries(SETTINGS_STAGES.map((s) => [s, capsFor(models[s]!).effort ? (o.effort ?? base[s]!) : "n/a"])),
    ...(o.costCapUsd ? { costCapUsd: o.costCapUsd } : {}),
    ...(o.backend ? { backend: o.backend } : {}),
    votesHighImpact: m.votesHighImpact,
    votesOther: m.votesOther,
    maxToolCalls: {
      scout: m.scoutCalls,
      code: m.codeCalls,
      mechanics: m.mechanicsCalls,
      research: m.researchCalls,
      codecheck: m.codeCheckCalls,
      skeptic: m.skepticCalls,
    },
    promptHashes: promptHashes(),
    evidenceCutoff: new Date().toISOString().slice(0, 10),
    codeCheck: true,
  };
}

function suitesFor(e: EvalRow): SuiteId[] {
  const f = e.suiteFilter;
  return f?.length ? suites.filter((s) => f.includes(s.id)).map((s) => s.id) : suites.map((s) => s.id);
}

/** Each adversary-matrix row is written by exactly one suite: the first that covers that adversary. */
const MATRIX_OWNER: Partial<Record<AdversaryId, SuiteId>> = {};
for (const s of suites) for (const a of s.adversaries) MATRIX_OWNER[a] ??= s.id;
const ownedAdversaries = (suiteId: SuiteId) => getSuite(suiteId).adversaries.filter((a) => MATRIX_OWNER[a] === suiteId);

function suiteCriteria(suiteId: SuiteId): CriterionDef[] {
  return getSuite(suiteId).benchmarks.flatMap((b) => b.criteria);
}

/** Criteria with at least one piece of evidence that can settle them (see isEvidencing). */
function evidencedCriteria(evidence: EvidenceRow[]): Set<string> {
  return new Set(evidence.filter(isEvidencing).map((e) => e.criterionId));
}

/**
 * Runs (or resumes) one evaluation. Every model call inside runs in this evaluation's call scope: the abort signal
 * stops in-flight calls on cancel or when a sibling suite fails, and reservations keep parallel calls under the cost
 * cap. It returns only after every suite it started has settled, so "running" means running (R3-REL-2).
 */
export async function runEvaluation(
  db: DB,
  evaluationId: string,
  opts: {
    signal?: AbortSignal;
    /** Whether this process may build the knowledge base (the local CLI does; production, with KB_BUILD=local, doesn't). */
    buildKb?: boolean;
  } = {},
): Promise<void> {
  const buildKb = opts.buildKb ?? env.kbBuild === "server";
  const ctl = new AbortController();
  if (opts.signal?.aborted) ctl.abort(opts.signal.reason);
  else opts.signal?.addEventListener("abort", () => ctl.abort(opts.signal!.reason), { once: true });
  const initial = await loadEvaluation(db, evaluationId);
  if (!initial) throw new Error(`Evaluation ${evaluationId} not found`);
  const { project, version } = initial;
  const mode = (initial.evaluation.mode as Mode) in MODES ? (initial.evaluation.mode as Mode) : "standard";
  const m = MODES[mode];
  const golden = !!(initial.evaluation.settings as { goldenEval?: boolean }).goldenEval;
  // The evaluation date is when evidence gathering starts (not when the run was queued); kept across resumes.
  if (!initial.evaluation.completedStages.includes("ingest")) {
    const settings = { ...(initial.evaluation.settings as Record<string, unknown>), evidenceCutoff: new Date().toISOString().slice(0, 10) };
    await db.update(schema.evaluations).set({ settings }).where(eq(schema.evaluations.id, evaluationId));
    initial.evaluation.settings = settings as never;
  }
  const evaluationDate = (initial.evaluation.settings as { evidenceCutoff?: string }).evidenceCutoff ?? new Date().toISOString().slice(0, 10);
  const emit = makeEmitter(db, evaluationId, initial.evaluation.runId);
  const usage = emptyUsage();
  // Carried across resumes: the cost and the token counters.
  const stored = (initial.evaluation.usage ?? {}) as Partial<Usage>;
  const baseUsage: Usage = {
    ...emptyUsage(),
    input: stored.input ?? 0,
    output: stored.output ?? 0,
    cacheRead: stored.cacheRead ?? 0,
    cacheWrite: stored.cacheWrite ?? 0,
    webSearches: stored.webSearches ?? 0,
    calls: stored.calls ?? 0,
    costUsd: initial.evaluation.costUsd,
  };
  // A rerun gets its own allowance on top of what was already spent (R4-2): otherwise a rerun near the cap deletes
  // a suite's evidence, fails at the cap, and fails again on resume.
  const rerun = initial.evaluation.settings as {
    capBase?: number;
    capScale?: number;
    costCapUsd?: number;
    models?: Record<string, string>;
    effort?: Record<string, string>;
    backend?: string;
  };
  // The evaluation's own cap (set from the CLI) replaces the mode's. Through Claude Code nothing is billed to the API,
  // so there's no cap unless one was set.
  const modeCap = rerun.costCapUsd ?? (rerun.backend === "claude-code" ? Number.POSITIVE_INFINITY : costCapFor(mode));
  const capUsd = rerun.capBase !== undefined ? rerun.capBase + modeCap * (rerun.capScale ?? 1) : modeCap;
  let reserved = 0;
  const scope: CallScope = {
    signal: ctl.signal,
    models: rerun.models,
    effort: rerun.effort,
    backend: rerun.backend,
    reserve(est) {
      if (baseUsage.costUsd + usage.costUsd + reserved + est > capUsd) throw new BudgetError(`Cost cap of $${capUsd} (${mode} mode) reached`);
      reserved += est;
      return () => {
        reserved -= est;
      };
    },
  };
  // Parallel tasks: the first failure aborts the others, and nothing returns until all have settled.
  const settleAll = async <T>(tasks: (() => Promise<T>)[]): Promise<T[]> => {
    let first: { e: unknown } | null = null;
    const results = await Promise.all(
      tasks.map((t) =>
        t().catch((e) => {
          if (!first) {
            first = { e };
            ctl.abort((e as Error)?.message ?? String(e));
          }
        }),
      ),
    );
    if (first) throw (first as { e: unknown }).e;
    return results as T[];
  };

  const status = async () => (await db.select({ s: schema.evaluations.status }).from(schema.evaluations).where(eq(schema.evaluations.id, evaluationId)))[0]?.s;
  const persistUsage = async () => {
    const total = mergeUsage(baseUsage, usage);
    await db
      .update(schema.evaluations)
      .set({
        costUsd: total.costUsd,
        usage: {
          input: total.input,
          output: total.output,
          cacheRead: total.cacheRead,
          cacheWrite: total.cacheWrite,
          webSearches: total.webSearches,
          calls: total.calls,
        },
      })
      .where(eq(schema.evaluations.id, evaluationId));
  };
  // Checked before every model call: stops on cancel, on a failure elsewhere in this evaluation (so parallel suites
  // don't keep spending into a dead run), and at the cost cap. Usage is persisted each time, so a crash loses at
  // most one call's metering.
  /** Throws when the evaluation was stopped: aborted, cancelled, or no longer running. */
  const ensureRunning = async () => {
    if (ctl.signal.aborted) throw new CancelledError(`Stopped: ${String(ctl.signal.reason ?? "aborted")}`);
    const [row] = await db
      .select({ s: schema.evaluations.status, runner: schema.evaluations.runnerId })
      .from(schema.evaluations)
      .where(eq(schema.evaluations.id, evaluationId));
    if (row?.s === "cancelled") throw new CancelledError("Cancelled");
    if (row?.s !== "running") throw new CancelledError(`Stopped: evaluation is ${row?.s}`);
    // Another process took it over after this one stopped reporting (it was presumed dead): this one must stop.
    if (row.runner && row.runner !== RUNNER_ID) throw new CancelledError("Stopped: another process took over this evaluation");
  };
  const guard = {
    // One round trip before each model call: usage written and the evaluation's state read back together.
    async check() {
      if (ctl.signal.aborted) throw new CancelledError(`Stopped: ${String(ctl.signal.reason ?? "aborted")}`);
      const total = mergeUsage(baseUsage, usage);
      const [row] = await db
        .update(schema.evaluations)
        .set({
          costUsd: total.costUsd,
          usage: {
            input: total.input,
            output: total.output,
            cacheRead: total.cacheRead,
            cacheWrite: total.cacheWrite,
            webSearches: total.webSearches,
            calls: total.calls,
          },
        })
        .where(eq(schema.evaluations.id, evaluationId))
        .returning({ s: schema.evaluations.status, runner: schema.evaluations.runnerId });
      if (row?.s === "cancelled") throw new CancelledError("Cancelled");
      if (row?.s !== "running") throw new CancelledError(`Stopped: evaluation is ${row?.s}`);
      if (row.runner && row.runner !== RUNNER_ID) throw new CancelledError("Stopped: another process took over this evaluation");
      if (baseUsage.costUsd + usage.costUsd > capUsd) throw new BudgetError(`Cost cap of $${capUsd} (${mode} mode) reached`);
    },
  };
  const progress = async (): Promise<Progress> =>
    ((await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, evaluationId)))[0]?.settings ?? {}) as Progress;
  // Progress writes are single statements: parallel suites update settings at the same time, and a read-modify-write
  // would lose one suite's update to another's.
  const saveProgress = async (patch: Progress) => {
    await db.execute(sql`UPDATE evaluations SET settings = settings || ${JSON.stringify(patch)}::jsonb WHERE id = ${evaluationId}`);
  };
  /** Adds an item to a progress list (research, judge, codecheck, unresearched) once. */
  const addToProgress = async (key: "research" | "judge" | "codecheck" | "unresearched", item: string) => {
    await db.execute(
      sql`UPDATE evaluations SET settings = jsonb_set(settings, ${`{${key}}`}::text[],
          (SELECT coalesce(jsonb_agg(DISTINCT v ORDER BY v), '[]'::jsonb) FROM jsonb_array_elements_text(coalesce(settings->${key}, '[]'::jsonb) || jsonb_build_array(${item}::text)) AS t(v)))
        WHERE id = ${evaluationId}`,
    );
  };
  /** Removes an item from a progress list. */
  const removeFromProgress = async (key: "unresearched", item: string) => {
    await db.execute(
      sql`UPDATE evaluations SET settings = jsonb_set(settings, ${`{${key}}`}::text[], coalesce(settings->${key}, '[]'::jsonb) - ${item}::text)
        WHERE id = ${evaluationId}`,
    );
  };
  // A stage is done only if nothing stopped it: a swallowed abort must not mark it complete (R4-5). Finishing a
  // stage also ends a run of restarts, so the crash-loop counter starts again (R4-6).
  const markStage = async (stage: Stage) => {
    await persistUsage();
    await ensureRunning();
    await db.execute(
      sql`UPDATE evaluations SET
          completed_stages = CASE WHEN completed_stages ? ${stage} THEN completed_stages ELSE completed_stages || jsonb_build_array(${stage}::text) END,
          settings = settings || '{"interruptions": 0}'::jsonb
        WHERE id = ${evaluationId}`,
    );
    await persistUsage();
  };
  const setStage = async (stage: Stage) => await db.update(schema.evaluations).set({ stage }).where(eq(schema.evaluations.id, evaluationId));
  const done = async (stage: Stage) =>
    ((await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, evaluationId)))[0]?.completedStages ?? []).includes(stage);

  const ctx = (stage: string, allowed: CriterionDef[]): ToolContext => ({
    db,
    evaluationId,
    project,
    version,
    stage,
    allowedCriteria: new Set(allowed.map((c) => c.id)),
    emit,
    evidenceCount: { n: 0 },
    excludeEditorNotes: golden,
  });
  // Golden-set runs leave out the editor-written description: it was written with the answers in mind.
  const projectInfo = projectBlock(project, { description: !golden });
  // A newer tracked release replaced the pinned one: evaluate the pinned version as it was while live (R3-JDG-10).
  const next = version?.releasedAt
    ? (
        await db
          .select({ label: schema.projectVersions.label, releasedAt: schema.projectVersions.releasedAt })
          .from(schema.projectVersions)
          .where(
            and(
              eq(schema.projectVersions.projectId, project.id),
              eq(schema.projectVersions.status, "tracked"),
              gt(schema.projectVersions.releasedAt, version.releasedAt),
            ),
          )
          .orderBy(asc(schema.projectVersions.releasedAt))
      )[0]
    : undefined;
  const supersededBy = next?.releasedAt ? { label: next.label, releasedAt: next.releasedAt } : null;
  const versionInfo = `${versionBlock(project, version, evaluationDate, supersededBy)}${releaseNotesBlock(version) ? `\n\n${releaseNotesBlock(version)}` : ""}`;
  const suiteIds = suitesFor(initial.evaluation);
  const judgeCtx: JudgeCtx = { db, evaluationId, m, usage, emit, guard, evaluationDate, supersededBy };

  await callScope.run(scope, async () => {
    try {
      // ---------- ingest: build or refresh the project's knowledge base ----------
      if (!(await done("ingest"))) {
        await setStage("ingest");
        const fresh = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!;
        if (!buildKb) {
          // Knowledge bases are built locally (KB_BUILD=local): this process uses the one there is, for this version.
          assertKbReady(fresh, project.slug, version);
          const age = fresh.kbRefreshedAt ? (Date.now() - Date.parse(fresh.kbRefreshedAt)) / 86_400_000 : 0;
          emit(
            age > env.kb.staleDays ? "warn" : "success",
            "ingest",
            `Using the knowledge base built ${age >= 1 ? `${Math.round(age)} day(s) ago` : "today"} (${describeStats(fresh.kbStats as never)})${age > env.kb.staleDays ? `; rebuild it with \`pnpm bench kb ${project.slug}\` for fresher sources` : ""}`,
          );
        } else if (kbIsStale(fresh, version?.id ?? null)) {
          emit("info", "ingest", `Building the knowledge base for ${project.name}${version ? ` · ${version.label}` : ""}`);
          try {
            // Cancel and shutdown reach the refresh too (R4-17).
            const stats = await refreshKnowledgeBase(db, project.id, {
              versionId: version?.id ?? null,
              progress: (msg) => emit("info", "ingest", msg),
              signal: ctl.signal,
              full: opts.buildKb === true,
            });
            emit("success", "ingest", `Knowledge base: ${describeStats(stats)}`);
          } catch (e) {
            if (e instanceof KbRefreshAbortedError || isStop(e)) throw e;
            emit("warn", "ingest", `Knowledge-base refresh failed (${(e as Error).message}); continuing with stored sources and live fetching`);
          }
        } else {
          emit("success", "ingest", `Knowledge base is fresh (${describeStats(fresh.kbStats as never)}); skipping refresh`);
        }
        const after = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!;
        if (after.kbError) emit("warn", "ingest", `Some knowledge-base lanes failed: ${after.kbError.split("\n").slice(0, 3).join("; ")}`);
        await saveProgress({ knowledgeBase: { ...(after.kbStats as Omit<KnowledgeBaseInfo, "refreshedAt">), refreshedAt: after.kbRefreshedAt } });
        await markStage("ingest");
      }

      // ---------- scout ----------
      if (!(await done("scout"))) {
        await setStage("scout");
        emit("info", "scout", `Scouting sources for ${project.name}${version ? ` · ${version.label}` : ""}`);
        const c0 = ctx("scout", []);
        for (const url of [...new Set([project.websiteUrl, version?.sourceUrl].filter((u): u is string => !!u))]) {
          try {
            await runTool("fetch_page", { url }, c0);
          } catch (e) {
            emit("warn", "scout", `Couldn't fetch ${url}: ${(e as Error).message}`);
          }
        }
        const res = await runAgent({
          model: stageModel("scout"),
          system: SCOUT_SYSTEM,
          user: `${projectInfo}\n\n${versionInfo}\n\nBudget: about ${m.scoutCalls} tool calls. Start with kb_overview.`,
          tools: toolDefinitions(STAGE_TOOLS.scout, []),
          webSearchUses: m.scoutSearches,
          maxToolCalls: m.scoutCalls,
          effort: stageEffort("scout", "high"),
          ctx: c0,
          usage,
          guard,
        });
        // The scout's incidents and audits section comes late in its notes: keep them whole (up to 40k).
        await saveProgress({ coverageNotes: res.text.slice(0, 40_000) });
        emit("success", "scout", `Scout finished with ${res.toolCalls} tool calls`);
        await markStage("scout");
      }

      // ---------- code: the system model from code and onchain state (reasoning tier) ----------
      // Two auditors in parallel: one maps contracts and privileged powers, the other how the system works end to
      // end (transaction flow, who sees and orders what, inclusion and escape paths, fees, client defaults). Every
      // later stage builds on their model.
      if (!(await done("code"))) {
        await setStage("code");
        emit("info", "code", "Auditing code and onchain state: privileged powers, and how the system works");
        const auditorBrief = `${projectInfo}\n\n${versionInfo}\n\nScout's notes (coverage, repositories, deployed addresses, assets, incidents):\n${(await progress()).coverageNotes ?? "(none)"}`;
        const audit = (stage: "code" | "code.mechanics", system: string, calls: number, focus: string) => {
          const cc = ctx(stage, allCriteria);
          return runAgent({
            model: stageModel("code"),
            system,
            user: `${auditorBrief}\n\n${focus}\n\nBudget: about ${calls} tool calls (recording evidence doesn't count). Start with kb_overview, then the repository maps.`,
            tools: toolDefinitions(
              STAGE_TOOLS.code,
              allCriteria.map((x) => x.id),
            ),
            webSearchUses: 0,
            maxToolCalls: calls,
            effort: stageEffort("code", "high"),
            ctx: cc,
            usage,
            guard,
          }).then((res) => ({ res, records: cc.evidenceCount.n }));
        };
        type Audit = { res: Awaited<ReturnType<typeof runAgent>>; records: number };
        const [powers, mechanics] = (await settleAll<Audit>([
          () => audit("code", CODE_SYSTEM, m.codeCalls, "Your part: contracts, privileged powers, role holders, delays and assets."),
          () =>
            audit(
              "code.mechanics",
              MECHANICS_SYSTEM,
              m.mechanicsCalls,
              "Your part: how the system works end to end. Another auditor is mapping privileged functions and role holders; don't duplicate that.",
            ),
        ])) as [Audit, Audit];
        // Keep the end of long notes: the structured summary each prompt asks for comes last.
        const tail = (t: string, n: number) => (t.length > n ? `…${t.slice(-n)}` : t);
        // Whole notes (up to 100k each): the start of the mechanics notes holds the actors and the lifecycle.
        const notes = `## Contracts and privileged powers\n${tail(powers.res.text, 100_000)}\n\n## How the system works\n${tail(mechanics.res.text, 100_000)}`;
        await saveProgress({ codeNotes: notes });
        emit(
          "success",
          "code",
          `Code audit finished: ${powers.records + mechanics.records} evidence records, ${powers.res.toolCalls + mechanics.res.toolCalls} tool calls`,
        );
        try {
          await guard.check();
          const map = await structureCodeMap(notes, usage);
          if (map) {
            await saveProgress({ codeMap: map });
            emit("info", "code", `Code map: ${map.contracts.length} contracts, ${map.privileged.length} privileged functions, ${map.assets.length} assets`);
          }
        } catch (e) {
          if (isStop(e)) throw e;
          emit("warn", "code", `Couldn't structure the code map (${(e as Error).message}); researchers get the prose notes`);
        }
        await markStage("code");
      }

      // ---------- research (suites in parallel), with targeted gap-fill ----------
      if (!(await done("research"))) {
        await setStage("research");
        // The knowledge base may have moved to another version (a newer evaluation's ingest, an editor refresh)
        // since this one's ingest: research must quote this version's sources (R3-REL-3).
        const kbNow = (await db.select().from(schema.projects).where(eq(schema.projects.id, project.id)))[0]!;
        if (!buildKb) assertKbReady(kbNow, project.slug, version);
        else if ((kbNow.kbVersionId ?? null) !== (version?.id ?? null) || kbNow.kbStatus !== "ready") {
          emit("warn", "ingest", "The knowledge base no longer matches this evaluation's version; rebuilding it before research");
          try {
            await refreshKnowledgeBase(db, project.id, {
              versionId: version?.id ?? null,
              progress: (msg) => emit("info", "ingest", msg),
              signal: ctl.signal,
              full: opts.buildKb === true,
            });
          } catch (e) {
            if (e instanceof KbRefreshAbortedError || isStop(e)) throw e;
            emit("warn", "ingest", `Knowledge-base refresh failed (${(e as Error).message}); continuing with stored sources`);
          }
        }
        const finished = new Set((await progress()).research ?? []);
        await settleAll(
          suiteIds
            .filter((s) => !finished.has(s))
            .map((suiteId) => async () => {
              const suite = getSuite(suiteId);
              const crit = suiteCriteria(suiteId);
              const stage = `research.${suiteId}`;
              // A suite being (re)researched starts clean: earlier research evidence for it would be duplicated.
              await db
                .delete(schema.evidence)
                .where(and(eq(schema.evidence.evaluationId, evaluationId), inArray(schema.evidence.createdByStage, [stage, `${stage}.gap`])));
              // Its code-check logs go too: the code check runs again on whatever this research leaves unsettled.
              await db
                .delete(schema.searchLogs)
                .where(
                  and(
                    eq(schema.searchLogs.evaluationId, evaluationId),
                    inArray(schema.searchLogs.createdByStage, [stage, `${stage}.gap`, `codecheck.${suiteId}`]),
                  ),
                );
              const c = ctx(stage, crit);
              emit("info", stage, `Researching ${suite.name}`);
              const tools = STAGE_TOOLS.research;
              // Larger suites get proportionally more research (deep: 5 calls per criterion, at least 60).
              const budget = Math.max(m.researchCalls, m.researchCallsPerCriterion * crit.length);
              const brief = `${projectInfo}\n\n${versionInfo}\n\nScout's coverage notes:\n${(await progress()).coverageNotes ?? "(none)"}\n\nCode auditor's map (contracts, privileged powers, holders, delays, assets, version changes):\n${(await progress()).codeNotes ?? "(none)"}`;
              const research = (agentCtx: ToolContext, user: string) =>
                runAgent({
                  model: stageModel("research"),
                  system: researchSystem(suiteId),
                  user,
                  tools: toolDefinitions(
                    tools,
                    crit.map((x) => x.id),
                  ),
                  webSearchUses: m.researchSearches,
                  maxToolCalls: budget,
                  effort: stageEffort("research", "high"),
                  ctx: agentCtx,
                  usage,
                  guard,
                });
              const opening = `${brief}\n\nResearch budget: about ${budget} calls (recording evidence doesn't count). Search the knowledge base first, and record evidence as you go.`;
              let res: Awaited<ReturnType<typeof research>> | null = null;
              // A refusal is retried once (it's often a classifier false positive on security material); a second
              // costs this suite, not the whole evaluation: its criteria are left not researched.
              for (let attempt = 1; attempt <= 2 && !res; attempt++) {
                try {
                  res = await research(c, opening);
                } catch (e) {
                  if (!(e instanceof RefusalError)) throw e;
                  if (attempt === 1) {
                    emit("warn", stage, `${suite.name}: the model declined (${e.message}); retrying once`);
                    continue;
                  }
                  emit("warn", stage, `${suite.name}: the model declined to research this suite (${e.message}); its criteria are left not researched`);
                  await addToProgress("unresearched", suiteId);
                  await addToProgress("research", suiteId);
                  return;
                }
              }
              if (!res) return;
              const critIds = crit.map((x) => x.id);
              const evidenceNow = async () =>
                await db
                  .select()
                  .from(schema.evidence)
                  .where(and(eq(schema.evidence.evaluationId, evaluationId), inArray(schema.evidence.criterionId, critIds)));
              for (let round = 1; round <= m.gapFillRounds; round++) {
                const rows = await evidenceNow();
                // In an exhaustive run a criterion resting only on marketing or a search attestation is still open.
                const have = evidencedCriteria(m.gapFillStrict ? rows.filter((e) => !isWeakEvidence(e)) : rows);
                const missing = crit.filter((x) => !have.has(x.id));
                const coverage = 1 - missing.length / crit.length;
                if (!missing.length || (coverage >= m.gapFillThreshold && !missing.some(isHighScrutiny))) break;
                emit("info", stage, `${suite.name}: ${missing.length} criteria still lack evidence; targeted research pass ${round}`);
                try {
                  await research(
                    ctx(`${stage}.gap`, missing),
                    `${brief}\n\nAn earlier research pass for this suite left these criteria without evidence that settles them:\n${missing
                      .map((x) => `- ${x.id}: ${x.question}`)
                      .join(
                        "\n",
                      )}\n\nResearch ONLY these. For each, search the knowledge base with specific terms, read the most relevant source, and record what decides it (a quote, or record_absence for a power or feature that doesn't exist). If after a genuine search nothing settles one, call record_search with what you searched: it's published as "not disclosed". Research budget: about ${budget} calls; recording doesn't count.`,
                  );
                } catch (e) {
                  if (!(e instanceof RefusalError)) throw e;
                  emit("warn", stage, `${suite.name}: the model declined targeted pass ${round} (${e.message}); keeping what's recorded`);
                  break;
                }
              }
              const all = await evidenceNow();
              const settled = evidencedCriteria(all);
              if (!all.some((e) => e.verified)) {
                await addToProgress("unresearched", suiteId);
                emit("warn", stage, `${suite.name}: no verified evidence after research; its criteria will be marked not researched`);
              } else {
                // A rerun that now finds evidence clears an earlier "not researched" (R3-REL-1).
                await removeFromProgress("unresearched", suiteId);
                emit(
                  "success",
                  stage,
                  `${suite.name}: ${settled.size}/${crit.length} criteria evidenced (${all.filter((e) => e.verified).length} verified records)${res.text ? ` · ${res.text.slice(0, 160)}` : ""}`,
                );
              }
              await addToProgress("research", suiteId);
              await persistUsage();
            }),
        );
        await markStage("research");
      }

      // ---------- judge ----------
      if (!(await done("judge"))) {
        await setStage("judge");
        const finished = new Set((await progress()).judge ?? []);
        // The judge weighs evidence by its source's current class (R4-8). Answers this pass will re-judge need no
        // flag; answers in suites that aren't re-judged (a rerun of other suites) are flagged if their weight moved.
        const rejudged = new Set(suiteIds.filter((sid) => !finished.has(sid)).flatMap((sid) => suiteCriteria(sid).map((c) => c.id)));
        await syncEvidenceClasses(db, { evaluationId, skipCriteria: rejudged });
        const unresearched = new Set((await progress()).unresearched ?? []);
        await settleAll(
          suiteIds
            .filter((s) => !finished.has(s))
            .map((suiteId) => async () => {
              await judgeAndStore(judgeCtx, suiteId, suiteCriteria(suiteId), { matrix: true, unresearched: unresearched.has(suiteId) });
              await addToProgress("judge", suiteId);
              await persistUsage();
            }),
        );
        await markStage("judge");
      }

      // ---------- code check: settle unknowns from the code and onchain state ----------
      // The code is the source of truth. Every criterion still unknown or "not disclosed" after judging, where the
      // code can decide it, goes to a code checker with the repositories at the pinned version and onchain reads,
      // and is re-judged. Its search log then records that the code was checked. (An evaluation that finished verify
      // before this stage existed doesn't run it on resume.)
      if (!(await done("codecheck")) && !(await done("verify"))) {
        await setStage("codecheck");
        const unresearchedNow = new Set((await progress()).unresearched ?? []);
        const checked = new Set((await progress()).codecheck ?? []);
        // An exhaustive run checks a suite research came back empty on too: that's where the code matters most.
        const pending = suiteIds.filter((s) => !checked.has(s) && (m.codeCheckAnswered || !unresearchedNow.has(s)));
        const stages = pending.map((s) => `codecheck.${s}`);
        if (stages.length) {
          // A resumed check starts clean, keeping evidence an answer already cites (as verify does for the skeptic).
          await deleteUncitedEvidence(db, evaluationId, stages);
          await db.delete(schema.searchLogs).where(and(eq(schema.searchLogs.evaluationId, evaluationId), inArray(schema.searchLogs.createdByStage, stages)));
        }
        const bundle = (await loadEvaluation(db, evaluationId))!;
        const [{ n: codeSources = 0 } = {}] = await query<{ n: number }>(
          db,
          sql`SELECT count(*)::int AS n FROM sources WHERE project_id = ${project.id} AND kind = 'code'`,
        );
        const hasCode =
          project.githubRepos.length > 0 || codeSources > 0 || ((await progress()).codeMap?.contracts ?? []).some((c) => /^0x[0-9a-fA-F]{40}$/.test(c.address));
        const evidenceById = new Map(bundle.evidence.map((e) => [e.id, e]));
        // An answer resting on no code or onchain record, where the code can decide it, is checked against the code too.
        const restsOffCode = (r: (typeof bundle.results)[number]) =>
          !(r.decisiveEvidenceIds.length ? r.decisiveEvidenceIds : r.evidenceIds).some((id) => evidenceById.get(id)?.sourceClass === "code_onchain");
        const unsettled = (sid: SuiteId) =>
          suiteCriteria(sid).filter((c) => {
            if (!isCodeCheckable(c.id)) return false;
            const r = bundle.results.find((x) => x.criterionId === c.id);
            // A suite left unresearched has no results yet: all of its code-decidable criteria are open.
            if (!r) return unresearchedNow.has(sid);
            if (r.overrideStatus) return false;
            const notDisclosed = r.status === "answered" && !!r.optionId && r.optionId === c.noDataOption && !!r.searchLog?.searched?.length;
            if (r.status === "unknown" || notDisclosed) return true;
            return m.codeCheckAnswered && r.status === "answered" && isHighScrutiny(c) && restsOffCode(r);
          });
        await settleAll(
          pending.map((suiteId) => async () => {
            const targets = unsettled(suiteId);
            const stage = `codecheck.${suiteId}`;
            const suite = getSuite(suiteId);
            if (targets.length && !hasCode) {
              for (const c of targets)
                await db.insert(schema.searchLogs).values({
                  id: newId(),
                  evaluationId,
                  criterionId: c.id,
                  searched: ["No public repositories, code sources or deployed contracts are known for this project"],
                  note: "The code check had no code to read.",
                  createdByStage: stage,
                });
            } else if (targets.length) {
              emit("info", stage, `${suite.name}: checking ${targets.length} unsettled criteria against the code`);
              const byId = new Map(bundle.results.map((r) => [r.criterionId, r]));
              const describe = (c: CriterionDef) => {
                const r = byId.get(c.id);
                if (!r) return `- ${c.id}: ${c.question}\n  now not researched`;
                const now =
                  r.status === "unknown"
                    ? "unknown"
                    : r.optionId === c.noDataOption
                      ? `"${optionLabel(c.id, r.optionId)}" (not disclosed)`
                      : `"${optionLabel(c.id, r.optionId)}" from docs or other prose only: confirm or refute it in the code`;
                const searched = r.searchLog?.searched?.length ? `; research searched: ${r.searchLog.searched.slice(0, 6).join("; ")}` : "";
                return `- ${c.id}: ${c.question}\n  now ${now}${searched}`;
              };
              const c = ctx(stage, targets);
              const checkBudget = Math.max(m.codeCheckCalls, m.codeCheckCallsPerCriterion * targets.length);
              await runAgent({
                model: stageModel("code"),
                system: CODECHECK_SYSTEM,
                user: [
                  projectInfo,
                  versionInfo,
                  `## The rubric for these criteria\n${renderSuiteRubric(suiteId, { only: new Set(targets.map((t) => t.id)), hints: true, tools: STAGE_TOOLS.codecheck })}`,
                  `## Unsettled criteria\n${targets.map(describe).join("\n")}`,
                  `System model from the code auditors:\n${(await progress()).codeNotes ?? "(none)"}`,
                  `Budget: about ${checkBudget} tool calls (recording doesn't count). Start with badge-deciding and high-impact criteria.`,
                ].join("\n\n"),
                tools: toolDefinitions(
                  STAGE_TOOLS.codecheck,
                  targets.map((t) => t.id),
                ),
                webSearchUses: 0,
                maxToolCalls: checkBudget,
                effort: stageEffort("code", "high"),
                ctx: c,
                usage,
                guard,
              });
              emit("success", stage, `${suite.name}: code check recorded ${c.evidenceCount.n} evidence records for ${targets.length} criteria`);
            }
            // A suite research left empty that the check found verified evidence for is researched now.
            if (unresearchedNow.has(suiteId) && targets.length) {
              const found = await db
                .select({ id: schema.evidence.id })
                .from(schema.evidence)
                .where(and(eq(schema.evidence.evaluationId, evaluationId), eq(schema.evidence.createdByStage, stage), eq(schema.evidence.verified, true)))
                .limit(1);
              if (found.length) {
                await removeFromProgress("unresearched", suiteId);
                emit("success", stage, `${suite.name}: the code check found verified evidence; judging the suite from it`);
                await judgeAndStore(judgeCtx, suiteId, suiteCriteria(suiteId), { matrix: true, pass: "codecheck" });
                await addToProgress("codecheck", suiteId);
                await persistUsage();
                return;
              }
            }
            // Re-judged with whatever the check found. Criteria without citable evidence don't reach the model; they
            // just pick up the check's search log (and a criterion's "nothing published" option where it has one).
            if (targets.length && !unresearchedNow.has(suiteId)) await judgeAndStore(judgeCtx, suiteId, targets, { matrix: false, pass: "codecheck" });
            await addToProgress("codecheck", suiteId);
            await persistUsage();
          }),
        );
        await markStage("codecheck");
      }

      // ---------- verify: skeptic + matrix consistency ----------
      if (!(await done("verify"))) {
        await setStage("verify");
        // A resumed verify starts clean: counter-evidence an interrupted skeptic recorded would otherwise be taken
        // for old evidence, and the answer it contradicts would be stamped "checked" (R3-REL-5). Evidence an answer
        // already cites (a completed re-judge) stays: deleting it would leave that answer resting on nothing (R4-1).
        await deleteUncitedEvidence(db, evaluationId, ["skeptic"]);
        const bundle = (await loadEvaluation(db, evaluationId))!;
        const defOf = (id: string) => allCriteria.find((x) => x.id === id);
        const answered = bundle.results.filter((r) => r.status === "answered" && r.optionId && !r.overrideStatus && defOf(r.criterionId));
        // Challenge every answered high-scrutiny criterion that isn't already the riskiest option (in deep mode, every
        // answered criterion that isn't); defend the riskiest option on badge-deciding criteria, since a false
        // accusation is the most damaging public error.
        const challenge = answered.filter((r) => {
          const c = defOf(r.criterionId)!;
          return r.optionId !== lowestOption(c).id && (m.skepticAllFavorable || isHighScrutiny(c));
        });
        // Defending the riskiest option: badge-deciding criteria always; in an exhaustive run every high-scrutiny one.
        const defend = answered.filter(
          (r) =>
            (BADGE_DRIVING.has(r.criterionId) || (m.skepticSecondPass && isHighScrutiny(defOf(r.criterionId)!))) &&
            r.optionId === lowestOption(defOf(r.criterionId)!).id,
        );
        const targets = [...challenge, ...defend];
        if (targets.length) {
          const targetIds = new Set(targets.map((r) => r.criterionId));
          const reports = new Map<string, { outcome: ChallengeOutcome; searched: string[] }>();
          const before = new Set(bundle.evidence.map((e) => e.id));
          emit("info", "skeptic", `Challenging ${challenge.length} answers and defending ${defend.length}`);
          const byId = new Map(bundle.evidence.map((e) => [e.id, e]));
          const describe = (r: (typeof targets)[number]) => {
            const cd = defOf(r.criterionId)!;
            const quotes = (r.decisiveEvidenceIds.length ? r.decisiveEvidenceIds : r.evidenceIds)
              .map((id) => byId.get(id))
              .filter((e): e is EvidenceRow => !!e)
              .slice(0, 3)
              .map(
                (e) =>
                  `    · [${e.id}] "${e.quote.replace(/\s+/g, " ").slice(0, 300)}" (${e.url})${e.quoteContext ? `\n      in context: "${e.quoteContext.replace(/\s+/g, " ").slice(0, 600)}"` : ""}`,
              )
              .join("\n");
            return `- ${cd.id} → "${optionLabel(cd.id, r.optionId)}" (${r.rationale})${quotes ? `\n  relied on:\n${quotes}` : ""}`;
          };
          const codeNotes = (await progress()).codeNotes ?? "(none)";
          // One skeptic per suite, in parallel, each with a budget for its own answers (the findings it files
          // under related criteria in other suites are shared through the evidence table).
          const skepticFor = async (subset: typeof targets, pass: 1 | 2) => {
            const ids = new Set(subset.map((r) => r.criterionId));
            const recordable = allCriteria.filter((c) => ids.has(c.id) || relatedCriteria(c.id).some((id) => ids.has(id)));
            const mine = new Map<string, { outcome: ChallengeOutcome; searched: string[] }>();
            const c = { ...ctx("skeptic", recordable), challengeReports: mine };
            const ch = subset.filter((r) => challenge.includes(r));
            const df = subset.filter((r) => defend.includes(r));
            const calls = Math.max(m.skepticCalls, m.skepticCallsPerTarget * subset.length);
            const rubricText = suiteIds
              .filter((sid) => subset.some((t) => t.criterionId.startsWith(`${sid}.`)))
              .map((sid) => renderSuiteRubric(sid, { only: ids, hints: true, tools: STAGE_TOOLS.skeptic }))
              .join("\n");
            await runAgent({
              model: stageModel("skeptic"),
              system: SKEPTIC_SYSTEM,
              user: [
                projectInfo,
                versionInfo,
                `## The rubric for these answers\n${rubricText}`,
                ch.length ? `## Answers to challenge (find evidence they're too generous)\n${ch.map(describe).join("\n")}` : "",
                df.length ? `## Answers to defend (find evidence they're too harsh)\n${df.map(describe).join("\n")}` : "",
                pass === 2 ? "A first skeptic pass didn't get to these answers. Examine each one and report on every one." : "",
                `Code auditor's map:\n${codeNotes}`,
                `Budget: about ${calls} tool calls (recording and reporting don't count). Spend it on the answers that matter most first: badge-deciding and high-impact ones, but examine and report on every answer.`,
              ]
                .filter(Boolean)
                .join("\n\n"),
              tools: toolDefinitions(
                STAGE_TOOLS.skeptic,
                recordable.map((t) => t.id),
              ),
              webSearchUses: m.skepticSearches,
              maxToolCalls: calls,
              effort: stageEffort("skeptic", "high"),
              ctx: c,
              usage,
              guard,
            });
            for (const [k, v] of mine) if (v.outcome !== "not_examined" || !reports.has(k)) reports.set(k, v);
          };
          const bySuite = (list: typeof targets) => suiteIds.map((sid) => list.filter((r) => r.criterionId.startsWith(`${sid}.`))).filter((x) => x.length);
          await settleAll(bySuite(targets).map((subset) => () => skepticFor(subset, 1)));
          const unexamined = targets.filter((r) => !reports.get(r.criterionId) || reports.get(r.criterionId)!.outcome === "not_examined");
          if (m.skepticSecondPass && unexamined.length) {
            emit("info", "skeptic", `Second pass over ${unexamined.length} answers the first didn't examine`);
            await settleAll(bySuite(unexamined).map((subset) => () => skepticFor(subset, 2)));
          }
          const after = (await loadEvaluation(db, evaluationId))!;
          // Any new verified finding (either direction) re-judges the criterion it's filed under and the targets
          // that can cite it.
          const fresh = after.evidence.filter((e) => !before.has(e.id) && e.verified && e.createdByStage === "skeptic");
          const filed = new Set(fresh.map((e) => e.criterionId));
          const rejudge = allCriteria.filter(
            (cd) =>
              after.results.some((r) => r.criterionId === cd.id) &&
              (filed.has(cd.id) || (targetIds.has(cd.id) && relatedCriteria(cd.id).some((id) => filed.has(id)))),
          );
          const examined = targets.filter((r) => reports.get(r.criterionId)?.outcome && reports.get(r.criterionId)!.outcome !== "not_examined").length;
          emit(
            rejudge.length ? "warn" : "success",
            "skeptic",
            `${rejudge.length ? `New evidence for ${rejudge.length} criteria; re-judging` : "No new evidence found"} · examined ${examined} of ${targets.length} answers`,
          );
          // Suites write different criteria, so their re-judges run in parallel.
          await settleAll(
            suiteIds
              .map((suiteId) => ({ suiteId, crit: suiteCriteria(suiteId).filter((x) => rejudge.some((r) => r.id === x.id)) }))
              .filter((x) => x.crit.length)
              .map((x) => () => judgeAndStore(judgeCtx, x.suiteId, x.crit, { matrix: false, pass: "skeptic" })),
          );
          // "Skeptic checked" is earned: the skeptic examined the answer, found nothing, and nothing changed it.
          for (const r of targets)
            if (!rejudge.some((x) => x.id === r.criterionId) && reports.get(r.criterionId)?.outcome === "answer_holds")
              await addFlag(db, evaluationId, r.criterionId, "skeptic_checked");
        }
        // Matrix vs criteria consistency.
        const b2 = (await loadEvaluation(db, evaluationId))!;
        const conflicts = matrixConflicts(b2.evaluation.adversaryMatrix as never, answerMapFor(b2));
        for (const cf of conflicts) await addFlag(db, evaluationId, cf.criterionId, "matrix_conflict");
        if (conflicts.length) emit("warn", "verify", `${conflicts.length} adversary-matrix conflicts flagged for review`);
        // Answers that can't both be true: one of each pair is wrong, so both go to review.
        const inconsistent = consistencyConflicts(answerMapFor(b2));
        for (const cf of inconsistent) for (const id of cf.criterionIds) await addFlag(db, evaluationId, id, "inconsistent_answers");
        for (const cf of inconsistent) emit("warn", "verify", `Inconsistent answers (${cf.criterionIds.join(" vs ")}): ${cf.message}`);
        await storeReviewFlags(db, evaluationId);
        await flagMissingEvidence(db, evaluationId);
        await markStage("verify");
      }

      // ---------- score: explain changes since the last published result, then summarize ----------
      if (!(await done("score"))) {
        await setStage("score");
        await guard.check();
        // The answers may have changed (a rerun): an old summary must not survive a failed new one (R4-3).
        await db.update(schema.evaluations).set({ summary: "", powers: [], context: {}, summaryAt: null }).where(eq(schema.evaluations.id, evaluationId));
        // Independent: the summary reads the answers, the explanations annotate them.
        await settleAll<unknown>([() => explainChanges(judgeCtx, project.id, version), () => summarize(db, evaluationId, usage, emit)]);
        emit("success", "score", "Scored and summarized; ready for review");
        await markStage("score");
      }

      // Don't overwrite a cancel that arrived during the last stage.
      await db
        .update(schema.evaluations)
        .set({ status: "review", stage: "review", finishedAt: new Date().toISOString() })
        .where(and(eq(schema.evaluations.id, evaluationId), eq(schema.evaluations.status, "running")));
      await persistUsage();
    } catch (e) {
      await persistUsage();
      const current = await status();
      const cancelled =
        current === "cancelled" ||
        ((e instanceof CancelledError || e instanceof LlmAbortedError || e instanceof KbRefreshAbortedError) && current !== "failed");
      // A sibling suite's failure already marked the evaluation failed; keep that status and its error.
      if (current === "running") {
        await db
          .update(schema.evaluations)
          .set({ status: cancelled ? "cancelled" : "failed", error: redact((e as Error).message).slice(0, 2000), finishedAt: new Date().toISOString() })
          .where(eq(schema.evaluations.id, evaluationId));
      }
      if (current === "running" || current === "cancelled")
        emit(cancelled ? "warn" : "error", "pipeline", cancelled ? "Evaluation cancelled" : `Evaluation failed: ${(e as Error).message}`);
      if (!cancelled && current === "running") throw e;
    } finally {
      // Every progress line is written before the run is reported finished.
      await emit.flush();
    }
  });
}

/**
 * Flags that used to exist only in the published snapshot are stored on the result, so they reach review and
 * block publishing until accepted (R3-JDG-5): favorable high-scrutiny answers resting on marketing or on nothing,
 * top options resting only on search attestations, and medium confidence where it matters (in the golden runs,
 * medium-confidence answers were right 74% of the time against 95% for high).
 */
export async function storeReviewFlags(db: DB, evaluationId: string) {
  const b = await loadEvaluation(db, evaluationId);
  if (!b) return;
  const answers = answerMapFor(b);
  for (const r of b.results) {
    if (r.overrideStatus || r.status !== "answered" || !r.optionId) continue;
    const c = allCriteria.find((x) => x.id === r.criterionId);
    if (!c) continue;
    const top = c.options.reduce((x, y) => (y.points > x.points ? y : x));
    const v = answers[r.criterionId]?.verifiability;
    const add: string[] = [];
    if (isHighScrutiny(c) && isFavorable(c, r.optionId)) {
      if (v === null) add.push("unsupported_favorable");
      if (v === "marketing") add.push("self_reported");
    }
    const decisive = b.evidence.filter((e) => r.decisiveEvidenceIds.includes(e.id));
    // Any top answer resting only on searches for absence goes to a reviewer, not only high-scrutiny ones (R4-10).
    if (
      (isHighScrutiny(c) || c.id in ABSENCE_POLICY || OFF_CHAIN_POWERS.has(c.id)) &&
      r.optionId === top.id &&
      decisive.length &&
      decisive.every((e) => e.verifyNote === "search attestation")
    )
      add.push("attestation_only_favorable");
    if (r.confidence === "medium" && (isHighScrutiny(c) || r.optionId === top.id)) add.push("medium_confidence");
    for (const f of add) await addFlag(db, evaluationId, r.criterionId, f);
  }
}

/**
 * An answer must never cite evidence that no longer exists (R4-1): if one does, it's flagged (blocking) so a
 * reviewer re-runs the suite or overrides it, instead of publishing an answer resting on nothing.
 */
export async function flagMissingEvidence(db: DB, evaluationId: string): Promise<number> {
  const ids = new Set(
    (await db.select({ id: schema.evidence.id }).from(schema.evidence).where(eq(schema.evidence.evaluationId, evaluationId))).map((e) => e.id),
  );
  let n = 0;
  for (const r of await db.select().from(schema.criterionResults).where(eq(schema.criterionResults.evaluationId, evaluationId))) {
    if (r.overrideStatus || r.status !== "answered") continue;
    if ([...r.evidenceIds, ...r.decisiveEvidenceIds].some((id) => !ids.has(id))) {
      await addFlag(db, evaluationId, r.criterionId, "evidence_missing");
      n++;
    }
  }
  return n;
}

/** Flags a reviewer already accepted for this exact answer; a changed answer gets its flags back (R4-4). */
function acceptedFor(r: { acceptedFlags: { flags: string[]; status: string; optionId: string | null } | null }, status: string, optionId: string | null) {
  return r.acceptedFlags && r.acceptedFlags.status === status && r.acceptedFlags.optionId === optionId ? new Set(r.acceptedFlags.flags) : new Set<string>();
}

/**
 * Adds a flag to a result once, unless a reviewer already accepted that flag for this same answer (R4-4). One
 * statement, so flags written concurrently (parallel suites, the skeptic) are never lost.
 */
async function addFlag(db: DB, evaluationId: string, criterionId: string, flag: string) {
  await db.execute(
    sql`UPDATE criterion_results SET flags = flags || jsonb_build_array(${flag}::text)
      WHERE evaluation_id = ${evaluationId} AND criterion_id = ${criterionId} AND NOT flags ? ${flag}
        AND NOT (accepted_flags IS NOT NULL AND accepted_flags->>'status' = status
          AND (accepted_flags->>'optionId') IS NOT DISTINCT FROM option_id AND coalesce(accepted_flags->'flags', '[]'::jsonb) ? ${flag})`,
  );
}

interface JudgeCtx {
  db: DB;
  evaluationId: string;
  m: (typeof MODES)[Mode];
  usage: Usage;
  emit: Emit;
  guard: { check(): Promise<void> };
  evaluationDate: string;
  supersededBy: Supersession | null;
}

/** First answer per criterion in one judge call (a model occasionally repeats a criterion). */
function dedupe(answers: JudgeAnswer[]): JudgeAnswer[] {
  const seen = new Set<string>();
  return answers.filter((a) => {
    if (seen.has(a.criterionId)) return false;
    seen.add(a.criterionId);
    return true;
  });
}

/**
 * The structured system model as compact lines for the judge: contracts, privileged functions, issuer powers, and
 * how the system works (actors, transaction flow, inclusion paths, fees, client defaults).
 */
export function renderCodeMap(map: CodeMap | undefined): string | null {
  if (!map?.contracts?.length && !map?.privileged?.length && !map?.actors?.length && !map?.lifecycle?.length) return null;
  const section = (title: string, items: string[]) => (items.length ? [`${title}:`, ...items] : []);
  // Everything the map holds (the judge's main view of the code), up to 60k characters.
  const lines = [
    ...(map.contracts ?? []).map((c) => `- contract ${c.name}${c.address ? ` ${c.address}` : ""}: ${c.role}; upgradeable: ${c.upgradeable}`),
    ...(map.privileged ?? []).map((p) => `- ${p.contract}.${p.fn} guarded by ${p.guard}, held by ${p.holder}, delay ${p.delay}: ${p.effect}`),
    ...(map.assets ?? []).map((a) => `- asset ${a.asset}: issuer powers ${a.issuerPowers}`),
    ...section(
      "Actors",
      (map.actors ?? []).map((a) => `- ${a.actor}: can ${a.can}; cannot ${a.cannot}; sees ${a.sees}`),
    ),
    ...section(
      "Transaction flow",
      (map.lifecycle ?? []).map((x) => `- ${x}`),
    ),
    ...section(
      "Inclusion and escape paths",
      (map.inclusion ?? []).map((x) => `- ${x}`),
    ),
    ...section(
      "Fees",
      (map.fees ?? []).map((x) => `- ${x}`),
    ),
    ...section(
      "Reference client defaults",
      (map.clientDefaults ?? []).map((x) => `- ${x}`),
    ),
    ...section(
      "Exits",
      (map.exits ?? []).map((x) => `- ${x}`),
    ),
    ...section(
      "Changes in this version",
      (map.versionChanges ?? []).map((x) => `- ${x}`),
    ),
    ...section(
      "Open questions the auditors couldn't settle",
      (map.openQuestions ?? []).map((x) => `- ${x}`),
    ),
  ];
  return lines.join("\n").slice(0, 60_000);
}

async function searchLogsFor(db: DB, evaluationId: string, criterionId: string): Promise<SearchLog | null> {
  const rows = await db
    .select()
    .from(schema.searchLogs)
    .where(and(eq(schema.searchLogs.evaluationId, evaluationId), eq(schema.searchLogs.criterionId, criterionId)));
  if (!rows.length) return null;
  return {
    // The code check's own search (repositories, files, onchain reads) settles an unknown the code could decide.
    codeChecked: rows.some((r) => r.createdByStage.startsWith("codecheck")),
    searched: [...new Set(rows.flatMap((r) => r.searched))].slice(0, 30),
    note: rows
      .map((r) => r.note)
      .filter(Boolean)
      .join(" ")
      .slice(0, 800),
  };
}

/**
 * Copies evidence the judge cited from a related criterion under this criterion (stage "judge.refile"), once, and
 * returns old id → copy id. The copy keeps the quote, source, class and verification of the original.
 */
async function refileCited(db: DB, evaluationId: string, criterionId: string, answer: JudgeAnswer, evidence: EvidenceRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set([...answer.evidenceIds, ...answer.decisiveEvidenceIds])) {
    const e = evidence.find((x) => x.id === id);
    if (!e || e.criterionId === criterionId) continue;
    const same = (
      await db
        .select({ id: schema.evidence.id })
        .from(schema.evidence)
        .where(
          and(
            eq(schema.evidence.evaluationId, evaluationId),
            eq(schema.evidence.criterionId, criterionId),
            eq(schema.evidence.quote, e.quote),
            e.sourceId ? eq(schema.evidence.sourceId, e.sourceId) : isNull(schema.evidence.sourceId),
          ),
        )
    )[0];
    if (same) {
      out.set(id, same.id);
      continue;
    }
    const copy = {
      ...e,
      id: newId(),
      criterionId,
      createdByStage: "judge.refile",
      claim: `Filed under ${e.criterionId}: ${e.claim}`.slice(0, 1000),
      createdAt: new Date().toISOString(),
    };
    await db.insert(schema.evidence).values(copy);
    evidence.push(copy);
    out.set(id, copy.id);
  }
  return out;
}

/**
 * Judges a suite's criteria and stores the answers. `pass` marks a re-judge after the code check or the skeptic
 * found new evidence: earlier votes are kept, and the new ones are labelled with the pass and the next round.
 */
async function judgeAndStore(
  j: JudgeCtx,
  suiteId: SuiteId,
  crit: CriterionDef[],
  opts: { matrix: boolean; pass?: "codecheck" | "skeptic"; unresearched?: boolean },
) {
  const { db, evaluationId, m, usage, emit, guard } = j;
  const bundle = (await loadEvaluation(db, evaluationId))!;
  // The suite's evidence plus what's filed under related criteria (the rest of each benchmark and fact-linked
  // criteria in other suites), which the judge may cite where it settles the answer.
  const citable = new Set(crit.flatMap((c) => [c.id, ...relatedCriteria(c.id)]));
  const evidence = bundle.evidence.filter((e) => citable.has(e.criterionId));
  // Source metadata only (titles, urls, dates); the content is already in the quotes and their context.
  const sourceIds = [...new Set(evidence.map((e) => e.sourceId).filter((x): x is string => !!x))];
  const sources = new Map(
    (sourceIds.length
      ? await db
          .select({
            id: schema.sources.id,
            title: schema.sources.title,
            url: schema.sources.url,
            date: schema.sources.date,
            fetchedAt: schema.sources.fetchedAt,
            kind: schema.sources.kind,
          })
          .from(schema.sources)
          .where(inArray(schema.sources.id, sourceIds))
      : []
    ).map((s) => [s.id, s]),
  );
  const model = stageModel("judge");
  const verified = new Set(evidence.filter((e) => e.verified).map((e) => e.criterionId));
  const onRetry = (attempt: number, delay: number, e: unknown) =>
    emit(
      "warn",
      `judge.${suiteId}`,
      `Anthropic API busy (${(e as Error).message.slice(0, 80)}); retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1})`,
    );
  // Only criteria with verified evidence (their own, or a related criterion's) go to the judge; the rest are
  // recorded without a model call.
  const hasCitable = (c: CriterionDef) => verified.has(c.id) || relatedCriteria(c.id).some((id) => verified.has(id));
  const toJudge = opts.unresearched ? [] : crit.filter(hasCitable);
  const votesFor = (c: CriterionDef) => (BADGE_DRIVING.has(c.id) ? m.votesBadge : isHighScrutiny(c) ? m.votesHighImpact : m.votesOther);
  const call = async (subset: CriterionDef[], seed: number, matrix: boolean) => {
    await guard.check();
    const r = await judgeSuite({
      suiteId,
      criteria: subset,
      project: bundle.project,
      version: bundle.version,
      evidence,
      sources,
      model,
      usage,
      matrixAdversaries: matrix ? ownedAdversaries(suiteId) : [],
      evaluationDate: j.evaluationDate,
      supersededBy: j.supersededBy,
      codeMap: renderCodeMap((bundle.evaluation.settings as { codeMap?: CodeMap }).codeMap),
      shuffleSeed: seed,
      onRetry,
    });
    return { answers: dedupe(r.answers), matrix: r.matrix };
  };

  const votes = new Map<string, Validated[]>();
  const add = (answers: JudgeAnswer[]) => {
    for (const a of answers) {
      const c = toJudge.find((x) => x.id === a.criterionId);
      if (c) votes.set(c.id, [...(votes.get(c.id) ?? []), validateAnswer(a, c, bundle.evidence)]);
    }
  };
  let matrixRows: Awaited<ReturnType<typeof call>>["matrix"] = [];
  if (toJudge.length) {
    emit("info", `judge.${suiteId}`, `Judging ${toJudge.length} of ${crit.length} criteria in ${getSuite(suiteId).name} (the rest have no verified evidence)`);
    if (m.allVotes) {
      // Exhaustive: every vote is cast, all in parallel (independent evidence orderings).
      const most = Math.max(...toJudge.map(votesFor));
      const rounds = await Promise.all(
        Array.from({ length: most }, (_, i) => {
          const subset = toJudge.filter((c) => votesFor(c) > i);
          return subset.length ? call(subset, i + 1, i === 0 && opts.matrix) : Promise.resolve(null);
        }),
      );
      for (const r of rounds) if (r) add(r.answers);
      matrixRows = rounds[0]?.matrix ?? [];
      // A criterion no vote answered is asked once more on its own.
      const unanswered = toJudge.filter((c) => !(votes.get(c.id) ?? []).length);
      if (unanswered.length) {
        emit("warn", `judge.${suiteId}`, `${unanswered.length} criteria got no answer; asking again`);
        add((await call(unanswered, most + 1, false)).answers);
      }
    } else {
      // Votes 1 and 2 are independent (different evidence orderings), so they run in parallel. A third vote only
      // breaks ties: where the first two agree, it can't change the majority.
      const second = toJudge.filter((c) => votesFor(c) >= 2);
      const [v1, v2] = await Promise.all([call(toJudge, 1, opts.matrix), second.length ? call(second, 2, false) : Promise.resolve(null)]);
      add(v1.answers);
      matrixRows = v1.matrix;
      if (v2) add(v2.answers);
      const key = (v: Validated) => `${v.answer.status}:${v.answer.optionId}`;
      const third = toJudge.filter((c) => votesFor(c) >= 3 && (votes.get(c.id) ?? []).length >= 2 && key(votes.get(c.id)![0]!) !== key(votes.get(c.id)![1]!));
      if (third.length) add((await call(third, 3, false)).answers);
    }
  } else if (opts.unresearched) {
    emit("warn", `judge.${suiteId}`, `${getSuite(suiteId).name}: research gathered no verified evidence, so its criteria are recorded as not researched`);
  }

  for (const c of crit) {
    const vs = votes.get(c.id) ?? [];
    const flags: string[] = [];
    let answer: JudgeAnswer;
    let proposedOptionId: string | null = null;
    if (opts.unresearched) {
      answer = {
        criterionId: c.id,
        status: "unknown",
        optionId: null,
        rationale: "Research gathered no verified evidence for this suite.",
        evidenceIds: [],
        decisiveEvidenceIds: [],
        confidence: "low",
      };
      flags.push("not_researched");
    } else if (!vs.length) {
      answer = {
        criterionId: c.id,
        status: "unknown",
        optionId: null,
        rationale: hasCitable(c)
          ? "The judge did not return an answer for this criterion."
          : "No verified evidence was found for this criterion after targeted research.",
        evidenceIds: [],
        decisiveEvidenceIds: [],
        confidence: "low",
      };
      flags.push(hasCitable(c) ? "unverified" : "no_evidence");
    } else {
      const maj = majority(
        c,
        vs.map((v) => v.answer),
      );
      answer = maj.answer;
      if (maj.split) flags.push("judge_disagreement");
      const chosen = vs.find((v) => v.answer === maj.answer);
      if (chosen) {
        flags.push(...chosen.flags);
        proposedOptionId = chosen.proposedOptionId;
      } else proposedOptionId = maj.proposedOptionId;
    }
    // An unknown answer carries research's search log, published as "not disclosed (searched: …)". Where the rubric
    // has an option for "nothing published" (Unclear, No independent study yet), a genuine search that found
    // nothing answers it (rubric 1.3.0). Not when the votes split, a vote proposed an option, or the judge failed
    // to answer despite citable evidence: those are open questions for a reviewer, not a lack of data.
    const logs = answer.status === "unknown" && !opts.unresearched ? await searchLogsFor(db, evaluationId, c.id) : null;
    const noData =
      !!logs?.searched.length &&
      !!c.noDataOption &&
      (!proposedOptionId || proposedOptionId === c.noDataOption) &&
      !flags.includes("judge_disagreement") &&
      !flags.includes("unverified");
    if (noData) {
      const searched = logs!.searched.slice(0, 6).join("; ");
      answer = {
        ...answer,
        status: "answered",
        optionId: c.noDataOption,
        rationale: `Not disclosed: research searched and found nothing (${searched}).${answer.rationale ? ` ${answer.rationale}` : ""}`,
        evidenceIds: [],
        decisiveEvidenceIds: [],
        confidence: "medium",
      };
      proposedOptionId = null;
      flags.splice(0, flags.length, ...flags.filter((f) => f !== "no_evidence" && f !== "needs_quote"));
    }
    if (answer.status === "answered" && !noData) {
      // Records cited from a related criterion are re-filed under this one, so the public trail shows them.
      const refiled = await refileCited(db, evaluationId, c.id, answer, bundle.evidence);
      answer = {
        ...answer,
        evidenceIds: answer.evidenceIds.map((id) => refiled.get(id) ?? id),
        decisiveEvidenceIds: answer.decisiveEvidenceIds.map((id) => refiled.get(id) ?? id),
      };
      const decisive = answer.decisiveEvidenceIds.map((id) => bundle.evidence.find((e) => e.id === id) ?? null);
      if (!decisive.some((e) => e && isEvidencing(e))) flags.push("context_only_evidence");
    }
    const existing = (
      await db
        .select()
        .from(schema.criterionResults)
        .where(and(eq(schema.criterionResults.evaluationId, evaluationId), eq(schema.criterionResults.criterionId, c.id)))
    )[0];
    if (opts.pass === "skeptic" && existing && (existing.optionId !== answer.optionId || existing.status !== answer.status)) flags.push("skeptic_changed");
    const kept = opts.pass ? (existing?.votes ?? []).map((v) => ({ ...v, round: v.round ?? 1 })) : [];
    const round = opts.pass ? Math.max(1, ...kept.map((v) => v.round)) + 1 : 1;
    const values = {
      searchLog: logs,
      status: opts.unresearched ? "not_researched" : answer.status,
      optionId: answer.optionId,
      proposedOptionId,
      rationale: answer.rationale.slice(0, 1000),
      confidence: answer.confidence,
      evidenceIds: answer.evidenceIds,
      decisiveEvidenceIds: answer.decisiveEvidenceIds,
      // Flags describe this answer (R4-18): a re-judged answer gets its own, not the previous answer's. Flags a reviewer
      // accepted for this same answer stay accepted (R4-4).
      flags: [...new Set(flags)].filter(
        (f) => !(existing && acceptedFor(existing, opts.unresearched ? "not_researched" : answer.status, answer.optionId).has(f)),
      ),
      votes: [
        ...kept,
        ...vs.map((x) => ({
          optionId: x.answer.optionId,
          status: x.answer.status,
          rationale: x.answer.rationale.slice(0, 600),
          evidenceIds: x.answer.evidenceIds,
          model,
          round,
          ...(opts.pass ? { pass: opts.pass } : {}),
        })),
      ],
      updatedAt: new Date().toISOString(),
    };
    if (existing) await db.update(schema.criterionResults).set(values).where(eq(schema.criterionResults.id, existing.id));
    else await db.insert(schema.criterionResults).values({ id: newId(), evaluationId, criterionId: c.id, ...values });
  }

  if (matrixRows.length) {
    const cur = (await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, evaluationId)))[0]!;
    const matrix = { ...(cur.adversaryMatrix as Record<string, Record<string, unknown>>) };
    const owned = new Set(ownedAdversaries(suiteId));
    for (const row of matrixRows)
      if (owned.has(row.adversary)) matrix[row.adversary] = { ...(matrix[row.adversary] ?? {}), [row.field]: { state: row.state, note: row.note } };
    await db.update(schema.evaluations).set({ adversaryMatrix: matrix }).where(eq(schema.evaluations.id, evaluationId));
  }
  emit("success", `judge.${suiteId}`, `${getSuite(suiteId).name}: judged ${crit.length} criteria`);
}

// ---------- code map ----------

export const codeMapSchema = z.object({
  contracts: z.array(z.object({ name: z.string(), address: z.string(), chainId: z.number().nullable(), role: z.string(), upgradeable: z.string() })),
  privileged: z.array(z.object({ contract: z.string(), fn: z.string(), guard: z.string(), holder: z.string(), delay: z.string(), effect: z.string() })),
  assets: z.array(z.object({ asset: z.string(), address: z.string(), issuerPowers: z.string() })),
  exits: z.array(z.string()),
  versionChanges: z.array(z.string()),
  openQuestions: z.array(z.string()),
  actors: z.array(z.object({ actor: z.string(), can: z.string(), cannot: z.string(), sees: z.string() })),
  lifecycle: z.array(z.string()),
  inclusion: z.array(z.string()),
  fees: z.array(z.string()),
  clientDefaults: z.array(z.string()),
});

/** Turns the auditor's prose notes into a structured map (shown to reviewers; facts only from the notes). */
async function structureCodeMap(notes: string, usage: Usage): Promise<CodeMap | null> {
  if (notes.trim().length < 200) return null;
  const model = stageModel("codemap");
  if (llmBackend() === "claude-code")
    return (
      await structuredViaClaudeCode({
        model,
        effort: stageEffort("codemap", "low"),
        system: CODE_MAP_SYSTEM,
        user: `Auditor's notes:\n\n${notes}`,
        schema: codeMapSchema,
        usage,
      })
    ).parsed_output as CodeMap | null;
  const extras = modelExtras(model, stageEffort("codemap", "low"));
  // Streamed, with room for high-effort thinking before the map (a cut-off map can't be parsed).
  const res = await llmCall(
    () =>
      anthropic()
        .beta.messages.stream(
          {
            model,
            max_tokens: maxOutputFor(model),
            system: CODE_MAP_SYSTEM,
            messages: [{ role: "user", content: `Auditor's notes:\n\n${notes}` }],
            ...(extras.thinking ? { thinking: extras.thinking } : {}),
            output_config: { ...(extras.effort ? { effort: extras.effort } : {}), format: betaZodOutputFormat(codeMapSchema) },
            ...extras.fallbackParams,
            betas: [...((extras.fallbackParams as { betas?: string[] }).betas ?? []), "structured-outputs-2025-12-15"],
          },
          { signal: scopeSignal() },
        )
        .finalMessage(),
    undefined,
    { model, contextTokens: notes.length / 4, maxTokens: maxOutputFor(model) },
  );
  addUsage(usage, model, res.usage);
  return (res.parsed_output as CodeMap | null) ?? null;
}

const SUMMARY_SYSTEM =
  "You write neutral, plain-language summaries for a public privacy benchmark. No marketing language, no adjectives like robust or seamless. Use only the established answers and verified evidence given; never add facts from memory, and never state anything about criteria marked not established. The summary cites the answered criterion ids it rests on (at least two). Every power cites each criterion it rests on with the option id shown in brackets; every context value cites evidence ids for that field. If nothing given supports a value, leave it out.";

// ---------- changes since the last published result ----------

export const changeSchema = z.object({
  changes: z.array(
    z.object({
      criterionId: z.string(),
      kind: z.enum(["protocol_change", "evidence_change", "unexplained"]),
      /** Ids in brackets: a release note or diff ([source id]) or a new quote ([evidence id]). */
      note: z.string(),
      evidenceIds: z.array(z.string()),
    }),
  ),
});

type SnapshotCriterion = { status: string; optionId: string | null; rationale?: string; evidence?: { id: string; quote: string; url?: string }[] };

/**
 * Diffs this evaluation against the project's last published result (any version) and asks the reasoning model to
 * explain each changed answer: did the protocol change in this version, did the evidence improve, or is it
 * unexplained (likely evaluator variance)? Every change is flagged for review; unexplained ones prominently.
 */
async function explainChanges(j: JudgeCtx, projectId: string, version: typeof schema.projectVersions.$inferSelect | null) {
  const { db, evaluationId, usage, emit } = j;
  // Baseline: the latest live (non-demo) published result for this version or an earlier one. Comparing with a
  // later version would reverse every change; demo results are hand labels, not evaluations.
  const published = await db
    .select({ result: schema.publishedResults, rubricVersion: schema.releases.rubricVersion, releasedAt: schema.projectVersions.releasedAt })
    .from(schema.publishedResults)
    .innerJoin(schema.releases, eq(schema.releases.id, schema.publishedResults.releaseId))
    .leftJoin(schema.projectVersions, eq(schema.projectVersions.id, schema.publishedResults.versionId))
    .where(
      and(
        eq(schema.publishedResults.projectId, projectId),
        eq(schema.publishedResults.active, true),
        ne(schema.publishedResults.evaluationId, evaluationId),
        eq(schema.releases.isDemo, false),
      ),
    )
    .orderBy(desc(schema.publishedResults.createdAt));
  const base = published.find((p) => !version?.releasedAt || !p.releasedAt || p.releasedAt <= version.releasedAt);
  if (!base) return;
  const snap = base.result.snapshot as { criteria?: Record<string, SnapshotCriterion>; version?: { label?: string } | null };
  const prevCrit = snap.criteria ?? {};
  const prevMap = Object.fromEntries(
    Object.entries(prevCrit).map(([id, c]) => [id, { criterionId: id, status: c.status as "answered", optionId: c.optionId }]),
  );
  const bundle = (await loadEvaluation(db, evaluationId))!;
  const answers = answerMapFor(bundle);
  const diffs = diffAnswers(prevMap, answers).filter((d) => d.to !== null && answers[d.criterionId]?.status !== "not_researched");
  if (!diffs.length) {
    emit("success", "score", `No answers changed since the published result${snap.version?.label ? ` for ${snap.version.label}` : ""}`);
    return;
  }
  const byId = new Map(bundle.evidence.map((e) => [e.id, e]));
  const resultOf = (id: string) => bundle.results.find((r) => r.criterionId === id);
  const prevQuotes = (id: string) => new Set((prevCrit[id]?.evidence ?? []).map((e) => normalizeText(e.quote)));
  const newQuotes = (id: string) => {
    const r = resultOf(id);
    return (r?.decisiveEvidenceIds.length ? r.decisiveEvidenceIds : (r?.evidenceIds ?? [])).map((x) => byId.get(x)).filter((e): e is EvidenceRow => !!e);
  };
  type Decided = { kind: "protocol_change" | "evidence_change" | "rubric_change" | "unexplained"; note: string; evidenceIds: string[] };
  const decided = new Map<string, Decided>();
  for (const d of diffs) {
    // A change the reviewer already accepted, for this same answer, keeps its explanation: no model call (R5-2).
    const cur = resultOf(d.criterionId);
    if (cur?.change && cur.change.from === d.from && cur.change.to === d.to && acceptedFor(cur, cur.status, cur.optionId).has("changed_since_published")) {
      decided.set(d.criterionId, { kind: cur.change.kind, note: cur.change.note, evidenceIds: cur.change.evidenceIds ?? [] });
      continue;
    }
    // A criterion whose definition changed since the earlier release explains its own change, without a model.
    if (criterionChangedSince(d.criterionId, base.rubricVersion)) {
      decided.set(d.criterionId, {
        kind: "rubric_change",
        note: `The criterion's definition changed after rubric ${base.rubricVersion}, which the earlier result used.`,
        evidenceIds: [],
      });
      continue;
    }
    // The same decisive quotes as last time and a different answer is evaluator variance.
    const now = newQuotes(d.criterionId);
    const before = prevQuotes(d.criterionId);
    if (now.length && before.size && now.every((e) => before.has(normalizeText(e.quote))))
      decided.set(d.criterionId, {
        kind: "unexplained",
        note: "The answer rests on the same quotes as the published result but differs from it: likely evaluator variance.",
        evidenceIds: [],
      });
  }
  const toModel = diffs.filter((d) => !decided.has(d.criterionId));
  // Release notes and diffs for the versions between the two results only.
  const fromDate = base.releasedAt;
  const toDate = version?.releasedAt ?? null;
  const changesSources = (
    await db
      .select({ id: schema.sources.id, title: schema.sources.title, content: schema.sources.contentMd, date: schema.sources.date })
      .from(schema.sources)
      .where(and(eq(schema.sources.projectId, projectId), eq(schema.sources.kind, "changes")))
      .orderBy(desc(schema.sources.fetchedAt))
      .limit(200)
  )
    // Every release note and diff in the version window (the 1M-token window holds them).
    .filter((x) => !x.date || ((!fromDate || x.date > fromDate) && (!toDate || x.date <= toDate)))
    .slice(0, 60)
    // ...within about 400k tokens in all.
    .reduce<{ out: { id: string; title: string; content: string; date: string | null }[]; chars: number }>(
      (acc, x) => {
        const content = x.content.slice(0, 60_000);
        if (acc.chars + content.length <= 1_500_000) {
          acc.out.push({ ...x, content });
          acc.chars += content.length;
        }
        return acc;
      },
      { out: [], chars: 0 },
    ).out;
  const describe = (id: string, c: { status: string; optionId: string | null } | undefined) =>
    !c ? "not evaluated" : c.status === "answered" ? `"${optionLabel(id, c.optionId)}"` : c.status.replace("_", " ");
  if (toModel.length) {
    const items = toModel.map((d) => {
      const cur = resultOf(d.criterionId);
      const before = prevCrit[d.criterionId];
      return [
        `## ${d.criterionId}`,
        `Previous answer: ${describe(d.criterionId, before)}${before?.rationale ? ` — ${before.rationale}` : ""}`,
        ...(before?.evidence ?? []).slice(0, 3).map((e) => `  prev quote: "${e.quote.slice(0, 300)}"`),
        `New answer: ${describe(d.criterionId, cur)}${cur?.rationale ? ` — ${cur.rationale}` : ""}`,
        ...newQuotes(d.criterionId)
          .slice(0, 4)
          .map((e) => `  new quote [${e.id}]: "${e.quote.slice(0, 300)}"`),
      ].join("\n");
    });
    const model = stageModel("changes");
    emit("info", "score", `${diffs.length} answers changed since the published result; explaining ${toModel.length}`);
    const changesUser = [
      `Previous published result: ${snap.version?.label ?? "unversioned"}. This evaluation: ${version?.label ?? "unversioned"}.`,
      releaseNotesBlock(version) || "No release notes for this version.",
      changesSources.length
        ? `Release notes and diffs for the versions in between:\n${changesSources.map((x) => `### ${x.title} [${x.id}]\n${x.content}`).join("\n\n")}`
        : "No release notes or diffs are stored for the versions in between.",
      "Changed answers:",
      ...items,
    ].join("\n\n");
    const ask = async (retry: boolean) => {
      if (llmBackend() === "claude-code")
        return (
          (
            await structuredViaClaudeCode({
              model,
              effort: stageEffort("changes", "medium"),
              system: CHANGE_SYSTEM,
              user: changesUser,
              schema: changeSchema,
              usage,
            })
          ).parsed_output?.changes ?? null
        );
      const extras = modelExtras(model, stageEffort("changes", "medium"));
      const res = await llmCall(
        () =>
          anthropic()
            .beta.messages.stream(
              {
                model,
                max_tokens: 64_000,
                system: CHANGE_SYSTEM,
                messages: [{ role: "user", content: changesUser }],
                ...(!retry && extras.thinking ? { thinking: extras.thinking } : {}),
                output_config: { ...(extras.effort ? { effort: extras.effort } : {}), format: betaZodOutputFormat(changeSchema) },
                ...extras.fallbackParams,
                betas: [...((extras.fallbackParams as { betas?: string[] }).betas ?? []), "structured-outputs-2025-12-15"],
              },
              { signal: scopeSignal() },
            )
            .finalMessage(),
        undefined,
        { model, contextTokens: 30_000 + changesSources.reduce((n, x) => n + x.content.length, 0) / 4, maxTokens: 64_000 },
      );
      addUsage(usage, model, res.usage);
      return (res.parsed_output as z.infer<typeof changeSchema> | null)?.changes ?? null;
    };
    let out: z.infer<typeof changeSchema>["changes"] | null = null;
    try {
      out = await ask(false);
    } catch (e) {
      if (isStop(e)) throw e;
      // A truncated or unparseable explanation shouldn't fail an evaluation whose paid stages are done.
      try {
        out = await ask(true);
      } catch (e2) {
        if (isStop(e2)) throw e2;
        emit("warn", "score", `Couldn't explain changed answers automatically (${(e2 as Error).message.slice(0, 120)}); they're flagged for review`);
      }
    }
    const sourceIds = new Set(changesSources.map((x) => x.id));
    for (const x of out ?? []) {
      if (!toModel.some((d) => d.criterionId === x.criterionId)) continue;
      // An explanation must point at what it claims: a release note or diff, or a quote the earlier result lacked.
      const before = prevQuotes(x.criterionId);
      const freshQuote = (id: string) => {
        const e = byId.get(id);
        return !!e && e.criterionId === x.criterionId && e.verified && !before.has(normalizeText(e.quote));
      };
      const ok =
        x.kind === "protocol_change"
          ? x.evidenceIds.some((id) => sourceIds.has(id) || (freshQuote(id) && byId.get(id)!.sourceClass === "code_onchain"))
          : x.kind === "evidence_change"
            ? x.evidenceIds.some(freshQuote)
            : true;
      decided.set(
        x.criterionId,
        ok
          ? { kind: x.kind, note: x.note, evidenceIds: x.evidenceIds }
          : { kind: "unexplained", note: `Explanation not backed by a cited change or new quote: ${x.note}`, evidenceIds: [] },
      );
    }
  }
  let unexplained = 0;
  for (const d of diffs) {
    const x = decided.get(d.criterionId);
    const kind = x?.kind ?? "unexplained";
    if (kind === "unexplained") unexplained++;
    const r = (
      await db
        .select()
        .from(schema.criterionResults)
        .where(and(eq(schema.criterionResults.evaluationId, evaluationId), eq(schema.criterionResults.criterionId, d.criterionId)))
    )[0];
    if (!r) continue;
    await db
      .update(schema.criterionResults)
      .set({
        change: { kind, note: x?.note ?? "No explanation was produced.", from: d.from, to: d.to, evidenceIds: x?.evidenceIds ?? [] },
        // Flags a reviewer accepted for this same answer stay accepted (R5-2).
        flags: [...new Set([...r.flags, "changed_since_published", ...(kind === "unexplained" ? ["change_unexplained"] : [])])].filter(
          (f) => r.flags.includes(f) || !acceptedFor(r, r.status, r.optionId).has(f),
        ),
      })
      .where(eq(schema.criterionResults.id, r.id));
  }
  emit(unexplained ? "warn" : "success", "score", `${diffs.length} changed answers explained; ${unexplained} unexplained (flagged for review)`);
}

// ---------- summary ----------

const CONTEXT_FIELDS = ["status", "valueSecured", "typicalCost", "feeModel", "throughput", "launched", "programmability", "token"] as const;

/** The criteria whose evidence may back each context value (a value citing unrelated evidence is dropped). */
const CONTEXT_CRITERIA: Record<(typeof CONTEXT_FIELDS)[number], string[]> = {
  status: ["security.maturity.status"],
  valueSecured: ["coverage.anonymity-set.usage"],
  typicalCost: ["programmability.performance.cost"],
  feeModel: ["programmability.performance.cost", "coverage.unlinkability.fees"],
  throughput: ["programmability.performance.throughput"],
  launched: ["security.maturity.age", "security.maturity.status"],
  programmability: ["programmability.contracts.model", "programmability.contracts.deployment"],
  token: ["governance.process.control", "governance.roles.holders"],
};
const CONTEXT_EVIDENCE = new Set(Object.values(CONTEXT_CRITERIA).flat());

export const summarySchema = z.object({
  summary: z.string(),
  /** The established answers the headline sentence rests on. */
  summaryCriterionIds: z.array(z.string()),
  powers: z.array(z.object({ statement: z.string(), criteria: z.array(z.object({ criterionId: z.string(), optionId: z.string() })) })),
  context: z.array(z.object({ field: z.enum(CONTEXT_FIELDS), value: z.string(), evidenceIds: z.array(z.string()) })),
});

const NOT_ESTABLISHED = "Not established by this evaluation";

/**
 * Writes the summary, "who holds power" list and context facts from final answers and VERIFIED evidence only
 * (R3-JDG-15). The headline must rest on at least two established answers; each power must name the options it
 * reflects and is dropped when they aren't the answers; each context value must cite verified evidence for its
 * own field. A failed call leaves the summary empty (publishing then blocks) instead of failing the evaluation.
 */
export async function summarize(db: DB, evaluationId: string, usage: Usage, emit?: Emit): Promise<boolean> {
  const bundle = (await loadEvaluation(db, evaluationId))!;
  const answers = answerMapFor(bundle);
  const lines = bundle.results.map((r) => {
    const a = answers[r.criterionId];
    // An unknown's rationale may carry the judge's unestablished conclusion; the summary must not repeat it.
    if (a?.status !== "answered") return `- ${r.criterionId}: not established`;
    return `- ${r.criterionId}: [${a.optionId}] ${optionLabel(r.criterionId, a.optionId ?? null)} — ${r.rationale}`;
  });
  const verified = bundle.evidence.filter((e) => e.verified);
  const ctxEvidence = verified
    .filter((e) => CONTEXT_EVIDENCE.has(e.criterionId))
    .slice(0, 60)
    .map((e) => `- [${e.id}] ${e.criterionId}: "${e.quote.replace(/\s+/g, " ").slice(0, 300)}"`);
  const model = stageModel("summary");
  const answered = new Map(
    Object.values(answers)
      .filter((a) => a.status === "answered")
      .map((a) => [a.criterionId, a.optionId]),
  );
  const summaryUser = `Project: ${bundle.project.name}${bundle.version ? ` (${bundle.version.label})` : ""}\n\nRubric answers (option id in brackets):\n${lines.join("\n")}\n\nVerified evidence on usage, cost, status and token:\n${ctxEvidence.join("\n") || "(none)"}\n\nWrite: summary (one sentence naming the biggest strength and the biggest standing lever or weakness, with summaryCriterionIds); powers (3–7 short plain statements of who can do what to users' privacy or funds, including notable established absences like 'No protocol-level pause', each citing its criteria and option ids); context (values for any of: ${CONTEXT_FIELDS.join(", ")}, each citing evidence ids).`;
  const ask = async (retry: boolean) => {
    if (llmBackend() === "claude-code") {
      const out = (
        await structuredViaClaudeCode({
          model,
          effort: stageEffort("summary", "medium"),
          system: SUMMARY_SYSTEM,
          user: summaryUser,
          schema: summarySchema,
          usage,
        })
      ).parsed_output;
      if (!out) throw new Error("no parseable summary");
      if (out.summaryCriterionIds.filter((id) => answered.has(id)).length < 2) throw new Error("the summary doesn't rest on two established answers");
      return out;
    }
    const extras = modelExtras(model, stageEffort("summary", "medium"));
    const res = await llmCall(
      () =>
        anthropic()
          .beta.messages.stream(
            {
              model,
              max_tokens: 32_000,
              system: SUMMARY_SYSTEM,
              messages: [{ role: "user", content: summaryUser }],
              ...(!retry && extras.thinking ? { thinking: extras.thinking } : {}),
              output_config: { ...(extras.effort ? { effort: extras.effort } : {}), format: betaZodOutputFormat(summarySchema) },
              ...extras.fallbackParams,
              betas: [...((extras.fallbackParams as { betas?: string[] }).betas ?? []), "structured-outputs-2025-12-15"],
            },
            { signal: scopeSignal() },
          )
          .finalMessage(),
      undefined,
      { model, contextTokens: 30_000, maxTokens: 32_000 },
    );
    addUsage(usage, model, res.usage);
    const out = res.parsed_output as z.infer<typeof summarySchema> | null;
    if (!out) throw new Error("no parseable summary");
    if (out.summaryCriterionIds.filter((id) => answered.has(id)).length < 2) throw new Error("the summary doesn't rest on two established answers");
    return out;
  };
  let out: z.infer<typeof summarySchema> | null = null;
  try {
    out = await ask(false);
  } catch (e) {
    if (isStop(e)) throw e;
    try {
      out = await ask(true);
    } catch (e2) {
      if (isStop(e2)) throw e2;
      emit?.("warn", "score", `Couldn't write a grounded summary (${(e2 as Error).message.slice(0, 120)}); regenerate it in review before publishing`);
      return false;
    }
  }
  const verifiedIds = new Map(verified.map((e) => [e.id, e]));
  // A power holds only if every criterion it cites was answered with the option it says it reflects.
  const powers = out.powers
    .filter((p) => p.criteria.length && p.criteria.every((c) => answered.has(c.criterionId) && answered.get(c.criterionId) === c.optionId))
    .map((p) => p.statement);
  const context = Object.fromEntries(
    CONTEXT_FIELDS.map((f) => {
      const v = out.context.find((c) => c.field === f && c.evidenceIds.some((id) => CONTEXT_CRITERIA[f].includes(verifiedIds.get(id)?.criterionId ?? "")));
      return [f, v?.value || NOT_ESTABLISHED];
    }),
  );
  await db
    .update(schema.evaluations)
    .set({ summary: out.summary, powers, context, summaryAt: new Date().toISOString() })
    .where(eq(schema.evaluations.id, evaluationId));
  return true;
}
