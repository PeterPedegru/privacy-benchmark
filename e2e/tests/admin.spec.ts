import { expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, AUTH_FILE, loginAdmin, watchErrors } from "./helpers";

test.describe("admin sign-in", () => {
  test("rejects a wrong password, accepts the right one", async ({ page }) => {
    await page.goto("/admin");
    await page.getByPlaceholder("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("That password isn't right.")).toBeVisible();
    await page.getByPlaceholder("Password").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("link", { name: "Projects" }).first()).toBeVisible();
  });
});

test.describe("admin", () => {
  test.use({ storageState: AUTH_FILE });

  test("every admin page loads without errors", async ({ page }) => {
    const errors = watchErrors(page);
    await loginAdmin(page);
    for (const [path, text] of [
      ["/admin", /overview|projects|runs/i],
      ["/admin/projects", /add project/i],
      ["/admin/updates", /update/i],
      ["/admin/runs", /run/i],
      ["/admin/review", /review/i],
      ["/admin/releases", /release/i],
      ["/admin/corrections", /correction/i],
      ["/admin/settings", /ANTHROPIC_API_KEY/],
    ] as const) {
      await page.goto(path);
      await expect(page.getByText(text).first()).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test("project detail shows the knowledge base without building it", async ({ page }) => {
    await loginAdmin(page);
    await page.goto("/admin/projects");
    await page.locator("a[href^='/admin/projects/']:not([href$='/new'])").first().click();
    await expect(page.getByText("Knowledge base").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /build now|refresh/i })).toBeVisible();
    await expect(page.getByPlaceholder(/upgradeTo, timelock/)).toBeVisible();
    for (const tab of ["versions", "sources", "evaluations", "settings"]) {
      await page
        .getByRole("button", { name: new RegExp(`^${tab}`, "i") })
        .first()
        .click();
    }
    await expect(page.getByText("X handle")).toBeVisible();
  });

  test("adding a project survives messy intake data (inline logo, odd slug, repo URLs)", async ({ page }) => {
    await loginAdmin(page);
    // Intake reads the live web; stub it with the kind of data that used to make saving fail.
    await page.route("**/api/admin/projects/intake", (route) =>
      route.fulfill({
        json: {
          url: "https://example-privacy.org/",
          name: "Example Privacy",
          slug: "Example Privacy!",
          logoUrl: `data:image/svg+xml;base64,${"A".repeat(4000)}`,
          tagline: "t".repeat(300),
          description: "A test project.",
          category: "privacy_app",
          mechanism: "pool",
          attributes: ["zk"],
          chains: ["Ethereum"],
          githubRepos: ["https://github.com/example/core.git"],
          xHandle: "https://x.com/ExamplePriv",
          docsUrl: "https://docs.example-privacy.org",
          links: { docs: [], github: [], social: [], blog: [], audits: [] },
          aiSuggested: false,
          costUsd: 0,
          warning: "example-privacy.org renders its content with JavaScript, so there was little to read. Check the details before saving.",
        },
      }),
    );
    await page.goto("/admin/projects/new");
    await page.getByPlaceholder("https://example.org").fill("https://example-privacy.org");
    await page.getByRole("button", { name: /run intake/i }).click();
    await expect(page.getByText(/renders its content with JavaScript/)).toBeVisible();
    // Typing a comma must not be swallowed while adding a second repo.
    const repos = page.locator("label", { hasText: "GitHub repos to watch" }).locator("input");
    await repos.fill("https://github.com/example/core.git");
    await repos.pressSequentially(", example/circuits");
    await expect(repos).toHaveValue(/, example\/circuits$/);
    const [saved] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/admin/projects") && r.request().method() === "POST"),
      page.getByRole("button", { name: "Save project" }).click(),
    ]);
    expect(saved.status(), await saved.text()).toBe(200);
    const { id } = (await saved.json()) as { id: string };
    await expect(page).toHaveURL(new RegExp(`/admin/projects/${id}$`));
    const detail = await (await page.request.get(`/api/admin/projects/${id}`)).json();
    expect(detail.project.slug).toBe("example-privacy");
    expect(detail.project.logoUrl).toBeNull();
    expect(detail.project.githubRepos).toEqual(["example/core", "example/circuits"]);
    expect(detail.project.xHandle).toBe("ExamplePriv");
    expect(detail.project.tagline.length).toBeLessThanOrEqual(200);
  });

  test("runs need an API key, and say so", async ({ page }) => {
    await loginAdmin(page);
    await page.goto("/admin/runs/new");
    await expect(page.getByText(/ANTHROPIC_API_KEY/).first()).toBeVisible();
  });

  test("review shows an evaluation with its evidence", async ({ page }) => {
    await loginAdmin(page);
    // Any evaluation (the seeded fixture may already be published by the admin-flow spec): never skip silently.
    const list = (await (await page.request.get("/api/admin/evaluations")).json()) as { id: string }[] | { evaluations: { id: string }[] };
    const rows = Array.isArray(list) ? list : list.evaluations;
    expect(rows.length).toBeGreaterThan(0);
    await page.goto(`/admin/review/${rows[0]!.id}`);
    await expect(page.getByText("Overall").first()).toBeVisible();
  });
});
