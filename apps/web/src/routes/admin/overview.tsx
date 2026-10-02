import { Link } from "@tanstack/react-router";
import { ArrowRight, GitBranch, Play, Plus, Rocket } from "lucide-react";
import { KeyBanner } from "@/components/admin/key-banner";
import { PageHeader, Panel, Stat, Status, useOverview } from "@/components/admin/kit";
import { ButtonLink } from "@/components/ui/button";
import { fmtDate, fmtUsd, timeAgo } from "@/lib/utils";

export function AdminOverview() {
  // Shares the layout's ["overview"] query; the layout does the polling.
  const q = useOverview();
  const d = q.data;
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={
          d?.lastRelease
            ? `Last release ${d.lastRelease.label}${d.lastRelease.isDemo ? " (demo)" : ""} · ${fmtDate(d.lastRelease.publishedAt)}`
            : "No releases yet"
        }
        actions={
          <>
            <ButtonLink to="/admin/projects/new" icon={<Plus className="size-4" />}>
              Add project
            </ButtonLink>
            <ButtonLink to="/admin/runs/new" variant="primary" icon={<Play className="size-4" />}>
              Run benchmark
            </ButtonLink>
          </>
        }
      />
      <KeyBanner context="Evaluations and update triage" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Projects" value={d?.projects ?? "—"} />
        <Stat
          label="Awaiting review"
          value={d?.awaitingReview ?? "—"}
          hint={
            <Link to="/admin/review" className="hover:text-fg">
              Open queue →
            </Link>
          }
        />
        <Stat
          label="Version updates"
          value={d?.updates ?? "—"}
          hint={
            <Link to="/admin/updates" className="hover:text-fg">
              Open inbox →
            </Link>
          }
        />
        <Stat label="Spend this month" value={d ? fmtUsd(d.spendThisMonth) : "—"} hint={`${d?.running ?? 0} evaluations running`} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Panel
          title="Recent runs"
          actions={
            <Link to="/admin/runs" className="text-xs text-muted hover:text-fg">
              All runs
            </Link>
          }
        >
          {d?.recentRuns.length ? (
            d.recentRuns.map((r) => (
              <Link
                key={r.id}
                to="/admin/runs/$id"
                params={{ id: r.id }}
                className="flex items-center gap-3 border-b border-line-weak px-4 py-3 text-sm last:border-0 hover:bg-bg-2"
              >
                <Status status={r.status} />
                <span className="flex-1 truncate">{r.label || `${r.mode} run`}</span>
                <span className="text-xs text-muted tabular">{fmtUsd(r.costUsd)}</span>
                <span className="text-xs text-muted">{timeAgo(r.createdAt)}</span>
              </Link>
            ))
          ) : (
            <div className="px-4 py-8 text-center text-sm text-muted">No runs yet.</div>
          )}
        </Panel>
        <Panel title="Workflow">
          <div className="flex flex-col">
            {[
              { icon: Plus, t: "Add a project by URL", d: "Intake fills in the name, logo, links and repos.", to: "/admin/projects/new" },
              { icon: GitBranch, t: "Track versions", d: "Sonnet 5.5 triages GitHub releases; pin a version.", to: "/admin/updates" },
              { icon: Play, t: "Run the benchmark", d: "Haiku gathers evidence; Opus 5.5 judges each criterion.", to: "/admin/runs/new" },
              { icon: Rocket, t: "Review & publish", d: "Resolve flags, then publish a release.", to: "/admin/review" },
            ].map((x) => (
              <Link key={x.t} to={x.to} className="group flex items-start gap-3 border-b border-line-weak px-4 py-3 last:border-0 hover:bg-bg-2">
                <x.icon className="mt-0.5 size-4 text-accent" strokeWidth={1.75} />
                <span className="flex-1">
                  <span className="block text-sm font-medium">{x.t}</span>
                  <span className="block text-xs text-muted">{x.d}</span>
                </span>
                <ArrowRight className="mt-1 size-3.5 text-faint group-hover:text-fg" />
              </Link>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
