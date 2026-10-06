/**
 * Community weighting (plans/11): weighting versions, five-day public polls on them, ballots and the close.
 *
 * A weighting is the rubric's suite and benchmark weights and every answer's points, frozen and hashed. The rubric's
 * own is created at boot (`rubric-<version>`, W1 on a fresh database); every poll that closes with a quorum adds the
 * next one, which new runs then use by default. Runs, releases and published results link to the weighting they were
 * scored with, so a published score can always be traced to the exact numbers behind it.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { PollInfo, PollStats, WeightingChange, WeightingDetail, WeightingRef, WeightingSummary } from "@pb/core";
import {
  aggregateBallots,
  type Ballot,
  ballotChanges,
  DEFAULT_WEIGHTING,
  diffWeightings,
  resolveWeighting,
  rubric,
  validateBallot,
  type Weighting,
} from "@pb/rubric";
import { and, desc, eq, isNull, lt, lte, sql } from "drizzle-orm";
import ipaddr from "ipaddr.js";
import { type DB, exec, query, schema, withAdvisoryLock } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import { stableJson } from "../lib/stable-json.ts";
import { isUniqueViolation } from "./kb-store.ts";

export type WeightingRow = typeof schema.weightings.$inferSelect;
export type PollRow = typeof schema.weightingPolls.$inferSelect;

/** A poll is open this long, from the moment it opens. It can be cancelled, never shortened. */
export const POLL_DAYS = 5;
export const POLL_MS = POLL_DAYS * 24 * 60 * 60_000;

/** The rubric's own weighting for the current rubric version. */
export const BASELINE_ID = `rubric-${rubric.version}`;

export const POLL_LIMITS = {
  /** Distinct voters per network (/24, /48) per poll: signed in with X (a backstop; the account is the limit), and browser-only. */
  networkVotersX: 20,
  networkVotersBrowser: 3,
  /** Times one ballot can be changed. */
  revisions: 20,
  /** Bounds on the quorum an editor can set. */
  maxMinBallots: 100_000,
} as const;

export class PollError extends Error {
  constructor(
    public code:
      | "poll_open"
      | "not_found"
      | "closed"
      | "sign_in_required"
      | "invalid"
      | "network_limit"
      | "revision_limit"
      | "busy"
      | "retired"
      | "x_unavailable",
    message: string,
    public details: string[] = [],
  ) {
    super(message);
  }
}

// ---------- weightings ----------

export function weightingHash(rubricVersion: string, config: Weighting): string {
  return createHash("sha256").update(stableJson({ rubricVersion, config })).digest("hex");
}

export function weightingRef(row: Pick<WeightingRow, "id" | "number" | "title" | "source" | "hash">): WeightingRef {
  return { id: row.id, number: row.number, label: `W${row.number}`, title: row.title, source: row.source as WeightingRef["source"], hash: row.hash };
}

/** A weighting this database never stored: the built-in weights of an older rubric. */
export function legacyRef(rubricVersion: string): WeightingRef {
  return {
    id: `rubric-${rubricVersion}`,
    number: null,
    label: `Rubric ${rubricVersion}`,
    title: `Rubric ${rubricVersion} weights`,
    source: "rubric",
    hash: null,
  };
}

/** Rows never change once created, except for retiring: cached per database for their config and reference. */
const resolved = new WeakMap<DB, Map<string, { row: WeightingRow; weighting: Weighting }>>();
const baselines = new WeakMap<DB, WeightingRow>();

function cacheFor(db: DB) {
  let m = resolved.get(db);
  if (!m) {
    m = new Map();
    resolved.set(db, m);
  }
  return m;
}

/**
 * Makes sure the current rubric's own weighting exists, and returns it. Run at boot and on first use (tests and the
 * e2e server don't boot through index.ts). Concurrent first uses converge on the same row.
 */
export async function ensureBaselineWeighting(db: DB): Promise<WeightingRow> {
  const known = baselines.get(db);
  if (known) return known;
  for (let attempt = 0; attempt < 4; attempt++) {
    const [have] = await db.select().from(schema.weightings).where(eq(schema.weightings.id, BASELINE_ID));
    if (have) {
      baselines.set(db, have);
      return have;
    }
    try {
      await db
        .insert(schema.weightings)
        .values({
          id: BASELINE_ID,
          number: await nextNumber(db),
          title: `Rubric ${rubric.version} weights`,
          source: "rubric",
          rubricVersion: rubric.version,
          config: DEFAULT_WEIGHTING as never,
          hash: weightingHash(rubric.version, DEFAULT_WEIGHTING),
          notes: "The rubric's own suite and benchmark weights and answer points.",
        })
        .onConflictDoNothing({ target: schema.weightings.id });
    } catch (e) {
      // Another weighting took the number first: try again with the next one.
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new Error("Couldn't create the rubric's weighting");
}

async function nextNumber(db: DB | Parameters<Parameters<DB["transaction"]>[0]>[0]): Promise<number> {
  const [row] = await (db as DB).select({ n: sql<number>`coalesce(max(${schema.weightings.number}), 0)` }).from(schema.weightings);
  return Number(row?.n ?? 0) + 1;
}

/**
 * Links what was created before weightings existed, under this rubric version, to the rubric's own weighting (boot
 * maintenance). Work from an older rubric stays unlinked: it was scored with that rubric's built-in numbers, which
 * this database never stored, and reads as such.
 */
export async function linkUnweighted(db: DB): Promise<number> {
  const base = await ensureBaselineWeighting(db);
  const v = rubric.version;
  let n = 0;
  n += await exec(db, sql`UPDATE runs SET weighting_id = ${base.id} WHERE weighting_id IS NULL AND rubric_version = ${v}`);
  n += await exec(
    db,
    sql`UPDATE evaluations e SET weighting_id = ${base.id} WHERE e.weighting_id IS NULL
        AND (e.run_id IS NULL OR EXISTS (SELECT 1 FROM runs r WHERE r.id = e.run_id AND r.rubric_version = ${v}))`,
  );
  n += await exec(db, sql`UPDATE releases SET weighting_id = ${base.id} WHERE weighting_id IS NULL AND rubric_version = ${v}`);
  n += await exec(
    db,
    sql`UPDATE published_results pr SET weighting_id = ${base.id} FROM releases r
        WHERE pr.weighting_id IS NULL AND r.id = pr.release_id AND r.rubric_version = ${v}`,
  );
  return n;
}

/**
 * The stored rubric weighting no longer matches the rubric's numbers: someone changed weights or points without
 * bumping the rubric version. The stored copy keeps scoring (results stay reproducible), but it's a mistake to fix.
 */
export async function baselineDrift(db: DB): Promise<string | null> {
  const row = await ensureBaselineWeighting(db);
  const want = weightingHash(rubric.version, DEFAULT_WEIGHTING);
  return row.hash === want
    ? null
    : `The stored ${row.title} (W${row.number}) differs from rubric ${rubric.version}'s numbers. Bump the rubric version when weights or points change.`;
}

/** A weighting by id, "W2" or "2". */
export async function findWeighting(db: DB, ref: string): Promise<WeightingRow | null> {
  const m = /^w?(\d{1,6})$/i.exec(ref.trim());
  const [row] = await db
    .select()
    .from(schema.weightings)
    .where(m ? eq(schema.weightings.number, Number(m[1])) : eq(schema.weightings.id, ref.trim()));
  return row ?? null;
}

/**
 * The weighting an evaluation is scored with: its own, or the rubric's for evaluations from before weightings
 * (null). Config resolved against this rubric (an older weighting gets this rubric's numbers where it has none).
 */
export async function weightingFor(db: DB, id: string | null | undefined): Promise<{ row: WeightingRow; weighting: Weighting; ref: WeightingRef }> {
  const cache = cacheFor(db);
  const key = id ?? BASELINE_ID;
  let hit = cache.get(key);
  if (!hit) {
    const row = key === BASELINE_ID ? await ensureBaselineWeighting(db) : await findWeighting(db, key);
    if (!row) throw new Error(`Unknown weighting ${key}`);
    hit = { row, weighting: resolveWeighting(row.config) };
    cache.set(key, hit);
  }
  return { ...hit, ref: weightingRef(hit.row) };
}

/**
 * The weighting new runs use: the newest poll result not retired (a rubric update doesn't discard the community's
 * weights: they carry over, with the new rubric's numbers wherever they have none), else the newest rubric weighting,
 * preferring the current rubric's. `readOnly` (the local CLI, whose role can't create weightings) returns null
 * instead of creating the rubric's weighting on a database that has none yet.
 */
export async function defaultWeighting(db: DB, opts: { readOnly?: boolean } = {}): Promise<WeightingRow | null> {
  if (!opts.readOnly) await ensureBaselineWeighting(db);
  const [row] = await db
    .select()
    .from(schema.weightings)
    .where(isNull(schema.weightings.retiredAt))
    .orderBy(
      sql`(${schema.weightings.source} = 'poll') DESC`,
      sql`(${schema.weightings.rubricVersion} = ${rubric.version}) DESC`,
      desc(schema.weightings.number),
    )
    .limit(1);
  if (row) return row;
  // Everything retired: the rubric's own still scores.
  return opts.readOnly ? ((await findWeighting(db, BASELINE_ID)) ?? null) : await ensureBaselineWeighting(db);
}

/** A weighting new work may use: it exists and isn't retired. */
export async function usableWeighting(db: DB, ref: string | undefined): Promise<WeightingRow> {
  if (!ref) return (await defaultWeighting(db))!;
  const row = await findWeighting(db, ref);
  if (!row) throw new PollError("not_found", `No weighting "${ref}".`);
  if (row.retiredAt) throw new PollError("retired", `Weighting W${row.number} is retired; pick another, or restore it first.`);
  return row;
}

/** Id → reference for every stored weighting, for labelling published results (refreshed at most once a minute). */
const refCache = new WeakMap<DB, { at: number; map: Map<string, WeightingRef> }>();
export async function weightingRefs(db: DB): Promise<Map<string, WeightingRef>> {
  const hit = refCache.get(db);
  if (hit && Date.now() - hit.at < 60_000) return hit.map;
  await ensureBaselineWeighting(db);
  const rows = await db
    .select({
      id: schema.weightings.id,
      number: schema.weightings.number,
      title: schema.weightings.title,
      source: schema.weightings.source,
      hash: schema.weightings.hash,
    })
    .from(schema.weightings);
  const map = new Map(rows.map((r) => [r.id, weightingRef(r)]));
  refCache.set(db, { at: Date.now(), map });
  return map;
}

/** Forgets cached references after a weighting is added. */
export function bumpWeightingRefs(db: DB) {
  refCache.delete(db);
}

/** The reference for a published result's weighting, including results from before weightings (their rubric's). */
export function refFor(refs: Map<string, WeightingRef>, weighting: WeightingRef | null | undefined, rubricVersion: string): WeightingRef {
  if (weighting?.id) return refs.get(weighting.id) ?? weighting;
  return refs.get(`rubric-${rubricVersion}`) ?? legacyRef(rubricVersion);
}

export async function listWeightings(db: DB): Promise<WeightingSummary[]> {
  const current = await defaultWeighting(db);
  const rows = await db.select().from(schema.weightings).orderBy(desc(schema.weightings.number));
  const counts = new Map(
    (
      await query<{ id: string; n: number }>(
        db,
        sql`SELECT pr.weighting_id AS id, count(*)::int AS n FROM published_results pr JOIN projects p ON p.id = pr.project_id
            WHERE pr.active AND p.status = 'active' AND pr.weighting_id IS NOT NULL GROUP BY pr.weighting_id`,
      )
    ).map((r) => [r.id, Number(r.n)]),
  );
  const polls = new Map(
    (await db.select().from(schema.weightingPolls).where(eq(schema.weightingPolls.status, "closed"))).filter((p) => p.resultId).map((p) => [p.resultId!, p]),
  );
  return rows.map((r) => {
    const p = polls.get(r.id);
    return {
      ...weightingRef(r),
      rubricVersion: r.rubricVersion,
      createdAt: r.createdAt,
      baseId: r.baseId,
      retired: !!r.retiredAt,
      current: r.id === current?.id,
      results: counts.get(r.id) ?? 0,
      poll: p ? { id: p.id, title: p.title, ballots: p.ballots, closedAt: p.closedAt } : null,
    };
  });
}

export async function weightingDetail(db: DB, row: WeightingRow): Promise<WeightingDetail> {
  const summary = (await listWeightings(db)).find((w) => w.id === row.id)!;
  const { weighting } = await weightingFor(db, row.id);
  const base = row.baseId ? await weightingFor(db, row.baseId).catch(() => null) : null;
  const poll = row.pollId ? ((await db.select().from(schema.weightingPolls).where(eq(schema.weightingPolls.id, row.pollId)))[0] ?? null) : null;
  const releases = await db
    .select({ id: schema.releases.id, label: schema.releases.label, publishedAt: schema.releases.publishedAt })
    .from(schema.releases)
    .where(and(eq(schema.releases.weightingId, row.id), eq(schema.releases.isDemo, false)))
    .orderBy(desc(schema.releases.publishedAt));
  return {
    ...summary,
    config: weighting,
    base: base?.ref ?? null,
    changes: base ? (diffWeightings(base.weighting, weighting) as WeightingChange[]) : [],
    pollStats: (poll?.stats as PollStats | null) ?? null,
    releases,
  };
}

/** Retires or restores a weighting. The last weighting in use can't be retired: new runs need one. */
export async function setRetired(db: DB, id: string, retired: boolean): Promise<WeightingRow> {
  const row = await findWeighting(db, id);
  if (!row) throw new PollError("not_found", "No such weighting.");
  if (retired) {
    const [others] = await query<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM weightings WHERE retired_at IS NULL AND id <> ${row.id}`);
    if (!Number(others?.n)) throw new PollError("busy", "This is the only weighting left for new runs; it can't be retired.");
  }
  const [updated] = await db
    .update(schema.weightings)
    .set({ retiredAt: retired ? new Date().toISOString() : null })
    .where(eq(schema.weightings.id, row.id))
    .returning();
  cacheFor(db).delete(row.id);
  return updated!;
}

// ---------- polls ----------

/** Changes when a poll opens, closes or is cancelled in this process (keys the cached public summary). */
let pollState = 0;
export const pollStateVersion = () => pollState;

export async function openPollRow(db: DB): Promise<PollRow | null> {
  const [row] = await db.select().from(schema.weightingPolls).where(eq(schema.weightingPolls.status, "open"));
  return row ?? null;
}

export async function pollById(db: DB, id: string): Promise<PollRow | null> {
  const [row] = await db.select().from(schema.weightingPolls).where(eq(schema.weightingPolls.id, id));
  return row ?? null;
}

/** Ballots that count: cast and not withdrawn. */
async function liveCount(db: DB, pollId: string): Promise<number> {
  const [row] = await query<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM weighting_ballots WHERE poll_id = ${pollId} AND withdrawn_at IS NULL`);
  return Number(row?.n ?? 0);
}

export async function pollInfo(db: DB, p: PollRow): Promise<PollInfo> {
  const base = await weightingFor(db, p.baseId);
  const result = p.resultId ? await weightingFor(db, p.resultId) : null;
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    opensAt: p.opensAt,
    closesAt: p.closesAt,
    status: p.status as PollInfo["status"],
    requireX: p.requireX,
    minBallots: p.minBallots,
    ballots: p.status === "open" ? await liveCount(db, p.id) : p.ballots,
    outcome: (p.outcome as PollInfo["outcome"]) ?? null,
    base: base.ref,
    result: result?.ref ?? null,
  };
}

export interface OpenPollInput {
  baseId?: string;
  title?: string;
  description?: string;
  requireX: boolean;
  minBallots?: number;
}

/** Opens a five-day poll on a base weighting (the current one by default). One poll is open at a time. */
export async function openPoll(db: DB, input: OpenPollInput, now = new Date()): Promise<PollRow> {
  await finalizeDuePolls(db, now);
  if (await openPollRow(db)) throw new PollError("poll_open", "A poll is already open. Cancel it or wait for it to close.");
  const base = await usableWeighting(db, input.baseId);
  const [{ n } = { n: 0 }] = await query<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM weighting_polls`);
  const id = newId();
  try {
    const [row] = await db
      .insert(schema.weightingPolls)
      .values({
        id,
        title: input.title?.trim() || `Community weighting poll #${Number(n) + 1}`,
        description: input.description?.trim() ?? "",
        baseId: base.id,
        opensAt: now.toISOString(),
        closesAt: new Date(now.getTime() + POLL_MS).toISOString(),
        status: "open",
        requireX: input.requireX,
        minBallots: Math.min(POLL_LIMITS.maxMinBallots, Math.max(1, Math.round(input.minBallots ?? 10))),
        salt: randomBytes(32).toString("hex"),
      })
      .returning();
    pollState++;
    return row!;
  } catch (e) {
    if (isUniqueViolation(e)) throw new PollError("poll_open", "A poll is already open.");
    throw e;
  }
}

/**
 * Cancels an open poll. Its ballots are deleted and its salt erased: a cancelled poll decides nothing, so they serve
 * no purpose.
 */
export async function cancelPoll(db: DB, id: string, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.weightingPolls)
      .set({
        status: "cancelled",
        closedAt: now.toISOString(),
        salt: "",
        ballots: sql`(SELECT count(*)::int FROM weighting_ballots WHERE poll_id = ${id} AND withdrawn_at IS NULL)`,
      })
      .where(and(eq(schema.weightingPolls.id, id), eq(schema.weightingPolls.status, "open")))
      .returning({ id: schema.weightingPolls.id });
    if (!row) throw new PollError("not_found", "No open poll with that id.");
    await tx.delete(schema.weightingBallots).where(eq(schema.weightingBallots.pollId, id));
  });
  pollState++;
}

// ---------- voters and ballots ----------

export interface Voter {
  kind: "x" | "browser";
  id: string;
}

function hmac(salt: string, value: string): string {
  return createHmac("sha256", salt).update(value).digest("hex");
}

export function voterHash(poll: Pick<PollRow, "salt">, voter: Voter): string {
  return hmac(poll.salt, `${voter.kind}:${voter.id}`);
}

/** The network an address belongs to: its IPv4 /24 or IPv6 /48. Many voters behind one NAT count as one network. */
export function networkOf(ip: string): string {
  if (!ipaddr.isValid(ip)) return "unknown";
  const a = ipaddr.process(ip);
  if (a.kind() === "ipv4") return `${(a as ipaddr.IPv4).octets.slice(0, 3).join(".")}.0/24`;
  return `${(a as ipaddr.IPv6).parts
    .slice(0, 3)
    .map((p) => p.toString(16))
    .join(":")}::/48`;
}

export function networkHash(poll: Pick<PollRow, "salt">, ip: string): string {
  return hmac(poll.salt, `net:${networkOf(ip)}`);
}

/**
 * Whether an address is one the network cap can apply to. An unknown or platform-internal address (a proxy or CDN
 * hop rather than the voter) would put everyone behind it in one "network", so the cap skips it; the account and
 * rate limits still apply.
 */
export function cappable(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  const range = ipaddr.process(ip).range();
  return !["private", "loopback", "carrierGradeNat", "linkLocal", "uniqueLocal", "unspecified"].includes(range);
}

/** The key rate limits count an address under: an IPv6 client controls its whole /64, so that's one key. */
export function rateKey(ip: string): string {
  if (!ipaddr.isValid(ip)) return ip;
  const a = ipaddr.process(ip);
  return a.kind() === "ipv4"
    ? a.toString()
    : `${(a as ipaddr.IPv6).parts
        .slice(0, 4)
        .map((p) => p.toString(16))
        .join(":")}::/64`;
}

export async function voterBallot(db: DB, poll: PollRow, voter: Voter) {
  const [row] = await db
    .select()
    .from(schema.weightingBallots)
    .where(and(eq(schema.weightingBallots.pollId, poll.id), eq(schema.weightingBallots.voterHash, voterHash(poll, voter))));
  return row ?? null;
}

function isOpen(poll: PollRow, now: Date) {
  return poll.status === "open" && now.toISOString() < poll.closesAt;
}

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * Inside a ballot write: the poll is still open, and stays so until the write commits (the share lock makes a
 * concurrent close wait for it, so the close counts this ballot).
 */
async function stillOpen(tx: Tx, pollId: string, now: Date): Promise<boolean> {
  const [row] = await query<{ id: string }>(
    tx as unknown as DB,
    sql`SELECT id FROM weighting_polls WHERE id = ${pollId} AND status = 'open' AND closes_at > ${now.toISOString()} FOR SHARE`,
  );
  return !!row;
}

/**
 * Records a voter's ballot, or replaces the one they cast before. One ballot per voter per poll; an X poll takes
 * X voters only; a network holds a bounded number of voters; a ballot can be changed a bounded number of times.
 */
export async function castBallot(
  db: DB,
  poll: PollRow,
  voter: Voter,
  ip: string,
  ballot: Ballot,
  now = new Date(),
): Promise<{ created: boolean; ballots: number }> {
  if (!isOpen(poll, now)) throw new PollError("closed", "This poll has closed.");
  if (poll.requireX && voter.kind !== "x") throw new PollError("sign_in_required", "Sign in with X to vote in this poll.");
  const errors = validateBallot(ballot);
  if (errors.length) throw new PollError("invalid", errors[0]!, errors);
  const base = await weightingFor(db, poll.baseId);
  const changes = ballotChanges(base.weighting, ballot).length;
  const vh = voterHash(poll, voter);
  const nh = cappable(ip) ? networkHash(poll, ip) : null;
  const stamp = now.toISOString();
  let created = false;
  try {
    await db.transaction(async (tx) => {
      // One writer per voter and per network at a time: the cap's count and the insert can't interleave.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${poll.id}:${nh ?? vh}`}))`);
      if (!(await stillOpen(tx, poll.id, now))) throw new PollError("closed", "This poll has closed.");
      const [existing] = await tx
        .select()
        .from(schema.weightingBallots)
        .where(and(eq(schema.weightingBallots.pollId, poll.id), eq(schema.weightingBallots.voterHash, vh)));
      if (existing) {
        // A change, or a vote again after withdrawing: both count against the same cap.
        const [updated] = await tx
          .update(schema.weightingBallots)
          .set({ ballot: ballot as never, changes, revisions: sql`${schema.weightingBallots.revisions} + 1`, withdrawnAt: null, updatedAt: stamp })
          .where(and(eq(schema.weightingBallots.id, existing.id), lt(schema.weightingBallots.revisions, POLL_LIMITS.revisions)))
          .returning({ id: schema.weightingBallots.id });
        if (!updated) throw new PollError("revision_limit", "This ballot has been changed too many times; it stands as it is.");
        return;
      }
      if (nh) {
        // Withdrawn ballots keep their network's slot: withdrawing and voting again from a new browser can't cycle it.
        const cap = voter.kind === "x" ? POLL_LIMITS.networkVotersX : POLL_LIMITS.networkVotersBrowser;
        const [same] = await query<{ n: number }>(
          tx as unknown as DB,
          sql`SELECT count(*)::int AS n FROM weighting_ballots WHERE poll_id = ${poll.id} AND network_hash = ${nh}`,
        );
        if (Number(same?.n ?? 0) >= cap) {
          console.warn(`[weighting] poll ${poll.id}: a network reached its ${cap}-voter cap`);
          throw new PollError("network_limit", "Too many people have voted from this network in this poll.");
        }
      }
      await tx.insert(schema.weightingBallots).values({
        id: newId(),
        pollId: poll.id,
        voterHash: vh,
        voterKind: voter.kind,
        networkHash: nh,
        ballot: ballot as never,
        changes,
        createdAt: stamp,
        updatedAt: stamp,
      });
      created = true;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new PollError("busy", "Your ballot is already being saved; try again.");
    throw e;
  }
  return { created, ballots: await liveCount(db, poll.id) };
}

/**
 * Withdraws a voter's ballot: it stops counting, but the row stays (revisions and the network slot remain used),
 * so withdrawing and voting again doesn't reset the limits.
 */
export async function withdrawBallot(db: DB, poll: PollRow, voter: Voter, now = new Date()): Promise<boolean> {
  if (!isOpen(poll, now)) throw new PollError("closed", "This poll has closed.");
  const n = await exec(
    db,
    sql`UPDATE weighting_ballots SET withdrawn_at = ${now.toISOString()}
        WHERE poll_id = ${poll.id} AND voter_hash = ${voterHash(poll, voter)} AND withdrawn_at IS NULL`,
  );
  return n > 0;
}

// ---------- results ----------

async function pollBallots(db: DB, pollId: string) {
  return db
    .select({ ballot: schema.weightingBallots.ballot, updatedAt: schema.weightingBallots.updatedAt, networkHash: schema.weightingBallots.networkHash })
    .from(schema.weightingBallots)
    .where(and(eq(schema.weightingBallots.pollId, pollId), isNull(schema.weightingBallots.withdrawnAt)));
}

function statsOf(ballots: { updatedAt: string }[], agg: { ballots: number; unchanged: number; changedBy: Record<string, number> }): PollStats {
  const perDay: Record<string, number> = {};
  for (const b of ballots) perDay[b.updatedAt.slice(0, 10)] = (perDay[b.updatedAt.slice(0, 10)] ?? 0) + 1;
  return { ballots: agg.ballots, unchanged: agg.unchanged, changedBy: agg.changedBy, perDay };
}

/** What the poll would decide if it closed now, for the editor: the result, its changes and the turnout. */
export async function pollPreview(db: DB, poll: PollRow) {
  const base = await weightingFor(db, poll.baseId);
  const ballots = await pollBallots(db, poll.id);
  const agg = aggregateBallots(
    base.weighting,
    ballots.map((b) => b.ballot as Ballot),
  );
  return {
    stats: statsOf(ballots, agg),
    networks: new Set(ballots.map((b) => b.networkHash).filter(Boolean)).size,
    quorum: ballots.length >= poll.minBallots,
    changes: agg.changes as WeightingChange[],
  };
}

/**
 * Closes a due poll: with a quorum, its result becomes the next weighting (and the default for new runs); without
 * one, nothing changes. Either way its salt, voter keys and network hashes are erased: nothing about who voted is
 * needed once it's decided. One transaction, claimed by its status, so two replicas can't both close it, and a crash
 * leaves it open to be closed again.
 */
export async function finalizePoll(db: DB, pollId: string, now = new Date()): Promise<PollRow | null> {
  const closed = await db.transaction(async (tx) => {
    const [poll] = await tx
      .update(schema.weightingPolls)
      .set({ status: "closed", closedAt: now.toISOString() })
      .where(and(eq(schema.weightingPolls.id, pollId), eq(schema.weightingPolls.status, "open"), lte(schema.weightingPolls.closesAt, now.toISOString())))
      .returning();
    if (!poll) return null;
    const [baseRow] = await tx.select().from(schema.weightings).where(eq(schema.weightings.id, poll.baseId));
    const base = resolveWeighting(baseRow!.config);
    const ballots = await tx
      .select({ ballot: schema.weightingBallots.ballot, updatedAt: schema.weightingBallots.updatedAt })
      .from(schema.weightingBallots)
      .where(and(eq(schema.weightingBallots.pollId, poll.id), isNull(schema.weightingBallots.withdrawnAt)));
    const agg = aggregateBallots(
      base,
      ballots.map((b) => b.ballot as Ballot),
    );
    const stats = statsOf(ballots, agg);
    let resultId: string | null = null;
    let outcome: "adopted" | "no_quorum" = "no_quorum";
    if (ballots.length >= poll.minBallots) {
      resultId = newId();
      outcome = "adopted";
      const changed = agg.changes.length;
      await tx.insert(schema.weightings).values({
        id: resultId,
        number: await nextNumber(tx),
        title: poll.title,
        source: "poll",
        rubricVersion: rubric.version,
        config: agg.weighting as never,
        hash: weightingHash(rubric.version, agg.weighting),
        baseId: poll.baseId,
        pollId: poll.id,
        notes: `${ballots.length} ballots; ${agg.unchanged} kept every weight as it was; ${changed} weight${changed === 1 ? "" : "s"} changed.`,
        createdAt: now.toISOString(),
      });
    }
    const [done] = await tx
      .update(schema.weightingPolls)
      .set({ outcome, resultId, ballots: ballots.length, stats: stats as never, salt: "" })
      .where(eq(schema.weightingPolls.id, poll.id))
      .returning();
    await tx.execute(sql`UPDATE weighting_ballots SET network_hash = NULL, voter_hash = 'closed:' || id WHERE poll_id = ${poll.id}`);
    return done!;
  });
  if (closed) {
    bumpWeightingRefs(db);
    pollState++;
  }
  return closed;
}

/** Closes every poll whose five days are up. Cheap when none are: one indexed query. */
export async function finalizeDuePolls(db: DB, now = new Date()): Promise<PollRow[]> {
  const due = await db
    .select({ id: schema.weightingPolls.id })
    .from(schema.weightingPolls)
    .where(and(eq(schema.weightingPolls.status, "open"), lte(schema.weightingPolls.closesAt, now.toISOString())));
  const out: PollRow[] = [];
  for (const p of due) {
    const r = await finalizePoll(db, p.id, now);
    if (r) out.push(r);
  }
  return out;
}

let timer: NodeJS.Timeout | null = null;

/** Erases what identifies voters in polls that are no longer open (a backstop for a write that raced a close). */
export async function scrubClosedPolls(db: DB): Promise<number> {
  return exec(
    db,
    sql`UPDATE weighting_ballots b SET network_hash = NULL, voter_hash = 'closed:' || b.id
        FROM weighting_polls p WHERE p.id = b.poll_id AND p.status <> 'open' AND b.voter_hash NOT LIKE 'closed:%'`,
  );
}

/** Closes due polls every minute, on one replica at a time. */
export function startPollScheduler(db: DB, everyMs = 60_000) {
  if (timer) return;
  const tick = () =>
    void withAdvisoryLock(db, "weighting-polls", async () => {
      for (const p of await finalizeDuePolls(db))
        console.log(`[weighting] poll "${p.title}" closed: ${p.outcome === "adopted" ? "adopted as a new weighting" : "no quorum"} (${p.ballots} ballots)`);
      await scrubClosedPolls(db);
    }).catch((e) => console.error(`[weighting] closing polls failed: ${(e as Error).message}`));
  tick();
  timer = setInterval(tick, everyMs);
  timer.unref();
}

export function stopPollScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
