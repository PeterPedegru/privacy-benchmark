import { expect, type Page, test } from "@playwright/test";
import { AUTH_FILE, leaderboard, loginAdmin } from "./helpers";

/**
 * The editor's publishing path (R3-TEST-14), on the fixture seeded by `pnpm seed:e2e` (apps/server/src/scripts/
 * seed-e2e.ts): a finished, non-demo evaluation in review with two flagged criteria. One serial flow, because each
 * step depends on the state the previous one left; retries can't help a stateful flow, so there are none.
 */
const FIXTURE = { slug: "e2e-fixture", name: "E2E Fixture Protocol", evaluation: "e2e-evaluation" };
const FLAGGED = { accept: "custody.pause.pause-fn", override: "coverage.confidentiality.amounts" };
const RELEASE = "E2E 1";

/** A criterion's card on the review page, found by the criterion id it shows. */
const card = (page: Page, criterionId: string) =>
  page
    .locator("code", { hasText: new RegExp(`^${criterionId.replace(/\./g, "\\.")}$`) })
    .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' rounded-2xl ')][1]");

async function tryPublish(page: Page) {
  await page.goto("/admin/releases");
  await page.getByRole("button", { name: new RegExp(FIXTURE.name) }).click();
  await page.getByLabel("Label", { exact: true }).fill(RELEASE);
  await page.getByRole("button", { name: /^Publish 1 evaluation$/ }).click();
}

test.describe("admin publishing flow", () => {
  test.use({ storageState: AUTH_FILE });
  test.describe.configure({ retries: 0 });

  test("accept, override, publish past flags, roll back, and decide a correction", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await loginAdmin(page);

    await test.step("accepting a flagged answer clears its flag, no reason needed", async () => {
      await page.goto(`/admin/review/${FIXTURE.evaluation}`);
      await expect(page.getByRole("tab", { name: "Flag queue (2)" })).toBeVisible();
      // "Accept all" asks once more before it accepts; cancelling leaves every flag open.
      await page.getByRole("button", { name: "Accept all (2)" }).click();
      await expect(page.getByRole("button", { name: "Accept all 2 as they are" })).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("tab", { name: "Flag queue (2)" })).toBeVisible();
      await card(page, FLAGGED.accept).getByRole("button", { name: "Accept", exact: true }).click();
      await expect(page.getByRole("tab", { name: "Flag queue (1)" })).toBeVisible();
      await expect(page.locator("code", { hasText: FLAGGED.accept })).toHaveCount(0);
    });

    await test.step("an override makes the summary stale, which blocks publishing until it's regenerated", async () => {
      const override = card(page, FLAGGED.override);
      await override.locator("select").selectOption("ranges");
      await override.getByPlaceholder("Reason (required to override, shown publicly)").fill("The docs say amounts are bucketed into ranges.");
      await override.getByRole("button", { name: "Override", exact: true }).click();
      await expect(page.getByText("No open flags.")).toBeVisible();

      await tryPublish(page);
      await expect(page.getByText(/overridden after the summary was written/)).toBeVisible();
      // Releases names the stale summary and gives the command that rewrites it locally, through Claude Code.
      await expect(page.getByText("summary stale")).toBeVisible();
      await expect(page.getByText(/1 of 1 summaries must be regenerated before publishing/)).toBeVisible();
      await expect(page.locator("code", { hasText: `pnpm bench summarize ${FIXTURE.evaluation}` })).toBeVisible();

      // Regenerating needs the model; the e2e server has no API key, and says so.
      await page.goto(`/admin/review/${FIXTURE.evaluation}`);
      await page.getByRole("button", { name: "Regenerate summary" }).click();
      await expect(page.getByText(/Set ANTHROPIC_API_KEY to regenerate summaries/)).toBeVisible();

      // Without a summary to regenerate, the editor clears the override instead.
      await page.getByRole("button", { name: /^Coverage/ }).click();
      await card(page, FLAGGED.override).getByRole("button", { name: "clear" }).click();
      await expect(card(page, FLAGGED.override).getByText(/^Override:/)).toHaveCount(0);
    });

    await test.step("unresolved flags block publishing; a public justification publishes past them", async () => {
      await tryPublish(page);
      await expect(page.getByText(/flagged criteria still need review/).first()).toBeVisible();
      // With the override cleared, the summary describes the answers again.
      await expect(page.getByText("summary stale")).toHaveCount(0);
      await expect(page.getByText("Regenerate the summaries of everything selected")).toBeVisible();
      const why = page.locator("label", { hasText: "Why publish past the review gates?" }).locator("textarea");
      await why.fill("The remaining flag is a wording conflict between two docs pages; the answer stands.");
      await page.getByRole("button", { name: "Publish anyway" }).click();
      await expect(page.getByText("Release published")).toBeVisible();

      await page.goto(`/projects/${FIXTURE.slug}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(FIXTURE.name);
      await expect(page.getByText(`Release ${RELEASE}`).first()).toBeVisible();
      const api = await (await page.request.get(`/api/public/projects/${FIXTURE.slug}`)).json();
      expect(api.snapshot.release.label).toBe(RELEASE);
      const release = await (await page.request.get("/api/admin/releases")).json();
      expect(release.find((r: { label: string }) => r.label === RELEASE).notesMd).toContain("Published with 1 unresolved review flags");
    });

    await test.step("rolling back unpublishes it", async () => {
      await page.goto("/admin/releases");
      const history = page.locator("div.rounded-2xl", { hasText: RELEASE });
      await history.getByRole("button", { name: "Roll back" }).click();
      await expect(history.getByText("superseded")).toBeVisible();
      expect((await page.request.get(`/api/public/projects/${FIXTURE.slug}`)).status()).toBe(404);
      // A new visitor: public JSON may be served from a browser's cache for a minute (max-age=60), by design.
      const visitor = await browser.newContext();
      try {
        const fresh = await visitor.newPage();
        await fresh.goto(new URL(`/projects/${FIXTURE.slug}`, page.url()).href);
        await expect(fresh.getByText("Project not found")).toBeVisible();
      } finally {
        await visitor.close();
      }
    });

    await test.step("a correction is accepted with a public reason", async () => {
      // Submitted against a published (demo) project, as a visitor would.
      const { rows } = await leaderboard(page);
      const message = "E2E admin flow: the pause criterion cites a page that has since changed.";
      const sent = await page.request.post("/api/public/corrections", { data: { projectSlug: rows[0]!.slug, message } });
      expect(sent.ok()).toBeTruthy();
      await page.goto("/admin/corrections");
      const correction = page.locator("div.rounded-2xl", { hasText: message });
      const reason = "Checked against the current docs: the page now describes the governance delay.";
      await correction.getByLabel("Public reason for the decision").fill(reason);
      await correction.getByRole("button", { name: "Accept", exact: true }).click();
      await expect(correction.getByText("accepted", { exact: true })).toBeVisible();
      const log = await (await page.request.get("/api/public/corrections")).json();
      expect(log.items.some((i: { note: string; status: string }) => i.note === reason && i.status === "accepted")).toBeTruthy();
      await page.goto("/releases");
      await expect(page.getByText(reason)).toBeVisible();
    });
  });
});
