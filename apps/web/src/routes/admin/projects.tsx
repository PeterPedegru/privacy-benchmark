import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GitBranch, Plus, RefreshCw } from "lucide-react";
import { PageHeader, Status, Td, Th, useAdmin, useAdminAction } from "@/components/admin/kit";
import { Button, ButtonLink } from "@/components/ui/button";
import { ProjectMark } from "@/components/ui/project-mark";
import { api } from "@/lib/api";
import { invalidateReleaseData } from "@/lib/queries";
import { cn, fmtPct, fmtUsd, timeAgo } from "@/lib/utils";

export type AdminProjectRow = {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  websiteUrl: string;
  category: string;
  status: string;
  githubRepos: string[];
  versions: { id: string; label: string; version: string; status: string; releasedAt: string | null }[];
  latestEvaluation: { id: string; status: string; createdAt: string; costUsd: number } | null;
  published: { id: string; overall: number | null; versionId: string | null }[];
  updates: number;
};

/**
 * Whether a project appears on the public site. Hidden projects ("archived") drop out of every public view and
 * download, published results included, until they're shown again; nothing is deleted.
 */
function VisibilitySwitch({ project }: { project: AdminProjectRow }) {
  const shown = project.status === "active";
  const qc = useQueryClient();
  const toggle = useAdminAction(
    async () => {
      const r = await api(`/api/admin/projects/${project.id}`, { method: "PATCH", json: { status: shown ? "archived" : "active" } });
      // This tab's public pages show the change at once; other visitors get it on their next load.
      void invalidateReleaseData(qc);
      return r;
    },
    {
      success: shown ? `${project.name} is hidden from the public site` : `${project.name} is shown on the public site`,
      invalidate: [["projects"], ["project"], ["overview"]],
    },
  );
  return (
    <button
      type="button"
      role="switch"
      aria-checked={shown}
      aria-label={`Show ${project.name} on the public site`}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate()}
      className="inline-flex items-center gap-2 text-sm disabled:opacity-50"
    >
      <span className={cn("relative h-5 w-9 rounded-full transition-colors", shown ? "bg-accent" : "bg-line-strong")}>
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow-1 transition-all", shown ? "left-[18px]" : "left-0.5")} />
      </span>
      <span className={shown ? "text-fg-2" : "text-muted"}>{shown ? "Shown" : "Hidden"}</span>
    </button>
  );
}

export function AdminProjects() {
  const q = useAdmin<AdminProjectRow[]>(["projects"], "/api/admin/projects");
  const checkAll = useAdminAction(
    () => api<{ newVersions: number; triaged: number; errors: string[]; costUsd: number }>("/api/admin/versions/check-all", { method: "POST" }),
    {
      success: (r) =>
        `${r.newVersions ? `${r.newVersions} new version(s) found` : "Up to date: no new releases"}${r.triaged ? ` · ${r.triaged} triaged by Sonnet 5.5` : ""} · ${fmtUsd(r.costUsd)}${r.errors.length ? ` · ${r.errors.length} error(s): ${r.errors[0]}` : ""}`,
      invalidate: [["projects"], ["updates"], ["version-checks"], ["overview"], ["project"]],
    },
  );
  return (
    <>
      <PageHeader
        title="Projects"
        subtitle={`${q.data?.length ?? 0} projects`}
        actions={
          <>
            <Button
              icon={<RefreshCw className={checkAll.isPending ? "size-4 animate-spin" : "size-4"} />}
              onClick={() => checkAll.mutate()}
              disabled={checkAll.isPending}
            >
              Check all for updates
            </Button>
            <ButtonLink to="/admin/projects/new" variant="primary" icon={<Plus className="size-4" />}>
              Add project
            </ButtonLink>
          </>
        }
      />
      <div className="overflow-x-auto rounded-2xl border border-line">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr>
              <Th>Project</Th>
              <Th>Latest version</Th>
              <Th>Repos</Th>
              <Th>Last evaluation</Th>
              <Th className="text-right">Published</Th>
              <Th>On site</Th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((p) => {
              const latest = p.versions.find((v) => v.status === "tracked");
              const pub = p.published[0];
              return (
                <tr key={p.id} className="hover:bg-bg-2">
                  <Td>
                    <Link to="/admin/projects/$id" params={{ id: p.id }} className="flex items-center gap-2.5 font-medium">
                      <ProjectMark name={p.name} logoUrl={p.logoUrl} size={20} />
                      {p.name}
                    </Link>
                  </Td>
                  <Td>
                    <span className="text-fg-2">{latest?.label ?? "—"}</span>
                    {p.updates > 0 && (
                      <Link
                        to="/admin/updates"
                        className="ml-2 inline-flex items-center gap-1 rounded-md bg-fair-bg px-1.5 text-[11px] font-semibold text-fair-fg"
                      >
                        <GitBranch className="size-3" /> {p.updates} new
                      </Link>
                    )}
                  </Td>
                  <Td className="text-xs text-muted">{p.githubRepos.length ? p.githubRepos.join(", ") : "manual"}</Td>
                  <Td>
                    {p.latestEvaluation ? (
                      <span className="flex items-center gap-2">
                        <Status status={p.latestEvaluation.status} /> <span className="text-xs text-muted">{timeAgo(p.latestEvaluation.createdAt)}</span>
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                  <Td className={cn("text-right font-semibold tabular", p.status !== "active" && "text-muted")}>{fmtPct(pub?.overall ?? null)}</Td>
                  <Td>
                    <VisibilitySwitch project={p} />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
