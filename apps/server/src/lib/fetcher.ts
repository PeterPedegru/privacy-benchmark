import { AsyncLocalStorage } from "node:async_hooks";
import { lookup as dnsLookup } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";

// ---------- cancellation (R4-17) ----------

/** A fetch, or a wait between fetches, stopped because its signal aborted (an evaluation was cancelled). */
export class FetchAbortedError extends Error {
  override name = "AbortError";
}

/**
 * The abort signal of the work this fetch belongs to, carried through async calls so every fetch a knowledge-base
 * refresh makes (lanes, the crawler, GitHub, PDFs) sees it without each function passing it on (R4-17).
 */
const fetchScope = new AsyncLocalStorage<AbortSignal>();

/** Runs `fn` with `signal` as the abort signal of every safeFetch and abortable wait inside it. */
export function withFetchSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  return signal ? fetchScope.run(signal, fn) : fn();
}

/** The current fetch scope's signal, if any. */
export function fetchSignal(): AbortSignal | undefined {
  return fetchScope.getStore();
}

export function fetchAbortedError(signal: AbortSignal): FetchAbortedError {
  const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "aborted");
  return new FetchAbortedError(`Stopped: ${reason}`, { cause: signal.reason });
}

/** Throws FetchAbortedError when `signal` (by default the fetch scope's) has aborted: checked between pages. */
export function throwIfFetchAborted(signal: AbortSignal | undefined = fetchSignal()): void {
  if (signal?.aborted) throw fetchAbortedError(signal);
}

/** Waits `ms`, or rejects with FetchAbortedError as soon as the fetch scope's signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal | undefined = fetchSignal()): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(fetchAbortedError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(fetchAbortedError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const UA = "PrivacyBenchmarkBot/1.0 (+evaluation research; respects robots)";
const ALLOWED_PORTS = new Set(["", "80", "443"]);
/** Headers that must never follow a redirect to another origin. */
const CREDENTIAL_HEADERS = /^(authorization|cookie|proxy-authorization|x-api-key|x-goog-api-key|api-key)$/i;

export class FetchBlockedError extends Error {}
/** The response was larger than the caller allowed. Thrown (not truncated) so a partial body is never parsed as whole. */
export class FetchTooLargeError extends Error {
  constructor(
    public url: string,
    public maxBytes: number,
  ) {
    super(`Response from ${new URL(url).host} exceeded ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
}

/**
 * True for anything that isn't a plain public unicast address: loopback, private, link-local, CGNAT, multicast,
 * reserved, benchmarking, and IPv6 forms that embed IPv4 (mapped, NAT64, 6to4, Teredo).
 */
export function isBlockedIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true;
  }
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address();
    // IPv4-compatible addresses (::/96, e.g. [::7f00:1] from "[::127.0.0.1]") and the unspecified address: never
    // a public unicast destination (R3-SEC-12).
    else if (v6.parts.slice(0, 6).every((p) => p === 0)) return true;
  }
  if (addr.kind() === "ipv4") {
    const [a = 0, b = 0] = (addr as ipaddr.IPv4).octets;
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  }
  return addr.range() !== "unicast";
}

/** Connection-time DNS check, so a hostname can't pass validation and then rebind to a private IP. */
const guardedAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
        if (err) return callback(err, "", 0);
        const list = (Array.isArray(addresses) ? addresses : [{ address: String(addresses), family: 4 }]) as { address: string; family: number }[];
        const bad = list.find((a) => isBlockedIp(a.address));
        if (bad) return callback(new FetchBlockedError(`Refusing to connect to non-public address ${bad.address}`), "", 0);
        const first = list[0];
        if (!first) return callback(new Error(`No address for ${hostname}`), "", 0);
        if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
        callback(null, first.address, first.family);
      });
    },
  },
});

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlockedError(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchBlockedError("Only http(s) URLs are allowed");
  if (url.username || url.password) throw new FetchBlockedError("Credentials in URLs are not allowed");
  if (!ALLOWED_PORTS.has(url.port)) throw new FetchBlockedError("Only the default http(s) ports are allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new FetchBlockedError("Local hostnames are not allowed");
  }
  // IP literals never reach the connect-time lookup, so this is their only check.
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  for (const a of addrs) if (isBlockedIp(a.address)) throw new FetchBlockedError(`Refusing to fetch non-public address ${a.address}`);
  return url;
}

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  /** How long the server asked us to wait (Retry-After on 429 and 503), in milliseconds. */
  retryAfterMs?: number | null;
}

/** Retry-After as delay-seconds or an HTTP date, in milliseconds; null when absent or unparseable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d{1,7}$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Default 5 MB. Larger responses throw FetchTooLargeError. */
  maxBytes?: number;
  timeoutMs?: number;
  /** Stops the fetch (FetchAbortedError). Defaults to the fetch scope's signal (withFetchSignal), R4-17. */
  signal?: AbortSignal;
}

/** SSRF-safe GET: public addresses and default ports only, size/time capped, redirects re-checked per hop. */
export async function safeFetch(raw: string, init: FetchOptions = {}): Promise<FetchResult> {
  const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES;
  const outer = init.signal ?? fetchSignal();
  let current = raw;
  let headers = { ...init.headers };
  let origin: string | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    throwIfFetchAborted(outer);
    const url = await assertPublicUrl(current);
    if (origin && url.origin !== origin) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.test(k)));
    origin = url.origin;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    outer?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await undiciFetch(url, {
        dispatcher: guardedAgent,
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/json,text/plain,application/pdf;q=0.9,*/*;q=0.5", ...headers },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => {});
        current = new URL(res.headers.get("location")!, url).toString();
        continue;
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new FetchTooLargeError(url.toString(), maxBytes);
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            ctrl.abort();
            throw new FetchTooLargeError(url.toString(), maxBytes);
          }
          chunks.push(value);
        }
      }
      return {
        url: url.toString(),
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
        body: Buffer.concat(chunks),
        ...(res.status === 429 || res.status === 503 ? { retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) } : {}),
      };
    } catch (e) {
      // Cancelled mid-request: say so, rather than as a network failure the caller might retry.
      if (outer?.aborted) throw fetchAbortedError(outer);
      throw e;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }
  throw new FetchBlockedError("Too many redirects");
}
