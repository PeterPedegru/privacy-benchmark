/**
 * Production runs the esbuild bundle with plain node (SEC-19, EFF-32). This builds it, boots its index.js on a temp
 * port with a throwaway database, checks the endpoints a deploy's healthcheck and first visitors hit, runs the
 * extraction worker and the PDF child process from the bundle, and checks that SIGTERM shuts it down cleanly.
 *
 * It builds into a private directory next to dist/ (BUNDLE_OUTDIR), never dist/ itself, so it can run alongside the
 * e2e build or a server started from dist/.
 */
import { type ChildProcess, execFileSync, fork, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPdf, textPdf } from "../src/lib/pdf-guard.ts";

const SERVER_DIR = resolve(import.meta.dirname, "..");
const OUT_NAME = `.bundle-test-${process.pid}`;
const OUT = resolve(SERVER_DIR, OUT_NAME);
const WEB_INDEX = resolve(SERVER_DIR, "../web/dist/index.html");
const PORT = 4400 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "pb-bundle-"));
let child: ChildProcess;
let output = "";

async function waitForHealth(deadlineMs: number) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${output}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server didn't become healthy:\n${output}`);
}

beforeAll(async () => {
  execFileSync(process.execPath, ["scripts/bundle.mjs"], { cwd: SERVER_DIR, stdio: "pipe", env: { ...process.env, BUNDLE_OUTDIR: OUT_NAME } });
  const { VITEST: _v, VITEST_POOL_ID: _p, VITEST_WORKER_ID: _w, ...base } = process.env;
  // The same node flags as the start command in .railway/railway.ts.
  child = spawn(process.execPath, ["--enable-source-maps", "--enable-experimental-regexp-engine-on-excessive-backtracks", `${OUT_NAME}/index.js`], {
    cwd: SERVER_DIR,
    env: {
      ...base,
      NODE_ENV: "production",
      PORT: String(PORT),
      PUBLIC_URL: BASE,
      DB_PATH: join(tmp, "bundle.db"),
      PGLITE_DIR: join(tmp, "pglite"),
      SEED_DEMO: "1",
      ADMIN_PASSWORD: "bundle-test-password",
      SESSION_SECRET: "bundle-test-session-secret-0123456789",
      ANTHROPIC_API_KEY: "",
      GITHUB_TOKEN: "",
      EXA_API_KEY: "",
      NEWSAPI_AI_KEY: "",
      X_BEARER_TOKEN: "",
      VERSION_CHECK_INTERVAL_HOURS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => (output += d));
  child.stderr?.on("data", (d) => (output += d));
  await waitForHealth(30_000);
}, 60_000);

afterAll(() => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
});

/** Runs one task in the bundled PDF child process, the way extract-pool.ts starts it. */
function pdfChild(bytes: Uint8Array): Promise<{ ok: boolean; result?: { text: string; pages: number }; error?: string }> {
  return new Promise((res, rej) => {
    const p = fork(resolve(OUT, "pdf-child.js"), [], {
      execArgv: ["--max-old-space-size=256", "--disallow-code-generation-from-strings"],
      env: { PATH: process.env.PATH ?? "", PB_PDF_CHILD: "1" },
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let err = "";
    p.stderr?.on("data", (d) => (err += d));
    p.once("message", (m) => res(m as { ok: boolean }));
    p.once("error", rej);
    p.once("close", (code) => rej(new Error(`pdf child exited (${code}) without replying: ${err}`)));
    p.send({ bytes, maxPages: 300, maxChars: 100_000 });
  });
}

describe("bundled server (dist/index.js)", () => {
  it("contains the bundle, its launcher, the extraction worker and the PDF child", () => {
    for (const f of ["index.js", "server.js", "extract-worker.js", "pdf-child.js"]) expect(existsSync(resolve(OUT, f)), f).toBe(true);
  });

  it("runs the bundled extraction worker under plain node", async () => {
    // The pool falls back to in-thread extraction when the worker can't load, which would hide a broken bundle.
    const worker = new Worker(resolve(OUT, "extract-worker.js"));
    try {
      const reply = await new Promise<{ ok: boolean; result?: { markdown: string } }>((res, rej) => {
        worker.once("message", res);
        worker.once("error", rej);
        worker.postMessage({
          id: 1,
          task: {
            kind: "html",
            url: "https://example.com/a",
            html: "<html><body><article><h1>Hello</h1><p>Shielded notes are encrypted to the recipient's viewing key.</p></article></body></html>",
          },
        });
      });
      expect(reply.ok).toBe(true);
      expect(reply.result?.markdown).toContain("viewing key");
    } finally {
      await worker.terminate();
    }
  });

  it("extracts a PDF in the bundled child process (unpdf resolves at runtime)", async () => {
    const reply = await pdfChild(textPdf("Audit report by Zellic for Aztec"));
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.result?.text).toContain("Audit report by Zellic for Aztec");
    expect(reply.result?.pages).toBe(1);
  });

  it("refuses a double-FlateDecode bomb in the bundled child process (R3-SEC-1)", async () => {
    const bomb = buildPdf(deflateSync(deflateSync(Buffer.alloc(100 * 1024 * 1024))), { filters: ["FlateDecode", "FlateDecode"] });
    const reply = await pdfChild(bomb);
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/decode to more than 64 MB/);
  });

  it("serves health, public JSON, share images and (when built) the SPA", async () => {
    const health = await fetch(`${BASE}/api/health`);
    expect(health.status).toBe(200);
    // The boot self-test found the worker and the PDF child in the bundle (R3-SEC-11); the queue is reported (R3-REL-15).
    expect(await health.json()).toEqual({
      ok: true,
      db: "ok",
      queue: { running: 0, queued: 0, oldestRunningSeconds: null },
      extraction: { html: "ok", pdf: "ok" },
    });
    const lb = await fetch(`${BASE}/api/public/leaderboard`, { headers: { "accept-encoding": "gzip" } });
    expect(lb.status).toBe(200);
    expect(lb.headers.get("content-encoding")).toBe("gzip");
    expect(lb.headers.get("etag")).toMatch(/^W\//);
    expect(((await lb.json()) as { rows: unknown[] }).rows.length).toBeGreaterThan(1);
    // Fonts load from node_modules and migrations from apps/server/drizzle, both resolved relative to dist/.
    const og = await fetch(`${BASE}/og/home.png`);
    expect(og.status).toBe(200);
    expect(og.headers.get("content-type")).toBe("image/png");
    expect((await og.arrayBuffer()).byteLength).toBeGreaterThan(5000);
    if (existsSync(WEB_INDEX)) {
      const page = await fetch(`${BASE}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("script-src 'self' 'sha256-");
      expect(await page.text()).toContain('<div id="root">');
    }
  });

  it("re-queues work and exits cleanly on SIGTERM", async () => {
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20_000))]);
    expect(code, output).toBe(0);
    expect(output).toContain("[shutdown] SIGTERM");
  }, 30_000);
});
