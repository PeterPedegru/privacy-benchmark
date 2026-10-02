import { expect, test } from "@playwright/test";
import { leaderboard } from "./helpers";

/** R3-REL-14 / R3-TEST-15: network failures and deploys don't masquerade as missing data, and a stale tab recovers. */
test.describe("resilience", () => {
  test("a project that fails to load offers a retry, not 'Project not found'", async ({ page }) => {
    const { rows } = await leaderboard(page);
    const slug = rows[0]!.slug;
    let attempts = 0;
    await page.route("**/api/public/projects/*", (route) => {
      attempts++;
      return route.abort("failed");
    });
    await page.goto(`/projects/${slug}`);
    // Network errors are retried with backoff (3 retries) before the page gives up.
    await expect(page.getByText("Couldn't load this project.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Project not found")).toHaveCount(0);
    expect(attempts).toBeGreaterThanOrEqual(2);

    // The server is back: Retry loads the project.
    await page.unroute("**/api/public/projects/*");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(rows[0]!.name);
  });

  test("a project that doesn't exist says so at once, without retrying", async ({ page }) => {
    let attempts = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/public/projects/no-such-project")) attempts++;
    });
    await page.goto("/projects/no-such-project");
    await expect(page.getByText("Project not found")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
    // The route loader asks once and the page refetches the failed query when it mounts; 3 retries would make it 4+.
    expect(attempts).toBeLessThanOrEqual(2);
  });

  test("a route chunk removed by a deploy reloads once, then shows a styled error with a Reload button", async ({ page }) => {
    const { rows } = await leaderboard(page);
    // The project page's own chunk (project-<hash>.js), as if a deploy replaced it while the tab was open.
    const chunk = /\/assets\/project-[\w-]{8}\.js$/;
    let chunkRequests = 0;
    await page.route(chunk, (route) => {
      chunkRequests++;
      return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
    });
    let loads = 0;
    page.on("load", () => loads++);
    await page.goto(`/projects/${rows[0]!.slug}`);
    await expect(page.getByRole("button", { name: "Reload" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1 })).toContainText("updated");
    // The first load, then exactly one automatic reload; the second failure shows the error instead of looping.
    expect(loads).toBe(2);
    expect(chunkRequests).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => sessionStorage.getItem("pb:chunk-reload"))).toBeTruthy();

    // The new build is there now: Reload gets the page.
    await page.unroute(chunk);
    await page.getByRole("button", { name: "Reload" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(rows[0]!.name);
  });
});
