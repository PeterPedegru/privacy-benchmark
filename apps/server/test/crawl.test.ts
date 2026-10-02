import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DB } from "../src/db/index.ts";

// A tiny in-memory web for the crawler. Each test uses its own host, because robots.txt and sitemaps are cached.
const pages = new Map<string, { status?: number; type?: string; body?: string; redirect?: string; failTimes?: number }>();
/** Latency of every fetch, and the URLs answered (R4-17 tests). */
const web = { delayMs: 0, served: [] as string[] };
vi.mock("../src/lib/fetcher.ts", async (orig) => {
  const actual = await orig<typeof import("../src/lib/fetcher.ts")>();
  return {
    ...actual,
    safeFetch: vi.fn(async (url: string, init: { signal?: AbortSignal } = {}) => {
      // Like the real safeFetch: a stopped refresh's fetches fail at once, waiting ones included (R4-17).
      const signal = init.signal ?? actual.fetchSignal();
      actual.throwIfFetchAborted(signal);
      if (web.delayMs) await actual.abortableSleep(web.delayMs, signal);
      web.served.push(url);
      let u = url;
      for (let i = 0; i < 5; i++) {
        const p = pages.get(u);
        if (p?.redirect) {
          u = p.redirect;
          continue;
        }
        if (!p) return { url: u, status: 404, contentType: "text/html", body: Buffer.from("<html><body>Not found</body></html>") };
        // A transient failure (503 with Retry-After: 0) before the page answers.
        if (p.failTimes) {
          p.failTimes--;
          return { url: u, status: 503, contentType: "text/html", body: Buffer.from("busy"), retryAfterMs: 0 };
        }
        return { url: u, status: p.status ?? 200, contentType: p.type ?? "text/html; charset=utf-8", body: Buffer.from(p.body ?? "") };
      }
      throw new Error("too many redirects");
    }),
  };
});

const {
  crawlRoots,
  dedupeRoots,
  describeFetchStats,
  HOST_CONCURRENCY,
  isNotFoundPage,
  parseFeed,
  parseLlmsTxt,
  parseRobots,
  parseSitemap,
  PENALTY,
  rankBlogUrls,
  robotsAllows,
  compileRobotsPattern,
  robotsPatternMatches,
  rootFromFinalUrl,
  SKIP_EXT,
  storageUrl,
  throttleHost,
  unversionedUrl,
  urlPriority,
  withHostSlot,
} = await import("../src/services/lanes/crawl.ts");

describe("robots.txt", () => {
  it("compiles wildcards and end anchors instead of truncating at '*' (SRC-3)", () => {
    // zama.org and starknet.io: these rules used to become "Disallow: /", blocking the whole site.
    const r = parseRobots("User-agent: *\nDisallow: /*?q=\nDisallow: /*?difficulty=\nDisallow: /*.php$\nDisallow: */trackback\n");
    expect(robotsAllows(r, "/")).toBe(true);
    expect(robotsAllows(r, "/developers/docs")).toBe(true);
    expect(robotsAllows(r, "/search?q=privacy")).toBe(false);
    expect(robotsAllows(r, "/learn?difficulty=easy")).toBe(false);
    expect(robotsAllows(r, "/index.php")).toBe(false);
    expect(robotsAllows(r, "/index.php?x=1")).toBe(true);
    expect(robotsAllows(r, "/2024/post/trackback")).toBe(false);
    expect(robotsPatternMatches(compileRobotsPattern("/a*b$"), "/axxb")).toBe(true);
    expect(robotsPatternMatches(compileRobotsPattern("/a*b$"), "/axxbc")).toBe(false);
    expect(robotsPatternMatches(compileRobotsPattern("/a**b"), "/a-x-b-y")).toBe(true);
    expect(robotsPatternMatches(compileRobotsPattern("*/trackback"), "/2024/post/trackback")).toBe(true);
    expect(robotsPatternMatches(compileRobotsPattern("/a*$"), "/a")).toBe(true);
  });

  it("lets the longest match win, with Allow winning ties", () => {
    const r = parseRobots("User-agent: *\nDisallow: /docs/\nAllow: /docs/public/\nDisallow: /x\nAllow: /x\n");
    expect(robotsAllows(r, "/docs/internal")).toBe(false);
    expect(robotsAllows(r, "/docs/public/page")).toBe(true);
    expect(robotsAllows(r, "/x")).toBe(true);
  });

  it("uses our agent's group when one exists, merges groups and collects sitemaps", () => {
    const text = [
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: GoogleBot",
      "User-agent: PrivacyBenchmarkBot",
      "Disallow: /admin",
      "Crawl-delay: 2",
      "",
      "User-agent: PrivacyBenchmarkBot",
      "Disallow: /drafts",
      "Sitemap: https://docs.example.org/homepage/sitemap.xml",
      "Disallow:",
    ].join("\n");
    const r = parseRobots(text);
    expect(robotsAllows(r, "/docs")).toBe(true);
    expect(robotsAllows(r, "/admin/x")).toBe(false);
    expect(robotsAllows(r, "/drafts/1")).toBe(false);
    expect(r.crawlDelay).toBe(2);
    expect(r.sitemaps).toEqual(["https://docs.example.org/homepage/sitemap.xml"]);
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow: /\n", "SomeoneElse"), "/a")).toBe(false);
  });
});

describe("crawl priority", () => {
  it("puts security, governance, upgrade, key, fee and exit pages first; API reference, versions, locales and legal last", () => {
    const p = (path: string) => urlPriority(`https://docs.example.org${path}`, { seed: "sitemap", depth: 1 });
    const important = ["/participate/governance/upgrades", "/security/council", "/fees", "/exit/escape-hatch", "/protocol/keys"];
    const noise = ["/build/corelib/core-array", "/api-reference/client", "/v0.12.0/intro", "/ja/intro", "/terms-of-service", "/changelog/2025"];
    for (const i of important) for (const n of noise) expect(p(i), `${i} vs ${n}`).toBeGreaterThan(p(n));
    expect(p("/privacy/viewing-keys")).toBeGreaterThan(p("/getting-started/install"));
    expect(urlPriority("https://docs.example.org/", { seed: "start" })).toBeGreaterThan(p("/security/council"));
  });
});

describe("sitemaps, llms.txt and blog ranking", () => {
  it("parses url sets, indexes, lastmod and escapes", () => {
    const s = parseSitemap(
      `<?xml version="1.0"?><urlset><url><loc>https://a.org/x?y=1&amp;z=2</loc><lastmod>2026-09-01</lastmod></url><url><loc><![CDATA[https://a.org/b]]></loc></url></urlset>`,
    );
    expect(s.urls).toEqual([
      { loc: "https://a.org/x?y=1&z=2", lastmod: "2026-09-01" },
      { loc: "https://a.org/b", lastmod: null },
    ]);
    expect(parseSitemap(`<sitemapindex><sitemap><loc>https://a.org/s1.xml</loc></sitemap></sitemapindex>`).sitemaps).toEqual(["https://a.org/s1.xml"]);
  });

  it("reads llms.txt links (relative ones too) and ignores SPA fallbacks", () => {
    const links = parseLlmsTxt(
      "# Aztec\n- [Docs](/index.md)\n- [Fees](/participate/basics/fees.md): fees\nSee https://docs.aztec.network/llms-full.txt.",
      "https://docs.aztec.network/llms.txt",
    );
    expect(links).toEqual(
      expect.arrayContaining([
        "https://docs.aztec.network/index.md",
        "https://docs.aztec.network/participate/basics/fees.md",
        "https://docs.aztec.network/llms-full.txt",
      ]),
    );
    expect(parseLlmsTxt("<!doctype html><html><body>app</body></html>", "https://x.org/llms.txt")).toEqual([]);
  });

  it("stores markdown twins under the page URL", () => {
    expect(storageUrl("https://docs.zama.org/protocol/governance/pausing.md")).toBe("https://docs.zama.org/protocol/governance/pausing");
    expect(storageUrl("https://docs.aztec.network/index.md")).toBe("https://docs.aztec.network/");
  });

  it("ranks risk-relevant blog posts first, then recent ones", () => {
    const ranked = rankBlogUrls(
      [
        { loc: "https://aztec.network/blog/community-call-recap", lastmod: "2026-09-20" },
        { loc: "https://aztec.network/blog/alpha-v5-proving-system-vulnerability", lastmod: "2026-05-01" },
        { loc: "https://aztec.network/blog/alpha-network-security-what-to-expect", lastmod: "2026-04-01" },
        { loc: "https://aztec.network/blog/tag/news", lastmod: "2026-09-29" },
        { loc: "https://aztec.network/about", lastmod: "2026-09-29" },
      ],
      3,
    );
    expect(ranked.map((r) => new URL(r.loc).pathname)).toEqual([
      "/blog/alpha-v5-proving-system-vulnerability",
      "/blog/alpha-network-security-what-to-expect",
      "/blog/community-call-recap",
    ]);
  });

  it("skips locale copies and blog indexes", () => {
    const ranked = rankBlogUrls(
      [
        { loc: "https://aztec.network/ja/blog/alpha-network-security-what-to-expect", lastmod: null },
        { loc: "https://aztec.network/zh/blog", lastmod: null },
        { loc: "https://aztec.network/blog/alpha-network-security-what-to-expect", lastmod: null },
      ],
      10,
    );
    expect(ranked.map((r) => r.loc)).toEqual(["https://aztec.network/blog/alpha-network-security-what-to-expect"]);
  });
});

describe("docs roots", () => {
  it("keeps a docs host whole and a website path to its first segment", () => {
    expect(rootFromFinalUrl("https://docs.zama.org/homepage", "www.zama.org")).toEqual({ url: "https://docs.zama.org/", host: "docs.zama.org", prefix: "" });
    expect(rootFromFinalUrl("https://tempo.xyz/developers/docs", "tempo.xyz")).toEqual({
      url: "https://tempo.xyz/developers",
      host: "tempo.xyz",
      prefix: "/developers",
    });
  });

  it("drops roots nested in another root", () => {
    const roots = dedupeRoots([
      { url: "https://docs.x.org/build", host: "docs.x.org", prefix: "/build" },
      { url: "https://docs.x.org/", host: "docs.x.org", prefix: "" },
      { url: "https://x.org/docs", host: "x.org", prefix: "/docs" },
    ]);
    expect(roots.map((r) => `${r.host}${r.prefix}`)).toEqual(["docs.x.org", "x.org/docs"]);
  });
});

describe("crawler", () => {
  it("seeds from llms.txt and robots sitemaps, follows priority, honours robots and skips noise", async () => {
    const h = "https://docs.crawl-a.test";
    const html = (title: string, body: string, head = "") =>
      `<html><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
    const filler = "This page explains the protocol in enough words to be stored as a docs page, well beyond eighty characters.";
    pages.set(`${h}/robots.txt`, {
      type: "text/plain",
      body: "User-agent: *\nDisallow: /*?q=\nDisallow: /private/\nAllow: /private/public-note\nSitemap: https://docs.crawl-a.test/custom-sitemap.xml\n",
    });
    pages.set(`${h}/llms.txt`, { type: "text/plain", body: "# Docs\n- [Council](/security/council.md)\n- [API](/api/reference.md)\n" });
    const locs = [
      "/intro",
      "/governance/upgrades",
      "/api/core-array",
      "/api/core-dict",
      "/v0.10.0/intro",
      "/ja/intro",
      "/terms",
      "/private/secret",
      "/private/public-note",
      "/fees",
      "/intro-copy",
    ];
    pages.set(`${h}/custom-sitemap.xml`, { type: "application/xml", body: `<urlset>${locs.map((l) => `<url><loc>${h}${l}</loc></url>`).join("")}</urlset>` });
    pages.set(`${h}/`, { body: html("Home", `${filler} <a href="/intro">Intro</a> <a href="/search?q=x">Search</a> <a href="/private/secret">Secret</a>`) });
    pages.set(`${h}/security/council.md`, { type: "text/markdown", body: `# Security Council\n\nA 3-of-5 council can veto upgrades. ${filler}` });
    pages.set(`${h}/governance/upgrades`, {
      body: html("Upgrades (HTML)", filler, `<link rel="alternate" type="text/markdown" href="/governance/upgrades.md">`),
    });
    pages.set(`${h}/governance/upgrades.md`, {
      type: "text/markdown",
      body: `# Upgrades\n\n| Contract | Owner |\n|---|---|\n| Rollup | Governance |\n\n${filler}`,
    });
    pages.set(`${h}/fees`, { body: html("Fees", filler) });
    pages.set(`${h}/intro`, { body: html("Intro", filler) });
    pages.set(`${h}/intro-copy`, { body: html("Intro", filler) });
    for (const l of ["/api/core-array", "/api/core-dict", "/v0.10.0/intro", "/ja/intro", "/terms", "/private/secret", "/private/public-note"])
      pages.set(`${h}${l}`, { body: html(l, filler) });

    const stored: { url: string; title: string; markdown: string }[] = [];
    const r = await crawlRoots([{ url: `${h}/`, host: "docs.crawl-a.test", prefix: "" }], {
      maxPages: 4,
      concurrency: 1,
      onPage: (p) => {
        stored.push(p);
        return true;
      },
    });
    expect(r.stored).toBe(4);
    const paths = stored.map((s) => new URL(s.url).pathname);
    expect(paths).toEqual(["/", "/security/council", "/fees", "/governance/upgrades"]);
    // The markdown twin replaced the HTML conversion, and the .md page got its heading as title.
    expect(stored.find((s) => s.url.endsWith("/governance/upgrades"))?.markdown).toContain("| Rollup | Governance |");
    expect(stored.find((s) => s.url.endsWith("/security/council"))?.title).toBe("Security Council");
  });

  it("skips disallowed, locale, legal and duplicate pages even with budget to spare", async () => {
    const h = "https://docs.crawl-b.test";
    const filler = "Plenty of words about this protocol so that the extracted text is long enough to keep as a page.";
    const html = (t: string) => `<html><head><title>${t}</title></head><body><main><h1>${t}</h1><p>${filler}</p></main></body></html>`;
    pages.set(`${h}/robots.txt`, { type: "text/plain", body: "User-agent: *\nDisallow: /private/\n" });
    pages.set(`${h}/`, {
      body: `<html><head><title>Home</title><link rel="alternate" hreflang="ja" href="/ja/"></head><body><main><p>${filler}</p><a href="/a">A</a><a href="/a-copy">A copy</a><a href="/private/x">P</a><a href="/ja/">JA</a><a href="/legal/terms">T</a><a href="https://other.test/out">Out</a></main></body></html>`,
    });
    pages.set(`${h}/a`, { body: html("A") });
    pages.set(`${h}/a-copy`, { body: html("A") });
    pages.set(`${h}/private/x`, { body: html("Private") });
    pages.set(`${h}/ja/`, { body: html("Japanese") });
    pages.set(`${h}/legal/terms`, { body: html("Terms") });
    const stored: string[] = [];
    await crawlRoots([{ url: `${h}/`, host: "docs.crawl-b.test", prefix: "" }], {
      maxPages: 20,
      onPage: (p) => {
        stored.push(new URL(p.url).pathname);
        return true;
      },
    });
    expect(stored.sort()).toEqual(["/", "/a"]);
  });

  it("never lets API reference pages take more than a tenth of the budget", async () => {
    const h = "https://docs.crawl-d.test";
    const filler = "Reference text long enough to be stored as a page by the crawler, well over eighty characters.";
    const html = (t: string, links = "") => `<html><head><title>${t}</title></head><body><main><h1>${t}</h1><p>${filler}</p>${links}</main></body></html>`;
    const api = Array.from({ length: 40 }, (_, i) => `/build/corelib/fn-${i}`);
    pages.set(`${h}/`, { body: html("Home", `${api.map((a) => `<a href="${a}">${a}</a>`).join("")}<a href="/privacy/overview">Privacy</a>`) });
    for (const a of api) pages.set(`${h}${a}`, { body: html(a) });
    pages.set(`${h}/privacy/overview`, { body: html("Privacy overview") });
    const stored: string[] = [];
    await crawlRoots([{ url: `${h}/`, host: "docs.crawl-d.test", prefix: "" }], {
      maxPages: 30,
      onPage: (p) => {
        stored.push(new URL(p.url).pathname);
        return true;
      },
    });
    expect(stored).toContain("/privacy/overview");
    expect(stored.filter((s) => s.startsWith("/build/corelib")).length).toBe(10);
  });

  it("follows a redirected start host and excludes other lanes' roots", async () => {
    pages.set("https://crawl-c.test/", { redirect: "https://www.crawl-c.test/" });
    const filler = "A marketing site page with enough words in it to be kept by the crawler as a website page.";
    pages.set("https://www.crawl-c.test/", {
      body: `<html><head><title>Home</title></head><body><main><p>${filler}</p><a href="https://crawl-c.test/security">Security</a><a href="/developers/docs/intro">Docs</a></main></body></html>`,
    });
    pages.set("https://crawl-c.test/security", { redirect: "https://www.crawl-c.test/security" });
    pages.set("https://www.crawl-c.test/security", { body: `<html><head><title>Security</title></head><body><main><p>${filler}</p></main></body></html>` });
    pages.set("https://www.crawl-c.test/developers/docs/intro", {
      body: `<html><head><title>Docs</title></head><body><main><p>${filler}</p></main></body></html>`,
    });
    const stored: string[] = [];
    await crawlRoots([{ url: "https://crawl-c.test/", host: "crawl-c.test", prefix: "" }], {
      maxPages: 10,
      exclude: [{ host: "crawl-c.test", prefix: "/developers" }],
      onPage: (p) => {
        stored.push(p.url);
        return true;
      },
    });
    expect(stored.sort()).toEqual(["https://www.crawl-c.test/", "https://www.crawl-c.test/security"]);
  });

  const filler = "Docs text long enough for the crawler to keep this page as content, well beyond eighty characters of prose.";
  const page = (t: string, links = "") => `<html><head><title>${t}</title></head><body><main><h1>${t}</h1><p>${filler}</p>${links}</main></body></html>`;

  it("retries transient failures and counts what still failed (R3-SRC-5)", async () => {
    const h = "https://docs.crawl-e.test";
    pages.set(`${h}/`, { body: page("Home", '<a href="/flaky">Flaky</a><a href="/down">Down</a>') });
    pages.set(`${h}/flaky`, { body: page("Flaky"), failTimes: 1 });
    pages.set(`${h}/down`, { body: page("Down"), failTimes: 5 });
    const stored: string[] = [];
    const r = await crawlRoots([{ url: `${h}/`, host: "docs.crawl-e.test", prefix: "" }], {
      maxPages: 10,
      onPage: (p) => {
        stored.push(new URL(p.url).pathname);
        return true;
      },
    });
    expect(stored.sort()).toEqual(["/", "/flaky"]);
    expect(r.stats).toMatchObject({ failed: 1, retried: 3, failedUrls: [`${h}/down`] });
    expect(describeFetchStats(r.stats)).toMatchObject({ partial: true, note: "1 fetch failures (1× HTTP 503), 3 retries" });
  }, 30_000);

  it("follows links of pages rejected as duplicates, and skips old-version copies of current pages (R3-SRC-9, R3-SRC-14)", async () => {
    const h = "https://docs.crawl-f.test";
    pages.set(`${h}/sitemap.xml`, {
      type: "application/xml",
      body: `<urlset>${["/", "/reference/node", "/next/reference/node", "/0.12/reference/node", "/0.12/reference/only-old"].map((p) => `<url><loc>${h}${p}</loc></url>`).join("")}</urlset>`,
    });
    pages.set(`${h}/`, { body: page("Home", '<a href="/dup">Dup</a>') });
    pages.set(`${h}/dup`, { body: page("Dup", '<a href="/deep/validator">Validator</a>') });
    pages.set(`${h}/deep/validator`, { body: page("Validator") });
    for (const p of ["/reference/node", "/next/reference/node", "/0.12/reference/node", "/0.12/reference/only-old"]) pages.set(`${h}${p}`, { body: page(p) });
    pages.set(`${h}/404`, { body: page("Page not found") });
    const stored: string[] = [];
    const r = await crawlRoots([{ url: `${h}/`, host: "docs.crawl-f.test", prefix: "" }], {
      maxPages: 20,
      onPage: (p) => {
        const path = new URL(p.url).pathname;
        if (path === "/dup") return false; // e.g. a duplicate of a stored row
        stored.push(path);
        return true;
      },
    });
    expect(stored).toContain("/deep/validator");
    expect(stored).toContain("/reference/node");
    expect(stored).toContain("/0.12/reference/only-old");
    expect(stored).not.toContain("/next/reference/node");
    expect(stored).not.toContain("/0.12/reference/node");
    expect(r.skippedCopies).toBe(2);
  });

  it("limits concurrent fetches per host across callers", async () => {
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        withHostSlot("https://busy.test/x", async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(HOST_CONCURRENCY);
    // A host that answered 429 gets one fetch at a time.
    throttleHost("https://limited.test/x", 0, 0);
    let limitedPeak = 0;
    active = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withHostSlot("https://limited.test/y", async () => {
          active++;
          limitedPeak = Math.max(limitedPeak, active);
          await new Promise((r) => setTimeout(r, 2));
          active--;
        }),
      ),
    );
    expect(limitedPeak).toBe(1);
  });
});

describe("docs penalties, soft 404s and blog ranking (R3-SRC-8, R3-SRC-9)", () => {
  it("penalizes generated API trees and skips scripts", () => {
    expect(PENALTY.test("/aztec-nr-api/mainnet/noir_aztec/index")).toBe(true);
    expect(PENALTY.test("/typedoc/classes/Wallet")).toBe(true);
    expect(PENALTY.test("/participate/governance")).toBe(false);
    expect(SKIP_EXT.test("/scripts/add-keys-to-provider.sh")).toBe(true);
    expect(SKIP_EXT.test("/tools/gen.py")).toBe(true);
    expect(unversionedUrl("https://docs.miden.xyz/next/reference/node")).toBe("https://docs.miden.xyz/reference/node");
    expect(unversionedUrl("https://docs.miden.xyz/0.13/reference/node")).toBe("https://docs.miden.xyz/reference/node");
    expect(unversionedUrl("https://docs.miden.xyz/reference/node")).toBeNull();
    expect(isNotFoundPage("Page not found | Miden", "https://docs.miden.xyz/x")).toBe(true);
    expect(isNotFoundPage("Fees", "https://docs.miden.xyz/404.html")).toBe(true);
    expect(isNotFoundPage("Not found in Aztec: a guide", "https://docs.aztec.network/x")).toBe(true);
    expect(isNotFoundPage("Notes and nullifiers", "https://docs.aztec.network/x")).toBe(false);
  });

  it("puts security posts first and dates undated posts from the feed or the blog index", () => {
    const e = (p: string) => ({ loc: `https://aztec.network${p}`, lastmod: null });
    const entries = [
      e("/blog/an-introduction-to-aztec"),
      e("/blog/aztec-2-pre-launch-notes"),
      e("/blog/critical-vulnerability-in-alpha-v4"),
      e("/blog/who-controls-your-privacy-off-switch"),
      e("/blog/introducing-alpha-v5"),
      e("/articles/best-privacy-blockchain-for-banks"),
    ];
    const dates = new Map([["aztec.network/blog/introducing-alpha-v5", "2026-06-01"]]);
    const order = new Map([
      ["aztec.network/blog/who-controls-your-privacy-off-switch", 0],
      ["aztec.network/blog/an-introduction-to-aztec", 9],
      ["aztec.network/blog/aztec-2-pre-launch-notes", 8],
    ]);
    const ranked = rankBlogUrls(entries, 10, { dates, order }).map((x) => new URL(x.loc).pathname);
    expect(ranked[0]).toBe("/blog/critical-vulnerability-in-alpha-v4");
    // Dated (from the feed) before undated; undated by their place on the blog index, newest first.
    expect(ranked.slice(1)).toEqual([
      "/blog/introducing-alpha-v5",
      "/blog/who-controls-your-privacy-off-switch",
      "/blog/aztec-2-pre-launch-notes",
      "/blog/an-introduction-to-aztec",
    ]);
    // SEO article trees are left out when the site has a blog.
    expect(ranked).not.toContain("/articles/best-privacy-blockchain-for-banks");
  });

  it("reads RSS and Atom feeds", () => {
    const rss = `<rss><channel><item><title>A</title><link>https://aztec.network/blog/a</link><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    expect(parseFeed(rss)).toEqual([{ loc: "https://aztec.network/blog/a", lastmod: "2026-09-01" }]);
    const atom = `<feed><entry><title>B</title><link rel="alternate" href="https://miden.xyz/blog/b"/><updated>2026-08-02T00:00:00Z</updated></entry></feed>`;
    expect(parseFeed(atom)).toEqual([{ loc: "https://miden.xyz/blog/b", lastmod: "2026-08-02" }]);
  });
});

const { openDb, schema } = await import("../src/db/index.ts");
const { standaloneContext } = await import("../src/services/lanes/context.ts");
const { ingestBlog } = await import("../src/services/lanes/crawl.ts");
const { isKbRefreshing, KbRefreshAbortedError, refreshKnowledgeBase } = await import("../src/services/kb.ts");

describe("blog lane and the X lane (R4-33)", () => {
  let db: DB;
  beforeAll(async () => {
    db = await openDb({ log: () => {} });
  });

  /** A site whose sitemap lists three undated posts, and a lane context for it. */
  async function site(host: string) {
    const origin = `https://${host}`;
    const posts = ["/blog/team-offsite-recap", "/blog/community-call-notes", "/blog/zeta-partnership-news"];
    pages.set(`${origin}/sitemap.xml`, {
      type: "application/xml",
      body: `<urlset>${posts.map((p) => `<url><loc>${origin}${p}</loc></url>`).join("")}</urlset>`,
    });
    for (const p of posts)
      pages.set(`${origin}${p}`, {
        body: `<html><head><title>${p.slice(6)}</title></head><body><main><h1>${p.slice(6)}</h1><p>${"Post text about the project. ".repeat(20)}</p></main></body></html>`,
      });
    const id = host.split(".")[0]!;
    await db.insert(schema.projects).values({ id, slug: id, name: id, websiteUrl: origin });
    const project = (await db.select().from(schema.projects)).find((p) => p.id === id)!;
    /** What the X lane stores: a post dated 2026-09-20 linking the third post. */
    const storeXPost = async () =>
      await db.insert(schema.sources).values({
        id: `x-${id}`,
        projectId: id,
        url: `https://x.com/${id}#2026-09`,
        kind: "announcement",
        sourceClass: "marketing",
        contentMd: `[2026-09-20] Our new partnership: ${origin}/blog/zeta-partnership-news`,
        origin: "kb",
        meta: { section: "announcements", lane: "x" },
      });
    const stored = async () =>
      (await db.select({ url: schema.sources.url }).from(schema.sources)).map((r) => r.url).filter((u) => u.startsWith(`${origin}/blog/`));
    return { ctx: await standaloneContext(db, project), storeXPost, stored };
  }

  it("ranks undated posts by X-post dates the X lane stores during a first build", async () => {
    // Without waiting (the old behaviour), the X post arrives too late: sitemap order decides.
    const before = await site("racing.example");
    expect((await ingestBlog(before.ctx, null, 1)).count).toBe(1);
    await before.storeXPost();
    expect(await before.stored()).toEqual(["https://racing.example/blog/team-offsite-recap"]);

    // Given the X lane's promise, the blog lane reads the post dates once that lane has finished.
    const after = await site("waiting.example");
    const xLane = new Promise<void>((resolve) =>
      setTimeout(async () => {
        await after.storeXPost();
        resolve();
      }, 150),
    );
    expect((await ingestBlog(after.ctx, null, 1, { xPostsReady: xLane })).count).toBe(1);
    expect(await after.stored()).toEqual(["https://waiting.example/blog/zeta-partnership-news"]);
  });

  it("stops waiting for a slow X lane at half the time left before the deadline", async () => {
    const slow = await site("slow.example");
    const logs: string[] = [];
    slow.ctx.log = (m) => logs.push(m);
    const started = Date.now();
    await ingestBlog(slow.ctx, null, 1, { deadline: Date.now() + 400, xPostsReady: new Promise(() => {}) });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(logs).toContainEqual(expect.stringMatching(/X lane is still running/));
  });
});

describe("stopping a knowledge-base refresh (R4-17)", () => {
  let db: DB;
  beforeAll(async () => {
    db = await openDb({ log: () => {} });
  });
  /** A site with a docs section of `n` pages, and its project. */
  async function docsSite(host: string, n: number): Promise<string> {
    const origin = `https://${host}`;
    const links = Array.from({ length: n }, (_, i) => `<a href="/docs/page-${i}">Page ${i}</a>`).join("");
    pages.set(`${origin}/`, {
      body: `<html><head><title>${host}</title></head><body><main><h1>${host}</h1><p>${"Home text. ".repeat(30)}</p>${links}</main></body></html>`,
    });
    const index = { body: `<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>${"Docs index. ".repeat(30)}</p>${links}</main></body></html>` };
    pages.set(`${origin}/docs`, index);
    pages.set(`${origin}/docs/`, index);
    for (let i = 0; i < n; i++)
      pages.set(`${origin}/docs/page-${i}`, {
        body: `<html><head><title>Page ${i}</title></head><body><main><h1>Page ${i}</h1><p>${`Docs page ${i} text. `.repeat(30)}</p>${links}</main></body></html>`,
      });
    const id = host.split(".")[0]!;
    await db.insert(schema.projects).values({ id, slug: id, name: id, websiteUrl: `${origin}/`, docsRoots: [{ url: `${origin}/docs/`, prefix: "/docs" }] });
    return id;
  }
  const project = async (id: string) => (await db.select().from(schema.projects).where(eq(schema.projects.id, id)))[0]!;

  it("rejects at once, and doesn't start, when the signal has already aborted", async () => {
    const id = await docsSite("early.example", 3);
    await expect(refreshKnowledgeBase(db, id, { signal: AbortSignal.abort("Cancelled") })).rejects.toThrow(KbRefreshAbortedError);
    expect(isKbRefreshing(id)).toBe(false);
    expect((await project(id)).kbStatus).toBe("empty");
  });

  it("stops between lane pages: the caller fails at once, nothing more is fetched or pruned", async () => {
    const id = await docsSite("heavy.example", 40);
    // A docs row from an earlier refresh: a completed docs run that didn't see it again would delete it.
    await db.insert(schema.sources).values({
      id: "old-docs",
      projectId: id,
      url: "https://heavy.example/docs/removed",
      kind: "docs",
      sourceClass: "official_docs",
      contentMd: "old",
      origin: "kb",
      meta: { section: "docs", lane: "docs", runId: "earlier" },
    });
    web.delayMs = 40;
    try {
      const ctrl = new AbortController();
      const refresh = refreshKnowledgeBase(db, id, { signal: ctrl.signal });
      refresh.catch(() => {});
      const docsServed = () => web.served.filter((u) => u.startsWith("https://heavy.example/docs/page-")).length;
      await vi.waitFor(() => expect(docsServed()).toBeGreaterThanOrEqual(3), { timeout: 20_000, interval: 20 });
      const stoppedAt = Date.now();
      ctrl.abort("Cancelled");
      await expect(refresh).rejects.toThrow(/Knowledge-base refresh stopped: Cancelled/);
      expect(Date.now() - stoppedAt).toBeLessThan(100);
      const servedAtStop = docsServed();
      // The refresh itself winds down quickly (every wait and fetch sees the signal), with no page fetched after.
      await vi.waitFor(() => expect(isKbRefreshing(id)).toBe(false), { timeout: 2000, interval: 10 });
      expect(docsServed()).toBe(servedAtStop);
      expect(servedAtStop).toBeLessThan(40);
      expect(await project(id)).toMatchObject({ kbStatus: "error", kbError: expect.stringMatching(/stopped: Cancelled/) });
      expect((await db.select().from(schema.sources).where(eq(schema.sources.id, "old-docs")))[0]).toBeDefined();
    } finally {
      web.delayMs = 0;
    }
  });

  it("keeps a shared refresh going while another caller still waits on it", async () => {
    const id = await docsSite("shared.example", 3);
    const ctrl = new AbortController();
    const first = refreshKnowledgeBase(db, id, { signal: ctrl.signal });
    const second = refreshKnowledgeBase(db, id);
    ctrl.abort("Cancelled");
    await expect(first).rejects.toThrow(KbRefreshAbortedError);
    // The caller without a signal gets the finished knowledge base.
    await expect(second).resolves.toMatchObject({ docs: expect.any(Number) });
    expect((await project(id)).kbStatus).toBe("ready");
  });
});
