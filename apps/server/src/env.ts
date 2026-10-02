import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = resolve(here, "..");

/** True when a secret is set to something other than an obvious placeholder ("dummy", "changeme", ...). */
export function isRealSecret(value: string | undefined | null): value is string {
  return !!value && !/placeholder|dummy|changeme|replace|your[-_ ]?key/i.test(value);
}
export const REPO_ROOT = resolve(SERVER_ROOT, "../..");

const envFile = resolve(SERVER_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

export const env = {
  port: num(process.env.PORT, 8787),
  // On Railway the volume mount path is provided automatically; locally data lives in data/.
  /**
   * The SQLite database from before Postgres. On the first boot with an empty Postgres it's imported (then left as
   * it was). Its directory also holds the logo cache and the logical backups.
   */
  dbPath:
    process.env.DB_PATH ??
    (process.env.RAILWAY_VOLUME_MOUNT_PATH ? resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH, "benchmark.db") : resolve(REPO_ROOT, "data/benchmark.db")),
  /** PGlite's data directory, used when DATABASE_URL is unset (local development without a Postgres server). */
  pgliteDir: process.env.PGLITE_DIR ?? resolve(REPO_ROOT, "data/pglite"),
  /** Postgres connections per process, and the longest a single statement may run. */
  pgPoolMax: num(process.env.PG_POOL_MAX, 10),
  pgStatementTimeoutMs: num(process.env.PG_STATEMENT_TIMEOUT_MS, 120_000),
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  /** Needed when the API key is organization-level rather than scoped to a workspace. */
  anthropicWorkspaceId: process.env.ANTHROPIC_WORKSPACE_ID ?? "",
  /** Hand-labelled demo release. Off unless explicitly enabled; when off, any demo data is purged on boot. */
  seedDemo: process.env.SEED_DEMO === "1",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  sessionSecret: process.env.SESSION_SECRET ?? "",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  exaKey: process.env.EXA_API_KEY ?? "",
  newsApiKey: process.env.NEWSAPI_AI_KEY ?? "",
  xBearer: process.env.X_BEARER_TOKEN ?? "",
  /** Knowledge-base limits per project. */
  kb: {
    // Sized for exhaustive weekly builds on the editor's machine (the database has room: tens of GB).
    maxDocsPages: num(process.env.KB_MAX_DOCS_PAGES, 2000),
    maxSitePages: num(process.env.KB_MAX_SITE_PAGES, 250),
    maxCodeFiles: num(process.env.KB_MAX_CODE_FILES, 4000),
    maxCodeBytes: num(process.env.KB_MAX_CODE_BYTES, 200_000_000),
    /** Repositories monitored from the project's GitHub orgs besides the configured ones, and their own budget. */
    maxDiscoveredRepos: num(process.env.KB_MAX_DISCOVERED_REPOS, 16),
    maxDiscoveredCodeFiles: num(process.env.KB_MAX_DISCOVERED_CODE_FILES, 3000),
    maxDiscoveredCodeBytes: num(process.env.KB_MAX_DISCOVERED_CODE_BYTES, 120_000_000),
    staleDays: num(process.env.KB_STALE_DAYS, 3),
  },
  etherscanKey: process.env.ETHERSCAN_API_KEY ?? "",
  publicUrl: (process.env.PUBLIC_URL ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "http://localhost:5173")).replace(
    /\/$/,
    "",
  ),
  /**
   * Three model tiers: gathering (cheap, fast), writing (prose), reasoning (judgment).
   * Per-stage EVAL_MODEL_* / VERSION_MODEL variables still override a single stage.
   */
  models: {
    gather: process.env.MODEL_GATHER || "claude-haiku-4-5",
    write: process.env.MODEL_WRITE || "claude-sonnet-5-5",
    reason: process.env.MODEL_REASON || process.env.EVAL_MODEL || "claude-opus-5-5",
    scout: process.env.EVAL_MODEL_SCOUT,
    code: process.env.EVAL_MODEL_CODE,
    research: process.env.EVAL_MODEL_RESEARCH,
    judge: process.env.EVAL_MODEL_JUDGE,
    skeptic: process.env.EVAL_MODEL_SKEPTIC,
    summary: process.env.EVAL_MODEL_SUMMARY,
    intake: process.env.EVAL_MODEL_INTAKE,
    versions: process.env.VERSION_MODEL,
    changes: process.env.EVAL_MODEL_CHANGES,
    codemap: process.env.EVAL_MODEL_CODEMAP,
  },

  versionCheckHours: process.env.VERSION_CHECK_INTERVAL_HOURS === "0" ? 0 : num(process.env.VERSION_CHECK_INTERVAL_HOURS, 12),
  maxConcurrentProjects: num(process.env.EVAL_MAX_CONCURRENT_PROJECTS, 2),
  maxInflightCalls: num(process.env.EVAL_MAX_INFLIGHT_CALLS, 6),
  /** The standard-mode cap; kept for older callers. Per-mode caps are in `costCaps` (see `costCapFor`). */
  evalCostCapUsd: num(process.env.EVAL_COST_CAP_USD_STANDARD, num(process.env.EVAL_COST_CAP_USD, 25)),
  /**
   * Spend cap per evaluation, by mode. A deep run's normal cost is above the standard cap, so one shared cap
   * either aborted deep runs after the money was spent or let quick runs overspend. The legacy
   * EVAL_COST_CAP_USD still sets the standard cap when EVAL_COST_CAP_USD_STANDARD isn't set.
   */
  costCaps: {
    quick: num(process.env.EVAL_COST_CAP_USD_QUICK, 10),
    standard: num(process.env.EVAL_COST_CAP_USD_STANDARD, num(process.env.EVAL_COST_CAP_USD, 25)),
    deep: num(process.env.EVAL_COST_CAP_USD_DEEP, 100),
  },
  isProd: process.env.NODE_ENV === "production",
  /**
   * Who builds knowledge bases. "local" (the default in production): the editor builds them with the local CLI
   * (`pnpm bench kb <slug>`), writing straight to the production database, and this server never crawls; an
   * evaluation it runs needs a ready knowledge base for its version. "server": this process builds them.
   */
  kbBuild: (process.env.KB_BUILD === "local" || process.env.KB_BUILD === "server"
    ? process.env.KB_BUILD
    : process.env.NODE_ENV === "production"
      ? "local"
      : "server") as "local" | "server",
};

/** Spend cap (USD) for one evaluation in the given mode; unknown modes (e.g. "manual") use the standard cap. */
export function costCapFor(mode: string): number {
  return env.costCaps[mode as keyof typeof env.costCaps] ?? env.costCaps.standard;
}

/**
 * Cookies get `Secure` (and the `__Host-` prefix) whenever the public URL is https, independent of NODE_ENV:
 * a production build served over plain http on localhost (e2e) still works, and a staging deploy without
 * NODE_ENV set still gets secure cookies.
 */
export const secureCookies = env.publicUrl.startsWith("https://");

/**
 * Running as a deployment the internet can reach (R3-SEC-11): NODE_ENV=production, an https public URL, or a Railway
 * environment. Railway doesn't set NODE_ENV by itself, so checks that guard a deployment can't rely on it alone.
 */
export function isDeployed(): boolean {
  return env.isProd || secureCookies || !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_ENVIRONMENT_NAME;
}

export type Stage = "scout" | "code" | "research" | "judge" | "skeptic" | "summary" | "intake" | "versions" | "changes" | "codemap";
export type Tier = "gather" | "write" | "reason";

/** Which tier each stage belongs to: gathering evidence, writing prose, or making judgments. */
export const STAGE_TIER: Record<Stage, Tier> = {
  // Mapping coverage and filling gaps needs judgment about what matters: the writing tier, not the cheapest one.
  scout: "write",
  // Understanding code and its powers is reasoning work, not gathering.
  code: "reason",
  // Research decides which quote settles which option and records it verbatim. Live runs on the gathering tier
  // paraphrased a third of its quotes and lost evidence, so it runs on the reasoning tier.
  research: "reason",
  judge: "reason",
  skeptic: "reason",
  // Explaining why an answer changed between versions is a judgment call.
  changes: "reason",
  codemap: "write",
  summary: "write",
  intake: "write",
  versions: "write",
};

export function modelFor(stage: Stage): string {
  return env.models[stage] || env.models[STAGE_TIER[stage]];
}
