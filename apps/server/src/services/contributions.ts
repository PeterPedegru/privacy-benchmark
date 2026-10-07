/** Sourced, manual evaluations enter the ordinary review flow. Importing never publishes or overrides answers. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { httpUrlSchema, type ProjectSnapshot, projectInputSchema } from "@pb/core";
import { type AdversaryMatrix, type AnswerMap, consistencyConflicts, criteria, findCriterion, matrixConflicts, rubric, scoreProject } from "@pb/rubric";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { type DB, driverOf, schema } from "../db/index.ts";
import { flagMissingEvidence, storeReviewFlags } from "../eval/pipeline.ts";
import { newId } from "../lib/ids.ts";
import { coverageFrom } from "./coverage.ts";
import { verifyQuote } from "./quotes.ts";
import { answerMapFor, bumpSnapshots, loadEvaluation } from "./snapshots.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sourceSchema = z.object({
  id: z.string().min(1),
  url: httpUrlSchema,
  title: z.string().min(1),
  kind: z.enum(["docs", "website", "code", "blog", "audit", "onchain", "analysis"]),
  sourceClass: z.enum(["code_onchain", "independent", "official_docs", "third_party", "marketing"]),
  date: date.nullable(),
  fetchedAt: z.iso.datetime({ offset: true }),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  contentMd: z.string().min(1),
  // Unlinked code, other versions and roadmap descriptions cannot establish live favorable answers.
  scope: z.enum(["evaluated", "context"]),
});
const answerSchema = z.object({
  criterionId: z.string(),
  status: z.enum(["answered", "unknown", "not_applicable"]),
  optionId: z.string().nullable(),
  rationale: z.string().min(20),
  confidence: z.enum(["high", "medium", "low"]),
  evidence: z.array(
    z.object({ sourceId: z.string(), quote: z.string().min(20), claim: z.string().min(1), stance: z.enum(["supports", "contradicts", "context"]) }),
  ),
  searchLog: z.object({ searched: z.array(z.string().min(1)).min(1), note: z.string().min(1), codeChecked: z.boolean().optional() }).optional(),
});
const cell = z.object({ state: z.enum(["private", "at_risk", "exposed", "unverifiable", "n_a"]), note: z.string().optional() });
const matrixSchema = z.partialRecord(
  z.enum(["public_observer", "chain_analyst", "network_observer", "privileged_insider", "future_adversary"]),
  z.partialRecord(z.enum(["sender", "recipient", "amount", "asset", "link", "function", "metadata"]), cell),
);
const contributionSchema = z.object({
  rubricVersion: z.literal(rubric.version),
  asOf: date,
  attribution: z.string().min(20),
  project: projectInputSchema.omit({ websiteUrl: true }).extend({ website: httpUrlSchema }),
  version: z.object({ version: z.string().min(1), label: z.string().min(1), releasedAt: date.nullable(), sourceUrl: httpUrlSchema }),
  summary: z.string().min(20),
  context: z.record(z.string(), z.string()),
  powers: z.array(z.string()),
  matrix: matrixSchema,
  answers: z.array(answerSchema),
});

export type Contribution = z.infer<typeof contributionSchema>;
type Source = z.infer<typeof sourceSchema>;
export type PreparedContribution = ReturnType<typeof prepareContribution>;

export function prepareContribution(input: unknown, archivedSources: unknown[]) {
  const data = contributionSchema.parse(input);
  const sources = archivedSources.map((s) => sourceSchema.parse(s));
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  if (sourceById.size !== sources.length || new Set(sources.map((s) => s.url)).size !== sources.length) throw new Error("Duplicate source ID or URL");
  for (const s of sources) {
    if (createHash("sha256").update(s.contentMd).digest("hex") !== s.contentHash) throw new Error(`Source hash mismatch: ${s.id}`);
    if (s.date && s.date > data.asOf) throw new Error(`Source postdates the evidence cutoff: ${s.id}`);
  }
  const ids = new Set(data.answers.map((a) => a.criterionId));
  if (ids.size !== data.answers.length || ids.size !== criteria.length || criteria.some((c) => !ids.has(c.id)))
    throw new Error("A contribution must research every criterion exactly once");
  const answers: AnswerMap = {};
  const evidence: { id: string; criterionId: string; verified: boolean; stance: string; verifyNote: null; sourceClass: string }[] = [];
  const results = data.answers.map((a) => {
    const c = findCriterion(a.criterionId)!;
    if (a.status === "answered" && !c.options.some((o) => o.id === a.optionId)) throw new Error(`Invalid option: ${c.id}`);
    if (a.status === "not_applicable" && !c.naAllowed) throw new Error(`Not applicable is not allowed: ${c.id}`);
    if (a.status !== "answered" && a.optionId !== null) throw new Error(`Unanswered criterion has an option: ${c.id}`);
    const noData = a.status === "answered" && a.optionId === c.noDataOption;
    if ((a.status === "unknown" || noData) && !a.searchLog) throw new Error(`Missing research log: ${c.id}`);
    const decisive: string[] = [];
    const classes: Source["sourceClass"][] = [];
    a.evidence = a.evidence.map((e, i) => {
      const s = sourceById.get(e.sourceId);
      if (!s) throw new Error(`Unknown source: ${e.sourceId}`);
      const check = verifyQuote(e.quote, s.contentMd);
      if (!check.verified || check.method !== "exact") throw new Error(`Quote did not match exactly: ${c.id} / ${s.id}`);
      if (s.scope === "context" && e.stance !== "context") throw new Error(`Context source cannot establish an answer: ${c.id} / ${s.id}`);
      const id = `${c.id}:${i}`;
      evidence.push({ id, criterionId: c.id, verified: true, stance: e.stance, verifyNote: null, sourceClass: s.sourceClass });
      if (e.stance !== "context") {
        decisive.push(id);
        classes.push(s.sourceClass);
      }
      return { ...e, quote: check.span! };
    });
    if (a.status !== "unknown" && !noData && !decisive.length) throw new Error(`Answer needs establishing evidence: ${c.id}`);
    const rank = ["code_onchain", "independent", "official_docs", "third_party", "marketing"];
    classes.sort((a, b) => rank.indexOf(a) - rank.indexOf(b));
    answers[c.id] = { criterionId: c.id, status: a.status, optionId: a.optionId, verifiability: classes[0] ?? null };
    return { ...a, overrideStatus: null, decisiveEvidenceIds: decisive };
  });
  const conflicts = [...consistencyConflicts(answers), ...matrixConflicts(data.matrix as AdversaryMatrix, answers)];
  if (conflicts.length) throw new Error(`Inconsistent contribution: ${conflicts.map((c) => c.message).join("; ")}`);
  return { data, sources, scores: scoreProject(answers), coverage: coverageFrom(results, evidence, null, { requireCodeCheck: true }) };
}

/** Read only files inside the package; an archive hash pins exactly the text checked for quotes. */
export function readContribution(directory: string): PreparedContribution {
  const root = realpathSync(directory);
  const read = (file: string) => {
    const path = realpathSync(resolve(root, file));
    const rel = relative(root, path);
    if (rel.startsWith(`..${sep}`) || rel === ".." || resolve(path) === root) throw new Error("Source path leaves the contribution directory");
    return readFileSync(path, "utf8");
  };
  const manifest = z.array(sourceSchema.omit({ contentMd: true }).extend({ file: z.string().min(1) })).parse(JSON.parse(read("sources.json")));
  return prepareContribution(
    JSON.parse(read("assessment.json")),
    manifest.map((s) => ({ ...s, contentMd: read(s.file) })),
  );
}

export async function importContribution(db: DB, prepared: PreparedContribution): Promise<string> {
  const { data, sources } = prepared;
  if ((await db.select().from(schema.projects).where(eq(schema.projects.slug, data.project.slug)))[0])
    throw new Error(`Project already exists: ${data.project.slug}. Import into an empty project namespace; existing evidence is never replaced.`);
  const projectId = newId();
  const versionId = newId();
  const evaluationId = newId();
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    const { website, ...p } = data.project;
    await tx.insert(schema.projects).values({ ...p, id: projectId, websiteUrl: website, trackVersions: false });
    await tx.insert(schema.projectVersions).values({
      ...data.version,
      id: versionId,
      projectId,
      source: "manual",
      status: "tracked",
      privacyRelevant: true,
      // A source snapshot is not a confirmation of deployed code correspondence.
      deployment: null,
    });
    await tx.insert(schema.evaluations).values({
      id: evaluationId,
      projectId,
      versionId,
      mode: "manual",
      status: "review",
      stage: "review",
      completedStages: [],
      summary: data.summary,
      summaryAt: now,
      powers: data.powers,
      context: { ...data.context, evaluation: data.attribution },
      adversaryMatrix: data.matrix,
      settings: {
        mode: "manual",
        models: {},
        effort: {},
        votesHighImpact: 0,
        votesOther: 0,
        maxToolCalls: {},
        promptHashes: {},
        evidenceCutoff: data.asOf,
        codeCheck: true,
        notes: data.attribution,
      },
      isDemo: false,
      finishedAt: now,
    });
    const sourceIds = new Map<string, string>();
    for (const s of sources) {
      const id = newId();
      sourceIds.set(s.id, id);
      const { id: _id, scope, ...row } = s;
      await tx.insert(schema.sources).values({ ...row, id, projectId, origin: "admin", meta: { contribution: data.project.slug, scope } });
    }
    for (const a of data.answers) {
      const evidenceIds: string[] = [];
      const decisiveEvidenceIds: string[] = [];
      for (const e of a.evidence) {
        const s = sources.find((s) => s.id === e.sourceId)!;
        const check = verifyQuote(e.quote, s.contentMd);
        const id = newId();
        evidenceIds.push(id);
        if (e.stance !== "context") decisiveEvidenceIds.push(id);
        await tx.insert(schema.evidence).values({
          id,
          evaluationId,
          criterionId: a.criterionId,
          sourceId: sourceIds.get(s.id)!,
          url: s.url,
          claim: e.claim,
          quote: check.span!,
          quoteContext: check.context ?? null,
          stance: e.stance,
          sourceClass: s.sourceClass,
          verified: true,
          verifyMethod: "exact",
          createdByStage: "manual",
        });
      }
      await tx.insert(schema.criterionResults).values({
        id: newId(),
        evaluationId,
        criterionId: a.criterionId,
        status: a.status,
        optionId: a.optionId,
        rationale: a.rationale,
        confidence: a.confidence,
        evidenceIds,
        decisiveEvidenceIds,
        searchLog: a.searchLog ?? null,
        flags: [...(a.status === "unknown" ? ["unverified"] : []), ...(a.confidence === "low" ? ["low_confidence"] : [])],
        updatedAt: now,
      });
      if (a.searchLog)
        await tx
          .insert(schema.searchLogs)
          .values({ id: newId(), evaluationId, criterionId: a.criterionId, searched: a.searchLog.searched, note: a.searchLog.note, createdByStage: "manual" });
    }
    // Review flags and score verification are part of the import: a failure must roll back the entire namespace.
    const transactionDb = tx as unknown as DB;
    await storeReviewFlags(transactionDb, evaluationId);
    await flagMissingEvidence(transactionDb, evaluationId);
    const bundle = (await loadEvaluation(transactionDb, evaluationId))!;
    if (JSON.stringify(scoreProject(answerMapFor(bundle))) !== JSON.stringify(prepared.scores))
      throw new Error("Imported scoring differs from the validated contribution");
  });
  return evaluationId;
}

/** Local comparison only: copy published snapshots verbatim, never reconstruct or re-judge their evidence. */
export async function importPublishedBaseline(db: DB, snapshots: ProjectSnapshot[]): Promise<void> {
  if (driverOf(db) !== "pglite") throw new Error("Published baselines can only be copied into a local PGlite database");
  if ((await db.select().from(schema.projects).limit(1)).length) throw new Error("Baseline import requires an empty local database");
  if (!snapshots.length || new Set(snapshots.map((s) => s.project.slug)).size !== snapshots.length) throw new Error("Invalid baseline project list");
  for (const s of snapshots) {
    projectInputSchema.parse({ ...s.project, websiteUrl: s.project.website });
    if (s.release.isDemo || s.release.rubricVersion !== rubric.version || s.scores.rubricVersion !== rubric.version)
      throw new Error("Baseline must contain published, non-demo results for the current rubric");
    if (criteria.some((c) => !s.criteria[c.id])) throw new Error("Incomplete baseline snapshot");
  }
  await db.transaction(async (tx) => {
    const releases = new Set<string>();
    for (const s of snapshots) {
      const projectId = newId();
      const versionId = s.version ? newId() : null;
      const { website, ...p } = s.project;
      await tx.insert(schema.projects).values({ ...p, id: projectId, websiteUrl: website, trackVersions: false });
      if (s.version && versionId) await tx.insert(schema.projectVersions).values({ ...s.version, id: versionId, projectId, status: "tracked" });
      if (!releases.has(s.release.id)) {
        await tx.insert(schema.releases).values({
          id: s.release.id,
          label: s.release.label,
          publishedAt: s.release.publishedAt,
          rubricVersion: s.release.rubricVersion,
          isDemo: false,
          notesMd:
            "Local archive of published Privacy Benchmark snapshots. Scores, evidence and dates are copied unchanged; no local evaluation was run for these projects.",
        });
        releases.add(s.release.id);
      }
      await tx.insert(schema.publishedResults).values({
        id: newId(),
        releaseId: s.release.id,
        projectId,
        versionId,
        overall: s.scores.overall,
        level: s.scores.level,
        trustTier: s.scores.trustTier,
        walkaway: s.scores.walkaway.passed,
        snapshot: s as unknown as Record<string, unknown>,
        createdAt: s.release.publishedAt,
      });
    }
  });
  bumpSnapshots();
}
