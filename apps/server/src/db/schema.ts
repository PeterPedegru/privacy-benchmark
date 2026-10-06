import { sql } from "drizzle-orm";
import { boolean, doublePrecision, index, integer, jsonb, pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Timestamps are ISO-8601 text (as `Date.toISOString()` writes them): the code compares them as strings, so the
 * database default produces the same format, in UTC with milliseconds.
 */
const now = sql`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const json = <T>(name: string) => jsonb(name).$type<T>();

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    websiteUrl: text("website_url").notNull(),
    logoUrl: text("logo_url"),
    tagline: text("tagline").notNull().default(""),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default("other"),
    mechanism: text("mechanism").notNull().default("none"),
    attributes: json<string[]>("attributes").notNull().default(sql`'[]'::jsonb`),
    chains: json<string[]>("chains").notNull().default(sql`'[]'::jsonb`),
    l2beatSlug: text("l2beat_slug"),
    defillamaSlug: text("defillama_slug"),
    githubRepos: json<string[]>("github_repos").notNull().default(sql`'[]'::jsonb`),
    xHandle: text("x_handle"),
    /** "admin" when set by an editor; "auto" when discovered (re-verified on every refresh). */
    xHandleSource: text("x_handle_source"),
    docsUrl: text("docs_url"),
    kbStatus: text("kb_status").notNull().default("empty"),
    kbStats: json<Record<string, number>>("kb_stats").notNull().default(sql`'{}'::jsonb`),
    kbRefreshedAt: text("kb_refreshed_at"),
    kbVersionId: text("kb_version_id"),
    kbError: text("kb_error"),
    /** Editor-set docs scopes, e.g. [{ url: "https://docs.starknet.io/build/starknet-privacy" }] (prefix defaults to the URL path). */
    docsRoots: json<{ url: string; prefix?: string }[]>("docs_roots").notNull().default(sql`'[]'::jsonb`),
    /** Extra names news and analyses may use for the project, e.g. ["RAILGUN", "$RAIL"]. */
    newsAliases: json<string[]>("news_aliases").notNull().default(sql`'[]'::jsonb`),
    /** Editor-maintained domains, blog paths (medium.com/@x) or GitHub orgs (github.com/x) the project owns. */
    extraDomains: json<string[]>("extra_domains").notNull().default(sql`'[]'::jsonb`),
    /** Knowledge-base bookkeeping: ownership registry, per-lane status, repo suggestions, verified X account. */
    kbMeta: json<Record<string, unknown>>("kb_meta").notNull().default(sql`'{}'::jsonb`),
    trackVersions: boolean("track_versions").notNull().default(true),
    versionTagPattern: text("version_tag_pattern"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("projects_slug_idx").on(t.slug)],
);

/** A version's deployment as an editor confirmed it: where it runs, and which contracts are this version. */
export interface VersionDeployment {
  status: "mainnet" | "testnet" | "not_deployed";
  /** `chain` is a chain id ("1", "8453") or a network name for non-EVM systems ("aztec", "starknet"). */
  contracts: { chain: string; address: string; label: string }[];
  note: string;
  confirmedAt: string;
}

export const projectVersions = pgTable(
  "project_versions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    label: text("label").notNull(),
    releasedAt: text("released_at"),
    source: text("source").notNull().default("manual"),
    sourceUrl: text("source_url"),
    repo: text("repo"),
    tag: text("tag"),
    isMajor: boolean("is_major").notNull().default(false),
    isPrerelease: boolean("is_prerelease").notNull().default(false),
    status: text("status").notNull().default("detected"),
    summary: text("summary").notNull().default(""),
    privacyRelevant: boolean("privacy_relevant").notNull().default(false),
    affectedSuites: json<string[]>("affected_suites").notNull().default(sql`'[]'::jsonb`),
    relevanceNote: text("relevance_note").notNull().default(""),
    notesMd: text("notes_md").notNull().default(""),
    createdAt: text("created_at").notNull().default(now),
    checkedAt: text("checked_at"),
    /** What this version actually runs, confirmed by an editor (JDG-32). Null until confirmed. */
    deployment: json<VersionDeployment | null>("deployment"),
  },
  (t) => [uniqueIndex("project_versions_project_version_idx").on(t.projectId, t.version), index("project_versions_status_idx").on(t.status)],
);

export const versionChecks = pgTable(
  "version_checks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    ranAt: text("ran_at").notNull().default(now),
    reposChecked: integer("repos_checked").notNull().default(0),
    newVersions: integer("new_versions").notNull().default(0),
    error: text("error"),
    usage: json<Record<string, number>>("usage").notNull().default(sql`'{}'::jsonb`),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
  },
  (t) => [index("version_checks_project_ran_idx").on(t.projectId, t.ranAt)],
);

export const sources = pgTable(
  "sources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    title: text("title").notNull().default(""),
    kind: text("kind").notNull().default("docs"),
    sourceClass: text("source_class").notNull().default("official_docs"),
    contentMd: text("content_md").notNull().default(""),
    contentHash: text("content_hash"),
    /** length(content_md), generated by the database so overviews don't read the content (EFF-9). */
    contentLen: integer("content_len").generatedAlwaysAs(sql`length(content_md)`),
    httpStatus: integer("http_status"),
    origin: text("origin").notNull().default("admin"),
    /** Where in the knowledge base this came from, e.g. {section: "code", repo, path, ref}. */
    meta: json<Record<string, unknown>>("meta").notNull().default(sql`'{}'::jsonb`),
    date: text("date"),
    fetchedAt: text("fetched_at").notNull().default(now),
  },
  (t) => [
    index("sources_project_idx").on(t.projectId),
    uniqueIndex("sources_project_url_idx").on(t.projectId, t.url),
    index("sources_project_kind_idx").on(t.projectId, t.kind),
    index("sources_project_hash_idx").on(t.projectId, t.contentHash),
  ],
);

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  label: text("label").notNull().default(""),
  rubricVersion: text("rubric_version").notNull(),
  mode: text("mode").notNull().default("standard"),
  suiteFilter: json<string[] | null>("suite_filter"),
  status: text("status").notNull().default("queued"),
  costUsd: doublePrecision("cost_usd").notNull().default(0),
  usage: json<Record<string, number>>("usage").notNull().default(sql`'{}'::jsonb`),
  /** The weighting the run's evaluations are scored with (each evaluation keeps its own link). */
  weightingId: text("weighting_id").references(() => weightings.id),
  createdAt: text("created_at").notNull().default(now),
  finishedAt: text("finished_at"),
});

export const evaluations = pgTable(
  "evaluations",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    versionId: text("version_id").references(() => projectVersions.id, { onDelete: "set null" }),
    status: text("status").notNull().default("queued"),
    stage: text("stage").notNull().default("intake"),
    completedStages: json<string[]>("completed_stages").notNull().default(sql`'[]'::jsonb`),
    mode: text("mode").notNull().default("standard"),
    suiteFilter: json<string[] | null>("suite_filter"),
    summary: text("summary").notNull().default(""),
    powers: json<string[]>("powers").notNull().default(sql`'[]'::jsonb`),
    context: json<Record<string, string>>("context").notNull().default(sql`'{}'::jsonb`),
    /** When the summary was last generated; overrides after this make it stale (blocks publishing). */
    summaryAt: text("summary_at"),
    adversaryMatrix: json<Record<string, unknown>>("adversary_matrix").notNull().default(sql`'{}'::jsonb`),
    reviewedSuites: json<string[]>("reviewed_suites").notNull().default(sql`'[]'::jsonb`),
    settings: json<Record<string, unknown>>("settings").notNull().default(sql`'{}'::jsonb`),
    error: text("error"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    usage: json<Record<string, number>>("usage").notNull().default(sql`'{}'::jsonb`),
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: text("created_at").notNull().default(now),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    /** The process running it (host:pid:boot), and when that process last reported. Another replica takes over a stale one. */
    runnerId: text("runner_id"),
    heartbeatAt: text("heartbeat_at"),
    /**
     * The weighting its scores are computed with, chosen when the run starts (null: the rubric's own weighting).
     * Scoring is deterministic from the answers, so an unpublished evaluation can be re-scored with another one.
     */
    weightingId: text("weighting_id").references(() => weightings.id),
  },
  (t) => [
    // One running evaluation per project, enforced by the database across replicas (R3-REL-3).
    uniqueIndex("evaluations_one_running_per_project").on(t.projectId).where(sql`status = 'running'`),
    index("evaluations_project_idx").on(t.projectId),
    index("evaluations_status_idx").on(t.status),
    index("evaluations_run_idx").on(t.runId),
    index("evaluations_version_idx").on(t.versionId),
    index("evaluations_weighting_idx").on(t.weightingId),
  ],
);

export const evidence = pgTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    evaluationId: text("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    criterionId: text("criterion_id").notNull(),
    claim: text("claim").notNull().default(""),
    quote: text("quote").notNull(),
    sourceId: text("source_id").references(() => sources.id, { onDelete: "set null" }),
    url: text("url").notNull().default(""),
    citedUrl: text("cited_url"),
    stance: text("stance").notNull().default("context"),
    sourceClass: text("source_class").notNull().default("official_docs"),
    verified: boolean("verified").notNull().default(false),
    verifyMethod: text("verify_method").notNull().default("none"),
    verifyNote: text("verify_note"),
    /** About 300 characters of the source either side of the quote, so readers see what surrounds it. */
    quoteContext: text("quote_context"),
    /** The researcher's wording when it differed from the source (the stored quote is always the source's text). */
    agentQuote: text("agent_quote"),
    createdByStage: text("created_by_stage").notNull().default("research"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("evidence_eval_idx").on(t.evaluationId, t.criterionId), index("evidence_source_idx").on(t.sourceId)],
);

/**
 * What a researcher searched for a criterion it couldn't settle (R3-JDG-13). An unknown answer with a search log
 * is published as "not disclosed (searched: …)"; without one it's a gap in the evaluation.
 */
export const searchLogs = pgTable(
  "search_logs",
  {
    id: text("id").primaryKey(),
    evaluationId: text("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    criterionId: text("criterion_id").notNull(),
    searched: json<string[]>("searched").notNull().default(sql`'[]'::jsonb`),
    note: text("note").notNull().default(""),
    createdByStage: text("created_by_stage").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("search_logs_eval_idx").on(t.evaluationId, t.criterionId)],
);

export interface JudgeVote {
  optionId: string | null;
  status: string;
  rationale?: string;
  evidenceIds?: string[];
  model?: string;
  /** 1: the judge stage; later rounds re-judge after the code check or the skeptic found new evidence. */
  round?: number;
  /** The pass that re-judged it (absent for the judge stage and for older skeptic rounds). */
  pass?: "codecheck" | "skeptic";
}

/** Research's log of a genuine search that found nothing; `codeChecked` when the code check searched too. */
export interface SearchLog {
  searched: string[];
  note: string;
  codeChecked?: boolean;
}

export const criterionResults = pgTable(
  "criterion_results",
  {
    id: text("id").primaryKey(),
    evaluationId: text("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    criterionId: text("criterion_id").notNull(),
    status: text("status").notNull().default("unknown"),
    optionId: text("option_id"),
    rationale: text("rationale").notNull().default(""),
    confidence: text("confidence").notNull().default("low"),
    evidenceIds: json<string[]>("evidence_ids").notNull().default(sql`'[]'::jsonb`),
    /** The cited records whose quotes establish the answer; verifiability is read from these (R3-JDG-3). */
    decisiveEvidenceIds: json<string[]>("decisive_evidence_ids").notNull().default(sql`'[]'::jsonb`),
    flags: json<string[]>("flags").notNull().default(sql`'[]'::jsonb`),
    /** For an unknown answer: what research searched without finding anything that settles it (R3-JDG-13). */
    searchLog: json<SearchLog | null>("search_log"),
    /** Every judge vote, kept across skeptic re-judging (round 2) so the trail shows what changed. */
    votes: json<JudgeVote[]>("votes").notNull().default(sql`'[]'::jsonb`),
    /** A reviewer accepted the answer as is (flags cleared) and said why. */
    reviewNote: text("review_note"),
    /** The flags a reviewer accepted, and for which answer: they stay accepted while the answer is unchanged (R4-4). */
    acceptedFlags: json<{ flags: string[]; status: string; optionId: string | null } | null>("accepted_flags"),
    reviewedAt: text("reviewed_at"),
    /** The judge's option when its answer was downgraded for lack of a verified citation (review aid; never scored). */
    proposedOptionId: text("proposed_option_id"),
    /**
     * Why this answer differs from the previously published one: a protocol change in this version, new or better
     * evidence, or unexplained (likely evaluator variance, which needs review).
     */
    change: json<{
      kind: "protocol_change" | "evidence_change" | "rubric_change" | "unexplained";
      note: string;
      from: string | null;
      to: string | null;
      evidenceIds: string[];
    } | null>("change"),
    overrideStatus: text("override_status"),
    overrideOptionId: text("override_option_id"),
    overrideReason: text("override_reason"),
    overriddenAt: text("overridden_at"),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("criterion_results_eval_crit_idx").on(t.evaluationId, t.criterionId)],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: serial("id").primaryKey(),
    evaluationId: text("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    ts: text("ts").notNull().default(now),
    level: text("level").notNull().default("info"),
    stage: text("stage").notNull(),
    message: text("message").notNull(),
    data: json<Record<string, unknown>>("data"),
  },
  (t) => [index("run_events_eval_idx").on(t.evaluationId), index("run_events_run_idx").on(t.runId)],
);

export const releases = pgTable("releases", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  rubricVersion: text("rubric_version").notNull(),
  notesMd: text("notes_md").notNull().default(""),
  isDemo: boolean("is_demo").notNull().default(false),
  evalSettings: json<Record<string, unknown>>("eval_settings"),
  /** Every result in a release is scored with this one weighting. */
  weightingId: text("weighting_id").references(() => weightings.id),
  publishedAt: text("published_at").notNull().default(now),
});

export const publishedResults = pgTable(
  "published_results",
  {
    id: text("id").primaryKey(),
    releaseId: text("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    evaluationId: text("evaluation_id").references(() => evaluations.id, { onDelete: "set null" }),
    versionId: text("version_id").references(() => projectVersions.id, { onDelete: "set null" }),
    overall: doublePrecision("overall"),
    level: text("level"),
    trustTier: text("trust_tier"),
    walkaway: boolean("walkaway"),
    weightingId: text("weighting_id").references(() => weightings.id),
    active: boolean("active").notNull().default(true),
    snapshot: json<Record<string, unknown>>("snapshot").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    index("published_project_idx").on(t.projectId),
    index("published_release_idx").on(t.releaseId),
    index("published_active_project_idx").on(t.active, t.projectId),
    index("published_project_created_idx").on(t.projectId, t.createdAt),
    index("published_evaluation_idx").on(t.evaluationId),
    index("published_version_idx").on(t.versionId),
    index("published_weighting_idx").on(t.weightingId),
  ],
);

export const cards = pgTable("cards", {
  id: text("id").primaryKey(),
  config: json<Record<string, unknown>>("config").notNull(),
  createdAt: text("created_at").notNull().default(now),
});

export const corrections = pgTable("corrections", {
  id: text("id").primaryKey(),
  projectSlug: text("project_slug").notNull(),
  criterionId: text("criterion_id"),
  message: text("message").notNull(),
  evidenceUrl: text("evidence_url"),
  contact: text("contact"),
  status: text("status").notNull().default("open"),
  createdAt: text("created_at").notNull().default(now),
  /** The editor's public reason for the decision, shown in the corrections log (JDG-38). Never the visitor's text. */
  decisionNote: text("decision_note"),
  decidedAt: text("decided_at"),
  /** The release whose notes list this correction as applied. */
  releaseId: text("release_id"),
});

/**
 * Small key-value facts about the database itself, such as when it was imported from SQLite. Search chunks
 * (`source_chunks`) aren't modelled here: triggers maintain them and `kb.ts` queries them with SQL.
 */
export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: json<Record<string, unknown>>("value").notNull(),
  updatedAt: text("updated_at").notNull().default(now),
});

// ---------- community weighting ----------

/**
 * A weighting version: the suite and benchmark weights and every answer's points, frozen. The rubric's own is
 * created at boot (`rubric-<version>`); each closed poll adds one. Never edited or deleted once created: runs,
 * releases and published results link to it. Retired ones are no longer offered for new runs.
 */
export const weightings = pgTable(
  "weightings",
  {
    id: text("id").primaryKey(),
    /** W1, W2…: sequential per database. */
    number: integer("number").notNull(),
    title: text("title").notNull(),
    /** "rubric": the rubric's own numbers; "poll": a poll's result. */
    source: text("source").notNull(),
    rubricVersion: text("rubric_version").notNull(),
    /** A `Weighting` (packages/rubric/src/weighting.ts). */
    config: json<Record<string, unknown>>("config").notNull(),
    /** sha256 of the rubric version and the config (stable JSON), so a published result pins exact numbers. */
    hash: text("hash").notNull(),
    baseId: text("base_id"),
    pollId: text("poll_id"),
    notes: text("notes").notNull().default(""),
    retiredAt: text("retired_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("weightings_number_idx").on(t.number)],
);

/** A five-day public poll on a base weighting. One is open at a time. */
export const weightingPolls = pgTable(
  "weighting_polls",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    baseId: text("base_id")
      .notNull()
      .references(() => weightings.id),
    opensAt: text("opens_at").notNull(),
    closesAt: text("closes_at").notNull(),
    /** open, closed (finalized) or cancelled. */
    status: text("status").notNull().default("open"),
    /** Voting needs an X sign-in (one ballot per account); otherwise one per browser. */
    requireX: boolean("require_x").notNull().default(true),
    /** Fewer ballots than this at close and the poll changes nothing. */
    minBallots: integer("min_ballots").notNull().default(10),
    /** Random per poll: keys voter and network hashes, so they can't be linked across polls. Never published. */
    salt: text("salt").notNull(),
    /** The final count, set at close. */
    ballots: integer("ballots").notNull().default(0),
    /** adopted (a new weighting), no_quorum, or null while open or after a cancel. */
    outcome: text("outcome"),
    resultId: text("result_id").references(() => weightings.id),
    /** At close: ballots per day, the share that changed nothing, and how many changed each weight (no voter data). */
    stats: json<Record<string, unknown> | null>("stats"),
    closedAt: text("closed_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("weighting_polls_one_open").on(t.status).where(sql`status = 'open'`), index("weighting_polls_closes_idx").on(t.closesAt)],
);

/**
 * One voter's ballot in one poll (a `Ballot`, packages/rubric/src/weighting.ts). The voter is an HMAC of their X
 * account or browser id under the poll's salt; the network an HMAC of their /24 (IPv6 /48), erased at close.
 */
export const weightingBallots = pgTable(
  "weighting_ballots",
  {
    id: text("id").primaryKey(),
    pollId: text("poll_id")
      .notNull()
      .references(() => weightingPolls.id, { onDelete: "cascade" }),
    voterHash: text("voter_hash").notNull(),
    voterKind: text("voter_kind").notNull(),
    networkHash: text("network_hash"),
    ballot: json<Record<string, unknown>>("ballot").notNull(),
    /** How many weights the ballot changes (0: a vote for the current weights). */
    changes: integer("changes").notNull().default(0),
    /** Times it was changed after it was first cast; kept through a withdrawal, so withdrawing doesn't reset the cap. */
    revisions: integer("revisions").notNull().default(0),
    /** Withdrawn by the voter: not counted, but kept so their revisions and network slot stay used. */
    withdrawnAt: text("withdrawn_at"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("weighting_ballots_voter_idx").on(t.pollId, t.voterHash), index("weighting_ballots_network_idx").on(t.pollId, t.networkHash)],
);
