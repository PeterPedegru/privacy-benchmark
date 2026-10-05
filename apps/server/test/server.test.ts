import { criteria, getCriterion, lowestOption } from "@pb/rubric";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDb, setDb } from "../src/db/index.ts";
import { type JudgeAnswer, majority, validateAnswer } from "../src/eval/judge.ts";
import { abortableSleep, assertPublicUrl, FetchAbortedError, fetchSignal, isBlockedIp, safeFetch, withFetchSignal } from "../src/lib/fetcher.ts";
import { redact } from "../src/lib/redact.ts";
import { importGoldenAsDemo } from "../src/services/demo.ts";
import type { GoldenFile } from "../src/services/golden.ts";
import { verifyQuote } from "../src/services/quotes.ts";
import { MEMO_MAX_BYTES, publishRelease, snapshotMemo, snapshotMemoStats, unpublishProject } from "../src/services/snapshots.ts";
import { compareSemver, normalizeVersion, parseSemver } from "../src/services/versions.ts";

const SOURCE = "Alpha has no pause function. Users hold their own viewing keys; nobody else can decrypt notes. The core contracts are immutable.";

function fixture(slug: string, best: boolean): GoldenFile {
  return {
    project: {
      slug,
      name: slug === "alpha" ? "Alpha" : "Beta",
      website: `https://${slug}.example.org`,
      logoUrl: null,
      tagline: "Test project",
      description: "A fixture.",
      category: "l2",
      mechanism: "private_execution",
      attributes: ["zk"],
      chains: ["Ethereum"],
    },
    asOf: "2026-09-30",
    summary: "Fixture summary.",
    context: { status: "Mainnet" },
    powers: ["No protocol-level pause"],
    sources: [
      { id: "landscape", url: `https://notes.example.org/${slug}`, title: "Notes", kind: "editor_note", sourceClass: "independent", date: "2026-09-30" },
    ],
    answers: criteria.map((c) => {
      const opt = best ? c.options.reduce((a, b) => (b.points > a.points ? b : a)) : lowestOption(c);
      return {
        criterionId: c.id,
        status: "answered" as const,
        optionId: opt.id,
        rationale: "Fixture rationale for this criterion.",
        confidence: "high" as const,
        evidence: c.id === "custody.pause.pause-fn" ? [{ sourceId: "landscape", quote: "Alpha has no pause function.", claim: "No pause" }] : [],
      };
    }),
    matrix: { public_observer: { amount: { state: "private" } } },
  };
}

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const db = await openDb({ log: () => {} });
  setDb(db);
  const a = await importGoldenAsDemo(db, fixture("alpha", true), SOURCE);
  const b = await importGoldenAsDemo(db, fixture("beta", false), SOURCE);
  await publishRelease(db, { evaluationIds: [a, b], label: "Demo", notes: "", isDemo: true });
  app = createApp();
});

describe("public API", () => {
  it("serves the leaderboard with versioned rows, best first", async () => {
    const res = await app.request("/api/public/leaderboard");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].slug).toBe("alpha");
    expect(body.rows[0].overall).toBeCloseTo(100, 4);
    expect(body.rows[0].level).toBe("Z5");
    expect(body.rows[1].overall).toBe(0);
    expect(body.release.isDemo).toBe(true);
    expect(body.rows[0].benchmarks["custody.pause"].score).toBeCloseTo(100, 4);
  });

  it("serves a project snapshot with evidence and flags", async () => {
    const res = await app.request("/api/public/projects/alpha");
    const body = await res.json();
    const pause = body.snapshot.criteria["custody.pause.pause-fn"];
    expect(pause.evidence[0].verified).toBe(true);
    expect(pause.flags).not.toContain("unverified");
    // Answers without evidence are flagged unverified.
    expect(body.snapshot.criteria["custody.pause.halt"].flags).toContain("unverified");
    expect(body.snapshot.sources).toHaveLength(1);
  });

  it("compares projects and 404s unknown ones", async () => {
    const res = await app.request("/api/public/compare?p=alpha,beta,nope");
    const body = await res.json();
    expect(body.snapshots.map((s: { project: { slug: string } }) => s.project.slug)).toEqual(["alpha", "beta"]);
    expect((await app.request("/api/public/projects/nope")).status).toBe(404);
  });

  it("exports CSV and publishes the rubric and prompts", async () => {
    const rel = (await (await app.request("/api/public/releases")).json())[0];
    const csv = await (await app.request(`/api/public/releases/${rel.id}/export.csv`)).text();
    expect(csv.split("\n")[0]).toContain("custody.pause");
    expect(csv).toContain("Alpha");
    const rubric = await (await app.request("/api/public/rubric")).json();
    expect(rubric.suites).toHaveLength(7);
    const prompts = await (await app.request("/api/public/prompts")).json();
    expect(Object.keys(prompts.prompts)).toContain("judge.custody");
  });

  it("renders cards as PNG", async () => {
    const post = await app.request("/api/public/cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "table", projects: ["alpha", "beta"], focus: "alpha", rowSet: "key" }),
    });
    const { id } = await post.json();
    for (const path of [`/og/card/${id}.png`, "/og/home.png", "/og/project/alpha.png"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(5000);
    }
    for (const template of ["headtohead", "spotlight"]) {
      const c = Buffer.from(JSON.stringify({ template, projects: ["alpha", "beta"], size: "portrait", theme: "dark" })).toString("base64url");
      expect((await app.request(`/og/card.png?c=${c}`)).status).toBe(200);
    }
    const share = await (await app.request(`/c/${id}`)).text();
    expect(share).toContain(`og:image`);
  });
});

describe("admin auth", () => {
  it("rejects unauthenticated and bad-password requests, accepts the right one with CSRF", async () => {
    expect((await app.request("/api/admin/overview")).status).toBe(401);
    const bad = await app.request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(bad.status).toBe(401);
    const ok = await app.request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test-password" }),
    });
    expect(ok.status).toBe(200);
    const cookies = ok.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const csrf = /pb_csrf=([^;]+)/.exec(cookies)![1]!;
    expect((await app.request("/api/admin/overview", { headers: { cookie: cookies } })).status).toBe(200);
    // Mutations need the CSRF header.
    const noCsrf = await app.request("/api/admin/versions/check-all", { method: "POST", headers: { cookie: cookies } });
    expect(noCsrf.status).toBe(403);
    const projects = await (await app.request("/api/admin/projects", { headers: { cookie: cookies } })).json();
    expect(projects.map((p: { slug: string }) => p.slug).sort()).toEqual(["alpha", "beta"]);
    const withCsrf = await app.request(`/api/admin/projects/${projects[0].id}/versions`, {
      method: "POST",
      headers: { cookie: cookies, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ label: "Alpha V6", releasedAt: "2026-10-01" }),
    });
    expect(withCsrf.status).toBe(200);
    expect((await withCsrf.json()).version).toBe("alpha-v6");
  });
});

describe("safety and helpers", () => {
  it("blocks private and non-http URLs", async () => {
    for (const u of [
      "http://127.0.0.1/",
      "http://localhost:8787/",
      "http://10.0.0.5/",
      "file:///etc/passwd",
      "http://[::1]/",
      "http://169.254.169.254/latest",
      // IPv4 hidden in IPv6 literals (the URL parser rewrites ::ffff:127.0.0.1 to ::ffff:7f00:1)
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[0:0:0:0:0:ffff:127.0.0.1]/",
      "http://[::ffff:a9fe:a9fe]/",
      "http://[64:ff9b::7f00:1]/",
      "http://[2002:7f00:1::]/",
      "http://[fe90::1]/",
      "http://198.18.0.1/",
      "http://100.64.0.1/",
      "https://example.org:8443/",
    ]) {
      await expect(assertPublicUrl(u), u).rejects.toThrow();
    }
    expect(isBlockedIp("93.184.216.34")).toBe(false);
    expect(isBlockedIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });

  it("stops fetching and waiting when its signal, or the refresh it runs in, is aborted (R4-17)", async () => {
    // Before any DNS lookup or connection.
    await expect(safeFetch("https://example.org/", { signal: AbortSignal.abort("Cancelled") })).rejects.toThrow(FetchAbortedError);
    await expect(withFetchSignal(AbortSignal.abort("Cancelled"), () => safeFetch("https://example.org/"))).rejects.toThrow("Stopped: Cancelled");
    // A pause between fetches ends as soon as the refresh stops.
    const ctrl = new AbortController();
    const started = Date.now();
    const pause = withFetchSignal(ctrl.signal, () => abortableSleep(30_000));
    setTimeout(() => ctrl.abort("Cancelled"), 20);
    await expect(pause).rejects.toThrow(FetchAbortedError);
    expect(Date.now() - started).toBeLessThan(5000);
    // Outside a refresh nothing changes.
    expect(fetchSignal()).toBeUndefined();
    await expect(abortableSleep(1)).resolves.toBeUndefined();
  });

  it("redacts configured secrets", () => {
    process.env.RPC_URL_1 = "https://eth.example-rpc.io/v2/SUPERSECRETKEY123";
    expect(redact("RPC failed. URL: https://eth.example-rpc.io/v2/SUPERSECRETKEY123 status 429")).not.toContain("SUPERSECRETKEY123");
    delete process.env.RPC_URL_1;
  });

  it("verifies quotes exactly, fuzzily, and rejects inventions", () => {
    expect(verifyQuote("Alpha has no pause function.", SOURCE).method).toBe("exact");
    expect(verifyQuote("users hold their own viewing keys; nobody else can decrypt notes", SOURCE).verified).toBe(true);
    expect(verifyQuote("Users hold their own viewing-keys, nobody else can decrypt notes", SOURCE).verified).toBe(true);
    expect(verifyQuote("A multisig can pause withdrawals at any time.", SOURCE).verified).toBe(false);
  });

  it("never verifies a quote whose meaning differs from the source, and stores the source's own words", () => {
    const src =
      "The security council can pause the rollup for up to 30 days without a timelock delay. Upgrades to the portal only take effect after governance approval.";
    for (const altered of [
      "The security council cannot pause the rollup for up to 30 days without a timelock delay.",
      "The security council can pause the rollup for up to 3 days without a timelock delay.",
      "The security council can pause the rollup for up to 30 days with a timelock delay.",
      "Upgrades to the pool take effect after governance approval.",
    ]) {
      expect(verifyQuote(altered, src).verified, altered).toBe(false);
    }
    // Too short to stand alone.
    expect(verifyQuote("no pause", "There is no pause function.").verified).toBe(false);
    // A near match with the same meaning verifies, and the stored text is the source's.
    const near = verifyQuote("The Security Council can pause the rollup for up to 30 days, without a timelock delay", src);
    expect(near.verified).toBe(true);
    expect(near.span).toBe("The security council can pause the rollup for up to 30 days without a timelock delay.");
    expect(near.context).toContain("Upgrades to the portal");
    // Misses come back with the closest real passage so the researcher can quote it exactly.
    const miss = verifyQuote("The council is able to halt the rollup for thirty days without any delay", src);
    expect(miss.verified).toBe(false);
    expect(miss.closest).toBeTruthy();
  });

  it("parses and compares versions", () => {
    expect(parseSemver("v2.1.0")).toMatchObject({ major: 2, minor: 1, patch: 0 });
    expect(parseSemver("aztec-packages-v0.87.2")).toMatchObject({ major: 0, minor: 87, patch: 2 });
    expect(parseSemver("alpha-v5")).toBeNull();
    expect(compareSemver(parseSemver("1.2.0")!, parseSemver("1.10.0")!)).toBeLessThan(0);
    expect(normalizeVersion("Alpha V5")).toBe("alpha-v5");
  });

  it("validates judge answers against the rubric and evidence", () => {
    const c = getCriterion("custody.pause.pause-fn");
    const a = (o: Partial<JudgeAnswer>): JudgeAnswer => ({
      criterionId: c.id,
      status: "answered",
      optionId: "none",
      rationale: "x",
      evidenceIds: [],
      decisiveEvidenceIds: [],
      confidence: "high",
      ...o,
    });
    const ev = [{ id: "e1", criterionId: c.id, verified: true, stance: "supports", sourceClass: "code_onchain" } as never];
    const ok = validateAnswer(a({ evidenceIds: ["e1"] }), c, ev);
    expect(ok.answer.status).toBe("answered");
    // A judge that doesn't single out decisive records relied on everything it cited.
    expect(ok.answer.decisiveEvidenceIds).toEqual(["e1"]);
    expect(validateAnswer(a({}), c, []).answer.status).toBe("unknown");
    expect(validateAnswer(a({ optionId: "made-up", evidenceIds: ["e1"] }), c, ev).answer.status).toBe("unknown");
    expect(validateAnswer(a({ status: "not_applicable", optionId: null, confidence: "low" }), c, []).answer.status).toBe("unknown");
  });

  it("lets the judge cite evidence filed under a related criterion, and nothing unrelated", () => {
    const halt = getCriterion("custody.pause.halt");
    const ev = [
      { id: "uptime", criterionId: "custody.pause.track-record", verified: true, stance: "supports", sourceClass: "independent" },
      { id: "far", criterionId: "coverage.confidentiality.amounts", verified: true, stance: "supports", sourceClass: "independent" },
    ] as never[];
    const base = { criterionId: halt.id, status: "answered" as const, optionId: "no", rationale: "", confidence: "high" as const };
    const sibling = validateAnswer({ ...base, evidenceIds: ["uptime"], decisiveEvidenceIds: ["uptime"] }, halt, ev);
    expect(sibling.answer.status).toBe("answered");
    const unrelated = validateAnswer({ ...base, evidenceIds: ["far"], decisiveEvidenceIds: ["far"] }, halt, ev);
    expect(unrelated.answer.status).toBe("unknown");
    expect(unrelated.flags).toContain("needs_quote");
  });

  it("reads conflict from decisive evidence, not the researcher's stance polarity", () => {
    const c = getCriterion("custody.pause.pause-fn");
    // A middle option established by a code record the researcher labelled "contradicts" is not a conflict.
    const ev = [{ id: "code", criterionId: c.id, verified: true, stance: "contradicts", sourceClass: "code_onchain" }] as never[];
    const mid = validateAnswer(
      { criterionId: c.id, status: "answered", optionId: "gov-delay", rationale: "", evidenceIds: ["code"], decisiveEvidenceIds: ["code"], confidence: "high" },
      c,
      ev,
    );
    expect(mid.flags).not.toContain("evidence_conflict");
    // The top option resting on docs while onchain code argues against it is.
    const ev2 = [
      { id: "docs", criterionId: c.id, verified: true, stance: "supports", sourceClass: "official_docs" },
      { id: "chain", criterionId: c.id, verified: true, stance: "contradicts", sourceClass: "code_onchain" },
    ] as never[];
    const top = validateAnswer(
      {
        criterionId: c.id,
        status: "answered",
        optionId: "none",
        rationale: "",
        evidenceIds: ["docs", "chain"],
        decisiveEvidenceIds: ["docs"],
        confidence: "high",
      },
      c,
      ev2,
    );
    expect(top.flags).toContain("evidence_conflict");
  });

  it("majority vote: a split establishes nothing and proposes the most cautious answer", () => {
    const c = getCriterion("custody.pause.pause-fn");
    const v = (optionId: string): JudgeAnswer => ({
      criterionId: c.id,
      status: "answered",
      optionId,
      rationale: "",
      evidenceIds: [],
      decisiveEvidenceIds: [],
      confidence: "high",
    });
    expect(majority(c, [v("none"), v("none"), v("fast-path")]).answer.optionId).toBe("none");
    const split = majority(c, [v("none"), v("gov-delay"), v("fast-path")]);
    expect(split.split).toBe(true);
    expect(split.answer.status).toBe("unknown");
    expect(split.answer.optionId).toBeNull();
    expect(split.proposedOptionId).toBe("fast-path");
  });
});

import { cohensKappa } from "../src/scripts/eval-golden.ts";

describe("golden eval metrics", () => {
  it("weights near misses lightly and bounds kappa with a bootstrap interval", async () => {
    const { weightedKappa, bootstrap } = await import("../src/scripts/eval-golden.ts");
    const exact = Array.from({ length: 20 }, (_, i) => ({ truthScore: (i % 5) / 4, predScore: (i % 5) / 4 }));
    expect(weightedKappa(exact)).toBe(1);
    const near = exact.map((p) => ({ ...p, predScore: Math.min(1, p.truthScore + 0.25) }));
    const far = exact.map((p) => ({ ...p, predScore: 1 - p.truthScore }));
    expect(weightedKappa(near)!).toBeGreaterThan(weightedKappa(far)!);
    const ci = bootstrap(
      exact.map((_p, i) => ({ truth: String(i % 3), pred: String(i % 3) })),
      cohensKappa,
    );
    expect(ci).toEqual([1, 1]);
  });

  it("computes Cohen's kappa", () => {
    expect(
      cohensKappa([
        { truth: "a", pred: "a" },
        { truth: "b", pred: "b" },
      ]),
    ).toBe(1);
    const k = cohensKappa([
      { truth: "a", pred: "a" },
      { truth: "a", pred: "b" },
      { truth: "b", pred: "b" },
      { truth: "b", pred: "a" },
    ]);
    expect(k).toBeCloseTo(0, 6);
  });
});

import { modelFor, STAGE_TIER } from "../src/env.ts";
import { capsFor, modelExtras } from "../src/lib/llm.ts";

describe("model tiers", () => {
  it("routes writing to Sonnet and every judgment-heavy stage (code, research, judge, skeptic, changes) to Opus", () => {
    expect(modelFor("scout")).toBe("claude-sonnet-5-5");
    expect(modelFor("research")).toBe("claude-opus-5-5");
    expect(modelFor("changes")).toBe("claude-opus-5-5");
    expect(modelFor("versions")).toBe("claude-sonnet-5-5");
    expect(modelFor("summary")).toBe("claude-sonnet-5-5");
    expect(modelFor("intake")).toBe("claude-sonnet-5-5");
    expect(modelFor("judge")).toBe("claude-opus-5-5");
    expect(modelFor("skeptic")).toBe("claude-opus-5-5");
    expect(modelFor("code")).toBe("claude-opus-5-5");
    expect(Object.keys(STAGE_TIER).sort()).toEqual(["changes", "code", "codemap", "intake", "judge", "research", "scout", "skeptic", "summary", "versions"]);
  });
  it("only sends parameters each model accepts", () => {
    expect(capsFor("claude-haiku-4-5")).toEqual({ adaptive: false, effort: false, fallbacks: false, webSearch: "web_search_20250305" });
    expect(modelExtras("claude-haiku-4-5", "high")).toEqual({ thinking: undefined, effort: undefined, fallbackParams: {} });
    const sonnet = modelExtras("claude-sonnet-5-5", "low");
    expect(sonnet.thinking).toEqual({ type: "adaptive" });
    expect(sonnet.effort).toBe("low");
    expect(sonnet.fallbackParams).toEqual({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    expect(capsFor("claude-opus-5-5").webSearch).toBe("web_search_20260209");
  });
});

import { eq } from "drizzle-orm";
import { getDb, schema } from "../src/db/index.ts";
import { isRealSecret } from "../src/env.ts";
import { normalizeHandle } from "../src/lib/externals.ts";
import { kbOverview, searchSources, storeKbSource } from "../src/services/kb.ts";

describe("knowledge base", () => {
  const projectId = async () => (await getDb().select().from(schema.projects).where(eq(schema.projects.slug, "alpha")))[0]!.id;

  it("stores sources once per URL and keeps the full-text index in sync", async () => {
    const db = getDb();
    const pid = await projectId();
    const id = await storeKbSource(db, pid, {
      url: "https://docs.alpha.example.org/security/upgrades",
      title: "Upgrades",
      kind: "docs",
      sourceClass: "official_docs",
      content: "The rollup contracts sit behind a proxy. A 3-of-5 security council can upgrade them without a timelock delay.",
      meta: { section: "docs" },
    });
    expect((await searchSources(db, pid, "security council timelock"))[0]?.id).toBe(id);
    // Re-ingesting the same URL updates in place, and the index follows the new text.
    const again = await storeKbSource(db, pid, {
      url: "https://docs.alpha.example.org/security/upgrades",
      title: "Upgrades",
      kind: "docs",
      sourceClass: "official_docs",
      content: "Upgrades go through governance with a 30 day exit window.",
      meta: { section: "docs" },
    });
    expect(again).toBe(id);
    expect(await searchSources(db, pid, "security council")).toHaveLength(0);
    const hit = (await searchSources(db, pid, "exit window"))[0];
    expect(hit?.id).toBe(id);
    expect(hit?.snippet).toContain("«exit»");
  });

  it("filters by kind, hides editor notes on request, and falls back to any-term matches", async () => {
    const db = getDb();
    const pid = await projectId();
    await storeKbSource(db, pid, {
      url: "https://github.com/alpha/core/blob/v1/src/Rollup.sol",
      title: "alpha/core@v1 src/Rollup.sol",
      kind: "code",
      sourceClass: "code_onchain",
      content: "function pause() external onlyOwner { _pause(); }",
      meta: { section: "code" },
    });
    expect((await searchSources(db, pid, "pause onlyOwner", { kinds: ["code"] })).map((h) => h.kind)).toEqual(["code"]);
    expect(await searchSources(db, pid, "pause onlyOwner", { kinds: ["docs"] })).toHaveLength(0);
    // The fixture's editor note mentions "pause"; golden runs must not see it.
    expect((await searchSources(db, pid, "pause function")).some((h) => h.kind === "editor_note")).toBe(true);
    expect((await searchSources(db, pid, "pause function", { excludeEditorNotes: true })).some((h) => h.kind === "editor_note")).toBe(false);
    // No source has every term, so the search widens to any term.
    expect((await searchSources(db, pid, "pause zebra-crossing")).length).toBeGreaterThan(0);
    expect(await searchSources(db, pid, "")).toEqual([]);
    expect(await kbOverview(db, pid, { excludeEditorNotes: true })).not.toContain("editor_note");
    expect(await kbOverview(db, pid)).toContain("code: 1 sources");
  });

  it("treats placeholder keys as unset and normalizes X handles", () => {
    expect(isRealSecret("dummy")).toBe(false);
    expect(isRealSecret("replace-me")).toBe(false);
    expect(isRealSecret("")).toBe(false);
    expect(isRealSecret("sk-live-abc123")).toBe(true);
    expect(normalizeHandle("https://x.com/aztecnetwork?lang=en")).toBe("aztecnetwork");
    expect(normalizeHandle("@Railgun_Project")).toBe("Railgun_Project");
    expect(normalizeHandle("not a handle")).toBeNull();
  });
});

describe("project input", () => {
  it("cleans cosmetic problems instead of rejecting, and explains real ones", async () => {
    const login = await app.request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
    });
    const cookies = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const token = /pb_csrf=([^;]+)/.exec(cookies)?.[1] ?? "";
    const post = (body: unknown) =>
      app.request("/api/admin/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookies, "x-csrf-token": decodeURIComponent(token) },
        body: JSON.stringify(body),
      });
    const ok = await post({
      slug: "My Shiny Project",
      name: "Shiny",
      websiteUrl: "https://shiny.example.org",
      logoUrl: `data:image/svg+xml;base64,${"A".repeat(3000)}`,
      tagline: "t".repeat(400),
      githubRepos: ["https://github.com/shiny/core.git", "shiny/core", "not a repo"],
      xHandle: "https://x.com/ShinyPriv",
      docsUrl: "",
    });
    expect(ok.status).toBe(200);
    const { id } = (await ok.json()) as { id: string };
    const p = (await getDb().select().from(schema.projects).where(eq(schema.projects.id, id)))[0]!;
    expect(p.slug).toBe("my-shiny-project");
    expect(p.logoUrl).toBeNull();
    expect(p.tagline).toHaveLength(200);
    expect(p.githubRepos).toEqual(["shiny/core"]);
    expect(p.xHandle).toBe("ShinyPriv");
    expect(p.docsUrl).toBeNull();
    const bad = await post({ name: "No site", slug: "no-site", websiteUrl: "not a url" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toMatch(/^Website: /);
  });
});

import { STAGE_TOOLS } from "../src/eval/pipeline.ts";
import { allToolDefinitions } from "../src/eval/tools.ts";

describe("stage tool lists", () => {
  it("stay within the API's limit of 20 strict tools per request", () => {
    for (const [stage, tools] of Object.entries(STAGE_TOOLS)) {
      expect(tools.length, stage).toBeLessThanOrEqual(20);
      expect(new Set(tools).size, `${stage} has duplicates`).toBe(tools.length);
    }
  });
});

describe("tool schemas", () => {
  it("only use JSON Schema features that strict tool use accepts", () => {
    // Strict mode rejects numeric and length constraints, and needs closed objects.
    const forbidden = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "uniqueItems"];
    const problems: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      for (const k of forbidden) if (k in n) problems.push(`${path}.${k}`);
      if (typeof n.minItems === "number" && n.minItems > 1) problems.push(`${path}.minItems`);
      if (n.type === "object" && n.additionalProperties !== false) problems.push(`${path} is not closed`);
      for (const [k, v] of Object.entries(n)) if (typeof v === "object") walk(v, `${path}.${k}`);
    };
    const defs = allToolDefinitions(criteria.map((c) => c.id));
    for (const [name, def] of Object.entries(defs)) if ((def as { strict?: boolean }).strict) walk(def.input_schema, name);
    expect(problems).toEqual([]);
    expect(Object.keys(defs).length).toBeGreaterThan(15);
  });
});

import { findQuoteSource } from "../src/services/quotes.ts";

describe("quote matching robustness", () => {
  const code = "function relay(IPrivacyPool.Withdrawal calldata _withdrawal, bytes calldata _proof) external nonReentrant { _relay(_withdrawal); }";
  it("anchors on words, not punctuation-joined tokens", () => {
    expect(verifyQuote("function relay(IPrivacyPool.Withdrawal calldata _withdrawal, bytes calldata _proof) external", code).verified).toBe(true);
  });
  it("verifies ellipsis-stitched quotes segment by segment, in order", () => {
    const src =
      "Deposits are public. Withdrawals require a proof of membership in the association set. Ragequit lets the original depositor exit publicly at any time.";
    const ok = verifyQuote("Withdrawals require a proof of membership … the original depositor exit publicly at any time", src);
    expect(ok.verified).toBe(true);
    expect(ok.span).toContain(" … ");
    expect(verifyQuote("Ragequit lets the original depositor exit … Withdrawals require a proof of membership", src).verified).toBe(false);
  });
  it("re-attributes a quote to the source that contains it", () => {
    const sources = [
      { id: "a", contentMd: "Nothing relevant here at all, just navigation text." },
      { id: "b", contentMd: "The OWNER_ROLE can upgrade the Entrypoint through UUPS without a timelock." },
    ];
    expect(findQuoteSource("The OWNER_ROLE can upgrade the Entrypoint through UUPS without a timelock.", sources)?.source.id).toBe("b");
    expect(findQuoteSource("Nobody can upgrade anything.", sources)).toBeNull();
  });
});

describe("snapshot memo", () => {
  it("is bounded, so request-derived keys can't grow memory without limit", async () => {
    const db = await openDb({ log: () => {} });
    let builds = 0;
    for (let i = 0; i < 1000; i++) await snapshotMemo(db, `k${i}`, () => ++builds);
    expect(builds).toBe(1000);
    // Recent keys are still cached; the oldest were evicted and rebuild.
    expect(await snapshotMemo(db, "k999", () => -1)).toBe(1000);
    expect(await snapshotMemo(db, "k0", () => -1)).toBe(-1);
  });

  it("is bounded by size too: big bodies can't hold more than 32 MB (R3-SEC-6)", async () => {
    const db = await openDb({ log: () => {} });
    const body = "x".repeat(3 * 1024 * 1024);
    for (let i = 0; i < 40; i++) await snapshotMemo(db, `big${i}`, () => `${body}${i}`);
    const stats = await snapshotMemoStats(db);
    expect(stats.bytes).toBeLessThanOrEqual(MEMO_MAX_BYTES);
    expect(stats.entries).toBeLessThan(40);
    expect(await snapshotMemo(db, "big39", () => "rebuilt")).toBe(`${body}39`);
  });
});

describe("public releases list", () => {
  it("hides demo releases only while a real release still has a visible result", async () => {
    const db = getDb();
    const app = createApp();
    const labels = async () => ((await (await app.request("/api/public/releases")).json()) as { label: string }[]).map((r) => r.label);
    expect(await labels()).toContain("Demo");
    // A real release of the alpha project hides the demo, on the leaderboard and in this list alike.
    const real = await importGoldenAsDemo(db, fixture("alpha", false), SOURCE);
    await db.update(schema.evaluations).set({ isDemo: false }).where(eq(schema.evaluations.id, real));
    await publishRelease(db, { evaluationIds: [real], label: "Real", notes: "" });
    expect(await labels()).toEqual(["Real"]);
    // Rolled back: the site shows the demo again, and so does the list (the empty real release stays listed).
    const ev = (await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, real)))[0]!;
    await unpublishProject(db, ev.projectId, ev.versionId);
    expect(await labels()).toEqual(expect.arrayContaining(["Real", "Demo"]));
  });
});
