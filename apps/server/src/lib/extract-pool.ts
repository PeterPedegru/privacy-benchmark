/**
 * Extraction off the main thread (EFF-13, SEC-3).
 *
 * HTML: a small worker_threads pool. Each task has a timeout; a worker that exceeds it is terminated and replaced,
 * so a pathological page costs one task, not the event loop. Workers have a V8 heap limit (R3-REL-18): one that
 * runs out of memory fails its task with ExtractMemoryError and is replaced. If workers can't load at all (a bundle
 * that didn't ship extract-worker.js), HTML runs in-thread with the same size caps; that is logged as an error and
 * reported by /api/health (R3-SEC-11).
 *
 * PDF: one child process per document (R3-SEC-1). pdf.js decodes into memory outside the V8 heap, which worker
 * limits don't cover, so the child is killed when its resident memory passes KB_PDF_MAX_RSS_MB (768 MB) or the task
 * deadline passes. PDFs never run on the main thread.
 */
import { execFile, fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { ExtractTask } from "./extract-worker.ts";
import type { PdfText } from "./pdf-child.ts";
import { textPdf } from "./pdf-guard.ts";

export class ExtractTimeoutError extends Error {}
/** The task needed more memory than its worker or child process may use. */
export class ExtractMemoryError extends Error {}

interface Pending {
  id: number;
  task: ExtractTask;
  timeoutMs: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  busy: Pending | null;
  timer: NodeJS.Timeout | null;
}

const SIZE = Math.max(1, Math.min(Number(process.env.KB_EXTRACT_WORKERS) || 2, Math.max(1, availableParallelism() - 1)));
// From source (tsx) the worker is the .ts file next to this one; in the production bundle (dist/server.js),
// scripts/bundle.mjs emits it as dist/extract-worker.js. Same for the PDF child.
const fromSource = import.meta.url.endsWith(".ts");
const WORKER_URL = new URL(fromSource ? "./extract-worker.ts" : "./extract-worker.js", import.meta.url);
export const PDF_CHILD_PATH = fileURLToPath(new URL(fromSource ? "./pdf-child.ts" : "./pdf-child.js", import.meta.url));

/** Node strips TypeScript types by default from 22.18 and 23.6 (in a child started without flags, as the PDF child is). */
export function nodeStripsTypesByDefault(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
}

/**
 * Node flags for the PDF child (R4-32). Run from source, the child is a .ts file. Node 22.18+ and 23.6+ run it as
 * is; older Node 22 (the engines field allows 22.0) gets tsx's loader, a dependency of the server that works on any
 * 22.x. The parent's own flags don't tell: the child is started with these flags only. The production bundle runs
 * dist/pdf-child.js and needs nothing.
 */
export function pdfChildExecArgv(opts: { fromSource?: boolean; nativeTypeScript?: boolean } = {}): string[] {
  const base = ["--max-old-space-size=256", "--disallow-code-generation-from-strings"];
  if (!(opts.fromSource ?? fromSource) || (opts.nativeTypeScript ?? nodeStripsTypesByDefault())) return base;
  return [...base, "--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href];
}

/** Heap limits per worker (R3-REL-18). HTML input is capped at 1 MB, so 512 MB is far above normal use. */
export function workerResourceLimits() {
  return { maxOldGenerationSizeMb: Number(process.env.KB_EXTRACT_WORKER_HEAP_MB) || 512, maxYoungGenerationSizeMb: 64 };
}

let nextId = 1;
const intentionallyOff = process.env.KB_EXTRACT_WORKERS === "0";
let disabled = intentionallyOff;
let workerFailure: string | null = null;
let lastInlineWarning = 0;
const slots: Slot[] = [];
const queue: Pending[] = [];

/**
 * A worker that can't load its module: a deployment problem (a bundle without extract-worker.js), and the only
 * failure that turns the workers off (R4-31). A timeout or a crashed task says nothing about the deploy.
 */
export function isModuleLoadError(e: unknown): boolean {
  const err = e as NodeJS.ErrnoException | undefined;
  return /Cannot find module|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/.test(`${err?.code ?? ""} ${err?.message ?? ""}`);
}

function workerUnavailable(reason: string) {
  disabled = true;
  if (workerFailure) return;
  workerFailure = reason;
  console.error(
    `[extract] ERROR: the extraction worker failed to load (${reason}). HTML is now parsed on the main thread, which a hostile page can stall; /api/health reports this until the deploy is fixed.`,
  );
}

function spawn(): Slot | null {
  let worker: Worker;
  try {
    // The worker parses untrusted HTML and needs no configuration: it gets an empty environment, not the secrets.
    worker = new Worker(WORKER_URL, { resourceLimits: workerResourceLimits(), env: {} });
  } catch (e) {
    workerUnavailable((e as Error).message);
    return null;
  }
  worker.unref();
  const slot: Slot = { worker, busy: null, timer: null };
  worker.on("message", (m: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    const p = slot.busy;
    if (!p || p.id !== m.id) return;
    finish(slot);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error ?? "extraction failed"));
    pump();
  });
  const fail = (e: Error) => {
    const p = slot.busy;
    finish(slot);
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    if (p) {
      // A worker that can't load its module is a deployment problem: fall back to in-thread extraction (loudly).
      if (isModuleLoadError(e)) workerUnavailable(e.message);
      if ((e as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY")
        p.reject(new ExtractMemoryError(`extraction ran out of memory (worker heap limit ${workerResourceLimits().maxOldGenerationSizeMb} MB)`));
      else if (disabled) runInline(p);
      else p.reject(e);
    }
    pump();
  };
  worker.on("error", fail);
  worker.on("exit", (code) => {
    if (slot.busy) fail(new Error(`extraction worker exited with code ${code}`));
    else {
      const i = slots.indexOf(slot);
      if (i >= 0) slots.splice(i, 1);
    }
  });
  slots.push(slot);
  return slot;
}

function finish(slot: Slot) {
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
  slot.busy = null;
}

function runInline(p: Pending) {
  if (p.task.kind === "pdf") {
    p.reject(new Error("PDFs are only extracted in a child process"));
    return;
  }
  if (!intentionallyOff && Date.now() - lastInlineWarning > 10 * 60_000) {
    lastInlineWarning = Date.now();
    console.error(`[extract] ERROR: extracting on the main thread because the worker failed to load (${workerFailure ?? "unknown"}).`);
  }
  import("./extract-worker.ts").then((m) => m.runTask(p.task)).then(p.resolve, (e: Error) => p.reject(e));
}

function pump() {
  while (queue.length) {
    if (disabled) {
      runInline(queue.shift()!);
      continue;
    }
    let slot = slots.find((s) => !s.busy);
    if (!slot && slots.length < SIZE) slot = spawn() ?? undefined;
    if (!slot) {
      if (disabled) continue;
      return;
    }
    const p = queue.shift()!;
    slot.busy = p;
    const s = slot;
    s.timer = setTimeout(() => {
      const cur = s.busy;
      finish(s);
      const i = slots.indexOf(s);
      if (i >= 0) slots.splice(i, 1);
      s.worker.removeAllListeners("exit");
      s.worker.terminate().catch(() => {});
      cur?.reject(new ExtractTimeoutError(`extraction took longer than ${Math.round(p.timeoutMs / 1000)} s`));
      pump();
    }, p.timeoutMs);
    s.worker.postMessage({ id: p.id, task: p.task });
  }
}

// ---------- PDF child processes (R3-SEC-1) ----------

export const PDF_MAX_PAGES = 300;
export const PDF_MAX_CHARS = 2_000_000;
const pdfMaxRss = () => (Number(process.env.KB_PDF_MAX_RSS_MB) || 768) * 1024 * 1024;
const PDF_CONCURRENCY = Math.max(1, Number(process.env.KB_PDF_CHILDREN) || 2);
let pdfActive = 0;
const pdfWaiting: (() => void)[] = [];

/** Resident memory of a process: /proc on Linux, `ps` elsewhere (macOS in development). Null when it's gone. */
async function rssOf(pid: number): Promise<number | null> {
  if (process.platform === "linux") {
    try {
      const m = /VmRSS:\s+(\d+)\s+kB/.exec(await readFile(`/proc/${pid}/status`, "utf8"));
      return m ? Number(m[1]) * 1024 : null;
    } catch {
      return null;
    }
  }
  return new Promise((resolve) =>
    execFile("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 2000 }, (err, out) => {
      const kb = Number(String(out).trim());
      resolve(err || !Number.isFinite(kb) || kb <= 0 ? null : kb * 1024);
    }),
  );
}

function runPdfChild(bytes: Uint8Array, timeoutMs: number, opts: { maxPages: number; maxChars: number }): Promise<PdfText> {
  return new Promise<PdfText>((resolve, reject) => {
    const child = fork(PDF_CHILD_PATH, [], {
      // No inherited flags (test runners, loaders) and no secrets: the child only needs to parse bytes.
      execArgv: pdfChildExecArgv(),
      env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV ?? "", PB_PDF_CHILD: "1" },
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let settled = false;
    let stderr = "";
    let checking = false;
    const limit = pdfMaxRss();
    const done = (err: Error | null, value?: PdfText) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (err) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(() => done(new ExtractTimeoutError(`PDF extraction took longer than ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    const check = () => {
      if (checking || settled || !child.pid) return;
      checking = true;
      rssOf(child.pid)
        .then((rss) => {
          if (rss !== null && rss > limit)
            done(new ExtractMemoryError(`PDF extraction passed ${Math.round(limit / 1024 / 1024)} MB of memory and was stopped (a decompression bomb?)`));
        })
        .finally(() => {
          checking = false;
        });
    };
    const watch = setInterval(check, process.platform === "linux" ? 100 : 200);
    // Look early too: a bomb can allocate hundreds of MB in the first 100 ms.
    const early = setTimeout(check, 30);
    early.unref();
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString();
    });
    child.on("message", (m: { ok: boolean; result?: PdfText; error?: string }) =>
      m.ok ? done(null, m.result) : done(new Error(m.error ?? "PDF extraction failed")),
    );
    child.on("error", (e) => done(e));
    // "close" comes after every message has been delivered, so a reply is never mistaken for a crash.
    child.on("close", (code, signal) => {
      const last = stderr.trim().split("\n").filter(Boolean).at(-1);
      done(new Error(`PDF extraction process ended (${signal ?? `exit ${code}`})${last ? `: ${last.slice(0, 300)}` : ""}`));
    });
    try {
      child.send({ bytes, maxPages: opts.maxPages, maxChars: opts.maxChars });
    } catch (e) {
      // The child is already gone (it couldn't start): fail now rather than wait for the deadline.
      done(e as Error);
    }
  });
}

/** PDF text in a child process, at most PDF_CONCURRENCY at once. */
export async function extractPdfInChild(bytes: Uint8Array, timeoutMs: number, opts: { maxPages?: number; maxChars?: number } = {}): Promise<PdfText> {
  if (pdfActive >= PDF_CONCURRENCY) await new Promise<void>((r) => pdfWaiting.push(r));
  pdfActive++;
  try {
    return await runPdfChild(bytes, timeoutMs, { maxPages: opts.maxPages ?? PDF_MAX_PAGES, maxChars: opts.maxChars ?? PDF_MAX_CHARS });
  } finally {
    pdfActive--;
    pdfWaiting.shift()?.();
  }
}

/** Runs one extraction task: HTML in the worker pool (or in-thread when workers are unavailable), PDF in a child process. */
export function runExtract<T>(task: ExtractTask, timeoutMs: number): Promise<T> {
  if (task.kind === "pdf") return extractPdfInChild(task.bytes, timeoutMs) as Promise<T>;
  return new Promise<T>((resolve, reject) => {
    queue.push({ id: nextId++, task, timeoutMs, resolve: resolve as (v: unknown) => void, reject });
    pump();
  });
}

/** Stops all workers (tests and graceful shutdown). */
export async function closeExtractPool(): Promise<void> {
  const all = slots.splice(0);
  await Promise.all(all.map((s) => s.worker.terminate().catch(() => 0)));
}

// ---------- status (R3-SEC-11) ----------

export type ExtractorState = "ok" | "failed" | "disabled" | "unchecked";
export interface ExtractionStatus {
  html: ExtractorState;
  pdf: ExtractorState;
  /** What failed, for the operator. Contains no secrets: module paths and error messages only. */
  error?: string;
}

let pdfState: ExtractorState = "unchecked";
let pdfError: string | null = null;
let htmlState: "unchecked" | "ok" | "failed" = "unchecked";
/** Why the HTML self-test hasn't passed when the workers themselves load (a timeout, a crash, wrong output). */
let htmlCheckError: string | null = null;

export function extractionStatus(): ExtractionStatus {
  const html: ExtractorState = intentionallyOff ? "disabled" : workerFailure ? "failed" : htmlState;
  const error = [workerFailure ? `html worker: ${workerFailure}` : htmlCheckError && `html self-test: ${htmlCheckError}`, pdfError && `pdf child: ${pdfError}`]
    .filter(Boolean)
    .join("; ");
  return { html, pdf: pdfState, ...(error ? { error } : {}) };
}

/** Waits before each retry of an HTML self-test that timed out (R4-31): a CPU-starved boot usually recovers. */
export const HTML_SELF_TEST_RETRIES_MS = [30_000, 120_000, 600_000];
const HTML_SELF_TEST_TIMEOUT_MS = 15_000;

/**
 * One HTML self-test through a worker, retried in the background after a timeout. Only a module-load error turns
 * the workers off (in-thread parsing is the fallback for a broken deploy, R3-SEC-3); a timeout, a crashed worker or
 * wrong output is reported in the status while the workers stay on, because parsing on the main thread would be no
 * faster and would let a hostile page stall the server (R4-31).
 */
async function checkHtml(log: (m: string) => void, opts: CheckOptions, attempt = 0): Promise<void> {
  const page = "<html><head><title>Self-test</title></head><body><main><p>The extraction worker answers.</p></main></body></html>";
  const timeoutMs = attempt === 0 ? (opts.htmlTimeoutMs ?? HTML_SELF_TEST_TIMEOUT_MS) : HTML_SELF_TEST_TIMEOUT_MS;
  try {
    const r = await runExtract<{ markdown: string }>({ kind: "html", url: "https://selftest.invalid/", html: page }, timeoutMs);
    if (!String(r?.markdown).includes("worker answers")) throw new Error(`unexpected output: ${JSON.stringify(r?.markdown).slice(0, 80)}`);
    htmlState = "ok";
    htmlCheckError = null;
    if (attempt > 0) log(`[extract] the HTML worker self-test passed on retry ${attempt}`);
  } catch (e) {
    const message = (e as Error).message;
    if (isModuleLoadError(e) || workerFailure) {
      if (!workerFailure) workerUnavailable(message);
      return;
    }
    const delays = opts.retryDelaysMs ?? HTML_SELF_TEST_RETRIES_MS;
    if (e instanceof ExtractTimeoutError && attempt < delays.length) {
      htmlCheckError = `timed out (attempt ${attempt + 1}); retrying`;
      log(
        `[extract] WARNING: the HTML worker self-test timed out (${message}); the workers stay on, and the test runs again in ${Math.round(delays[attempt]! / 1000)} s`,
      );
      const retry = setTimeout(() => void checkHtml(log, opts, attempt + 1), delays[attempt]);
      retry.unref();
      return;
    }
    htmlState = "failed";
    htmlCheckError = e instanceof ExtractTimeoutError ? `timed out ${attempt + 1} times` : message;
    log(`[extract] ERROR: the HTML worker self-test failed (${htmlCheckError}); the workers stay on. Check the server's CPU and memory.`);
  }
}

export interface CheckOptions {
  /** The first HTML attempt's deadline (default 15 s; tests use less). */
  htmlTimeoutMs?: number;
  /** Delays before the retries after a timeout (default HTML_SELF_TEST_RETRIES_MS). */
  retryDelaysMs?: number[];
}

/**
 * Boot self-test: one HTML task through a worker and one PDF through a child process, so a bundle that didn't ship
 * dist/extract-worker.js or dist/pdf-child.js is a loud startup error instead of a silent fallback. Resolves after
 * the first attempt of each; an HTML retry after a timeout runs in the background.
 */
export async function checkExtraction(log: (m: string) => void = console.error, opts: CheckOptions = {}): Promise<ExtractionStatus> {
  const html = checkHtml(log, opts);
  const pdf = extractPdfInChild(textPdf("PDF extraction self-test"), 30_000)
    .then((r) => {
      if (!r.text.includes("self-test")) throw new Error("unexpected output");
      pdfState = "ok";
    })
    .catch((e: Error) => {
      pdfState = "failed";
      pdfError = e.message;
      log(`[extract] ERROR: PDF extraction doesn't work (${e.message}); PDFs will fail until the deploy is fixed.`);
    });
  await Promise.all([html, pdf]);
  return extractionStatus();
}
