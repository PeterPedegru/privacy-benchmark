/**
 * HTML → markdown and page metadata, with hard limits so one hostile page can't stall the process (SEC-3):
 * at most 1 MB of HTML is parsed, and Readability is skipped on DOMs with more than 20,000 elements.
 *
 * This module runs inside the extraction worker (extract-worker.ts) and, as a fallback, on the main thread. It must
 * stay free of app imports (env, db) and use only erasable TypeScript, because the worker may be started by plain
 * Node with built-in type stripping.
 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export const MAX_PARSE_CHARS = 1_000_000;
export const MAX_READABILITY_ELEMENTS = 20_000;

export interface PageMeta {
  title: string;
  description: string;
  siteName: string;
  image: string | null;
  icon: string | null;
  links: { href: string; text: string }[];
  /** `<link rel="canonical">`, absolute. */
  canonical?: string | null;
  /** `<link rel="alternate" type="text/markdown">`, absolute (GitBook, Mintlify and others publish one). */
  markdownUrl?: string | null;
  /** hreflang alternates (other-language copies of this page). */
  alternates?: string[];
  /** `<html lang>`. */
  lang?: string | null;
  /** RSS and Atom feeds the page declares (`<link rel="alternate" type="application/rss+xml">`). */
  feeds?: string[];
}

export interface HtmlExtraction {
  title: string;
  markdown: string;
  meta: PageMeta;
  elements: number;
  readability: boolean;
}

let turndownInstance: TurndownService | null = null;
function turndown(): TurndownService {
  if (!turndownInstance) {
    turndownInstance = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    turndownInstance.remove(["script", "style", "noscript", "iframe", "svg", "template"] as never);
  }
  return turndownInstance;
}

function abs(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/** Caps the HTML before parsing, cutting at a tag boundary when possible. */
export function capHtml(html: string): string {
  if (html.length <= MAX_PARSE_CHARS) return html;
  const cut = html.lastIndexOf("<", MAX_PARSE_CHARS);
  return html.slice(0, cut > MAX_PARSE_CHARS * 0.9 ? cut : MAX_PARSE_CHARS);
}

/** linkedom returns no documentElement for non-HTML bodies (plain-text error pages, fragments); wrap those. */
export function parseDoc(html: string) {
  const { document } = parseHTML(html);
  if (document.documentElement) return document;
  const escaped = html.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return parseHTML(`<!doctype html><html><head></head><body><pre>${escaped}</pre></body></html>`).document;
}

type Doc = ReturnType<typeof parseDoc>;

export function readMetaFromDoc(document: Doc, baseUrl: string): PageMeta {
  const m = (sel: string) => document.querySelector(sel)?.getAttribute("content")?.trim() ?? "";
  const iconEl =
    document.querySelector('link[rel="apple-touch-icon"]') ??
    document.querySelector('link[rel="icon"][type="image/svg+xml"]') ??
    document.querySelector('link[rel="icon"]') ??
    document.querySelector('link[rel="shortcut icon"]');
  const links = [...document.querySelectorAll("a[href]")]
    .map((a) => ({ href: abs(a.getAttribute("href"), baseUrl) ?? "", text: (a.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80) }))
    .filter((l) => l.href.startsWith("http"));
  const canonical = abs(document.querySelector('link[rel="canonical"]')?.getAttribute("href"), baseUrl);
  const mdLink = [...document.querySelectorAll('link[rel="alternate"]')].find((l) => /markdown/i.test(l.getAttribute("type") ?? ""));
  const alternates = [...document.querySelectorAll("link[rel=alternate][hreflang]")]
    .map((l) => abs(l.getAttribute("href"), baseUrl))
    .filter((x): x is string => !!x);
  const feeds = [...document.querySelectorAll('link[rel="alternate"]')]
    .filter((l) => /rss|atom/i.test(l.getAttribute("type") ?? ""))
    .map((l) => abs(l.getAttribute("href"), baseUrl))
    .filter((x): x is string => !!x)
    .slice(0, 5);
  return {
    title: m('meta[property="og:title"]') || (document.querySelector("title")?.textContent ?? "").trim(),
    description: m('meta[property="og:description"]') || m('meta[name="description"]'),
    siteName: m('meta[property="og:site_name"]'),
    image: abs(m('meta[property="og:image"]'), baseUrl),
    // Inline (data:) icons are too large to store as a URL; fall back to the conventional favicon.
    icon: (iconEl?.getAttribute("href")?.startsWith("data:") ? null : abs(iconEl?.getAttribute("href"), baseUrl)) ?? abs("/favicon.ico", baseUrl),
    links: [...new Map(links.map((l) => [l.href, l])).values()].slice(0, 400),
    canonical,
    markdownUrl: abs(mdLink?.getAttribute("href"), baseUrl),
    alternates,
    lang: document.documentElement?.getAttribute("lang") ?? null,
    feeds,
  };
}

/**
 * Metadata and links of an HTML page, parsed on the calling thread. Only for callers that already run in the
 * extraction worker (or tests); request handlers and lanes use `extractHtmlAsync` (R3-SEC-3).
 */
export function readMeta(html: string, baseUrl: string): PageMeta {
  return readMetaFromDoc(parseDoc(capHtml(html)), baseUrl);
}

/** Case-insensitive `indexOf` for an ASCII needle, without lowercasing the haystack (lengths must stay aligned). */
export function indexOfAsciiCI(hay: string, needle: string, from = 0): number {
  const n = needle.toLowerCase();
  const first = n.charCodeAt(0);
  const upper = n[0]!.toUpperCase().charCodeAt(0);
  for (let i = from; i <= hay.length - n.length; i++) {
    const c = hay.charCodeAt(i);
    if (c !== first && c !== upper) continue;
    let j = 1;
    for (; j < n.length; j++) {
      const h = hay.charCodeAt(i + j);
      const w = n.charCodeAt(j);
      if (h !== w && !(h >= 65 && h <= 90 && h + 32 === w)) break;
    }
    if (j === n.length) return i;
  }
  return -1;
}

/**
 * Finds the closing tag for elements opened at increasing positions, in linear total time: a failed search from
 * position p means every later search fails too, so it's remembered per tag name (R3-SEC-2, R3-SEC-3).
 */
function closeFinder(text: string) {
  const failedFrom = new Map<string, number>();
  return (name: string, from: number): number => {
    const f = failedFrom.get(name);
    if (f !== undefined && from >= f) return -1;
    const at = indexOfAsciiCI(text, `</${name}`, from);
    if (at < 0) failedFrom.set(name, from);
    return at;
  };
}

const TAG_NAME = /^[A-Za-z][A-Za-z0-9-]{0,30}/;

/**
 * Last-resort text extraction: drops script, style, noscript, svg and template blocks, then every tag, with
 * indexOf scans and bounded patterns only (no backreferences), so hostile markup costs linear time (R3-SEC-3).
 */
export function stripTags(html: string): string {
  const src = capHtml(html);
  const findClose = closeFinder(src);
  let out = "";
  let i = 0;
  for (;;) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    const name = src
      .slice(lt + 1, lt + 33)
      .match(TAG_NAME)?.[0]
      ?.toLowerCase();
    if (name && /^(script|style|noscript|svg|template)$/.test(name)) {
      const close = findClose(name, lt + 1 + name.length);
      if (close >= 0) {
        const gt = src.indexOf(">", close);
        out += `${src.slice(i, lt)} `;
        i = gt < 0 ? src.length : gt + 1;
        continue;
      }
    }
    out += src.slice(i, lt + 1);
    i = lt + 1;
  }
  out += src.slice(i);
  return out
    .replace(/<br\s{0,5}\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^<>]{1,2000}>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t\r\f\v]*(?:\n[ \t\r\f\v]*)+/g, "\n\n")
    .trim();
}

/** `display:none` or `visibility:hidden` in an inline style (whitespace removed first, so the test is linear). */
function hiddenStyle(style: string): boolean {
  const s = style.slice(0, 2000).replace(/\s+/g, "").toLowerCase();
  return /(^|;)(display:none|visibility:hidden)(!important)?(;|$)/.test(s);
}

/** Definitions of React's streaming runtime in an inline script: `function $RC(`, `$RC=function…`, `self.$RC=…`. */
const STREAMING_RUNTIME = {
  C: /\bfunction\s+\$RC\s*\(|(?<![\w$])\$RC\s*=(?!=)/,
  S: /\bfunction\s+\$RS\s*\(|(?<![\w$])\$RS\s*=(?!=)/,
};

/** Where an inline script defines `$RC` or `$RS`, or -1. */
function streamingRuntimeAt(text: string, fn: "C" | "S"): number {
  const at = STREAMING_RUNTIME[fn].exec(text)?.index ?? -1;
  if (at < 0) return -1;
  // React's runtime finds the segment and moves its nodes; a do-nothing function defined to unlock this doesn't (R5-9).
  const body = text.slice(at, at + 2000);
  return body.includes("getElementById") && /removeChild|insertBefore|parentNode/.test(body) ? at : -1;
}

/**
 * React streaming SSR (React 18+, used by Vocs and Next.js) sends late content as `<div hidden id="S:n">` and moves
 * it into place with an inline `$RC("B:n","S:n")` (or `$RS("S:n","P:n")`) call. That content is what a browser
 * shows, so it is moved into its placeholder before hidden elements are stripped (R3-SRC-3).
 *
 * Only what React's runtime would really move is revealed (R4-15): the call must come after an inline script defines
 * the function (`$RC` or `$RS`), and the `<template id="B:n">` (or `P:n`) placeholder it fills must exist. The
 * content is moved into that placeholder; `hidden` is never just removed. A bare `$RC("B:7","S:7")` next to a hidden
 * note "to AI evaluators" throws in a browser and shows nothing, so the note stays hidden here too. Returns how many
 * segments were revealed.
 */
/** True when the nearest non-whitespace node before the placeholder is React's `<!--$?-->` boundary comment. */
function pendingBoundary(el: Element): boolean {
  let prev = (el as unknown as { previousSibling: { nodeType: number; nodeValue: string | null; previousSibling: unknown } | null }).previousSibling;
  while (prev && prev.nodeType === 3 && !(prev.nodeValue ?? "").trim()) prev = prev.previousSibling as typeof prev;
  return !!prev && prev.nodeType === 8 && (prev.nodeValue ?? "").trim() === "$?";
}

export function revealStreamedSegments(document: Doc): number {
  const calls = new Map<string, string>(); // segment id → placeholder id
  const defined = { C: false, S: false };
  for (const s of document.querySelectorAll("script")) {
    if (s.hasAttribute("src")) continue;
    const text = (s.textContent ?? "").slice(0, 200_000);
    // A call only works once the function exists: defined by an earlier script, or earlier in this one.
    const definedAt = { C: defined.C ? 0 : streamingRuntimeAt(text, "C"), S: defined.S ? 0 : streamingRuntimeAt(text, "S") };
    let i = 0;
    for (;;) {
      const at = text.indexOf("$R", i);
      if (at < 0) break;
      i = at + 2;
      const fn = text[at + 2];
      if ((fn !== "C" && fn !== "S") || text[at + 3] !== "(") continue;
      if (definedAt[fn] < 0 || definedAt[fn] > at) continue;
      const args = text.slice(at + 4, at + 80).match(/^\s*["']([A-Z]:[\w-]{1,20})["']\s*,\s*["']([A-Z]:[\w-]{1,20})["']/);
      if (!args) continue;
      // $RC(boundary, segment) completes a boundary; $RS(segment, placeholder) completes a segment.
      if (fn === "C") calls.set(args[2]!, args[1]!);
      else calls.set(args[1]!, args[2]!);
    }
    if (definedAt.C >= 0) defined.C = true;
    if (definedAt.S >= 0) defined.S = true;
  }
  if (!calls.size) return 0;
  const templates = new Map<string, Element>();
  for (const t of document.querySelectorAll("template[id]")) templates.set(t.getAttribute("id") ?? "", t as unknown as Element);
  let n = 0;
  for (const el of document.querySelectorAll("div[hidden][id]")) {
    const target = calls.get(el.getAttribute("id") ?? "");
    const placeholder = target ? templates.get(target) : undefined;
    // No placeholder to fill: React's runtime would do nothing visible, so the segment stays hidden.
    if (!placeholder?.parentNode) continue;
    // A boundary placeholder follows React's pending-boundary comment (<!--$?-->); a lone template doesn't (R5-9).
    if (target?.startsWith("B:") && !pendingBoundary(placeholder)) continue;
    for (const child of [...el.childNodes]) placeholder.parentNode.insertBefore(child as unknown as Node, placeholder as unknown as Node);
    placeholder.remove();
    el.remove();
    n++;
  }
  return n;
}

/**
 * Removes content readers never see (JDG-34): `[hidden]`, `[aria-hidden="true"]`, inline `display:none` or
 * `visibility:hidden`, `<template>`, and `<noscript>` in the body. Text addressed to AI evaluators is usually
 * hidden this way. Returns how many elements were removed.
 */
export function stripHiddenElements(document: Doc): number {
  const doomed = new Set<Element>();
  for (const el of document.querySelectorAll("[hidden], [aria-hidden='true'], template, body noscript, [style]")) {
    const tag = el.tagName.toLowerCase();
    if (el.hasAttribute("style") && !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true" && tag !== "template" && tag !== "noscript") {
      if (!hiddenStyle(el.getAttribute("style") ?? "")) continue;
    }
    doomed.add(el as unknown as Element);
  }
  let n = 0;
  for (const el of doomed) {
    // Skip descendants of an element already removed (linkedom reports isConnected; treat unknown as connected).
    if (el.isConnected === false) continue;
    el.remove();
    n++;
  }
  return n;
}

/** Images and links whose target is an embedded data URI (inline SVG logos, base64 screenshots): noise in markdown. */
function stripDataUriElements(document: Doc): void {
  for (const el of document.querySelectorAll('img[src^="data:"], source[srcset^="data:"], image[href^="data:"]')) el.remove();
  for (const a of document.querySelectorAll('a[href^="data:"]')) a.removeAttribute("href");
  for (const img of document.querySelectorAll("img[srcset]")) if ((img.getAttribute("srcset") ?? "").includes("data:")) img.removeAttribute("srcset");
}

const HIDDEN_ATTRS =
  /\bhidden\b|aria-hidden\s{0,3}=\s{0,3}["']?true|style\s{0,3}=\s{0,3}["'][^"']{0,500}(display\s{0,3}:\s{0,3}none|visibility\s{0,3}:\s{0,3}hidden)/i;

/**
 * HTML comments and other markup a markdown renderer never shows: comments (an unclosed one hides the rest of the
 * document, as in CommonMark), `<template>`, `<noscript>`, and elements marked hidden. Linear: tags are found with
 * indexOf and bounded patterns (R3-SEC-2).
 */
export function stripHiddenMarkdown(md: string): string {
  const findClose = closeFinder(md);
  // The next ">" at or after a position; positions only grow, so the scan is shared (no quadratic re-scans).
  let nextGt = -2;
  const gtFrom = (p: number) => {
    if (nextGt === -1) return -1;
    if (nextGt < p) nextGt = md.indexOf(">", p);
    return nextGt;
  };
  let out = "";
  let i = 0;
  for (;;) {
    const lt = md.indexOf("<", i);
    if (lt < 0) break;
    if (md.startsWith("<!--", lt)) {
      const end = md.indexOf("-->", lt + 4);
      out += md.slice(i, lt);
      if (end < 0) return out;
      i = end + 3;
      continue;
    }
    const name = md.slice(lt + 1, lt + 33).match(TAG_NAME)?.[0];
    if (name) {
      const gt = gtFrom(lt);
      const attrs = gt > 0 && gt - lt <= 2000 ? md.slice(lt + 1 + name.length, gt) : null;
      const lower = name.toLowerCase();
      if (attrs !== null && (lower === "template" || lower === "noscript" || HIDDEN_ATTRS.test(attrs))) {
        const close = findClose(lower, gt + 1);
        if (close >= 0) {
          const end = gtFrom(close);
          out += md.slice(i, lt);
          i = end < 0 ? md.length : end + 1;
          continue;
        }
      }
    }
    out += md.slice(i, lt + 1);
    i = lt + 1;
  }
  return out + md.slice(i);
}

/**
 * Parses once: metadata and links are read before Readability mutates the document; streamed segments are put in
 * place, hidden elements and embedded data URIs are removed; Readability runs only on reasonably sized DOMs;
 * turndown converts the result.
 */
export function extractHtml(html: string, url: string, opts: { readability?: boolean } = {}): HtmlExtraction {
  const document = parseDoc(capHtml(html));
  const meta = readMetaFromDoc(document, url);
  revealStreamedSegments(document);
  stripHiddenElements(document);
  stripDataUriElements(document);
  // querySelectorAll, not getElementsByTagName("*"), which linkedom answers with 0.
  const elements = document.querySelectorAll("*").length;
  let title = (document.querySelector("title")?.textContent ?? "").trim();
  let contentHtml = document.body?.innerHTML ?? html;
  let usedReadability = false;
  if (opts.readability !== false && elements <= MAX_READABILITY_ELEMENTS) {
    try {
      const article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
      if (article?.content && (article.textContent ?? "").length > 400) {
        contentHtml = article.content;
        title = article.title || title;
        usedReadability = true;
      }
    } catch {
      // fall back to the raw body
    }
  }
  let markdown: string;
  try {
    markdown = turndown()
      .turndown(contentHtml)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    // Deeply nested markup can overflow turndown's recursion.
    markdown = stripTags(contentHtml);
  }
  return { title: title || url, markdown: stripDataUris(markdown), meta, elements, readability: usedReadability };
}

/** Plain HTML fragment → markdown, without Readability (forum posts, release bodies). Hidden elements are dropped. */
export function fragmentToMarkdown(html: string): string {
  try {
    const document = parseDoc(`<!doctype html><html><head></head><body>${capHtml(html)}</body></html>`);
    stripHiddenElements(document);
    stripDataUriElements(document);
    return stripDataUris(
      turndown()
        .turndown(document.body?.innerHTML ?? "")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    );
  } catch {
    return stripTags(html);
  }
}

/** A heading line's text: after `prefix`, with trailing spaces and closing `#`s removed (no regex). */
function headingText(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) return null;
  let s = line.slice(prefix.length, prefix.length + 400);
  let end = s.length;
  while (end > 0 && (s[end - 1] === " " || s[end - 1] === "\t" || s[end - 1] === "\r")) end--;
  while (end > 0 && s[end - 1] === "#") end--;
  while (end > 0 && (s[end - 1] === " " || s[end - 1] === "\t")) end--;
  s = s.slice(0, end).trim();
  return s ? s.slice(0, 300) : null;
}

/**
 * The first level-1 (or, failing that, level-2) markdown heading, or a front-matter title, for `.md` pages whose
 * title would otherwise be a URL. Reads the first 200 lines with string operations only (R3-SEC-2).
 */
export function markdownTitle(md: string): string | null {
  const lines: string[] = [];
  let pos = 0;
  while (lines.length < 200 && pos <= md.length) {
    const nl = md.indexOf("\n", pos);
    lines.push(md.slice(pos, nl < 0 ? Math.min(md.length, pos + 2000) : Math.min(nl, pos + 2000)));
    if (nl < 0) break;
    pos = nl + 1;
  }
  for (const l of lines) {
    const t = headingText(l, "# ") ?? headingText(l, "#\t");
    if (t) return t;
  }
  for (const l of lines) {
    const t = headingText(l, "## ") ?? headingText(l, "##\t");
    if (t) return t;
  }
  if (lines[0]?.trim() === "---") {
    for (const l of lines.slice(1, 60)) {
      if (l.trim() === "---") break;
      if (l.startsWith("title:")) {
        const v = l
          .slice(6)
          .trim()
          .replace(/^["']|["']$/g, "")
          .trim();
        if (v) return v.slice(0, 300);
      }
    }
  }
  return null;
}

/**
 * True when a page is navigation rather than content (R3-SRC-3): under 150 words outside links while links make up
 * more than 85% of the text. Such pages are usually client-rendered; callers try the markdown twin or Exa. Linear.
 */
export function isNavigationOnly(md: string): boolean {
  const text = md.length > 400_000 ? md.slice(0, 400_000) : md;
  let linkChars = 0;
  let outside = "";
  let i = 0;
  // Next "](" and ")" at or after a position, shared across iterations so every scan is linear overall.
  let nextMid = -2;
  let nextClose = -2;
  for (;;) {
    const open = text.indexOf("[", i);
    if (open < 0) break;
    if (nextMid !== -1 && nextMid < open) nextMid = text.indexOf("](", open);
    const mid = nextMid;
    if (mid < 0) break;
    if (nextClose !== -1 && nextClose < mid + 2) nextClose = text.indexOf(")", mid + 2);
    const close = nextClose;
    // Only well-formed, short links count; anything else is ordinary text.
    if (close < 0 || mid - open > 500 || close - mid > 2100 || text.slice(open, mid).includes("\n\n")) {
      outside += text.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    outside += text.slice(i, open);
    linkChars += close + 1 - open;
    i = close + 1;
  }
  outside += text.slice(i);
  const words = (outside.match(/[\p{L}\p{N}]{2,}/gu) ?? []).length;
  const total = linkChars + outside.replace(/\s+/g, "").length;
  return words < 150 && total > 0 && linkChars / total > 0.85;
}

/**
 * Removes embedded data URIs from markdown (R3-SRC-3, R3-SRC-4): inline images (`![x](data:…)`), links to data URIs,
 * reference-style definitions (`[image1]: <data:image/png;base64,…>`) and any long base64 payload. They are noise
 * for search and quoting (one audit copy was 386 KB of a single PNG). Linear: scans with indexOf, no backtracking.
 */
export function stripDataUris(md: string): string {
  if (!md.includes("data:")) return md;
  let out = "";
  let i = 0;
  for (;;) {
    const at = md.indexOf("data:", i);
    if (at < 0) break;
    // Where the URI ends: whitespace, a closing paren/bracket/angle or quote.
    let end = at + 5;
    while (end < md.length) {
      const ch = md.charCodeAt(end);
      // space, tab, newline, CR, ) > " ' ]
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 41 || ch === 62 || ch === 34 || ch === 39 || ch === 93) break;
      end++;
    }
    const uri = md.slice(at, end);
    const isMedia = /^data:(image|application|font|audio|video)\//i.test(uri) || /;base64,/i.test(uri);
    if (!isMedia || uri.length < 40) {
      out += md.slice(i, end);
      i = end;
      continue;
    }
    // Drop the whole markdown construct around it when there is one: ![alt](data:…), [x](data:…), [ref]: <data:…>.
    let start = at;
    const before = md.slice(Math.max(i, at - 300), at);
    const img = before.match(/(!?)\[([^\]\n]{0,200})\]\(\s*<?$/);
    const ref = before.match(/(^|\n)\[[^\]\n]{1,100}\]:\s*<?$/);
    let stop = end;
    if (img) {
      start = at - img[0].length;
      if (md[stop] === ">") stop++;
      if (md[stop] === ")") stop++;
      // An image disappears; a link keeps its text.
      out += md.slice(i, start) + (img[1] ? "" : (img[2] ?? ""));
    } else if (ref) {
      start = at - ref[0].length + (ref[1] ? 1 : 0);
      if (md[stop] === ">") stop++;
      out += md.slice(i, start);
    } else {
      out += `${md.slice(i, at)}(embedded data)`;
    }
    i = stop;
  }
  return out + md.slice(i);
}

/** True when a text body is actually an HTML page (SPA fallbacks answer every path with index.html). */
export function looksLikeHtml(text: string): boolean {
  return /^\s*(<!doctype html|<html[\s>])/i.test(text.slice(0, 500));
}
