import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectInfo, SourceKind } from "@pb/core";
import type { AdversaryMatrix, SourceClass } from "@pb/rubric";
import { REPO_ROOT } from "../env.ts";

export interface GoldenAnswer {
  criterionId: string;
  status: "answered" | "unknown" | "not_applicable";
  optionId: string | null;
  rationale: string;
  confidence: "high" | "medium" | "low";
  labelConfidence?: "certain" | "likely" | "uncertain";
  evidence: { sourceId: string; quote: string; claim: string; citedUrl?: string | null }[];
}

export interface GoldenFile {
  project: ProjectInfo & { logoUrl: string | null };
  asOf: string;
  summary: string;
  context: Record<string, string>;
  powers: string[];
  sources: { id: string; url: string; title: string; kind: SourceKind; sourceClass: SourceClass; date: string | null }[];
  answers: GoldenAnswer[];
  matrix: AdversaryMatrix;
}

/** The hand-labelled golden set the evaluator is measured against. Kept out of the public repository (gitignored). */
export const GOLDEN_DIR = resolve(REPO_ROOT, "evals/golden");
/** Fictional sample projects, committed so a fresh checkout has a demo release and the browser tests have data. */
export const SAMPLE_DIR = resolve(REPO_ROOT, "evals/sample");
/** The landscape research lives in plans/ (never committed). When present, demo quotes are verified against it. */
export const LANDSCAPE_PATH = resolve(REPO_ROOT, "plans/research/source-privacy-landscape-2026-09-30.md");

const jsonFiles = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
    : [];

/** Where demo data comes from: the golden set when this checkout has it, else the sample. */
export function datasetDir(): string {
  return jsonFiles(GOLDEN_DIR).length ? GOLDEN_DIR : SAMPLE_DIR;
}

export function loadGoldenFiles(dir: string = datasetDir()): GoldenFile[] {
  return jsonFiles(dir).map((f) => JSON.parse(readFileSync(resolve(dir, f), "utf8")) as GoldenFile);
}

// ---------- seeded source rows (R4-12) ----------

/**
 * `meta.seed` on a source row the demo import created: the golden file it came from and the class it was given (by
 * the file, or since by the seed reclassification). A row whose class no longer matches was changed by an editor.
 */
export interface SeedMark {
  golden: string;
  sourceClass: string;
}

/**
 * The classes golden files gave these sources before R4-12 corrected them to today's classifier. Rows seeded before
 * seed marks existed still carry one of them (unless an editor changed it), which is how they're recognised.
 */
export const GOLDEN_CLASSES_BEFORE_R4_12: Readonly<Record<string, string>> = {
  "https://docs.human.tech/shield": "official_docs",
  "https://github.com/holonym-foundation/shield.human.tech/blob/main/l1-contracts/src/TokenPortal.sol": "code_onchain",
  "https://github.com/defi-wonderland/aztec-standards/blob/main/src/token_contract/README.md": "code_onchain",
  "https://github.com/AztecProtocol/aztec-packages": "code_onchain",
  "https://crypto.news/what-broke-ethereums-fusaka-upgrade/": "independent",
  "https://github.com/0xMiden/node": "code_onchain",
  "https://github.com/0xMiden/miden-vm": "code_onchain",
  "https://github.com/0xMiden/miden-vm/blob/next/SECURITY.md": "code_onchain",
  "https://github.com/0xbow-io/privacy-pools-website/blob/main/LICENSE.md": "code_onchain",
  "https://github.com/0xbow-io/privacy-pools-core/blob/main/audit/circuits_audit_oxorio.md": "independent",
  "https://github.com/0xbow-io/privacy-pools-core/blob/main/audit/contracts_audit_oxorio.md": "independent",
  "https://github.com/0xbow-io/privacy-pools-core/blob/main/audit/entrypoint_upgrade_audit_oxorio.md": "independent",
  "https://github.com/0xbow-io/privacy-pools-core/blob/main/audit/contracts_audit_auditware.md": "independent",
  "https://docs.envio.dev/blog/privacy-in-public-case-study": "independent",
  "https://github.com/Railgun-Privacy/circuits-v2/blob/main/License.md": "code_onchain",
  "https://help.railway.xyz/transactions/private-transfers": "official_docs",
  "https://help.railway.xyz/transactions/shield-unshield-1": "official_docs",
  "https://www.migalabs.io/blog/railgun-freeze-DAO": "independent",
  "https://immunefi.com/bug-bounty/starknet/information/": "independent",
  "https://api.github.com/repos/tempoxyz/zones": "code_onchain",
  "https://github.com/l2beat/l2beat/blob/main/packages/config/src/projects/zama-cw/discovered.json": "code_onchain",
  "https://spdx.org/licenses/BSD-3-Clause-Clear.json": "independent",
  "https://github.com/zama-ai/fhevm/blob/main/SECURITY.md": "code_onchain",
  "https://github.com/OpenZeppelin/openzeppelin-confidential-contracts/tree/master/audits": "independent",
  "https://www.zama.org/confidential-tokens/cusdt": "marketing",
  "https://zerion.io/blog/zerion-now-supports-confidential-tokens-powered-by-zama/": "independent",
};

/**
 * The seed mark of a source row the demo import created that no editor has reclassified since, or null (an editor's
 * row, a knowledge-base or agent row, or a seeded row an editor changed). Rows seeded before marks existed count when
 * the project's golden file lists their URL and their class is one the golden file gave them; an editor row at such
 * a URL with exactly that class can't be told apart. (An HTTP status says nothing: an agent's fetch fills an empty
 * seeded row's text and status and keeps its class.)
 */
export function seedMarkOf(
  row: { url: string; origin: string; sourceClass: string; meta: Record<string, unknown> | null },
  slug: string,
  golden: { sourceClass: string } | undefined,
): SeedMark | null {
  if (row.origin !== "admin") return null;
  const mark = row.meta?.seed as SeedMark | undefined;
  if (mark) return mark.sourceClass === row.sourceClass ? mark : null;
  if (!golden) return null;
  const seeded = row.sourceClass === golden.sourceClass || row.sourceClass === GOLDEN_CLASSES_BEFORE_R4_12[row.url];
  return seeded ? { golden: slug, sourceClass: row.sourceClass } : null;
}

export function landscapeText(): string | null {
  return existsSync(LANDSCAPE_PATH) ? readFileSync(LANDSCAPE_PATH, "utf8") : null;
}
