import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { fmtScore } from "@pb/rubric";
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
import { healthReport } from "./services/health.ts";
import { resolveSnapshot } from "./services/snapshots.ts";

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
 * The admin shares an origin with the public site and its CSRF cookie is readable from JS, so any script injection
 * would be an admin takeover. Scripts: our own files plus the hashed inline theme script, nothing else. Images:
 * our own origin only, since project logos are proxied (SEC-17).
 */
export function contentSecurityPolicy(scriptHashes: string[]): ContentSecurityPolicyOptions {
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", ...scriptHashes],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "blob:"],
    fontSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
    mediaSrc: ["'self'"],
    workerSrc: ["'self'", "blob:"],
    manifestSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  };
}

/** Paths other sites may embed: share images and pages, and proxied logos. Everything else is same-origin only. */
const isShareable = (p: string) => p.startsWith("/og/") || p.startsWith("/c/") || p.startsWith("/api/public/logo");

export function createApp() {
  const app = new Hono();
  const dist = resolve(REPO_ROOT, "apps/web/dist");
  const indexPath = resolve(dist, "index.html");
  const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;

  if (!process.env.VITEST) app.use("*", logger());

  // Per-path headers. Registered before secureHeaders so it runs after it on the way out and can override.
  app.use("*", async (c, next) => {
    await next();
    const p = c.req.path;
    c.header("Cross-Origin-Resource-Policy", isShareable(p) ? "cross-origin" : "same-origin");
    if (p.startsWith("/api/admin/")) c.header("Cache-Control", "no-store");
    // A proxied SVG opened directly must not run script on our origin.
    if (p.startsWith("/api/public/logo")) c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (p.startsWith("/assets/") && c.res.status === 200) c.header("Cache-Control", IMMUTABLE);
  });
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: contentSecurityPolicy(indexHtml ? inlineScriptHashes(indexHtml) : []),
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
  app.route("/api/public", publicRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/", cardRoutes);
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
  app.all("/og/*", (c) => c.text("not found", 404));

  // Production: serve the built SPA, injecting Open Graph tags for shareable pages.
  if (indexHtml) {
    const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
    // A function replacer, so `$&`, `` $` `` and `$'` in a project name are inserted literally (SEC-16).
    const withMeta = (title: string, description: string, image: string) =>
      indexHtml.replace(
        "</head>",
        () =>
          `<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:image" content="${esc(image)}"><meta name="twitter:card" content="summary_large_image"></head>`,
      );
    // The page shell must be revalidated so a deploy's new asset hashes are picked up immediately.
    const page = (c: Context, html: string) => c.html(html, 200, { "cache-control": "no-cache" });
    const home = withMeta("Privacy Benchmark", "Who can see, stop or seize your private transactions? Every number sourced.", `${env.publicUrl}/og/home.png`);

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
        withMeta(
          `${s.project.name} · Privacy Benchmark`,
          `${s.project.name} scores ${fmtScore(s.scores.overall)} (${s.scores.level ?? "—"}).`,
          `${env.publicUrl}/og/project/${s.project.slug}.png`,
        ),
      );
    });
    app.get("*", (c) => page(c, home));
  }
  return app;
}
