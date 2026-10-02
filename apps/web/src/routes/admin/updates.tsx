import { suites } from "@pb/rubric";
import { Link, useNavigate } from "@tanstack/react-router";
import { ExternalLink, GitBranch, RefreshCw } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useState } from "react";
import { KeyBanner } from "@/components/admin/key-banner";
import { PageHeader, Status, useAdmin, useAdminAction } from "@/components/admin/kit";
import { Chip } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { api } from "@/lib/api";
import { fmtDate, fmtUsd, safeHref } from "@/lib/utils";

type Update = {
  id: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  label: string;
  version: string;
  releasedAt: string | null;
  source: string;
  sourceUrl: string | null;
  repo: string | null;
  tag: string | null;
  isMajor: boolean;
  isPrerelease: boolean;
  status: string;
  summary: string;
  privacyRelevant: boolean;
  affectedSuites: string[];
  relevanceNote: string;
};

function checkSummary(r: { newVersions: number; triaged?: number; errors: string[]; costUsd: number }) {
  const head = `${r.newVersions ? `${r.newVersions} new version(s) found` : "Up to date: no new releases"}${r.triaged ? ` · ${r.triaged} triaged by Sonnet 5.5` : ""}`;
  return `${head} · ${fmtUsd(r.costUsd)}${r.errors.length ? ` · ${r.errors.length} error(s): ${r.errors[0]}` : ""}`;
}

export function AdminUpdates() {
  const [all, setAll] = useState(false);
  const q = useAdmin<Update[]>(["updates", all], all ? "/api/admin/updates?all=1" : "/api/admin/updates");
  const nav = useNavigate();
  const set = useAdminAction(({ id, status }: { id: string; status: string }) => api(`/api/admin/versions/${id}`, { method: "PATCH", json: { status } }), {
    invalidate: [["updates"], ["overview"], ["projects"], ["project"]],
  });
  const checkAll = useAdminAction(
    () => api<{ newVersions: number; triaged: number; errors: string[]; costUsd: number }>("/api/admin/versions/check-all", { method: "POST" }),
    {
      success: (r) => checkSummary(r),
      invalidate: [["updates"], ["version-checks"], ["overview"], ["projects"], ["project"]],
    },
  );
  const items = q.data ?? [];
  const checks = useAdmin<{ ranAt: string; projectName: string | null; error: string | null }[]>(["version-checks"], "/api/admin/version-checks");
  const latestRun = checks.data?.[0]?.ranAt.slice(0, 16);
  const latestErrors = (checks.data ?? []).filter((c) => c.ranAt.slice(0, 16) === latestRun && c.error);
  return (
    <>
      <PageHeader
        title="Version updates"
        subtitle="New releases detected on GitHub, triaged by Claude Sonnet 5.5. Track the ones worth benchmarking; evaluations are pinned to a tracked version."
        actions={
          <>
            <Segmented
              value={all ? "all" : "inbox"}
              onChange={(v) => setAll(v === "all")}
              options={[
                { value: "inbox", label: "Needs a decision" },
                { value: "all", label: "All releases" },
              ]}
            />
            <Button
              icon={<RefreshCw className={checkAll.isPending ? "size-4 animate-spin" : "size-4"} />}
              onClick={() => checkAll.mutate()}
              disabled={checkAll.isPending}
            >
              Check all now
            </Button>
          </>
        }
      />
      <KeyBanner context="Release summaries" />
      {latestErrors.length > 0 && (
        <div className="mb-6 rounded-xl border border-fair-bd bg-fair-bg px-4 py-3 text-sm text-fair-fg">
          <div className="font-semibold">The last check hit errors</div>
          <ul className="mt-1 list-disc pl-5">
            {latestErrors.map((c, i) => (
              <li key={i} className="break-words">
                {c.projectName}: {(c.error ?? "").split("\n")[0]?.slice(0, 300)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!items.length && !q.isLoading && (
        <Empty title="Inbox zero" icon={<GitBranch className="size-6" />}>
          New releases on watched repos appear here. Add repos on a project's Settings tab, or add versions manually from announcements.
        </Empty>
      )}
      <div className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {items.map((u) => (
            <m.div
              key={u.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 24 }}
              className="rounded-2xl border border-line bg-bg p-4"
            >
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to="/admin/projects/$id" params={{ id: u.projectId }} className="font-semibold hover:text-accent-fg">
                      {u.projectName}
                    </Link>
                    <span className="text-muted">·</span>
                    <span className="font-medium">{u.label}</span>
                    <span className="text-xs text-muted">
                      {u.repo ? `${u.repo}@${u.tag}` : "manual"} · {fmtDate(u.releasedAt)}
                    </span>
                    {safeHref(u.sourceUrl) && (
                      <a href={safeHref(u.sourceUrl)!} target="_blank" rel="noreferrer noopener" className="text-muted hover:text-fg">
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {u.isMajor ? <Chip tone="accent">Major</Chip> : <Chip>Minor</Chip>}
                    {u.isPrerelease && <Chip>Pre-release</Chip>}
                    {u.privacyRelevant ? <Chip tone="fair">Privacy-relevant</Chip> : u.summary ? <Chip>Not privacy-relevant</Chip> : <Chip>Not triaged</Chip>}
                    {u.affectedSuites.map((s) => (
                      <Chip key={s}>{suites.find((x) => x.id === s)?.shortName ?? s}</Chip>
                    ))}
                  </div>
                  {u.summary ? (
                    <p className="mt-2 max-w-3xl text-sm text-fg-2">{u.summary}</p>
                  ) : (
                    <p className="mt-2 text-sm text-muted">
                      Not triaged yet. Sonnet 5.5 summarizes it on the next successful check; see the check status above if this persists.
                    </p>
                  )}
                  {u.relevanceNote && <p className="mt-1 text-xs text-muted">{u.relevanceNote}</p>}
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Status status={u.status} />
                </div>
              </div>
              <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-line-weak pt-3">
                <Button size="sm" variant="ghost" onClick={() => set.mutate({ id: u.id, status: "ignored" })}>
                  Ignore
                </Button>
                <Button size="sm" onClick={() => set.mutate({ id: u.id, status: "tracked" })}>
                  Track
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() =>
                    set.mutate(
                      { id: u.id, status: "tracked" },
                      { onSuccess: () => nav({ to: "/admin/runs/new", search: { project: u.projectId, version: u.id } as never }) },
                    )
                  }
                >
                  Track & evaluate
                </Button>
              </div>
            </m.div>
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}
