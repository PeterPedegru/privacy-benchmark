import { expect, test as setup } from "@playwright/test";
import { ADMIN_PASSWORD, AUTH_FILE } from "./helpers";

setup("sign in to admin", async ({ page }) => {
  await page.goto("/admin");
  await page.getByPlaceholder("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Projects" }).first()).toBeVisible();
  await page.context().storageState({ path: AUTH_FILE });
});
