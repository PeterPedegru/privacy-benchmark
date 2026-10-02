/**
 * Docs, website and blog lanes: a polite crawler with
 * - correct robots.txt (RFC 9309: wildcards, `$` anchors, longest match with Allow winning ties, `Sitemap:` lines),
 *   cached per origin as a promise (SRC-3, EFF-15), matched with a linear glob matcher (R3-SEC-2);
 * - scope that follows redirects and treats www and apex as one site (SRC-3);
 * - one pooled page budget across docs roots and a priority queue: security, governance, upgrade, key, fee and
 *   exit pages first; API reference, versioned copies, locales and legal pages last (SRC-4, R3-SRC-9);
 * - seeds from llms.txt, sitemaps declared in robots.txt and per-prefix sitemaps (SRC-3, SRC-4), parsed with
 *   linear scanners (R3-SEC-2);
 * - markdown twins and canonical links preferred, duplicates skipped by canonical key and content hash (SRC-13);
 * - retries with backoff for network errors, timeouts, 429 and 5xx (Retry-After honoured), a per-host concurrency
 *   limit shared by every lane, and failure counts in the lane note (R3-SRC-5);
 * - a deadline per lane (R3-SEC-8).
 */

import { sql } from "drizzle-orm";
import { query } from "../../db/index.ts";
import { env } from "../../env.ts";
import { exaSearch, hasExa } from "../../lib/externals.ts";
import { type ExtractedPage, extractHtmlAsync, fetchPage } from "../../lib/extract.ts";
import type { PageMeta } from "../../lib/extract-core.ts";
import { looksLikeHtml, markdownTitle } from "../../lib/extract-core.ts";
import { FetchAbortedError, FetchBlockedError, FetchTooLargeError, safeFetch, throwIfFetchAborted } from "../../lib/fetcher.ts";
import { LruCache } from "../../lib/lru.ts";
import { canonicalKey, docsRootOf, hostKey, hostOf, isLegalPath, isLegalTitle, isLocalePath, normalizeUrl, registrableDomain, sameSite } from "../classify.ts";
import { contentHash, purgeWhere, STALE } from "../kb-store.ts";
import { classify, counted, type LaneContext, type Progress, type ProjectRow, sleep, storeFor } from "./context.ts";

export const UA_TOKEN = "PrivacyBenchmarkBot";

// ---------- robots.txt ----------

export interface RobotsRule {
  allow: boolean;
  pattern: string;
  /** The pattern split on `*` (runs collapsed), and whether it ends with `$`. */
  parts: string[];
  anchored: boolean;
}

export interface Robots {
  rules: RobotsRule[];
  sitemaps: string[];
  crawlDelay: number | null;
}

const MAX_PATTERN = 512;
const MAX_RULES = 1000;
const MAX_MATCH_PATH = 2048;

/** A robots.txt path pattern compiled for `robotsPatternMatches`: `*` matches anything, a trailing `$` anchors. */
export function compileRobotsPattern(pattern: string): Pick<RobotsRule, "parts" | "anchored"> {
  let p = pattern.trim().slice(0, MAX_PATTERN);
  if (!p.startsWith("/") && !p.startsWith("*")) p = `/${p}`;
  const anchored = p.endsWith("$");
  if (anchored) p = p.slice(0, -1);
  // Runs of '*' are one wildcard; '$' anywhere but the end is a literal.
  return { parts: p.replace(/\*{2,}/g, "*").split("*"), anchored };
}

/**
 * Glob match from the start of the path, in linear time (R3-SEC-2): the first part is a prefix, each later part is
 * found leftmost with indexOf (leftmost is always optimal for `*`), and an anchored pattern's last part must end the
 * path. Replaces a regex whose `.*` runs backtracked exponentially on patterns like `/*a*a*a*a*a*b`.
 */
export function robotsPatternMatches(rule: Pick<RobotsRule, "parts" | "anchored">, pathAndQuery: string): boolean {
  const path = pathAndQuery.slice(0, MAX_MATCH_PATH);
  const parts = rule.parts;
  const first = parts[0] ?? "";
  if (parts.length === 1) return rule.anchored ? path === first : path.startsWith(first);
  if (!path.startsWith(first)) return false;
  let pos = first.length;
  const last = parts.length - 1;
  for (let i = 1; i < last; i++) {
    const part = parts[i]!;
    if (!part) continue;
    const at = path.indexOf(part, pos);
    if (at < 0) return false;
    pos = at + part.length;
  }
  const tail = parts[last]!;
  if (rule.anchored) return path.length - tail.length >= pos && path.endsWith(tail);
  return !tail || path.indexOf(tail, pos) >= 0;
}

/**
 * Parses robots.txt for our user agent: the groups naming our token if any, otherwise the `*` groups (RFC 9309
 * §2.2.1; groups for the same agent are merged). `Sitemap:` lines apply regardless of group.
 */
export function parseRobots(text: string, ua = UA_TOKEN): Robots {
  type Group = { agents: string[]; rules: { allow: boolean; pattern: string }[]; delay: number | null };
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  let ruleCount = 0;
  for (const raw of text.slice(0, 512 * 1024).split(/\r?\n/)) {
    const hash = raw.indexOf("#");
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (key === "sitemap") {
      if (/^https?:\/\//i.test(val) && sitemaps.length < 50) sitemaps.push(val);
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      // An empty Disallow allows everything; an empty Allow says nothing.
      if (val && ruleCount < MAX_RULES) {
        current.rules.push({ allow: key === "allow", pattern: val.slice(0, MAX_PATTERN) });
        ruleCount++;
      }
    } else if (key === "crawl-delay") {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }
  const token = ua.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && (a === token || token.startsWith(a))));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules).map((r) => ({ ...r, ...compileRobotsPattern(r.pattern) }));
  const delays = chosen.map((g) => g.delay).filter((d): d is number => d !== null);
  return { rules, sitemaps: [...new Set(sitemaps)], crawlDelay: delays.length ? Math.max(...delays) : null };
}

/** The longest matching rule decides; on a tie, Allow wins. No matching rule means allowed. */
export function robotsAllows(robots: Robots, pathAndQuery: string): boolean {
  let best: RobotsRule | null = null;
  for (const r of robots.rules) {
    if (!robotsPatternMatches(r, pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
  }
  return best ? best.allow : true;
}

const ALLOW_ALL: Robots = { rules: [], sitemaps: [], crawlDelay: null };
const DISALLOW_ALL: Robots = { rules: [{ allow: false, pattern: "/", parts: ["/"], anchored: false }], sitemaps: [], crawlDelay: null };
/** Bounded (R3-SEC-15): one entry per origin, oldest evicted first. */
const robotsCache = new LruCache<{ at: number; ttl: number; p: Promise<Robots> }>({ maxSize: 1000, maxEntries: 1000, sizeOf: () => 1 });

/** robots.txt for an origin, fetched once and shared by concurrent callers (the cache holds the promise). */
export function robotsFor(origin: string): Promise<Robots> {
  const hit = robotsCache.get(origin);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.p;
  const entry = { at: Date.now(), ttl: 3_600_000, p: Promise.resolve(ALLOW_ALL) };
  entry.p = (async () => {
    try {
      const res = await safeFetch(`${origin}/robots.txt`, { maxBytes: 512 * 1024, timeoutMs: 10_000 });
      if (res.status >= 500) {
        // RFC 9309: unreachable robots.txt means "assume disallowed"; retry soon.
        entry.ttl = 300_000;
        return DISALLOW_ALL;
      }
      if (res.status >= 400) return ALLOW_ALL;
      const text = res.body.toString("utf8");
      if (looksLikeHtml(text)) return ALLOW_ALL;
      return parseRobots(text);
    } catch {
      entry.ttl = 300_000;
      return ALLOW_ALL;
    }
  })();
  robotsCache.set(origin, entry);
  return entry.p;
}

export async function allowedByRobots(url: string): Promise<boolean> {
  const u = new URL(url);
  return robotsAllows(await robotsFor(u.origin), `${u.pathname}${u.search}`);
}

// ---------- sitemaps, feeds and llms.txt (linear scanners, R3-SEC-2) ----------

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

const unescapeXml = (s: string) => {
  let t = s.trim();
  if (t.startsWith("<![CDATA[") && t.endsWith("]]>")) t = t.slice(9, -3);
  return t
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
};

/**
 * The bodies of `<tag …>…</tag>` elements, found with indexOf. An element without its closing tag ends the scan, so
 * an unclosed `<url>` repeated a million times costs one pass, not a quadratic regex.
 */
export function xmlBlocks(xml: string, tag: string, limit = 50_000): string[] {
  const out: string[] = [];
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let i = 0;
  while (out.length < limit) {
    const s = xml.indexOf(open, i);
    if (s < 0) break;
    const next = xml.charCodeAt(s + open.length);
    // `<url>` or `<url xmlns…>`, not `<urlset>`.
    if (next !== 62 && next !== 32 && next !== 9 && next !== 10 && next !== 13 && next !== 47) {
      i = s + open.length;
      continue;
    }
    const gt = xml.indexOf(">", s + open.length);
    if (gt < 0) break;
    if (xml.charCodeAt(gt - 1) === 47) {
      // self-closing <tag/>: no body
      i = gt + 1;
      continue;
    }
    const e = xml.indexOf(close, gt + 1);
    if (e < 0) break;
    out.push(xml.slice(gt + 1, e));
    i = e + close.length;
  }
  return out;
}

/** The text of the first `<tag>…</tag>` inside a block (no attributes expected), or null. */
function xmlText(block: string, tag: string): string | null {
  const open = `<${tag}>`;
  const s = block.indexOf(open);
  if (s < 0) return null;
  const e = block.indexOf(`</${tag}>`, s + open.length);
  return e < 0 ? null : unescapeXml(block.slice(s + open.length, e));
}

/** Page entries (with lastmod) and nested sitemap locations of one sitemap file. */
export function parseSitemap(xml: string): { urls: SitemapEntry[]; sitemaps: string[] } {
  const urls: SitemapEntry[] = [];
  const sitemaps: string[] = [];
  for (const b of xmlBlocks(xml, "sitemap", 1000)) {
    const loc = xmlText(b, "loc");
    if (loc) sitemaps.push(loc);
  }
  for (const b of xmlBlocks(xml, "url")) {
    const loc = xmlText(b, "loc");
    if (loc) urls.push({ loc, lastmod: xmlText(b, "lastmod") });
  }
  return { urls, sitemaps };
}

/** Items of an RSS or Atom feed: link and date (R3-SRC-8). Linear. */
export function parseFeed(xml: string): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  for (const b of xmlBlocks(xml, "item", 500)) {
    const link = xmlText(b, "link") ?? xmlText(b, "guid");
    const date = xmlText(b, "pubDate") ?? xmlText(b, "dc:date") ?? xmlText(b, "published");
    if (link && /^https?:\/\//.test(link)) out.push({ loc: link, lastmod: isoDate(date) });
  }
  for (const b of xmlBlocks(xml, "entry", 500)) {
    // <link href="…"/> (rel="alternate" or none).
    let link: string | null = null;
    let i = 0;
    for (;;) {
      const s = b.indexOf("<link", i);
      if (s < 0) break;
      const gt = b.indexOf(">", s);
      if (gt < 0) break;
      const tagText = b.slice(s, gt);
      const href = tagText.match(/href\s{0,3}=\s{0,3}["']([^"']{1,2000})["']/)?.[1];
      if (href && (!/rel\s{0,3}=/.test(tagText) || /rel\s{0,3}=\s{0,3}["']alternate["']/.test(tagText))) {
        link = unescapeXml(href);
        break;
      }
      i = gt + 1;
    }
    const date = xmlText(b, "published") ?? xmlText(b, "updated");
    if (link && /^https?:\/\//.test(link)) out.push({ loc: link, lastmod: isoDate(date) });
  }
  return out;
}

function isoDate(s: string | null): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/** Bounded (R3-SEC-15): a sitemap set can hold 20,000 URLs, so few are kept. */
const sitemapCache = new LruCache<{ at: number; p: Promise<SitemapEntry[]> }>({ maxSize: 64, maxEntries: 64, sizeOf: () => 1 });

/**
 * All sitemap entries reachable from the given sitemap files (indexes are followed), cached for 10 minutes so the
 * docs, website and blog lanes share one read per host (EFF-15).
 */
export function sitemapEntries(seeds: string[], opts: { maxFiles?: number; maxUrls?: number } = {}): Promise<SitemapEntry[]> {
  const key = [...seeds].sort().join("|");
  const hit = sitemapCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.p;
  const p = (async () => {
    const seen = new Set<string>();
    const out: SitemapEntry[] = [];
    const queue = [...seeds];
    let files = 0;
    while (queue.length && files < (opts.maxFiles ?? 16) && out.length < (opts.maxUrls ?? 20_000)) {
      const sm = queue.shift()!;
      if (seen.has(sm) || /\.gz$/i.test(sm)) continue;
      seen.add(sm);
      files++;
      try {
        const res = await safeFetch(sm, { maxBytes: 20 * 1024 * 1024, timeoutMs: 20_000 });
        if (res.status >= 400) continue;
        const xml = res.body.toString("utf8");
        if (!xml.includes("<urlset") && !xml.includes("<sitemapindex")) continue;
        const parsed = parseSitemap(xml);
        queue.push(...parsed.sitemaps);
        out.push(...parsed.urls);
      } catch {
        // unreachable or oversize sitemap
      }
    }
    return out.slice(0, opts.maxUrls ?? 20_000);
  })();
  sitemapCache.set(key, { at: Date.now(), p });
  return p;
}

/** Characters that end a URL in running text. */
function urlEnd(text: string, from: number, max = 2048): number {
  let e = from;
  const stop = Math.min(text.length, from + max);
  while (e < stop) {
    const c = text.charCodeAt(e);
    // whitespace ) > ] " ' <
    if (c <= 32 || c === 41 || c === 62 || c === 93 || c === 34 || c === 39 || c === 60) break;
    e++;
  }
  return e;
}

/** Links in an llms.txt file (markdown links and bare URLs), resolved against the file's URL. Linear (R3-SEC-2). */
export function parseLlmsTxt(text: string, base: string): string[] {
  if (looksLikeHtml(text)) return [];
  const out = new Set<string>();
  const src = text.slice(0, 4 * 1024 * 1024);
  // Markdown links: "](target" or "](<target>".
  let i = 0;
  for (let n = 0; out.size < 20_000 && n < 40_000; n++) {
    const at = src.indexOf("](", i);
    if (at < 0) break;
    let s = at + 2;
    while (s < src.length && (src[s] === " " || src[s] === "\t")) s++;
    if (src[s] === "<") s++;
    const e = urlEnd(src, s);
    if (e > s) {
      try {
        out.add(new URL(src.slice(s, e), base).toString());
      } catch {
        // ignore
      }
    }
    i = Math.max(at + 2, e);
  }
  // Bare URLs not inside a link target.
  i = 0;
  for (let n = 0; out.size < 20_000 && n < 40_000; n++) {
    const at = src.indexOf("http", i);
    if (at < 0) break;
    i = at + 4;
    const prev = src[at - 1];
    if (prev === "(" || prev === "<" || (at > 0 && /[\w/]/.test(prev ?? ""))) continue;
    if (!src.startsWith("http://", at) && !src.startsWith("https://", at)) continue;
    const e = urlEnd(src, at);
    i = e;
    // Trailing punctuation belongs to the sentence, not the URL.
    let end = e;
    while (end > at && ".,;:".includes(src[end - 1]!)) end--;
    const u = src.slice(at, end);
    if (u.length > 10) out.add(u);
  }
  return [...out];
}

async function llmsLinks(origin: string, prefix: string, opts: { alsoRoot?: boolean } = {}): Promise<string[]> {
  const urls = [`${origin}${prefix}/llms.txt`];
  if (prefix && opts.alsoRoot !== false) urls.push(`${origin}/llms.txt`);
  const out: string[] = [];
  for (const u of urls) {
    try {
      const res = await safeFetch(u, { maxBytes: 4 * 1024 * 1024, timeoutMs: 15_000 });
      if (res.status >= 400 || /html/i.test(res.contentType)) continue;
      out.push(...parseLlmsTxt(res.body.toString("utf8"), res.url));
    } catch {
      // no llms.txt
    }
  }
  return out;
}

// ---------- priority ----------

/** Pages that answer custody, governance and risk questions. */
export const BOOST =
  /secur|audit|govern|upgrad|admin|pause|emergenc|multisig|council|veto|keys?\b|key-|custod|trust|risk|threat|fee|withdraw|exit|escape|forced|censor|address|deploy|contracts|faq|safety|bridge|complian|viewing|slash|sequenc|decentrali|incident|bug-?bount/i;
/** Pages about the privacy model itself. */
export const PRIVACY_BOOST =
  /privacy|private|shield|stealth|anonym|confidential|encrypt|decrypt|notes?\b|nullif|association|ragequit|unlink|kms|acl|threat-model|proof|circuit/i;
/**
 * Low-value pages: API reference (including generated `*-api` trees such as Aztec's `aztec-nr-api`), typedoc and
 * rustdoc output, release notes, versioned copies, legal (R3-SRC-9).
 */
export const PENALTY =
  /\/(api|api-references?|apis|api-docs|corelib|typedoc|rustdoc|changelog|release-notes|releases|tags?|sdk-reference|reference\/api|generated|[\w-]{1,60}-api|api-[\w-]{1,60})(\/|$)|\/v?\d+\.\d+(\.\d+)?(\/|$)|privacy-policy|terms|cookie|legal/i;
const MILD_PENALTY = /reference|\/next\/|\/unstable\/|\/nightly\/|\/archive[sd]?\/|\/deprecated\//i;

/** A path segment that marks a copy of the docs for another version or channel. */
const VERSION_SEGMENT = /^(v?\d+(\.\d+){1,2}(\.x)?|next|beta|unstable|nightly|canary|preview)$/i;

/**
 * The same page without its version or channel segment (`/next/reference/x` → `/reference/x`), when the path below
 * the root has one; used to skip copies whose current version is also published (R3-SRC-9). Pure.
 */
export function unversionedUrl(url: string, rootPrefix = ""): string | null {
  try {
    const u = new URL(url);
    const rel = rootPrefix && u.pathname.startsWith(rootPrefix) ? u.pathname.slice(rootPrefix.length) : u.pathname;
    const segs = rel.split("/");
    const i = segs.findIndex((s) => VERSION_SEGMENT.test(s));
    if (i < 0) return null;
    segs.splice(i, 1);
    u.pathname = `${rootPrefix}${segs.join("/")}` || "/";
    return u.toString();
  } catch {
    return null;
  }
}

/** A soft 404: a "Page not found" title or a /404 path served with status 200 (R3-SRC-9). */
export function isNotFoundPage(title: string, url: string): boolean {
  if (/^\s*(404\b|page not found|not found\b|page cannot be found|this page could not be found)/i.test(title)) return true;
  try {
    return /\/404(\.html?)?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export type SeedKind = "start" | "llms" | "sitemap" | "link";

/** Crawl priority of a URL (higher first). Pure, so it can be tested. */
export function urlPriority(url: string, opts: { seed?: SeedKind; depth?: number } = {}): number {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return -100;
  }
  let p = 0;
  if (BOOST.test(path)) p += 10;
  if (PRIVACY_BOOST.test(path)) p += 6;
  if (PENALTY.test(path)) p -= 15;
  else if (MILD_PENALTY.test(path)) p -= 6;
  if (isLocalePath(path)) p -= 30;
  if (isLegalPath(path)) p -= 30;
  p -= path.split("/").filter(Boolean).length;
  p -= Math.min(6, (opts.depth ?? 0) * 0.5);
  if (opts.seed === "start") p += 40;
  else if (opts.seed === "llms") p += 4;
  return p;
}

// ---------- fetching: per-host limit and retries (R3-SRC-5) ----------

/** Concurrent fetches per host across every lane (the website and blog lanes share a host). */
export const HOST_CONCURRENCY = 4;
const hostGates = new Map<string, { active: number; waiters: (() => void)[] }>();
/** Hosts that answered 429: one fetch at a time, and nothing before `until` (kept 10 minutes). */
const throttles = new LruCache<{ until: number; at: number }>({ maxSize: 2000, maxEntries: 2000, sizeOf: () => 1 });
const THROTTLE_MEMORY_MS = 600_000;

function throttleOf(host: string): { until: number; at: number } | null {
  const t = throttles.get(host);
  if (!t) return null;
  if (Date.now() - t.at > THROTTLE_MEMORY_MS) {
    throttles.delete(host);
    return null;
  }
  return t;
}

/** The host rate-limited us: drop to one fetch at a time and pause for Retry-After (at least 5 s, at most 60 s). */
export function throttleHost(url: string, retryAfterMs?: number | null, minPauseMs = 5000): void {
  const host = hostOf(url);
  if (!host) return;
  const pause = Math.min(60_000, Math.max(minPauseMs, retryAfterMs ?? 0));
  const prev = throttleOf(host);
  throttles.set(host, { until: Math.max(prev?.until ?? 0, Date.now() + pause), at: Date.now() });
}

/** Runs `fn` holding one of the host's fetch slots (one slot while the host is throttled). */
export async function withHostSlot<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const host = hostOf(url) ?? "?";
  let g = hostGates.get(host);
  if (!g) {
    g = { active: 0, waiters: [] };
    hostGates.set(host, g);
  }
  const limit = () => (throttleOf(host) ? 1 : HOST_CONCURRENCY);
  if (g.active < limit()) g.active++;
  // A released slot is handed over with `active` already counted for the waiter.
  else await new Promise<void>((r) => g!.waiters.push(r));
  try {
    const wait = (throttleOf(host)?.until ?? 0) - Date.now();
    if (wait > 0) await sleep(wait);
    return await fn();
  } finally {
    g.active--;
    while (g.waiters.length && g.active < limit()) {
      g.active++;
      g.waiters.shift()!();
    }
    if (!g.active && !g.waiters.length) hostGates.delete(host);
  }
}

/** Errors worth another try: network failures and timeouts, not policy refusals, oversize bodies or a cancel. */
function retryableError(e: unknown): boolean {
  return (
    !(e instanceof FetchBlockedError) &&
    !(e instanceof FetchTooLargeError) &&
    !(e instanceof FetchAbortedError) &&
    !/invalid url/i.test((e as Error)?.message ?? "")
  );
}

export const retryableStatus = (status: number) => status === 429 || status === 408 || status >= 500;

/** Backoff before attempt `n` (1-based): Retry-After when the server sent one (capped at 30 s), else 2 s, 6 s. */
export function backoffMs(attempt: number, retryAfterMs?: number | null): number {
  if (retryAfterMs !== null && retryAfterMs !== undefined && retryAfterMs >= 0) return Math.min(30_000, Math.max(500, retryAfterMs));
  return 2000 * 3 ** (attempt - 1);
}

export interface FetchStats {
  /** Fetches made (retries included). */
  attempts: number;
  /** Pages that still failed after their retries (network, timeout, 429, 5xx). */
  failed: number;
  /** Retries made. */
  retried: number;
  /** URLs that failed for good, so their stored rows can be kept for this run. */
  failedUrls: string[];
  /** Why pages failed for good ("HTTP 429", "timeout", "network"), counted. */
  reasons?: Record<string, number>;
  /** The lane stopped at its deadline. */
  timedOut?: boolean;
}

export const emptyStats = (): FetchStats => ({ attempts: 0, failed: 0, retried: 0, failedUrls: [], reasons: {} });

/** A short reason for a transient failure. */
export function failureReason(status: number | null, e?: unknown): string {
  if (status !== null) return `HTTP ${status}`;
  const msg = `${(e as Error)?.name ?? ""} ${(e as Error)?.message ?? ""}`;
  return /abort|timeout|timed out/i.test(msg) ? "timeout" : "network";
}

function noteFailure(stats: FetchStats, url: string, reason: string) {
  stats.failed++;
  stats.failedUrls.push(url);
  stats.reasons = stats.reasons ?? {};
  stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
}

/** A lane note fragment, and whether the lane should count as partial (over 10% of pages failed). */
export function describeFetchStats(s: FetchStats): { note: string; partial: boolean } {
  const pages = s.attempts - s.retried;
  const partial = s.timedOut === true || (pages > 0 && s.failed / pages > 0.1);
  const why = Object.entries(s.reasons ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([r, n]) => `${n}× ${r}`)
    .join(", ");
  const bits = [
    s.failed ? `${s.failed} fetch failures${why ? ` (${why})` : ""}` : "",
    s.retried ? `${s.retried} retries` : "",
    s.timedOut ? "stopped at the lane deadline" : "",
  ].filter(Boolean);
  return { note: bits.join(", "), partial };
}

/** fetchPage with the host slot and up to two retries on transient failures. */
export async function fetchWithRetry(url: string, stats: FetchStats, opts: Parameters<typeof fetchPage>[1] = {}): Promise<ExtractedPage | null> {
  let reason = "network";
  for (let attempt = 1; attempt <= 3; attempt++) {
    // A stopped refresh fails here, between pages, instead of fetching on (R4-17).
    throwIfFetchAborted();
    stats.attempts++;
    let page: ExtractedPage | null = null;
    let wait: number | null = null;
    try {
      page = await withHostSlot(url, () => fetchPage(url, opts));
      if (!retryableStatus(page.status)) return page;
      wait = page.retryAfterMs ?? null;
      reason = failureReason(page.status);
      if (page.status === 429 || (wait ?? 0) > 0) throttleHost(url, wait);
    } catch (e) {
      if (e instanceof FetchAbortedError) throw e;
      if (!retryableError(e)) return null;
      reason = failureReason(null, e);
    }
    if (attempt === 3) break;
    stats.retried++;
    await sleep(backoffMs(attempt, wait));
  }
  noteFailure(stats, url, reason);
  return null;
}

// ---------- crawler ----------

/** Files that are never pages. PDFs are read by the audits lane; llms.txt is read as a seed list. */
export const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|json|xml|zip|gz|tar|tgz|mp4|mp3|webm|woff2?|ttf|otf|eot|pdf|txt|csv|wasm|bin|sh|py)$/i;

export interface CrawlRoot {
  url: string;
  /** Host without "www.". */
  host: string;
  /** Path prefix, "" for the whole host. */
  prefix: string;
}

export interface CrawlPage {
  url: string;
  title: string;
  markdown: string;
  root: CrawlRoot;
  via?: string;
  lastmod?: string | null;
}

export interface CrawlOptions {
  maxPages: number;
  /** Stores a page; false when it wasn't stored (a duplicate, out of scope). */
  onPage: (p: CrawlPage) => boolean | undefined | Promise<boolean | undefined>;
  progress?: Progress;
  /** Scopes the crawl must not enter (the website lane excludes docs roots). */
  exclude?: { host: string; prefix: string }[];
  /** Extra path filter (the website lane leaves blog posts to the blog lane). */
  skipPath?: (pathname: string) => boolean;
  /** Seed from llms.txt (default true). */
  llms?: boolean;
  concurrency?: number;
  label?: string;
  /** Stop starting new fetches after this time (epoch ms). */
  deadline?: number;
}

export interface CrawlResult {
  stored: number;
  perRoot: Record<string, number>;
  stats: FetchStats;
  /** Versioned or pre-release copies skipped because the current page is published too. */
  skippedCopies: number;
}

const underPrefix = (path: string, prefix: string) => !prefix || path === prefix || path.startsWith(`${prefix}/`);

/** The URL a page is stored under: normalized, with a markdown twin's ".md" removed. */
export function storageUrl(url: string): string {
  const n = normalizeUrl(url) ?? url;
  const stripped = n.replace(/\/index\.md$/i, "/").replace(/\.md$/i, "");
  return normalizeUrl(stripped) ?? stripped;
}

/** Crawls several roots with one pooled budget and one priority queue. Returns pages stored per root and fetch statistics. */
export async function crawlRoots(roots: CrawlRoot[], opts: CrawlOptions): Promise<CrawlResult> {
  const perRoot: Record<string, number> = {};
  const stats = emptyStats();
  if (!roots.length) return { stored: 0, perRoot, stats, skippedCopies: 0 };
  const rootKey = (r: CrawlRoot) => `${r.host}${r.prefix}`;
  const findRoot = (u: URL): CrawlRoot | null => {
    const host = hostKey(u.hostname);
    let best: CrawlRoot | null = null;
    for (const r of roots) if (r.host === host && underPrefix(u.pathname, r.prefix) && (!best || r.prefix.length > best.prefix.length)) best = r;
    return best;
  };
  const inScope = (raw: string): { url: string; root: CrawlRoot } | null => {
    const n = normalizeUrl(raw);
    if (!n) return null;
    const u = new URL(n);
    const root = findRoot(u);
    if (!root) return null;
    const path = u.pathname;
    if (SKIP_EXT.test(path)) return null;
    const rel = root.prefix ? path.slice(root.prefix.length) || "/" : path;
    if (isLocalePath(rel) || isLegalPath(path)) return null;
    if (opts.exclude?.some((e) => e.host === hostKey(u.hostname) && underPrefix(path, e.prefix))) return null;
    if (opts.skipPath?.(path)) return null;
    return { url: n, root };
  };
  type Item = { url: string; root: CrawlRoot; prio: number; depth: number; attempt: number; notBefore: number };
  const queue: Item[] = [];
  const seen = new Set<string>();
  const storedKeys = new Set<string>();
  const hashes = new Set<string>();
  const push = (raw: string, seed: SeedKind, depth: number) => {
    const s = inScope(raw);
    if (!s) return;
    const key = canonicalKey(s.url);
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ url: s.url, root: s.root, prio: urlPriority(s.url, { seed, depth }), depth, attempt: 1, notBefore: 0 });
  };
  // Seeds: start URLs, llms.txt, robots-declared and conventional sitemaps.
  for (const r of roots) push(r.url, "start", 0);
  const origins = new Map<string, CrawlRoot[]>();
  for (const r of roots) {
    const origin = new URL(r.url).origin;
    origins.set(origin, [...(origins.get(origin) ?? []), r]);
  }
  await Promise.all(
    [...origins.entries()].map(async ([origin, rs]) => {
      if (opts.llms !== false) for (const r of rs) for (const l of await llmsLinks(origin, r.prefix)) push(l, "llms", 1);
      const robots = await robotsFor(origin);
      const seeds = new Set([...robots.sitemaps, `${origin}/sitemap.xml`, `${origin}/sitemap-index.xml`, `${origin}/sitemap_index.xml`]);
      for (const r of rs) if (r.prefix) seeds.add(`${origin}${r.prefix}/sitemap.xml`);
      for (const e of await sitemapEntries([...seeds], { maxUrls: opts.maxPages * 25 })) push(e.loc, "sitemap", 1);
    }),
  );
  let stored = 0;
  let active = 0;
  let skippedCopies = 0;
  // Low-value pages (API reference, versioned copies, changelogs) never take more than a slice of the budget, even
  // when nothing better is queued: STRK20's docs host would otherwise fill up with Cairo corelib reference.
  const strongCap = Math.max(10, Math.floor(opts.maxPages * 0.1));
  const mildCap = Math.max(20, Math.floor(opts.maxPages * 0.25));
  let strongStored = 0;
  let mildStored = 0;
  // Pages being fetched or stored hold a slot (workers run concurrently), so no cap is overshot.
  let strongInFlight = 0;
  let mildInFlight = 0;
  let storing = 0;
  const lowValue = (item: Item): "strong" | "mild" | null => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(item.url).pathname);
    } catch {
      return null;
    }
    const rel = item.root.prefix ? path.slice(item.root.prefix.length) : path;
    // A root that is itself a versioned path (docs.x.org/v2) doesn't make its own pages low-value.
    const versionedRoot = /\/v?\d+\.\d+(\.\d+)?(\/|$)/.test(new URL(item.root.url).pathname);
    if (PENALTY.test(versionedRoot ? rel.replace(/\/v?\d+\.\d+(\.\d+)?(?=\/|$)/g, "") : rel)) return "strong";
    if (MILD_PENALTY.test(rel)) return "mild";
    return null;
  };
  const pop = (): Item | undefined => {
    if (!queue.length) return undefined;
    const now = Date.now();
    let bi = -1;
    let bp = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < queue.length; i++) {
      const it = queue[i]!;
      if (it.notBefore > now) continue;
      // Fairness: every root gets its first pages before a big root takes the whole pool.
      const p = it.prio + ((perRoot[rootKey(it.root)] ?? 0) < 15 ? 8 : 0);
      if (p > bp) {
        bp = p;
        bi = i;
      }
    }
    return bi < 0 ? undefined : queue.splice(bi, 1)[0];
  };
  // Multi-space docs hosts (GitBook) publish a sitemap and llms.txt per section (/protocol/sitemap.xml) that the
  // root sitemap doesn't list. The first sections linked from the top pages are probed for both.
  const probed = new Set<string>();
  const probeSections = async (root: CrawlRoot, links: string[]) => {
    if (root.prefix) return;
    const origin = new URL(root.url).origin;
    const segs: string[] = [];
    for (const l of links) {
      try {
        const u = new URL(l);
        if (hostKey(u.hostname) !== root.host) continue;
        const s = u.pathname.split("/").filter(Boolean)[0];
        if (s && !/\.\w{2,4}$/.test(s) && !probed.has(`${root.host}/${s}`) && !segs.includes(s)) segs.push(s);
      } catch {
        // ignore
      }
    }
    for (const s of segs) {
      if ([...probed].filter((p) => p.startsWith(`${root.host}/`)).length >= 8) break;
      probed.add(`${root.host}/${s}`);
      for (const l of await llmsLinks(origin, `/${s}`, { alsoRoot: false })) push(l, "llms", 1);
      for (const e of await sitemapEntries([`${origin}/${s}/sitemap.xml`], { maxUrls: opts.maxPages * 10 })) push(e.loc, "sitemap", 1);
    }
  };
  const expand = (page: ExtractedPage, depth: number) => {
    const alternates = new Set(page.meta.alternates ?? []);
    for (const l of page.meta.links) if (!alternates.has(l.href)) push(l.href, "link", depth + 1);
    if (page.via === "markdown") for (const l of parseLlmsTxt(page.markdown, page.url)) push(l, "link", depth + 1);
  };
  const delays = new Map<string, number>();
  const worker = async () => {
    while (stored < opts.maxPages) {
      throwIfFetchAborted();
      if (opts.deadline && Date.now() > opts.deadline) {
        stats.timedOut = true;
        return;
      }
      const item = pop();
      if (!item) {
        if (!active && !queue.length) return;
        await sleep(100);
        continue;
      }
      const lv = lowValue(item);
      if ((lv === "strong" && strongStored >= strongCap) || (lv === "mild" && mildStored >= mildCap)) continue;
      // Full only if the pages in flight are stored: try again shortly.
      if ((lv === "strong" && strongStored + strongInFlight >= strongCap) || (lv === "mild" && mildStored + mildInFlight >= mildCap)) {
        queue.push({ ...item, notBefore: Date.now() + 250 });
        continue;
      }
      // A versioned or pre-release copy whose current page is published too (Miden's /next and /0.1x trees).
      const current = unversionedUrl(item.url, item.root.prefix);
      if (current && seen.has(canonicalKey(current))) {
        skippedCopies++;
        continue;
      }
      active++;
      if (lv === "strong") strongInFlight++;
      else if (lv === "mild") mildInFlight++;
      try {
        if (!(await allowedByRobots(item.url))) continue;
        stats.attempts++;
        let page: ExtractedPage | null = null;
        let failure: number | null | undefined;
        let reason = "";
        try {
          page = await withHostSlot(item.url, () => fetchPage(item.url));
          if (retryableStatus(page.status)) {
            failure = page.retryAfterMs ?? null;
            reason = failureReason(page.status);
            // Rate limited: the whole host slows down, not just this page (R3-SRC-5).
            if (page.status === 429 || (failure ?? 0) > 0) throttleHost(item.url, failure);
          }
        } catch (e) {
          if (!retryableError(e)) continue;
          failure = null;
          reason = failureReason(null, e);
        }
        if (failure !== undefined) {
          // Transient failure: back in the queue, up to two more tries (R3-SRC-5).
          if (item.attempt < 3) {
            stats.retried++;
            queue.push({ ...item, attempt: item.attempt + 1, notBefore: Date.now() + backoffMs(item.attempt, failure) });
          } else noteFailure(stats, storageUrl(item.url), reason);
          continue;
        }
        if (!page || page.status >= 400 || page.markdown.trim().length < 80 || isLegalTitle(page.title) || isNotFoundPage(page.title, page.url)) continue;
        // Scope follows the final URL: a redirect off the root drops the page.
        const final = inScope(page.url);
        if (!final) continue;
        let target = storageUrl(final.url);
        if (page.canonical) {
          const c = inScope(page.canonical);
          if (c) target = storageUrl(c.url);
        }
        const key = canonicalKey(target);
        seen.add(canonicalKey(final.url));
        if (storedKeys.has(key)) continue;
        const h = contentHash(page.markdown);
        if (hashes.has(h)) continue;
        storedKeys.add(key);
        hashes.add(h);
        const title = page.via === "markdown" && /^https?:/.test(page.title) ? (markdownTitle(page.markdown) ?? page.title) : page.title;
        if (stored + storing >= opts.maxPages) break;
        storing++;
        let accepted: boolean | undefined;
        try {
          accepted = await opts.onPage({ url: target, title, markdown: page.markdown, root: final.root, via: page.via });
        } finally {
          storing--;
        }
        // A page rejected as a duplicate of a stored row still links to the rest of the site (R3-SRC-14).
        expand(page, item.depth);
        if (accepted === false) continue;
        stored++;
        if (lv === "strong") strongStored++;
        else if (lv === "mild") mildStored++;
        perRoot[rootKey(final.root)] = (perRoot[rootKey(final.root)] ?? 0) + 1;
        if (item.depth <= 1 && opts.llms !== false)
          await probeSections(
            final.root,
            page.meta.links.map((l) => l.href),
          );
        if (stored % 25 === 0) opts.progress?.(`${opts.label ?? "crawl"}: ${stored} pages`);
      } finally {
        active--;
        if (lv === "strong") strongInFlight--;
        else if (lv === "mild") mildInFlight--;
      }
      const origin = new URL(item.url).origin;
      if (!delays.has(origin)) delays.set(origin, Math.min(2000, ((await robotsFor(origin)).crawlDelay ?? 0) * 1000));
      await sleep(Math.max(150, delays.get(origin) ?? 0));
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
  return { stored, perRoot, stats, skippedCopies };
}

/** Crawls one site section (same site, optional path prefix). Kept for callers of the old API. */
export async function crawl(
  start: string,
  opts: { maxPages: number; pathPrefix?: string; onPage: (p: { url: string; title: string; markdown: string }) => void | Promise<void>; progress?: Progress },
): Promise<number> {
  const u = new URL(start);
  const r = await crawlRoots([{ url: start, host: hostKey(u.hostname), prefix: (opts.pathPrefix ?? "").replace(/\/+$/, "") }], {
    maxPages: opts.maxPages,
    progress: opts.progress,
    onPage: async (p) => {
      await opts.onPage({ url: p.url, title: p.title, markdown: p.markdown });
      return true;
    },
  });
  return r.stored;
}

// ---------- site probe and docs roots ----------

export interface SiteProbe {
  url: string;
  finalUrl: string;
  status: number;
  meta: PageMeta;
}

/**
 * Fetches a homepage once (redirects followed) for its final URL and links; shared by every lane that needs it. The
 * HTML is parsed in the extraction worker, never on the main thread (R3-SEC-3).
 */
export async function probeSite(url: string): Promise<SiteProbe | null> {
  try {
    const res = await safeFetch(url, { timeoutMs: 20_000 });
    const html = res.body.toString("utf8");
    const r = await extractHtmlAsync(html, res.url, { readability: false });
    return { url, finalUrl: res.url, status: res.status, meta: r.meta };
  } catch {
    return null;
  }
}

const DOCS_HOST_RE = /^(docs|doc|developers?|dev|learn|wiki|guide|guides|book|handbook|specs?)\./;
const HOSTED_DOCS = /(^|\.)(gitbook\.io|mintlify\.app|readme\.io|notion\.site|docs\.rs)$/;
const DOCS_PATH = /^\/(docs|documentation|developers|developer|learn|wiki)(\/|$)/;

function tokensOf(project: ProjectRow): string[] {
  return `${project.name} ${project.slug}`
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

/** A docs root from a resolved docs URL: a docs host covers the whole host, a website path keeps its first segment. */
export function rootFromFinalUrl(finalUrl: string, siteHost: string): CrawlRoot | null {
  try {
    const u = new URL(finalUrl);
    const host = hostKey(u.hostname);
    if (host === hostKey(siteHost)) {
      const seg = u.pathname.split("/").filter(Boolean)[0];
      if (!seg) return null;
      return { url: `${u.origin}/${seg}`, host, prefix: `/${seg}` };
    }
    return { url: `${u.origin}/`, host, prefix: "" };
  } catch {
    return null;
  }
}

async function probeDocs(candidate: string): Promise<string | null> {
  try {
    const page = await fetchPage(candidate, { preferMarkdown: false });
    if (page.status < 400 && page.markdown.length >= 200) return page.url;
  } catch {
    // not there
  }
  return null;
}

/**
 * Docs roots: an editor's `docsRoots` setting wins outright. Otherwise the docs URL, docs hosts linked from the
 * homepage on the project's own domains, and always a probe of `docs.<apex>`; website paths such as /docs count
 * only when no docs host exists (SRC-4).
 */
export async function discoverDocsRoots(project: ProjectRow, site?: SiteProbe | null): Promise<CrawlRoot[]> {
  const configured = (project.docsRoots ?? []).filter((r) => r?.url);
  if (configured.length) {
    const out: CrawlRoot[] = [];
    for (const r of configured) {
      try {
        const u = new URL(r.url);
        const host = hostKey(u.hostname);
        const prefix = (r.prefix ?? (DOCS_HOST_RE.test(host) && u.pathname === "/" ? "" : u.pathname)).replace(/\/+$/, "");
        out.push({ url: r.url, host, prefix });
      } catch {
        // invalid entry
      }
    }
    if (project.docsUrl && !out.some((r) => sameSite(r.url, project.docsUrl!))) {
      const fin = (await probeDocs(project.docsUrl)) ?? project.docsUrl;
      const r = rootFromFinalUrl(fin, "");
      if (r) out.push(r);
    }
    return dedupeRoots(out);
  }
  const probe = site === undefined ? await probeSite(project.websiteUrl) : site;
  const siteHost = hostOf(probe?.finalUrl ?? project.websiteUrl) ?? "";
  const apex = registrableDomain(siteHost);
  const tokens = tokensOf(project);
  const hostRoots: CrawlRoot[] = [];
  const pathRoots: CrawlRoot[] = [];
  const addResolved = (finalUrl: string) => {
    const r = rootFromFinalUrl(finalUrl, siteHost);
    if (!r) return;
    (r.prefix && r.host === hostKey(siteHost) ? pathRoots : hostRoots).push(r);
  };
  if (project.docsUrl) {
    const fin = await probeDocs(project.docsUrl);
    if (fin) {
      const u = new URL(fin);
      // An explicit docs URL on the website host keeps its whole path as the scope.
      if (hostKey(u.hostname) === hostKey(siteHost) && u.pathname.length > 1) {
        hostRoots.push({ url: fin, host: hostKey(u.hostname), prefix: u.pathname.replace(/\/+$/, "") });
      } else addResolved(fin);
    }
  }
  const linked = new Set<string>();
  for (const l of probe?.meta.links ?? []) {
    try {
      const u = new URL(l.href);
      const host = hostKey(u.hostname);
      const owned = registrableDomain(host) === apex;
      const hosted = HOSTED_DOCS.test(host) && tokens.some((t) => `${host}${u.pathname}`.toLowerCase().includes(t));
      if ((owned && DOCS_HOST_RE.test(host)) || hosted) linked.add(hosted ? `${u.origin}${u.pathname.split("/").slice(0, 2).join("/")}` : `${u.origin}/`);
      else if (owned && host === hostKey(siteHost) && DOCS_PATH.test(u.pathname)) linked.add(`${u.origin}/${u.pathname.split("/")[1]}`);
    } catch {
      // ignore
    }
  }
  const probes = new Set<string>([`https://docs.${apex}`, ...linked]);
  const results = await Promise.all([...probes].map(async (c) => ({ c, fin: await probeDocs(c) })));
  for (const { fin } of results) if (fin) addResolved(fin);
  if (!hostRoots.length && !pathRoots.length) {
    for (const c of [
      `https://developers.${apex}`,
      `https://learn.${apex}`,
      `https://wiki.${apex}`,
      `${probe ? new URL(probe.finalUrl).origin : `https://${siteHost}`}/docs`,
    ]) {
      const fin = await probeDocs(c);
      if (fin) {
        addResolved(fin);
        break;
      }
    }
  }
  // Path roots on the website host count only when there's no docs host (aztec.network/developers is a landing page).
  const chosen = hostRoots.some((r) => r.host !== hostKey(siteHost)) ? hostRoots : [...hostRoots, ...pathRoots];
  return dedupeRoots(chosen).slice(0, 5);
}

/** Removes duplicate roots and roots nested inside another root. */
export function dedupeRoots(roots: CrawlRoot[]): CrawlRoot[] {
  const out: CrawlRoot[] = [];
  for (const r of [...roots].sort((a, b) => a.prefix.length - b.prefix.length)) {
    if (out.some((o) => o.host === r.host && underPrefix(r.prefix || "/", o.prefix))) continue;
    out.push(r);
  }
  return out;
}

// ---------- lanes ----------

export interface LaneResult {
  count: number;
  stats: FetchStats;
}

/** Docs lane: crawls every docs root with one pooled budget; every page is official documentation. */
export async function ingestDocs(
  ctx: LaneContext,
  roots: CrawlRoot[],
  opts: { deadline?: number } = {},
): Promise<{ count: number; perRoot: Record<string, number>; stats: FetchStats; skippedCopies: number }> {
  let count = 0;
  const r = await crawlRoots(roots, {
    maxPages: env.kb.maxDocsPages,
    progress: ctx.log,
    label: "docs",
    deadline: opts.deadline,
    onPage: async (p) => {
      const c = classify(ctx, p.url, "docs");
      // Pages under a docs root are official docs whatever their path looks like.
      const { status } = await storeFor(ctx, "docs", "docs", {
        url: p.url,
        title: p.title,
        kind: "docs",
        sourceClass: "official_docs",
        content: p.markdown,
        meta: { root: p.root.url, ...(p.via === "markdown" ? { format: "markdown" } : {}), ...(c.docsRoot ? {} : { outsideRegistry: true }) },
      });
      if (counted(status)) count++;
      return counted(status);
    },
  });
  return { count, perRoot: r.perRoot, stats: r.stats, skippedCopies: r.skippedCopies };
}

const BLOG_PATH = /(^|\/)(blog|blogs|news|posts?|announcements?|updates?|articles?|insights|stories|newsroom)(\/|$)/i;
/** Website pages shorter than this are shells (a JS app's homepage, a video stub), not content (R3-SRC-14). */
export const MIN_SITE_CHARS = 300;

/** Website lane: the project's site minus its docs roots, locales, legal pages and blog posts (the blog lane reads those). */
export async function ingestWebsite(ctx: LaneContext, docsRoots: CrawlRoot[], site: SiteProbe | null, opts: { deadline?: number } = {}): Promise<LaneResult> {
  const start = site?.finalUrl ?? ctx.project.websiteUrl;
  const u = new URL(start);
  let count = 0;
  // Shells stored by earlier runs (an 80-character homepage) go, even when this run finds nothing new.
  await purgeWhere(ctx.db, ctx.project.id, sql`meta->>'lane' = 'website' AND coalesce(content_len, 0) < ${MIN_SITE_CHARS}`);
  const r = await crawlRoots([{ url: start, host: hostKey(u.hostname), prefix: "" }], {
    maxPages: env.kb.maxSitePages,
    progress: ctx.log,
    label: "website",
    llms: false,
    deadline: opts.deadline,
    exclude: docsRoots.map((d) => ({ host: d.host, prefix: d.prefix })),
    skipPath: (p) => BLOG_PATH.test(p) && p.split("/").filter(Boolean).length > 1,
    onPage: async (p) => {
      if (p.markdown.trim().length < MIN_SITE_CHARS) return false;
      const c = classify(ctx, p.url, "website", { title: p.title });
      if (c.drop || c.docsRoot) return false;
      const { status } = await storeFor(ctx, "website", "website", {
        url: p.url,
        title: p.title,
        kind: c.owner === "project" ? c.kind : "website",
        sourceClass: c.owner === "project" ? c.sourceClass : "marketing",
        content: p.markdown,
      });
      if (counted(status)) count++;
      return counted(status);
    },
  });
  if (count < 3 && hasExa()) {
    ctx.log("Website renders client-side; reading it through Exa");
    count += await siteViaExa(ctx, env.kb.maxSitePages);
  }
  return { count, stats: r.stats };
}

/** Pages of a JavaScript-rendered site, read through Exa. Only the website host itself; docs roots belong to the docs lane. */
export async function siteViaExa(ctx: LaneContext, limit: number): Promise<number> {
  const siteHost = hostOf(ctx.project.websiteUrl) ?? "";
  const results = await exaSearch(`${ctx.project.name} overview, features, how it works, security, governance, fees`, {
    includeDomains: [registrableDomain(siteHost)],
    numResults: Math.min(limit, 25),
    maxCharacters: 60_000,
  });
  let n = 0;
  for (const d of results) {
    if (!d.text || d.text.trim().length < MIN_SITE_CHARS) continue;
    const url = normalizeUrl(d.url, { keepQuery: true });
    if (!url || !ctx.registry.siteHosts.some((h) => sameSite(h, url))) continue;
    if (docsRootOf(ctx.registry, url)) continue;
    const c = classify(ctx, url, "website", { title: d.title });
    if (c.drop || c.docsRoot) continue;
    const { status } = await storeFor(ctx, "website", "website", {
      url,
      title: d.title || url,
      kind: c.kind,
      sourceClass: c.sourceClass,
      content: d.text,
      date: d.publishedAt?.slice(0, 10) ?? null,
      meta: { via: "exa" },
    });
    if (counted(status)) n++;
  }
  return n;
}

/** Posts about incidents, vulnerabilities, upgrades and governance: always ranked first (R3-SRC-8). */
export const BLOG_SECURITY = /vulnerab|incident|post-?mortem|exploit|hack|disclos|secur|audit|pause|upgrad|govern|council|escape|censor/i;
/** Posts worth reading for a risk evaluation, after the security tier. */
export const BLOG_GENERIC = /bug|veto|emergenc|risk|safety|what-to-expect|mainnet|launch|decentrali|privacy|proving|sequenc|exit|fee|key/i;
/** Kept for callers of the old name: either tier. */
export const BLOG_BOOST = new RegExp(`${BLOG_SECURITY.source}|${BLOG_GENERIC.source}`, "i");

/** SEO article trees that sites keep beside a real blog ("Best Privacy Blockchain for Banks"). */
const SEO_PATH = /^\/(articles?|learn|guides?|glossary|resources)\//i;

/**
 * Ranks blog URLs (R3-SRC-8): security posts first, then other risk-relevant posts, then the rest; newest first
 * within each tier. Posts without a sitemap `lastmod` take their date from `dates` (RSS, X posts) or, failing that,
 * their position on the blog index (`order`, newest first). SEO article trees are left out when the site also has
 * a `/blog/`. Pure.
 */
export function rankBlogUrls(entries: SitemapEntry[], limit: number, hints: { dates?: Map<string, string>; order?: Map<string, number> } = {}): SitemapEntry[] {
  const posts = entries.filter((e) => {
    try {
      const p = new URL(e.loc).pathname;
      return (
        BLOG_PATH.test(p) &&
        p.split("/").filter(Boolean).length >= 2 &&
        !/\/(page|tag|tags|category|categories|author)\//i.test(p) &&
        !isLocalePath(p) &&
        !isLegalPath(p) &&
        // A blog index ("/blog") isn't a post.
        !/^\/?(blog|news|updates|posts|articles|announcements)\/?$/i.test(p.replace(/^\/[a-z]{2}(-[a-z]{2})?\//i, "/"))
      );
    } catch {
      return false;
    }
  });
  const hasBlog = posts.some((e) => /\/blog\//i.test(new URL(e.loc).pathname));
  const keyOf = (e: SitemapEntry) => canonicalKey(e.loc);
  const usable = posts
    .filter((e) => !(hasBlog && SEO_PATH.test(new URL(e.loc).pathname)))
    .map((e) => ({ ...e, lastmod: e.lastmod ?? hints.dates?.get(keyOf(e)) ?? null }));
  const order = (e: SitemapEntry) => hints.order?.get(keyOf(e)) ?? Number.POSITIVE_INFINITY;
  // Dated posts newest first; undated ones by their place on the blog index; the rest keep sitemap order.
  const byRecency = (a: SitemapEntry, b: SitemapEntry) => {
    if (a.lastmod && b.lastmod) return b.lastmod.localeCompare(a.lastmod);
    if (a.lastmod || b.lastmod) return a.lastmod ? -1 : 1;
    return order(a) - order(b);
  };
  const path = (e: SitemapEntry) => new URL(e.loc).pathname;
  const generic = (e: SitemapEntry) => (BLOG_GENERIC.test(path(e)) ? 1 : 0);
  const security = usable.filter((e) => BLOG_SECURITY.test(path(e))).sort(byRecency);
  // Words like "privacy" and "launch" match most posts of a privacy project, so outside the security tier recency
  // decides and the generic words only break ties (a 2019 "pre-launch notes" post no longer beats this year's).
  const rest = usable.filter((e) => !BLOG_SECURITY.test(path(e))).sort((a, b) => byRecency(a, b) || generic(b) - generic(a));
  const head = Math.ceil(limit * 0.75);
  const picked = [...security.slice(0, head), ...rest, ...security.slice(head)];
  const out: SitemapEntry[] = [];
  const keys = new Set<string>();
  for (const e of picked) {
    const k = keyOf(e);
    if (keys.has(k)) continue;
    keys.add(k);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/** How long the blog lane waits for the X lane before ranking without its post dates (R4-33). */
export const BLOG_WAIT_FOR_X_MS = 5 * 60_000;

/** True when `p` settles within `ms` (resolved or rejected); false when the time runs out first. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dates and blog-index order for posts the sitemap leaves undated (R3-SRC-8): RSS/Atom feeds, the blog index, X posts.
 * The X lane runs alongside this one, so on a project's first build its post dates aren't stored yet: with
 * `xPostsReady`, the X posts are read once that lane has finished (waiting at most BLOG_WAIT_FOR_X_MS, and half of
 * what's left before the deadline), after the feeds and the blog index (R4-33).
 */
async function blogHints(
  ctx: LaneContext,
  origin: string,
  site: SiteProbe | null,
  stats: FetchStats,
  opts: { deadline?: number; xPostsReady?: Promise<unknown> } = {},
): Promise<{ dates: Map<string, string>; order: Map<string, number>; extra: SitemapEntry[] }> {
  const dates = new Map<string, string>();
  const order = new Map<string, number>();
  const extra: SitemapEntry[] = [];
  const sameHost = (u: string) => sameSite(u, origin);
  // The blog index lists posts newest first.
  const feeds = new Set(site?.meta.feeds ?? []);
  for (const path of ["/blog", "/news", "/updates"]) {
    const page = await fetchWithRetry(`${origin}${path}`, stats, { preferMarkdown: false, rescueThin: false });
    if (!page || page.status >= 400) continue;
    for (const f of page.meta.feeds ?? []) feeds.add(f);
    let i = 0;
    for (const l of page.meta.links) {
      if (!sameHost(l.href)) continue;
      const k = canonicalKey(l.href);
      if (!order.has(k)) order.set(k, i++);
      extra.push({ loc: l.href, lastmod: null });
    }
    if (i > 5) break;
  }
  // Feeds carry dates.
  for (const f of [...feeds, `${origin}/rss.xml`, `${origin}/feed.xml`, `${origin}/blog/rss.xml`, `${origin}/feed`, `${origin}/atom.xml`].slice(0, 6)) {
    try {
      const res = await withHostSlot(f, () => safeFetch(f, { maxBytes: 5 * 1024 * 1024, timeoutMs: 15_000 }));
      if (res.status >= 400) continue;
      const items = parseFeed(res.body.toString("utf8"));
      for (const it of items) {
        if (!sameHost(it.loc)) continue;
        if (it.lastmod) dates.set(canonicalKey(it.loc), it.lastmod);
        extra.push(it);
      }
      if (items.length) break;
    } catch {
      // no feed there
    }
  }
  // Posts the project's X account linked, dated by the post (the X lane already expanded the links).
  if (opts.xPostsReady) {
    const left = opts.deadline ? (opts.deadline - Date.now()) / 2 : BLOG_WAIT_FOR_X_MS;
    if (!(await settlesWithin(opts.xPostsReady, Math.min(BLOG_WAIT_FOR_X_MS, left))))
      ctx.log("blog: the X lane is still running; ranking undated posts without X-post dates");
  }
  const posts = await query<{ c: string }>(
    ctx.db,
    sql`SELECT content_md AS c FROM sources WHERE project_id = ${ctx.project.id} AND kind = 'announcement' AND NOT ${STALE}`,
  );
  for (const p of posts) {
    for (const line of p.c.split("\n\n")) {
      const d = line.match(/^\[(\d{4}-\d{2}-\d{2})\]/)?.[1];
      if (!d) continue;
      for (const m of line.matchAll(/https?:\/\/[^\s)<>"']{1,500}/g)) {
        if (!sameHost(m[0])) continue;
        const k = canonicalKey(m[0]);
        const prev = dates.get(k);
        if (!prev || d < prev) dates.set(k, d);
        extra.push({ loc: m[0], lastmod: null });
      }
    }
  }
  return { dates, order, extra };
}

/**
 * Blog lane (SRC-12, R3-SRC-8): posts from the sitemap, feeds, blog index and X links; security first, then recent.
 * `xPostsReady` is the X lane, whose post dates rank undated posts (R4-33).
 */
export async function ingestBlog(
  ctx: LaneContext,
  site: SiteProbe | null,
  limit = 40,
  opts: { deadline?: number; xPostsReady?: Promise<unknown> } = {},
): Promise<LaneResult> {
  const start = new URL(site?.finalUrl ?? ctx.project.websiteUrl);
  const origin = start.origin;
  const stats = emptyStats();
  const robots = await robotsFor(origin);
  const entries = await sitemapEntries([...new Set([...robots.sitemaps, `${origin}/sitemap.xml`, `${origin}/sitemap-index.xml`])]);
  const undated = entries.filter((e) => !e.lastmod && BLOG_PATH.test(e.loc)).length;
  const dated = entries.filter((e) => e.lastmod && BLOG_PATH.test(e.loc)).length;
  // Without lastmod the sitemap's order says nothing about recency: find dates and order elsewhere.
  const hints = undated > dated || entries.length < 5 ? await blogHints(ctx, origin, site, stats, opts) : null;
  const candidates = rankBlogUrls([...entries, ...(hints?.extra ?? [])], limit, hints ?? {});
  let n = 0;
  let i = 0;
  const worker = async () => {
    while (i < candidates.length) {
      throwIfFetchAborted();
      if (opts.deadline && Date.now() > opts.deadline) {
        stats.timedOut = true;
        return;
      }
      const e = candidates[i++]!;
      const url = normalizeUrl(e.loc);
      if (!url || !(await allowedByRobots(url))) continue;
      const page = await fetchWithRetry(url, stats);
      if (page && page.status < 400 && page.markdown.length >= 200 && !isNotFoundPage(page.title, page.url)) {
        const target = storageUrl(page.canonical && sameSite(page.canonical, url) ? page.canonical : url);
        const c = classify(ctx, target, "blog", { title: page.title });
        if (!c.drop && !c.docsRoot) {
          const { status } = await storeFor(ctx, "blog", "website", {
            url: target,
            title: page.title,
            kind: c.owner === "project" ? c.kind : "blog",
            sourceClass: c.owner === "project" ? c.sourceClass : "marketing",
            content: page.markdown,
            date: e.lastmod?.slice(0, 10) ?? null,
          });
          if (counted(status)) n++;
        }
      }
      await sleep(200);
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  stats.failedUrls = stats.failedUrls.map(storageUrl);
  return { count: n, stats };
}

/** Forum hosts the project links (forum.*, community.*, gov.* on its own domains). */
export function linkedForumHosts(meta: PageMeta | null | undefined, apex: string): string[] {
  const out = new Set<string>();
  for (const l of meta?.links ?? []) {
    const h = hostOf(l.href);
    if (h && /^(forum|forums|community|gov|governance|research|discuss)\./.test(h) && registrableDomain(h) === apex) out.add(h);
  }
  return [...out];
}

/** GitHub owners linked from a page (github.com/<owner> or github.com/<owner>/<repo>). */
export function linkedGithubOwners(meta: PageMeta | null | undefined): string[] {
  const out = new Set<string>();
  for (const l of meta?.links ?? []) {
    const m = l.href.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][\w-]{0,38})(?:\/|$)/);
    if (
      m &&
      !/^(orgs|sponsors|features|about|pricing|login|topics|marketplace|apps|settings|site|security|enterprise|collections|events|explore)$/i.test(m[1]!)
    )
      out.add(m[1]!.toLowerCase());
  }
  return [...out];
}

/** X handles linked from a page (profile links only, not share intents or posts). */
export function linkedXHandles(meta: PageMeta | null | undefined): string[] {
  const out: string[] = [];
  for (const l of meta?.links ?? []) {
    if (!/^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(l.href) || /intent|share|hashtag|search|home|status\//i.test(l.href)) continue;
    const m = l.href.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#].*)?$/);
    if (m) out.push(m[1]!);
  }
  return out;
}
