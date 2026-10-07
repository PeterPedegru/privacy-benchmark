import { createHash } from "node:crypto";
import type { ProjectSnapshot } from "@pb/core";
import { type CardConfig, cardConfigSchema } from "@pb/core";
import { fmtScore, sharesOf } from "@pb/rubric";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { renderBrandCard, renderCard, renderHomeCard, renderWeightingCard, type WeightingCardData } from "../cards/render.tsx";
import { getDb, schema } from "../db/index.ts";
import { env } from "../env.ts";
import { clientIp, windowLimiter } from "../lib/auth.ts";
import { LruCache } from "../lib/lru.ts";
import { cardLogo } from "../services/logos.ts";
import { resolveSnapshot, snapshotGeneration, visibleSnapshots } from "../services/snapshots.ts";
import { defaultWeighting, findWeighting, openPollRow, pollInfo, type WeightingRow, weightingFor } from "../services/weighting.ts";

export const cardRoutes = new Hono();

/** Resolves refs to visible snapshots, dropping unknown ones. Cached snapshots: cheap. */
export async function resolveVisible(refs: string[]): Promise<ProjectSnapshot[]> {
  const db = getDb();
  const out: ProjectSnapshot[] = [];
  for (const r of refs) {
    const s = await resolveSnapshot(db, r, { visibleOnly: true });
    if (s) out.push(s);
  }
  return out;
}

/** Stable identity of a card config: its normalized form (schema defaults applied, schema key order). */
export function cardKey(cfg: CardConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(cardConfigSchema.parse(cfg)))
    .digest("hex");
}

// ---------- PNG cache and render limits (SEC-4, EFF-31) ----------

/** Rendered PNGs, bounded by bytes. Keys include the publish generation, so a new release never serves a stale card. */
const pngCache = new LruCache<Buffer>({ maxSize: 48 * 1024 * 1024, maxEntries: 2000 });
const inflight = new Map<string, Promise<Buffer | null>>();
const MAX_CONCURRENT_RENDERS = 2;
const MAX_QUEUED_RENDERS = 16;
let rendering = 0;
const waiting: (() => void)[] = [];
/** Ad-hoc `?c=` configs are unbounded, so cache misses are limited per client (the card builder previews a few per minute). */
const adhocRenders = windowLimiter({ limit: 120, windowMs: 10 * 60_000 });

class RenderBusyError extends Error {}

async function withRenderSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (rendering >= MAX_CONCURRENT_RENDERS) {
    if (waiting.length >= MAX_QUEUED_RENDERS) throw new RenderBusyError("Card renderer is busy");
    await new Promise<void>((r) => waiting.push(r));
  } else rendering++;
  try {
    return await fn();
  } finally {
    // Hand the slot straight to the next waiter, so the count never exceeds the limit.
    const next = waiting.shift();
    if (next) next();
    else rendering--;
  }
}

/** Test hook. */
export function clearCardCache() {
  pngCache.clear();
  adhocRenders.reset();
  renders = 0;
}

let renders = 0;
/** Test and diagnostics hook: cache size and how many cards were actually rendered. */
export function cardCacheStats() {
  return { entries: pngCache.size, bytes: pngCache.bytes, renders };
}

type CardResult = { png: Buffer } | { status: 404 | 429 | 503; message: string };

/** Looks up or renders a card. The cache is checked before resolving snapshots, so a hit costs a hash and a map lookup. */
async function cardPng(c: Context, key: string, build: () => Promise<Buffer | null>, opts: { limited?: boolean } = {}): Promise<CardResult> {
  const fullKey = `${await snapshotGeneration(getDb())}:${key}`;
  const hit = pngCache.get(fullKey);
  if (hit) return { png: hit };
  let job = inflight.get(fullKey);
  if (!job) {
    if (opts.limited && !adhocRenders.hit(clientIp(c))) return { status: 429, message: "too many card renders; try again in a few minutes" };
    job = withRenderSlot(() => {
      renders++;
      return build();
    }).finally(() => inflight.delete(fullKey));
    inflight.set(fullKey, job);
  }
  try {
    const png = await job;
    if (!png) return { status: 404, message: "no published projects match" };
    pngCache.set(fullKey, png);
    return { png };
  } catch (e) {
    if (e instanceof RenderBusyError) return { status: 503, message: e.message };
    throw e;
  }
}

function renderConfig(cfg: CardConfig): () => Promise<Buffer | null> {
  return async () => {
    const snaps = await resolveVisible(cfg.projects);
    return snaps.length ? renderCard(cfg, snaps) : null;
  };
}

function decodeConfig(b64: string | undefined): CardConfig | null {
  if (!b64 || b64.length > 4096) return null;
  try {
    const json = Buffer.from(b64, "base64url").toString("utf8");
    const parsed = cardConfigSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function pngResponse(c: Context, r: CardResult, cacheSeconds = 300) {
  if (!("png" in r)) {
    if (r.status === 503) c.header("retry-after", "5");
    return c.text(r.message, r.status);
  }
  return new Response(new Uint8Array(r.png), {
    headers: { "content-type": "image/png", "cache-control": `public, max-age=${cacheSeconds}, stale-while-revalidate=86400` },
  });
}

cardRoutes.get("/og/card.png", async (c) => {
  const cfg = decodeConfig(c.req.query("c"));
  if (!cfg) return c.text("invalid card config", 400);
  return pngResponse(c, await cardPng(c, `cfg:${cardKey(cfg)}`, renderConfig(cfg), { limited: true }));
});

cardRoutes.get("/og/card/:file", async (c) => {
  const id = c.req.param("file").replace(/\.png$/, "");
  const row = (await getDb().select().from(schema.cards).where(eq(schema.cards.id, id)))[0];
  if (!row) return c.text("not found", 404);
  const cfg = cardConfigSchema.safeParse(row.config);
  if (!cfg.success) return c.text("invalid", 400);
  return pngResponse(c, await cardPng(c, `cfg:${cardKey(cfg.data)}`, renderConfig(cfg.data)), 3600);
});

cardRoutes.get("/og/project/:file", async (c) => {
  const slug = c.req.param("file").replace(/\.png$/, "");
  const version = c.req.query("version");
  if (slug.length > 96 || (version?.length ?? 0) > 64) return c.text("not found", 404);
  const cfg = cardConfigSchema.parse({ template: "spotlight", projects: [version ? `${slug}@${version}` : slug], size: "landscape" });
  // Only refs that resolve are rendered, so arbitrary slugs can't fill the cache or the queue.
  if (!(await resolveVisible(cfg.projects)).length) return c.text("not found", 404);
  return pngResponse(c, await cardPng(c, `cfg:${cardKey(cfg)}`, renderConfig(cfg)));
});

/** Default share image: the top five projects by overall score, table card. */
/** The top of the leaderboard as published now, one result per project. */
async function topProjects() {
  return (await visibleSnapshots(getDb()))
    .sort((a, b) => (b.scores.overall ?? -1) - (a.scores.overall ?? -1))
    .filter((s, i, arr) => arr.findIndex((x) => x.project.slug === s.project.slug) === i);
}

/**
 * The landing page's share images: 1200×630 for Open Graph (Slack, LinkedIn, iMessage), 1200×600 for X's large card.
 * Before the first release the page still advertises them, so a branded card stands in.
 */
async function homeImage(c: Context, height: 630 | 600) {
  const top = await topProjects();
  if (!top.length) return pngResponse(c, { png: await renderBrandCard() });
  return pngResponse(c, await cardPng(c, `home:${height}`, () => renderHomeCard(top, height)));
}
cardRoutes.get("/og/home.png", (c) => homeImage(c, 630));
cardRoutes.get("/og/home-x.png", (c) => homeImage(c, 600));

// ---------- community weighting ----------

/** The projects the weighting card shows by their logo (the names as people know them). */
const WEIGHTING_LOGOS: [slug: string, name: string][] = [
  ["aztec", "Aztec"],
  ["zama", "Zama"],
  ["miden", "Miden"],
  ["strk20", "Starknet"],
  ["zksync-prividium", "ZKsync"],
];

/**
 * What the weighting card shows: the open poll and today's weights (/weighting), or one version and how its poll
 * moved it from its base (/weighting/W2).
 */
async function weightingCard(version: WeightingRow | null): Promise<{ key: string; data: WeightingCardData }> {
  const db = getDb();
  const row = version ?? (await defaultWeighting(db))!;
  const w = await weightingFor(db, row.id);
  const base = row.baseId ? await weightingFor(db, row.baseId).catch(() => null) : null;
  const pollRow = version ? null : await openPollRow(db);
  const poll = pollRow ? await pollInfo(db, pollRow) : null;
  const sourcePoll = row.pollId ? (await db.select().from(schema.weightingPolls).where(eq(schema.weightingPolls.id, row.pollId)))[0] : null;
  const daysLeft = poll ? Math.max(0, Math.ceil((Date.parse(poll.closesAt) - Date.now()) / 86_400_000)) : 0;
  const logos = await Promise.all(WEIGHTING_LOGOS.map(async ([slug, name]) => ({ name, src: await cardLogo(db, slug).catch(() => null) })));
  const data: WeightingCardData = {
    mode: version ? "version" : "poll",
    weighting: { label: w.ref.label, title: w.ref.title, source: w.ref.source },
    suites: sharesOf(w.weighting).suites,
    // A version's page shows how its poll moved each weight; the invitation shows today's weights as they stand.
    base: version && base ? sharesOf(base.weighting).suites : null,
    baseLabel: version && base ? base.ref.label : null,
    poll: poll ? { title: poll.title, ballots: poll.ballots, daysLeft } : null,
    ballots: sourcePoll ? sourcePoll.ballots : null,
    logos,
  };
  // Changes with the weighting, the poll's turnout and days left, and which logos loaded.
  const key = `weighting:${row.id}:${poll ? `${poll.id}:${poll.ballots}:${daysLeft}` : "-"}:${logos.map((l) => (l.src ? 1 : 0)).join("")}`;
  return { key, data };
}

async function weightingImage(c: Context, height: 630 | 600, version: WeightingRow | null = null) {
  const { key, data } = await weightingCard(version);
  // Short-lived: the turnout changes while a poll is open.
  return pngResponse(c, await cardPng(c, `${key}:${height}`, () => renderWeightingCard(data, height)), 600);
}
cardRoutes.get("/og/weighting.png", (c) => weightingImage(c, 630));
cardRoutes.get("/og/weighting-x.png", (c) => weightingImage(c, 600));
cardRoutes.get("/og/weighting/:file", async (c) => {
  const ref = c.req.param("file").replace(/\.png$/, "");
  const row = ref.length <= 32 ? await findWeighting(getDb(), ref) : null;
  if (!row) return c.text("not found", 404);
  return weightingImage(c, 630, row);
});

function esc(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export function shareHtml(opts: { title: string; description: string; image: string; redirect: string }) {
  const { title, description, image, redirect } = opts;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0;url=${esc(redirect)}"></head><body><a href="${esc(redirect)}">Continue</a></body></html>`;
}

cardRoutes.get("/c/:id{[a-z0-9]+}", async (c) => {
  const row = (
    await getDb()
      .select()
      .from(schema.cards)
      .where(eq(schema.cards.id, c.req.param("id")))
  )[0];
  if (!row) return c.redirect(`${env.publicUrl}/cards`);
  const cfg = cardConfigSchema.safeParse(row.config);
  const snaps = cfg.success ? await resolveVisible(cfg.data.projects) : [];
  const names = snaps.map((s) => `${s.project.name}${s.version ? ` ${s.version.label}` : ""}`).join(" vs ");
  const title = names ? `${names} · Privacy Benchmark` : "Privacy Benchmark";
  const description = snaps.map((s) => `${s.project.name} ${fmtScore(s.scores.overall)}`).join(" · ");
  return c.html(shareHtml({ title, description, image: `${env.publicUrl}/og/card/${row.id}.png`, redirect: `${env.publicUrl}/cards?id=${row.id}` }));
});
