import { findCriterion, getBenchmark } from "./rubric.ts";
import { answeredOptionId } from "./scoring.ts";
import type { AnswerMap } from "./types.ts";

export interface ConsistencyConflict {
  criterionIds: [string, string];
  message: string;
}

type Rule = { a: string; b: string; conflicts: (a: string, b: string) => boolean; message: string };

/**
 * Answers that can't both be true. Each rule only fires on established (answered) inputs, and flags both
 * criteria for review: one of the two answers is wrong, and the evaluator can't tell which.
 */
const RULES: Rule[] = [
  {
    a: "governance.upgrades.upgradeability",
    b: "custody.exit.window",
    conflicts: (up, win) => up === "immutable" && win !== "infinite",
    message: "Immutable core contracts can't be upgraded against users, so the exit window should be unlimited.",
  },
  {
    a: "trust.decryption.infra-visibility",
    b: "trust.crypto.hardware",
    conflicts: (vis, hw) => (vis === "tee" && hw === "none") || (vis === "none" && hw === "confidentiality"),
    message: "Infrastructure visibility and hardware trust disagree about whether a TEE sees plaintext.",
  },
  {
    a: "coverage.execution.private-logic",
    b: "programmability.contracts.model",
    conflicts: (logic, model) => logic === "none" && model === "general-hybrid",
    message: "A hybrid private/public contract model implies some private logic, but private logic is answered as none.",
  },
  {
    a: "custody.exit.gatekeeper",
    b: "custody.access.private-exit",
    // A public exit that always works while the private exit can be gated is the gatekeeper's middle option.
    conflicts: (gate, priv) => gate === "none" && priv !== "no-gate",
    message: "Exits are answered as ungated, but private exits are answered as gated (fully or with a public fallback).",
  },
  {
    a: "coverage.execution.private-logic",
    b: "coverage.callstack.targets",
    conflicts: (logic, targets) => logic === "none" && targets !== "visible",
    message: "With no private logic there are no private calls to hide, so call targets should be visible.",
  },
  {
    a: "coverage.execution.private-logic",
    b: "coverage.callstack.structure",
    conflicts: (logic, structure) => logic === "none" && structure !== "visible",
    message: "With no private logic there is no private call structure to hide, so it should be visible.",
  },
  {
    a: "coverage.execution.private-logic",
    b: "coverage.callstack.public-boundary",
    conflicts: (logic, boundary) => logic === "none" && boundary !== "visible",
    message: "With no private logic there are no private calls into public code, so the public boundary should be answered visible.",
  },
  {
    a: "trust.decryption.retroactive",
    b: "trust.decryption.standing-access",
    conflicts: (retro, standing) => retro === "yes" && standing === "none",
    message: "Someone can decrypt past activity, yet nobody is answered as holding standing decryption access.",
  },
  {
    a: "custody.access.entry",
    b: "coverage.identity.registration",
    conflicts: (entry, reg) => entry === "open" && reg === "kyc",
    message: "Using the system needs identity registration, so entry can't be open.",
  },
  {
    a: "custody.pause.pause-fn",
    b: "custody.pause.exits-during-pause",
    conflicts: (pause, exits) => pause === "none" && exits !== "yes",
    message: "With no pause function, exits can't be blocked by a pause; this should be answered yes.",
  },
];

export function consistencyConflicts(answers: AnswerMap): ConsistencyConflict[] {
  const out: ConsistencyConflict[] = [];
  for (const r of RULES) {
    const a = answeredOptionId(answers, r.a);
    const b = answeredOptionId(answers, r.b);
    if (a !== null && b !== null && r.conflicts(a, b)) out.push({ criterionIds: [r.a, r.b], message: r.message });
  }
  return out;
}

/** The rule set, for tests and the methodology page. */
export const CONSISTENCY_RULES = RULES.map(({ a, b, message }) => ({ a, b, message }));

/**
 * Criteria that answer from the same facts across benchmarks. Evidence filed under one may be cited for the other
 * (the judge sees it as related evidence), so the same fact can't get two answers from two evidence sets.
 */
const FACT_LINKS: [string, string][] = [
  ["custody.exit.window", "governance.upgrades.upgradeability"],
  ["custody.exit.gatekeeper", "custody.access.private-exit"],
  ["coverage.execution.private-logic", "coverage.callstack.targets"],
  ["coverage.execution.private-logic", "coverage.callstack.structure"],
  ["custody.access.entry", "coverage.identity.registration"],
  ["custody.freeze.seizure", "governance.roles.scope"],
  ["security.soundness.history", "security.maturity.continuity"],
  ["custody.pause.halt", "decentralization.operators.producers"],
];

/** Criteria whose evidence can establish this one: the rest of its benchmark, plus explicit fact links. */
export function relatedCriteria(criterionId: string): string[] {
  const c = findCriterion(criterionId);
  if (!c) return [];
  const siblings = getBenchmark(c.benchmarkId).criteria.map((x) => x.id);
  const linked = FACT_LINKS.flatMap(([a, b]) => (a === criterionId ? [b] : b === criterionId ? [a] : []));
  return [...new Set([...siblings, ...linked])].filter((id) => id !== criterionId);
}
