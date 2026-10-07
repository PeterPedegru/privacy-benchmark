import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { fmtScore, privacyText } from "@pb/rubric";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { getDb } from "./db/index.ts";
import { env, REPO_ROOT } from "./env.ts";
import { adminRoutes } from "./routes/admin.ts";
import { cardRoutes } from "./routes/cards.ts";
import { publicRoutes } from "./routes/public.ts";
import { weightingRoutes } from "./routes/weighting.ts";
import { healthReport } from "./services/health.ts";
import { resolveSnapshot } from "./services/snapshots.ts";
import { findWeighting, openPollRow } from "./services/weighting.ts";

export const PUBLIC_BODY_LIMIT = 16 * 1024;
export const ADMIN_BODY_LIMIT = 3 * 1024 * 1024;
const IMMUTABLE = "public, max-age=31536000, immutable";

type ContentSecurityPolicyOptions = NonNullable<NonNullable<Parameters<typeof secureHeaders>[0]>["contentSecurityPolicy"]>;

/** CSP `'sha256-…'` sources for each inline `<script>` in the page (the theme bootstrap in apps/web/index.html). */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(m[1] ?? "")) continue;
    out.push(
      `'sha256-${createHash("sha256")
        .update(m[2] ?? "", "utf8")
        .digest("base64")}'`,
    );
  }
  return out;
}

/**
 * Privacy-friendly analytics (Plausible: no cookies, no personal data), on privacybenchmark.org's public pages only.
 * A fork's deployment, local development and the tests send nothing; ANALYTICS_SCRIPT_URL sets another script, and
 * an empty one turns it off.
 */
const PLAUSIBLE_SCRIPT = "https://plausible.io/js/pa-NjSs7rPY4Yv8Pd5YCZTfH.js";
const PLAUSIBLE_INIT =
  "window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()";
export function analyticsScript(publicUrl: string = env.publicUrl): string | null {
  const configured = process.env.ANALYTICS_SCRIPT_URL;
  if (configured !== undefined) return configured || null;
  return new URL(publicUrl).hostname === "privacybenchmark.org" ? PLAUSIBLE_SCRIPT : null;
}

/** The page with the analytics snippet before </head>. */
export function withAnalytics(html: string, scriptUrl: string): string {
  return html.replace("</head>", () => `<script async src="${scriptUrl}"></script><script>${PLAUSIBLE_INIT}</script></head>`);
}

/** Admin pages and endpoints: never analytics, and the strict policy whatever the public pages allow. */
export const isAdminPath = (p: string) => p === "/admin" || p.startsWith("/admin/") || p.startsWith("/api/admin/");

/**
 * The admin shares an origin with the public site and its CSRF cookie is readable from JS, so any script injection
 * would be an admin takeover. Scripts: our own files plus the hashed inline scripts, nothing else; public pages
 * also allow the analytics origin (`analytics`), which admin pages never load. Images: our own origin only, since
 * project logos are proxied (SEC-17).
 */
export function contentSecurityPolicy(scriptHashes: string[], opts: { analytics?: string | null } = {}): ContentSecurityPolicyOptions {
  const analytics = opts.analytics ? [new URL(opts.analytics).origin] : [];
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", ...scriptHashes, ...analytics],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "blob:"],
    fontSrc: ["'self'", "data:"],
    connectSrc: ["'self'", ...analytics],
    mediaSrc: ["'self'"],
    workerSrc: ["'self'", "blob:"],
    manifestSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  };
}

/** A policy as a Content-Security-Policy header value. */
export function cspHeader(o: ContentSecurityPolicyOptions): string {
  return Object.entries(o)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)} ${(v as string[]).join(" ")}`)
    .join("; ");
}

/** Paths other sites may embed: share images and pages, and proxied logos. Everything else is same-origin only. */
const isShareable = (p: string) => p.startsWith("/og/") || p.startsWith("/c/") || p.startsWith("/api/public/logo");

export function createApp(opts: { analytics?: string | null } = {}) {
  const app = new Hono();
  const dist = resolve(REPO_ROOT, "apps/web/dist");
  const indexPath = resolve(dist, "index.html");
  const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
  // Public pages carry the analytics snippet; admin pages get the page without it, under the strict policy.
  const analytics = opts.analytics !== undefined ? opts.analytics : analyticsScript();
  const publicHtml = indexHtml && analytics ? withAnalytics(indexHtml, analytics) : indexHtml;
  const adminCsp = cspHeader(contentSecurityPolicy(indexHtml ? inlineScriptHashes(indexHtml) : []));

  if (!process.env.VITEST) app.use("*", logger());

  // Per-path headers. Registered before secureHeaders so it runs after it on the way out and can override.
  app.use("*", async (c, next) => {
    await next();
    const p = c.req.path;
    c.header("Cross-Origin-Resource-Policy", isShareable(p) ? "cross-origin" : "same-origin");
    if (p.startsWith("/api/admin/")) c.header("Cache-Control", "no-store");
    if (isAdminPath(p)) c.header("Content-Security-Policy", adminCsp);
    // A proxied SVG opened directly must not run script on our origin.
    if (p.startsWith("/api/public/logo")) c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (p.startsWith("/assets/") && c.res.status === 200) c.header("Cache-Control", IMMUTABLE);
  });
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: contentSecurityPolicy(publicHtml ? inlineScriptHashes(publicHtml) : [], { analytics }),
      crossOriginResourcePolicy: false,
      permissionsPolicy: {
        camera: [],
        microphone: [],
        geolocation: [],
        payment: [],
        usb: [],
        browsingTopics: [],
      },
    }),
  );
  // Compresses JSON, HTML, JS and CSS (not images, and never the admin event stream). Precompressed static files win.
  app.use("*", compress());
  const tooLarge = (c: Context) => c.json({ error: "payload_too_large" }, 413);
  app.use("/api/public/*", bodyLimit({ maxSize: PUBLIC_BODY_LIMIT, onError: tooLarge }));
  app.use("/api/admin/*", bodyLimit({ maxSize: ADMIN_BODY_LIMIT, onError: tooLarge }));

  app.get("/api/health", async (c) => {
    const report = await healthReport(getDb);
    return c.json(report, report.ok ? 200 : 503, { "cache-control": "no-store" });
  });
  app.route("/api/public", weightingRoutes);
  app.route("/api/public", publicRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/", cardRoutes);
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  app.all("/og/*", (c) => c.text("not found", 404));

  // Production: serve the built SPA, injecting Open Graph tags for shareable pages.
  if (indexHtml && publicHtml) {
    const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
    // A function replacer, so `$&`, `` $` `` and `$'` in a project name are inserted literally (SEC-16).
    // Link previews: Open Graph (Slack, LinkedIn, iMessage, Discord) and X's large card, which takes its own 2:1 image.
    const withMeta = (m: { title: string; description: string; url: string; image: string; xImage: string; alt: string }) =>
      publicHtml.replace("</head>", () =>
        [
          `<meta property="og:type" content="website">`,
          `<meta property="og:site_name" content="Privacy Benchmark">`,
          `<meta property="og:url" content="${esc(m.url)}">`,
          `<meta property="og:title" content="${esc(m.title)}">`,
          `<meta property="og:description" content="${esc(m.description)}">`,
          `<meta property="og:image" content="${esc(m.image)}">`,
          `<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
          `<meta property="og:image:alt" content="${esc(m.alt)}">`,
          `<meta name="twitter:card" content="summary_large_image">`,
          `<meta name="twitter:title" content="${esc(m.title)}">`,
          `<meta name="twitter:description" content="${esc(m.description)}">`,
          `<meta name="twitter:image" content="${esc(m.xImage)}">`,
          `<meta name="twitter:image:alt" content="${esc(m.alt)}">`,
          "</head>",
        ].join(""),
      );
    // The page shell must be revalidated so a deploy's new asset hashes are picked up immediately.
    const page = (c: Context, html: string) => c.html(html, 200, { "cache-control": "no-cache" });
    const home = withMeta({
      title: "Privacy Benchmark: privacy systems, ranked",
      description:
        "Crypto privacy systems ranked on a published rubric: what's hidden from the public and from operators, and who can stop you. Every score sourced. Open source.",
      url: `${env.publicUrl}/`,
      image: `${env.publicUrl}/og/home.png`,
      xImage: `${env.publicUrl}/og/home-x.png`,
      alt: "The Privacy Benchmark leaderboard: each project's Public and Operator privacy scores and its overall score",
    });

    app.use("/assets/*", serveStatic({ root: dist, precompressed: true }));
    // A missing hashed asset (a tab left open across a deploy) must 404, not get the SPA shell as JavaScript.
    app.all("/assets/*", (c) => c.text("not found", 404, { "cache-control": "no-store" }));
    app.use("/fonts/*", serveStatic({ root: dist, precompressed: true }));
    app.all("/fonts/*", (c) => c.text("not found", 404));
    app.get("/favicon.svg", serveStatic({ root: dist }));
    app.get("/projects/:slug", async (c) => {
      const s = await resolveSnapshot(getDb(), c.req.param("slug"), { visibleOnly: true });
      if (!s) return page(c, home);
      return page(
        c,
        withMeta({
          title: `${s.project.name} · Privacy Benchmark`,
          description: `${s.project.name} scores ${fmtScore(s.scores.overall)} · ${privacyText(s.scores.level, s.scores.trustTier)}. ${s.project.tagline}`,
          url: `${env.publicUrl}/projects/${s.project.slug}`,
          image: `${env.publicUrl}/og/project/${s.project.slug}.png`,
          xImage: `${env.publicUrl}/og/project/${s.project.slug}.png`,
          alt: `${s.project.name} on the Privacy Benchmark: overall score, privacy scores and suite scores`,
        }),
      );
    });
    // Community weighting: the open poll's invitation, and each weighting version.
    app.get("/weighting", async (c) => {
      const poll = await openPollRow(getDb()).catch(() => null);
      return page(
        c,
        withMeta({
          title: poll ? "Vote on the weights · Privacy Benchmark" : "Community weighting · Privacy Benchmark",
          description: poll
            ? "How much should each part of privacy count? The community weighting poll is open: one ballot per X account, and the result scores the next benchmark run."
            : "The Privacy Benchmark's weights are set in public: a five-day poll before each run, one ballot per X account, and the median ballot wins.",
          url: `${env.publicUrl}/weighting`,
          image: `${env.publicUrl}/og/weighting.png`,
          xImage: `${env.publicUrl}/og/weighting-x.png`,
          alt: "Privacy Benchmark community weighting: how much each of the seven suites counts, set by public vote",
        }),
      );
    });
    app.get("/weighting/:ref", async (c) => {
      const row = await findWeighting(getDb(), c.req.param("ref")).catch(() => null);
      if (!row) return page(c, home);
      const label = `W${row.number}`;
      return page(
        c,
        withMeta({
          title: `${label}: ${row.title} · Privacy Benchmark`,
          description:
            row.source === "poll"
              ? `${label}, the Privacy Benchmark weights the community voted for: how much each part of privacy counts, and what changed.`
              : `${label}, the rubric's own weights: how much each part of privacy counts in the Privacy Benchmark.`,
          url: `${env.publicUrl}/weighting/${label}`,
          image: `${env.publicUrl}/og/weighting/${label}.png`,
          xImage: `${env.publicUrl}/og/weighting/${label}.png`,
          alt: `Privacy Benchmark weighting ${label}: how much each of the seven suites counts`,
        }),
      );
    });
    // Admin pages: the page as built, without the analytics snippet (their policy wouldn't allow it anyway).
    app.get("*", (c) => page(c, isAdminPath(c.req.path) ? indexHtml : home));
  }
  return app;
}
