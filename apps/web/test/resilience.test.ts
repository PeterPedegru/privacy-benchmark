/** R3-REL-14: what retries, what doesn't, and how a missing route chunk surfaces. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, isNotFound, isRetryable, retryDelay, retryQuery } from "@/lib/api";
import { ChunkLoadError, chunk, isChunkError, RELOAD_AGAIN_AFTER_MS, reloadForNewBuild } from "@/lib/recovery";

afterEach(() => vi.unstubAllGlobals());

describe("api errors", () => {
  it("carries the HTTP status, and 0 when the server can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const offline = await api("/api/public/leaderboard").catch((e) => e);
    expect(offline).toBeInstanceOf(ApiError);
    expect(offline.status).toBe(0);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not_found" }), { status: 404 })));
    const missing = await api("/api/public/projects/nope").catch((e) => e);
    expect(missing.status).toBe(404);
    expect(isNotFound(missing)).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    const gateway = await api("/api/public/meta").catch((e) => e);
    expect(gateway.status).toBe(503);
    expect(gateway.message).toMatch(/restarting/);
    // Our own 503s keep their explanation.
    const body = JSON.stringify({ error: "no_api_key", message: "Set ANTHROPIC_API_KEY to regenerate summaries." });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 503, headers: { "content-type": "application/json" } })));
    const own = await api("/api/public/summarize-like", { method: "POST" }).catch((e) => e);
    expect([own.status, own.code, own.message]).toEqual([503, "no_api_key", "Set ANTHROPIC_API_KEY to regenerate summaries."]);
  });

  it("retries network errors and 5xx up to three times with backoff, never 4xx", () => {
    expect(isRetryable(new ApiError(0, "network", ""))).toBe(true);
    expect(isRetryable(new ApiError(502, "unavailable", ""))).toBe(true);
    for (const s of [400, 401, 404, 409, 429]) expect(isRetryable(new ApiError(s, "x", "")), String(s)).toBe(false);
    expect(isRetryable(new Error("boom"))).toBe(false);
    const net = new ApiError(0, "network", "");
    expect([0, 1, 2, 3].map((n) => retryQuery(n, net))).toEqual([true, true, true, false]);
    expect(retryQuery(0, new ApiError(404, "not_found", ""))).toBe(false);
    expect([0, 1, 2].map(retryDelay)).toEqual([500, 1000, 2000]);
  });
});

describe("route chunks", () => {
  it("turns a failed import into a ChunkLoadError that TanStack Router won't reload on by itself", async () => {
    const failed = chunk(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/project-abc.js")));
    const err = await failed().catch((e) => e);
    expect(err).toBeInstanceOf(ChunkLoadError);
    expect(isChunkError(err)).toBe(true);
    expect(err.message.startsWith("Failed to fetch dynamically imported module")).toBe(false);
    // Vite resolves to undefined after a handled preload error; without a reload under way that's an error too.
    expect(await chunk(() => Promise.resolve(undefined))().catch((e) => e)).toBeInstanceOf(ChunkLoadError);
    expect(await chunk(() => Promise.resolve({ Page: 1 }))()).toEqual({ Page: 1 });
  });

  it("never reloads when session storage can't be used", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(reloadForNewBuild()).toBe(false);
  });

  it("reloads once per deploy: not again within ten minutes, again after (R4-35)", () => {
    const store = new Map<string, string>();
    const reload = vi.fn();
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    vi.stubGlobal("location", { reload });
    const t0 = Date.parse("2026-10-01T12:00:00Z");
    expect(reloadForNewBuild(t0)).toBe(true);
    expect(store.get("pb:chunk-reload")).toBe("2026-10-01T12:00:00.000Z");
    // The reload didn't help (the chunk is still missing): the error screen's Reload button, no loop.
    expect(reloadForNewBuild(t0 + 30_000)).toBe(false);
    expect(reloadForNewBuild(t0 + RELOAD_AGAIN_AFTER_MS - 1)).toBe(false);
    // A second deploy later in the same session reloads again.
    expect(reloadForNewBuild(t0 + RELOAD_AGAIN_AFTER_MS)).toBe(true);
    expect(reloadForNewBuild(t0 + RELOAD_AGAIN_AFTER_MS + 1000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(2);
    // A time stored before this change (or a clock that moved back) doesn't block a reload forever.
    store.set("pb:chunk-reload", "2026-10-02T00:00:00.000Z");
    expect(reloadForNewBuild(t0 + 3 * RELOAD_AGAIN_AFTER_MS)).toBe(true);
    store.set("pb:chunk-reload", "not a date");
    expect(reloadForNewBuild(t0 + 4 * RELOAD_AGAIN_AFTER_MS)).toBe(true);
  });
});
