import { expect, test } from "@playwright/test";

test.describe("public API contract", () => {
  test("health, meta, rubric and prompts", async ({ request }) => {
    expect((await request.get("/api/health")).ok()).toBeTruthy();
    const meta = await (await request.get("/api/public/meta")).json();
    expect(meta).toHaveProperty("release");
    const rubric = await (await request.get("/api/public/rubric")).json();
    expect(rubric.suites).toHaveLength(7);
    const prompts = await (await request.get("/api/public/prompts")).json();
    expect(Object.keys(prompts.prompts)).toEqual(expect.arrayContaining(["scout", "code", "skeptic"]));
  });

  test("leaderboard rows are sorted, scored 0-100 and carry badges", async ({ request }) => {
    const body = await (await request.get("/api/public/leaderboard")).json();
    expect(body.rows.length).toBeGreaterThan(1);
    const scores = body.rows.map((r: { overall: number | null }) => r.overall ?? -1);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    for (const r of body.rows) {
      if (r.overall !== null) expect(r.overall).toBeGreaterThanOrEqual(0);
      if (r.overall !== null) expect(r.overall).toBeLessThanOrEqual(100);
      expect(r.level).toMatch(/^Z[0-5]$|^$/);
    }
  });

  test("project snapshot, compare and exports", async ({ request }) => {
    const { rows } = await (await request.get("/api/public/leaderboard")).json();
    const [a, b] = rows;
    const page = await (await request.get(`/api/public/projects/${a.slug}`)).json();
    expect(page.snapshot.project.slug).toBe(a.slug);
    expect(Object.keys(page.snapshot.criteria).length).toBeGreaterThan(50);
    expect(Array.isArray(page.history)).toBeTruthy();
    const full = await (await request.get(`/api/public/compare?p=${a.slug},${b.slug}`)).json();
    const table = await (await request.get(`/api/public/compare?fields=table&p=${a.slug},${b.slug}`)).json();
    expect(table.snapshots.map((s: { project: { slug: string } }) => s.project.slug)).toEqual([a.slug, b.slug]);
    // The table payload keeps answers and scores but drops evidence, rationales and sources.
    expect(table.snapshots[0].scores).toEqual(full.snapshots[0].scores);
    expect(table.snapshots[0].sources).toEqual([]);
    expect(Object.values(table.snapshots[0].criteria).every((c) => (c as { evidence: unknown[] }).evidence.length === 0)).toBeTruthy();
    expect(JSON.stringify(table).length).toBeLessThan(JSON.stringify(full).length / 2);
    expect((await request.get("/api/public/projects/does-not-exist")).status()).toBe(404);
    const releases = await (await request.get("/api/public/releases")).json();
    // A release that still has published results (admin-flows.spec.ts publishes one and rolls it back).
    const id = ((releases.releases ?? releases) as { id: string; projects: number }[]).find((r) => r.projects > 0)!.id;
    const csv = await request.get(`/api/public/releases/${id}/export.csv`);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    expect((await csv.text()).split("\n").length).toBeGreaterThan(rows.length);
  });

  test("cards render as PNG", async ({ request }) => {
    // The landing page's share images: 1200×630 for Open Graph, 1200×600 for X's large card.
    for (const [path, height] of [
      ["/og/home.png", 630],
      ["/og/home-x.png", 600],
    ] as const) {
      const img = await request.get(path);
      expect(img.headers()["content-type"]).toBe("image/png");
      const png = await img.body();
      expect(png.length).toBeGreaterThan(5_000);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], path).toEqual([1200, height]);
    }
    const { rows } = await (await request.get("/api/public/leaderboard")).json();
    const proj = await request.get(`/og/project/${rows[0].slug}.png`);
    expect(proj.headers()["content-type"]).toBe("image/png");
  });

  test("weightings and the poll", async ({ request }) => {
    const list = await (await request.get("/api/public/weightings")).json();
    expect(list[list.length - 1]).toMatchObject({ label: "W1", source: "rubric" });
    const w1 = await (await request.get("/api/public/weightings/W1")).json();
    expect(Object.keys(w1.config.suites)).toHaveLength(7);
    // Every published result names the weighting it was scored with.
    const { rows } = await (await request.get("/api/public/leaderboard")).json();
    for (const r of rows) expect(r.weighting?.label, r.slug).toMatch(/^W\d+$/);
    const poll = await request.get("/api/public/poll");
    expect(poll.headers()["cache-control"]).toBe("no-store");
    expect(await poll.json()).toMatchObject({ xEnabled: false });
    // Ballots are same-origin JSON only.
    const text = await request.post("/api/public/polls/none/ballot", { headers: { "content-type": "text/plain" }, data: "{}" });
    expect(text.status()).toBe(415);
  });

  test("security headers are set", async ({ request }) => {
    const res = await request.get("/");
    const h = res.headers();
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"] ?? h["content-security-policy"]).toBeTruthy();
    expect(h["referrer-policy"]).toBeTruthy();
  });

  test("admin API requires a session and CSRF", async ({ request }) => {
    expect((await request.get("/api/admin/overview")).status()).toBe(401);
    expect((await request.post("/api/admin/projects", { data: {} })).status()).toBeGreaterThanOrEqual(401);
    const bad = await request.post("/api/admin/login", { data: { password: "wrong" } });
    // 429 once the login rate limiter has seen this client's earlier attempts.
    expect([401, 429]).toContain(bad.status());
  });
});
