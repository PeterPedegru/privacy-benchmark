/**
 * Independent analyses through Exa (SRC-8): governance, privacy-model and risk write-ups (dated, the last two
 * years), plus undated incident and post-mortem searches with large text caps. Every result goes through the
 * shared classifier: mirrors, AI summaries and SEO farms are dropped; the project's own pages keep the project's
 * class; third parties must pass the relevance gate (name in the title, or twice in the first 3,000 characters).
 * Docs-root URLs are left to the docs lane, and links to the project's Discourse topics go through the forum
 * reader so their author decides the class.
 */

import { eq, inArray, sql } from "drizzle-orm";
import { query, schema } from "../../db/index.ts";
import { exaSearch } from "../../lib/externals.ts";
import { type Classification, dropReason, githubParts, hostOf, isForumHost, normalizeUrl, passesRelevanceGate } from "../classify.ts";
import { purgeWhere } from "../kb-store.ts";
import { classify, counted, type LaneContext, storeFor } from "./context.ts";
import { ingestForumTopic, topicIdFromUrl } from "./forum.ts";
import { PRICE_CHATTER } from "./news.ts";

export const INCIDENT_DOMAINS = [
  "rekt.news",
  "slowmist.medium.com",
  "hacked.slowmist.io",
  "blocksec.com",
  "halborn.com",
  "peckshield.com",
  "certik.com",
  "blog.solidityscan.com",
  "medium.com",
  "theblock.co",
  "coindesk.com",
  "decrypt.co",
];

interface Query {
  q: string;
  dated: boolean;
  numResults: number;
  maxCharacters: number;
  includeDomains?: string[];
  subkind?: "incident";
}

export function analysisQueries(name: string): Query[] {
  return [
    { q: `${name} admin keys multisig upgrade security council governance analysis`, dated: true, numResults: 25, maxCharacters: 60_000 },
    { q: `${name} privacy model analysis anonymity set viewing keys`, dated: true, numResults: 25, maxCharacters: 60_000 },
    { q: `${name} security risks trust assumptions independent review`, dated: true, numResults: 25, maxCharacters: 60_000 },
    // One per remaining rubric area, so each suite has independent material to weigh.
    { q: `${name} decentralization sequencer prover validator operator set censorship resistance`, dated: true, numResults: 15, maxCharacters: 60_000 },
    { q: `${name} self-custody exit withdrawal escape hatch forced inclusion analysis`, dated: true, numResults: 15, maxCharacters: 60_000 },
    { q: `${name} compliance screening KYC association set sanctions analysis`, dated: true, numResults: 15, maxCharacters: 60_000 },
    { q: `${name} cryptography trusted setup proof system soundness review`, dated: true, numResults: 15, maxCharacters: 60_000 },
    { q: `${name} exploit hack vulnerability incident post-mortem`, dated: false, numResults: 25, maxCharacters: 150_000, subkind: "incident" },
    { q: `${name} exploit post-mortem`, dated: false, numResults: 10, maxCharacters: 150_000, includeDomains: INCIDENT_DOMAINS, subkind: "incident" },
  ];
}

/** Analyses lane. `full` runs the undated searches too; incremental runs only look at recent publications. */
export async function ingestAnalysesLane(ctx: LaneContext, opts: { full: boolean; since?: string | null }): Promise<{ stored: number; dropped: number }> {
  const name = ctx.registry.aliases[0] ?? ctx.project.name;
  const twoYears = new Date(Date.now() - 730 * 86_400_000).toISOString();
  const start = !opts.full && opts.since ? new Date(Math.max(Date.parse(twoYears), Date.parse(opts.since) - 7 * 86_400_000)).toISOString() : twoYears;
  const seen = new Set<string>();
  let stored = 0;
  let dropped = 0;
  for (const q of analysisQueries(name)) {
    if (!q.dated && !opts.full) continue;
    let results: Awaited<ReturnType<typeof exaSearch>> = [];
    try {
      results = await exaSearch(q.q, {
        numResults: q.numResults,
        ...(q.dated ? { startPublishedDate: start } : {}),
        ...(q.includeDomains ? { includeDomains: q.includeDomains } : { excludeDomains: ["x.com", "twitter.com", "reddit.com"] }),
        maxCharacters: q.maxCharacters,
      });
    } catch (e) {
      ctx.log(`analysis query failed: ${(e as Error).message}`);
      continue;
    }
    for (const r of results) {
      const url = normalizeUrl(r.url, { keepQuery: true });
      if (!url || seen.has(url) || r.text.length < 300) continue;
      seen.add(url);
      const host = hostOf(url) ?? "";
      if (isForumHost(ctx.registry, host)) {
        const id = topicIdFromUrl(url);
        if (id) {
          try {
            const t = await ingestForumTopic(ctx, host, id, "analysis");
            if (t && counted(t.status as never)) stored++;
          } catch {
            // fall through to nothing: forum pages without JSON aren't stored
          }
          continue;
        }
      }
      const c = classify(ctx, url, "analysis", { title: r.title, text: r.text, requireRelevance: true });
      if (c.drop || (notProject(c) && PRICE_CHATTER.test(r.title))) {
        dropped++;
        continue;
      }
      if (c.docsRoot) continue; // the docs lane owns docs pages
      // The project's code at some commit or branch belongs to the code lane, at the version under evaluation.
      if (c.owner === "project_github" && /^(tree|blob|raw|commit|commits|compare)\//.test(githubParts(url)?.rest ?? "")) continue;
      const section = c.kind === "audit" ? "audits" : "analysis";
      const { status } = await storeFor(ctx, "analysis", section, {
        url,
        title: r.title || url,
        kind: c.kind,
        sourceClass: c.sourceClass,
        content: r.text,
        date: r.publishedAt?.slice(0, 10) ?? null,
        meta: { query: q.q, ...(q.subkind ? { subkind: q.subkind } : {}), ...(c.auditor ? { auditor: c.auditor } : {}) },
      });
      if (counted(status)) stored++;
    }
  }
  return { stored, dropped };
}

const notProject = (c: Classification) => c.owner !== "project" && c.owner !== "project_github";

/**
 * Re-applies the domain policy and relevance gate to stored analyses (including rows from older runs), writes the
 * classifier's current kind and class back to the rows that stay (R3-SRC-2), then keeps the newest 100. Cited rows
 * are only marked stale.
 */
export async function pruneAnalyses(ctx: LaneContext): Promise<number> {
  const rows = await query<{ id: string; url: string; title: string; kind: string; sourceClass: string; text: string; lane: string | null }>(
    ctx.db,
    sql`SELECT id, url, title, kind, source_class AS "sourceClass", substr(content_md, 1, 6000) AS text, meta->>'lane' AS lane
       FROM sources WHERE project_id = ${ctx.project.id} AND origin = 'kb' AND meta->>'section' = 'analysis'`,
  );
  const bad: string[] = [];
  for (const r of rows) {
    const drop = (() => {
      if (dropReason(r.url)) return true;
      const c = classify(ctx, r.url, "analysis", { title: r.title, text: r.text });
      if (c.drop) return true;
      if (c.docsRoot) return true;
      // The project's code at some commit belongs to the code lane (R3-SRC-14).
      if (c.owner === "project_github" && /^(tree|blob|raw|commit|commits|compare)\//.test(githubParts(r.url)?.rest ?? "")) return true;
      if (notProject(c) && (PRICE_CHATTER.test(r.title) || !passesRelevanceGate(r.title, r.text, ctx.registry.aliases))) return true;
      return c;
    })();
    if (drop === true) {
      bad.push(r.id);
      continue;
    }
    // Hack post-mortems were stored as analyses on purpose; any other kind follows the classifier.
    const kind = drop.kind === "news" ? "analysis" : drop.kind;
    if (kind !== r.kind || drop.sourceClass !== r.sourceClass)
      await ctx.db.update(schema.sources).set({ kind, sourceClass: drop.sourceClass }).where(eq(schema.sources.id, r.id));
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
      sql`meta->>'lane' = 'analysis' AND id NOT IN (SELECT id FROM sources WHERE project_id = ${ctx.project.id} AND meta->>'lane' = 'analysis' ORDER BY coalesce(date, '') DESC, fetched_at DESC LIMIT 100)`,
    )
  ).deleted;
  return n;
}
