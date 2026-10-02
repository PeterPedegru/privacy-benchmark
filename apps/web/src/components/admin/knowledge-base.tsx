import { useQuery } from "@tanstack/react-query";
import { BookOpen, Code2, Database, FileDiff, Globe, Megaphone, Newspaper, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { m } from "motion/react";
import { Fragment, useDeferredValue, useState } from "react";
import { Input, Panel, Select, Status, useAdmin, useAdminAction } from "@/components/admin/kit";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn, hostOf, sourceLink, timeAgo } from "@/lib/utils";

export type KbSummary = {
  status: "empty" | "refreshing" | "ready" | "error";
  stats: Record<string, number>;
  refreshedAt: string | null;
  versionId: string | null;
  error: string | null;
  byKind: { kind: string; n: number; bytes: number }[];
  integrations: { github: boolean; exa: boolean; news: boolean; x: boolean };
  xHandle: string | null;
  xHandleSource: "admin" | "auto" | null;
  lanes: Record<string, { ok: boolean; count: number; refreshedAt: string; ms?: number; error?: string; ref?: string; note?: string }>;
  suggestions: {
    repos?: { repo: string; score: number; language: string | null; configured: boolean; archived: boolean; reasons: string[] }[];
    l2beatSlug?: string | null;
  };
  repos?: { repo: string; source: "configured" | "discovered"; score?: number; reasons?: string[] }[];
};

type Hit = { id: string; title: string; url: string; kind: string; sourceClass: string; snippet: string };

const SECTIONS = [
  { key: "docs", label: "Docs pages", icon: BookOpen, hint: "Crawled from the docs site" },
  { key: "code", label: "Code files", icon: Code2, hint: "Configured repos at the version's tag; the org's other active repos at their latest release" },
  { key: "changes", label: "Releases & diffs", icon: FileDiff, hint: "Release notes and version-to-version changes" },
  { key: "website", label: "Site pages", icon: Globe, hint: "Website and blog" },
  { key: "announcements", label: "X posts", icon: Megaphone, hint: "Grouped by quarter" },
  { key: "news", label: "News articles", icon: Newspaper, hint: "NewsAPI.ai" },
  { key: "analysis", label: "Analyses & audits", icon: ShieldCheck, hint: "Exa search" },
  { key: "data", label: "Data sources", icon: Database, hint: "L2BEAT, DefiLlama" },
] as const;

const INTEGRATIONS = [
  { key: "github", label: "GitHub token", env: "GITHUB_TOKEN" },
  { key: "exa", label: "Exa", env: "EXA_API_KEY" },
  { key: "news", label: "NewsAPI.ai", env: "NEWSAPI_AI_KEY" },
  { key: "x", label: "X", env: "X_BEARER_TOKEN" },
] as const;

export function KnowledgeBase({ projectId, versions }: { projectId: string; versions: { id: string; label: string; status: string; tag: string | null }[] }) {
  const kb = useAdmin<KbSummary>(["kb", projectId], `/api/admin/projects/${projectId}/kb`, {
    refetchInterval: (q) => ((q.state.data as KbSummary | undefined)?.status === "refreshing" ? 3000 : false),
  });
  const pinnable = versions.filter((v) => v.status === "tracked" && v.tag);
  const [versionId, setVersionId] = useState<string>(kb.data?.versionId ?? "");
  const refresh = useAdminAction(
    () => api<{ alreadyRunning?: boolean }>(`/api/admin/projects/${projectId}/kb/refresh`, { json: { versionId: versionId || null } }),
    {
      success: (r) => (r.alreadyRunning ? "A refresh is already running" : "Refresh started. This takes a few minutes."),
      invalidate: [
        ["kb", projectId],
        ["project", projectId],
      ],
    },
  );
  const k = kb.data;
  if (!k) return <div className="h-40 shimmer rounded-2xl" />;
  const refreshing = k.status === "refreshing";
  const pinned = versions.find((v) => v.id === k.versionId);
  return (
    <div className="flex flex-col gap-5">
      <Panel>
        <div className="flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              Knowledge base <Status status={k.status} />
            </div>
            <p className="mt-1 max-w-xl text-sm text-muted">
              Everything the evaluator reads before it judges: full docs, the open-source code at the pinned version, release notes and diffs, the project's own
              announcements, news and independent analyses. Agents search it first and quote it verbatim.
            </p>
            <div className="mt-2 text-xs text-muted">
              {k.refreshedAt ? (
                <>
                  Refreshed {timeAgo(k.refreshedAt)} · code at {pinned ? pinned.label : "the default branch"}
                  {k.stats.bytes ? ` · ${(k.stats.bytes / 1e6).toFixed(1)} MB of text` : ""}
                </>
              ) : (
                "Not built yet. Evaluations build it automatically, or build it now."
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Select value={versionId} onChange={(e) => setVersionId(e.target.value)} className="h-8 w-auto text-xs" aria-label="Code version">
              <option value="">Default branch</option>
              {pinnable.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="primary"
              disabled={refreshing || refresh.isPending}
              icon={<RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />}
              onClick={() => refresh.mutate()}
            >
              {refreshing ? "Refreshing…" : k.refreshedAt ? "Refresh" : "Build now"}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-line px-4 py-2.5 text-xs">
          {INTEGRATIONS.map((i) => (
            <span key={i.key} className="inline-flex items-center gap-1.5 text-muted" title={k.integrations[i.key] ? undefined : `Set ${i.env} to enable`}>
              <span className={cn("size-1.5 rounded-full", k.integrations[i.key] ? "bg-strong-fg" : "bg-faint")} />
              {i.label}
              {!k.integrations[i.key] && <code className="font-mono text-faint">{i.env}</code>}
            </span>
          ))}
          {k.integrations.x && (
            <span className="text-muted">
              {k.xHandle ? (
                <>
                  Announcements from{" "}
                  <a href={`https://x.com/${encodeURIComponent(k.xHandle)}`} target="_blank" rel="noreferrer noopener" className="text-fg-3 hover:text-fg">
                    @{k.xHandle}
                  </a>{" "}
                  ({k.xHandleSource === "admin" ? "set by an editor" : "auto-detected, verified against the profile"})
                </>
              ) : (
                "No verified X account yet. Set it in Settings if detection misses it."
              )}
            </span>
          )}
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {SECTIONS.map((s, i) => (
          <m.div
            key={s.key}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
            className="rounded-2xl border border-line bg-bg p-4"
          >
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <s.icon className="size-3.5" strokeWidth={1.75} /> {s.label}
            </div>
            <div className="mt-1 text-2xl font-semibold tracking-[-0.02em] tabular">{(k.stats[s.key] ?? 0).toLocaleString()}</div>
            <div className="mt-0.5 text-xs text-faint">{s.hint}</div>
          </m.div>
        ))}
      </div>

      {k.error && (
        <Panel title={k.status === "error" ? "Refresh failed" : "Partial errors in the last refresh"}>
          <pre className="max-h-48 overflow-auto px-4 py-3 font-mono text-xs whitespace-pre-wrap text-fg-3">{k.error}</pre>
        </Panel>
      )}

      {Object.keys(k.lanes ?? {}).length > 0 && <Lanes lanes={k.lanes} />}

      {!!k.repos?.length && <Repos repos={k.repos} />}

      {(k.suggestions?.repos?.some((r) => !r.configured && !r.archived && !k.repos?.some((m) => m.repo === r.repo)) || k.suggestions?.l2beatSlug) && (
        <Suggestions s={k.suggestions} monitored={new Set((k.repos ?? []).map((r) => r.repo))} />
      )}

      <KbSearch projectId={projectId} kinds={k.byKind.map((b) => b.kind)} />
    </div>
  );
}

function KbSearch({ projectId, kinds }: { projectId: string; kinds: string[] }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const dq = useDeferredValue(q.trim());
  const res = useQuery({
    queryKey: ["admin", "kb-search", projectId, dq, kind],
    queryFn: () => api<{ hits: Hit[] }>(`/api/admin/projects/${projectId}/kb/search?q=${encodeURIComponent(dq)}${kind ? `&kind=${kind}` : ""}`),
    enabled: dq.length > 1,
    placeholderData: (p) => p,
  });
  return (
    <Panel
      title="Search the knowledge base"
      actions={
        <Select value={kind} onChange={(e) => setKind(e.target.value)} className="h-8 w-auto text-xs" aria-label="Source kind">
          <option value="">All kinds</option>
          {kinds.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </Select>
      }
    >
      <div className="p-4">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="upgradeTo, timelock, viewing key, sequencer…" className="pl-9" />
        </div>
        <p className="mt-2 text-xs text-muted">The same full-text search the agents use, so you can see what they can find.</p>
      </div>
      {dq.length > 1 && (
        <div className="border-t border-line">
          {res.data?.hits.length === 0 && <div className="px-4 py-6 text-center text-sm text-muted">No matches.</div>}
          {res.data?.hits.map((h) => (
            <a
              key={h.id}
              // evm:// reads link to an explorer; anything that isn't http(s) renders as a non-link anchor.
              href={sourceLink(h.url) ?? undefined}
              target="_blank"
              rel="noreferrer noopener"
              className="block border-b border-line-weak px-4 py-3 last:border-0 hover:bg-bg-2"
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="truncate">{h.title || h.url}</span>
                <span className="shrink-0 rounded bg-surface px-1.5 text-[11px] font-normal text-muted">{h.kind}</span>
              </div>
              <div className="truncate text-xs text-faint">{hostOf(h.url)}</div>
              <div className="mt-1 line-clamp-3 text-xs text-fg-3">
                <Highlighted text={h.snippet} />
              </div>
            </a>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Renders FTS snippets, where matches are wrapped in « ». */
function Highlighted({ text }: { text: string }) {
  const parts = text.replace(/\s+/g, " ").split(/(«[^»]*»)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("«") ? (
          <mark key={i} className="rounded-sm bg-accent-soft px-0.5 text-accent-fg">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

function Lanes({ lanes }: { lanes: KbSummary["lanes"] }) {
  return (
    <Panel title="Lanes in the last refresh">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="text-xs text-muted">
              {["Lane", "Stored", "Read", "Time", "Status"].map((h) => (
                <th key={h} className="border-b border-line px-4 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(lanes).map(([name, l]) => (
              <tr key={name} className="align-top">
                <td className="border-b border-line-weak px-4 py-2 font-medium capitalize">{name}</td>
                <td className="border-b border-line-weak px-4 py-2 tabular">{l.count}</td>
                <td className="max-w-[260px] truncate border-b border-line-weak px-4 py-2 text-muted" title={l.ref ?? l.note}>
                  {l.ref ?? l.note ?? "—"}
                </td>
                <td className="border-b border-line-weak px-4 py-2 text-muted tabular">{l.ms ? `${(l.ms / 1000).toFixed(1)}s` : "—"}</td>
                <td className={cn("border-b border-line-weak px-4 py-2", l.ok ? "text-strong-fg" : "text-poor-fg")}>{l.ok ? "OK" : (l.error ?? "Failed")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Repos({ repos }: { repos: NonNullable<KbSummary["repos"]> }) {
  return (
    <Panel title="Repositories read">
      <ul className="flex flex-col gap-1 p-4 text-[13px]">
        {repos.map((r) => (
          <li key={r.repo}>
            <code className="font-mono">{r.repo}</code>
            <span className="text-muted">
              {" "}
              ·{" "}
              {r.source === "configured"
                ? "configured, at the version's tag"
                : `found in the org (${(r.reasons ?? []).slice(0, 3).join(", ")}), at its latest release`}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Suggestions({ s, monitored }: { s: KbSummary["suggestions"]; monitored: Set<string> }) {
  const repos = (s.repos ?? []).filter((r) => !r.configured && !r.archived && !monitored.has(r.repo)).slice(0, 6);
  return (
    <Panel title="Suggestions from the last refresh">
      <div className="flex flex-col gap-3 p-4 text-[13px]">
        {s.l2beatSlug && (
          <div>
            L2BEAT slug looks like <code className="font-mono">{s.l2beatSlug}</code>. Set it in Settings if the current one is wrong.
          </div>
        )}
        {repos.length > 0 && (
          <div>
            <div className="text-xs font-medium text-muted">
              Other repositories in the project's GitHub orgs, not read (add one in Settings to pin it to the version's tag)
            </div>
            <ul className="mt-1.5 flex flex-col gap-1">
              {repos.map((r) => (
                <li key={r.repo}>
                  <code className="font-mono">{r.repo}</code>
                  <span className="text-muted">
                    {" "}
                    · {r.language ?? "unknown language"} · {r.reasons.slice(0, 2).join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}
