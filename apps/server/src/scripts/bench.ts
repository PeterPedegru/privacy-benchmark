/**
 * The local CLI: builds knowledge bases and runs evaluations on this machine, writing straight to the database (in
 * production, through its public URL). A finished evaluation lands in the admin's Review like any other; publishing
 * it makes it the project version's live result.
 *
 *   railway run --service bench-cli -- pnpm bench status [slug]
 *   railway run --service bench-cli -- pnpm bench kb <slug> [--version <tag>]
 *   railway run --service bench-cli -- pnpm bench run <slug> [--mode deep|standard|quick] [--version <tag>] [--suites a,b] [--skip-kb]
 *                                                     [--model <id>|tiered] [--effort low|medium|high|xhigh|max] [--cap <usd>]
 *   railway run --service bench-cli -- pnpm bench resume <evaluationId> [--cap <usd>]
 *   railway run --service bench-cli -- pnpm bench rerun <evaluationId> --suites a,b
 *   railway run --service bench-cli -- pnpm bench summarize <evaluationId…>
 *
 * `railway run --service bench-cli` supplies the API keys (Anthropic, Exa, X, NewsAPI, GitHub), DATABASE_PUBLIC_URL (the
 * `bench_cli` role) and PGSSL_CA (the database's CA, so TLS is verified), and nothing else. Without a
 * database URL the CLI uses the local PGlite database (PGLITE_DIR), for trial runs. It never migrates a server's
 * database: the schema must match this checkout (deploy first). Ctrl-C stops a run, which can then be resumed.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvent } from "@pb/core";
import { rubric, suites } from "@pb/rubric";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { closeDb, type DB, databaseUrl, openDb, query, schema } from "../db/index.ts";
import { costCapFor, env } from "../env.ts";
import { isClaudeCodeLimit, verifyClaudeCode } from "../eval/claude-code.ts";
import { bus } from "../eval/events.ts";
import { evalSettings, MODES, type Mode, runEvaluation, summarize } from "../eval/pipeline.ts";
import { HEARTBEAT_EVERY_MS, projectBusy, RERUNNABLE, releaseClaim, rerunChanges, updateRunStatus } from "../eval/queue.ts";
import { newId } from "../lib/ids.ts";
import type { Effort } from "../lib/llm.ts";
import { callScope, emptyUsage, hasApiKey, isBillingError, verifyCanSpend } from "../lib/llm.ts";
import { RUNNER_ID } from "../lib/runner.ts";
import { describeStats, refreshKnowledgeBase } from "../services/kb.ts";
import { REFRESH_HEARTBEAT_STALE_MS } from "../services/kb-maintenance.ts";
import { isUniqueViolation } from "../services/kb-store.ts";
import { latestTrackedVersion } from "../services/versions.ts";

/** Parses `command positional... --flag value --switch`. */
export function parseArgs(argv: string[], switches: string[] = ["skip-kb"]) {
  const [command, ...rest] = argv;
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") continue;
    if (!a.startsWith("--")) positional.push(a);
    else if (switches.includes(a.slice(2))) flags[a.slice(2)] = true;
    else {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${a} needs a value`);
      flags[a.slice(2)] = value;
      i++;
    }
  }
  return { command, positional, flags };
}

const USAGE = `Usage:
  pnpm bench status [slug]
  pnpm bench kb <slug> [--version <tag>]
  pnpm bench run <slug> [--mode deep|standard|quick] [--version <tag>] [--suites a,b] [--skip-kb]
                        [--model <id>|tiered] [--effort low|medium|high|xhigh|max] [--cap <usd>]
      Rebuilds the knowledge base first (--skip-kb reuses it while it's fresh). Every stage runs on the reasoning
      model (MODEL_REASON, Opus 5.5) unless --model says otherwise ("tiered": each stage's configured model);
      deep mode thinks at xhigh effort. A local deep run's cap is $300 (BENCH_DEEP_CAP_USD); --cap sets another.
  pnpm bench resume <evaluationId> [--cap <usd>]
  pnpm bench rerun <evaluationId> --suites a,b [--cap <usd>]
      Researches, code-checks and judges those suites again, then re-runs the checks and the summary after them
      (the admin's "Re-run suites", through Claude Code on this machine).
  pnpm bench summarize <evaluationId…>
      Writes the summaries again from the current answers, overrides included (the admin's "Regenerate summary").
      Releases shows the command for the evaluations you've picked.

Run through \`railway run --service bench-cli --\` to use production's database and API keys.`;

/** An error's message with its cause (a driver error wraps the TLS or network failure), and a hint for TLS. */
export function errorText(e: unknown): string {
  const err = e as Error & { cause?: Error };
  const cause = err.cause?.message && !err.message.includes(err.cause.message) ? `: ${err.cause.message}` : "";
  const text = `${err.message.split("\n")[0]}${cause}`;
  return /certificate|self[- ]signed|SSL|TLS/i.test(text)
    ? `${text}\nThe database's certificate couldn't be verified. Run through \`railway run --service bench-cli --\`, which pins the database's CA (PGSSL_CA).`
    : text;
}

const say = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);

async function open(): Promise<DB> {
  const url = databaseUrl({ preferPublic: true });
  say(url ? `database: ${new URL(url).host}` : `database: local PGlite (${env.pgliteDir})`);
  // A local database may be migrated; a server's never is from here (deploy first).
  // Seven suites' agents call tools in parallel, over the internet: a bigger pool of long-lived connections.
  return openDb(url ? { url, migrate: false, log: () => {}, pool: { max: 24, idleTimeoutMillis: 600_000 } } : { pgliteDir: env.pgliteDir, log: () => {} });
}

/** Keeps a Mac awake while this process runs: a sleeping laptop stops reporting, and the server fails its run. */
function stayAwake() {
  if (process.platform !== "darwin") return;
  try {
    spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {
    // not available: the run still works while the machine stays awake
  }
}

async function findProject(db: DB, slug: string) {
  const p = (await db.select().from(schema.projects).where(eq(schema.projects.slug, slug)))[0];
  if (p) return p;
  const all = await db.select({ slug: schema.projects.slug }).from(schema.projects).orderBy(schema.projects.slug);
  throw new Error(`No project "${slug}". Projects: ${all.map((r) => r.slug).join(", ")}`);
}

/** The version to evaluate: --version (tag, version, label or id), else the latest tracked one. */
async function findVersion(db: DB, projectId: string, wanted?: string) {
  if (!wanted) return (await latestTrackedVersion(db, projectId)) ?? null;
  const v = schema.projectVersions;
  const [row] = await db
    .select()
    .from(v)
    .where(and(eq(v.projectId, projectId), or(eq(v.tag, wanted), eq(v.version, wanted), eq(v.label, wanted), eq(v.id, wanted))));
  if (!row) throw new Error(`No version "${wanted}" for this project`);
  return row;
}

const day = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

async function status(db: DB, slug?: string) {
  const projects = slug ? [await findProject(db, slug)] : await db.select().from(schema.projects).orderBy(schema.projects.slug);
  for (const p of projects) {
    const v = await latestTrackedVersion(db, p.id);
    const evs = await db
      .select()
      .from(schema.evaluations)
      .where(and(eq(schema.evaluations.projectId, p.id), eq(schema.evaluations.isDemo, false)))
      .orderBy(desc(schema.evaluations.createdAt))
      .limit(3);
    console.log(`\n${p.slug} · ${p.name}`);
    console.log(`  latest version: ${v ? `${v.label}${v.tag ? ` (${v.tag})` : ""}` : "none tracked"}`);
    const kb = p.kbStatus === "ready" && p.kbRefreshedAt ? `ready, built ${day(p.kbRefreshedAt)} · ${describeStats(p.kbStats as never)}` : p.kbStatus;
    console.log(`  knowledge base: ${kb}`);
    for (const e of evs) console.log(`  ${e.id} · ${e.mode} · ${e.status} (${e.stage}) · $${e.costUsd.toFixed(2)} · ${day(e.createdAt)}`);
  }
}

/** Rebuilds a project's knowledge base with every lane, unless something else is using or rebuilding it. */
async function buildKb(db: DB, slug: string, wanted: string | undefined, signal?: AbortSignal, tag = "") {
  const p = await findProject(db, slug);
  if (await projectBusy(db, p.id)) throw new Error(`An evaluation of ${slug} is running; its knowledge base can't change under it. Try again when it's done.`);
  const beat = (p.kbMeta as { heartbeatAt?: string; refreshRunner?: string } | null) ?? {};
  if (p.kbStatus === "refreshing" && beat.refreshRunner !== RUNNER_ID && Date.parse(beat.heartbeatAt ?? "") > Date.now() - REFRESH_HEARTBEAT_STALE_MS)
    throw new Error(`The knowledge base for ${slug} is being rebuilt elsewhere (${beat.refreshRunner ?? "another process"}). Try again when it's done.`);
  const v = await findVersion(db, p.id, wanted);
  say(`${tag}knowledge base for ${p.name}${v ? ` · ${v.label}` : ""}: every lane`);
  const started = Date.now();
  let stats = await refreshKnowledgeBase(db, p.id, { versionId: v?.id ?? null, progress: (m) => say(`${tag}  ${m}`), signal, full: true });
  // An exhaustive run needs the code, docs, audits and address lanes whole: one more build when any failed or came
  // back partial (unchanged files are kept, so it costs little).
  const weak = (q: Awaited<ReturnType<typeof findProject>>) =>
    Object.entries(((q.kbMeta ?? {}) as { lanes?: Record<string, { ok: boolean; partial?: boolean }> }).lanes ?? {})
      .filter(([k, l]) => /^(code:|docs$|audits$|addresses$)/.test(k) && (!l.ok || l.partial))
      .map(([k]) => k);
  const failing = weak(await findProject(db, slug));
  if (failing.length && !signal?.aborted) {
    say(`${tag}  ${failing.join(", ")} failed or came back partial; building once more`);
    stats = await refreshKnowledgeBase(db, p.id, { versionId: v?.id ?? null, progress: (m) => say(`${tag}  ${m}`), signal, full: true });
  }
  say(`${tag}knowledge base ready in ${Math.round((Date.now() - started) / 60_000)} min: ${describeStats(stats)}`);
  const after = await findProject(db, slug);
  const still = weak(after);
  if (still.length) say(`${tag}  still failed or partial: ${still.join(", ")}`);
  if (after.kbError) say(`${tag}  some lanes reported problems:\n    ${after.kbError.split("\n").slice(0, 8).join("\n    ")}`);
}

const MARK: Record<string, string> = { error: "✗", warn: "!", success: "✓" };

/** How an evaluation this process drove ended. */
export interface Outcome {
  slug: string;
  id: string | null;
  status: string;
  costUsd: number;
  error: string | null;
}

/** Evaluations this process is driving, so one Ctrl-C stops them all (each resumable). */
const active = new Set<string>();
const stopAll = new AbortController();
let ctrlC = false;
function stopOnCtrlC(db: DB) {
  if (ctrlC) return;
  ctrlC = true;
  let pressed = false;
  process.on("SIGINT", () => {
    if (pressed) process.exit(130);
    pressed = true;
    console.log("\nStopping after the calls in flight (Ctrl-C again to quit now). Resume later with `pnpm bench resume`.");
    // Marked cancelled first, so the pipeline records the stop as a cancel (resumable), not a failure.
    void db
      .update(schema.evaluations)
      .set({ status: "cancelled" })
      .where(and(inArray(schema.evaluations.id, [...active, "-"]), eq(schema.evaluations.status, "running")))
      .catch(() => {})
      .finally(() => stopAll.abort("Cancelled from the CLI"));
  });
}

/** Runs an evaluation this process has claimed, printing its progress (tagged when several run at once). */
async function drive(db: DB, evaluationId: string, runId: string | null, slug: string, tag: string): Promise<Outcome> {
  const listener = (ev: RunEvent) => say(`${tag}${MARK[ev.level] ?? "·"} [${ev.stage}] ${ev.message}`);
  bus.on(`eval:${evaluationId}`, listener);
  active.add(evaluationId);
  const beat = setInterval(() => {
    void db
      .execute(sql`UPDATE evaluations SET heartbeat_at = ${new Date().toISOString()} WHERE id = ${evaluationId} AND runner_id = ${RUNNER_ID}`)
      .catch((e) => say(`${tag}! heartbeat failed: ${(e as Error).message}`));
  }, HEARTBEAT_EVERY_MS);
  try {
    await runEvaluation(db, evaluationId, { signal: stopAll.signal, buildKb: true });
  } catch {
    // Recorded on the evaluation (status and error), reported below.
  } finally {
    clearInterval(beat);
    bus.off(`eval:${evaluationId}`, listener);
    active.delete(evaluationId);
    await releaseClaim(db, evaluationId, runId);
  }
  const ev = (await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, evaluationId)))[0]!;
  const results = await db
    .select({ flags: schema.criterionResults.flags })
    .from(schema.criterionResults)
    .where(eq(schema.criterionResults.evaluationId, evaluationId));
  const viaClaudeCode = (ev.settings as { backend?: string }).backend === "claude-code";
  const cost = viaClaudeCode ? `API-equivalent $${ev.costUsd.toFixed(2)} (your Claude Code login; nothing billed to the API)` : `$${ev.costUsd.toFixed(2)}`;
  console.log(`\n${tag}Evaluation ${evaluationId}: ${ev.status} · ${cost} · ${results.filter((r) => r.flags.length).length} criteria flagged`);
  if (ev.status === "review") console.log(`${tag}Review and publish it at ${env.publicUrl}/admin/review/${evaluationId}`);
  else console.log(`${tag}${stopHint(ev.error) ?? ev.error ?? ""}\n${tag}Resume with: pnpm bench resume ${evaluationId}`);
  return { slug, id: evaluationId, status: ev.status, costUsd: ev.costUsd, error: ev.error };
}

/** Failures that every other run would hit too: the API account can't spend, or Claude Code's plan limit was reached. */
const blocksEveryRun = (error: string | null) => !!error && (isBillingError(error) || isClaudeCodeLimit(error));

/** What to do about a failure that blocks every run, or null for any other error. */
function stopHint(error: string | null): string | null {
  if (error && isClaudeCodeLimit(error))
    return `${error}\nWait for the limit to reset, or log Claude Code in to another account (\`claude\`, then /login), then resume.`;
  if (error && isBillingError(error))
    return "The Anthropic account can't spend (out of credits, or the key was rejected). Add credits under Plans & Billing in the Anthropic Console, then resume.";
  return null;
}

/**
 * Fails fast, before any knowledge-base build is paid for, when the model can't be reached: Claude Code not
 * installed or not logged in, or (with --backend api) an API account that can't spend.
 */
async function requireModel(flags: Record<string, string | true>) {
  if (backendFlag(flags) === "claude-code") {
    say("checking Claude Code (a one-line session on your login; no API key)…");
    const blocked = await verifyClaudeCode();
    if (blocked)
      throw new Error(
        `Claude Code isn't ready: ${blocked}\nInstall it and log in (run \`claude\` once), or set BENCH_CLAUDE_BIN to its path. Runs use your Claude Code login, never an API key.`,
      );
    return;
  }
  requireKeys();
  const blocked = await verifyCanSpend();
  if (blocked)
    throw new Error(
      `The Anthropic API won't take a request: ${blocked}${isBillingError(blocked) ? "\nAdd credits under Plans & Billing in the Anthropic Console, then run again." : ""}`,
    );
}

/**
 * Runs `items` with at most `parallel` at once, stopping new ones after a billing failure or a Claude Code usage
 * limit (the rest would fail the same way, after building their knowledge bases).
 */
async function batch<T>(items: T[], parallel: number, work: (item: T) => Promise<Outcome>): Promise<Outcome[]> {
  const out: Outcome[] = [];
  let next = 0;
  let halted = false;
  const lane = async () => {
    while (!halted && !stopAll.signal.aborted && next < items.length) {
      const item = items[next++]!;
      let o: Outcome;
      try {
        o = await work(item);
      } catch (e) {
        o = { slug: String(item), id: null, status: "error", costUsd: 0, error: errorText(e) };
        console.error(`\n[${o.slug}] ${o.error}`);
      }
      out.push(o);
      if (!halted && blocksEveryRun(o.error)) {
        halted = true;
        say(
          isClaudeCodeLimit(o.error)
            ? "Claude Code's usage limit was reached: not starting the rest. When it resets (or after /login to another account), run `pnpm bench resume --failed`."
            : "The Anthropic account can't spend: not starting the rest. Add credits, then `pnpm bench resume --failed`.",
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, items.length)) }, lane));
  if (items.length > 1) {
    console.log("\nSummary:");
    for (const o of out) console.log(`  ${o.slug}: ${o.status}${o.id ? ` (${o.id})` : ""} · $${o.costUsd.toFixed(2)}`);
    const skipped = items.length - out.length;
    if (skipped) console.log(`  ${skipped} not started`);
  }
  return out;
}

function requireKeys() {
  if (!hasApiKey()) throw new Error("ANTHROPIC_API_KEY isn't set: run through `railway run --service bench-cli --` (or set it in apps/server/.env).");
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** A positive dollar amount from --cap, or undefined. */
function capFlag(flags: Record<string, string | true>): number | undefined {
  if (flags.cap === undefined) return undefined;
  const n = Number(flags.cap);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--cap must be a dollar amount, e.g. --cap 150`);
  return n;
}

/**
 * A local deep run's default cap: high enough that an exhaustive run at xhigh effort on the reasoning model isn't
 * cut short (the cap is a backstop against a runaway loop, not a budget). BENCH_DEEP_CAP_USD changes it.
 */
export const LOCAL_DEEP_CAP_USD = Number(process.env.BENCH_DEEP_CAP_USD) > 0 ? Number(process.env.BENCH_DEEP_CAP_USD) : 300;

/** Where a CLI run's model calls go: Claude Code on this machine (the default; no API), or `--backend api`. */
export function backendFlag(flags: Record<string, string | true>): "api" | "claude-code" {
  if (flags.backend === undefined || flags.backend === "claude-code") return "claude-code";
  if (flags.backend === "api") return "api";
  throw new Error("--backend must be claude-code (the default) or api");
}

/** The reasoning model a run uses: --model, else MODEL_REASON, else Opus 5.5. */
const reasoningModel = () => env.models.reason || "claude-opus-5-5";

/**
 * The evaluation settings a CLI run records: the mode's, every stage on one model unless "tiered", flags applied.
 * Through Claude Code there's no spending cap unless --cap sets one (nothing is billed to the API).
 */
export function cliSettings(mode: Mode, flags: Record<string, string | true>) {
  const backend = backendFlag(flags);
  const model = flags.model === "tiered" ? undefined : typeof flags.model === "string" ? flags.model : reasoningModel();
  const effort = typeof flags.effort === "string" ? flags.effort : undefined;
  if (effort && !EFFORTS.includes(effort as (typeof EFFORTS)[number])) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
  const costCapUsd = capFlag(flags) ?? (mode === "deep" && backend === "api" ? LOCAL_DEEP_CAP_USD : undefined);
  return { ...evalSettings(mode, { model, effort: effort as Effort | undefined, costCapUsd, backend }), local: true };
}

async function run(db: DB, slug: string, flags: Record<string, string | true>, tag = ""): Promise<Outcome> {
  const mode = (typeof flags.mode === "string" ? flags.mode : "deep") as Mode;
  if (!(mode in MODES)) throw new Error(`Unknown mode "${mode}" (deep, standard or quick)`);
  const settings = cliSettings(mode, flags);
  const asked = suitesFlag(flags);
  const suiteFilter = asked.length ? asked : null;
  const p = await findProject(db, slug);
  const v = await findVersion(db, p.id, typeof flags.version === "string" ? flags.version : undefined);
  if (!flags["skip-kb"]) await buildKb(db, slug, v?.id, stopAll.signal, tag);
  if (stopAll.signal.aborted) return { slug, id: null, status: "cancelled", costUsd: 0, error: null };
  const runId = newId();
  const id = newId();
  const now = new Date().toISOString();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.runs).values({ id: runId, label: "Local run", rubricVersion: rubric.version, mode, suiteFilter, status: "running" });
      await tx.insert(schema.evaluations).values({
        id,
        runId,
        projectId: p.id,
        versionId: v?.id ?? null,
        mode,
        suiteFilter,
        status: "running",
        stage: "ingest",
        settings: settings as never,
        startedAt: now,
        runnerId: RUNNER_ID,
        heartbeatAt: now,
      });
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new Error(`An evaluation of ${slug} is already running; wait for it, or cancel it in the admin.`);
    throw e;
  }
  const models = [...new Set(Object.values(settings.models))].join(", ");
  const efforts = [...new Set(Object.values(settings.effort))].join("/");
  const where =
    settings.backend === "claude-code" ? "Claude Code on this machine (no API)" : `the Anthropic API, cap $${settings.costCapUsd ?? costCapFor(mode)}`;
  say(
    `${tag}evaluation ${id}: ${p.name}${v ? ` · ${v.label}` : ""}, ${mode} mode${suiteFilter ? `, suites ${suiteFilter.join(", ")}` : ""} · ${models} at ${efforts} effort · via ${where}`,
  );
  return drive(db, id, runId, slug, tag);
}

async function resume(db: DB, evaluationId: string, flags: Record<string, string | true>, tag = ""): Promise<Outcome> {
  const now = new Date().toISOString();
  // --cap raises the cap of an evaluation that stopped at it. The rest of a resumed run goes through this CLI's
  // backend (Claude Code by default), with no cap unless one is given.
  const cap = capFlag(flags);
  const backend = backendFlag(flags);
  const patch = JSON.stringify({ local: true, backend, ...(cap ? { costCapUsd: cap } : {}) });
  const dropCap = backend === "claude-code" && !cap ? sql`- 'costCapUsd'` : sql``;
  const [claimed] = await db
    .update(schema.evaluations)
    .set({ status: "running", error: null, finishedAt: null, runnerId: RUNNER_ID, heartbeatAt: now, settings: sql`(settings ${dropCap}) || ${patch}::jsonb` })
    .where(and(eq(schema.evaluations.id, evaluationId), inArray(schema.evaluations.status, ["failed", "cancelled"])))
    .returning({ id: schema.evaluations.id, runId: schema.evaluations.runId, projectId: schema.evaluations.projectId });
  if (!claimed) throw new Error(`Evaluation ${evaluationId} isn't failed or cancelled (only those can be resumed).`);
  await updateRunStatus(db, claimed.runId);
  const slug =
    (await db.select({ slug: schema.projects.slug }).from(schema.projects).where(eq(schema.projects.id, claimed.projectId)))[0]?.slug ?? evaluationId;
  say(`${tag}resuming ${evaluationId} (${slug}) from its last completed stage`);
  return drive(db, evaluationId, claimed.runId, slug, tag);
}

/** The suites named by --suites, all known, or an error listing the known ones. */
function suitesFlag(flags: Record<string, string | true>): string[] {
  const asked =
    typeof flags.suites === "string"
      ? flags.suites
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const unknown = asked.filter((s) => !suites.some((x) => x.id === s));
  if (unknown.length) throw new Error(`Unknown suite(s): ${unknown.join(", ")}. Suites: ${suites.map((s) => s.id).join(", ")}`);
  return asked;
}

/** Re-runs some suites of a finished, unpublished evaluation on this machine, as the admin's rerun does on the server. */
export async function rerun(db: DB, evaluationId: string, flags: Record<string, string | true>): Promise<Outcome> {
  const picked = suitesFlag(flags);
  if (!picked.length) throw new Error(`Name the suites to re-run: --suites a,b. Suites: ${suites.map((s) => s.id).join(", ")}`);
  const ev = (await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, evaluationId)))[0];
  if (!ev) throw new Error(`No evaluation ${evaluationId}`);
  if (ev.isDemo) throw new Error("Demo evaluations are hand-labelled and can't be re-run.");
  if (!RERUNNABLE.includes(ev.status))
    throw new Error(
      `Only evaluations in review, reviewed, failed or cancelled can be re-run (this one is ${ev.status}). To re-evaluate a published result, start a new evaluation.`,
    );
  const outside = ev.suiteFilter ? picked.filter((s) => !ev.suiteFilter!.includes(s)) : [];
  if (outside.length) throw new Error(`This evaluation covers only ${ev.suiteFilter!.join(", ")}; it never ran ${outside.join(", ")}.`);
  const cap = capFlag(flags);
  const backend = backendFlag(flags);
  const change = rerunChanges(ev, picked);
  // Through Claude Code there's no cap unless --cap sets one, as for a resume.
  if (backend === "claude-code" && !cap) delete change.settings.costCapUsd;
  const slug = (await db.select({ slug: schema.projects.slug }).from(schema.projects).where(eq(schema.projects.id, ev.projectId)))[0]?.slug ?? evaluationId;
  const now = new Date().toISOString();
  const claim = db
    .update(schema.evaluations)
    .set({
      ...change,
      settings: { ...change.settings, local: true, backend, ...(cap ? { costCapUsd: cap } : {}) } as never,
      status: "running",
      finishedAt: null,
      runnerId: RUNNER_ID,
      heartbeatAt: now,
    })
    // Only from the status it was read in: anything else (a resume, a publish, the admin) got there first.
    .where(and(eq(schema.evaluations.id, evaluationId), eq(schema.evaluations.status, ev.status)))
    .returning({ id: schema.evaluations.id });
  const [claimed] = await claim.catch((e) => {
    if (isUniqueViolation(e)) throw new Error(`An evaluation of ${slug} is already running; wait for it, or cancel it in the admin.`);
    throw e;
  });
  if (!claimed) throw new Error(`Evaluation ${evaluationId} changed while this started; check it with \`pnpm bench status\` and try again.`);
  await updateRunStatus(db, ev.runId);
  say(`re-running ${picked.join(", ")} of ${evaluationId} (${slug}); the stages after research run again`);
  return drive(db, evaluationId, ev.runId, slug, "");
}

/**
 * Writes an evaluation's summary again from its current answers, as the admin's "Regenerate summary" does, but on
 * this machine with the evaluation's recorded models and effort. An override changes the answers, so its summary
 * goes stale until this runs.
 */
export async function summarizeAgain(db: DB, evaluationId: string, flags: Record<string, string | true>) {
  const ev = (await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, evaluationId)))[0];
  if (!ev) throw new Error(`No evaluation ${evaluationId}`);
  // The pipeline writes the summary itself; a second writer would race it.
  if (ev.status === "queued" || ev.status === "running")
    throw new Error(`Evaluation ${evaluationId} is ${ev.status}; the pipeline writes its summary. Regenerate it once it's in review.`);
  const backend = backendFlag(flags);
  const settings = ev.settings as { models?: Record<string, string>; effort?: Record<string, string> };
  const usage = emptyUsage();
  say(`summarizing ${evaluationId} from its current answers, overrides included`);
  try {
    const ok = await callScope.run({ signal: stopAll.signal, models: settings.models, effort: settings.effort, backend }, () =>
      summarize(db, evaluationId, usage),
    );
    if (!ok) throw new Error("Couldn't write a summary grounded in the established answers. Try again.");
  } finally {
    // Added in SQL: the admin may have changed the evaluation meanwhile. Spend from a failed attempt counts too.
    if (usage.costUsd > 0)
      await db
        .update(schema.evaluations)
        .set({ costUsd: sql`${schema.evaluations.costUsd} + ${usage.costUsd}` })
        .where(eq(schema.evaluations.id, evaluationId));
  }
  const cost = backend === "claude-code" ? `API-equivalent $${usage.costUsd.toFixed(2)}, on your Claude Code login` : `$${usage.costUsd.toFixed(2)}`;
  say(`summary written (${cost}). Review it at ${env.publicUrl}/admin/review/${evaluationId}`);
}

/** Each project's latest local evaluation, when it failed or was stopped (what `resume --failed` picks up). */
async function failedLocal(db: DB): Promise<string[]> {
  const rows = await query<{ id: string }>(
    db,
    sql`SELECT DISTINCT ON (project_id) id, status FROM evaluations
        WHERE settings->>'local' = 'true' AND is_demo = false
        ORDER BY project_id, created_at DESC`,
  );
  const latest = rows.map((r) => r.id);
  if (!latest.length) return [];
  return (
    await db
      .select({ id: schema.evaluations.id })
      .from(schema.evaluations)
      .where(and(inArray(schema.evaluations.id, latest), inArray(schema.evaluations.status, ["failed", "cancelled"])))
  ).map((r) => r.id);
}

async function main() {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const { command, positional, flags } = args;
  const needsArg =
    command === "kb" || command === "rerun" || command === "summarize" || (command === "run" && !flags.all) || (command === "resume" && !flags.failed);
  if (!command || !["status", "kb", "run", "resume", "rerun", "summarize"].includes(command) || (needsArg && !positional[0])) {
    console.log(USAGE);
    return command && command !== "help" ? 1 : 0;
  }
  let db: DB;
  try {
    db = await open();
  } catch (e) {
    console.error(`\n${errorText(e)}`);
    return 1;
  }
  try {
    const parallel = Math.max(1, Number(flags.parallel) || 1);
    if (command === "status") await status(db, positional[0]);
    else if (command === "kb") {
      stopOnCtrlC(db);
      stayAwake();
      await buildKb(db, positional[0]!, typeof flags.version === "string" ? flags.version : undefined, stopAll.signal);
    } else if (command === "run") {
      const slugs = flags.all
        ? (await db.select({ slug: schema.projects.slug }).from(schema.projects).orderBy(schema.projects.slug)).map((r) => r.slug)
        : positional;
      await requireModel(flags);
      stopOnCtrlC(db);
      stayAwake();
      const out = await batch(slugs, parallel, (slug) => run(db, slug, flags, slugs.length > 1 ? `[${slug}] ` : ""));
      if (out.some((o) => o.status !== "review") || out.length < slugs.length) process.exitCode = 1;
    } else if (command === "rerun") {
      suitesFlag(flags); // a typo fails before the model check
      await requireModel(flags);
      stopOnCtrlC(db);
      stayAwake();
      const o = await rerun(db, positional[0]!, flags);
      if (o.status !== "review") process.exitCode = 1;
    } else if (command === "summarize") {
      await requireModel(flags);
      stopOnCtrlC(db);
      // At once: each is one session, and Claude Code's session limit keeps the number running in check.
      const ids = [...new Set(positional)];
      const done = await Promise.allSettled(ids.map((id) => summarizeAgain(db, id, flags)));
      const failed = done.flatMap((r, i) => (r.status === "rejected" ? [`${ids[i]}: ${errorText(r.reason)}`] : []));
      if (ids.length > 1) say(`${ids.length - failed.length} of ${ids.length} summaries written`);
      if (failed.length) {
        console.error(`\n${failed.join("\n")}`);
        process.exitCode = 1;
      }
    } else {
      const ids = flags.failed ? await failedLocal(db) : positional;
      if (!ids.length) {
        say("Nothing to resume.");
        return 0;
      }
      await requireModel(flags);
      stopOnCtrlC(db);
      stayAwake();
      const out = await batch(ids, parallel, (id) => resume(db, id, flags, ids.length > 1 ? `[${id}] ` : ""));
      if (out.some((o) => o.status !== "review") || out.length < ids.length) process.exitCode = 1;
    }
  } catch (e) {
    console.error(`\n${errorText(e)}`);
    process.exitCode = 1;
  } finally {
    await closeDb(db);
  }
  return Number(process.exitCode ?? 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
