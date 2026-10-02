import { expect, test } from "@playwright/test";
import { leaderboard, watchErrors } from "./helpers";

test.describe("public site", () => {
  test("home is the benchmark table, with the suite leaders, method and cards under it", async ({ page }, info) => {
    const errors = watchErrors(page);
    const { rows } = await leaderboard(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Compare privacy systems");
    await expect(page.getByText(rows[0]!.name).first()).toBeVisible();
    // "Benchmarks" is the highlighted menu item (desktop menu; phones use the drawer).
    if (info.project.name !== "mobile")
      await expect(page.locator("header nav").getByRole("link", { name: "Benchmarks" }).locator(".bg-surface")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: /Seven suites/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Models gather and judge/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Share a comparison/ })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the table's old address keeps its columns and focus", async ({ page }) => {
    const { rows } = await leaderboard(page);
    const [a, b] = rows;
    await page.goto(`/benchmarks?p=${a!.slug},${b!.slug}&focus=${b!.slug}`);
    await expect(page).toHaveURL(new RegExp(`/\\?p=${a!.slug}(%2C|,)${b!.slug}&focus=${b!.slug}`));
    await expect(page.getByText(`Focus · ${b!.name}`)).toBeVisible();
  });

  test("benchmark table shows projects and explains a cell", async ({ page }, info) => {
    const errors = watchErrors(page);
    const { rows } = await leaderboard(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Compare privacy systems");
    // Phones get the pivot view (one project per column is too narrow); desktop gets the grid table.
    if (info.project.name !== "mobile") await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByText(rows[0]!.name).first()).toBeVisible();
    // Desktop: grid cells carry "<benchmark>: <score>%" labels. Phones: the pivot lists benchmarks as rows.
    const cell =
      info.project.name === "mobile" ? page.getByRole("button", { name: /^Confidentiality/ }).first() : page.locator("button[aria-label*='%']").first();
    await cell.click();
    // On phones the benchmark card expands first; a project row inside it opens the breakdown.
    if (info.project.name === "mobile") await page.locator("button:not([aria-expanded])", { hasText: /\d%/ }).first().click();
    await expect(
      page
        .getByRole("dialog")
        .getByText(/calculat/i)
        .first(),
    ).toBeVisible();
    // The table loads without evidence; the breakdown fetches the full result, so a criterion shows its rationale.
    const dialog = page.getByRole("dialog");
    await dialog.locator("button[aria-expanded='false']").first().click();
    await expect(dialog.getByText(/^Confidence: /).first()).toBeVisible();
    await expect(
      dialog
        .locator("blockquote")
        .or(dialog.getByText("No quoted evidence recorded", { exact: false }))
        .first(),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("rankings list every published project in score order", async ({ page }) => {
    const { rows } = await leaderboard(page);
    await page.goto("/rankings");
    for (const r of rows.slice(0, 3)) await expect(page.getByText(r.name).first()).toBeVisible();
  });

  test("project page tabs: benchmarks, matrix, sources, history", async ({ page }) => {
    const errors = watchErrors(page);
    const { rows } = await leaderboard(page);
    await page.goto(`/projects/${rows[0]!.slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(rows[0]!.name);
    for (const [label, tab] of [
      ["Adversary matrix", "matrix"],
      ["sources", "sources"],
      ["Versions & changes", "history"],
      ["benchmarks", "benchmarks"],
    ] as const) {
      await page.getByRole("button", { name: label, exact: true }).click();
      if (tab === "benchmarks") await expect(page).not.toHaveURL(/tab=/);
      else await expect(page).toHaveURL(new RegExp(`tab=${tab}`));
    }
    expect(errors).toEqual([]);
  });

  test("methodology discloses the rubric and the evaluator prompts", async ({ page }) => {
    await page.goto("/methodology");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(/Knowledge base/).first()).toBeVisible();
    await expect(page.getByText(/Code audit/).first()).toBeVisible();
  });

  test("cards page renders a comparison card image", async ({ page }) => {
    await page.goto("/cards");
    const img = page.locator("img[src*='/og/']").first();
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(100);
  });

  test("a visitor can suggest a correction", async ({ page }) => {
    const { rows } = await leaderboard(page);
    await page.goto(`/projects/${rows[0]!.slug}`);
    await page
      .getByRole("button", { name: /correction/i })
      .first()
      .click();
    const message = page.getByPlaceholder("What's wrong, and what should it say?");
    await message.fill("E2E test: the pause criterion cites an outdated page.");
    await message.blur();
    await page.getByRole("button", { name: "Send correction" }).click();
    await expect(page.getByText(/thanks|received|sent/i).first()).toBeVisible();
  });

  test("releases page has the public corrections log", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/releases");
    await expect(page.getByRole("heading", { name: "Corrections log" })).toBeVisible();
    await expect(page.getByText(/awaiting review|No corrections decided yet|Corrected|Not changed|Accepted/).first()).toBeVisible();
    expect(errors).toEqual([]);
  });
});
