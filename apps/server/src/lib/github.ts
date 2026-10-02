/**
 * GitHub REST client for the knowledge base. Large responses (trees of big monorepos, raw files) are allowed up to
 * 64 MB and throw instead of being truncated. The token is sent to api.github.com and raw.githubusercontent.com
 * only; the fetcher strips it on cross-origin redirects.
 */
import { env } from "../env.ts";
import { auditorForUrl } from "../services/classify.ts";
import { safeFetch } from "./fetcher.ts";
import { redact } from "./redact.ts";

export const GH_MAX_BYTES = 64 * 1024 * 1024;

export class GithubError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function ghHeaders(accept = "application/vnd.github+json"): Record<string, string> {
  const h: Record<string, string> = { accept, "x-github-api-version": "2022-11-28" };
  if (env.githubToken) h.authorization = `Bearer ${env.githubToken}`;
  return h;
}

export const validRepo = (r: string) => /^[\w.-]+\/[\w.-]+$/.test(r) && !r.includes("..");

/** Percent-encodes each path segment, keeping the slashes. */
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

/**
 * A repository file path made safe for a raw.githubusercontent.com URL: each segment decoded (so `%2e%2e` is seen
 * for what it is), empty, `.` and `..` segments and any carrying a separator rejected, then re-encoded. Null when
 * nothing safe is left. Pure.
 */
export function safeRepoPath(path: string): string | null {
  const out: string[] = [];
  for (const raw of path.replace(/^\/+/, "").split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!seg) continue;
    if (seg === "." || seg === ".." || /[\\/\0]/.test(seg)) return null;
    out.push(encodeURIComponent(seg));
  }
  return out.length ? out.join("/") : null;
}

/** A raw-file URL for owner/repo at ref, refusing anything that would resolve outside that repo. */
export function rawFileUrl(repo: string, ref: string, path: string): string | null {
  const safe = safeRepoPath(path);
  if (!safe || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split("/").some((p) => p === "." || p === "..")) return null;
  const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${safe}`;
  return new URL(url).pathname.startsWith(`/${repo}/`) ? url : null;
}

async function request(path: string, opts: { accept?: string; maxBytes?: number; timeoutMs?: number } = {}) {
  const res = await safeFetch(`https://api.github.com${path}`, {
    headers: ghHeaders(opts.accept),
    maxBytes: opts.maxBytes ?? GH_MAX_BYTES,
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  if (res.status === 403 || res.status === 429) {
    const body = res.body.toString("utf8").slice(0, 200);
    if (/rate limit/i.test(body)) throw new GithubError(`GitHub rate limit reached${env.githubToken ? "" : " (set GITHUB_TOKEN)"}`, res.status);
    throw new GithubError(`GitHub ${res.status} for ${path}: ${redact(body)}`, res.status);
  }
  if (res.status >= 400) throw new GithubError(`GitHub ${res.status} for ${path}`, res.status);
  return res;
}

/** GET a GitHub API path and parse JSON. Throws GithubError (with status) on HTTP errors. */
export async function gh<T>(path: string, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<T> {
  const res = await request(path, opts);
  return JSON.parse(res.body.toString("utf8")) as T;
}

/** Like gh(), but null on 404. */
export async function ghOrNull<T>(path: string, opts: { maxBytes?: number } = {}): Promise<T | null> {
  try {
    return await gh<T>(path, opts);
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) return null;
    throw e;
  }
}

/** The commit SHA a ref (tag, branch or SHA) points to. */
export async function ghCommitSha(repo: string, ref: string): Promise<string | null> {
  try {
    const res = await request(`/repos/${repo}/commits/${encodeURIComponent(ref)}`, { accept: "application/vnd.github.sha", maxBytes: 4096 });
    const sha = res.body.toString("utf8").trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Follows page numbers until a short page (the fetcher doesn't expose Link headers). */
export async function ghPaged<T>(path: string, maxPages = 5, perPage = 100): Promise<T[]> {
  const out: T[] = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const items = await gh<T[]>(`${path}${sep}per_page=${perPage}&page=${page}`);
    if (!Array.isArray(items)) break;
    out.push(...items);
    if (items.length < perPage) break;
  }
  return out;
}

/**
 * A raw file at a ref, or null when it doesn't exist. Uses the server token for the higher rate limit unless
 * `token: false` (repos named by third parties, e.g. links from DefiLlama or Exa, are read anonymously).
 */
export async function ghRaw(repo: string, ref: string, path: string, maxBytes = GH_MAX_BYTES, opts: { token?: boolean } = {}): Promise<Buffer | null> {
  const useToken = opts.token !== false && !!env.githubToken;
  const url = rawFileUrl(repo, ref, path);
  if (!url) throw new GithubError(`unsafe path ${repo}/${path}`, 400);
  const res = await safeFetch(url, {
    headers: useToken ? { authorization: `Bearer ${env.githubToken}` } : {},
    maxBytes,
    timeoutMs: 60_000,
  });
  if (res.status === 404) return null;
  if (res.status >= 400) throw new GithubError(`raw.githubusercontent.com ${res.status} for ${repo}/${path}`, res.status);
  return res.body;
}

// ---------- evaluation agents (R3-SEC-5) ----------

/**
 * The token evaluation agents' GitHub tools use: `GITHUB_AGENT_TOKEN` (a fine-grained token limited to public
 * repositories, read-only, so injected instructions can't reach private repos), never the server's broader
 * `GITHUB_TOKEN`; without it the tools read anonymously (lower rate limits). The tools only read the project's
 * repos and auditors' report repos (`agentMayReadRepo`).
 */
export function agentGithubToken(): string {
  return process.env.GITHUB_AGENT_TOKEN || "";
}

/** Headers for an agent's GitHub API call. */
export function agentGhHeaders(accept = "application/vnd.github+json"): Record<string, string> {
  const h: Record<string, string> = { accept, "x-github-api-version": "2022-11-28" };
  const t = agentGithubToken();
  if (t) h.authorization = `Bearer ${t}`;
  return h;
}

/** Repos any agent may read whatever project it evaluates, besides auditors' report repos: L2BEAT's config. */
export const AGENT_REPO_ALLOWLIST = ["l2beat/l2beat"];

/**
 * Whether an agent may read a repo: one owned by the project (its registry's GitHub owners), an auditor's report
 * repository (`auditorForUrl`), or the allowlist. Keeps an injected instruction from pointing the tools at
 * arbitrary repos.
 */
export function agentMayReadRepo(repo: string, ownedOwners: string[]): boolean {
  const [owner] = repo.toLowerCase().split("/");
  if (!owner) return false;
  if (ownedOwners.map((o) => o.toLowerCase()).includes(owner)) return true;
  if (AGENT_REPO_ALLOWLIST.includes(repo.toLowerCase())) return true;
  // Code4rena's findings repos (only their report.md counts as an audit; classification sees to that).
  if (/^code-423n4\/[\w.-]+-findings$/i.test(repo)) return true;
  return auditorForUrl(`https://github.com/${repo}`) !== null;
}

/**
 * GitHub code-search terms with no way to widen the search: qualifiers (`org:`, `repo:`), boolean operators and
 * grouping are removed, and each remaining term is quoted.
 */
export function sanitizeCodeSearch(query: string): string {
  return query
    .replace(/\b[a-z_]+:\S*/gi, " ")
    .replace(/[()"\\]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !/^(OR|AND|NOT)$/i.test(t) && t !== "-" && !t.startsWith("-"))
    .slice(0, 8)
    .map((t) => `"${t.slice(0, 60)}"`)
    .join(" ");
}

/** Per-refresh memo so lanes that need the same tree or listing share one request. */
export class GithubMemo {
  private cache = new Map<string, Promise<unknown>>();
  get<T>(path: string, opts: { maxBytes?: number } = {}): Promise<T> {
    let p = this.cache.get(path) as Promise<T> | undefined;
    if (!p) {
      p = gh<T>(path, opts);
      this.cache.set(path, p);
      p.catch(() => this.cache.delete(path));
    }
    return p;
  }
  getOrNull<T>(path: string): Promise<T | null> {
    return this.get<T>(path).catch((e) => {
      if (e instanceof GithubError && e.status === 404) return null;
      throw e;
    });
  }
  /** Memoizes any async computation under a key. */
  once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.cache.get(`once:${key}`) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.cache.set(`once:${key}`, p);
    }
    return p;
  }
}
