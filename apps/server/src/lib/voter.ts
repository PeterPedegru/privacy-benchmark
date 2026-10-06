/**
 * Who is voting in a community weighting poll: an X account (Sign in with X, OAuth 2.0 with PKCE) or, in a
 * browser-mode poll, a browser. Either way the identity lives in one signed, HttpOnly cookie on the voter's side;
 * the server stores only an HMAC of it under each poll's own salt (services/weighting.ts).
 *
 * The X access token is used once, to read the account's id and creation date, then revoked and dropped. The handle
 * is never read or stored.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { env, isRealSecret, secureCookies } from "../env.ts";
import type { Voter } from "../services/weighting.ts";
import { cookieSecret } from "./auth.ts";

export const VOTER_COOKIE = secureCookies ? "__Host-pb_voter" : "pb_voter";
/** The OAuth round trip's state and PKCE verifier, for ten minutes, sent only to the callback. */
export const X_STATE_COOKIE = "pb_xauth";
const X_STATE_PATH = "/api/public/auth/x";

const X_VOTER_TTL_S = 7 * 24 * 3600;
const BROWSER_VOTER_TTL_S = 30 * 24 * 3600;

const voterCookieOpts = (maxAge: number) => ({ httpOnly: true, secure: secureCookies, sameSite: "Lax" as const, path: "/", maxAge });

export async function readVoter(c: Context): Promise<Voter | null> {
  const v = await getSignedCookie(c, cookieSecret(), VOTER_COOKIE);
  if (!v) return null;
  const [kind, id, exp] = v.split(".");
  if ((kind !== "x" && kind !== "browser") || !id || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !(Number(exp) > Date.now())) return null;
  return { kind, id };
}

export async function setVoter(c: Context, voter: Voter) {
  const ttl = voter.kind === "x" ? X_VOTER_TTL_S : BROWSER_VOTER_TTL_S;
  await setSignedCookie(c, VOTER_COOKIE, `${voter.kind}.${voter.id}.${Date.now() + ttl * 1000}`, cookieSecret(), voterCookieOpts(ttl));
}

/** A new browser voter (browser-mode polls only). */
export function newBrowserVoter(): Voter {
  return { kind: "browser", id: randomBytes(16).toString("base64url") };
}

export function clearVoter(c: Context) {
  deleteCookie(c, VOTER_COOKIE, { path: "/", secure: secureCookies });
}

// ---------- Sign in with X ----------

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
export const X_REVOKE_URL = "https://api.x.com/2/oauth2/revoke";
export const X_ME_URL = "https://api.x.com/2/users/me?user.fields=created_at";

export const xAuthEnabled = () => isRealSecret(env.xOAuthClientId);
export const xRedirectUri = () => `${env.publicUrl}/api/public/auth/x/callback`;

/** Where to send the voter back to: a path on this site only. */
export function safeNext(next: string | undefined | null): string {
  return next && /^\/(?!\/)[A-Za-z0-9/_-]{0,120}$/.test(next) ? next : "/weighting";
}

const b64url = (b: Buffer) => b.toString("base64url");

/** Starts the round trip: remembers state and the PKCE verifier, and returns the authorize URL. */
export async function startXSignIn(c: Context, next: string): Promise<string> {
  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  await setSignedCookie(c, X_STATE_COOKIE, `${state}.${verifier}.${next}`, cookieSecret(), {
    httpOnly: true,
    secure: secureCookies,
    // Lax: the callback is a top-level navigation back from x.com.
    sameSite: "Lax",
    path: X_STATE_PATH,
    maxAge: 600,
  });
  const u = new URL(X_AUTHORIZE_URL);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: env.xOAuthClientId,
    redirect_uri: xRedirectUri(),
    // users.read needs tweet.read; nothing is read but the account's id and creation date.
    scope: "users.read tweet.read",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

export type XSignInResult = { ok: true; voter: Voter; next: string } | { ok: false; reason: "denied" | "expired" | "young" | "error"; next: string };

type Fetch = typeof fetch;

function clientAuth(): { headers: Record<string, string>; body: Record<string, string> } {
  if (env.xOAuthClientSecret)
    return { headers: { authorization: `Basic ${Buffer.from(`${env.xOAuthClientId}:${env.xOAuthClientSecret}`).toString("base64")}` }, body: {} };
  return { headers: {}, body: { client_id: env.xOAuthClientId } };
}

/** Finishes the round trip: checks state, exchanges the code, reads the account, revokes the token. */
export async function finishXSignIn(c: Context, fetchImpl: Fetch = fetch, now = Date.now()): Promise<XSignInResult> {
  const saved = await getSignedCookie(c, cookieSecret(), X_STATE_COOKIE);
  deleteCookie(c, X_STATE_COOKIE, { path: X_STATE_PATH, secure: secureCookies });
  const [state, verifier, rawNext] = (saved || "").split(".");
  const next = safeNext(rawNext);
  if (!saved || !state || !verifier) return { ok: false, reason: "expired", next };
  if (c.req.query("error") || !c.req.query("code")) return { ok: false, reason: "denied", next };
  if (c.req.query("state") !== state) return { ok: false, reason: "expired", next };
  const auth = clientAuth();
  try {
    const tokenRes = await fetchImpl(X_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...auth.headers },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: c.req.query("code")!,
        redirect_uri: xRedirectUri(),
        code_verifier: verifier,
        ...auth.body,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) return { ok: false, reason: "error", next };
    const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
    if (!token) return { ok: false, reason: "error", next };
    let me: { id?: string; created_at?: string } | undefined;
    try {
      const meRes = await fetchImpl(X_ME_URL, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      me = meRes.ok ? ((await meRes.json()) as { data?: { id?: string; created_at?: string } }).data : undefined;
    } finally {
      // Nothing else is ever done with the token.
      void fetchImpl(X_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...auth.headers },
        body: new URLSearchParams({ token, token_type_hint: "access_token", ...auth.body }).toString(),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
    if (!me?.id || !/^\d{1,30}$/.test(me.id)) return { ok: false, reason: "error", next };
    const created = Date.parse(me.created_at ?? "");
    if (!Number.isFinite(created) || now - created < env.xMinAccountDays * 86_400_000) return { ok: false, reason: "young", next };
    return { ok: true, voter: { kind: "x", id: me.id }, next };
  } catch {
    return { ok: false, reason: "error", next };
  }
}
