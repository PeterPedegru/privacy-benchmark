import { expect, test } from "@playwright/test";
import { AUTH_FILE, loginAdmin, watchErrors } from "./helpers";

/**
 * Community weighting end to end: an editor opens a poll, a visitor votes for the current weights in one click, then
 * changes a suite's weight and updates the vote, and the editor sees the ballot and cancels the poll. The e2e server
 * has no X sign-in configured, so the poll counts one ballot per browser.
 */
test.describe("community weighting", () => {
  test.use({ storageState: AUTH_FILE });
  test.describe.configure({ retries: 0 });

  test("open a poll, vote, change the vote, cancel", async ({ page, browser }) => {
    test.setTimeout(90_000);
    page.on("dialog", (d) => void d.accept());
    await loginAdmin(page);

    await test.step("an editor opens a five-day poll", async () => {
      await page.goto("/admin/weighting");
      await expect(page.getByText("W1", { exact: true }).first()).toBeVisible();
      await page.getByPlaceholder("Community weighting poll #1").fill("E2E weighting poll");
      await page.getByRole("button", { name: "Open a five-day poll" }).click();
      await expect(page.getByRole("button", { name: "Cancel poll" })).toBeVisible();
    });

    // A visitor: a fresh browser context, no admin session.
    const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const v = await visitor.newPage();
    const errors = watchErrors(v);

    await test.step("the open poll is announced at the top of the site", async () => {
      await v.goto("/");
      const banner = v.getByRole("link", { name: "Vote on the weights" });
      await expect(banner).toBeVisible();
      // Above the header, like the other announcements.
      const header = await v.locator("header").boundingBox();
      expect((await banner.boundingBox())!.y).toBeLessThan(header!.y);
      await banner.click();
      await expect(v).toHaveURL(/\/weighting$/);
    });

    const slider = v.getByRole("slider", { name: "Privacy coverage weight" });
    const nudge = async () => {
      await slider.focus();
      for (let i = 0; i < 10; i++) await slider.press("ArrowRight");
    };
    /** Both vote buttons (the card at the top, the bar at the bottom) offer the same thing. */
    const bothSay = async (top: string, bottom: string) => {
      await expect(v.getByRole("button", { name: top, exact: true })).toHaveCount(top === bottom ? 2 : 1);
      await expect(v.getByRole("button", { name: bottom, exact: true })).toHaveCount(top === bottom ? 2 : 1);
    };

    await test.step("both vote buttons follow the sliders", async () => {
      await expect(v.getByText("E2E weighting poll")).toBeVisible();
      // No preview of how projects would rank: a vote is on what should matter.
      await expect(v.getByText("If your weights won")).toHaveCount(0);
      await bothSay("Keep the current weights", "Vote: keep the current weights");
      await nudge();
      await expect(v.getByText("1 weight changed")).toBeVisible();
      await bothSay("Submit my vote", "Submit my vote");
      await v.getByRole("button", { name: "Reset to the current weights" }).click();
      await bothSay("Keep the current weights", "Vote: keep the current weights");
    });

    await test.step("a visitor votes for the current weights in one click", async () => {
      await v.getByRole("button", { name: "Keep the current weights", exact: true }).click();
      await expect(v.getByText("Your vote is in")).toBeVisible();
      await expect(v.getByText("1 ballot", { exact: true })).toBeVisible();
      await expect(v.getByRole("button", { name: "Vote saved", exact: true })).toBeDisabled();
    });

    await test.step("then changes one weight and updates the vote from the top card", async () => {
      await nudge();
      await expect(v.getByText("You have unsaved changes")).toBeVisible();
      await bothSay("Update my vote", "Update my vote");
      await v.getByRole("button", { name: "Update my vote", exact: true }).first().click();
      // The first vote's toast can still be showing: look for this one's.
      await expect(v.getByText(/Vote saved\. You can change it/)).toBeVisible();
      await expect(v.getByRole("button", { name: "Vote saved", exact: true })).toBeDisabled();
      // Still one ballot: a vote is replaced, not added.
      await v.reload();
      await expect(v.getByText("1 ballot", { exact: true })).toBeVisible();
      await expect(v.getByText("1 weight changed")).toBeVisible();
      await expect(v.getByText("Your vote is in")).toBeVisible();
    });

    await test.step("every weighting has its own page", async () => {
      await v.goto("/weighting/W1");
      await expect(v.getByRole("heading", { level: 1 })).toContainText("W1.");
      await expect(v.getByText("Every weight")).toBeVisible();
    });
    expect(errors).toEqual([]);
    await visitor.close();

    await test.step("the editor sees the ballot and cancels the poll", async () => {
      await page.goto("/admin/weighting");
      await expect(page.getByText("E2E weighting poll").first()).toBeVisible();
      await page.getByRole("button", { name: "Cancel poll" }).click();
      await expect(page.getByRole("button", { name: "Open a five-day poll" })).toBeVisible();
      await expect(page.getByText("cancelled").first()).toBeVisible();
    });
  });

  test("a run picks its weighting", async ({ page }) => {
    await loginAdmin(page);
    await page.goto("/admin/runs/new");
    await expect(page.getByRole("combobox", { name: "Weighting" })).toContainText("W1");
  });
});
