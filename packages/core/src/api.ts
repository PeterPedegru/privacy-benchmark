import { z } from "zod";
import type { EvalSettings, LeaderboardRow, ProjectSnapshot, ReleaseInfo } from "./snapshot.ts";

export interface LeaderboardResponse {
  release: ReleaseInfo & { notes: string; settings: EvalSettings | null };
  rows: LeaderboardRow[];
}

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
