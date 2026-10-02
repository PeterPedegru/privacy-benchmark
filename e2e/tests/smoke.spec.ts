import { expect, test } from "@playwright/test";

/** Read-only checks against a deployed site. Never logs in or writes. */
test.describe("production smoke", () => {
  test("API is healthy and serves published data", async ({ request }) => {
    const health = await request.get("/api/health");
    expect(health.ok(), await health.text()).toBeTruthy();
    // The database answers, and HTML and PDF extraction passed their boot self-test.
    expect(await health.json()).toMatchObject({ ok: true, db: "ok", extraction: { html: "ok", pdf: "ok" } });
    const lb = await request.get("/api/public/leaderboard");
    expect(lb.ok()).toBeTruthy();
    const body = await lb.json();
    expect(Array.isArray(body.rows)).toBeTruthy();
    expect((await request.get("/api/public/rubric")).ok()).toBeTruthy();
  });

  test("pages render without errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    for (const path of ["/", "/benchmarks", "/rankings", "/methodology"]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test("OG image and security headers", async ({ request }) => {
    const og = await request.get("/og/home.png");
    expect(og.headers()["content-type"]).toBe("image/png");
    const h = (await request.get("/")).headers();
    expect(h["strict-transport-security"]).toBeTruthy();
    expect(h["x-content-type-options"]).toBe("nosniff");
  });

  test("admin API is closed to anonymous requests", async ({ request }) => {
    expect((await request.get("/api/admin/overview")).status()).toBe(401);
    expect((await request.get("/api/admin/projects")).status()).toBe(401);
  });
});
