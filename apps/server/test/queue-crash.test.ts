/**
 * Crashes count toward the crash-loop limit (R4-6): an uncaught error goes through the shutdown path, which must
 * count an interruption like an out-of-memory kill does, and fail the evaluation after too many in a row.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DB } from "../src/db/index.ts";

vi.mock("../src/lib/llm.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/llm.ts")>()), hasApiKey: () => true }));
// The runner never settles on its own, like an evaluation mid-call when the process crashes.
vi.mock("../src/eval/pipeline.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/eval/pipeline.ts")>()),
  runEvaluation: vi.fn(() => new Promise(() => {})),
}));

const { openDb, schema, setDb } = await import("../src/db/index.ts");
const { kick, stopWorker } = await import("../src/eval/queue.ts");

let db: DB;
beforeAll(async () => {
  db = await openDb({ log: () => {} });
  setDb(db);
  await db.insert(schema.projects).values({ id: "p1", slug: "alpha", name: "Alpha", websiteUrl: "https://alpha.example.org" });
  await db.insert(schema.evaluations).values({ id: "eC", projectId: "p1", mode: "quick", status: "queued", stage: "research", settings: { interruptions: 2 } });
});

describe("a crash during an evaluation", () => {
  it("counts an interruption and fails the evaluation past the limit instead of requeueing it", async () => {
    await kick(db);
    const left = await stopWorker(db, 50, { crashed: true });
    expect(left).toContain("eC");
    const e = (await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, "eC")))[0]!;
    expect(e.status).toBe("failed");
    expect(e.error).toMatch(/crashed 3 times/);
  });
});
