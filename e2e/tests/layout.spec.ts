import { expect, type Page, test } from "@playwright/test";

const PAGES = ["/", "/benchmarks", "/rankings", "/projects", "/methodology", "/cards", "/releases"];

async function check(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${path} scrolls horizontally`).toBeLessThanOrEqual(1);
}

test.describe("layout", () => {
  test("project pages (every tab) fit the screen", async ({ page }) => {
    const { rows } = await (await page.request.get("/api/public/leaderboard")).json();
    for (const slug of rows.slice(0, 3).map((r: { slug: string }) => r.slug))
      for (const tab of ["", "?tab=matrix", "?tab=sources", "?tab=history"]) await check(page, `/projects/${slug}${tab}`);
  });

  for (const path of PAGES) {
    test(`${path} has no horizontal overflow and no overlapping title lines`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, "page scrolls horizontally").toBeLessThanOrEqual(1);
      const tight = await page.$$eval("h1, h2", (els) =>
        els
          .map((el) => {
            const cs = getComputedStyle(el);
            const lh = Number.parseFloat(cs.lineHeight);
            const fs = Number.parseFloat(cs.fontSize);
            return { text: (el.textContent ?? "").slice(0, 40), ratio: Number.isFinite(lh) ? lh / fs : 1.2 };
          })
          .filter((x) => x.ratio < 0.95),
      );
      expect(tight, "headings whose line height is smaller than their font size overlap when they wrap").toEqual([]);
    });
  }
});
