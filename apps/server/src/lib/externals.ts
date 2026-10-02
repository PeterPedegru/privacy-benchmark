/**
 * Thin clients for the external research sources: Exa (web search with page text, and page/PDF contents),
 * NewsAPI.ai / Event Registry (news coverage) and the X API v2 (announcements).
 * Each returns plain records; callers store them as knowledge-base sources. Keys travel in headers or request
 * bodies, never in URLs, and upstream error text is redacted before it is thrown.
 */
import { env, isRealSecret } from "../env.ts";
import { fetchSignal, throwIfFetchAborted } from "./fetcher.ts";
import { redact } from "./redact.ts";

export interface FoundDoc {
  title: string;
  url: string;
  text: string;
  publishedAt: string | null;
  author?: string | null;
  source?: string | null;
}

async function upstreamError(url: string, res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(redact(`${new URL(url).host} ${res.status}: ${body.slice(0, 300)}`));
}

/** A request's timeout, combined with the knowledge-base refresh's abort signal when there is one (R4-17). */
function requestSignal(timeoutMs: number): AbortSignal {
  const scope = fetchSignal();
  throwIfFetchAborted(scope);
  return scope ? AbortSignal.any([AbortSignal.timeout(timeoutMs), scope]) : AbortSignal.timeout(timeoutMs);
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = 45_000): Promise<T> {
  // No redirects: API keys travel in headers, and Node's fetch only drops Authorization on a cross-origin hop (R3-SEC-15).
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: requestSignal(timeoutMs),
    redirect: "error",
  });
  if (!res.ok) throw await upstreamError(url, res);
  return (await res.json()) as T;
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers, signal: requestSignal(30_000), redirect: "error" });
  if (!res.ok) throw await upstreamError(url, res);
  return (await res.json()) as T;
}

// ---------- Exa ----------

export const hasExa = () => isRealSecret(env.exaKey);

export async function exaSearch(
  query: string,
  opts: {
    numResults?: number;
    includeDomains?: string[];
    excludeDomains?: string[];
    startPublishedDate?: string;
    category?: string;
    maxCharacters?: number;
    type?: "auto" | "neural" | "keyword" | "fast";
  } = {},
): Promise<FoundDoc[]> {
  if (!env.exaKey) throw new Error("EXA_API_KEY is not set");
  type R = { results: { title: string | null; url: string; publishedDate?: string | null; author?: string | null; text?: string }[] };
  const r = await postJson<R>(
    "https://api.exa.ai/search",
    {
      query,
      type: opts.type ?? "auto",
      numResults: Math.min(opts.numResults ?? 8, 25),
      ...(opts.includeDomains?.length ? { includeDomains: opts.includeDomains } : {}),
      ...(opts.excludeDomains?.length ? { excludeDomains: opts.excludeDomains } : {}),
      ...(opts.startPublishedDate ? { startPublishedDate: opts.startPublishedDate } : {}),
      ...(opts.category ? { category: opts.category } : {}),
      contents: { text: { maxCharacters: opts.maxCharacters ?? 12_000 } },
    },
    { "x-api-key": env.exaKey },
    90_000,
  );
  return (r.results ?? []).map((x) => ({
    title: x.title ?? x.url,
    url: x.url,
    text: x.text ?? "",
    publishedAt: x.publishedDate ?? null,
    author: x.author ?? null,
  }));
}

export interface ExaContent {
  url: string;
  ok: boolean;
  title: string;
  text: string;
  publishedAt: string | null;
  error?: string;
}

/**
 * Page text for known URLs (Exa `/contents`). Exa renders JavaScript pages and extracts PDFs. A GitHub `blob` URL
 * comes back as a "Binary file" stub for PDFs, so callers should pass raw.githubusercontent.com URLs.
 */
export async function exaContents(
  urls: string[],
  opts: { maxCharacters?: number; livecrawl?: "never" | "fallback" | "preferred" | "always" } = {},
): Promise<ExaContent[]> {
  if (!env.exaKey) throw new Error("EXA_API_KEY is not set");
  if (!urls.length) return [];
  type R = {
    results?: { url: string; id?: string; title?: string | null; text?: string; publishedDate?: string | null }[];
    statuses?: { id: string; status: string; error?: { tag?: string; httpStatusCode?: number } }[];
  };
  const r = await postJson<R>(
    "https://api.exa.ai/contents",
    { urls, text: { maxCharacters: opts.maxCharacters ?? 200_000 }, ...(opts.livecrawl ? { livecrawl: opts.livecrawl } : {}) },
    { "x-api-key": env.exaKey },
    120_000,
  );
  const byUrl = new Map((r.results ?? []).map((x) => [x.id ?? x.url, x]));
  return urls.map((u) => {
    const status = r.statuses?.find((s) => s.id === u);
    const hit = byUrl.get(u) ?? (r.results ?? []).find((x) => x.url === u);
    const text = hit?.text ?? "";
    const stub = /^# .+\n\n- Branch: .+\n- Repository: .+\n\nBinary file \(/.test(text);
    return {
      url: u,
      ok: !!hit && status?.status !== "error" && !stub && text.length > 0,
      title: hit?.title ?? "",
      text: stub ? "" : text,
      publishedAt: hit?.publishedDate ?? null,
      ...(status?.status === "error" ? { error: status.error?.tag ?? "error" } : stub ? { error: "binary stub" } : {}),
    };
  });
}

// ---------- NewsAPI.ai (Event Registry) ----------

export const hasNews = () => isRealSecret(env.newsApiKey);

/** `eventUri` groups syndicated copies of one story (R3-SRC-10). */
export type NewsArticle = FoundDoc & { dataType: string; sourceUri?: string | null; eventUri?: string | null };

type ErArticle = {
  title: string;
  url: string;
  body?: string;
  dateTime?: string;
  date?: string;
  dataType?: string;
  source?: { title?: string; uri?: string };
  eventUri?: string | null;
};

function mapArticles(results: ErArticle[] | undefined): NewsArticle[] {
  return (results ?? []).map((a) => ({
    title: a.title,
    url: a.url,
    text: a.body ?? "",
    publishedAt: a.dateTime ?? a.date ?? null,
    source: a.source?.title ?? null,
    sourceUri: a.source?.uri ?? null,
    dataType: a.dataType ?? "news",
    eventUri: a.eventUri ?? null,
  }));
}

export async function newsSearch(
  keyword: string,
  opts: { dateStart?: string; count?: number; dataTypes?: ("news" | "pr" | "blog")[]; sortBy?: "date" | "rel" } = {},
): Promise<NewsArticle[]> {
  if (!env.newsApiKey) throw new Error("NEWSAPI_AI_KEY is not set");
  type R = { articles?: { results?: ErArticle[] } };
  const r = await postJson<R>("https://eventregistry.org/api/v1/article/getArticles", {
    action: "getArticles",
    keyword,
    keywordLoc: "body,title",
    lang: "eng",
    ...(opts.dateStart ? { dateStart: opts.dateStart } : {}),
    dataType: opts.dataTypes ?? ["news", "pr"],
    isDuplicateFilter: "skipDuplicates",
    resultType: "articles",
    articlesSortBy: opts.sortBy ?? "rel",
    articlesCount: Math.min(opts.count ?? 30, 100),
    includeArticleBody: true,
    includeArticleEventUri: true,
    articleBodyLen: -1,
    apiKey: env.newsApiKey,
  });
  return mapArticles(r.articles?.results);
}

/**
 * Event Registry complex query: any alias (as an exact phrase), co-occurring with any context term; relevance
 * sorted, news and press releases only (blogs are mostly SEO spam). Spam exclusion happens locally: a `$not`
 * clause made Event Registry return nothing.
 */
export async function newsQuery(opts: {
  aliases: string[];
  context?: string[];
  dateStart?: string;
  count?: number;
  dataTypes?: ("news" | "pr" | "blog")[];
}): Promise<NewsArticle[]> {
  if (!env.newsApiKey) throw new Error("NEWSAPI_AI_KEY is not set");
  const kw = (k: string, exact = false) => ({ keyword: k, keywordLoc: "body,title", ...(exact ? { keywordSearchMode: "exact" } : {}) });
  const and: Record<string, unknown>[] = [{ $or: opts.aliases.map((a) => kw(a, true)) }];
  if (opts.context?.length) and.push({ $or: opts.context.map((c) => kw(c)) });
  and.push({ lang: "eng", ...(opts.dateStart ? { dateStart: opts.dateStart } : {}) });
  const $query: Record<string, unknown> = { $and: and };
  type R = { articles?: { results?: ErArticle[] } };
  const r = await postJson<R>("https://eventregistry.org/api/v1/article/getArticles", {
    action: "getArticles",
    query: { $query, $filter: { dataType: opts.dataTypes ?? ["news", "pr"], isDuplicate: "skipDuplicates" } },
    resultType: "articles",
    articlesSortBy: "rel",
    articlesCount: Math.min(opts.count ?? 60, 100),
    includeArticleBody: true,
    includeArticleEventUri: true,
    articleBodyLen: -1,
    apiKey: env.newsApiKey,
  });
  return mapArticles(r.articles?.results);
}

// ---------- X API v2 ----------

export const hasX = () => isRealSecret(env.xBearer);
const X = "https://api.x.com/2";

export interface Post {
  id: string;
  text: string;
  createdAt: string;
  url: string;
  author?: string;
}

function xHeaders() {
  if (!env.xBearer) throw new Error("X_BEARER_TOKEN is not set");
  return { authorization: `Bearer ${env.xBearer}` };
}

export function normalizeHandle(h: string): string | null {
  const m = h.trim().match(/^(?:https?:\/\/(?:www\.)?(?:x|twitter)\.com\/)?@?([A-Za-z0-9_]{1,15})(?:[/?#].*)?$/);
  return m ? m[1]! : null;
}

/** A project's own posts (no replies or reposts), newest first. Long posts use their full note text. */
export interface XUser {
  id: string;
  username: string;
  name: string;
  description: string;
  /** Expanded links from the profile URL and bio. */
  urls: string[];
  followers?: number;
  verified?: boolean;
  /** "blue", "business", "government" or "none". */
  verifiedType?: string | null;
}

/** Profile lookup, used to verify that a handle really belongs to a project. Null when the account doesn't exist. */
export async function xUser(handle: string): Promise<XUser | null> {
  const h = normalizeHandle(handle);
  if (!h) return null;
  type U = {
    data?: {
      id: string;
      username: string;
      name: string;
      description?: string;
      url?: string;
      verified?: boolean;
      verified_type?: string;
      public_metrics?: { followers_count?: number };
      entities?: { url?: { urls?: { expanded_url?: string }[] }; description?: { urls?: { expanded_url?: string }[] } };
    };
  };
  const r = await getJson<U>(`${X}/users/by/username/${h}?user.fields=description,url,entities,public_metrics,verified,verified_type`, xHeaders());
  if (!r.data) return null;
  const e = r.data.entities;
  const urls = [...(e?.url?.urls ?? []), ...(e?.description?.urls ?? [])].map((u) => u.expanded_url ?? "").filter(Boolean);
  if (r.data.url) urls.push(r.data.url);
  return {
    id: r.data.id,
    username: r.data.username,
    name: r.data.name,
    description: r.data.description ?? "",
    urls,
    followers: r.data.public_metrics?.followers_count,
    verified: r.data.verified,
    verifiedType: r.data.verified_type ?? null,
  };
}

type UrlEntity = { start?: number; end?: number; url: string; expanded_url?: string; display_url?: string; media_key?: string };

/** Replaces t.co links with their targets; drops links to the post's own media. */
export function expandLinks(text: string, urls: UrlEntity[] | undefined): string {
  let out = text;
  for (const u of urls ?? []) {
    if (!u.url) continue;
    const target = u.expanded_url ?? "";
    const isMedia = !!u.media_key || /^https?:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+\/(photo|video)\//.test(target);
    out = out.split(u.url).join(isMedia ? "" : target || u.url);
  }
  return out.trim();
}

export async function xPosts(handle: string, opts: { max?: number; sinceIso?: string; sinceId?: string; userId?: string } = {}): Promise<Post[]> {
  const h = normalizeHandle(handle);
  if (!h) throw new Error(`Invalid X handle: ${handle}`);
  let userId = opts.userId;
  if (!userId) {
    const u = await getJson<{ data?: { id: string } }>(`${X}/users/by/username/${h}`, xHeaders());
    if (!u.data) throw new Error(`X user @${h} not found`);
    userId = u.data.id;
  }
  const out: Post[] = [];
  let token: string | undefined;
  const max = opts.max ?? 300;
  while (out.length < max) {
    const q = new URLSearchParams({ max_results: "100", exclude: "retweets,replies", "tweet.fields": "created_at,note_tweet,entities" });
    // since_id makes the fetch incremental; start_time bounds a first full read.
    if (opts.sinceId) q.set("since_id", opts.sinceId);
    else if (opts.sinceIso) q.set("start_time", opts.sinceIso);
    if (token) q.set("pagination_token", token);
    type R = {
      data?: {
        id: string;
        text: string;
        created_at: string;
        entities?: { urls?: UrlEntity[] };
        note_tweet?: { text: string; entities?: { urls?: UrlEntity[] } };
      }[];
      meta?: { next_token?: string };
    };
    const r = await getJson<R>(`${X}/users/${userId}/tweets?${q}`, xHeaders());
    for (const t of r.data ?? []) {
      const text = t.note_tweet ? expandLinks(t.note_tweet.text, t.note_tweet.entities?.urls) : expandLinks(t.text, t.entities?.urls);
      out.push({ id: t.id, text, createdAt: t.created_at, url: `https://x.com/${h}/status/${t.id}`, author: h });
    }
    token = r.meta?.next_token;
    if (!token || !r.data?.length) break;
  }
  return out.slice(0, max);
}

/** Recent public discussion (the last 7 days on most API tiers). */
export async function xSearch(query: string, max = 50): Promise<Post[]> {
  const q = new URLSearchParams({
    query: `${query} -is:retweet lang:en`,
    max_results: String(Math.min(Math.max(max, 10), 100)),
    "tweet.fields": "created_at,author_id,note_tweet,entities",
    expansions: "author_id",
    "user.fields": "username",
  });
  type R = {
    data?: {
      id: string;
      text: string;
      created_at: string;
      author_id: string;
      entities?: { urls?: UrlEntity[] };
      note_tweet?: { text: string; entities?: { urls?: UrlEntity[] } };
    }[];
    includes?: { users?: { id: string; username: string }[] };
  };
  const r = await getJson<R>(`${X}/tweets/search/recent?${q}`, xHeaders());
  const users = new Map((r.includes?.users ?? []).map((u) => [u.id, u.username]));
  return (r.data ?? []).map((t) => {
    const author = users.get(t.author_id) ?? "i";
    const text = t.note_tweet ? expandLinks(t.note_tweet.text, t.note_tweet.entities?.urls) : expandLinks(t.text, t.entities?.urls);
    return { id: t.id, text, createdAt: t.created_at, url: `https://x.com/${author}/status/${t.id}`, author };
  });
}

export function postsToMarkdown(posts: Post[]): string {
  return posts.map((p) => `[${p.createdAt.slice(0, 10)}] @${p.author}: ${p.text.replace(/\s+/g, " ").trim()} (${p.url})`).join("\n\n");
}
