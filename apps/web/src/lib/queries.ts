import type { CompareResponse, LeaderboardResponse, ProjectSnapshot, ReleaseInfo, VersionInfo } from "@pb/core";
import type { Rubric } from "@pb/rubric";
import { keepPreviousData, type QueryClient, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "./api";

export interface Meta {
  rubricVersion: string;
  /** Changes whenever anything published or visible changes, a project being hidden included. */
  dataVersion: string;
  projects: number;
  release: (ReleaseInfo & { notes: string }) | null;
  isDemo: boolean;
}

export interface ProjectPage {
  snapshot: ProjectSnapshot;
  versions: (VersionInfo & { overall: number | null; level: string | null })[];
  history: { release: ReleaseInfo; version: VersionInfo | null; overall: number | null; level: string | null }[];
  changes: { criterionId: string; from: string | null; to: string | null }[];
  comparedTo: { version: VersionInfo | null; overall: number | null } | null;
}

const MINUTE = 60_000;
// Public data only changes when a release is published, so it stays fresh for 5 minutes. Meta is the cheap
// heartbeat (60 s): when it reports a different release, useReleaseSync() refetches everything below.
const RELEASE_DATA_STALE = 5 * MINUTE;

// Query options are shared by the hooks and the route loaders (router.tsx), which start these requests in
// parallel with the route's code chunk.
export const metaQuery = queryOptions({
  queryKey: ["meta"],
  queryFn: () => api<Meta>("/api/public/meta"),
  staleTime: MINUTE,
  refetchOnWindowFocus: true,
});
export const leaderboardQuery = queryOptions({
  queryKey: ["leaderboard"],
  queryFn: () => api<LeaderboardResponse>("/api/public/leaderboard"),
  staleTime: RELEASE_DATA_STALE,
});
export const compareQuery = (refs: string[]) =>
  queryOptions({
    queryKey: ["compare", refs.join(",")],
    // Table fields only: the cell breakdown loads the full project page for its evidence (EFF-29).
    queryFn: () => api<CompareResponse>(`/api/public/compare?fields=table&p=${encodeURIComponent(refs.join(","))}`),
    staleTime: RELEASE_DATA_STALE,
  });
export const projectQuery = (slug: string, version?: string) =>
  queryOptions({
    queryKey: ["project", slug, version ?? ""],
    queryFn: () => api<ProjectPage>(`/api/public/projects/${encodeURIComponent(slug)}${version ? `?version=${encodeURIComponent(version)}` : ""}`),
    staleTime: RELEASE_DATA_STALE,
  });
export const releasesQuery = queryOptions({
  queryKey: ["releases"],
  queryFn: () => api<(ReleaseInfo & { notes: string; projects: number })[]>("/api/public/releases"),
  staleTime: RELEASE_DATA_STALE,
});

export const useMeta = () => useQuery(metaQuery);
export const useLeaderboard = (opts: { enabled?: boolean } = {}) => useQuery({ ...leaderboardQuery, enabled: opts.enabled });
export const useProject = (slug: string, version?: string) => useQuery({ ...projectQuery(slug, version), placeholderData: keepPreviousData });
export const useCompare = (refs: string[]) => useQuery({ ...compareQuery(refs), enabled: refs.length > 0, placeholderData: keepPreviousData });
// The rubric and prompts only change with a deploy.
export const useRubric = () => useQuery({ queryKey: ["rubric"], queryFn: () => api<Rubric>("/api/public/rubric"), staleTime: Number.POSITIVE_INFINITY });
export const usePrompts = () =>
  useQuery({
    queryKey: ["prompts"],
    queryFn: () => api<{ hashes: Record<string, string>; prompts: Record<string, string> }>("/api/public/prompts"),
    staleTime: Number.POSITIVE_INFINITY,
  });
export const useReleases = () => useQuery(releasesQuery);

export interface CorrectionsLog {
  open: number;
  items: {
    id: string;
    projectSlug: string;
    projectName: string;
    criterionId: string | null;
    status: "accepted" | "rejected" | "done";
    note: string;
    submittedAt: string;
    decidedAt: string | null;
    release: { id: string; label: string } | null;
  }[];
}
// Decisions change outside releases, so this isn't keyed on the release like the published data.
export const useCorrectionsLog = () =>
  useQuery({ queryKey: ["corrections-log"], queryFn: () => api<CorrectionsLog>("/api/public/corrections"), staleTime: MINUTE });

/** The benchmark table's columns when none are picked: the top of the leaderboard, fewer on phones. */
/** The benchmark table's default columns: every project in the latest release, in leaderboard order. */
export function defaultRefs(lb: LeaderboardResponse | undefined): string[] {
  return (lb?.rows ?? []).map((r) => r.slug);
}

const RELEASE_KEYS = new Set(["leaderboard", "compare", "project", "releases"]);

/** Marks every release-derived public query stale; the ones on screen refetch now, the rest on next use. */
export function invalidateReleaseData(qc: QueryClient) {
  return qc.invalidateQueries({ predicate: (q) => RELEASE_KEYS.has(q.queryKey[0] as string) });
}

/**
 * Keys the 5-minute public caches on what's published without making every query wait for meta first: when meta
 * reports a different release, or a change to the visible set (an editor hiding or showing a project), the
 * release-derived data is refetched.
 */
export function useReleaseSync() {
  const qc = useQueryClient();
  const meta = useMeta();
  // undefined until meta loads; "" when nothing is published yet.
  const id = meta.data ? `${meta.data.release?.id ?? ""}:${meta.data.dataVersion ?? ""}` : undefined;
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (id === undefined) return;
    if (seen.current !== undefined && seen.current !== id) void invalidateReleaseData(qc);
    seen.current = id;
  }, [id, qc]);
}
