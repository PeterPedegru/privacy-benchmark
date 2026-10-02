/**
 * Generates the sample dataset: three fictional projects with answers for every criterion, so a fresh checkout has
 * a demo release to show and the browser tests have data. Nothing in it is researched: projects, sources and quotes
 * are invented, and every source says so. The hand-labelled golden set the evaluator is measured against is kept
 * out of the public repository (evals/golden, gitignored); when it's present locally, it's used instead.
 *
 *   pnpm --filter @pb/server exec tsx ../../evals/sample/generate.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnswerMap } from "../../packages/rubric/src/index.ts";
import { consistencyConflicts, criteria, isHighScrutiny } from "../../packages/rubric/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ADVERSARIES = ["public_observer", "chain_analyst", "network_observer", "privileged_insider", "future_adversary"];
const FIELDS = ["sender", "recipient", "amount", "asset", "link", "function", "metadata"];
const STATES = ["private", "at_risk", "exposed"];

/** A stable number in [0, 1) for a string: the same inputs always give the same dataset. */
function unit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

interface Profile {
  slug: string;
  name: string;
  tagline: string;
  category: string;
  mechanism: string;
  /** How favorable its answers lean, 0 (riskiest options) to 1 (best). */
  strength: number;
}

const PROFILES: Profile[] = [
  {
    slug: "example-rollup",
    name: "Example Private Rollup",
    tagline: "Fictional rollup with private and public smart contracts",
    category: "l2",
    mechanism: "private_execution",
    strength: 0.8,
  },
  {
    slug: "example-pool",
    name: "Example Shielded Pool",
    tagline: "Fictional shielded pool for private transfers",
    category: "privacy_pool",
    mechanism: "shielded_ledger",
    strength: 0.55,
  },
  {
    slug: "example-coprocessor",
    name: "Example Confidential Coprocessor",
    tagline: "Fictional coprocessor for confidential token balances",
    category: "coprocessor",
    mechanism: "confidential_amounts",
    strength: 0.3,
  },
];

function build(p: Profile) {
  const host = `https://${p.slug}.example`;
  const sources = [
    { id: "docs", url: `${host}/docs`, title: `${p.name} docs (fictional sample)`, kind: "docs", sourceClass: "official_docs", date: "2026-09-01" },
    { id: "code", url: `${host}/code`, title: `${p.name} contracts (fictional sample)`, kind: "code", sourceClass: "code_onchain", date: "2026-09-01" },
    { id: "audit", url: `${host}/audit`, title: `${p.name} audit (fictional sample)`, kind: "audit", sourceClass: "independent", date: "2026-08-15" },
  ];
  const answers = criteria.map((c) => {
    const r = unit(`${p.slug}:${c.id}`);
    // A few unknowns, to show how unsettled criteria look; never on criteria that decide a badge or the level.
    if (r < 0.04 && !isHighScrutiny(c))
      return {
        criterionId: c.id,
        status: "unknown",
        rationale: "Sample data: left unknown to show how an unsettled criterion scores.",
        confidence: "low",
        labelConfidence: "certain",
        evidence: [],
      };
    const ranked = [...c.options].sort((a, b) => b.points - a.points);
    const target = (1 - p.strength) * (ranked.length - 1) + (unit(`${c.id}:${p.slug}`) - 0.5) * 1.6;
    const option = ranked[Math.max(0, Math.min(ranked.length - 1, Math.round(target)))]!;
    const first = Math.floor(unit(`${c.id}#src`) * sources.length);
    const cited = [sources[first]!, sources[(first + 1) % sources.length]!];
    return {
      criterionId: c.id,
      status: "answered",
      optionId: option.id,
      rationale: `Sample data: "${option.label}" was generated for ${p.name}, a fictional project, to show how an answer, its rationale and its evidence appear. Nothing here was researched or describes a real system.`,
      confidence: "high",
      labelConfidence: "certain",
      evidence: cited.map((s) => ({
        sourceId: s.id,
        quote: `${p.name} is fictional sample data. For "${c.question}" its generated answer is "${option.label}", recorded here as if quoted from its ${s.kind === "code" ? "contracts" : s.kind}.`,
        claim: `${c.label}: ${option.label}.`,
        citedUrl: s.url,
      })),
    };
  });
  // Pairs of answers that can't both be true are settled as unknown, as a reviewer would leave them.
  for (let round = 0; round < 50; round++) {
    const map: AnswerMap = Object.fromEntries(
      answers.map((a) => [
        a.criterionId,
        { criterionId: a.criterionId, status: a.status as "answered", optionId: (a as { optionId?: string }).optionId ?? null },
      ]),
    );
    const conflicts = consistencyConflicts(map);
    if (!conflicts.length) break;
    // Settle the pair on the criterion that doesn't decide a badge, so the badges stay rated.
    const ids = conflicts[0]!.criterionIds;
    const id = ids.find((x) => !isHighScrutiny(criteria.find((c) => c.id === x)!)) ?? ids[1];
    const i = answers.findIndex((a) => a.criterionId === id);
    answers[i] = {
      criterionId: id,
      status: "unknown",
      rationale: "Sample data: left unknown where two generated answers contradicted each other.",
      confidence: "low",
      labelConfidence: "certain",
      evidence: [],
    };
  }
  const matrix = Object.fromEntries(
    ADVERSARIES.map((adv) => [
      adv,
      Object.fromEntries(
        FIELDS.map((f) => {
          const state = STATES[Math.min(2, Math.floor((1 - p.strength) * 2 + unit(`${p.slug}:${adv}:${f}`) * 1.5))]!;
          return [f, { state, note: `Sample data: ${state.replace("_", " ")} for this fictional project.` }];
        }),
      ),
    ]),
  );
  return {
    project: {
      slug: p.slug,
      name: p.name,
      website: host,
      logoUrl: null,
      tagline: p.tagline,
      description: `${p.name} is a fictional project in the sample dataset. Its answers, sources and quotes are generated for demos and tests; none of it describes a real system.`,
      category: p.category,
      mechanism: p.mechanism,
      attributes: ["zk"],
      chains: ["Example Chain"],
      l2beatSlug: null,
      defillamaSlug: null,
    },
    asOf: "2026-09-30",
    summary: `${p.name} is fictional sample data: its scores show how the benchmark presents a project, not the properties of a real system.`,
    context: { status: "Fictional sample project", launched: "Not a real system" },
    powers: ["Sample data: a fictional admin multisig can upgrade the contracts.", "Sample data: a fictional operator orders transactions."],
    sources,
    answers,
    matrix,
  };
}

for (const p of PROFILES) {
  writeFileSync(join(here, `${p.slug}.json`), `${JSON.stringify(build(p), null, 1)}\n`);
  console.log(`wrote ${p.slug}.json`);
}
