/**
 * Quote verification. A quote is verified when it appears in the stored source, either exactly (after
 * normalizing whitespace, punctuation and markdown) or as a near match that doesn't change its meaning.
 *
 * What gets stored and published is always the source's own text (the matched span), never the model's
 * rendering of it, with surrounding context so a reader can check what was left out.
 */

/** Characters that a model may legitimately render differently. Each maps to its normalized form ("" = drop). */
function normChar(ch: string): string {
  if (/[‘’‛`]/.test(ch)) return "'";
  if (/[“”‟]/.test(ch)) return '"';
  if (/[–—‐‑-]/.test(ch)) return " ";
  if (/\s| /.test(ch)) return " ";
  if (/[*_]/.test(ch)) return "";
  return ch.toLowerCase();
}

export interface Normalized {
  text: string;
  /** map[i] = index in the original string of normalized character i. */
  map: number[];
}

/** Normalizes while remembering where each character came from, so a match can be cut out of the original. */
export function normalizeWithMap(s: string): Normalized {
  let text = "";
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < s.length; i++) {
    let ch = s[i]!;
    // Markdown escapes: "\_" renders as "_".
    if (ch === "\\" && i + 1 < s.length && /[~*_`[\]()#>|-]/.test(s[i + 1]!)) {
      i++;
      ch = s[i]!;
    }
    const n = normChar(ch);
    if (!n) continue;
    if (n === " ") {
      if (lastSpace) continue;
      lastSpace = true;
    } else lastSpace = false;
    text += n;
    map.push(i);
  }
  while (text.endsWith(" ")) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

export function normalizeText(s: string): string {
  return normalizeWithMap(s).text;
}

/**
 * Agents quote the same few sources over and over; normalizing a large source takes tens of milliseconds on the
 * main thread, so recent results are kept (keyed by the content itself).
 */
const NORM_CACHE = new Map<string, Normalized>();
/** Bounded by size (R4-27): each cached character also holds an 8-byte map entry. Very large sources aren't cached. */
const NORM_CACHE_MAX_CHARS = 4_000_000;
const NORM_CACHE_MAX_SOURCE = 500_000;
let normCacheChars = 0;
function normalizedSource(source: string): Normalized {
  const hit = NORM_CACHE.get(source);
  if (hit) {
    NORM_CACHE.delete(source);
    NORM_CACHE.set(source, hit);
    return hit;
  }
  const n = normalizeWithMap(source);
  if (source.length > 2000 && source.length <= NORM_CACHE_MAX_SOURCE) {
    NORM_CACHE.set(source, n);
    normCacheChars += source.length;
    while (normCacheChars > NORM_CACHE_MAX_CHARS) {
      const oldest = NORM_CACHE.keys().next().value as string;
      NORM_CACHE.delete(oldest);
      normCacheChars -= oldest.length;
    }
  }
  return n;
}

const WORD = /[\p{L}\p{N}]/u;

function snapWords(s: string, from: number, to: number): [number, number] {
  let a = from;
  let b = to;
  while (a > 0 && WORD.test(s[a - 1]!) && WORD.test(s[a]!)) a--;
  while (b < s.length && b > 0 && WORD.test(s[b - 1]!) && WORD.test(s[b]!)) b++;
  return [a, b];
}
function tokens(s: string): string[] {
  return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Pairs that are close in spelling but opposite in meaning. */
const ANTONYMS: [string, string][] = [
  ["increase", "decrease"],
  ["increased", "decreased"],
  ["enable", "disable"],
  ["enabled", "disabled"],
  ["allow", "deny"],
  ["allowed", "denied"],
  ["public", "private"],
  ["permissioned", "permissionless"],
  ["trusted", "trustless"],
  ["custodial", "noncustodial"],
  ["upgradeable", "immutable"],
  ["include", "exclude"],
  ["included", "excluded"],
  ["encrypted", "decrypted"],
  ["visible", "invisible"],
  ["mandatory", "optional"],
  ["above", "below"],
  ["more", "less"],
  ["max", "min"],
  ["maximum", "minimum"],
];
const NEGATING_PREFIX = /^(?:un|in|im|ir|il|dis|non|anti)/;

/** True when two tokens could be opposites: an antonym pair, or one is the other with a negating affix. */
function polarityFlip(a: string, b: string): boolean {
  if (ANTONYMS.some(([x, y]) => (a === x && b === y) || (a === y && b === x))) return true;
  const strip = (w: string) => w.replace(NEGATING_PREFIX, "");
  if ((a !== b && strip(a) === b) || strip(b) === a) return true;
  if (a.replace(/less$/, "") === b.replace(/(ful|ed)$/, "") && a !== b) return true;
  if (b.replace(/less$/, "") === a.replace(/(ful|ed)$/, "") && a !== b) return true;
  return false;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/**
 * A near match may differ from the source by at most one word, and that word must be a small spelling change, not a
 * flipped meaning ("able" vs "unable", "increase" vs "decrease") and not an added or dropped negating word.
 */
function wordsAgree(quote: string, span: string): boolean {
  const a = tokens(quote);
  const b = tokens(span);
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const da = a.slice(i, a.length - j);
  const db = b.slice(i, b.length - j);
  if (da.length + db.length === 0) return true;
  if (da.length > 1 || db.length > 1) return false;
  if (da.length === 1 && db.length === 1) return editDistance(da[0]!, db[0]!) <= 2 && !polarityFlip(da[0]!, db[0]!);
  // One word added or dropped: never a negating one.
  const extra = (da[0] ?? db[0])!;
  return !/^(?:not|no|non|un|never|without|except|only|cannot|nor)$/.test(extra);
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

/**
 * Words whose presence or absence changes what a sentence claims. A near match must agree on all of them:
 * "can pause" vs "cannot pause", "30-day" vs "3-day", "only the portal" vs "the pool".
 */
const MEANING_TOKENS =
  /\b(?:not|no|never|none|nobody|nothing|neither|nor|cannot|can't|won't|don't|doesn't|isn't|aren't|wasn't|without|unless|except|only|can|could|may|might|must|shall|should|will|would|always|all|any|every|some|before|after|within|immediately|instantly|days?|hours?|minutes?|weeks?|months?|years?|blocks?|seconds?|%|percent|\d+(?:[.,]\d+)?)\b|n't\b|\d+/g;

function meaningTokens(s: string): string {
  return (s.match(MEANING_TOKENS) ?? []).join(" ");
}

export const MIN_QUOTE_CHARS = 20;
export const MIN_QUOTE_WORDS = 4;
const FUZZY_MIN_CHARS = 40;
const CONTEXT_CHARS = 300;

export interface QuoteCheck {
  verified: boolean;
  /** stitched: separate passages joined with an ellipsis, each found in order close together in the source. */
  method: "exact" | "fuzzy" | "stitched" | "none";
  score: number;
  /** The source's own text for the match (what gets stored and shown). */
  span?: string;
  /** About 300 characters either side of the match, from the source. */
  context?: string;
  start?: number;
  end?: number;
  /** When not verified: the closest passage in the source, for the agent to re-record verbatim. */
  closest?: string;
  reason?: string;
}

function cut(source: string, n: Normalized, from: number, to: number) {
  const start = n.map[from] ?? 0;
  const end = (n.map[Math.min(to, n.map.length) - 1] ?? start) + 1;
  const context = `${start > CONTEXT_CHARS ? "…" : ""}${source.slice(Math.max(0, start - CONTEXT_CHARS), Math.min(source.length, end + CONTEXT_CHARS))}${
    end + CONTEXT_CHARS < source.length ? "…" : ""
  }`;
  return { span: source.slice(start, end), context, start, end };
}

/** Splits a quote stitched from separate passages ("A … B" or "A ... B"). */
function segments(quote: string): string[] {
  return quote
    .split(/\s*(?:…|\.{3}|\[\.\.\.\]|\[…\])\s*/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * Verifies a quote against a source. Quotes stitched from several passages with an ellipsis are verified one
 * segment at a time (in order); the stored span then runs from the first segment to the last, so the omitted
 * text stays visible in the stored quote's context.
 */
/** Stitched segments must each stand on their own, and sit close together in one passage of the source. */
const SEGMENT_MIN_WORDS = 5;
const SEGMENT_MIN_CHARS = 25;
const SEGMENT_MAX_GAP = 250;

export function verifyQuote(quote: string, source: string, threshold = 0.92): QuoteCheck {
  const parts = segments(quote);
  if (parts.length > 1) {
    const checks: QuoteCheck[] = [];
    let after = 0;
    for (const part of parts) {
      const np = normalizeText(part);
      if (np.length < SEGMENT_MIN_CHARS || np.split(" ").length < SEGMENT_MIN_WORDS)
        return {
          verified: false,
          method: "none",
          score: 0,
          reason: `Each part of a quote joined with "…" needs at least ${SEGMENT_MIN_WORDS} words; "${part.slice(0, 60)}" is too short. Quote the passage whole.`,
        };
      const c = verifyOne(part, source, threshold, after, true);
      if (!c.verified) return { ...c, reason: `The part "${part.slice(0, 80)}" ${c.reason ? c.reason.toLowerCase() : "wasn't found"}` };
      const prev = checks[checks.length - 1];
      if (prev) {
        const between = source.slice(prev.end ?? 0, c.start ?? 0);
        if (normalizeText(between).length > SEGMENT_MAX_GAP || /\n\s*\n/.test(between))
          return {
            verified: false,
            method: "none",
            score: 0,
            closest: c.span,
            reason: 'The parts joined with "…" come from passages too far apart in the source; record them as separate quotes.',
          };
        // The omitted text must not change the meaning: "the owner can … pause" can't skip a "not" (R4-9).
        if (meaningTokens(normalizeText(between)))
          return {
            verified: false,
            method: "none",
            score: 0,
            closest: source.slice(prev.start ?? 0, c.end ?? 0),
            reason: "The text left out between the joined parts has a negation, number or qualifier that changes the meaning; quote the passage whole.",
          };
      }
      checks.push(c);
      after = c.end ?? after;
    }
    const first = checks[0]!;
    const last = checks[checks.length - 1]!;
    return {
      verified: true,
      method: "stitched",
      score: Math.min(...checks.map((c) => c.score)),
      span: checks.map((c) => c.span).join(" … "),
      context: source.slice(Math.max(0, (first.start ?? 0) - CONTEXT_CHARS), Math.min(source.length, (last.end ?? 0) + CONTEXT_CHARS)),
      start: first.start,
      end: last.end,
    };
  }
  return verifyOne(quote, source, threshold, 0, false);
}

/** Words used to anchor the fuzzy search: punctuation-free, so "relay(iprivacypool.withdrawal" yields usable tokens. */
function anchorWords(q: string): string[] {
  return [...new Set(q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 4))].sort((a, b) => b.length - a.length).slice(0, 4);
}

function verifyOne(quote: string, source: string, threshold: number, fromOriginal: number, segment: boolean): QuoteCheck {
  const q = normalizeText(quote);
  const minWords = segment ? 2 : MIN_QUOTE_WORDS;
  if ((!segment && q.length < MIN_QUOTE_CHARS) || q.split(" ").length < minWords) {
    return { verified: false, method: "none", score: 0, reason: `Quotes need at least ${MIN_QUOTE_WORDS} words; quote a full sentence.` };
  }
  const n = normalizedSource(source);
  const s = n.text;
  // Segments must appear after the previous one.
  const fromNorm = fromOriginal
    ? Math.max(
        0,
        n.map.findIndex((i) => i >= fromOriginal),
      )
    : 0;
  const at = s.indexOf(q, fromNorm);
  if (at !== -1) {
    // A match that starts or ends inside a word ("partner" in "partners") is widened to whole words; if that
    // changes a word, it's a near match and must pass the same word check.
    const [from, to] = snapWords(s, at, at + q.length);
    if (from === at && to === at + q.length) return { verified: true, method: "exact", score: 1, ...cut(source, n, at, at + q.length) };
    if (wordsAgree(q, s.slice(from, to))) return { verified: true, method: "fuzzy", score: 0.99, ...cut(source, n, from, to) };
  }

  // Sliding window over the source at the quote's length, anchored on the quote's longest words.
  const anchors = anchorWords(q);
  let best = 0;
  let bestAt = -1;
  for (const anchor of anchors) {
    let idx = s.indexOf(anchor, fromNorm);
    let guard = 0;
    while (idx !== -1 && guard++ < 200) {
      const step = Math.max(1, Math.floor(q.length / 20));
      for (let off = Math.max(0, idx - q.length); off <= idx; off += step) {
        const d = dice(q, s.slice(off, off + q.length));
        if (d > best) {
          best = d;
          bestAt = off;
        }
      }
      idx = s.indexOf(anchor, idx + 1);
    }
  }
  // Snap the best window to whole words, so neither the comparison nor the stored span starts mid-word.
  const [from, to] = bestAt >= 0 ? snapWords(s, bestAt, bestAt + q.length) : [bestAt, bestAt + q.length];
  const window = bestAt >= 0 ? cut(source, n, from, to) : null;
  const closest = window && best >= 0.5 ? window.span : undefined;
  if (best < threshold || !window) return { verified: false, method: "none", score: best, closest, reason: "Not found in the source." };
  if (q.length < FUZZY_MIN_CHARS) return { verified: false, method: "none", score: best, closest, reason: "Short quotes must match exactly." };
  if (meaningTokens(q) !== meaningTokens(s.slice(from, to)) || !wordsAgree(q, s.slice(from, to))) {
    return { verified: false, method: "none", score: best, closest, reason: "Close to the source, but a negation, number, qualifier or word differs." };
  }
  return { verified: true, method: "fuzzy", score: best, ...window };
}

/**
 * Finds which of several sources contains a quote, for quotes recorded against the wrong source id (researchers
 * often cite the page they were on rather than the one the text came from). Exact matches win over near matches.
 */
export function findQuoteSource<T extends { id: string; contentMd: string }>(
  quote: string,
  candidates: T[],
  opts: { max?: number; maxChars?: number } = {},
): { source: T; check: QuoteCheck } | null {
  let best: { source: T; check: QuoteCheck } | null = null;
  // Bounded: each candidate costs a full scan on the main thread.
  const pool = candidates.filter((c) => c.contentMd.length <= (opts.maxChars ?? 500_000)).slice(0, opts.max ?? 3);
  for (const source of pool) {
    const check = verifyQuote(quote, source.contentMd);
    if (!check.verified) continue;
    if (check.method === "exact") return { source, check };
    if (!best || check.score > best.check.score) best = { source, check };
  }
  return best;
}
