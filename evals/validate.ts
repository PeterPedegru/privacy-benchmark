/**
 * Validates dataset files against the rubric: the fictional sample (evals/sample) and, when this checkout has it,
 * the hand-labelled golden set (evals/golden, kept out of the public repository).
 * Usage: pnpm exec tsx evals/validate.ts [slug ...]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnswerMap } from "../packages/rubric/src/index.ts";
import { consistencyConflicts, criteria, findCriterion, fmtScore, scoreProject } from "../packages/rubric/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const slugs = process.argv.slice(2);
const files = ["sample", "golden"]
  .map((d) => join(here, d))
  .filter((d) => existsSync(d))
  .flatMap((d) => readdirSync(d).map((f) => join(d, f)))
  .filter((f) => f.endsWith(".json") && (slugs.length === 0 || slugs.includes(f.replace(/^.*\/|\.json$/g, ""))));
const ADVERSARIES = ["public_observer", "chain_analyst", "network_observer", "privileged_insider", "future_adversary"];
const FIELDS = ["sender", "recipient", "amount", "asset", "link", "function", "metadata"];
const STATES = ["private", "at_risk", "exposed", "unverifiable", "n_a"];
const SOURCE_CLASSES = ["code_onchain", "independent", "official_docs", "third_party", "marketing"];
let failed = false;

for (const f of files) {
  const errors: string[] = [];
  const warn: string[] = [];
  const data = JSON.parse(readFileSync(f, "utf8"));
  const sourceIds = new Set<string>((data.sources ?? []).map((s: { id: string }) => s.id));
  for (const s of data.sources ?? []) {
    if (!s.id || !s.url || !s.title) errors.push(`source missing id/url/title: ${JSON.stringify(s)}`);
    if (!SOURCE_CLASSES.includes(s.sourceClass)) errors.push(`source ${s.id} bad sourceClass ${s.sourceClass}`);
  }
  const seen = new Set<string>();
  const answers: AnswerMap = {};
  for (const a of data.answers ?? []) {
    const c = findCriterion(a.criterionId);
    if (!c) {
      errors.push(`unknown criterion ${a.criterionId}`);
      continue;
    }
    if (seen.has(a.criterionId)) errors.push(`duplicate ${a.criterionId}`);
    seen.add(a.criterionId);
    if (!["answered", "unknown", "not_applicable"].includes(a.status)) errors.push(`${a.criterionId} bad status ${a.status}`);
    if (a.status === "answered" && !c.options.some((o) => o.id === a.optionId))
      errors.push(`${a.criterionId} bad option ${a.optionId} (valid: ${c.options.map((o) => o.id).join(", ")})`);
    if (a.status === "not_applicable" && !c.naAllowed) errors.push(`${a.criterionId} N/A not allowed`);
    if (!a.rationale || a.rationale.length < 10) errors.push(`${a.criterionId} missing rationale`);
    if (!["high", "medium", "low"].includes(a.confidence)) errors.push(`${a.criterionId} bad confidence`);
    for (const e of a.evidence ?? []) {
      if (!sourceIds.has(e.sourceId)) errors.push(`${a.criterionId} evidence cites unknown source ${e.sourceId}`);
      if (!e.quote) errors.push(`${a.criterionId} evidence missing quote`);
    }
    if (a.status === "answered" && (a.evidence ?? []).length === 0) warn.push(`${a.criterionId} answered without evidence`);
    answers[a.criterionId] = { criterionId: a.criterionId, status: a.status, optionId: a.optionId ?? null };
  }
  for (const c of criteria) if (!seen.has(c.id)) errors.push(`missing criterion ${c.id}`);
  for (const [adv, row] of Object.entries(data.matrix ?? {})) {
    if (!ADVERSARIES.includes(adv)) errors.push(`matrix bad adversary ${adv}`);
    for (const [field, cell] of Object.entries(row as Record<string, { state: string }>)) {
      if (!FIELDS.includes(field)) errors.push(`matrix bad field ${adv}.${field}`);
      if (!STATES.includes(cell.state)) errors.push(`matrix bad state ${adv}.${field}=${cell.state}`);
    }
  }
  // Under rubric 1.2+, a favorable answer about a track record, or about censorship, needs a dated statement (R4-13).
  for (const a of data.answers as { criterionId: string; status: string; optionId?: string; evidence?: unknown[] }[]) {
    const needsDated = ["security.soundness.open-critical", "security.soundness.history", "custody.pause.track-record", "decentralization.censorship.observed"];
    const c = findCriterion(a.criterionId);
    const top = c?.options.reduce((x, y) => (y.points > x.points ? y : x));
    if (needsDated.includes(a.criterionId) && a.status === "answered" && a.optionId === top?.id && !(a.evidence ?? []).length)
      warn.push(`${a.criterionId} = ${a.optionId} has no evidence; rubric 1.2 needs a dated statement (or unknown)`);
  }
  // Labels that can't both be true: an error when both are confident, a warning when either is uncertain.
  const uncertain = new Set(
    (data.answers as { criterionId: string; labelConfidence?: string }[]).filter((a) => a.labelConfidence === "uncertain").map((a) => a.criterionId),
  );
  for (const cf of consistencyConflicts(answers)) {
    const msg = `inconsistent labels ${cf.criterionIds.join(" vs ")}: ${cf.message}`;
    if (cf.criterionIds.some((id) => uncertain.has(id))) warn.push(`${msg} (one is marked uncertain)`);
    else errors.push(msg);
  }
  const card = scoreProject(answers);
  console.log(`\n${f.slice(here.length + 1)}: ${errors.length} errors, ${warn.length} warnings`);
  console.log(
    `  overall ${fmtScore(card.overall)} · ${card.level} · tier ${card.trustTier ?? "—"} · walkaway ${card.walkaway.passed ? "✓" : "✗"} ${card.walkaway.reasons.join("; ")}`,
  );
  console.log(`  ${card.suites.map((s) => `${s.suiteId} ${fmtScore(s.score)}`).join(" · ")}`);
  for (const e of errors.slice(0, 40)) console.log(`  ERROR ${e}`);
  for (const w of warn.slice(0, 10)) console.log(`  warn  ${w}`);
  if (errors.length) failed = true;
}
if (!files.length) console.log("no files");
process.exit(failed ? 1 : 0);
