/**
 * Extraction workers run with a V8 heap limit (R3-REL-18). A worker that runs out of memory fails its task with
 * ExtractMemoryError and is replaced; the server and the other tasks carry on.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

// Before the pool spawns its first worker: a heap small enough that a dense 1 MB page exhausts it (that page needs
// between 128 and 256 MB, well under the 512 MB default).
vi.stubEnv("KB_EXTRACT_WORKER_HEAP_MB", "32");
const { checkExtraction, closeExtractPool, ExtractMemoryError, ExtractTimeoutError, extractionStatus, isModuleLoadError, runExtract, workerResourceLimits } =
  await import("../src/lib/extract-pool.ts");

afterAll(async () => {
  await closeExtractPool();
  vi.unstubAllEnvs();
});

const small = "<html><head><title>Small</title></head><body><main><p>The protocol is governed by a security council.</p></main></body></html>";
/** A 1 MB page of tiny nested elements: a big DOM for linkedom. */
const dense = `<html><head><title>Dense</title></head><body>${"<div><span>a</span><b>b</b></div>".repeat(29_000)}</body></html>`;

// First in the file, while no worker is warm: the self-test's first attempt has to start one.
describe("boot self-test (R4-31)", () => {
  it("keeps the workers on after a self-test timeout, and retries until it passes", async () => {
    const logs: string[] = [];
    // A 1 ms deadline: no worker starts that fast, as on a CPU-starved boot.
    const status = await checkExtraction((m) => logs.push(m), { htmlTimeoutMs: 1, retryDelaysMs: [50] });
    expect(status.html).toBe("unchecked");
    expect(status.error).toMatch(/html self-test: timed out \(attempt 1\); retrying/);
    expect(logs).toContainEqual(expect.stringMatching(/WARNING: the HTML worker self-test timed out.*the workers stay on/));
    // The retry passes in a worker: HTML never moved to the main thread.
    await vi.waitFor(() => expect(extractionStatus().html).toBe("ok"), { timeout: 20_000, interval: 50 });
    expect(extractionStatus()).toEqual({ html: "ok", pdf: "ok" });
    expect(logs).toContainEqual(expect.stringMatching(/passed on retry 1/));
  });

  it("turns the workers off only for a module that can't load", () => {
    expect(isModuleLoadError(Object.assign(new Error("Cannot find module '/app/apps/server/dist/extract-worker.js'"), { code: "ERR_MODULE_NOT_FOUND" }))).toBe(
      true,
    );
    expect(isModuleLoadError(new Error('Unknown file extension ".ts"'))).toBe(false);
    expect(isModuleLoadError(Object.assign(new TypeError('Unknown file extension ".ts"'), { code: "ERR_UNKNOWN_FILE_EXTENSION" }))).toBe(true);
    expect(isModuleLoadError(new ExtractTimeoutError("extraction took longer than 15 s"))).toBe(false);
    expect(isModuleLoadError(new Error("extraction worker exited with code 1"))).toBe(false);
  });
});

describe("worker heap limit (R3-REL-18)", () => {
  it("applies the configured limit", () => {
    expect(workerResourceLimits().maxOldGenerationSizeMb).toBe(32);
  });

  it("fails a task that runs out of memory, then keeps serving", async () => {
    expect(((await runExtract<{ title: string }>({ kind: "html", html: small, url: "https://x.org/" }, 20_000)) as { title: string }).title).toBe("Small");
    const results = await Promise.allSettled([0, 1, 2].map(() => runExtract({ kind: "html", html: dense, url: "https://x.org/dense" }, 30_000)));
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed.length).toBeGreaterThan(0);
    for (const f of failed) expect((f as PromiseRejectedResult).reason).toBeInstanceOf(ExtractMemoryError);
    expect(((await runExtract<{ title: string }>({ kind: "html", html: small, url: "https://x.org/" }, 20_000)) as { title: string }).title).toBe("Small");
  });
});
