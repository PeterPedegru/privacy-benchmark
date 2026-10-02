/**
 * When a search for something's absence may stand as evidence (R3-JDG-2). An attestation proves only what a
 * search over stored files can prove:
 * - A POWER that isn't in the code (no pause function, no blocklist): favorable, and only over the whole code
 *   snapshot, with canonical patterns the agent can add to but not replace.
 * - A FEATURE that isn't there (no Tor support, no stealth addresses): evidence AGAINST the favorable options.
 *   Docs may show that too.
 * - Never that something didn't HAPPEN (no incidents, no pauses, no audits, no usage): search can't show that.
 */

export interface AbsencePolicy {
  /** True for powers (absence is good), false for features (absence counts against). */
  favorableWhenAbsent: boolean;
  /** Always searched, in addition to the agent's patterns. */
  patterns: string[];
}

const power = (...patterns: string[]): AbsencePolicy => ({ favorableWhenAbsent: true, patterns });
const feature = (...patterns: string[]): AbsencePolicy => ({ favorableWhenAbsent: false, patterns });

export const ABSENCE_POLICY: Record<string, AbsencePolicy> = {
  // Powers: absence from the code is favorable.
  "custody.pause.pause-fn": power("pause", "whenNotPaused", "Pausable", "unpause"),
  "custody.freeze.blocklist": power(
    "blacklist",
    "blocklist",
    "denylist",
    "isBlocked",
    "freeze",
    "sanction",
    "transferHook",
    "beforeTokenTransfer",
    "authorizer",
  ),
  "governance.upgrades.upgradeability": power("upgradeTo", "Upgradeable", "ERC1967", "TransparentUpgradeableProxy", "setImplementation"),
  "governance.upgrades.emergency": power("emergency", "guardian", "securityCouncil"),
  "governance.upgrades.verifier": power("setVerifier", "updateVerifier", "setVerificationKey", "setVkey"),
  "governance.roles.scope": power("onlyOwner", "onlyRole", "onlyAdmin", "AccessControl", "Ownable"),
  // Features: absence counts against the favorable options.
  "coverage.metadata.network": feature("tor", "socks", "onion", "mixnet", "nym"),
  "coverage.metadata.fingerprinting": feature("padding", "decoy"),
  "coverage.identity.reusable-address": feature("stealth"),
  "coverage.execution.private-state": feature(),
  "coverage.execution.shared-state": feature(),
  "programmability.blending.private-reads": feature(),
  "programmability.composability.cross-domain": feature(),
  "programmability.contracts.accounts": feature(),
  "programmability.contracts.standards": feature(),
  "programmability.disclosure.primitives": feature("viewingKey", "viewing_key", "disclos"),
  "trust.disclosure.selective": feature("viewingKey", "viewing_key", "disclos"),
  "trust.disclosure.revocable": feature("revoke"),
  "security.assurance.formal-verification": feature("certora", "coq", "isabelle", "formal verification", "formally verified"),
  "security.soundness.defense-in-depth": feature("rateLimit", "withdrawalDelay", "circuitBreaker", "withdrawalLimit"),
};

/**
 * Powers that usually live off-chain (R4-10): with stablecoin issuers, in a front end or screening API, in a key
 * management service or an operator's hardware. A search of the contracts can't show they're absent.
 */
export const OFF_CHAIN_POWERS: ReadonlySet<string> = new Set([
  "custody.freeze.seizure",
  "trust.decryption.standing-access",
  "trust.decryption.retroactive",
  "coverage.identity.registration",
  "custody.access.screening",
  "trust.crypto.hardware",
]);

/** Track records and events: an empty search proves nothing about them. */
export const EVENT_CRITERIA: ReadonlySet<string> = new Set([
  "security.soundness.open-critical",
  "security.soundness.history",
  "custody.pause.track-record",
  "security.maturity.continuity",
  "security.maturity.status",
  "security.maturity.age",
  "coverage.anonymity-set.usage",
  "coverage.anonymity-set.effective",
  "decentralization.censorship.observed",
  "security.assurance.bounty",
  "security.assurance.audits",
]);

/**
 * Criteria the code can't decide: track records and events, adoption and measured figures, and claims that live in
 * papers rather than code. Every other criterion is checked against the code and onchain state before it's left
 * unknown or "not disclosed".
 */
export const CODE_UNDECIDABLE: ReadonlySet<string> = new Set([
  ...EVENT_CRITERIA,
  "programmability.developer.sdks",
  "programmability.developer.familiarity",
  "programmability.performance.proving-time",
  "programmability.performance.cost",
  "trust.crypto.formal-privacy",
]);

export function isCodeCheckable(criterionId: string): boolean {
  return !CODE_UNDECIDABLE.has(criterionId);
}

export function absenceRefusal(criterionId: string, scope: "code" | "docs"): string | null {
  if (EVENT_CRITERIA.has(criterionId))
    return `record_absence can't show that something didn't happen (${criterionId}): searching the knowledge base proves nothing about incidents, disclosures, usage or programs. Record a dated statement from a source that tracks them (GitHub security advisories, post-mortems, DefiLlama hacks, L2BEAT, the bounty platform), or leave it unknown.`;
  if (OFF_CHAIN_POWERS.has(criterionId))
    return `record_absence can't show this is absent (${criterionId}): it usually lives off-chain (issuers of the assets held, front ends and screening services, key management or operators' hardware), where a search of the stored code can't see it. Record a statement that says how it works, or leave it unknown.`;
  const p = ABSENCE_POLICY[criterionId];
  if (!p)
    return `record_absence doesn't apply to ${criterionId}: its options aren't about whether a power or feature exists. Record quotes that show what the system does.`;
  if (p.favorableWhenAbsent && scope === "docs")
    return `A power's absence can only be attested over the code: docs not mentioning a power doesn't mean the contracts lack it. Use scope "code".`;
  return null;
}

/** Words of a line, with identifiers split at camelCase boundaries: "requireKYC(sgxQuote)" → require, kyc, sgx, quote. */
function words(line: string): string[] {
  return line
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Matches a pattern in a line: short patterns (4 characters or fewer: "tor", "kyc", "sgx") as whole words of the
 * line, identifiers split at camelCase, so "tor" doesn't match "storage" but "kyc" matches "requireKYC". Longer
 * ones as case-insensitive substrings ("pause" matches "whenNotPaused").
 */
export function patternMatcher(pattern: string): (line: string, lower?: string) => boolean {
  const p = pattern.toLowerCase();
  // `lower` is the line already lowercased, so a scan with many patterns lowercases each line once (R4-20).
  if (p.length > 4 || /[^a-z0-9]/.test(p)) return (line, lower = line.toLowerCase()) => lower.includes(p);
  return (line, lower = line.toLowerCase()) => lower.includes(p) && words(line).includes(p);
}
