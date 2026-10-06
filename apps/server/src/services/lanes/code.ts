/**
 * Code, releases, diffs and security advisories from GitHub (SRC-2, SRC-6, SRC-7, SRC-14, P1 advisories).
 *
 * Selection is tiered: security docs, audit reports and deployment/address files first (tier 0), then contracts
 * and circuits, then Rust/Go and design docs, then TypeScript in security-relevant packages (at most 20% of the
 * budget). Generated, binding, test, mock, example, fuzz and versioned-copy paths are excluded, identical blobs are
 * stored once, and files whose header says they are generated are skipped. Blobs whose SHA is already stored are
 * reused instead of downloaded (EFF-11).
 */

import { sql } from "drizzle-orm";
import { query } from "../../db/index.ts";
import { env } from "../../env.ts";
import { encodePath, GithubError, ghCommitSha, ghRaw } from "../../lib/github.ts";
import type { SourceClass } from "../classify.ts";
import { KbBudgetError, keepAlive, purgeWhere } from "../kb-store.ts";
import { compareSemver, parseSemver } from "../versions.ts";
import { parseAuditMeta } from "./audits.ts";
import { classify, counted, type LaneContext, mapLimit, type ProjectRow, type RepoSuggestion, storeFor, type VersionRow } from "./context.ts";

/** Audit reports kept in a repo (not the folder's README index). */
export const AUDIT_FILE = /(^|\/)(audits?|audit-reports?|security-reviews?)\/(?!readme|index)[^/]+\.md$|(^|\/)AUDIT(?!S?\.md$)[^/]*\.md$/i;

// ---------- path rules (pure) ----------

/** Paths that never belong in a code snapshot. */
export const EXCLUDE =
  /(^|\/)(tests?|testing|teststubs?|test[-_][\w-]+|[\w-]+[-_]tests?|test_programs|acir_tests|__tests__|specs?[-_]tests?|mocks?|mock[-_][\w-]+|mocked\w*|fixtures?|examples?|[\w-]+[-_]examples?|samples?|demos?|bench[\w-]*|stress[\w-]*|load-?tests?|node_modules|vendor|third[-_]party|target|build|dist|out|cache|coverage|\.github|\.claude|\.vscode|e2e|fuzz[\w-]*|(rust_|go_|ts_|py_)?bindings|generated|gen|autogen|typechain(-types)?|artifacts|abis?|snapshots?|lib\/(forge-std|openzeppelin[^/]*|solmate|solady|ds-test|murky|permit2))(\/|$)|\.t\.sol$|_test\.(rs|go)$|_test\.py$|(^|\/)test_[\w-]+\.py$|\.(test|spec|bench)\.(ts|tsx|js|mjs|rs)$|Test[A-Z]?\w*\.sol$|\.d\.ts$|\.min\.js$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock)$/i;

/** A path segment that is a version number marks a copied old version (sdk/contracts/v0.12.0/...). */
const VERSIONED_COPY = /(^|\/)(version[-_])?v?\d+\.\d+(\.\d+)?([-_][\w.]+)?\/|(^|\/)[\w-]*versioned[-_](docs|sidebars)\//i;

/** Tier 0: security policy, audit reports, threat models, deployments and address lists. */
export const TIER0 =
  /(^|\/)(audits?|audit-reports?|security|security-reviews?|reports?)\/[^/]+\.md$|(^|\/)(SECURITY|AUDITS?|THREAT[-_]MODEL|BUG[-_]BOUNTY)[^/]*\.md$|(^|\/)deployments?[^/]*\.(json|md)$|(^|\/)deployments?\/.*\.(json|md)$|(^|\/)addresses?[^/]*\.(json|md)$|(^|\/)broadcast\/.*\/run-latest\.json$/i;

const CODE_EXT: Record<string, number> = {
  ".sol": 10,
  ".vy": 9,
  ".nr": 9,
  ".cairo": 9,
  ".move": 8,
  ".circom": 8,
  ".huff": 8,
  ".masm": 7,
  ".daml": 8,
  ".rs": 4,
  ".go": 2,
};
/** Other languages a system's nodes, clients, specs and tooling are written in (tier 2). */
const OTHER_CODE = new Set([".py", ".c", ".h", ".cc", ".cpp", ".hpp", ".java", ".kt", ".scala", ".swift", ".zig", ".ex", ".hs"]);
/** Specifications and design notes kept as markdown in a repository (consensus-specs, EIPs, docs/). */
const SPEC_DOC = /(^|\/)(specs?|specifications?|eips|ercs|docs?|design)\/.+\.md$/i;
/** Protocol configuration: genesis, chain specs, network parameters (not tool configs). */
const CONFIG_FILE = /(^|\/)[^/]*(genesis|chain[-_]?spec|chain[-_]?config|params|parameters|network[-_]?config|mainnet|config)[^/]*\.(toml|ya?ml|json)$/i;
const CONFIG_NOISE =
  /tsconfig|eslint|prettier|babel|jest|vite|webpack|rollup\.config|turbo|lerna|renovate|dependabot|codecov|tailwind|postcss|vercel|netlify|docker|\.github|biome|commitlint|husky|nx\.json|package/i;
/** Forge deploy scripts: who gets admin roles, which delays are set. */
const DEPLOY_SCRIPT = /\.s\.sol$/i;
const DOC_FILE = /(^|\/)(readme|governance|architecture|design|spec|specification|protocol|overview|upgrades?|admin|roles|permissions)[^/]*\.md$/i;
const KEYWORDS =
  /contract|l1|protocol|governance|govern|bridge|portal|token|rollup|verifier|verify|pool|registry|escrow|access|role|upgrade|proxy|timelock|staking|slash|circuit|kernel|account|note|nullifier|privacy|private|shield|withdraw|deposit|pause|freeze|blacklist|admin|owner|council|multisig|safe|fee|paymaster|sequencer|inbox|outbox|deploy|address|key|wallet|signer|encrypt|crypto|relayer|prover|validator|keystore|kms|acl|gateway|decrypt|compliance|association|asp/i;
/** TypeScript packages that hold security-relevant logic (key handling, relayers, wallets, provers). */
const TS_RELEVANT =
  /(^|\/)(pxe|key[-_]?store|keys?|wallet|accounts?|relayer|signer|sdk|engine|crypto|prover|sequencer|node|kms|gateway|relayer-sdk|privacy|shield|note|governance|bridge)(\/|[-_.])/i;

export function isExcludedPath(path: string): boolean {
  return EXCLUDE.test(path) || VERSIONED_COPY.test(path);
}

export type Tier = 0 | 1 | 2 | 3;

/** Which tier a path belongs to, or null when it isn't snapshotted at all. */
/** Tier-0 names inside test, mock, example or vendored trees are fixtures, not the project's own records. */
const TIER0_NOISE = /(^|\/)(tests?|testing|mocks?|fixtures?|examples?|node_modules|lib|vendor|third[-_]party|e2e|out|build|dist|cache)\//i;

/** How-to guides about deploying (`docs/getting-started/deployment/*.md`) aren't address lists (R3-SRC-14). */
const DEPLOY_GUIDE = /(^|\/)(docs?|guides?|getting-started|tutorials?|how-?to)\/(.*\/)?deployments?\/[^/]+\.md$/i;

export function fileTier(path: string): Tier | null {
  if (TIER0.test(path) && !TIER0_NOISE.test(path) && !DEPLOY_GUIDE.test(path)) return 0;
  if (isExcludedPath(path)) return null;
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (DEPLOY_SCRIPT.test(path)) return 2;
  if ((CODE_EXT[ext] ?? 0) >= 7) return 1;
  if (ext === ".rs" || ext === ".go" || OTHER_CODE.has(ext) || DOC_FILE.test(path) || SPEC_DOC.test(path)) return 2;
  if (CONFIG_FILE.test(path) && !CONFIG_NOISE.test(path)) return 2;
  if ((ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".mjs") && TS_RELEVANT.test(path)) return 3;
  return null;
}

/** Ranking within a tier: language weight, security keywords in the path, shallow paths first. */
export function scoreFile(path: string): number {
  const tier = fileTier(path);
  if (tier === null) return 0;
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  // Named design docs (governance, architecture) rank with contracts' neighbours; other prose and configs below code.
  let s = tier === 0 ? 20 : tier === 3 ? 1 : DEPLOY_SCRIPT.test(path) ? 5 : (CODE_EXT[ext] ?? (OTHER_CODE.has(ext) ? 2 : DOC_FILE.test(path) ? 6 : 3));
  if (KEYWORDS.test(path)) s += 4;
  s -= Math.min(4, path.split("/").length / 3);
  return Math.max(0.1, s);
}

export interface TreeEntry {
  path: string;
  type: string;
  size?: number;
  sha?: string;
}

/** Larger files are generated or vendored blobs, not code worth quoting. */
export const MAX_FILE_BYTES = 2_000_000;

export interface Selection {
  picked: (TreeEntry & { tier: Tier; score: number })[];
  skipped: number;
  duplicates: number;
}

const TS_SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/i;
/** Source files, not type declarations or tool configs (vitest.config.mts, eslint.config.js). */
const isTsSource = (path: string) =>
  TS_SOURCE.test(path) && !/\.d\.[cm]?ts$/i.test(path) && !/(^|\/)[^/]*\.config\.[cm]?[jt]sx?$/i.test(path) && !isExcludedPath(path);

/**
 * A repository whose own code is TypeScript or JavaScript: a TS-native service (a permissioning API, a sequencer),
 * not an SDK beside contracts. At least 20 source files, no contract code at all, and three times as many as Rust,
 * Go or other systems code. Pure.
 */
export function isTsPrimary(entries: TreeEntry[]): boolean {
  let ts = 0;
  let contracts = 0;
  let systems = 0;
  for (const e of entries) {
    if (e.type !== "blob" || isExcludedPath(e.path)) continue;
    const ext = e.path.slice(e.path.lastIndexOf(".")).toLowerCase();
    if (isTsSource(e.path)) ts++;
    else if ((CODE_EXT[ext] ?? 0) >= 7) contracts++;
    else if (CODE_EXT[ext] !== undefined || OTHER_CODE.has(ext)) systems++;
  }
  return ts >= 20 && contracts === 0 && ts >= 3 * systems;
}

/** In a TS-native repository its source is the system's code (tier 2), and its SQL migrations define its data. */
function tsPrimaryTier(path: string): { tier: Tier; score: number } | null {
  if (isExcludedPath(path)) return null;
  const sql = /\.sql$/i.test(path);
  if (!sql && !isTsSource(path)) return null;
  let s = sql ? 2 : 4;
  if (KEYWORDS.test(path)) s += 4;
  s -= Math.min(4, path.split("/").length / 3);
  return { tier: 2, score: Math.max(0.1, s) };
}

/**
 * Picks files: tier 0 first (capped at 80 files / 4 MB), then by score, de-duplicated by blob SHA, files up to 2 MB.
 * TypeScript and JavaScript beside contracts (SDKs, tooling) are limited to 35% of the file budget; a repository
 * whose own code is TypeScript (isTsPrimary) has its source and SQL migrations ranked as code, without the cap.
 * Pure.
 */
export function selectFiles(entries: TreeEntry[], budget: { files: number; bytes: number }): Selection {
  const tsPrimary = isTsPrimary(entries);
  const seenSha = new Set<string>();
  let duplicates = 0;
  const candidates: (TreeEntry & { tier: Tier; score: number })[] = [];
  for (const t of entries) {
    if (t.type !== "blob" || (t.size ?? 0) > MAX_FILE_BYTES) continue;
    const base = fileTier(t.path);
    const promoted = tsPrimary && (base === null || base === 3) ? tsPrimaryTier(t.path) : null;
    const tier = promoted?.tier ?? base;
    if (tier === null) continue;
    if (t.sha) {
      if (seenSha.has(t.sha)) {
        duplicates++;
        continue;
      }
      seenSha.add(t.sha);
    }
    candidates.push({ ...t, tier, score: promoted?.score ?? scoreFile(t.path) });
  }
  candidates.sort((a, b) => ((a.tier === 0) !== (b.tier === 0) ? (a.tier === 0 ? -1 : 1) : b.score - a.score || a.path.localeCompare(b.path)));
  const picked: Selection["picked"] = [];
  let bytes = 0;
  let tier0 = 0;
  let tier0Bytes = 0;
  let ts = 0;
  const tsCap = Math.floor(budget.files * 0.35);
  for (const c of candidates) {
    if (picked.length >= budget.files) break;
    const size = c.size ?? 0;
    if (c.tier === 0) {
      if (tier0 >= 80 || tier0Bytes + size > 4_000_000) continue;
      tier0++;
      tier0Bytes += size;
    } else {
      if (bytes + size > budget.bytes) continue;
      if (c.tier === 3) {
        if (ts >= tsCap) continue;
        ts++;
      }
    }
    bytes += size;
    picked.push(c);
  }
  return { picked, skipped: candidates.length - picked.length, duplicates };
}

/** Generated-file markers in the first 300 bytes. */
export function isGeneratedHeader(text: string): boolean {
  return /@generated|auto-?generated|autogenerated|DO NOT EDIT|Code generated by|This file was generated|generated by (wasm-bindgen|typechain|abigen|protoc|forge bind)/i.test(
    text.slice(0, 300),
  );
}

// ---------- refs (pure helpers) ----------

export interface ReleaseInfo {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
}

const STABLE_TAG = /^v?\d+\.\d+(\.\d+)?$/;

/** The newest stable (non-draft, non-pre-release) release tag, by semver then date. Pure. */
export function latestStableTag(releases: ReleaseInfo[]): string | null {
  const stable = releases.filter((r) => !r.draft && !r.prerelease && parseSemver(r.tag_name) && !parseSemver(r.tag_name)!.pre);
  stable.sort((a, b) => {
    const sa = parseSemver(a.tag_name)!;
    const sb = parseSemver(b.tag_name)!;
    return compareSemver(sb, sa) || (b.published_at ?? "").localeCompare(a.published_at ?? "");
  });
  return stable[0]?.tag_name ?? null;
}

/**
 * The version before `current` among a repo's tracked versions: released no later than it, lower semver when both
 * parse, stable before pre-release, and ties on the release date broken by semver (v1.2.1 beats v1.2.0). Pure.
 */
export function pickPreviousTag(
  versions: { id: string; tag: string | null; releasedAt: string | null }[],
  current: { id: string; tag: string; releasedAt: string | null },
): string | null {
  const cur = parseSemver(current.tag);
  const candidates = versions.filter((v) => {
    if (!v.tag || v.id === current.id || v.tag === current.tag) return false;
    if ((v.releasedAt ?? "") > (current.releasedAt ?? "9999")) return false;
    const s = parseSemver(v.tag);
    if (cur && s && compareSemver(s, cur) >= 0) return false;
    return true;
  });
  const stableOnly = cur && !cur.pre ? candidates.filter((v) => !parseSemver(v.tag!)?.pre) : candidates;
  const pool = stableOnly.length ? stableOnly : candidates;
  pool.sort((a, b) => {
    const sa = parseSemver(a.tag!);
    const sb = parseSemver(b.tag!);
    if (sa && sb && cur) return compareSemver(sb, sa) || (b.releasedAt ?? "").localeCompare(a.releasedAt ?? "");
    return (b.releasedAt ?? "").localeCompare(a.releasedAt ?? "") || (sa && sb ? compareSemver(sb, sa) : 0);
  });
  return pool[0]?.tag ?? null;
}

/**
 * Releases worth storing: stable ones, plus pre-releases newer than the latest stable release or than the
 * previous evaluated version; newest first, capped. Pure.
 */
export function selectReleases(releases: ReleaseInfo[], opts: { sinceDate?: string | null; cap?: number } = {}): ReleaseInfo[] {
  const usable = releases.filter((r) => !r.draft && (r.body ?? "").trim().length > 20);
  const latestStable = usable
    .filter((r) => !r.prerelease)
    .map((r) => r.published_at ?? "")
    .sort()
    .pop();
  const floor = [latestStable, opts.sinceDate].filter((x): x is string => !!x).sort()[0] ?? "";
  return usable
    .filter((r) => !r.prerelease || (r.published_at ?? "") > floor)
    .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""))
    .slice(0, opts.cap ?? 30);
}

// ---------- tree fetching ----------

interface TreeResponse {
  sha: string;
  tree: TreeEntry[];
  truncated: boolean;
}

/** The full tree at a ref. When GitHub truncates the recursive listing, subtrees are walked individually (SRC-2). */
export async function fetchTree(ctx: LaneContext, repo: string, ref: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const top = await ctx.gh.get<TreeResponse>(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (!top.truncated) return { entries: top.tree, truncated: false };
  ctx.log(`${repo}@${ref}: tree truncated by GitHub; walking subtrees`);
  const out: TreeEntry[] = [];
  let calls = 0;
  let truncated = false;
  const walk = async (sha: string, prefix: string): Promise<void> => {
    if (calls++ > 150) {
      truncated = true;
      return;
    }
    const t = await ctx.gh.get<TreeResponse>(`/repos/${repo}/git/trees/${sha}?recursive=1`);
    if (!t.truncated) {
      for (const e of t.tree) out.push({ ...e, path: `${prefix}${e.path}` });
      return;
    }
    const flat = await ctx.gh.get<TreeResponse>(`/repos/${repo}/git/trees/${sha}`);
    const dirs: TreeEntry[] = [];
    for (const e of flat.tree) {
      const path = `${prefix}${e.path}`;
      out.push({ ...e, path });
      if (e.type === "tree" && !isExcludedPath(`${path}/`)) dirs.push({ ...e, path });
    }
    for (const d of dirs) await walk(d.sha!, `${d.path}/`);
  };
  const root = await ctx.gh.get<TreeResponse>(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}`);
  const dirs: TreeEntry[] = [];
  for (const e of root.tree) {
    out.push(e);
    if (e.type === "tree" && !isExcludedPath(`${e.path}/`)) dirs.push(e);
  }
  await mapLimit(dirs, 4, (d) => walk(d.sha!, `${d.path}/`));
  return { entries: out, truncated };
}

/**
 * The newest stable tag by semver, prefixes allowed (`v0.3.3`, `PRIVACY-1.2.0`); pre-releases (`-RC.8`) never.
 * For repos that tag without publishing releases (tempoxyz/zones). Pure.
 */
export function latestStableFromTags(tags: string[]): string | null {
  const stable = tags.filter((t) => parseSemver(t) && !parseSemver(t)!.pre);
  stable.sort((a, b) => compareSemver(parseSemver(b)!, parseSemver(a)!) || a.localeCompare(b));
  return stable[0] ?? null;
}

/** A tag that marks a mainnet deployment (`CONTRACT_V2_DEPLOYED_MAINNET_2026-07-08`): the newest by its date. Pure. */
export function latestDeploymentTag(tags: string[]): string | null {
  const marked = tags.filter((t) => /deploy(ed)?[-_ ]?(to[-_ ])?mainnet|mainnet[-_ ]?deploy/i.test(t));
  const dateOf = (t: string) =>
    t
      .match(/(20\d\d)[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])/)
      ?.slice(1, 4)
      .join("-") ?? "";
  marked.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
  return marked[0] ?? null;
}

export type RefSource = "pinned" | "latest-release" | "latest-tag" | "deployment-tag" | "default-branch";

/**
 * The ref to snapshot: the pinned version's tag for its repo, else the latest stable release, else the highest
 * stable tag, else the newest tag marking a mainnet deployment, else the default branch (R3-SRC-12).
 */
export async function resolveRef(ctx: LaneContext, repo: string): Promise<{ ref: string; source: RefSource; defaultBranch: string }> {
  const meta = await ctx.gh.get<{ default_branch: string }>(`/repos/${repo}`);
  const pinned = ctx.version?.repo === repo && ctx.version.tag ? ctx.version.tag : null;
  if (pinned) return { ref: pinned, source: "pinned", defaultBranch: meta.default_branch };
  const releases = await ctx.gh.get<ReleaseInfo[]>(`/repos/${repo}/releases?per_page=100`).catch(() => [] as ReleaseInfo[]);
  const tag = latestStableTag(releases);
  if (tag) return { ref: tag, source: "latest-release", defaultBranch: meta.default_branch };
  const tags = (await ctx.gh.get<{ name: string }[]>(`/repos/${repo}/tags?per_page=100`).catch(() => [] as { name: string }[])).map((t) => t.name);
  const stableTag = latestStableFromTags(tags);
  if (stableTag) return { ref: stableTag, source: "latest-tag", defaultBranch: meta.default_branch };
  const deployed = latestDeploymentTag(tags);
  if (deployed) return { ref: deployed, source: "deployment-tag", defaultBranch: meta.default_branch };
  return { ref: meta.default_branch, source: "default-branch", defaultBranch: meta.default_branch };
}

const REF_LABEL: Record<RefSource, string> = {
  pinned: "pinned version",
  "latest-release": "latest stable release",
  "latest-tag": "latest stable tag (no releases published)",
  "deployment-tag": "newest mainnet-deployment tag (no stable tags)",
  "default-branch": "default branch",
};

/** GitHub's fallback for a repo without its own security policy: the org's `.github` repo (R3-SRC-4). */
const SECURITY_POLICY = /^(\.github\/|docs\/)?SECURITY\.md$/i;

// ---------- lanes ----------

export interface RepoSnapshot {
  repo: string;
  ref: string;
  commit: string | null;
  refSource: string;
  files: number;
  reused: number;
  generated: number;
  bytes: number;
  truncated: boolean;
  /** Files that couldn't be read (network, rate limits): the lane is partial and keeps earlier rows. */
  failed: number;
}

/** Deletes (or marks stale, when cited) this repo's code from other refs. Runs even when the snapshot fails. */
export async function purgeOtherRefs(ctx: LaneContext, repo: string, keepRef: string): Promise<{ deleted: number; staled: number }> {
  return purgeWhere(ctx.db, ctx.project.id, sql`meta->>'section' = 'code' AND meta->>'repo' = ${repo} AND coalesce(meta->>'ref', '') <> ${keepRef}`);
}

/** Snapshots a repo at its ref: repository map plus the selected files. */
export async function ingestRepoCode(ctx: LaneContext, repo: string, budget: { files: number; bytes: number }): Promise<RepoSnapshot> {
  const { ref, source, defaultBranch } = await resolveRef(ctx, repo);
  ctx.shared.repoRefs.set(repo, ref);
  const lane = `code:${repo}`;
  let tree: { entries: TreeEntry[]; truncated: boolean };
  try {
    tree = await fetchTree(ctx, repo, ref);
  } catch (e) {
    // A failed pinned snapshot must not leave another ref's code looking like the pinned version (SRC-2).
    const p = await purgeOtherRefs(ctx, repo, ref);
    if (p.deleted || p.staled) ctx.log(`${repo}: removed ${p.deleted} files from other refs, marked ${p.staled} cited files stale`);
    throw e;
  }
  const [info, commit] = await Promise.all([ctx.gh.get<{ license: { spdx_id: string } | null; pushed_at: string }>(`/repos/${repo}`), ghCommitSha(repo, ref)]);
  const map = tree.entries.filter((t) => t.type === "blob" && !isExcludedPath(t.path)).map((t) => t.path);
  await storeFor(ctx, lane, "code", {
    url: `https://github.com/${repo}/tree/${ref}`,
    title: `${repo}@${ref}: repository map (${map.length} files${tree.truncated ? ", partial" : ""})`,
    kind: "code",
    sourceClass: "code_onchain",
    content: [
      `Repository: ${repo}`,
      `Ref: ${ref} (${source === "default-branch" ? `default branch ${defaultBranch}` : REF_LABEL[source]})`,
      `Commit: ${commit ?? "unknown"}`,
      `License: ${info.license?.spdx_id ?? "none"}`,
      `Last push: ${info.pushed_at}`,
      "",
      ...map,
    ].join("\n"),
    meta: { repo, ref, commit, path: "", map: true, refSource: source },
  });
  const sel = selectFiles(tree.entries, budget);
  // Reuse blobs already stored (same SHA, any ref) instead of downloading them again (EFF-11).
  const known = new Map<string, { id: string; url: string; lane: string | null; len: number; stale: boolean }>();
  for (const r of await query<{ id: string; url: string; sha: string; lane: string | null; len: number; stale: boolean }>(
    ctx.db,
    sql`SELECT id, url, meta->>'sha' AS sha, meta->>'lane' AS lane, coalesce(content_len, 0) AS len, coalesce(meta->>'stale', 'false') = 'true' AS stale
      FROM sources
      WHERE project_id = ${ctx.project.id} AND meta->>'section' = 'code' AND meta->>'repo' = ${repo} AND (meta->>'sha') IS NOT NULL`,
  )) {
    if (!known.has(r.sha) || r.url.includes(`/blob/${ref}/`)) known.set(r.sha, { id: r.id, url: r.url, lane: r.lane, len: r.len, stale: r.stale });
  }
  const contentOf = async (id: string) => (await query<{ c: string }>(ctx.db, sql`SELECT content_md AS c FROM sources WHERE id = ${id}`))[0]?.c ?? null;
  let files = 0;
  let reused = 0;
  let generated = 0;
  let bytes = 0;
  let failed = 0;
  // A file already stored at this ref with the same blob is unchanged: kept in one statement, not downloaded again
  // (a weekly rebuild at the same tag re-reads nothing).
  const urlOf = (path: string) => `https://github.com/${repo}/blob/${ref}/${path}`;
  const same = (f: (typeof sel.picked)[number]) => {
    const k = f.sha ? known.get(f.sha) : undefined;
    return !!k && k.url === urlOf(f.path) && k.lane === lane && !k.stale;
  };
  const unchanged = sel.picked.filter(same);
  if (unchanged.length) {
    await keepAlive(
      ctx.db,
      ctx.project.id,
      lane,
      ctx.runId,
      unchanged.map((f) => urlOf(f.path)),
    );
    files += unchanged.length;
    reused += unchanged.length;
    bytes += unchanged.reduce((n, f) => n + known.get(f.sha!)!.len, 0);
  }
  await mapLimit(
    sel.picked.filter((f) => !same(f)),
    8,
    async (f) => {
      try {
        let content: string | null = null;
        const prior = f.sha ? known.get(f.sha) : undefined;
        if (prior) {
          content = await contentOf(prior.id);
          if (content !== null) reused++;
        }
        if (content === null) {
          const body = await ghRaw(repo, ref, f.path, 8 * 1024 * 1024);
          if (!body) return;
          content = body.toString("utf8");
        }
        if (f.tier !== 0 && isGeneratedHeader(content)) {
          generated++;
          return;
        }
        const isDoc = /\.(md|mdx)$/i.test(f.path);
        const url = `https://github.com/${repo}/blob/${ref}/${f.path}`;
        let kind = isDoc ? "docs" : "code";
        let sourceClass: SourceClass = isDoc ? "official_docs" : "code_onchain";
        let audit: Record<string, unknown> | undefined;
        if (isDoc && AUDIT_FILE.test(f.path)) {
          // A report kept in the project's repo is the project's copy (official docs); the firm it names is a claim.
          const c = classify(ctx, url, "code", { title: f.path, text: content });
          kind = c.kind;
          sourceClass = c.sourceClass;
          if (c.kind === "audit") {
            const am = parseAuditMeta(content, url);
            audit = { ...am, auditor: c.auditor ?? am.auditor, claimedAuditor: c.claimedAuditor ?? am.claimedAuditor };
          }
        }
        const { status } = await storeFor(ctx, lane, "code", {
          url,
          title: `${repo}/${f.path}@${ref}`,
          kind,
          sourceClass,
          content,
          meta: { repo, ref, path: f.path, sha: f.sha ?? null, tier: f.tier, ...(commit ? { commit } : {}), ...(audit ? { audit } : {}) },
        });
        if (counted(status)) {
          files++;
          bytes += content.length;
        }
        if (files % 100 === 0 && files) ctx.log(`${repo}: ${files}/${sel.picked.length} files`);
      } catch (e) {
        // The project's storage budget is a hard stop, not one unreadable file.
        if (e instanceof KbBudgetError) throw e;
        failed++;
      }
    },
  );
  if (failed) ctx.log(`${repo}: ${failed} of ${sel.picked.length} files couldn't be read; keeping earlier copies`);
  // Code from other refs of this repo goes (or is marked stale when cited), so agents never mix versions.
  await purgeOtherRefs(ctx, repo, ref);
  // No security policy in the repo: GitHub shows the org's `.github/SECURITY.md` instead, and so do we (tier 0).
  if (!tree.entries.some((t) => t.type === "blob" && SECURITY_POLICY.test(t.path))) {
    if (await ingestOrgSecurityPolicy(ctx, repo.split("/")[0]!, lane)) files++;
  }
  return { repo, ref, commit, refSource: source, files, reused, generated, bytes, truncated: tree.truncated || sel.skipped > 0, failed };
}

/**
 * The org-wide security policy from `<owner>/.github` (Tempo's says the chain "is still undergoing audit and does
 * not have an active bug bounty"). Stored once per owner per run, under the repo lane that asked first.
 */
export async function ingestOrgSecurityPolicy(ctx: LaneContext, owner: string, lane: string): Promise<boolean> {
  return ctx.gh.once(`org-security:${owner.toLowerCase()}:${ctx.runId}`, async () => {
    const repo = `${owner}/.github`;
    const info = await ctx.gh.getOrNull<{ default_branch: string }>(`/repos/${repo}`).catch(() => null);
    if (!info) return false;
    for (const path of ["SECURITY.md", ".github/SECURITY.md", "docs/SECURITY.md"]) {
      const body = await ghRaw(repo, info.default_branch, path, 1024 * 1024).catch(() => null);
      if (!body) continue;
      const { status } = await storeFor(ctx, lane, "code", {
        url: `https://github.com/${repo}/blob/${info.default_branch}/${path}`,
        title: `${repo}/${path}@${info.default_branch} (organization security policy)`,
        kind: "docs",
        sourceClass: "official_docs",
        content: body.toString("utf8"),
        meta: { repo, ref: info.default_branch, path, tier: 0, orgPolicy: true },
      });
      return counted(status);
    }
    return false;
  });
}

/** Release notes: stable releases plus recent pre-releases (SRC-14). */
export async function ingestRepoReleases(ctx: LaneContext, repo: string, sinceDate: string | null, cap = 30): Promise<number> {
  const rels = await ctx.gh.get<ReleaseInfo[]>(`/repos/${repo}/releases?per_page=100`);
  let n = 0;
  for (const r of selectReleases(rels, { sinceDate, cap })) {
    const { status } = await storeFor(ctx, `releases:${repo}`, "changes", {
      url: r.html_url,
      title: `${repo} ${r.tag_name} release notes${r.prerelease ? " (pre-release)" : ""}`,
      kind: "changes",
      sourceClass: "official_docs",
      content: `# ${r.name || r.tag_name}\n\n${r.body}`,
      date: r.published_at?.slice(0, 10) ?? null,
      meta: { repo, tag: r.tag_name, prerelease: r.prerelease },
    });
    if (counted(status)) n++;
  }
  return n;
}

/** Code changes between two refs: all commits (paged), changed files, and patches of security-relevant files. */
export async function ingestRepoChanges(ctx: LaneContext, repo: string, base: string, head: string): Promise<boolean> {
  type C = {
    ahead_by: number;
    total_commits?: number;
    commits: { sha: string; commit: { message: string; author: { date: string } } }[];
    files?: { filename: string; status: string; additions: number; deletions: number; patch?: string }[];
  };
  const path = `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  // With paging, page 1 carries the complete changed-file list; later pages only add commits.
  const first = await ctx.gh.get<C>(`${path}?per_page=100&page=1`);
  const commits = [...first.commits];
  for (let page = 2; page <= 10 && commits.length < (first.total_commits ?? first.ahead_by); page++) {
    const next = await ctx.gh.get<C>(`${path}?per_page=100&page=${page}`).catch(() => null);
    if (!next?.commits.length) break;
    commits.push(...next.commits);
  }
  const files = first.files ?? [];
  const relevant = files.filter((f) => fileTier(f.filename) !== null);
  relevant.sort((a, b) => scoreFile(b.filename) - scoreFile(a.filename));
  let patches = "";
  for (const f of relevant) {
    if (patches.length > 400_000) break;
    if (f.patch) patches += `\n\n### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n\`\`\`diff\n${f.patch.slice(0, 6000)}\n\`\`\``;
  }
  const content = [
    `Comparing ${base} → ${head}: ${first.total_commits ?? first.ahead_by} commits, ${files.length} files changed (${relevant.length} security-relevant).`,
    "## Commits",
    ...commits.slice(-1000).map((x) => `- ${x.commit.author.date.slice(0, 10)} ${x.sha.slice(0, 8)} ${x.commit.message.split("\n")[0]}`),
    "## Security-relevant files changed",
    ...relevant.map((f) => `- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`),
    "## Patches",
    patches,
  ].join("\n");
  await storeFor(ctx, `changes:${repo}`, "changes", {
    url: `https://github.com/${repo}/compare/${base}...${head}`,
    title: `${repo} changes ${base} → ${head}`,
    kind: "changes",
    sourceClass: "code_onchain",
    content,
    meta: { repo, base, head },
  });
  return true;
}

/** Published GitHub security advisories for a repo (P1). */
export async function ingestRepoAdvisories(ctx: LaneContext, repo: string): Promise<number> {
  type A = {
    ghsa_id: string;
    cve_id: string | null;
    html_url: string;
    summary: string;
    description: string | null;
    severity: string | null;
    published_at: string | null;
    vulnerabilities?: { package?: { name?: string; ecosystem?: string } | null; vulnerable_version_range?: string | null; patched_versions?: string | null }[];
    credits?: { login?: string; user?: { login?: string } }[];
  };
  let advisories: A[] = [];
  try {
    advisories = await ctx.gh.get<A[]>(`/repos/${repo}/security-advisories?per_page=100&state=published`);
  } catch (e) {
    if (e instanceof GithubError && (e.status === 404 || e.status === 403)) return 0;
    throw e;
  }
  let n = 0;
  for (const a of advisories) {
    const vulns = (a.vulnerabilities ?? [])
      .map(
        (v) =>
          `- ${v.package?.name ?? "package"} (${v.package?.ecosystem ?? "?"}): affected ${v.vulnerable_version_range ?? "?"}, patched ${v.patched_versions ?? "?"}`,
      )
      .join("\n");
    const { status } = await storeFor(ctx, `advisories:${repo}`, "changes", {
      url: a.html_url,
      title: `${repo} security advisory ${a.ghsa_id}: ${a.summary}`,
      kind: "changes",
      sourceClass: "official_docs",
      content: [
        `# ${a.summary}`,
        `Advisory: ${a.ghsa_id}${a.cve_id ? ` (${a.cve_id})` : ""} · severity ${a.severity ?? "unknown"} · published ${a.published_at?.slice(0, 10) ?? "?"}`,
        vulns ? `\n## Affected\n${vulns}` : "",
        `\n## Details\n${a.description ?? ""}`,
      ].join("\n"),
      date: a.published_at?.slice(0, 10) ?? null,
      meta: { repo, subkind: "advisory", ghsa: a.ghsa_id, severity: a.severity },
    });
    if (counted(status)) n++;
  }
  return n;
}

// ---------- repo discovery ----------

const LANG_WEIGHT: Record<string, number> = {
  Solidity: 6,
  Noir: 6,
  Cairo: 6,
  Circom: 5,
  Vyper: 5,
  Move: 5,
  Rust: 3,
  Go: 2,
  TypeScript: 1,
  "C++": 1,
  // Protocol specifications (Ethereum's consensus and execution specs) are executable Python.
  Python: 1,
};
const REPO_GOOD =
  /contract|circuit|protocol|core|bridge|governance|token|vault|pool|privacy|shield|engine|node|vm|wallet|relayer|kms|gateway|rollup|sequencer|l1|zk|kernel|prover|verifier|specs?$|^specs?|-specs?-|eips?$|ercs?$|consensus|execution|beacon|deposit|staking|stealth|confidential|fhe|innocence|ppoi|broadcaster|security/i;
const REPO_BAD =
  /docs?$|^docs|website|landing|example|demo|tutorial|test|bench|template|awesome|brand|design|^ui$|frontend|blog|faucet|explorer|homebrew|action|\.github|playground|workshop|hackathon|starter|boilerplate|mocks?\b|course|fundamental|exporter|metrics|changelog|images|container|runner|hooks|snippets|assets|slides|presentation|sandbox/i;
const DESC_GOOD =
  /specification|protocol|smart contracts?|circuits?|zero[- ]knowledge|privacy|consensus|execution client|full node|security|threshold|key management|encrypt/i;
const DESC_STALE = /deprecated|no longer (maintained|supported|in use)|unmaintained|sunset|archived|legacy|superseded/i;

export interface OrgRepo {
  full_name: string;
  name: string;
  language: string | null;
  pushed_at: string | null;
  archived: boolean;
  fork: boolean;
  stargazers_count: number;
  description: string | null;
  topics?: string[];
  /** KB; 0 for an empty repository. */
  size?: number;
}

/** Scores an org's repos for relevance to a privacy/security evaluation (language, name, description signals). Pure. */
export function rankRepos(repos: OrgRepo[], configured: string[], now = Date.now()): RepoSuggestion[] {
  const conf = new Set(configured.map((r) => r.toLowerCase()));
  return repos
    .map((r) => {
      const reasons: string[] = [];
      let score = 0;
      const lw = LANG_WEIGHT[r.language ?? ""] ?? 0;
      if (lw) {
        score += lw;
        reasons.push(`${r.language}`);
      }
      // A docs, demo or template repo about the protocol (fhevm-foundry-template) gets no credit for its name.
      if (REPO_BAD.test(r.name)) {
        score -= 4;
        reasons.push("docs/demo/tooling name");
      } else if (/contracts?|circuits?/i.test(r.name)) {
        score += 5;
        reasons.push("contracts/circuits in name");
      } else if (REPO_GOOD.test(r.name)) {
        score += 3;
        reasons.push("protocol-related name");
      }
      const about = `${r.description ?? ""} ${(r.topics ?? []).join(" ")}`;
      const deprecated = DESC_STALE.test(about);
      if (deprecated) {
        score -= 8;
        reasons.push("described as deprecated");
      } else if (DESC_GOOD.test(about)) {
        score += 2;
        reasons.push("protocol-related description");
      }
      if (r.fork) {
        score -= 5;
        reasons.push("fork");
      }
      if (r.archived) {
        score -= 6;
        reasons.push("archived");
      }
      const ageDays = r.pushed_at ? (now - Date.parse(r.pushed_at)) / 86_400_000 : 9999;
      if (ageDays > 730) {
        score -= 3;
        reasons.push("no push in 2 years");
      }
      score += Math.log10((r.stargazers_count ?? 0) + 1);
      return {
        repo: r.full_name,
        score: Math.round(score * 10) / 10,
        language: r.language,
        pushedAt: r.pushed_at,
        archived: r.archived,
        configured: conf.has(r.full_name.toLowerCase()),
        reasons,
        fork: r.fork,
        empty: r.size === 0,
        deprecated,
        description: r.description,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** A discovered repo is monitored from this score up, when it's active and the org is the project's. */
export const MIN_MONITOR_SCORE = 5;
/** ...and pushed within this many days: a dormant repo is history, not the system that runs today. */
export const MONITOR_ACTIVE_DAYS = 365;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The org repos monitored besides the configured ones: active, relevant (score), not archived, forked or empty,
 * and either in an org that is the project's own (named after it, or its profile links the project's site) or
 * naming the project themselves. An org that holds unrelated products (starkware-libs for STRK20) contributes only
 * repos that name the project. Pure.
 */
export function pickMonitoredRepos(
  ranked: RepoSuggestion[],
  opts: { dedicatedOwners: string[]; tokens: string[]; limit: number; now?: number },
): RepoSuggestion[] {
  const now = opts.now ?? Date.now();
  const dedicated = new Set(opts.dedicatedOwners.map((o) => o.toLowerCase()));
  const tokens = opts.tokens.map(squash).filter((t) => t.length >= 3);
  return ranked
    .filter((r) => {
      if (r.configured || r.archived || r.fork || r.empty || r.deprecated || r.score < MIN_MONITOR_SCORE) return false;
      if (!r.pushedAt || now - Date.parse(r.pushedAt) > MONITOR_ACTIVE_DAYS * 86_400_000) return false;
      const owner = r.repo.split("/")[0]!.toLowerCase();
      return dedicated.has(owner) || tokens.some((t) => squash(`${r.repo.split("/")[1]} ${r.description ?? ""}`).includes(t));
    })
    .slice(0, opts.limit);
}

/** Every public repository of a GitHub org or user (paged, newest push first; at most `maxPages` of 100). */
export async function listOwnerRepos(gh: LaneContext["gh"], owner: string, maxPages = 6): Promise<OrgRepo[]> {
  const out: OrgRepo[] = [];
  for (const kind of ["orgs", "users"] as const) {
    for (let page = 1; page <= maxPages; page++) {
      const batch = await gh.getOrNull<OrgRepo[]>(`/${kind}/${encodePath(owner)}/repos?per_page=100&type=public&sort=pushed&page=${page}`).catch(() => null);
      if (!batch) break;
      out.push(...batch);
      if (batch.length < 100) break;
    }
    if (out.length) break;
  }
  return out;
}

/**
 * Ranks every repository in the project's GitHub orgs (configured repo owners plus orgs the website links) and picks
 * the ones to monitor alongside the configured repos. The ranking is kept for editors as suggestions.
 */
export async function discoverRepos(
  ctx: Pick<LaneContext, "gh" | "registry"> & { project: ProjectRow },
  opts: { dedicatedOwners: string[]; limit: number },
): Promise<{ ranked: RepoSuggestion[]; monitored: RepoSuggestion[] }> {
  const owners = new Set([...ctx.project.githubRepos.map((r) => r.split("/")[0]!.toLowerCase()), ...ctx.registry.githubOwners]);
  const all: OrgRepo[] = [];
  for (const owner of [...owners].slice(0, 6)) all.push(...(await listOwnerRepos(ctx.gh, owner)));
  const ranked = rankRepos(all, ctx.project.githubRepos);
  return { ranked, monitored: pickMonitoredRepos(ranked, { dedicatedOwners: opts.dedicatedOwners, tokens: ctx.registry.tokens, limit: opts.limit }) };
}

/** The previous version's tag for diffs (DB wrapper around pickPreviousTag). */
export async function previousTagFor(
  ctx: Pick<LaneContext, "db" | "project">,
  version: VersionRow | null,
  repo: string,
): Promise<{ tag: string; releasedAt: string | null } | null> {
  if (!version?.tag || version.repo !== repo) return null;
  const rows = await query<{ id: string; tag: string; releasedAt: string | null }>(
    ctx.db,
    sql`SELECT id, tag, released_at AS "releasedAt" FROM project_versions WHERE project_id = ${ctx.project.id} AND repo = ${repo} AND tag IS NOT NULL`,
  );
  const tag = pickPreviousTag(rows, { id: version.id, tag: version.tag, releasedAt: version.releasedAt });
  if (!tag) return null;
  return { tag, releasedAt: rows.find((r) => r.tag === tag)?.releasedAt ?? null };
}

/**
 * Per-repo budgets: the configured repos share the code budget, the discovered ones a budget of their own, so the
 * pinned code keeps its depth. With no configured repos, the discovered ones get both.
 */
export function repoBudgets(
  configured: number,
  discovered: number,
): { configured: { files: number; bytes: number }; discovered: { files: number; bytes: number } } {
  const split = (files: number, bytes: number, n: number) => ({ files: Math.floor(files / Math.max(1, n)), bytes: Math.floor(bytes / Math.max(1, n)) });
  const extraFiles = configured ? 0 : env.kb.maxCodeFiles;
  const extraBytes = configured ? 0 : env.kb.maxCodeBytes;
  return {
    configured: split(env.kb.maxCodeFiles, env.kb.maxCodeBytes, configured),
    discovered: split(env.kb.maxDiscoveredCodeFiles + extraFiles, env.kb.maxDiscoveredCodeBytes + extraBytes, discovered),
  };
}

/** Per-repo budget for the code lane (configured repos only). */
export function perRepoBudget(repos: number): { files: number; bytes: number } {
  return repoBudgets(repos, 0).configured;
}

export const _test = { VERSIONED_COPY, STABLE_TAG };
