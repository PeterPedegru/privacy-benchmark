import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

export const ADMIN_PASSWORD = "e2e-admin-password";
export const AUTH_FILE = fileURLToPath(new URL("../.auth/admin.json", import.meta.url));

/** Fails the test on uncaught page errors and console errors (ignoring aborted fetches during navigation). */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource: the server responded with a status of 401|net::ERR_ABORTED|AbortError/.test(t)) return;
    errors.push(`console: ${t}`);
  });
  return errors;
}

/** Opens the admin with the session saved by auth.setup.ts (specs opt in with test.use({ storageState: AUTH_FILE })). */
export async function loginAdmin(page: Page) {
  await page.goto("/admin");
  await expect(page.getByRole("link", { name: "Projects" }).first()).toBeVisible();
}

export async function leaderboard(page: Page): Promise<{ rows: { slug: string; name: string; overall: number | null }[] }> {
  const res = await page.request.get("/api/public/leaderboard");
  expect(res.ok()).toBeTruthy();
  return res.json();
}
