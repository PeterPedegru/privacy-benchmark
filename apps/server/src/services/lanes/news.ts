/**
 * News lane (SRC-5, R3-SRC-10): Event Registry, relevance-sorted, news and press releases only, any of the
 * project's aliases co-occurring with crypto terms, gambling spam excluded. Every article must then pass a
 * word-boundary proximity filter (the name in the title or twice in the text, with two distinct crypto terms within
 * 300 characters of a mention, "rollup", "mainnet" and "testnet" not counting on their own), titles are
 * de-duplicated and syndicated copies of one Event Registry event are kept once. Press releases are `marketing`,
 * news sites `third_party`. Event Registry's archive only reaches back a few weeks on our plan, so when the
 * articles cover less than 60 days, Exa's news index fills in the rest of the year.
 */

import { eq, inArray, sql } from "drizzle-orm";
import { query, schema } from "../../db/index.ts";
import { exaSearch, hasExa, type NewsArticle, newsQuery } from "../../lib/externals.ts";
import { aliasMentions, hostOf, normalizeUrl } from "../classify.ts";
import { purgeWhere } from "../kb-store.ts";
import { classify, counted, type LaneContext, storeFor } from "./context.ts";

/** Strong crypto context, matched on word boundaries ("defi" no longer matches "definitely"). */
export const CRYPTO =
  /\b(crypto(?:currenc(?:y|ies))?|blockchains?|ethereum|bitcoin|stablecoins?|defi|web3|zero[- ]knowledge|zk[- ]?(?:proofs?|snarks?|starks?|rollups?)|layer[- ]?2|on-?chain|smart contracts?|dapps?|privacy protocol|crypto mixers?|tokens? (?:holders|sale|launch|unlock)|airdrops?|dao)\b/i;
/** Words that are crypto only in context ("rollup" is also a wrestling pin): they count only next to a strong term. */
const WEAK_CRYPTO = /\b(rollups?|mainnet|testnet)\b/i;
const CRYPTO_ALL = new RegExp(`${CRYPTO.source}|${WEAK_CRYPTO.source}`, "gi");

/** Distinct crypto terms in a passage, and whether any is a strong one. Pure. */
export function cryptoTerms(text: string): { distinct: number; strong: boolean } {
  const terms = new Set<string>();
  let strong = false;
  for (const m of text.matchAll(CRYPTO_ALL)) {
    const t = m[0]
      .toLowerCase()
      .replace(/[\s-]+/g, " ")
      .replace(/s$/, "");
    terms.add(t);
    if (!WEAK_CRYPTO.test(m[0])) strong = true;
  }
  return { distinct: terms.size, strong };
}

/** Gambling and casino spam that borrows project names (Aztec Gold slots). */
export const SPAM = /\b(casinos?|slots?|jackpots?|sportsbooks?|betting|bookmakers?|free spins|gambling|poker|roulette|horoscopes?|lottery|lotteries)\b/i;

/** Price and market chatter (ticker bots, price predictions, presale promotions): nothing a security evaluation can use. */
export const PRICE_CHATTER =
  /\b(price (prediction|index|analysis|today|reaches|hits|surges?|drops?|slides?)|market cap|trading (up|down)|\d+(\.\d+)?% (up|down|gain|loss|rally|drop|surge)|(slides?|surges?|plunges?|jumps?|soars?|tumbles?|rall(y|ies)|dips?|climbs?|falls?) (around |by |over |nearly )?\d+(\.\d+)?%|all[- ]time high|new ath|presale|meme ?coins?|next crypto to explode|to buy now|price chart|live chart|technical analysis)/i;

export interface NewsCandidate {
  title: string;
  text: string;
  url: string;
  source?: string | null;
}

/** Whether an article is really about the project. Pure. */
export function newsRelevance(a: NewsCandidate, aliases: string[]): { ok: boolean; reason: string } {
  const titleHits = aliasMentions(a.title, aliases);
  const text = `${a.title}\n${a.text}`;
  const hits = aliasMentions(text, aliases);
  if (!titleHits.length && hits.length < 2) return { ok: false, reason: "name not in the title and mentioned fewer than twice" };
  if (SPAM.test(a.title) || (SPAM.test(text.slice(0, 2000)) && !CRYPTO.test(a.title))) return { ok: false, reason: "gambling spam" };
  if (PRICE_CHATTER.test(a.title)) return { ok: false, reason: "price or market chatter" };
  const near = hits.slice(0, 50).some((m) => {
    const c = cryptoTerms(text.slice(Math.max(0, m.index - 300), m.index + m.text.length + 300));
    return c.distinct >= 2 && c.strong;
  });
  if (!near) return { ok: false, reason: "no crypto context near a mention" };
  // A publisher named like the project ("TEMPO.CO" for Tempo) writes about everything.
  const publisher = `${a.source ?? ""} ${hostOf(a.url) ?? ""}`;
  if (aliases.some((al) => al.length >= 4 && new RegExp(`\\b${al.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(publisher))) {
    return { ok: false, reason: "publisher shares the project's name" };
  }
  return { ok: true, reason: "relevant" };
}

/** Title key for de-duplicating syndicated copies. Pure. */
export function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/\s+[-|–—:]\s+[^-|–—:]{2,40}$/, "") // " - Publisher" suffix
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 120);
}

const NEWS_KEEP = 80;
/** Below this many days of coverage, Exa backfills the year. */
const MIN_WINDOW_DAYS = 60;

/** Exa news queries for the backfill: incidents and governance first. */
export function backfillQuery(name: string): string {
  return `${name} exploit, hack, vulnerability, incident, outage, freeze, governance vote, upgrade or security council news`;
}

/** News lane. `since` limits the window on incremental runs. */
export async function ingestNewsLane(
  ctx: LaneContext,
  opts: { since?: string | null } = {},
): Promise<{ stored: number; dropped: number; oldest: string | null; backfilled: number }> {
  const aliases = ctx.registry.aliases;
  const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const dateStart = opts.since && opts.since > yearAgo ? opts.since : yearAgo;
  const articles = await newsQuery({
    aliases,
    context: ["blockchain", "crypto", "cryptocurrency", "Ethereum", "stablecoin", "DeFi", "zero-knowledge", "rollup", "token", "privacy"],
    dateStart,
    count: 100,
  });
  // Titles and events already stored count as seen, so syndicated copies of an old story don't come back.
  const stored0 = await query<{ title: string; date: string | null; eventUri: string | null }>(
    ctx.db,
    sql`SELECT title, date, meta->>'eventUri' AS "eventUri" FROM sources WHERE project_id = ${ctx.project.id} AND meta->>'lane' = 'news'`,
  );
  const seen = new Set(stored0.map((r) => normalizeTitle(r.title.replace(/\s+\([^)]*\)$/, ""))));
  const events = new Set(stored0.map((r) => r.eventUri).filter((e): e is string => !!e));
  let stored = 0;
  let dropped = 0;
  const consider = async (a: NewsArticle | (NewsArticle & { via: string })) => {
    const url = normalizeUrl(a.url, { keepQuery: true });
    if (!url || !a.title) return;
    const verdict = newsRelevance({ title: a.title, text: a.text, url, source: a.source }, aliases);
    if (!verdict.ok) {
      dropped++;
      return;
    }
    const key = normalizeTitle(a.title);
    if (seen.has(key)) return;
    // One story syndicated by many outlets is one Event Registry event (R3-SRC-10).
    if (a.eventUri && events.has(a.eventUri)) return;
    seen.add(key);
    if (a.eventUri) events.add(a.eventUri);
    const c = classify(ctx, url, "news", { title: a.title, text: a.text, dataType: a.dataType });
    if (c.drop || c.docsRoot) {
      dropped++;
      return;
    }
    const { status } = await storeFor(ctx, "news", "news", {
      url,
      title: `${a.title}${a.source ? ` (${a.source})` : ""}`,
      kind: c.owner === "project" ? c.kind : "news",
      sourceClass: c.sourceClass,
      content: a.text,
      date: a.publishedAt?.slice(0, 10) ?? null,
      meta: { publisher: a.source, dataType: a.dataType, ...(a.eventUri ? { eventUri: a.eventUri } : {}), ...("via" in a ? { via: a.via } : {}) },
    });
    if (counted(status)) stored++;
  };
  for (const a of articles) await consider(a);
  // How far back the coverage reaches: the oldest article returned or already stored.
  const dates = [...articles.map((a) => a.publishedAt?.slice(0, 10)), ...stored0.map((r) => r.date)].filter((d): d is string => !!d).sort();
  const oldest = dates[0] ?? null;
  let backfilled = 0;
  const windowDays = oldest ? (Date.now() - Date.parse(oldest)) / 86_400_000 : 0;
  if (windowDays < MIN_WINDOW_DAYS && hasExa()) {
    try {
      const before = stored;
      const found = await exaSearch(backfillQuery(aliases[0] ?? ctx.project.name), {
        category: "news",
        startPublishedDate: `${yearAgo}T00:00:00Z`,
        numResults: 20,
        maxCharacters: 20_000,
      });
      for (const d of found) await consider({ ...d, dataType: "news", source: hostOf(d.url), via: "exa" });
      backfilled = stored - before;
    } catch (e) {
      ctx.log(`news: Exa backfill failed: ${(e as Error).message}`);
    }
  }
  return { stored, dropped, oldest, backfilled };
}

/**
 * Re-applies the current relevance filter to stored news (rows from older, looser runs), writes the classifier's
 * current kind and class back to the rows that stay (R3-JDG-6: news sites are third_party), and keeps the newest
 * articles. Cited rows are only marked stale.
 */
export async function pruneNews(ctx: LaneContext): Promise<number> {
  const rows = await query<{ id: string; url: string; title: string; kind: string; sourceClass: string; text: string; dataType: string | null }>(
    ctx.db,
    sql`SELECT id, url, title, kind, source_class AS "sourceClass", content_md AS text, meta->>'dataType' AS "dataType"
       FROM sources WHERE project_id = ${ctx.project.id} AND origin = 'kb' AND meta->>'section' = 'news'`,
  );
  const bad: string[] = [];
  for (const r of rows) {
    const title = r.title.replace(/\s+\([^)]*\)$/, "");
    if (!newsRelevance({ title, text: r.text, url: r.url }, ctx.registry.aliases).ok) {
      bad.push(r.id);
      continue;
    }
    const c = classify(ctx, r.url, "news", { title, dataType: r.dataType });
    if (c.drop) {
      bad.push(r.id);
      continue;
    }
    const kind = c.owner === "project" ? c.kind : "news";
    if (kind !== r.kind || c.sourceClass !== r.sourceClass)
      await ctx.db.update(schema.sources).set({ kind, sourceClass: c.sourceClass }).where(eq(schema.sources.id, r.id));
  }
  let n = 0;
  for (let i = 0; i < bad.length; i += 200) {
    const chunk = bad.slice(i, i + 200);
    n += (await purgeWhere(ctx.db, ctx.project.id, inArray(schema.sources.id, chunk))).deleted;
  }
  n += (
    await purgeWhere(
      ctx.db,
      ctx.project.id,
      sql`meta->>'lane' = 'news' AND id NOT IN (SELECT id FROM sources WHERE project_id = ${ctx.project.id} AND meta->>'lane' = 'news' ORDER BY coalesce(date, '') DESC LIMIT ${NEWS_KEEP})`,
    )
  ).deleted;
  return n;
}
