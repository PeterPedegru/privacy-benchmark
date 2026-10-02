import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The real fetcher refuses loopback addresses (that's the point of it), so upstream responses are stubbed here.
const upstream = new Map<string, { status?: number; contentType: string; body: Buffer }>();
const fetched: string[] = [];
vi.mock("../src/lib/fetcher.ts", () => ({
  safeFetch: vi.fn(async (url: string, opts: { maxBytes?: number }) => {
    fetched.push(url);
    const r = upstream.get(url);
    if (!r) throw new Error("connection refused");
    if (opts.maxBytes && r.body.byteLength > opts.maxBytes) throw new Error("too large");
    return { url, status: r.status ?? 200, contentType: r.contentType, body: r.body };
  }),
}));

const { createApp } = await import("../src/app.ts");
const { openDb, schema, setDb } = await import("../src/db/index.ts");
const { clearLogoCache, sniffImage } = await import("../src/services/logos.ts");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>');
const HTML = Buffer.from("<!doctype html><html><body><script>alert(document.cookie)</script></body></html>");

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const db = await openDb({ log: () => {} });
  setDb(db);
  const add = async (slug: string, logoUrl: string) =>
    await db.insert(schema.projects).values({ id: slug, slug, name: slug, websiteUrl: `https://${slug}.example.org`, logoUrl });
  await add("png", "https://png.example.org/logo.png");
  await add("svg", "https://svg.example.org/logo.svg");
  await add("html", "https://html.example.org/logo.png");
  await add("lying", "https://lying.example.org/logo.png");
  await add("big", "https://big.example.org/logo.png");
  await add("down", "https://down.example.org/logo.png");
  upstream.set("https://png.example.org/logo.png", { contentType: "image/png", body: PNG });
  upstream.set("https://svg.example.org/logo.svg", { contentType: "image/svg+xml; charset=utf-8", body: SVG });
  upstream.set("https://html.example.org/logo.png", { contentType: "text/html", body: HTML });
  // Claims to be a PNG but is HTML: never served from our origin.
  upstream.set("https://lying.example.org/logo.png", { contentType: "image/png", body: HTML });
  upstream.set("https://big.example.org/logo.png", { contentType: "image/png", body: Buffer.concat([PNG, Buffer.alloc(600 * 1024)]) });
  app = createApp();
});

beforeEach(() => {
  clearLogoCache();
  fetched.length = 0;
});

const logo = (u: string) => app.request(`/api/public/logo?u=${encodeURIComponent(u)}`);

describe("logo proxy", () => {
  it("serves a project's logo from our origin, fetched once", async () => {
    const res = await logo("https://png.example.org/logo.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("max-age=2592000");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    // The by-slug route serves published projects only, so unpublished slugs can't be probed.
    expect((await app.request("/api/public/logo/png")).status).toBe(404);
    expect((await logo("https://png.example.org/logo.png")).status).toBe(200);
    expect(fetched).toEqual(["https://png.example.org/logo.png"]);
  });

  it("rejects non-images, mislabeled HTML, oversized files and failed fetches", async () => {
    for (const u of [
      "https://html.example.org/logo.png",
      "https://lying.example.org/logo.png",
      "https://big.example.org/logo.png",
      "https://down.example.org/logo.png",
    ]) {
      const res = await logo(u);
      expect(res.status, u).toBe(404);
      expect(res.headers.get("content-type"), u).not.toContain("html");
    }
    // Failures are remembered for a while instead of refetched on every page view.
    await logo("https://html.example.org/logo.png");
    expect(fetched.filter((u) => u.startsWith("https://html.")).length).toBe(1);
  });

  it("is not an open proxy: only URLs that are some project's logo are fetched", async () => {
    expect((await logo("https://attacker.example/x.png")).status).toBe(404);
    expect((await app.request("/api/public/logo/no-such-project")).status).toBe(404);
    expect(fetched).toEqual([]);
  });

  it("sandboxes SVG logos so they can't run script if opened directly", async () => {
    const res = await logo("https://svg.example.org/logo.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("identifies image formats by their bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a......"))).toBe("image/gif");
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))).toBe("image/webp");
    expect(sniffImage(Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]))).toBe("image/x-icon");
    expect(sniffImage(SVG)).toBe("image/svg+xml");
    expect(sniffImage(HTML)).toBeNull();
    expect(sniffImage(Buffer.from('{"not":"an image"}'))).toBeNull();
  });
});
