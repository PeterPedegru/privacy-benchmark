/**
 * Fetch a page and turn it into markdown. HTML is parsed in the extraction worker pool with a size cap and a
 * timeout (EFF-13, SEC-3); when the worker times out or fails, the page comes back empty instead of being parsed on
 * the main thread (R3-SEC-3). When a page publishes a markdown twin (`<link rel="alternate" type="text/markdown">`,
 * GitBook and Mintlify do), the twin is used: it keeps tables and diagrams that HTML conversion loses (SRC-13).
 * Hosts that serve `<page>.md` without declaring it are probed once and then preferred, and a page that extracts as
 * navigation only falls back to its twin or Exa's renderer (R3-SRC-3). PDFs are extracted through Exa or pdf.js
 * (SRC-17).
 */
import { createHash } from "node:crypto";
import { hostOf, sameSite } from "../services/classify.ts";
import { exaContents, hasExa } from "./externals.ts";
import { type HtmlExtraction, isNavigationOnly, looksLikeHtml, markdownTitle, type PageMeta, stripDataUris, stripHiddenMarkdown } from "./extract-core.ts";
import { ExtractTimeoutError, runExtract } from "./extract-pool.ts";
import { safeFetch } from "./fetcher.ts";
import { LruCache } from "./lru.ts";
import { extractPdf } from "./pdf.ts";

export type { PageMeta } from "./extract-core.ts";

export interface ExtractedPage {
  url: string;
  status: number;
  title: string;
  markdown: string;
  hash: string;
  meta: PageMeta;
  /** How the text was obtained. */
  via?: "html" | "markdown" | "pdf" | "json" | "text" | "exa";
  /** The page's canonical URL, when it declares one on the same site. */
  canonical?: string | null;
  /** Retry-After from a 429 or 503 response, in milliseconds. */
  retryAfterMs?: number | null;
}

const HTML_TIMEOUT_MS = 10_000;
const EMPTY_META: PageMeta = { title: "", description: "", siteName: "", image: null, icon: null, links: [] };

/** The `<title>` from the first 64 KB, found with indexOf (no parsing). */
export function titleFromHead(html: string): string | null {
  const head = html.slice(0, 65_536);
  const lower = head.toLowerCase();
  const open = lower.indexOf("<title");
  if (open < 0) return null;
  const gt = lower.indexOf(">", open);
  const close = lower.indexOf("</title>", gt + 1);
  if (gt < 0 || close < 0) return null;
  const t = head
    .slice(gt + 1, Math.min(close, gt + 1 + 300))
    .replace(/\s+/g, " ")
    .trim();
  return t || null;
}

/**
 * HTML → markdown and metadata in the worker pool. A page the worker can't finish in time comes back empty (callers
 * skip pages under ~80 characters); it is never re-parsed on the main thread (R3-SEC-3).
 */
export async function extractHtmlAsync(html: string, url: string, opts: { readability?: boolean } = {}): Promise<HtmlExtraction> {
  try {
    return await runExtract<HtmlExtraction>({ kind: "html", html, url, readability: opts.readability }, HTML_TIMEOUT_MS);
  } catch (e) {
    if (!(e instanceof ExtractTimeoutError)) throw e;
    const title = titleFromHead(html) ?? url;
    return { title, markdown: "", meta: { ...EMPTY_META, title }, elements: -1, readability: false };
  }
}

/** An HTML fragment (forum post, release body) → markdown in the worker pool; "" when the worker fails (R3-SEC-3). */
export async function fragmentToMarkdownAsync(html: string): Promise<string> {
  try {
    return await runExtract<string>({ kind: "fragment", html }, HTML_TIMEOUT_MS);
  } catch {
    return "";
  }
}

function hashOf(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

/** A same-site markdown twin, or null when it doesn't exist or isn't really markdown. */
async function fetchMarkdownTwin(mdUrl: string, pageUrl: string, opts: { requireMarkdownType?: boolean } = {}): Promise<string | null> {
  if (!sameSite(mdUrl, pageUrl)) return null;
  try {
    const res = await safeFetch(mdUrl, { headers: { accept: "text/markdown,text/plain;q=0.9,*/*;q=0.1" } });
    if (res.status >= 400) return null;
    if (opts.requireMarkdownType && !/markdown|text\/plain/i.test(res.contentType)) return null;
    const text = res.body.toString("utf8");
    if (looksLikeHtml(text) || /html/.test(res.contentType) || text.trim().length < 80) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Hosts known to serve `<page>.md` twins without declaring them (Vocs sites such as tempo.xyz): learned from the
 * first probes on a host, then reused (R3-SRC-3).
 */
const twinHosts = new LruCache<{ hits: number; misses: number }>({ maxSize: 2000, maxEntries: 2000, sizeOf: () => 1 });

/** The undeclared `.md` twin of a page URL, when the path can have one. */
export function undeclaredTwinUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.search || u.pathname === "/" || u.pathname.endsWith("/") || /\.\w{1,5}$/.test(u.pathname)) return null;
    u.hash = "";
    u.pathname = `${u.pathname}.md`;
    return u.toString();
  } catch {
    return null;
  }
}

async function tryUndeclaredTwin(pageUrl: string, force: boolean): Promise<string | null> {
  const twin = undeclaredTwinUrl(pageUrl);
  const host = hostOf(pageUrl);
  if (!twin || !host) return null;
  const s = twinHosts.get(host) ?? { hits: 0, misses: 0 };
  // Probe a host twice; after that, only hosts that answered keep being asked (or a page that needs it).
  if (!force && s.hits === 0 && s.misses >= 2) return null;
  const md = await fetchMarkdownTwin(twin, pageUrl, { requireMarkdownType: true });
  if (md) s.hits++;
  else s.misses++;
  twinHosts.set(host, s);
  return md;
}

export interface FetchPageOptions {
  /** Prefer a page's markdown twin when it declares one (default true). */
  preferMarkdown?: boolean;
  /** Run Readability on HTML (default true). */
  readability?: boolean;
  maxBytes?: number;
  /** Fall back to the `.md` twin or Exa when a page extracts as navigation only (default true). */
  rescueThin?: boolean;
}

export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<ExtractedPage> {
  const preferMarkdown = opts.preferMarkdown !== false;
  if (/\.pdf($|\?)/i.test(new URL(url).pathname)) return pdfPage(url);
  const res = await safeFetch(url, opts.maxBytes ? { maxBytes: opts.maxBytes } : {});
  const ct = res.contentType.toLowerCase();
  const isPdf = ct.includes("pdf") || (res.body.length > 4 && res.body.subarray(0, 4).toString("latin1") === "%PDF");
  if (isPdf) return pdfPage(res.url, new Uint8Array(res.body.buffer, res.body.byteOffset, res.body.byteLength), res.status);
  const text = res.body.toString("utf8");
  let title = url;
  let markdown = text;
  let meta: PageMeta = EMPTY_META;
  let via: ExtractedPage["via"] = "text";
  let canonical: string | null = null;
  const adoptMarkdown = (raw: string | null, minLength: number): boolean => {
    const md = raw ? stripDataUris(stripHiddenMarkdown(raw)).trim() : null;
    if (!md || md.length < minLength) return false;
    markdown = md;
    title = markdownTitle(md) ?? title;
    via = "markdown";
    return true;
  };
  if (ct.includes("html") || looksLikeHtml(text) || /^\s*</.test(text)) {
    const r = await extractHtmlAsync(text, res.url, { readability: opts.readability });
    meta = r.meta;
    title = r.title;
    markdown = r.markdown;
    via = "html";
    if (meta.canonical && sameSite(meta.canonical, res.url)) canonical = meta.canonical;
    if (preferMarkdown && res.status < 400) {
      const thin = !markdown || isNavigationOnly(markdown);
      if (meta.markdownUrl) {
        const raw = await fetchMarkdownTwin(meta.markdownUrl, res.url);
        adoptMarkdown(raw, Math.min(markdown.length * 0.5, 2000));
      } else {
        // Hosts that serve undeclared twins (Vocs) are probed once, then preferred; a navigation-only page always asks.
        const raw = await tryUndeclaredTwin(res.url, thin);
        adoptMarkdown(raw, thin ? 200 : Math.min(markdown.length * 0.5, 2000));
      }
      // Still navigation only (client-rendered, or body streamed in a way we can't place): ask Exa's renderer.
      if (opts.rescueThin !== false && via === "html" && (!markdown || isNavigationOnly(markdown)) && hasExa()) {
        try {
          const [r2] = await exaContents([res.url], { maxCharacters: 200_000 });
          const exaText = r2?.ok ? stripDataUris(stripHiddenMarkdown(r2.text)).trim() : "";
          if (exaText.length >= 300 && !isNavigationOnly(exaText)) {
            markdown = exaText;
            title = r2!.title || title;
            via = "exa";
          }
        } catch {
          // keep what we have
        }
      }
    }
  } else if (ct.includes("json")) {
    markdown = `\`\`\`json\n${text.slice(0, 200_000)}\n\`\`\``;
    via = "json";
  } else if (ct.includes("markdown") || /\.mdx?$/i.test(new URL(res.url).pathname)) {
    markdown = stripDataUris(stripHiddenMarkdown(text));
    title = markdownTitle(markdown) ?? url;
    via = "markdown";
  }
  return { url: res.url, status: res.status, title, markdown, hash: hashOf(markdown), meta, via, canonical, retryAfterMs: res.retryAfterMs ?? null };
}

async function pdfPage(url: string, bytes?: Uint8Array, status = 200): Promise<ExtractedPage> {
  try {
    const pdf = await extractPdf(url, { bytes, preferLocal: !!bytes });
    const markdown = stripDataUris(pdf.text);
    return { url, status, title: pdf.title || url, markdown, hash: hashOf(markdown), meta: EMPTY_META, via: "pdf" };
  } catch (e) {
    const markdown = `(PDF text could not be extracted: ${(e as Error).message}; open the source link)`;
    return { url, status: status < 400 ? 422 : status, title: url, markdown, hash: hashOf(markdown), meta: EMPTY_META, via: "pdf" };
  }
}
