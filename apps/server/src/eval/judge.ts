import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { type AdversaryId, type CriterionDef, findCriterion, getSuite, relatedCriteria, SOURCE_CLASS_RANK, type SuiteId } from "@pb/rubric";
import { z } from "zod";
import type { schema } from "../db/index.ts";
import { addUsage, anthropic, llmCall, maxOutputFor, modelExtras, scopeSignal, stageEffort, type Usage } from "../lib/llm.ts";
import { OFF_CHAIN_POWERS } from "./absence.ts";
import { RefusalError } from "./agent.ts";
import { llmBackend, structuredViaClaudeCode } from "./claude-code.ts";
import { judgeSystem, MATRIX_INSTRUCTIONS, projectBlock, type Supersession, versionBlock } from "./prompts.ts";

type EvidenceRow = typeof schema.evidence.$inferSelect;
type SourceRow = typeof schema.sources.$inferSelect;
type ProjectRow = typeof schema.projects.$inferSelect;
type VersionRow = typeof schema.projectVersions.$inferSelect;

export interface JudgeAnswer {
  criterionId: string;
  status: "answered" | "unknown" | "not_applicable";
  optionId: string | null;
  rationale: string;
  evidenceIds: string[];
  /** The cited records whose quotes establish the chosen option (not merely relevant ones). */
  decisiveEvidenceIds: string[];
  confidence: "high" | "medium" | "low";
}

export interface MatrixRow {
  adversary: AdversaryId;
  field: string;
  state: string;
  note: string;
}

const FIELDS = ["sender", "recipient", "amount", "asset", "link", "function", "metadata"] as const;
const STATES = ["private", "at_risk", "exposed", "unverifiable", "n_a"] as const;

function answerSchema(criteria: CriterionDef[], adversaries: AdversaryId[]) {
  const ids = criteria.map((c) => c.id) as [string, ...string[]];
  const base = {
    answers: z.array(
      z.object({
        criterionId: z.enum(ids),
        status: z.enum(["answered", "unknown", "not_applicable"]),
        optionId: z.string().nullable(),
        rationale: z.string(),
        evidenceIds: z.array(z.string()),
        decisiveEvidenceIds: z.array(z.string()),
        confidence: z.enum(["high", "medium", "low"]),
      }),
    ),
  };
  if (!adversaries.length) return z.object(base);
  return z.object({
    ...base,
    matrix: z.array(
      z.object({
        adversary: z.enum(adversaries as [AdversaryId, ...AdversaryId[]]),
        field: z.enum(FIELDS),
        state: z.enum(STATES),
        note: z.string(),
      }),
    ),
  });
}

type SourceMeta = Pick<SourceRow, "id" | "title" | "url" | "date" | "fetchedAt" | "kind">;

/** Context around a quote, trimmed so the quote sits in the middle of at most `max` characters. */
function contextAround(e: EvidenceRow, max = 1500): string | null {
  if (!e.quoteContext) return null;
  const ctx = e.quoteContext.replace(/\s+/g, " ");
  const q = e.quote.replace(/\s+/g, " ");
  if (ctx.length <= q.length + 40) return null;
  const at = ctx.indexOf(q.slice(0, 60));
  if (at < 0) return ctx.slice(0, max);
  const pad = Math.max(0, Math.floor((max - q.length) / 2));
  const from = Math.max(0, at - pad);
  return `${from > 0 ? "…" : ""}${ctx.slice(from, from + Math.max(max, q.length + 2 * pad))}${from + max < ctx.length ? "…" : ""}`;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
}

/**
 * The evidence the judge sees: verified quotes only, each with its source, dates, class, the researcher's stance
 * and the text around the quote (so an out-of-context excerpt is visible). Shuffled per vote with a seed, to
 * counter position bias.
 */
export function evidenceTable(criteria: CriterionDef[], evidence: EvidenceRow[], sources: Map<string, SourceMeta>, shuffleSeed = 0): string {
  const lines: string[] = [];
  const render = (e: EvidenceRow) => {
    const src = e.sourceId ? sources.get(e.sourceId) : undefined;
    const dates = [src?.date ? `dated ${src.date}` : null, src?.fetchedAt ? `fetched ${src.fetchedAt.slice(0, 10)}` : null].filter(Boolean).join(", ");
    // Code, onchain and audit context is where a modifier or a caveat sits next to the quoted line: show more of it.
    const context = contextAround(e, e.sourceClass === "code_onchain" || src?.kind === "audit" || src?.kind === "code" ? 3000 : 1500);
    lines.push(
      [
        `- [${e.id}] ${e.sourceClass} · researcher's stance: ${e.stance} · ${src?.title ?? e.url} (${src?.url ?? e.url}${dates ? `; ${dates}` : ""})`,
        `  quote: "${e.quote.replace(/\s+/g, " ").slice(0, 4000)}"`,
        context ? `  context: "${context}"` : null,
        `  researcher's reading: ${e.claim}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  };
  const section = (id: string, label: string) => {
    let ev = evidence.filter((e) => e.criterionId === id && e.verified);
    if (shuffleSeed) ev = seededShuffle(ev, shuffleSeed + hashSeed(id));
    lines.push(`### ${id} (${label})`);
    if (!ev.length) lines.push("(no verified evidence)");
    for (const e of ev) render(e);
  };
  for (const c of criteria) section(c.id, c.label);
  // The same fact is often filed under a neighbouring criterion (a chain's uptime under the pause track record,
  // a timelock under upgrades): it's shown here and may be cited where it settles a criterion above.
  const asked = new Set(criteria.map((c) => c.id));
  const related = [...new Set(criteria.flatMap((c) => relatedCriteria(c.id)))].filter(
    (id) => !asked.has(id) && evidence.some((e) => e.criterionId === id && e.verified),
  );
  if (related.length) {
    lines.push(
      "",
      "## Related evidence (filed under linked criteria; cite a record for a criterion above only when its quote establishes that criterion's answer)",
    );
    for (const id of related) section(id, findCriterion(id)?.label ?? id);
  }
  return lines.join("\n");
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface JudgeInput {
  suiteId: SuiteId;
  criteria: CriterionDef[];
  project: ProjectRow;
  version: VersionRow | null;
  evidence: EvidenceRow[];
  sources: Map<string, SourceMeta>;
  model: string;
  usage: Usage;
  /** Adversary-matrix rows this call should fill (each row has one owner suite); [] for none. */
  matrixAdversaries: AdversaryId[];
  evaluationDate: string;
  supersededBy?: Supersession | null;
  /** The code auditor's structured map, rendered: context for spotting gaps, never evidence. */
  codeMap?: string | null;
  shuffleSeed?: number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export async function judgeSuite(i: JudgeInput): Promise<{ answers: JudgeAnswer[]; matrix: MatrixRow[] }> {
  const suite = getSuite(i.suiteId);
  const adversaries = i.matrixAdversaries;
  const outSchema = answerSchema(i.criteria, adversaries);
  const only = i.criteria.length < suite.benchmarks.reduce((n, b) => n + b.criteria.length, 0);
  const user = [
    // No directory description: it's editor-written and could carry conclusions into the judgment.
    projectBlock(i.project, { description: false }),
    versionBlock(i.project, i.version, i.evaluationDate, i.supersededBy ?? null),
    "",
    only ? `Answer ONLY these criteria: ${i.criteria.map((c) => c.id).join(", ")}.` : "Answer every criterion in this suite.",
    adversaries.length ? MATRIX_INSTRUCTIONS.replace("the adversaries this suite covers", adversaries.join(", ")) : "",
    "",
    "## Evidence records",
    evidenceTable(i.criteria, i.evidence, i.sources, i.shuffleSeed ?? 0),
    i.codeMap
      ? `\n## Code auditor's map (notes, NOT evidence: never cite it; use it to notice when the evidence misses a contract or power it lists)\n${i.codeMap}`
      : "",
  ].join("\n");

  const extras = modelExtras(i.model, stageEffort("judge", "high"));
  // Large suites (28 criteria plus the adversary matrix) with adaptive thinking can need well over 16k output
  // tokens, and a truncated answer is unparseable JSON. Stream so a high max_tokens doesn't hit request timeouts;
  // the stream helper parses structured output like messages.parse does.
  const fallbackBetas = (extras.fallbackParams as { betas?: string[] }).betas ?? [];
  const call = () =>
    anthropic()
      .beta.messages.stream(
        {
          model: i.model,
          max_tokens: maxOutputFor(i.model),
          system: [{ type: "text", text: judgeSystem(i.suiteId), cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: user }],
          ...(extras.thinking ? { thinking: extras.thinking } : {}),
          output_config: { ...(extras.effort ? { effort: extras.effort } : {}), format: betaZodOutputFormat(outSchema) },
          ...extras.fallbackParams,
          betas: [...fallbackBetas, "structured-outputs-2025-12-15"],
        },
        { signal: scopeSignal() },
      )
      .finalMessage();
  let res: { parsed_output: unknown; stop_reason: string | null; stop_details?: { category?: string } };
  if (llmBackend() === "claude-code") {
    // A Claude Code session with the judge's schema (no API).
    res = await structuredViaClaudeCode({
      model: i.model,
      effort: stageEffort("judge", "high"),
      system: judgeSystem(i.suiteId),
      user,
      schema: outSchema,
      usage: i.usage,
    });
  } else {
    let apiRes: Awaited<ReturnType<typeof call>>;
    try {
      apiRes = await llmCall(call, i.onRetry, { model: i.model, contextTokens: user.length / 3.5, maxTokens: maxOutputFor(i.model) });
    } catch (e) {
      if (/parse structured output/i.test((e as Error).message))
        throw new Error(`Judge output for ${i.suiteId} was cut off or malformed: ${(e as Error).message.slice(0, 200)}`);
      throw e;
    }
    addUsage(i.usage, i.model, apiRes.usage);
    res = apiRes as unknown as typeof res;
  }
  if (res.stop_reason === "refusal") {
    throw new RefusalError(res.stop_details?.category ?? null);
  }
  const parsed = res.parsed_output as { answers: JudgeAnswer[]; matrix?: MatrixRow[] } | null;
  if (!parsed) throw new Error(`Judge returned no parseable output (stop: ${res.stop_reason})`);
  return { answers: parsed.answers, matrix: parsed.matrix ?? [] };
}

export interface Validated {
  answer: JudgeAnswer;
  flags: string[];
  /** The option the judge chose when its answer had to be downgraded (shown to reviewers, never scored). */
  proposedOptionId: string | null;
}

const CLASS_RANK: Record<string, number> = SOURCE_CLASS_RANK;

/**
 * Validates a judge answer against the rubric and the evidence. An "answered" status needs the judge itself to
 * have cited at least one verified record for this criterion or a related one; nothing is attached on its behalf.
 * A downgraded answer keeps the judge's choice as a proposal with a `needs_quote` flag, so a reviewer can supply
 * the source. Decisive records are the ones whose quotes establish the option; verifiability is read from them.
 */
export function validateAnswer(a: JudgeAnswer, c: CriterionDef, evidence: EvidenceRow[]): Validated {
  const flags: string[] = [];
  let proposedOptionId: string | null = null;
  const citable = new Set([c.id, ...relatedCriteria(c.id)]);
  // A search attestation can't establish that a power held off-chain is absent (R5-1).
  const usable = (e: EvidenceRow) => !(e.verifyNote === "search attestation" && OFF_CHAIN_POWERS.has(e.criterionId));
  const mine = new Map(evidence.filter((e) => citable.has(e.criterionId) && usable(e)).map((e) => [e.id, e]));
  const decisiveAsked = [...new Set(a.decisiveEvidenceIds ?? [])].filter((id) => mine.has(id));
  const cited = [...new Set([...a.evidenceIds, ...decisiveAsked])].filter((id) => mine.has(id));
  const out: JudgeAnswer = { ...a, evidenceIds: cited, decisiveEvidenceIds: [] };
  if (out.status === "not_applicable" && !c.naAllowed) {
    out.status = "unknown";
    out.optionId = null;
    flags.push("invalid_na");
  }
  if (out.status === "answered") {
    const verified = cited.map((id) => mine.get(id)!).filter((e) => e.verified);
    if (!out.optionId || !c.options.some((o) => o.id === out.optionId)) {
      out.status = "unknown";
      out.optionId = null;
      flags.push("invalid_option");
    } else if (!verified.length) {
      proposedOptionId = out.optionId;
      out.status = "unknown";
      out.optionId = null;
      flags.push("needs_quote");
    } else {
      const named = verified.filter((e) => decisiveAsked.includes(e.id));
      // A judge that cited but didn't single out the decisive records relied on those that don't argue against the
      // answer (R4-19); only if every cited record does is the whole citation taken.
      const supporting = verified.filter((e) => e.stance !== "contradicts");
      const decisive = named.length ? named : supporting.length ? supporting : verified;
      out.decisiveEvidenceIds = decisive.map((e) => e.id);
      // The top option resting on weaker sources than a record arguing against it needs a human look.
      const top = c.options.reduce((x, y) => (y.points > x.points ? y : x));
      const best = Math.max(...decisive.map((e) => CLASS_RANK[e.sourceClass] ?? 0));
      const against = verified.filter((e) => e.stance === "contradicts" && !out.decisiveEvidenceIds.includes(e.id));
      if (out.optionId === top.id && against.some((e) => (CLASS_RANK[e.sourceClass] ?? 0) > best)) flags.push("evidence_conflict");
    }
  }
  if (out.status !== "answered") out.optionId = null;
  if (out.confidence === "low") flags.push("low_confidence");
  return { answer: out, flags, proposedOptionId };
}

/**
 * Majority vote over judge runs. Without a majority nothing is established: the answer is unknown (badges stay
 * Unrated) and the most cautious answered option goes to the reviewer as a proposal. A split vote must never
 * become a public claim such as "known critical issue".
 */
export function majority(c: CriterionDef, votes: JudgeAnswer[]): { answer: JudgeAnswer; split: boolean; proposedOptionId: string | null } {
  const key = (v: JudgeAnswer) => (v.status === "answered" ? `a:${v.optionId}` : v.status);
  const counts = new Map<string, JudgeAnswer[]>();
  for (const v of votes) counts.set(key(v), [...(counts.get(key(v)) ?? []), v]);
  const ranked = [...counts.values()].sort((a, b) => b.length - a.length);
  const top = ranked[0]!;
  if (top.length > votes.length / 2) return { answer: top[0]!, split: ranked.length > 1, proposedOptionId: null };
  const pts = (v: JudgeAnswer) => c.options.find((o) => o.id === v.optionId)?.points ?? 0;
  const answered = votes.filter((v) => v.status === "answered" && v.optionId).sort((a, b) => pts(a) - pts(b));
  const label = (v: JudgeAnswer) => (v.status === "answered" ? (c.options.find((o) => o.id === v.optionId)?.label ?? v.optionId) : v.status.replace("_", " "));
  return {
    answer: {
      criterionId: c.id,
      status: "unknown",
      optionId: null,
      rationale: `The judge's votes disagreed (${votes.map(label).join("; ")}), so no answer is established; a reviewer decides.`,
      evidenceIds: [...new Set(votes.flatMap((v) => v.evidenceIds))],
      decisiveEvidenceIds: [],
      confidence: "low",
    },
    split: true,
    proposedOptionId: answered[0]?.optionId ?? null,
  };
}
