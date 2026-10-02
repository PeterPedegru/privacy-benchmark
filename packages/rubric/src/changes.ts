import { RUBRIC_VERSION } from "./rubric.ts";

/**
 * Criteria whose question, guidance or options changed in each rubric version. When an answer differs from the
 * previously published one and its criterion changed since that release's rubric, the change is the rubric's,
 * not the project's (R3-JDG-14). A test pins every criterion's definition hash, so an edit that isn't listed
 * here fails CI.
 */
export const RUBRIC_CHANGES: { version: string; criteria: string[] }[] = [
  {
    version: "1.1.0",
    criteria: [
      "custody.freeze.blocklist",
      "custody.freeze.seizure",
      "coverage.callstack.targets",
      "coverage.callstack.structure",
      "coverage.execution.private-logic",
    ],
  },
  {
    version: "1.2.0",
    criteria: [
      "coverage.identity.persistent-id",
      "coverage.identity.registration",
      "coverage.callstack.public-boundary",
      "coverage.metadata.network",
      "coverage.metadata.pending",
      "coverage.metadata.fingerprinting",
      "coverage.unlinkability.fees",
      "coverage.unlinkability.sender",
      "custody.freeze.systemic",
      "custody.access.entry",
      "custody.exit.window",
      "governance.upgrades.upgradeability",
      "governance.upgrades.verifier",
      "governance.roles.scope",
      "governance.roles.holders",
      "governance.roles.transparency",
      "programmability.composability.private-public",
      "programmability.disclosure.compliance-proofs",
      "programmability.disclosure.primitives",
      "programmability.developer.sdks",
      "programmability.developer.local-dev",
      "security.soundness.open-critical",
      "security.soundness.history",
      "security.soundness.defense-in-depth",
      "security.assurance.bounty",
      "security.assurance.reproducibility",
      "security.assurance.formal-verification",
      "security.maturity.continuity",
      "decentralization.censorship.observed",
      "decentralization.censorship.indistinguishable",
    ],
  },
  {
    version: "1.2.1",
    criteria: ["coverage.metadata.network", "coverage.callstack.public-boundary", "coverage.unlinkability.fees", "governance.upgrades.upgradeability"],
  },
  {
    // A logged search that finds nothing answers the "nothing published" option; a gated private exit passes walkaway.
    version: "1.3.0",
    criteria: [
      "coverage.anonymity-set.usage",
      "coverage.anonymity-set.effective",
      "programmability.performance.proving-time",
      "governance.process.concentration",
      "decentralization.operators.concentration",
      "custody.exit.gatekeeper",
    ],
  },
];

function parse(v: string): number[] {
  return v.split(".").map((x) => Number.parseInt(x, 10) || 0);
}
function newer(a: string, b: string): boolean {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** True when the criterion's definition changed after `sinceVersion`, up to the current rubric. */
export function criterionChangedSince(criterionId: string, sinceVersion: string): boolean {
  return RUBRIC_CHANGES.some((c) => newer(c.version, sinceVersion) && !newer(c.version, RUBRIC_VERSION) && c.criteria.includes(criterionId));
}
