/**
 * Project logos served from our own origin (SEC-17). Hotlinking them sent every visitor's IP and user agent to the
 * projects being scored. Each logo URL is fetched once through the SSRF-safe fetcher, checked to really be an
 * image, and cached in memory and on disk next to the database.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import type { DB } from "../db/index.ts";
import { schema } from "../db/index.ts";
import { env } from "../env.ts";
import { safeFetch } from "../lib/fetcher.ts";
import { LruCache } from "../lib/lru.ts";

export const MAX_LOGO_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
/** A failed fetch is retried after this long (kept in memory only). */
const NEGATIVE_TTL_MS = 60 * 60_000;

export interface Logo {
  contentType: string;
  body: Buffer;
  etag: string;
}

/**
 * The image type from the bytes themselves. The upstream Content-Type must also say image/*, but it isn't trusted
 * on its own: anything served from our origin has to really be one of these formats.
 */
export function sniffImage(buf: Buffer): string | null {
  const ascii = (a: number, b: number) => buf.subarray(a, b).toString("latin1");
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return "image/gif";
  if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 12 && ascii(4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(8, 12))) return "image/avif";
  if (buf.length >= 6 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0 && buf.readUInt16LE(4) > 0) return "image/x-icon";
  const head = buf.subarray(0, 4096).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

export class LogoRejectedError extends Error {}

const memory = new LruCache<Logo>({ maxSize: 16 * 1024 * 1024, maxEntries: 1000, sizeOf: (l) => l.body.byteLength });
const failures = new Map<string, number>();
const inflight = new Map<string, Promise<Logo | null>>();

const hashOf = (url: string) => createHash("sha256").update(url).digest("hex");

function cacheDir(): string | null {
  return env.dbPath === ":memory:" ? null : join(dirname(env.dbPath), "logo-cache");
}

function readDisk(key: string): Logo | null {
  const dir = cacheDir();
  if (!dir) return null;
  try {
    const meta = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8")) as { contentType: string };
    const body = readFileSync(join(dir, `${key}.img`));
    if (sniffImage(body) !== meta.contentType) return null;
    return { contentType: meta.contentType, body, etag: `"${key.slice(0, 32)}"` };
  } catch {
    return null;
  }
}

function writeDisk(key: string, logo: Logo, url: string) {
  const dir = cacheDir();
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    // Write then rename, so a crash never leaves a half-written image that later passes for a cached one.
    writeFileSync(join(dir, `${key}.img.tmp`), logo.body);
    renameSync(join(dir, `${key}.img.tmp`), join(dir, `${key}.img`));
    writeFileSync(join(dir, `${key}.json`), JSON.stringify({ contentType: logo.contentType, url, fetchedAt: new Date().toISOString() }));
  } catch (e) {
    console.warn(`[logos] could not cache ${new URL(url).host} on disk: ${(e as Error).message}`);
  }
}

/** Fetches and validates one logo. Throws LogoRejectedError for anything that isn't a small image. */
export async function fetchLogo(url: string): Promise<Logo> {
  const res = await safeFetch(url, {
    maxBytes: MAX_LOGO_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8" },
  });
  if (res.status !== 200) throw new LogoRejectedError(`HTTP ${res.status}`);
  const declared = res.contentType.split(";")[0]!.trim().toLowerCase();
  if (!declared.startsWith("image/")) throw new LogoRejectedError(`not an image (${declared || "no content type"})`);
  const contentType = sniffImage(res.body);
  if (!contentType) throw new LogoRejectedError(`unrecognized image data (declared ${declared})`);
  return { contentType, body: res.body, etag: `"${hashOf(url).slice(0, 32)}"` };
}

/** The cached logo for a URL, fetching it on first use. Null when it can't be fetched or isn't an image. */
export async function getLogo(url: string): Promise<Logo | null> {
  const key = hashOf(url);
  const hit = memory.get(key);
  if (hit) return hit;
  const failedAt = failures.get(key);
  if (failedAt && Date.now() - failedAt < NEGATIVE_TTL_MS) return null;
  const disk = readDisk(key);
  if (disk) {
    memory.set(key, disk);
    return disk;
  }
  let job = inflight.get(key);
  if (!job) {
    job = fetchLogo(url)
      .then((logo) => {
        memory.set(key, logo);
        failures.delete(key);
        writeDisk(key, logo, url);
        return logo;
      })
      .catch((e) => {
        if (failures.size > 5000) failures.clear();
        failures.set(key, Date.now());
        console.warn(`[logos] ${new URL(url).host}: ${(e as Error).message}`);
        return null;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return job;
}

/** Only URLs that are some project's logo are proxied, so the endpoint can't be used to fetch arbitrary URLs. */
export async function isProjectLogoUrl(db: DB, url: string): Promise<boolean> {
  return !!(await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.logoUrl, url)))[0];
}

export async function logoUrlForSlug(db: DB, slug: string): Promise<string | null> {
  return (await db.select({ logoUrl: schema.projects.logoUrl }).from(schema.projects).where(eq(schema.projects.slug, slug)))[0]?.logoUrl ?? null;
}

/** Test hook. */
export function clearLogoCache() {
  memory.clear();
  failures.clear();
}
