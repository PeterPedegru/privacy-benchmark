import { z } from "zod";
import type { EvalSettings, LeaderboardRow, ProjectSnapshot, ReleaseInfo, WeightingRef } from "./snapshot.ts";

/** A weighting the leaderboard's rows use, with its suite weights and how many rows use it (most used first). */
export interface LeaderboardWeighting extends WeightingRef {
  suites: Record<string, number>;
  projects: number;
}

export interface LeaderboardResponse {
  release: ReleaseInfo & { notes: string; settings: EvalSettings | null };
  rows: LeaderboardRow[];
  /** Absent from servers older than weightings. */
  weightings?: LeaderboardWeighting[];
}

// ---------- community weighting ----------

/** A weighting version as listed publicly. */
export interface WeightingSummary extends WeightingRef {
  rubricVersion: string;
  createdAt: string;
  baseId: string | null;
  /** Not offered for new runs any more; results scored with it stay linked. */
  retired: boolean;
  /** The weighting new runs use by default. */
  current: boolean;
  /** Active published results scored with it. */
  results: number;
  poll: { id: string; title: string; ballots: number; closedAt: string | null } | null;
}

/** A change between two weightings, in the voter's terms (% of group, % credit). */
export interface WeightingChange {
  key: string;
  kind: "suite" | "benchmark" | "criterion" | "credit";
  id: string;
  optionId?: string;
  label: string;
  context: string;
  from: number;
  to: number;
}

export interface WeightingDetail extends WeightingSummary {
  /** A Weighting (packages/rubric): suite and benchmark weights and every answer's points. */
  config: { suites: Record<string, number>; benchmarks: Record<string, number>; points: Record<string, Record<string, number>> };
  base: WeightingRef | null;
  changes: WeightingChange[];
  /** The poll that produced it: its turnout and how many ballots changed each weight. */
  pollStats: PollStats | null;
  releases: { id: string; label: string; publishedAt: string }[];
}

export interface PollStats {
  ballots: number;
  /** Ballots that changed nothing: votes for the base as it was. */
  unchanged: number;
  /** Parameter key → ballots that changed it. */
  changedBy: Record<string, number>;
  /** Day (YYYY-MM-DD) → ballots last saved that day. */
  perDay: Record<string, number>;
}

export interface PollInfo {
  id: string;
  title: string;
  description: string;
  opensAt: string;
  closesAt: string;
  status: "open" | "closed" | "cancelled";
  requireX: boolean;
  minBallots: number;
  ballots: number;
  outcome: "adopted" | "no_quorum" | null;
  base: WeightingRef;
  result: WeightingRef | null;
}

/** GET /api/public/poll: the open poll (or the last closed one), and where this visitor stands. */
export interface PollResponse {
  poll: (PollInfo & { baseConfig: WeightingDetail["config"] }) | null;
  /** The most recent poll that closed, when one is open or none is. */
  lastClosed: PollInfo | null;
  voter: {
    /** Signed in with X (or, for a browser-mode poll, has a voter cookie). */
    signedIn: boolean;
    kind: "x" | "browser" | null;
    /** This visitor's ballot in the open poll. */
    ballot: BallotInput | null;
    votedAt: string | null;
    revisionsLeft: number;
  };
  /** Whether X sign-in is available on this server. */
  xEnabled: boolean;
}

/** A ballot as sent: relative importances (0–100) per touched group, credits (0–100) per in-between answer. */
export type BallotInput = z.infer<typeof ballotSchema>;
const weights = z.record(z.string().max(120), z.number().min(0).max(100));
/** Bounded so a ballot can't be large: the rubric has ~110 criteria and ~130 in-between answers. */
export const ballotSchema = z
  .object({
    suites: weights.optional(),
    benchmarks: weights.optional(),
    criteria: weights.optional(),
    credits: z.record(z.string().max(120), z.record(z.string().max(64), z.number().min(0).max(100))).optional(),
  })
  .strict()
  .refine(
    (b) =>
      Object.keys(b.suites ?? {}).length <= 20 &&
      Object.keys(b.benchmarks ?? {}).length <= 80 &&
      Object.keys(b.criteria ?? {}).length <= 250 &&
      Object.keys(b.credits ?? {}).length <= 250 &&
      Object.values(b.credits ?? {}).every((o) => Object.keys(o).length <= 12),
    { message: "Ballot too large" },
  );

export interface ProjectResponse {
  snapshot: ProjectSnapshot;
  history: { release: ReleaseInfo; overall: number | null; level: string | null }[];
  changes: { criterionId: string; from: string | null; to: string | null }[];
}

export interface CompareResponse {
  release: ReleaseInfo;
  snapshots: ProjectSnapshot[];
}

export const cardConfigSchema = z.object({
  template: z.enum(["table", "headtohead", "spotlight"]).default("table"),
  /** Project refs: `slug` or `slug@version`. */
  projects: z.array(z.string().min(1).max(96)).min(1).max(5),
  focus: z.string().max(96).nullable().optional(),
  rowSet: z.enum(["suites", "key", "all", "custom"]).default("suites"),
  rows: z.array(z.string().max(80)).max(40).optional(),
  size: z.enum(["auto", "landscape", "portrait", "square"]).default("auto"),
  theme: z.enum(["light", "dark"]).default("light"),
  accent: z.enum(["classic", "iris"]).default("classic"),
});
export type CardConfig = z.infer<typeof cardConfigSchema>;

/**
 * An absolute http(s) URL. `z.string().url()` also accepts `javascript:` and `data:` URLs, which must never reach
 * an href or a fetch.
 */
export const httpUrlSchema = z.url({ protocol: /^https?$/, error: "Must be an http(s) URL" }).max(2048);

export const intakeRequestSchema = z.object({ url: httpUrlSchema });

export const projectInputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().min(1).max(120),
  websiteUrl: httpUrlSchema,
  logoUrl: httpUrlSchema.nullable().optional(),
  tagline: z.string().max(200).default(""),
  description: z.string().max(2000).default(""),
  category: z.enum(["l1", "l2", "privacy_pool", "privacy_app", "coprocessor", "appchain", "wallet", "other"]).default("other"),
  mechanism: z.enum(["pool", "shielded_ledger", "stealth_address", "confidential_amounts", "private_execution", "none"]).default("none"),
  attributes: z.array(z.string().max(32)).max(20).default([]),
  chains: z.array(z.string().max(64)).max(20).default([]),
  l2beatSlug: z.string().max(64).nullable().optional(),
  defillamaSlug: z.string().max(64).nullable().optional(),
});
export type ProjectInput = z.infer<typeof projectInputSchema>;

export const runRequestSchema = z.object({
  projectIds: z.array(z.string()).min(1).max(50),
  mode: z.enum(["quick", "standard", "deep"]).default("standard"),
  suites: z.array(z.string()).optional(),
  label: z.string().max(120).optional(),
  /** The weighting to score with; the current one when omitted. */
  weightingId: z.string().max(64).optional(),
});

export const overrideSchema = z.object({
  optionId: z.string().nullable(),
  status: z.enum(["answered", "unknown", "not_applicable"]).default("answered"),
  reason: z.string().min(3).max(1000),
});

export const releaseRequestSchema = z.object({
  evaluationIds: z.array(z.string()).min(1),
  label: z.string().min(1).max(40),
  notes: z.string().max(10000).default(""),
});

export type RunEvent = {
  id: number;
  evaluationId: string;
  ts: string;
  level: "info" | "warn" | "error" | "success";
  stage: string;
  message: string;
  data?: Record<string, unknown>;
};
