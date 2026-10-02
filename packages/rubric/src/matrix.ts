import { answeredOptionId } from "./scoring.ts";
import type { AdversaryId, AdversaryMatrix, AnswerMap, MatrixField, MatrixState } from "./types.ts";

export const ADVERSARIES: { id: AdversaryId; name: string; description: string }[] = [
  { id: "public_observer", name: "Public observer", description: "Anyone with a block explorer." },
  { id: "chain_analyst", name: "Chain analyst", description: "Correlates timing, amounts and fingerprints across transactions." },
  {
    id: "network_observer",
    name: "Network observer",
    description: "RPC providers, relayers and ISPs who see where requests come from.",
  },
  {
    id: "privileged_insider",
    name: "Privileged insider",
    description: "Upgrade admins, sequencers, key or committee holders, TEE vendors, approval-list operators, hosted provers.",
  },
  { id: "future_adversary", name: "Future adversary", description: "Harvest-now-decrypt-later, including a quantum computer." },
];

export const MATRIX_FIELDS: { id: MatrixField; name: string }[] = [
  { id: "sender", name: "Sender" },
  { id: "recipient", name: "Recipient" },
  { id: "amount", name: "Amount" },
  { id: "asset", name: "Asset" },
  { id: "link", name: "Link" },
  { id: "function", name: "Function" },
  { id: "metadata", name: "Metadata" },
];

export const MATRIX_STATES: { id: MatrixState; name: string; glyph: string }[] = [
  { id: "private", name: "Private", glyph: "●" },
  { id: "at_risk", name: "At risk", glyph: "◐" },
  { id: "exposed", name: "Exposed", glyph: "○" },
  { id: "unverifiable", name: "Unverifiable", glyph: "?" },
  { id: "n_a", name: "Not applicable", glyph: "–" },
];

type Check = {
  adversary: AdversaryId;
  field: MatrixField;
  criterionId: string;
  /** Options that mean "hidden" for this field. */
  hidden: string[];
  /** Options that say nothing about this field either way (no conflict in either direction). */
  neutral?: string[];
  /** Only check when this holds (e.g. an insider's view of amounts matters only if the public can't see them). */
  when?: (answers: AnswerMap) => boolean;
};

const CHECKS: Check[] = [
  { adversary: "public_observer", field: "amount", criterionId: "coverage.confidentiality.amounts", hidden: ["hidden"] },
  { adversary: "public_observer", field: "asset", criterionId: "coverage.confidentiality.asset", hidden: ["hidden"] },
  // In a mixer the depositor's and recipient's addresses are public; only the link between them is hidden.
  { adversary: "public_observer", field: "sender", criterionId: "coverage.unlinkability.sender", hidden: ["hidden"], neutral: ["mixing"] },
  { adversary: "public_observer", field: "recipient", criterionId: "coverage.unlinkability.recipient", hidden: ["hidden"], neutral: ["mixing"] },
  { adversary: "public_observer", field: "link", criterionId: "coverage.unlinkability.sender", hidden: ["hidden", "mixing"] },
  { adversary: "public_observer", field: "function", criterionId: "coverage.execution.function-hiding", hidden: ["hidden", "contract-hidden"] },
  { adversary: "network_observer", field: "metadata", criterionId: "coverage.metadata.network", hidden: ["default", "opt-in"] },
  {
    adversary: "privileged_insider",
    field: "amount",
    criterionId: "trust.decryption.standing-access",
    hidden: ["none"],
    when: (answers) => answeredOptionId(answers, "coverage.confidentiality.amounts") === "hidden",
  },
];

export interface MatrixConflict {
  adversary: AdversaryId;
  field: MatrixField;
  criterionId: string;
  matrixState: MatrixState;
  optionId: string | null;
  message: string;
}

/** Flags cells where the matrix and the scored criteria disagree, so they can't drift apart silently. */
export function matrixConflicts(matrix: AdversaryMatrix, answers: AnswerMap): MatrixConflict[] {
  const out: MatrixConflict[] = [];
  for (const chk of CHECKS) {
    const cell = matrix[chk.adversary]?.[chk.field];
    // Only established answers can conflict: an unknown says nothing about the cell.
    const opt = answeredOptionId(answers, chk.criterionId);
    if (!cell || opt === null || chk.neutral?.includes(opt) || (chk.when && !chk.when(answers))) continue;
    const hidden = chk.hidden.includes(opt);
    if (cell.state === "private" && !hidden) {
      out.push({ ...chk, matrixState: cell.state, optionId: opt, message: `Matrix says private, but the criterion answer implies it is visible.` });
    }
    if (cell.state === "exposed" && hidden) {
      out.push({ ...chk, matrixState: cell.state, optionId: opt, message: `Matrix says exposed, but the criterion answer implies it is hidden.` });
    }
  }
  return out;
}
