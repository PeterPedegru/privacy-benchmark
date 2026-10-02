/** /api/health (R3-REL-15): the database answers, the queue's state, and nothing an outsider shouldn't see. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { closeDb, type DB, openDb, schema, setDb } from "../src/db/index.ts";
import { healthReport } from "../src/services/health.ts";

// vi.mock is hoisted above the imports: the extraction status can be set per test.
const extraction = vi.hoisted(() => ({ status: null as null | { html: string; pdf: string; error?: string } }));
vi.mock("../src/lib/extract-pool.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/extract-pool.ts")>();
  return { ...orig, extractionStatus: () => extraction.status ?? orig.extractionStatus() };
});

let db: DB;

beforeAll(async () => {
  db = await openDb({ log: () => {} });
  setDb(db);
  await db.insert(schema.projects).values([
    { id: "p1", slug: "alpha", name: "Alpha", websiteUrl: "https://alpha.example.org" },
    { id: "p2", slug: "beta", name: "Beta", websiteUrl: "https://beta.example.org" },
  ]);
});

describe("health", () => {
  it("reports the database and an idle queue", async () => {
    const res = await createApp().request("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ok: true,
      db: "ok",
      queue: { running: 0, queued: 0, oldestRunningSeconds: null },
      extraction: { html: "unchecked", pdf: "unchecked" },
    });
  });

  it("counts running and queued evaluations and the oldest running one's age", async () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    await db.insert(schema.evaluations).values([
      { id: "e1", projectId: "p1", status: "running", startedAt: "2026-10-01T11:00:00.000Z", settings: { secret: "internal notes" } as never },
      // One running evaluation per project: the second running one is another project's.
      { id: "e2", projectId: "p2", status: "running", startedAt: "2026-10-01T11:50:00.000Z" },
      { id: "e3", projectId: "p1", status: "queued" },
      { id: "e4", projectId: "p1", status: "failed", startedAt: "2026-09-01T00:00:00.000Z" },
    ]);
    const report = await healthReport(() => db, now);
    expect(report).toEqual({
      ok: true,
      db: "ok",
      queue: { running: 2, queued: 1, oldestRunningSeconds: 3600 },
      extraction: { html: "unchecked", pdf: "unchecked" },
    });
    // Counts only: no ids, settings or project names.
    expect(JSON.stringify(report)).not.toMatch(/e1|alpha|internal/);
  });

  it("reports a failed extractor without taking the site down, and without its error text", async () => {
    extraction.status = { html: "failed", pdf: "ok", error: "html worker: Cannot find module '/app/apps/server/dist/extract-worker.js'" };
    try {
      const res = await createApp().request("/api/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, extraction: { html: "failed", pdf: "ok" } });
      expect(JSON.stringify(body)).not.toContain("/app/");
    } finally {
      extraction.status = null;
    }
  });

  it("is unhealthy (503) when the database doesn't answer", async () => {
    const broken = await openDb({ log: () => {} });
    await closeDb(broken);
    expect(await healthReport(() => broken)).toMatchObject({ ok: false, db: "error", queue: null });
    setDb(broken);
    try {
      const res = await createApp().request("/api/health");
      expect(res.status).toBe(503);
    } finally {
      setDb(db);
    }
  });
});
