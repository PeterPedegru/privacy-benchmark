import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from "hono/cookie";
import ipaddr from "ipaddr.js";
import { env, isDeployed, isRealSecret, secureCookies } from "../env.ts";

const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
/** `__Host-` pins the cookie to this exact origin (Secure, Path=/, no Domain), so a sibling subdomain can't set it. */
export const SESSION_COOKIE = secureCookies ? "__Host-pb_session" : "pb_session";
/**
 * The web client reads this one from `document.cookie` and echoes it in `x-csrf-token`, so its name stays stable.
 * The custom header is what stops cross-site requests (they can't set it without a CORS preflight we never allow).
 */
export const CSRF_COOKIE = "pb_csrf";
export const MAX_PASSWORD_LENGTH = 256;
export const MIN_ADMIN_PASSWORD_LENGTH = 12;
export const MIN_SESSION_SECRET_LENGTH = 32;

const secret = env.sessionSecret || randomBytes(32).toString("hex");
/** The key signed cookies use (SESSION_SECRET, or a random per-boot key): the voter cookie signs with it too. */
export const cookieSecret = () => secret;
const salt = randomBytes(16);

function scryptAsync(password: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, (e, key) => (e ? reject(e) : resolve(key))));
}

// ---------- configuration checks ----------

export interface SecretProblem {
  name: "ADMIN_PASSWORD" | "SESSION_SECRET";
  problem: string;
}

/** Weak or placeholder admin credentials. An unset ADMIN_PASSWORD just locks the admin, so it isn't a problem here. */
export function secretProblems(): SecretProblem[] {
  const out: SecretProblem[] = [];
  const pw = env.adminPassword;
  if (pw && (pw.length < MIN_ADMIN_PASSWORD_LENGTH || !isRealSecret(pw)))
    out.push({ name: "ADMIN_PASSWORD", problem: `must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters and not a placeholder` });
  const s = env.sessionSecret;
  if (pw && !s) out.push({ name: "SESSION_SECRET", problem: "is not set, so sessions are signed with a random key and reset on every restart" });
  else if (s && (s.length < MIN_SESSION_SECRET_LENGTH || !isRealSecret(s)))
    out.push({ name: "SESSION_SECRET", problem: `must be at least ${MIN_SESSION_SECRET_LENGTH} random characters and not a placeholder` });
  return out;
}

/**
 * In production a weak admin password or session secret is a startup error: the login is reachable from the
 * internet, and a guessable SESSION_SECRET lets anyone forge a session. An unset SESSION_SECRET is only a warning
 * (a random per-boot key is safe, sessions just don't survive restarts). Returns false when the server must not start.
 */
export function checkSecretsAtBoot(log: (m: string) => void = console.error): boolean {
  const problems = secretProblems();
  for (const p of problems) log(`[security] ${p.name} ${p.problem}.`);
  // Keyed on being deployed (NODE_ENV, an https public URL or a Railway environment), not on NODE_ENV alone (R3-SEC-11).
  if (!isDeployed()) return true;
  const fatal = problems.filter((p) => !(p.name === "SESSION_SECRET" && !env.sessionSecret));
  if (fatal.length) {
    log(
      `[security] Refusing to start in production with weak credentials (${fatal.map((p) => p.name).join(", ")}). Set strong values in the service variables, e.g. \`openssl rand -base64 32\`.`,
    );
    return false;
  }
  return true;
}

// ---------- client identity and login throttling ----------

function parseIp(v: string | undefined | null): string | null {
  const s = v?.trim().replace(/^\[|\]$/g, "");
  if (!s || !ipaddr.isValid(s)) return null;
  const a = ipaddr.parse(s);
  return a.kind() === "ipv6" && (a as ipaddr.IPv6).isIPv4MappedAddress() ? (a as ipaddr.IPv6).toIPv4Address().toString() : a.toString();
}

/** Ranges a proxy hop inside the platform can have (Railway's internal proxies are in 100.64.0.0/10). */
const INTERNAL_RANGES = new Set(["private", "loopback", "carrierGradeNat", "linkLocal", "uniqueLocal", "unspecified"]);

function isInternal(ip: string): boolean {
  return INTERNAL_RANGES.has(ipaddr.parse(ip).range());
}

/**
 * The client's IP for rate limiting.
 *
 * Assumption (Railway, per its docs and staff answers as of 2026-09): requests reach the app only through Railway's
 * edge, which overwrites `X-Real-IP` with the connecting IP. Reports differ on whether the edge strips or appends a
 * client-sent `X-Forwarded-For`, so its leftmost entry is never trusted. Order: `X-Real-IP`, then the rightmost
 * XFF hop that isn't a platform-internal address, then the socket address. On Railway's CDN path X-Real-IP can be
 * a CDN edge address shared by many clients: limits get coarser, never spoofable, and the global login brake still
 * applies. Behind a different proxy, revisit this function.
 */
export function clientIp(c: Context): string {
  const real = parseIp(c.req.header("x-real-ip"));
  if (real) return real;
  const hops = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map(parseIp)
    .filter((x): x is string => !!x);
  const external = [...hops].reverse().find((ip) => !isInternal(ip));
  if (external) return external;
  if (hops.length) return hops[hops.length - 1]!;
  try {
    // Only present under @hono/node-server; app.request() in tests has no socket.
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
    return parseIp(incoming?.socket?.remoteAddress) ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** A fixed-window counter per key with bounded memory: expired keys are pruned, and it resets if it still overflows. */
export function windowLimiter(opts: { limit: number; windowMs: number; maxKeys?: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const maxKeys = opts.maxKeys ?? 10_000;
  return {
    /** Counts one hit; false when the key is over its limit for the current window. */
    hit(key: string, now = Date.now()): boolean {
      let h = hits.get(key);
      if (!h || h.resetAt <= now) {
        if (!h && hits.size >= maxKeys) {
          for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
          if (hits.size >= maxKeys) hits.clear();
        }
        h = { count: 0, resetAt: now + opts.windowMs };
        hits.set(key, h);
      }
      h.count++;
      return h.count <= opts.limit;
    },
    size: () => hits.size,
    reset: () => hits.clear(),
  };
}

const LOGIN_PER_IP = { limit: 5, windowMs: 60_000 };
const GLOBAL_FAILURES = { limit: 30, windowMs: 10 * 60_000 };
/** Under attack, one attempt from an unknown device every 10 s, across all clients. */
export const SLOWED_INTERVAL_MS = 10_000;
const loginAttempts = windowLimiter(LOGIN_PER_IP);
const failures = { count: 0, resetAt: 0, alerted: false, nextSlot: 0 };

export type LoginVerdict = { ok: true } | { ok: false; reason: "rate_limited" | "slowed"; retryAfterSeconds: number };

function rollWindow(now: number) {
  if (failures.resetAt <= now) Object.assign(failures, { count: 0, resetAt: now + GLOBAL_FAILURES.windowMs, alerted: false, nextSlot: 0 });
}

/**
 * Per-IP limit (5 attempts a minute) plus a global slow-down: after 30 failed logins in 10 minutes from anywhere,
 * clients without a known-device cookie share one attempt every 10 s until the window ends. Spoofed or rotating IPs
 * can't get around it, and unlike the hard lock it replaced (R3-SEC-7), an attacker can't lock the editor out:
 * a browser that has signed in before (`knownDevice`) skips the slow-down and keeps only its per-IP limit.
 */
export function loginAllowed(ip: string, now = Date.now(), opts: { knownDevice?: boolean } = {}): LoginVerdict {
  rollWindow(now);
  if (!loginAttempts.hit(ip, now)) return { ok: false, reason: "rate_limited", retryAfterSeconds: Math.ceil(LOGIN_PER_IP.windowMs / 1000) };
  if (failures.count >= GLOBAL_FAILURES.limit && !opts.knownDevice) {
    if (now < failures.nextSlot) return { ok: false, reason: "slowed", retryAfterSeconds: Math.max(1, Math.ceil((failures.nextSlot - now) / 1000)) };
    failures.nextSlot = now + SLOWED_INTERVAL_MS;
  }
  return { ok: true };
}

export function recordLoginFailure(ip: string, now = Date.now()) {
  rollWindow(now);
  failures.count++;
  if (failures.count >= GLOBAL_FAILURES.limit && !failures.alerted) {
    failures.alerted = true;
    console.error(
      `[security] ${failures.count} failed admin logins in ${GLOBAL_FAILURES.windowMs / 60_000} min (latest from ${ip}); new devices get one attempt every ${SLOWED_INTERVAL_MS / 1000} s until ${new Date(failures.resetAt).toISOString()}.`,
    );
  }
}

/** Test hook: clears the login counters. */
export function resetLoginLimits() {
  loginAttempts.reset();
  Object.assign(failures, { count: 0, resetAt: 0, alerted: false, nextSlot: 0 });
}

// ---------- password ----------

let expected: { password: string; hash: Promise<Buffer> } | null = null;

export function adminConfigured(): boolean {
  return !!env.adminPassword;
}

/** Async scrypt (off the main thread), constant-time compare, length-capped input. */
export async function checkPassword(password: unknown): Promise<boolean> {
  const pw = env.adminPassword;
  if (!pw || typeof password !== "string" || !password || password.length > MAX_PASSWORD_LENGTH) return false;
  if (expected?.password !== pw) expected = { password: pw, hash: scryptAsync(pw) };
  const [got, want] = await Promise.all([scryptAsync(password), expected.hash]);
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---------- sessions ----------

/** Keyed hash of the admin password: changing ADMIN_PASSWORD invalidates every existing session. */
function passwordFingerprint(): string {
  return createHmac("sha256", secret).update(`pwv:${env.adminPassword}`).digest("base64url").slice(0, 16);
}

/** Session ids logged out before expiry (in-memory; a restart forgets them, but they still expire within 12 h). */
const revoked = new Map<string, number>();

function revoke(sid: string, exp: number) {
  const now = Date.now();
  if (revoked.size > 10_000) for (const [k, e] of revoked) if (e <= now) revoked.delete(k);
  revoked.set(sid, exp);
}

const cookieBase = { sameSite: "Strict" as const, secure: secureCookies, path: "/" };

export async function startSession(c: Context) {
  const expires = Date.now() + SESSION_TTL_MS;
  const sid = randomBytes(12).toString("base64url");
  await setSignedCookie(c, SESSION_COOKIE, `admin.${expires}.${sid}.${passwordFingerprint()}`, secret, {
    ...cookieBase,
    httpOnly: true,
    maxAge: SESSION_TTL_MS / 1000,
  });
  setCookie(c, CSRF_COOKIE, randomBytes(24).toString("hex"), { ...cookieBase, httpOnly: false, maxAge: SESSION_TTL_MS / 1000 });
}

/**
 * A browser that has signed in before carries this signed, long-lived marker and skips the global login slow-down
 * (R3-SEC-7). It grants nothing else: the password is still required, and the per-IP limit still applies. Bound to
 * the password fingerprint, so changing ADMIN_PASSWORD forgets every device.
 */
export const DEVICE_COOKIE = secureCookies ? "__Host-pb_device" : "pb_device";
const DEVICE_TTL_MS = 1000 * 60 * 60 * 24 * 180;

export async function rememberDevice(c: Context) {
  const exp = Date.now() + DEVICE_TTL_MS;
  await setSignedCookie(c, DEVICE_COOKIE, `device.${exp}.${randomBytes(9).toString("base64url")}.${passwordFingerprint()}`, secret, {
    ...cookieBase,
    httpOnly: true,
    maxAge: DEVICE_TTL_MS / 1000,
  });
}

export async function isKnownDevice(c: Context): Promise<boolean> {
  if (!adminConfigured()) return false;
  const v = await getSignedCookie(c, secret, DEVICE_COOKIE);
  if (!v) return false;
  const [kind, exp, , pwv] = v.split(".");
  if (kind !== "device" || !(Number(exp) > Date.now()) || !pwv) return false;
  const want = Buffer.from(passwordFingerprint());
  const got = Buffer.from(pwv);
  return got.length === want.length && timingSafeEqual(got, want);
}

interface Session {
  sid: string;
  exp: number;
}

async function readSession(c: Context): Promise<Session | null> {
  if (!adminConfigured()) return null;
  const v = await getSignedCookie(c, secret, SESSION_COOKIE);
  if (!v) return null;
  const [role, exp, sid, pwv] = v.split(".");
  if (role !== "admin" || !sid || !pwv || !(Number(exp) > Date.now()) || revoked.has(sid)) return null;
  const want = Buffer.from(passwordFingerprint());
  const got = Buffer.from(pwv);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return { sid, exp: Number(exp) };
}

export async function endSession(c: Context) {
  const s = await readSession(c);
  if (s) revoke(s.sid, s.exp);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secureCookies });
  deleteCookie(c, CSRF_COOKIE, { path: "/", secure: secureCookies });
  // Sessions from before the cookie rename.
  if (SESSION_COOKIE !== "pb_session" && getCookie(c, "pb_session")) deleteCookie(c, "pb_session", { path: "/" });
}

export async function isAdmin(c: Context): Promise<boolean> {
  return (await readSession(c)) !== null;
}

export function csrfOk(c: Context): boolean {
  const cookie = getCookie(c, CSRF_COOKIE);
  const header = c.req.header("x-csrf-token");
  if (!cookie || !header || cookie.length !== header.length) return false;
  return timingSafeEqual(Buffer.from(cookie), Buffer.from(header));
}

/** Requires an admin session; mutating requests must also echo the CSRF cookie in `x-csrf-token`. */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  if (!(await isAdmin(c))) return c.json({ error: "unauthorized" }, 401);
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !csrfOk(c)) return c.json({ error: "csrf" }, 403);
  await next();
};
