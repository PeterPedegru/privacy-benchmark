/**
 * Public community-weighting routes (plans/11): weighting versions, the open poll, ballots, and Sign in with X.
 *
 * Basic protection against repeat and automated voting: one ballot per X account (or per browser, in a
 * browser-mode poll) per poll, accounts older than X_MIN_ACCOUNT_DAYS, a bounded number of voters per network,
 * a bounded number of changes per ballot, rate limits per IP and overall, same-origin JSON writes only, and a
 * median result that a minority of ballots can't move.
 */
import { type BallotInput, ballotSchema, type PollResponse } from "@pb/core";
import { desc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { getDb, schema } from "../db/index.ts";
import { env } from "../env.ts";
import { clientIp, windowLimiter } from "../lib/auth.ts";
import { clearVoter, finishXSignIn, newBrowserVoter, readVoter, safeNext, setVoter, startXSignIn, xAuthEnabled } from "../lib/voter.ts";
import {
  castBallot,
  finalizeDuePolls,
  findWeighting,
  listWeightings,
  openPollRow,
  POLL_LIMITS,
  PollError,
  pollById,
  pollInfo,
  pollStateVersion,
  rateKey,
  voterBallot,
  weightingDetail,
  weightingFor,
  withdrawBallot,
} from "../services/weighting.ts";

export const weightingRoutes = new Hono();

/** Weighting versions change only when a poll closes or an editor retires one: revalidated, never stale for long. */
const WEIGHTING_CACHE = "public, max-age=60";

weightingRoutes.get("/weightings", async (c) => {
  c.header("cache-control", WEIGHTING_CACHE);
  return c.json(await listWeightings(getDb()));
});

weightingRoutes.get("/weightings/:ref", async (c) => {
  const db = getDb();
  const row = await findWeighting(db, c.req.param("ref"));
  if (!row) return c.json({ error: "not_found" }, 404);
  c.header("cache-control", WEIGHTING_CACHE);
  return c.json(await weightingDetail(db, row));
});

/** A poll whose five days are up closes on the next read, even between scheduler ticks; a failure there is the scheduler's to retry. */
async function closeDue(db: ReturnType<typeof getDb>) {
  await finalizeDuePolls(db).catch((e) => console.error(`[weighting] closing a due poll failed: ${(e as Error).message}`));
}

/**
 * The open poll in brief, the same for everyone: what the banner on every public page needs. Cached here and by
 * browsers for 15 s, so the busiest moment (a poll's announcement) costs a query every 15 s, not one per page view.
 */
const SUMMARY_TTL_MS = 15_000;
let summary: { at: number; state: number; body: unknown } | null = null;
weightingRoutes.get("/poll/summary", async (c) => {
  if (!summary || Date.now() - summary.at > SUMMARY_TTL_MS || summary.state !== pollStateVersion()) {
    const db = getDb();
    await closeDue(db);
    const open = await openPollRow(db);
    summary = { at: Date.now(), state: pollStateVersion(), body: { poll: open ? { id: open.id, title: open.title, closesAt: open.closesAt } : null } };
  }
  c.header("cache-control", "public, max-age=15");
  return c.json(summary.body);
});

/** The open poll (or none), the last one that closed, and this visitor's ballot. Per visitor, so never cached. */
weightingRoutes.get("/poll", async (c) => {
  const db = getDb();
  await closeDue(db);
  const open = await openPollRow(db);
  const voter = await readVoter(c);
  const row = open && voter ? await voterBallot(db, open, voter) : null;
  // A withdrawn ballot doesn't count, but its revisions do.
  const mine = row && !row.withdrawnAt ? row : null;
  const closedRows = await db
    .select()
    .from(schema.weightingPolls)
    .where(eq(schema.weightingPolls.status, "closed"))
    .orderBy(desc(schema.weightingPolls.closedAt))
    .limit(1);
  const body: PollResponse = {
    poll: open ? { ...(await pollInfo(db, open)), baseConfig: (await weightingFor(db, open.baseId)).weighting } : null,
    lastClosed: closedRows[0] ? await pollInfo(db, closedRows[0]) : null,
    voter: {
      signedIn: !!voter && (!open?.requireX || voter.kind === "x"),
      kind: voter?.kind ?? null,
      ballot: (mine?.ballot as BallotInput | undefined) ?? null,
      votedAt: mine?.updatedAt ?? null,
      revisionsLeft: row ? Math.max(0, POLL_LIMITS.revisions - row.revisions) : POLL_LIMITS.revisions,
    },
    xEnabled: xAuthEnabled(),
  };
  c.header("cache-control", "no-store");
  return c.json(body);
});

// ---------- ballots ----------

/** Ballot writes per IP per hour, and across everyone per minute (a brake on a flood, not a quota). */
const ballotWrites = windowLimiter({ limit: 30, windowMs: 3600_000 });
const allBallotWrites = windowLimiter({ limit: 600, windowMs: 60_000, maxKeys: 1 });

/**
 * Writes come from this site's own pages only: a JSON body (a cross-site form can't send one without a CORS
 * preflight, which is never answered) and, when the browser says where it came from, this origin.
 */
function sameOriginJson(c: Context): Response | null {
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) return c.json({ error: "unsupported_media_type" }, 415);
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(env.publicUrl).origin && origin !== new URL(c.req.url).origin) return c.json({ error: "forbidden_origin" }, 403);
  return null;
}

const POLL_ERROR_STATUS: Record<PollError["code"], 400 | 401 | 404 | 409 | 422 | 429> = {
  poll_open: 409,
  not_found: 404,
  closed: 409,
  sign_in_required: 401,
  invalid: 422,
  network_limit: 429,
  revision_limit: 429,
  busy: 409,
  retired: 409,
  x_unavailable: 422,
};

function pollError(c: Context, e: unknown) {
  if (!(e instanceof PollError)) throw e;
  return c.json({ error: e.code, message: e.message, details: e.details }, POLL_ERROR_STATUS[e.code]);
}

const rateLimited = (c: Context) => c.json({ error: "rate_limited", message: "Too many ballots from here. Try again later." }, 429, { "retry-after": "60" });

weightingRoutes.post("/polls/:id/ballot", async (c) => {
  const blocked = sameOriginJson(c);
  if (blocked) return blocked;
  // Per address first: one client's flood is turned away here and never reaches the shared limit below.
  if (!ballotWrites.hit(rateKey(clientIp(c)))) return rateLimited(c);
  const db = getDb();
  const poll = await pollById(db, c.req.param("id"));
  if (!poll) return c.json({ error: "not_found" }, 404);
  if (!allBallotWrites.hit("all")) return rateLimited(c);
  const parsed = ballotSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "Invalid ballot" }, 400);
  let voter = await readVoter(c);
  if (poll.requireX && voter?.kind !== "x")
    return c.json({ error: "sign_in_required", message: "Sign in with X to vote in this poll.", signIn: xAuthEnabled() }, 401);
  const minted = !voter;
  voter ??= newBrowserVoter();
  try {
    const r = await castBallot(db, poll, voter, clientIp(c), parsed.data);
    if (minted) await setVoter(c, voter);
    return c.json({ ok: true, ...r });
  } catch (e) {
    return pollError(c, e);
  }
});

weightingRoutes.delete("/polls/:id/ballot", async (c) => {
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(env.publicUrl).origin && origin !== new URL(c.req.url).origin) return c.json({ error: "forbidden_origin" }, 403);
  if (!ballotWrites.hit(rateKey(clientIp(c)))) return rateLimited(c);
  const db = getDb();
  const poll = await pollById(db, c.req.param("id"));
  const voter = await readVoter(c);
  if (!poll) return c.json({ error: "not_found" }, 404);
  if (!voter) return c.json({ ok: true, removed: false });
  try {
    return c.json({ ok: true, removed: await withdrawBallot(db, poll, voter) });
  } catch (e) {
    return pollError(c, e);
  }
});

// ---------- Sign in with X ----------

const signInStarts = windowLimiter({ limit: 20, windowMs: 3600_000 });

weightingRoutes.get("/auth/x/start", async (c) => {
  const next = safeNext(c.req.query("next"));
  if (!xAuthEnabled()) return c.redirect(`${next}?x=unavailable`, 302);
  if (!signInStarts.hit(rateKey(clientIp(c)))) return c.redirect(`${next}?x=limited`, 302);
  c.header("cache-control", "no-store");
  return c.redirect(await startXSignIn(c, next), 302);
});

weightingRoutes.get("/auth/x/callback", async (c) => {
  c.header("cache-control", "no-store");
  const r = await finishXSignIn(c);
  if (!r.ok) return c.redirect(`${r.next}?x=${r.reason}`, 302);
  await setVoter(c, r.voter);
  return c.redirect(`${r.next}?x=ok`, 302);
});

weightingRoutes.post("/auth/x/logout", async (c) => {
  const blocked = sameOriginJson(c);
  if (blocked) return blocked;
  clearVoter(c);
  return c.json({ ok: true });
});
