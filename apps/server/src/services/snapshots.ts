import { createHash, randomBytes } from "node:crypto";
import type {
  BenchmarkCell,
  CriterionFlag,
  EvalSettings,
  KnowledgeBaseInfo,
  LeaderboardRow,
  ProjectInfo,
  ProjectSnapshot,
  ReleaseInfo,
  SnapshotCriterion,
  SnapshotEvidence,
  SnapshotSource,
  VersionInfo,
} from "@pb/core";
import {
  type AdversaryMatrix,
  type AnswerMap,
  benchmarks,
  criteria,
  findCriterion,
  isFavorable,
  isHighScrutiny,
  normalizeLevel,
  rubric,
  SOURCE_CLASS_RANK,
  type SourceClass,
  scoreProject,
} from "@pb/rubric";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "../db/index.ts";
import { query, schema } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import { LruCache } from "../lib/lru.ts";
import { coverageFrom } from "./coverage.ts";

const CLASS_RANK = SOURCE_CLASS_RANK;

type ProjectRow = typeof schema.projects.$inferSelect;
type ResultRow = typeof schema.criterionResults.$inferSelect;
type EvidenceRow = typeof schema.evidence.$inferSelect;
type SourceRow = typeof schema.sources.$inferSelect;

export function projectInfo(p: ProjectRow): ProjectInfo {
  return {
    slug: p.slug,
    name: p.name,
    website: p.websiteUrl,
    logoUrl: p.logoUrl,
    tagline: p.tagline,
    description: p.description,
    category: p.category as ProjectInfo["category"],
    mechanism: p.mechanism as ProjectInfo["mechanism"],
    attributes: p.attributes,
    chains: p.chains,
    l2beatSlug: p.l2beatSlug,
    defillamaSlug: p.defillamaSlug,
  };
}

/** Effective answer after an editor override. */
export function effective(r: ResultRow): { status: "answered" | "unknown" | "not_researched" | "not_applicable"; optionId: string | null } {
  if (r.overrideStatus) return { status: r.overrideStatus as "answered", optionId: r.overrideOptionId };
  return { status: r.status as "answered", optionId: r.optionId };
}

/**
 * Strongest verified source class behind the answer. With decisive records (the judge named the ones that
 * establish its option) every stance counts: a middle option is often established by a record the researcher
 * labelled "contradicts". Results from before decisive records existed count supporting records only.
 */
function bestClass(ev: EvidenceRow[], anyStance = false): SourceClass | null {
  let best: SourceClass | null = null;
  for (const e of ev) {
    if (!e.verified || (!anyStance && e.stance !== "supports")) continue;
    const c = e.sourceClass as SourceClass;
    if (!best || CLASS_RANK[c] > CLASS_RANK[best]) best = c;
  }
  return best;
}

export function versionInfo(v: typeof schema.projectVersions.$inferSelect): VersionInfo {
  return {
    id: v.id,
    version: v.version,
    label: v.label,
    releasedAt: v.releasedAt,
    source: v.source as VersionInfo["source"],
    sourceUrl: v.sourceUrl,
    tag: v.tag,
    isMajor: v.isMajor,
    summary: v.summary,
  };
}

/** What a snapshot keeps of a cited source: metadata only, never the content (R3-REL-17). */
export type SourceMeta = Pick<SourceRow, "id" | "url" | "title" | "kind" | "sourceClass" | "date" | "fetchedAt" | "contentHash">;
const sourceMetaColumns = {
  id: schema.sources.id,
  url: schema.sources.url,
  title: schema.sources.title,
  kind: schema.sources.kind,
  sourceClass: schema.sources.sourceClass,
  date: schema.sources.date,
  fetchedAt: schema.sources.fetchedAt,
  contentHash: schema.sources.contentHash,
};

export interface EvaluationBundle {
  evaluation: typeof schema.evaluations.$inferSelect;
  project: ProjectRow;
  version: typeof schema.projectVersions.$inferSelect | null;
  results: ResultRow[];
  evidence: EvidenceRow[];
  sources: SourceMeta[];
}

/**
 * An evaluation with its project, version, results, evidence and the metadata of the sources its evidence cites.
 * Called once per judge suite, in verify, explain and summary, by the admin review page and at publish, so it reads
 * source metadata only: the cited sources' content can run to megabytes each (R3-REL-17).
 */
export async function loadEvaluation(db: DB, evaluationId: string): Promise<EvaluationBundle | null> {
  const evaluation = (await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, evaluationId)))[0];
  if (!evaluation) return null;
  const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, evaluation.projectId)))[0];
  if (!project) return null;
  const version = evaluation.versionId
    ? ((await db.select().from(schema.projectVersions).where(eq(schema.projectVersions.id, evaluation.versionId)))[0] ?? null)
    : null;
  const results = await db.select().from(schema.criterionResults).where(eq(schema.criterionResults.evaluationId, evaluationId));
  const evidence = await db.select().from(schema.evidence).where(eq(schema.evidence.evaluationId, evaluationId));
  const sourceIds = [...new Set(evidence.map((e) => e.sourceId).filter((x): x is string => !!x))];
  const sources = sourceIds.length ? await db.select(sourceMetaColumns).from(schema.sources).where(inArray(schema.sources.id, sourceIds)) : [];
  return { evaluation, project, version, results, evidence, sources };
}

export function answerMapFor(bundle: Pick<EvaluationBundle, "results" | "evidence"> & { evaluation?: { isDemo: boolean } }): AnswerMap {
  const byCrit = new Map<string, EvidenceRow[]>();
  for (const e of bundle.evidence) {
    const arr = byCrit.get(e.criterionId) ?? [];
    arr.push(e);
    byCrit.set(e.criterionId, arr);
  }
  const answers: AnswerMap = {};
  for (const r of bundle.results) {
    if (!findCriterion(r.criterionId)) continue;
    const eff = effective(r);
    const cited = (byCrit.get(r.criterionId) ?? []).filter((e) => r.evidenceIds.length === 0 || r.evidenceIds.includes(e.id));
    const decisive = r.decisiveEvidenceIds?.length ? cited.filter((e) => r.decisiveEvidenceIds.includes(e.id)) : null;
    answers[r.criterionId] = {
      criterionId: r.criterionId,
      status: eff.status,
      optionId: eff.optionId,
      // undefined = not assessed: editor overrides are human judgments, and hand-labelled demo data predates
      // evidence linking. null = assessed and nothing verified supports the answer (discounted when favorable).
      verifiability:
        r.overrideStatus || (bundle.evaluation?.isDemo && cited.length === 0) ? undefined : decisive?.length ? bestClass(decisive, true) : bestClass(cited),
    };
  }
  return answers;
}

/** The judge's answer is the criterion's "nothing published" option after a logged search found nothing (rubric 1.3.0). */
function notDisclosed(r: ResultRow): boolean {
  const eff = effective(r);
  return (
    !r.overrideStatus &&
    eff.status === "answered" &&
    !!eff.optionId &&
    eff.optionId === findCriterion(r.criterionId)?.noDataOption &&
    !!r.searchLog?.searched?.length
  );
}

export function criterionFlags(r: ResultRow, cited: EvidenceRow[], verifiability: SourceClass | null | undefined): CriterionFlag[] {
  const flags = new Set<CriterionFlag>(r.flags as CriterionFlag[]);
  const eff = effective(r);
  const c = findCriterion(r.criterionId);
  if (eff.status === "answered" && !r.overrideStatus && !cited.some((e) => e.verified) && !notDisclosed(r)) flags.add("unverified");
  if (eff.status === "unknown" && !flags.has("no_evidence") && !flags.has("needs_quote")) flags.add("unverified");
  if (r.confidence === "low") flags.add("low_confidence");
  if (r.overrideStatus) flags.add("editor_adjusted");
  if (c && eff.status === "answered" && eff.optionId && isHighScrutiny(c) && isFavorable(c, eff.optionId)) {
    if (verifiability === "marketing") flags.add("self_reported");
    if (verifiability === null) flags.add("unsupported_favorable");
  }
  return [...flags];
}

export function buildSnapshot(bundle: EvaluationBundle, release: ReleaseInfo): ProjectSnapshot {
  const answers = answerMapFor(bundle);
  const scores = scoreProject(answers);
  const evidenceById = new Map(bundle.evidence.map((e) => [e.id, e]));
  const usedSources = new Set<string>();
  const crit: Record<string, SnapshotCriterion> = {};
  for (const r of bundle.results) {
    if (!findCriterion(r.criterionId)) continue;
    const eff = effective(r);
    const cited = r.evidenceIds.length
      ? r.evidenceIds.map((id) => evidenceById.get(id)).filter((e): e is EvidenceRow => !!e)
      : bundle.evidence.filter((e) => e.criterionId === r.criterionId);
    const ev: SnapshotEvidence[] = cited.map((e) => {
      if (e.sourceId) usedSources.add(e.sourceId);
      return {
        id: e.id,
        sourceId: e.sourceId ?? "",
        quote: e.quote,
        claim: e.claim,
        verified: e.verified,
        citedUrl: e.citedUrl,
        stance: (["supports", "contradicts", "context"].includes(e.stance) ? e.stance : "context") as SnapshotEvidence["stance"],
        match: e.verifyNote === "search attestation" ? "attestation" : (e.verifyMethod as SnapshotEvidence["match"]),
        context: e.quoteContext ? e.quoteContext.slice(0, 900) : null,
        sourceClass: e.sourceClass as SourceClass,
        ...(r.decisiveEvidenceIds?.includes(e.id) ? { decisive: true } : {}),
      };
    });
    const verifiability = answers[r.criterionId]?.verifiability;
    // A change explanation describes the judge's answer; after a review override it holds only if the published
    // answer is still the one it explained.
    const effectiveTo = eff.status === "answered" ? eff.optionId : eff.status;
    const change = r.change && r.change.to === effectiveTo ? r.change : null;
    const flags = criterionFlags(r, cited, verifiability).filter((f) => change || (f !== "changed_since_published" && f !== "change_unexplained"));
    crit[r.criterionId] = {
      status: eff.status,
      optionId: eff.optionId,
      rationale: r.rationale,
      confidence: r.confidence as SnapshotCriterion["confidence"],
      verifiability: verifiability ?? null,
      flags,
      override: r.overrideStatus ? { reason: r.overrideReason ?? "", originalOptionId: r.optionId } : null,
      evidence: ev,
      change: change ? { kind: change.kind, note: change.note, from: change.from, to: change.to } : null,
      searchLog: (eff.status === "unknown" || notDisclosed(r)) && r.searchLog ? r.searchLog : null,
    };
  }
  const sources: SnapshotSource[] = bundle.sources
    .filter((s) => usedSources.has(s.id))
    .map((s) => ({
      id: s.id,
      url: s.url,
      title: s.title,
      kind: s.kind as SnapshotSource["kind"],
      sourceClass: s.sourceClass as SourceClass,
      date: s.date,
      fetchedAt: s.fetchedAt,
      contentHash: s.contentHash ?? undefined,
    }));
  return {
    project: projectInfo(bundle.project),
    version: bundle.version ? versionInfo(bundle.version) : null,
    release,
    evaluatedAt: bundle.evaluation.finishedAt ?? bundle.evaluation.createdAt,
    evidenceAsOf:
      (bundle.evaluation.settings as { evidenceCutoff?: string }).evidenceCutoff ?? (bundle.evaluation.finishedAt ?? bundle.evaluation.createdAt).slice(0, 10),
    summary: bundle.evaluation.summary,
    powers: bundle.evaluation.powers,
    context: bundle.evaluation.context,
    scores,
    criteria: crit,
    sources,
    knowledgeBase: (bundle.evaluation.settings as { knowledgeBase?: KnowledgeBaseInfo }).knowledgeBase ?? null,
    coverage: bundle.evaluation.isDemo
      ? null
      : (({ covered, total, suites }) => ({ covered, total, suites }))(
          coverageFrom(bundle.results, bundle.evidence, null, { requireCodeCheck: !!(bundle.evaluation.settings as { codeCheck?: boolean }).codeCheck }),
        ),
    matrix: bundle.evaluation.adversaryMatrix as AdversaryMatrix,
  };
}

export function leaderboardRow(s: ProjectSnapshot): LeaderboardRow {
  const cells: Record<string, BenchmarkCell> = {};
  for (const suite of s.scores.suites) {
    for (const b of suite.benchmarks) {
      const crits = b.criteria.map((c) => s.criteria[c.criterionId]);
      cells[b.benchmarkId] = {
        score: b.score,
        unknownCount: b.unknownCount,
        unverifiedCount: crits.filter((c) => c?.flags.includes("unverified")).length,
        capped:
          b.rules.some((r) => r === "operator_visibility_cap" || r === "critical_bug_cap" || r === "no_private_logic_gate" || r === "l0_gate") ||
          b.criteria.some((c) => c.rules.includes("instant_upgrade_power")),
        adjusted: crits.some((c) => c?.flags.includes("editor_adjusted")),
        selfReported: crits.some((c) => c?.flags.includes("self_reported")),
      };
    }
  }
  return {
    slug: s.project.slug,
    name: s.project.name,
    version: s.version,
    otherVersions: [],
    logoUrl: s.project.logoUrl,
    tagline: s.project.tagline,
    category: s.project.category,
    mechanism: s.project.mechanism,
    overall: s.scores.overall,
    level: s.scores.level,
    trustTier: s.scores.trustTier,
    walkaway: s.scores.walkaway,
    suites: Object.fromEntries(s.scores.suites.map((x) => [x.suiteId, x.score])),
    benchmarks: cells,
    evaluatedAt: s.evaluatedAt,
  };
}

export function releaseInfo(r: typeof schema.releases.$inferSelect): ReleaseInfo {
  return { id: r.id, label: r.label, publishedAt: r.publishedAt, isDemo: r.isDemo, rubricVersion: r.rubricVersion };
}

export interface PublishInput {
  evaluationIds: string[];
  label: string;
  notes: string;
  isDemo?: boolean;
  settings?: EvalSettings | null;
}

/** Freezes the given evaluations into an immutable release. Demo and real results never mix. */
export async function publishRelease(db: DB, input: PublishInput): Promise<string> {
  const releaseId = newId();
  const publishedAt = new Date().toISOString();
  const bundles: EvaluationBundle[] = [];
  for (const id of input.evaluationIds) {
    const b = await loadEvaluation(db, id);
    if (!b) throw new Error(`Evaluation ${id} not found`);
    if (!!b.evaluation.isDemo !== !!input.isDemo) throw new Error("Demo and real evaluations can't be published together");
    bundles.push(b);
  }
  // Only the documented, public settings: the evaluation row also holds pipeline working state (unreviewed
  // scout and code-audit notes, stage progress) that must never be published (SEC-5).
  const settings = publicSettings(input.settings ?? bundles[0]?.evaluation.settings);
  // Accepted corrections for the projects in this release are applied by it: listed in its notes, marked done.
  const applied = input.isDemo
    ? []
    : await acceptedCorrections(
        db,
        bundles.map((b) => b.project.slug),
      );
  const notes = applied.length ? `${input.notes.trim()}\n\n${correctionNotes(applied, bundles)}`.trim() : input.notes;
  await db.transaction(async (tx) => {
    await tx.insert(schema.releases).values({
      id: releaseId,
      label: input.label,
      rubricVersion: rubric.version,
      notesMd: notes,
      isDemo: !!input.isDemo,
      evalSettings: settings as never,
      publishedAt,
    });
    const release: ReleaseInfo = { id: releaseId, label: input.label, publishedAt, isDemo: !!input.isDemo, rubricVersion: rubric.version };
    for (const b of bundles) {
      const snap = buildSnapshot(b, release);
      // A newer release supersedes the earlier published result for the same project version.
      await tx
        .update(schema.publishedResults)
        .set({ active: false })
        .where(
          and(
            eq(schema.publishedResults.projectId, b.project.id),
            b.evaluation.versionId ? eq(schema.publishedResults.versionId, b.evaluation.versionId) : isNull(schema.publishedResults.versionId),
          ),
        );
      await tx.insert(schema.publishedResults).values({
        id: newId(),
        releaseId,
        projectId: b.project.id,
        evaluationId: b.evaluation.id,
        versionId: b.evaluation.versionId,
        overall: snap.scores.overall,
        level: snap.scores.level,
        trustTier: snap.scores.trustTier,
        walkaway: snap.scores.walkaway.passed,
        active: true,
        snapshot: snap as never,
      });
      await tx.update(schema.evaluations).set({ status: "published" }).where(eq(schema.evaluations.id, b.evaluation.id));
    }
    for (const c of applied) await tx.update(schema.corrections).set({ status: "done", releaseId }).where(eq(schema.corrections.id, c.id));
  });
  bumpSnapshots();
  return releaseId;
}

type CorrectionRow = typeof schema.corrections.$inferSelect;

async function acceptedCorrections(db: DB, slugs: string[]): Promise<CorrectionRow[]> {
  if (!slugs.length) return [];
  return await db
    .select()
    .from(schema.corrections)
    .where(and(eq(schema.corrections.status, "accepted"), inArray(schema.corrections.projectSlug, slugs)))
    .orderBy(schema.corrections.createdAt);
}

/** The release-notes section for applied corrections: the editor's reason, never the submitter's text or contact. */
function correctionNotes(applied: CorrectionRow[], bundles: { project: { slug: string; name: string } }[]): string {
  const name = (slug: string) => bundles.find((b) => b.project.slug === slug)?.project.name ?? slug;
  const lines = applied.map((c) => {
    const where = c.criterionId ? `${name(c.projectSlug)} · ${findCriterion(c.criterionId)?.label ?? c.criterionId}` : name(c.projectSlug);
    return `- ${where}: ${c.decisionNote ?? "corrected after review"}`;
  });
  return `Corrections applied in this release:\n${lines.join("\n")}`;
}

/** Rolls a project version back to its previous published result (or removes it if there was none). */
export async function unpublishProject(db: DB, projectId: string, versionId: string | null = null) {
  const rows = await db
    .select()
    .from(schema.publishedResults)
    .where(and(eq(schema.publishedResults.projectId, projectId), versionId ? eq(schema.publishedResults.versionId, versionId) : undefined))
    .orderBy(desc(schema.publishedResults.createdAt));
  const active = rows.find((r) => r.active);
  if (!active) return;
  await db.transaction(async (tx) => {
    await tx.update(schema.publishedResults).set({ active: false }).where(eq(schema.publishedResults.id, active.id));
    const prev = rows.find((r) => r.id !== active.id && r.createdAt <= active.createdAt);
    if (prev) await tx.update(schema.publishedResults).set({ active: true }).where(eq(schema.publishedResults.id, prev.id));
  });
  bumpSnapshots();
}

// ---------- published-snapshot cache (EFF-1) ----------
//
// Published snapshots never change, so the parsed list is cached and rebuilt only when the published set changes.
// `generation` increases on every change; it keys ETags and the card PNG cache. Writers call `bumpSnapshots()`
// (publish, unpublish, demo purge/seed, project status changes), and a cheap fingerprint query on every read
// catches any writer that doesn't, so the cache can't keep serving withdrawn or archived results.

/** Changes on every boot, so ETags from a previous process (whose generation counter restarted) never match. */
const BOOT_ID = randomBytes(4).toString("hex");
let generation = 0;

interface SnapshotCache {
  db: DB;
  gen: number;
  fingerprint: string;
  /** Active results of active projects, demo included. */
  all: ProjectSnapshot[];
  /** What the public site shows: real results once any exist, otherwise the demo. */
  visible: ProjectSnapshot[];
  /** Newest version first. */
  allByProject: Map<string, ProjectSnapshot[]>;
  visibleByProject: Map<string, ProjectSnapshot[]>;
  memo: LruCache<MemoEntry>;
}

let cache: SnapshotCache | null = null;
/** One rebuild at a time: concurrent requests after a change share it. */
let building: { db: DB; fp: string; promise: Promise<SnapshotCache> } | null = null;

/**
 * Changes whenever the published set or a project's visibility changes, in this process or another replica: the
 * active rows (count and an order-independent hash of their ids) and the ids of hidden projects.
 */
async function fingerprint(db: DB): Promise<string> {
  const [row] = await query<{ fp: string }>(
    db,
    sql`SELECT (SELECT count(*)::text || '.' || coalesce(sum(hashtext(id)::bigint), 0)::text FROM published_results WHERE active) || '|' ||
      (SELECT coalesce(string_agg(id, ',' ORDER BY id), '') FROM projects WHERE status <> 'active') AS fp`,
  );
  return String(row?.fp ?? "");
}

/** Invalidates the published-snapshot cache. Call after anything that changes what's published or visible. */
export function bumpSnapshots(): void {
  generation++;
  cache = null;
}

function versionSortKey(s: ProjectSnapshot): string {
  return `${s.version?.releasedAt ?? ""}|${s.release.publishedAt}`;
}

function groupByProject(list: ProjectSnapshot[]): Map<string, ProjectSnapshot[]> {
  const map = new Map<string, ProjectSnapshot[]>();
  for (const s of list) {
    const arr = map.get(s.project.slug) ?? [];
    arr.push(s);
    map.set(s.project.slug, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => versionSortKey(b).localeCompare(versionSortKey(a)));
  return map;
}

/**
 * A stored snapshot as today's code reads it: results published before the privacy levels were renamed carry L0 to
 * L5, shown as Z0 to Z5. The stored record itself is never rewritten.
 */
export function readSnapshot(raw: unknown): ProjectSnapshot {
  const s = raw as ProjectSnapshot;
  const level = normalizeLevel(s.scores?.level ?? null);
  return s.scores && s.scores.level !== level ? { ...s, scores: { ...s.scores, level } } : s;
}

async function loadActive(db: DB, includeArchived: boolean): Promise<ProjectSnapshot[]> {
  const rows = await db
    .select({ snapshot: schema.publishedResults.snapshot, status: schema.projects.status })
    .from(schema.publishedResults)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.publishedResults.projectId))
    .where(eq(schema.publishedResults.active, true));
  return rows.filter((r) => includeArchived || r.status === "active").map((r) => readSnapshot(r.snapshot));
}

async function snapshotCache(db: DB): Promise<SnapshotCache> {
  const fp = await fingerprint(db);
  if (cache && cache.db === db && cache.fingerprint === fp) return cache;
  if (building && building.db === db && building.fp === fp) return building.promise;
  const promise = rebuild(db, fp);
  building = { db, fp, promise };
  try {
    return await promise;
  } finally {
    if (building?.promise === promise) building = null;
  }
}

async function rebuild(db: DB, fp: string): Promise<SnapshotCache> {
  if (cache) generation++;
  const all = await loadActive(db, false);
  const real = all.filter((s) => !s.release.isDemo);
  const visible = real.length ? real : all;
  const allByProject = groupByProject(all);
  cache = {
    db,
    gen: generation,
    fingerprint: fp,
    all,
    visible,
    allByProject,
    visibleByProject: visible === all ? allByProject : groupByProject(visible),
    memo: newMemo(),
  };
  return cache;
}

/**
 * A version of the published, visible data that's the same on every replica (a hash of what decides it), for
 * clients to know when to refetch. It names nothing: hidden projects' ids stay out of it.
 */
export async function publishedDataVersion(db: DB): Promise<string> {
  return createHash("sha256")
    .update((await snapshotCache(db)).fingerprint)
    .digest("hex")
    .slice(0, 16);
}

/** The current publish generation (changes whenever the published or visible set changes). */
export async function snapshotGeneration(db: DB): Promise<number> {
  return (await snapshotCache(db)).gen;
}

/** Weak ETag for responses derived only from published snapshots. */
export async function snapshotEtag(db: DB): Promise<string> {
  return `W/"${BOOT_ID}-${(await snapshotCache(db)).gen}"`;
}

/**
 * Keys come from request parameters, so the memo is bounded by entries and by size (R3-SEC-6): least recently used
 * entries go first. Strings count their length; anything else counts as a small fixed size.
 */
export const MEMO_MAX_ENTRIES = 256;
export const MEMO_MAX_BYTES = 32 * 1024 * 1024;
type MemoEntry = { v: unknown };
const newMemo = () =>
  new LruCache<MemoEntry>({ maxSize: MEMO_MAX_BYTES, maxEntries: MEMO_MAX_ENTRIES, sizeOf: (e) => (typeof e.v === "string" ? e.v.length : 256) });

/** Computes a value once per publish generation (e.g. a pre-serialized response body). */
export async function snapshotMemo<T>(db: DB, key: string, build: () => T | Promise<T>): Promise<T> {
  const c = await snapshotCache(db);
  const hit = c.memo.get(key);
  if (hit) return hit.v as T;
  const v = await build();
  c.memo.set(key, { v });
  return v;
}

/** The memoized value for `key` in the current generation, without building it (undefined on a miss). */
export async function snapshotMemoPeek<T>(db: DB, key: string): Promise<T | undefined> {
  return (await snapshotCache(db)).memo.get(key)?.v as T | undefined;
}

/** Size of the current generation's memo (tests and diagnostics). */
export async function snapshotMemoStats(db: DB): Promise<{ entries: number; bytes: number }> {
  const m = (await snapshotCache(db)).memo;
  return { entries: m.size, bytes: m.bytes };
}

/** Every active published result: one per (project, version). Cached: treat the snapshots as read-only. */
export async function activeSnapshots(db: DB, opts: { includeArchived?: boolean } = {}): Promise<ProjectSnapshot[]> {
  if (opts.includeArchived) return loadActive(db, true);
  return [...(await snapshotCache(db)).all];
}

/** Demo and real data never mix: once any real result is published, demo results are hidden. */
export async function visibleSnapshots(db: DB): Promise<ProjectSnapshot[]> {
  return [...(await snapshotCache(db)).visible];
}

/** Visible snapshots grouped by project slug, newest version first. Read-only. */
export async function visibleByProject(db: DB): Promise<ReadonlyMap<string, readonly ProjectSnapshot[]>> {
  return (await snapshotCache(db)).visibleByProject;
}

/** The documented, public release settings. Anything else in a stored settings object is internal working state. */
export const PUBLIC_SETTINGS_KEYS = [
  "mode",
  "models",
  "effort",
  "votesHighImpact",
  "votesOther",
  "maxToolCalls",
  "promptHashes",
  "evidenceCutoff",
  "notes",
] as const satisfies readonly (keyof EvalSettings)[];

export function publicSettings(raw: unknown): EvalSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return Object.fromEntries(PUBLIC_SETTINGS_KEYS.filter((k) => k in r).map((k) => [k, r[k]])) as unknown as EvalSettings;
}

/** Groups active snapshots by project, newest version first. */
export async function snapshotsByProject(db: DB): Promise<Map<string, ProjectSnapshot[]>> {
  const map = new Map<string, ProjectSnapshot[]>();
  for (const s of await activeSnapshots(db)) {
    const arr = map.get(s.project.slug) ?? [];
    arr.push(s);
    map.set(s.project.slug, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => versionSortKey(b).localeCompare(versionSortKey(a)));
  return map;
}

/** Resolves `slug` or `slug@version` to an active snapshot (latest version by default). */
export async function resolveSnapshot(db: DB, ref: string, opts: { visibleOnly?: boolean } = {}): Promise<ProjectSnapshot | null> {
  const [slug, version] = ref.split("@");
  const c = await snapshotCache(db);
  const list = (opts.visibleOnly ? c.visibleByProject : c.allByProject).get(slug ?? "") ?? [];
  if (!list.length) return null;
  if (!version) return list[0] ?? null;
  return list.find((s) => s.version?.version === version) ?? null;
}

export async function snapshotHistory(db: DB, projectId: string) {
  const rows = await db
    .select({
      snapshot: schema.publishedResults.snapshot,
      overall: schema.publishedResults.overall,
      level: schema.publishedResults.level,
      release: schema.releases,
    })
    .from(schema.publishedResults)
    .innerJoin(schema.releases, eq(schema.releases.id, schema.publishedResults.releaseId))
    .where(and(eq(schema.publishedResults.projectId, projectId)))
    .orderBy(desc(schema.releases.publishedAt));
  return rows.map((r) => ({ ...r, snapshot: readSnapshot(r.snapshot), level: normalizeLevel(r.level) }));
}

export const ALL_CRITERIA_IDS = criteria.map((c) => c.id);
export const ALL_BENCHMARK_IDS = benchmarks.map((b) => b.id);
