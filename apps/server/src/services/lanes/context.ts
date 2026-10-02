/**
 * What every knowledge-base lane gets: the database, the project and pinned version, the run id stamped on every
 * row, the ownership registry used for classification, a shared GitHub memo, and a per-run scratch space lanes use
 * to hand data to later lanes (for example L2BEAT's discovered contracts to the address registry).
 */
import { ne } from "drizzle-orm";
import { type DB, schema } from "../../db/index.ts";
import { abortableSleep } from "../../lib/fetcher.ts";
import { GithubMemo } from "../../lib/github.ts";
import { newId } from "../../lib/ids.ts";
import {
  buildInterestedParties,
  classifyUrl,
  createRegistry,
  type InterestedParties,
  type Lane,
  mergeRegistries,
  type OwnershipRegistry,
} from "../classify.ts";
import { type KbSourceInput, type Section, type StoreStatus, storeKbSourceEx } from "../kb-store.ts";

export type ProjectRow = typeof schema.projects.$inferSelect;
export type VersionRow = typeof schema.projectVersions.$inferSelect;
export type Progress = (message: string) => void;

export interface LaneStatus {
  ok: boolean;
  count: number;
  refreshedAt: string;
  ms?: number;
  error?: string;
  /** Code ref, docs roots, handle... whatever identifies what the lane read. */
  ref?: string;
  note?: string;
  /** Last full (non-incremental) run, for lanes that fetch incrementally. */
  fullAt?: string;
  /** More than a tenth of the lane's pages failed to fetch, or it stopped at its deadline; it didn't prune (R3-SRC-5). */
  partial?: boolean;
}

export interface RepoSuggestion {
  repo: string;
  score: number;
  language: string | null;
  pushedAt: string | null;
  archived: boolean;
  configured: boolean;
  reasons: string[];
  fork?: boolean;
  empty?: boolean;
  deprecated?: boolean;
  description?: string | null;
}

/** A repository the code lanes read: configured by an editor, or discovered in the project's GitHub orgs. */
export interface MonitoredRepo {
  repo: string;
  source: "configured" | "discovered";
  score?: number;
  reasons?: string[];
}

export interface KbMeta {
  runId?: string;
  refreshedAt?: string;
  registry?: OwnershipRegistry;
  lanes?: Record<string, LaneStatus>;
  suggestions?: { repos?: RepoSuggestion[]; l2beatSlug?: string | null };
  /** The repositories the last build read. */
  repos?: MonitoredRepo[];
  x?: { handle: string; userId?: string; verifiedAt: string; reason?: string; urls?: string[] };
  docsRoots?: { url: string; prefix: string }[];
  forums?: string[];
}

export interface DiscoveredContract {
  chainId: number | null;
  chain: string;
  address: string;
  name: string | null;
  proxyType: string | null;
  implementation: string | null;
  admin: string | null;
  owner: string | null;
  safe: { threshold: number | null; members: number } | null;
  critical: boolean;
  description: string | null;
}

export interface RunShared {
  discovered: DiscoveredContract[];
  defillama: { id: string | null; parentId: string | null; auditLinks: string[] } | null;
  /** Refs actually snapshotted per repo, so the audits lane reads the same tree. */
  repoRefs: Map<string, string>;
  /** Every repository this build reads (configured first), for the lanes that look inside repos. */
  repos: string[];
}

export interface LaneContext {
  db: DB;
  project: ProjectRow;
  version: VersionRow | null;
  runId: string;
  registry: OwnershipRegistry;
  /** Other benchmarked projects and known competitors (their pages about this project are marketing). */
  interested: InterestedParties | null;
  gh: GithubMemo;
  log: Progress;
  meta: KbMeta;
  shared: RunShared;
}

/** A context for calling one lane on its own (tests, scripts): registry from configuration only. */
export async function standaloneContext(db: DB, project: ProjectRow, opts: { version?: VersionRow | null; log?: Progress } = {}): Promise<LaneContext> {
  const meta = (project.kbMeta ?? {}) as KbMeta;
  const registry = meta.registry ?? registryFromProject(project);
  return {
    db,
    project,
    version: opts.version ?? null,
    runId: newId(),
    registry,
    interested: await interestedPartiesFor(db, project.id, registry),
    gh: new GithubMemo(),
    log: opts.log ?? (() => {}),
    meta,
    shared: { discovered: [], defillama: null, repoRefs: new Map(), repos: [...project.githubRepos] },
  };
}

/** The ownership registry from project configuration alone (no network). */
export function registryFromProject(project: ProjectRow): OwnershipRegistry {
  return createRegistry({
    name: project.name,
    slug: project.slug,
    websiteUrl: project.websiteUrl,
    docsUrl: project.docsUrl,
    docsRoots: project.docsRoots ?? [],
    githubRepos: project.githubRepos,
    extraDomains: project.extraDomains ?? [],
    newsAliases: project.newsAliases ?? [],
    xHandles: project.xHandle ? [project.xHandle] : [],
  });
}

/** The registry of a project row: the one persisted by the last refresh merged with current configuration. */
export function registryOf(p: ProjectRow): OwnershipRegistry {
  const fromConfig = registryFromProject(p);
  const persisted = ((p.kbMeta ?? {}) as KbMeta).registry;
  return persisted ? mergeRegistries(persisted, fromConfig) : fromConfig;
}

/** Other benchmarked projects' domains, GitHub owners and blog paths, plus the competitor list, minus what this project owns (R3-JDG-6). */
export async function interestedPartiesFor(db: DB, projectId: string, own: OwnershipRegistry): Promise<InterestedParties> {
  const others = await db.select().from(schema.projects).where(ne(schema.projects.id, projectId));
  return buildInterestedParties(
    own,
    others.map((o) => registryOf(o)),
  );
}

/** Stores a source for a lane: stamps `meta.lane` and `meta.runId`. */
export async function storeFor(
  ctx: LaneContext,
  lane: string,
  section: Section,
  s: Omit<KbSourceInput, "meta"> & { meta?: Record<string, unknown> },
): Promise<{ id: string; status: StoreStatus }> {
  return storeKbSourceEx(ctx.db, ctx.project.id, { ...s, meta: { ...(s.meta ?? {}), section, lane, runId: ctx.runId } });
}

/** True when a store call added or refreshed a row (not a duplicate or a URL owned by a stronger lane). */
export const counted = (status: StoreStatus) => status === "inserted" || status === "updated" || status === "touched";

/** Classify a URL with the run's registry. */
export function classify(ctx: LaneContext, url: string, lane: Lane, extra: Omit<Parameters<typeof classifyUrl>[2], "registry" | "interested"> = {}) {
  return classifyUrl(url, lane, { registry: ctx.registry, interested: ctx.interested, ...extra });
}

/** A pause between fetches; ends early, rejecting, when the refresh is stopped (R4-17). */
export const sleep = (ms: number) => abortableSleep(ms);

/** Runs `fn` over items with bounded concurrency. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!, idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
