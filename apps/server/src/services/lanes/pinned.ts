/**
 * Pinned lane (R3-SRC-7): the URLs editors pinned (`origin = 'admin'`), which include the golden evaluations' own
 * citations, are fetched like any knowledge-base page. Every http(s) admin row that is empty, or older than
 * KB_STALE_DAYS and not kept fresh by another lane, is re-read: PDFs through Exa or pdf.js, GitHub `tree` URLs as the
 * folder's README plus its file list, `blob` URLs as raw files, other pages through the extractor with Exa
 * `/contents` as the fallback for pages that need JavaScript. The text goes into the same row; the editor's kind,
 * class and title stay. Failures are listed in the lane note so editors can fix dead seeds.
 */

import { sql } from "drizzle-orm";
import { query } from "../../db/index.ts";
import { env } from "../../env.ts";
import { exaContents, hasExa } from "../../lib/externals.ts";
import { fetchPage } from "../../lib/extract.ts";
import { isNavigationOnly, stripDataUris } from "../../lib/extract-core.ts";
import { FetchAbortedError, throwIfFetchAborted } from "../../lib/fetcher.ts";
import { encodePath, ghRaw } from "../../lib/github.ts";
import { extractPdf } from "../../lib/pdf.ts";
import { githubParts } from "../classify.ts";
import { assertBudget, capContent, contentHash, MAX_PAGE_CHARS, MAX_REPORT_CHARS, noteWrite } from "../kb-store.ts";
import { type LaneContext, mapLimit } from "./context.ts";
import { withHostSlot } from "./crawl.ts";

interface PinnedRow {
  id: string;
  url: string;
  kind: string;
  title: string;
  len: number | null;
  hash: string | null;
}

/** Text for a pinned URL, or null with a reason. */
export async function readPinned(
  ctx: Pick<LaneContext, "gh" | "registry">,
  url: string,
): Promise<{ text: string; title: string | null; status: number } | { error: string }> {
  const gh = githubParts(url);
  const ownRepo = !!gh && ctx.registry.githubOwners.includes(gh.owner.toLowerCase());
  // GitHub folders: the README and the file list (the page itself is a JavaScript app).
  const tree = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/tree\/([^/]+)(?:\/(.*))?$/);
  if (tree) {
    const [, repo, ref, dir = ""] = tree;
    const listing = await ctx.gh
      .getOrNull<{ name: string; type: string; path: string; size: number }[]>(`/repos/${repo}/contents/${encodePath(dir)}?ref=${encodeURIComponent(ref!)}`)
      .catch(() => null);
    if (!Array.isArray(listing)) return { error: "GitHub folder not found" };
    const readme = listing.find((f) => /^readme\.(md|markdown|txt)$/i.test(f.name));
    const body = readme ? await ghRaw(repo!, ref!, readme.path, 2 * 1024 * 1024, { token: ownRepo }).catch(() => null) : null;
    const files = listing.map((f) => `- ${f.type === "dir" ? `${f.path}/` : `${f.path} (${f.size} B)`}`).join("\n");
    return { text: `${body ? `${body.toString("utf8")}\n\n` : ""}## Files in ${repo}/${dir || ""} at ${ref}\n${files}`, title: null, status: 200 };
  }
  const blob = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (blob && !/\.pdf$/i.test(blob[3]!)) {
    const body = await ghRaw(blob[1]!, blob[2]!, decodeURIComponent(blob[3]!), 8 * 1024 * 1024, { token: ownRepo });
    return body ? { text: body.toString("utf8"), title: null, status: 200 } : { error: "file not found on GitHub" };
  }
  if (/\.pdf($|\?)/i.test(new URL(url).pathname)) {
    const pdf = await extractPdf(url, { maxCharacters: 400_000 });
    return { text: pdf.text, title: pdf.title || null, status: 200 };
  }
  let page: Awaited<ReturnType<typeof fetchPage>> | null = null;
  try {
    page = await withHostSlot(url, () => fetchPage(url));
  } catch (e) {
    page = null;
    if (!hasExa()) return { error: (e as Error).message.slice(0, 120) };
  }
  if (page && page.status < 400 && page.markdown.trim().length >= 300 && !isNavigationOnly(page.markdown)) {
    return { text: page.markdown, title: page.title, status: page.status };
  }
  // A page that needs JavaScript, or blocks bots: Exa renders it.
  if (hasExa()) {
    const [r] = await exaContents([url], { maxCharacters: 200_000 }).catch(() => []);
    if (r?.ok && r.text.trim().length >= 200) return { text: r.text, title: r.title || null, status: 200 };
  }
  if (page && page.status >= 400) return { error: `HTTP ${page.status}` };
  return { error: "no readable text" };
}

/** Pinned lane. Returns the count fetched and a note naming failures. */
export async function ingestPinned(ctx: LaneContext, opts: { deadline?: number } = {}): Promise<{ count: number; note: string; partial: boolean }> {
  const staleBefore = new Date(Date.now() - env.kb.staleDays * 86_400_000).toISOString();
  // Admin rows another lane refreshes (a docs page the crawler also reached) are left to that lane unless it stopped.
  const laneStaleBefore = new Date(Date.now() - 2 * env.kb.staleDays * 86_400_000).toISOString();
  const rows = await query<PinnedRow>(
    ctx.db,
    sql`SELECT id, url, kind, title, content_len AS len, content_hash AS hash FROM sources
       WHERE project_id = ${ctx.project.id} AND origin = 'admin' AND kind <> 'editor_note' AND (url LIKE 'http://%' OR url LIKE 'https://%')
         AND (coalesce(content_len, 0) = 0
              OR ((meta->>'lane') IS NULL AND fetched_at < ${staleBefore})
              OR ((meta->>'lane') IS NOT NULL AND fetched_at < ${laneStaleBefore}))
       ORDER BY coalesce(content_len, 0) ASC LIMIT 60`,
  );
  const failed: string[] = [];
  let fetched = 0;
  const update = (content: string, hash: string, status: number, at: string, title: string, id: string) =>
    ctx.db.execute(
      sql`UPDATE sources SET content_md = ${content}, content_hash = ${hash}, http_status = ${status}, fetched_at = ${at},
        title = CASE WHEN title = '' OR title = url THEN ${title} ELSE title END,
        meta = meta || jsonb_build_object('pinnedAt', ${at}::text, 'pinnedError', NULL) WHERE id = ${id}`,
    );
  const touch = (at: string, id: string) =>
    ctx.db.execute(sql`UPDATE sources SET fetched_at = ${at}, meta = meta || jsonb_build_object('pinnedAt', ${at}::text) WHERE id = ${id}`);
  const mark = (error: string, id: string) =>
    ctx.db.execute(sql`UPDATE sources SET meta = meta || jsonb_build_object('pinnedError', ${error}::text) WHERE id = ${id}`);
  await mapLimit(rows, 4, async (r) => {
    throwIfFetchAborted();
    if (opts.deadline && Date.now() > opts.deadline) return;
    try {
      const got = await readPinned(ctx, r.url);
      if ("error" in got) {
        failed.push(`${r.url} (${got.error})`);
        await mark(got.error.slice(0, 200), r.id);
        return;
      }
      // Pages are capped like any web page; reports and code files keep more (R3-SEC-8).
      const text = capContent(stripDataUris(got.text), ["audit", "code", "l2beat", "defillama"].includes(r.kind) ? MAX_REPORT_CHARS : MAX_PAGE_CHARS);
      const hash = contentHash(text);
      const now = new Date().toISOString();
      if (hash === r.hash) {
        await touch(now, r.id);
      } else {
        const delta = text.length - (r.len ?? 0);
        await assertBudget(ctx.db, ctx.project.id, delta);
        await update(text, hash, got.status, now, (got.title ?? "").slice(0, 300) || r.title, r.id);
        noteWrite(ctx.project.id, delta);
      }
      fetched++;
    } catch (e) {
      if (e instanceof FetchAbortedError) throw e;
      failed.push(`${r.url} (${(e as Error).message.slice(0, 80)})`);
      await mark((e as Error).message.slice(0, 200), r.id);
    }
  });
  const note = `${fetched} fetched, ${failed.length} failed${failed.length ? `: ${failed.slice(0, 6).join("; ")}${failed.length > 6 ? "; …" : ""}` : ""}`;
  return { count: fetched, note, partial: rows.length > 0 && failed.length / rows.length > 0.1 };
}
