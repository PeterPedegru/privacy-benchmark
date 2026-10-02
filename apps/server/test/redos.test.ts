/**
 * R3-SEC-2 / R3-SEC-3 regression: the payloads from the round-3 security review, which used to block the event loop
 * for seconds to hours, must each finish (and so block the loop) in under 200 ms.
 */
import { afterAll, describe, expect, it } from "vitest";
import { isNavigationOnly, markdownTitle, stripDataUris, stripHiddenMarkdown, stripTags } from "../src/lib/extract-core.ts";
import { closeExtractPool } from "../src/lib/extract-pool.ts";
import { extractAddresses } from "../src/services/lanes/addresses.ts";
import { parseFeed, parseLlmsTxt, parseRobots, parseSitemap, robotsAllows } from "../src/services/lanes/crawl.ts";

afterAll(() => closeExtractPool());

const LIMIT_MS = 200;

/** Runs `fn` while a 5 ms heartbeat measures the longest gap; returns that lag and the call's own duration. */
async function lag(fn: () => unknown): Promise<{ lag: number; ms: number }> {
  let last = performance.now();
  let worst = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 5);
  await new Promise((r) => setTimeout(r, 15));
  const t = performance.now();
  fn();
  const ms = performance.now() - t;
  await new Promise((r) => setTimeout(r, 15));
  clearInterval(beat);
  return { lag: Math.max(worst, ms), ms };
}

const payloads: [string, () => unknown][] = [
  ["robots: 8 wildcards against 60 a's", () => robotsAllows(parseRobots(`User-agent: *\nDisallow: /${"*a".repeat(8)}*b\n`), `/${"a".repeat(60)}`)],
  ["robots: 16 wildcards against 2,048 a's", () => robotsAllows(parseRobots(`User-agent: *\nDisallow: /${"*a".repeat(16)}*b$\n`), `/${"a".repeat(5000)}`)],
  ["markdownTitle: '# a' + 8,000 spaces", () => markdownTitle(`# a${" ".repeat(8000)}x\nfoo`)],
  ["markdownTitle: 100,000 front-matter fences", () => markdownTitle("---\n".repeat(100_000))],
  ["stripHiddenMarkdown: '<a' + ' hidden' x 150,000 (1 MB)", () => stripHiddenMarkdown(`<a${" hidden".repeat(150_000)}`)],
  ["stripHiddenMarkdown: '<a hidden>' x 100,000, never closed", () => stripHiddenMarkdown("<a hidden>".repeat(100_000))],
  ["parseSitemap: '<url>' x 200,000 unclosed (1 MB)", () => parseSitemap(`<urlset>${"<url>".repeat(200_000)}`)],
  ["parseSitemap: '<url><loc>' x 100,000 unclosed", () => parseSitemap(`<urlset>${"<url><loc>".repeat(100_000)}`)],
  ["parseFeed: '<item>' x 200,000 unclosed", () => parseFeed(`<rss>${"<item>".repeat(200_000)}`)],
  ["parseLlmsTxt: '](a' x 300,000 (900 KB)", () => parseLlmsTxt("](a".repeat(300_000), "https://x.org/")],
  ["parseLlmsTxt: 'http' x 250,000", () => parseLlmsTxt("http".repeat(250_000), "https://x.org/")],
  ["parseLlmsTxt: URLs ending in 2,000 dots", () => parseLlmsTxt(` https://x.org/${".".repeat(2000)}`.repeat(1500), "https://x.org/")],
  ["stripTags: '<svg>' x 199,000 (1 MB)", () => stripTags(`<html><body>${"<svg>".repeat(199_000)}`)],
  ["stripTags: '<' x 1,000,000", () => stripTags("<".repeat(1_000_000))],
  ["stripTags: '<title' x 150,000", () => stripTags("<title".repeat(150_000))],
  ["isNavigationOnly: '[' x 300,000 and '](' x 200,000", () => isNavigationOnly(`${"[".repeat(300_000)}${"](".repeat(200_000)}`)],
  ["stripDataUris: 'data:' x 200,000", () => stripDataUris(`![x](${"data:".repeat(200_000)}`)],
  [
    "extractAddresses: a 1 MB line of '[' with addresses",
    () => extractAddresses(`- ${"[".repeat(1_000_000)} 0x6818809EefCe719E480a7526D76bD3e561526b46 ${"[".repeat(1000)}`, "https://x.org/"),
  ],
  [
    "extractAddresses: 10,000 distinct addresses with links on one table row",
    () =>
      extractAddresses(
        `| ${Array.from({ length: 10_000 }, (_, i) => {
          const a = `0x${i.toString(16).padStart(40, "a")}`;
          return `[${a}](https://etherscan.io/address/${a})`;
        }).join(" | ")} |`,
        "https://x.org/",
      ),
  ],
];

describe("untrusted text never blocks the event loop (R3-SEC-2, R3-SEC-3)", () => {
  for (const [name, fn] of payloads) {
    it(name, async () => {
      const r = await lag(fn);
      expect(r.lag, `${name}: ${r.ms.toFixed(1)} ms`).toBeLessThan(LIMIT_MS);
    });
  }
});
