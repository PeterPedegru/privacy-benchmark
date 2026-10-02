import { expect, type Page, test } from "@playwright/test";
import { AUTH_FILE } from "./helpers";

/**
 * The server sends a strict Content-Security-Policy (scripts: same origin plus the hashed inline theme script;
 * images: same origin only, logos are proxied). These checks fail on any CSP violation and on any request that
 * leaves our origin, so a page that silently breaks under the policy, or hotlinks a logo, is caught.
 */

async function watchPolicy(page: Page, origin: string) {
  const offsite: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith("http") && u.origin !== origin) offsite.push(r.url());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return {
    offsite,
    violations: () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp),
  };
}

test.describe("content security policy", () => {
  test("public pages run under the CSP, with logos served from our origin", async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const policy = await watchPolicy(page, origin);
    const res = await page.goto("/");
    expect(res?.headers()["content-security-policy"]).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    const { rows } = await (await page.request.get("/api/public/leaderboard")).json();
    const logos: string[] = [];
    page.on("response", (r) => {
      if (r.url().includes("/api/public/logo")) logos.push(`${r.status()} ${r.url()}`);
    });
    for (const path of ["/", "/benchmarks", "/rankings", "/projects", `/projects/${rows[0].slug}`, "/methodology", "/cards", "/releases"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      expect(await policy.violations(), path).toEqual([]);
    }
    expect(policy.offsite).toEqual([]);
    // Every logo comes through our own origin (checked above); the sample dataset's fictional projects have none.
    if (rows.some((r: { logoUrl: string | null }) => r.logoUrl)) expect(logos.length).toBeGreaterThan(0);
  });

  test("the hashed inline theme script still runs", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("pb-theme", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.evaluate(() => localStorage.setItem("pb-theme", "light"));
    await page.reload();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });

  test.describe("admin", () => {
    test.use({ storageState: AUTH_FILE });

    test("admin pages run under the CSP and are never cached", async ({ page, baseURL }) => {
      const policy = await watchPolicy(page, new URL(baseURL!).origin);
      for (const path of ["/admin", "/admin/projects", "/admin/runs", "/admin/review", "/admin/releases", "/admin/settings"]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        expect(await policy.violations(), path).toEqual([]);
      }
      expect(policy.offsite).toEqual([]);
      const me = await page.request.get("/api/admin/me");
      expect(me.headers()["cache-control"]).toBe("no-store");
    });
  });
});
