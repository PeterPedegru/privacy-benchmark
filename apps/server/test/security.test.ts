import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { criteria, lowestOption } from "@pb/rubric";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { contentSecurityPolicy, createApp, inlineScriptHashes } from "../src/app.ts";
import { type DB, getDb, openDb, schema, setDb } from "../src/db/index.ts";
import { costCapFor, env } from "../src/env.ts";
import { requeueInterrupted } from "../src/eval/queue.ts";
import {
  checkPassword,
  checkSecretsAtBoot,
  clientIp,
  DEVICE_COOKIE,
  loginAllowed,
  recordLoginFailure,
  resetLoginLimits,
  SLOWED_INTERVAL_MS,
  windowLimiter,
} from "../src/lib/auth.ts";
import { limiter } from "../src/lib/llm.ts";
import { LruCache } from "../src/lib/lru.ts";
import { rpcErrorMessage, upstreamError } from "../src/lib/redact.ts";
import { inspectAddress } from "../src/lib/rpc.ts";
import { cardCacheStats, clearCardCache } from "../src/routes/cards.ts";
import { cardIdFor, csvField } from "../src/routes/public.ts";
import { importGoldenAsDemo } from "../src/services/demo.ts";
import type { GoldenFile } from "../src/services/golden.ts";
import { publicSettings, publishRelease, snapshotGeneration, unpublishProject } from "../src/services/snapshots.ts";
import { nextVersionCheckDelay } from "../src/services/versions.ts";

const SOURCE = "Gamma has no pause function. Users hold their own viewing keys.";

function golden(slug: string, name: string, best: boolean): GoldenFile {
  return {
    project: {
      slug,
      name,
      website: `https://${slug}.example.org`,
      logoUrl: `https://${slug}.example.org/logo.png`,
      tagline: "Fixture",
      description: "A fixture.",
      category: "l2",
      mechanism: "private_execution",
      attributes: [],
      chains: ["Ethereum"],
    },
    asOf: "2026-09-30",
    summary: "Fixture summary.",
    context: {},
    powers: [],
    sources: [
      { id: "landscape", url: `https://notes.example.org/${slug}`, title: "Notes", kind: "editor_note", sourceClass: "independent", date: "2026-09-30" },
    ],
    answers: criteria.map((c) => {
      const opt = best ? c.options.reduce((a, b) => (b.points > a.points ? b : a)) : lowestOption(c);
      return { criterionId: c.id, status: "answered" as const, optionId: opt.id, rationale: "Fixture.", confidence: "high" as const, evidence: [] };
    }),
    matrix: {},
  };
}

/** A non-demo evaluation for `slug`, carrying pipeline working state in its settings like a real run does. */
async function realEvaluation(db: DB, slug: string, name: string, best: boolean): Promise<string> {
  const id = await importGoldenAsDemo(db, golden(slug, name, best), SOURCE);
  await db
    .update(schema.evaluations)
    .set({
      isDemo: false,
      settings: {
        mode: "standard",
        models: { judge: "claude-opus-5-5" },
        evidenceCutoff: "2026-09-30",
        coverageNotes: "SCOUT NOTES: internal, unreviewed",
        codeNotes: "CODE NOTES: internal, unreviewed",
        research: ["custody"],
        judge: ["custody"],
        knowledgeBase: { docs: 3 },
      },
    })
    .where(eq(schema.evaluations.id, id));
  return id;
}

const projectId = async (db: DB, slug: string) => (await db.select().from(schema.projects).where(eq(schema.projects.slug, slug)))[0]!.id;

let app: ReturnType<typeof createApp>;
let db: DB;

async function login(ip = "198.51.100.10", password = env.adminPassword) {
  const res = await app.request("/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: JSON.stringify({ password }),
  });
  const cookies = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { res, cookies, csrf: /pb_csrf=([^;]+)/.exec(cookies)?.[1] ?? "" };
}

beforeAll(async () => {
  db = await openDb({ log: () => {} });
  setDb(db);
  app = createApp();
});

beforeEach(() => {
  resetLoginLimits();
  clearCardCache();
});

// ---------- SEC-1 ----------

describe("client IP and login throttling", () => {
  const ipOf = async (headers: Record<string, string>) => {
    const probe = new Hono().get("/", (c) => c.text(clientIp(c)));
    return (await probe.request("/", { headers })).text();
  };

  it("keys on X-Real-IP, else the rightmost public X-Forwarded-For hop, never the client-supplied leftmost one", async () => {
    expect(await ipOf({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 203.0.113.7" })).toBe("203.0.113.7");
    expect(await ipOf({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" })).toBe("203.0.113.9");
    // Railway's internal proxy hops (100.64.0.0/10) and private hops are skipped.
    expect(await ipOf({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 100.64.3.2, 10.0.0.1" })).toBe("203.0.113.9");
    expect(await ipOf({ "x-forwarded-for": "garbage, 203.0.113.9" })).toBe("203.0.113.9");
    // Only internal hops: the rightmost one, still never the leftmost.
    expect(await ipOf({ "x-forwarded-for": "10.9.9.9, 100.64.0.1" })).toBe("100.64.0.1");
    expect(await ipOf({ "x-real-ip": "::ffff:203.0.113.5" })).toBe("203.0.113.5");
    expect(await ipOf({})).toBe("unknown");
  });

  it("rotating a spoofed X-Forwarded-For no longer gives fresh attempts", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `9.9.9.${i}, 203.0.113.50` },
        body: JSON.stringify({ password: "wrong-password" }),
      });
      expect(res.status).toBe(401);
    }
    const sixth = await app.request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.99, 203.0.113.50" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    expect(sixth.status).toBe(429);
  });

  it("slows every new device after 30 failures from anywhere, without locking out a known one (R3-SEC-7)", async () => {
    // A browser that signed in before the attack.
    const before = await login("192.0.2.150");
    expect(before.res.status).toBe(200);
    const device = before.res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((c) => c.startsWith(`${DEVICE_COOKIE}=`))!;
    expect(device).toBeTruthy();

    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      const ip = `198.51.100.${i + 1}`;
      expect(loginAllowed(ip, now).ok).toBe(true);
      recordLoginFailure(ip, now);
    }
    // Unknown devices share one attempt every 10 s.
    expect(loginAllowed("192.0.2.200", now).ok).toBe(true);
    expect(loginAllowed("192.0.2.201", now + 1000)).toEqual({ ok: false, reason: "slowed", retryAfterSeconds: 9 });
    expect(loginAllowed("192.0.2.202", now + SLOWED_INTERVAL_MS + 1).ok).toBe(true);
    const slowed = await login("192.0.2.203");
    expect(slowed.res.status).toBe(429);
    expect(slowed.res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(((await slowed.res.json()) as { error: string }).error).toBe("login_slowed");

    // The known device still signs in at once; a forged marker doesn't count.
    const known = await app.request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "192.0.2.150", cookie: device },
      body: JSON.stringify({ password: env.adminPassword }),
    });
    expect(known.status).toBe(200);
    const forged = await app.request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "192.0.2.151", cookie: `${DEVICE_COOKIE}=device.9999999999999.x.y.forged` },
      body: JSON.stringify({ password: env.adminPassword }),
    });
    expect(forged.status).toBe(429);
    // The window ends.
    expect(loginAllowed("192.0.2.204", now + 11 * 60_000).ok).toBe(true);
  });

  it("refuses weak credentials on any deployment, not only with NODE_ENV=production (R3-SEC-11)", () => {
    const logs: string[] = [];
    // The test environment's SESSION_SECRET is short: fine locally, fatal on a Railway environment.
    expect(checkSecretsAtBoot((m) => logs.push(m))).toBe(true);
    vi.stubEnv("RAILWAY_ENVIRONMENT", "production");
    try {
      expect(checkSecretsAtBoot((m) => logs.push(m))).toBe(false);
      expect(logs.at(-1)).toMatch(/Refusing to start/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("bounds the attempts map", () => {
    const l = windowLimiter({ limit: 1, windowMs: 60_000, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) l.hit(`ip-${i}`);
    expect(l.size()).toBeLessThanOrEqual(100);
  });

  it("checks the password with async scrypt and caps its length", async () => {
    const pending = checkPassword(env.adminPassword);
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toBe(true);
    expect(await checkPassword("wrong-password")).toBe(false);
    expect(await checkPassword(`${env.adminPassword}${"x".repeat(300)}`)).toBe(false);
    expect(await checkPassword("x".repeat(100_000))).toBe(false);
    expect(await checkPassword(undefined)).toBe(false);
    expect(await checkPassword({ toString: () => env.adminPassword })).toBe(false);
  });
});

// ---------- SEC-11, SEC-12 ----------

describe("admin auth", () => {
  it("only exact login/logout/me paths skip auth (no suffix bypass)", async () => {
    expect((await app.request("/api/admin/sources/login", { method: "DELETE" })).status).toBe(401);
    expect((await app.request("/api/admin/corrections/logout", { method: "PATCH", body: "{}" })).status).toBe(401);
    expect((await app.request("/api/admin/versions/me", { method: "DELETE" })).status).toBe(401);
    expect((await app.request("/api/admin/login", { method: "GET" })).status).toBe(401);
    expect((await app.request("/api/admin/me")).status).toBe(200);
  });

  it("revokes sessions when ADMIN_PASSWORD changes, and on logout", async () => {
    const original = env.adminPassword;
    const s = await login();
    expect(s.res.status).toBe(200);
    expect((await app.request("/api/admin/overview", { headers: { cookie: s.cookies } })).status).toBe(200);
    env.adminPassword = "a-brand-new-password-123";
    try {
      expect((await app.request("/api/admin/overview", { headers: { cookie: s.cookies } })).status).toBe(401);
      expect(await (await app.request("/api/admin/me", { headers: { cookie: s.cookies } })).json()).toMatchObject({ admin: false });
    } finally {
      env.adminPassword = original;
    }
    expect((await app.request("/api/admin/overview", { headers: { cookie: s.cookies } })).status).toBe(200);
    // Logout needs the CSRF header while the session is live, then the cookie stops working server-side too.
    expect((await app.request("/api/admin/logout", { method: "POST", headers: { cookie: s.cookies } })).status).toBe(403);
    expect((await app.request("/api/admin/logout", { method: "POST", headers: { cookie: s.cookies, "x-csrf-token": s.csrf } })).status).toBe(200);
    expect((await app.request("/api/admin/overview", { headers: { cookie: s.cookies } })).status).toBe(401);
  });

  it("uses plain cookie names over http (PUBLIC_URL decides Secure, not NODE_ENV)", async () => {
    const { res } = await login("198.51.100.77");
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toMatch(/pb_session=.*HttpOnly/);
    expect(set).toContain("SameSite=Strict");
    expect(set).not.toContain("Secure");
  });
});

// ---------- SEC-13, SEC-4 body limits ----------

describe("response headers", () => {
  it("sets CSP, Permissions-Policy, CORP and no-store where they belong", async () => {
    const pub = await app.request("/api/public/meta");
    const csp = pub.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')*;/);
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(pub.headers.get("permissions-policy")).toContain("camera=()");
    expect(pub.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(pub.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await app.request("/og/home.png")).headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    const admin = await app.request("/api/admin/me");
    expect(admin.headers.get("cache-control")).toBe("no-store");
  });

  it("hashes the inline theme script exactly", () => {
    const body = '\n      try { document.documentElement.classList.add("dark"); } catch (e) {}\n    ';
    const html = `<head><script>${body}</script><script type="module" src="/assets/x.js"></script></head>`;
    const hashes = inlineScriptHashes(html);
    expect(hashes).toHaveLength(1);
    const expected = `'sha256-${createHash("sha256").update(body).digest("base64")}'`;
    expect(hashes[0]).toBe(expected);
    expect(contentSecurityPolicy(hashes).scriptSrc).toEqual(["'self'", expected]);
    // The real built page, when present, gets its theme script allowed.
    try {
      const built = readFileSync(resolve(import.meta.dirname, "../../web/dist/index.html"), "utf8");
      expect(inlineScriptHashes(built).length).toBeGreaterThan(0);
    } catch {
      // web not built in this environment
    }
  });

  it("rejects oversized bodies: 16 KB public, 1 KB login, 3 MB admin", async () => {
    const big = (n: number) => JSON.stringify({ message: "x".repeat(n) });
    const pub = await app.request("/api/public/corrections", { method: "POST", headers: { "content-type": "application/json" }, body: big(20_000) });
    expect(pub.status).toBe(413);
    const ok = await app.request("/api/public/corrections", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.200" },
      body: JSON.stringify({ projectSlug: "gamma", message: "This number looks wrong to me." }),
    });
    expect(ok.status).toBe(200);
    const loginBody = await app.request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "x".repeat(2000) }),
    });
    expect(loginBody.status).toBe(413);
    const admin = await app.request("/api/admin/projects", { method: "POST", headers: { "content-type": "application/json" }, body: big(3.2 * 1024 * 1024) });
    expect(admin.status).toBe(413);
  });

  it("rejects javascript: and data: URLs in public input", async () => {
    for (const evidenceUrl of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>"]) {
      const res = await app.request("/api/public/corrections", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.201" },
        body: JSON.stringify({ projectSlug: "gamma", message: "This number looks wrong to me.", evidenceUrl }),
      });
      expect(res.status, evidenceUrl).toBe(400);
    }
  });
});

// ---------- published data: SEC-5, SEC-10, SEC-15, EFF-1, SEC-4 cards ----------

describe("published data", () => {
  let gamma1: string;
  let delta: string;

  beforeAll(async () => {
    gamma1 = await realEvaluation(db, "gamma", '=HYPERLINK("https://evil.example","Gamma")', true);
    delta = await realEvaluation(db, "delta", "Delta", false);
  });

  it("caches the leaderboard behind an ETag that changes on publish", async () => {
    const empty = await app.request("/api/public/leaderboard");
    const etag0 = empty.headers.get("etag")!;
    expect(etag0).toMatch(/^W\/"/);
    // Revalidated on every use, so a change shows on the next load; the ETag keeps that a 304 otherwise.
    expect(empty.headers.get("cache-control")).toBe("public, no-cache");
    expect((await app.request("/api/public/leaderboard", { headers: { "if-none-match": etag0 } })).status).toBe(304);
    const gen = await snapshotGeneration(db);
    await publishRelease(db, { evaluationIds: [gamma1, delta], label: "R1", notes: "" });
    expect(await snapshotGeneration(db)).toBeGreaterThan(gen);
    const fresh = await app.request("/api/public/leaderboard", { headers: { "if-none-match": etag0 } });
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("etag")).not.toBe(etag0);
    const body = (await fresh.json()) as { rows: { slug: string }[]; release: { settings: Record<string, unknown> } };
    expect(body.rows.map((r) => r.slug).sort()).toEqual(["delta", "gamma"]);
    // SEC-5: internal working state is never published.
    expect(Object.keys(body.release.settings).sort()).toEqual(["evidenceCutoff", "mode", "models"]);
  });

  it("filters release settings at write time, at read time, and in the migration", async () => {
    const rel = (await db.select().from(schema.releases).where(eq(schema.releases.label, "R1")))[0]!;
    expect(rel.evalSettings).not.toHaveProperty("coverageNotes");
    // A row written before the fix still has the internal notes...
    await db
      .update(schema.releases)
      .set({ evalSettings: { mode: "standard", coverageNotes: "leak", codeNotes: "leak", research: ["x"], judge: ["x"], knowledgeBase: {}, goldenEval: {} } })
      .where(eq(schema.releases.id, rel.id));
    // ...which the public API filters on the way out...
    const res = await (await app.request(`/api/public/releases/${rel.id}/settings`)).json();
    expect(res.settings).toEqual({ mode: "standard" });
    // (Stored settings were stripped by a SQLite-era migration before the move to Postgres; new releases only store
    // public settings.)
    expect(publicSettings({ mode: "deep", notes: "n", codeNotes: "x" })).toEqual({ mode: "deep", notes: "n" });
  });

  it("escapes spreadsheet formulas in CSV exports", async () => {
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("+cmd")).toBe("'+cmd");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvField("-2+3")).toBe("'-2+3");
    expect(csvField("\tx")).toBe("'\tx");
    expect(csvField("-12.5")).toBe("-12.5");
    expect(csvField('a "b", c')).toBe('"a ""b"", c"');
    expect(csvField("plain")).toBe("plain");
    const rel = (await db.select().from(schema.releases).where(eq(schema.releases.label, "R1")))[0]!;
    const csv = await (await app.request(`/api/public/releases/${rel.id}/export.csv`)).text();
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.example"",""Gamma"")"`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it("keeps superseded results in history but drops withdrawn and archived ones from history and exports", async () => {
    const r1 = (await db.select().from(schema.releases).where(eq(schema.releases.label, "R1")))[0]!;
    const gamma2 = await realEvaluation(db, "gamma", "Gamma", false);
    await publishRelease(db, { evaluationIds: [gamma2], label: "R2", notes: "" });
    const r2 = (await db.select().from(schema.releases).where(eq(schema.releases.label, "R2")))[0]!;
    const hist = async () =>
      ((await (await app.request("/api/public/projects/gamma")).json()) as { history: { release: { label: string } }[] }).history.map((h) => h.release.label);
    expect(await hist()).toEqual(["R2", "R1"]);
    expect((await app.request(`/api/public/releases/${r1.id}/export.json`)).status).toBe(200);

    // Withdraw R2's result: it leaves history and R2's export; R1's result is current again.
    await unpublishProject(db, await projectId(db, "gamma"));
    expect(await hist()).toEqual(["R1"]);
    expect((await app.request(`/api/public/releases/${r2.id}/export.json`)).status).toBe(404);
    expect((await app.request(`/api/public/releases/${r2.id}/export.csv`)).status).toBe(404);
    const releases = (await (await app.request("/api/public/releases")).json()) as { id: string; projects: number }[];
    expect(releases.find((r) => r.id === r2.id)?.projects).toBe(0);

    // Archive delta (no bumpSnapshots call): the cache notices, and the exports drop it.
    await db.update(schema.projects).set({ status: "archived" }).where(eq(schema.projects.slug, "delta"));
    const lb = (await (await app.request("/api/public/leaderboard")).json()) as { rows: { slug: string }[] };
    expect(lb.rows.map((r) => r.slug)).toEqual(["gamma"]);
    const exp = (await (await app.request(`/api/public/releases/${r1.id}/export.json`)).json()) as { snapshots: { project: { slug: string } }[] };
    expect(exp.snapshots.map((s) => s.project.slug)).toEqual(["gamma"]);
    expect((await app.request("/api/public/projects/delta")).status).toBe(404);
    await db.update(schema.projects).set({ status: "active" }).where(eq(schema.projects.slug, "delta"));
  });

  it("validates card refs, collapses duplicates and rate-limits creation", async () => {
    const post = (body: unknown, ip = "203.0.113.30") =>
      app.request("/api/public/cards", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });
    const cfg = { template: "table", projects: ["gamma", "delta"], rowSet: "suites" };
    const a = await post(cfg);
    expect(a.status).toBe(200);
    const { id } = (await a.json()) as { id: string };
    // Same config (defaults spelled out or not) → same card.
    const b = (await (await post({ ...cfg, size: "auto", theme: "light" })).json()) as { id: string };
    expect(b.id).toBe(id);
    expect(id).toBe(cardIdFor((await (await app.request(`/api/public/cards/${id}`)).json()) as object));
    expect(await db.select().from(schema.cards)).toHaveLength(1);
    const bad = await post({ template: "table", projects: ["gamma", "no-such-project"] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "unknown_projects", refs: ["no-such-project"] });
    for (let i = 0; i < 59; i++) await post(cfg, "203.0.113.31");
    expect((await post(cfg, "203.0.113.31")).status).toBe(200);
    expect((await post(cfg, "203.0.113.31")).status).toBe(429);
    expect((await post(cfg, "203.0.113.32")).status).toBe(200);
  });

  it("serves cards from a cache keyed by config and publish generation, and 404s unknown projects", async () => {
    const res = await app.request("/og/project/gamma.png");
    expect(res.status).toBe(200);
    expect(cardCacheStats().renders).toBe(1);
    expect((await app.request("/og/project/nope.png")).status).toBe(404);
    // The same normalized config as /og/project/gamma.png (defaults spelled out): a cache hit, no render.
    const c = Buffer.from(JSON.stringify({ template: "spotlight", projects: ["gamma"], size: "landscape", theme: "light" })).toString("base64url");
    const [a, b] = await Promise.all([app.request(`/og/card.png?c=${c}`), app.request(`/og/card.png?c=${c}`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(cardCacheStats().renders).toBe(1);
    // Two concurrent requests for a new config render it once.
    const d = Buffer.from(JSON.stringify({ template: "table", projects: ["gamma", "delta"], theme: "dark" })).toString("base64url");
    await Promise.all([app.request(`/og/card.png?c=${d}`), app.request(`/og/card.png?c=${d}`)]);
    expect(cardCacheStats().renders).toBe(2);
    // A publish starts a new generation: the next request renders fresh.
    await publishRelease(db, { evaluationIds: [await realEvaluation(db, "zeta", "Zeta", true)], label: "R3", notes: "" });
    expect((await app.request("/og/project/gamma.png")).status).toBe(200);
    expect(cardCacheStats().renders).toBe(3);
    expect(cardCacheStats().bytes).toBeGreaterThan(0);
  });
});

// ---------- EFF-25 lean admin lists, EFF-21 estimate ----------

describe("admin lists", () => {
  it("returns latest evaluations without settings blobs, with decoded columns", async () => {
    const s = await login("198.51.100.90");
    const rows = (await (await app.request("/api/admin/projects", { headers: { cookie: s.cookies } })).json()) as {
      slug: string;
      latestEvaluation: Record<string, unknown> | null;
      published: unknown[];
      versions: unknown[];
    }[];
    const gamma = rows.find((r) => r.slug === "gamma")!;
    expect(gamma.latestEvaluation).not.toBeNull();
    expect(gamma.latestEvaluation).not.toHaveProperty("settings");
    expect(gamma.latestEvaluation!.isDemo).toBe(false);
    expect(Array.isArray(gamma.latestEvaluation!.completedStages)).toBe(true);
    expect(gamma.published.length).toBe(1);
    const evs = (await (await app.request("/api/admin/evaluations", { headers: { cookie: s.cookies } })).json()) as Record<string, unknown>[];
    expect(evs.length).toBeGreaterThan(0);
    expect(evs[0]).not.toHaveProperty("settings");
    expect(typeof evs[0]!.flagged).toBe("number");
    const releases = (await (await app.request("/api/admin/releases", { headers: { cookie: s.cookies } })).json()) as Record<string, unknown>[];
    expect(releases[0]).not.toHaveProperty("evalSettings");
  });

  it("estimates per mode and reports the per-mode cost cap", async () => {
    expect([costCapFor("quick"), costCapFor("standard"), costCapFor("deep"), costCapFor("manual")]).toEqual([10, 25, 100, 25]);
    const s = await login("198.51.100.91");
    const est = (await (await app.request("/api/admin/estimate?mode=deep&projects=2&suites=7", { headers: { cookie: s.cookies } })).json()) as {
      low: number;
      high: number;
      capPerEvaluation: number;
    };
    expect(est.capPerEvaluation).toBe(100);
    // Two projects can't be estimated above two caps.
    expect(est.high).toBeLessThanOrEqual(200);
    expect(est.low).toBeGreaterThan(0);
  });
});

// ---------- SEC-7 ----------

describe("upstream errors", () => {
  it("strips RPC URLs (and the keys in them) from real viem failures", async () => {
    process.env.RPC_URL_1 = "http://127.0.0.1:9/v2/SUPERSECRETKEY123";
    try {
      const err = await inspectAddress(1, "0x000000000000000000000000000000000000dEaD").catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toMatch(/^RPC call failed on chain 1: /);
      expect(msg).not.toContain("SUPERSECRETKEY123");
      expect(msg).not.toContain("127.0.0.1");
      expect(msg.length).toBeLessThanOrEqual(300);
    } finally {
      delete process.env.RPC_URL_1;
    }
    expect(
      rpcErrorMessage(10, Object.assign(new Error("HTTP request failed.\nURL: https://x.io/v2/abc\nBody: {}"), { shortMessage: "HTTP request failed." })),
    ).toBe("RPC call failed on chain 10: HTTP request failed.");
    expect(rpcErrorMessage(1, new Error("fetch failed for https://rpc.example/v2/KEY at block 5\nmore"))).toBe(
      "RPC call failed on chain 1: fetch failed for [url] at block 5",
    );
    expect(upstreamError("https://api.example.org/v1/search?apiKey=SECRET", 429).message).toBe("api.example.org returned HTTP 429");
  }, 30_000);
});

// ---------- runtime helpers ----------

describe("runtime", () => {
  it("never runs more than `max` calls at once, including during handoffs", async () => {
    const run = limiter(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 10 }, task));
    // A newcomer arriving exactly at a handoff must queue, not take the slot.
    const late = Array.from({ length: 4 }, task);
    await Promise.resolve();
    late.push(task());
    await Promise.all(late);
    expect(peak).toBe(2);
    expect(run.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it("bounds the LRU by bytes", () => {
    const lru = new LruCache<Buffer>({ maxSize: 1000 });
    for (let i = 0; i < 10; i++) lru.set(`k${i}`, Buffer.alloc(300));
    expect(lru.bytes).toBeLessThanOrEqual(1000);
    expect(lru.get("k9")).toBeDefined();
    expect(lru.get("k0")).toBeUndefined();
  });

  it("re-queues evaluations left running by a previous process", async () => {
    const id = await realEvaluation(getDb(), "epsilon", "Epsilon", true);
    await db.update(schema.evaluations).set({ status: "running", stage: "research" }).where(eq(schema.evaluations.id, id));
    expect(await requeueInterrupted(db)).toBe(1);
    expect((await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, id)))[0]!.status).toBe("queued");
    const events = await db.select().from(schema.runEvents).where(eq(schema.runEvents.evaluationId, id));
    expect(events.at(-1)?.message).toMatch(/stopped reporting/);
  });

  it("resumes the version schedule from the last check", async () => {
    const hours = env.versionCheckHours;
    env.versionCheckHours = 12;
    try {
      const id = await projectId(db, "gamma");
      await db
        .update(schema.projects)
        .set({ githubRepos: ["gamma/core"] })
        .where(eq(schema.projects.id, id));
      const now = Date.now();
      // Never checked: soon after boot.
      expect(await nextVersionCheckDelay(db, now)).toBe(60_000);
      await db.insert(schema.versionChecks).values({ id: "vc1", projectId: id, ranAt: new Date(now - 2 * 3600_000).toISOString() });
      const delay = await nextVersionCheckDelay(db, now);
      expect(delay).toBeGreaterThan(9.9 * 3600_000);
      expect(delay).toBeLessThanOrEqual(10 * 3600_000);
    } finally {
      env.versionCheckHours = hours;
    }
  });
});

describe("GitHub file paths can't leave the repository (security review, 2026-10)", () => {
  it("rejects encoded and plain traversal in paths and refs", async () => {
    const { rawFileUrl, safeRepoPath } = await import("../src/lib/github.ts");
    expect(safeRepoPath("%2e%2e/%2e%2e/%2e%2e/evil/repo/HEAD/f")).toBeNull();
    expect(safeRepoPath("src/../../x")).toBeNull();
    expect(safeRepoPath("src/%2Fetc")).toBeNull();
    expect(safeRepoPath("src\\..\\x")).toBeNull();
    expect(safeRepoPath("contracts/src/Rollup.sol")).toBe("contracts/src/Rollup.sol");
    expect(safeRepoPath("docs/My%20Spec.md")).toBe("docs/My%20Spec.md");
    expect(rawFileUrl("owner/repo", "..", "x/y.sol")).toBeNull();
    expect(rawFileUrl("owner/repo", "v1.0.0", "%2e%2e/%2e%2e/other/repo/HEAD/f")).toBeNull();
    expect(rawFileUrl("owner/..", "HEAD", "f")).toBeNull();
    expect(rawFileUrl("owner/repo", "v1.0.0", "src/A.sol")).toBe("https://raw.githubusercontent.com/owner/repo/v1.0.0/src/A.sol");
  });

  it("never gives agents the server's broader GitHub token", async () => {
    const { agentGithubToken } = await import("../src/lib/github.ts");
    const was = process.env.GITHUB_AGENT_TOKEN;
    delete process.env.GITHUB_AGENT_TOKEN;
    try {
      expect(agentGithubToken()).toBe("");
    } finally {
      if (was !== undefined) process.env.GITHUB_AGENT_TOKEN = was;
    }
  });

  it("verifies the database's certificate on public hosts, pinned when a CA is given", async () => {
    const { sslFor } = await import("../src/db/index.ts");
    const saved = { ca: process.env.PGSSL_CA, mode: process.env.PGSSL };
    delete process.env.PGSSL;
    delete process.env.PGSSL_CA;
    try {
      expect(sslFor("postgresql://u:p@postgres.railway.internal:5432/db")).toBe(false);
      expect(sslFor("postgresql://u:p@switchyard.proxy.rlwy.net:53663/db")).toEqual({ rejectUnauthorized: true });
      process.env.PGSSL_CA = "-----BEGIN CERTIFICATE-----\\nAAAA\\n-----END CERTIFICATE-----";
      const pinned = sslFor("postgresql://u:p@switchyard.proxy.rlwy.net:53663/db") as { ca: string; rejectUnauthorized: boolean; checkServerIdentity: unknown };
      expect(pinned.rejectUnauthorized).toBe(true);
      expect(pinned.ca).toContain("\nAAAA\n");
      expect(typeof pinned.checkServerIdentity).toBe("function");
      process.env.PGSSL = "insecure";
      expect(sslFor("postgresql://u:p@switchyard.proxy.rlwy.net:53663/db")).toEqual({ rejectUnauthorized: false });
    } finally {
      if (saved.ca === undefined) delete process.env.PGSSL_CA;
      else process.env.PGSSL_CA = saved.ca;
      if (saved.mode === undefined) delete process.env.PGSSL;
      else process.env.PGSSL = saved.mode;
    }
  });
});
