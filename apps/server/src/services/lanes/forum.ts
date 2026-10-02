/**
 * Governance-forum lane (P1, R3-SRC-13): the project's Discourse forums (forum.*, community.*, gov.* on its own
 * domains), read through Discourse's JSON API. Topics come from searches for the project's own names (weighted
 * three times), governance, upgrade and security terms, plus the year's top topics; older topics rank lower, and
 * very long threads (over 60 KB) are kept only when their title is about governance or risk. A topic is
 * `official_docs` when its author is staff, moderator or admin, otherwise `third_party` (a community member's view,
 * hosted by the project, R3-SEC-4).
 */
import { fragmentToMarkdownAsync } from "../../lib/extract.ts";
import { safeFetch } from "../../lib/fetcher.ts";
import { aliasMentions, hostKey } from "../classify.ts";
import { classify, counted, type LaneContext, mapLimit, sleep, storeFor } from "./context.ts";

async function discourse<T>(host: string, path: string): Promise<T | null> {
  try {
    const res = await safeFetch(`https://${host}${path}`, { headers: { accept: "application/json" }, maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
    if (res.status >= 400 || !/json/i.test(res.contentType)) return null;
    return JSON.parse(res.body.toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** Which candidate hosts are Discourse forums. */
export async function detectForums(candidates: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const h of [...new Set(candidates.map(hostKey))].slice(0, 6)) {
    const about = await discourse<{ about?: { title?: string } }>(h, "/about.json");
    if (about?.about) out.push(h);
  }
  return out;
}

export const FORUM_TERMS = [
  "governance",
  "upgrade",
  "security council",
  "multisig",
  "emergency",
  "incident",
  "vulnerability",
  "privacy",
  "proposal",
  "fees",
  "exit",
  "post-mortem",
];

type TopicRef = { id: number; title: string; slug?: string; views?: number; posts_count?: number; created_at?: string; category_id?: number };

/** Threads longer than this are kept only when the title is about governance or risk (R3-SRC-13). */
export const MAX_TOPIC_CHARS = 60_000;

/** Topic titles about governance, upgrades, keys, incidents and risk. */
export const FORUM_TITLE =
  /govern|upgrad|council|multisig|multi-sig|emergenc|incident|vulnerab|security|privacy|proposal|veto|pause|fee|exit|slash|sequenc|decentrali|audit|post-?mortem|\b(aip|azup|snip|rfc|rfp)\b|keys?\b|admin|escape|censor|risk|token generation|tge\b|delegat|voting/i;

/** Categories that hold showcases, support, events and chatter rather than protocol decisions. */
export const SKIP_CATEGORY =
  /showcase|bount(y|ies)|projects?|introduc|general|off.?topic|ecosystem|jobs?|hiring|events?|meetups?|hackathon|support|help|troubleshoot|feedback|random|lounge|social|welcome|builders?|show and tell|ideas|developer program|librar(y|ies)|misc|hangout|mingle|vibe|house of|applications?/i;

/**
 * Ranks topics: governance/security titles and titles naming the project first, then matches across searches
 * (searches for the project's own names count three times), then views, minus about a point per year of age. Pure.
 */
export function rankTopics(hits: Map<number, { topic: TopicRef; terms: number }>, limit: number, opts: { now?: number; aliases?: string[] } = {}): TopicRef[] {
  const now = opts.now ?? Date.now();
  const age = (t: TopicRef) => (t.created_at ? Math.max(0, (now - Date.parse(t.created_at)) / (365 * 86_400_000)) : 0);
  const named = (t: TopicRef) => (opts.aliases?.length ? aliasMentions(t.title, opts.aliases).length > 0 : false);
  const score = (h: { topic: TopicRef; terms: number }) =>
    (FORUM_TITLE.test(h.topic.title) ? 10 : 0) + (named(h.topic) ? 10 : 0) + h.terms * 3 + Math.log10((h.topic.views ?? 0) + 1) - age(h.topic);
  return [...hits.values()]
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit)
    .map((h) => h.topic);
}

interface DiscoursePost {
  username: string;
  name?: string;
  staff?: boolean;
  moderator?: boolean;
  admin?: boolean;
  user_title?: string | null;
  created_at: string;
  post_number: number;
  cooked: string;
}

/** Fetches one topic and stores it, classified by its author's role. Also used by the analysis lane for forum links. */
export async function ingestForumTopic(ctx: LaneContext, host: string, id: number, lane = "forum"): Promise<{ id: string; status: string } | null> {
  type T = { id: number; title: string; slug: string; created_at: string; posts_count: number; views?: number; post_stream?: { posts?: DiscoursePost[] } };
  const t = await discourse<T>(host, `/t/${id}.json`);
  const posts = t?.post_stream?.posts ?? [];
  if (!t || !posts.length) return null;
  const op = posts[0]!;
  const role = (p: DiscoursePost) => (p.admin ? "admin" : p.moderator ? "moderator" : p.staff ? "staff" : null);
  const parts: string[] = [
    `# ${t.title}`,
    `Forum: ${host} · started ${t.created_at.slice(0, 10)} by @${op.username}${role(op) ? ` (${role(op)})` : ""} · ${t.posts_count} posts`,
  ];
  for (const p of posts.slice(0, 100)) {
    const body = await fragmentToMarkdownAsync(p.cooked);
    parts.push(
      `\n## @${p.username}${role(p) ? ` (${role(p)})` : ""}${p.user_title ? ` · ${p.user_title}` : ""} · ${p.created_at.slice(0, 10)} · #${p.post_number}\n\n${body}`,
    );
  }
  if (t.posts_count > 100) parts.push(`\n(${t.posts_count - 100} more replies on the forum)`);
  const content = parts.join("\n");
  // Long chatter (delegate threads, ecosystem councils) crowds out the protocol's own threads.
  if (content.length > MAX_TOPIC_CHARS && !FORUM_TITLE.test(t.title)) return null;
  const url = `https://${host}/t/${t.slug}/${t.id}`;
  const authorRole = role(op) ? "staff" : "member";
  const c = classify(ctx, url, "forum", { authorRole });
  const r = await storeFor(ctx, lane, "forum", {
    url,
    title: `${t.title} (${host})`,
    kind: "governance",
    sourceClass: c.owner === "project" ? c.sourceClass : authorRole === "staff" ? "official_docs" : "third_party",
    content,
    date: t.created_at.slice(0, 10),
    meta: { host, topicId: t.id, author: op.username, authorRole, posts: t.posts_count },
  });
  return r;
}

/** Forum lane: searches each forum and stores the best-matching topics (100 per forum). */
export async function ingestForums(ctx: LaneContext, hosts: string[], perForum = 100): Promise<number> {
  let n = 0;
  for (const host of hosts.slice(0, 4)) {
    const hits = new Map<number, { topic: TopicRef; terms: number }>();
    const note = (t: TopicRef, w: number) => {
      const h = hits.get(t.id);
      if (h) h.terms += w;
      else hits.set(t.id, { topic: t, terms: w });
    };
    // Showcase, support and event categories are skipped; their topics rarely say anything about the protocol's risks.
    const site = await discourse<{ categories?: { id: number; name: string; slug?: string }[] }>(host, "/site.json");
    const skipCats = new Set((site?.categories ?? []).filter((c) => SKIP_CATEGORY.test(`${c.name} ${c.slug ?? ""}`)).map((c) => c.id));
    // The project's own names first (STRK20, SNIP-36 threads), weighted three times.
    for (const alias of ctx.registry.aliases.slice(0, 4)) {
      const r = await discourse<{ topics?: TopicRef[] }>(host, `/search.json?q=${encodeURIComponent(alias)}`);
      for (const t of r?.topics ?? []) note(t, 3);
      await sleep(300);
    }
    for (const term of FORUM_TERMS) {
      const r = await discourse<{ topics?: TopicRef[] }>(host, `/search.json?q=${encodeURIComponent(term)}`);
      for (const t of r?.topics ?? []) note(t, 1);
      await sleep(300);
    }
    const top = await discourse<{ topic_list?: { topics?: TopicRef[] } }>(host, "/top.json?period=yearly");
    for (const t of top?.topic_list?.topics ?? []) note(t, 0.5);
    for (const [id, h] of hits) if (h.topic.category_id !== undefined && skipCats.has(h.topic.category_id)) hits.delete(id);
    const picked = rankTopics(hits, perForum, { aliases: ctx.registry.aliases });
    await mapLimit(picked, 2, async (t) => {
      try {
        const r = await ingestForumTopic(ctx, host, t.id);
        if (r && counted(r.status as never)) n++;
      } catch {
        // skip unreadable topics
      }
      await sleep(250);
    });
  }
  return n;
}

/** Topic id from a Discourse topic URL (/t/<slug>/<id> or /t/<id>). */
export function topicIdFromUrl(url: string): number | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const segs = path.split("/").filter(Boolean);
  if (segs[0] !== "t" || !segs[1]) return null;
  // /t/<id>[/<post>] or /t/<slug>/<id>[/<post>]
  if (/^\d+$/.test(segs[1])) return Number(segs[1]);
  return segs[2] && /^\d+$/.test(segs[2]) ? Number(segs[2]) : null;
}
