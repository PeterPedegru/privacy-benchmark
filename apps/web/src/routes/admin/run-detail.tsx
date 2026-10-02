import type { RunEvent } from "@pb/core";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Check, CircleX, RotateCcw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PageHeader, Panel, Status, useAdmin, useAdminAction } from "@/components/admin/kit";
import { Button } from "@/components/ui/button";
import { ProjectMark } from "@/components/ui/project-mark";
import { api } from "@/lib/api";
import { cn, fmtUsd } from "@/lib/utils";

type RunDetail = {
  run: { id: string; label: string; mode: string; status: string; costUsd: number; createdAt: string };
  evaluations: {
    id: string;
    projectName: string;
    projectSlug: string;
    logoUrl: string | null;
    versionLabel: string | null;
    status: string;
    stage: string;
    completedStages: string[];
    costUsd: number;
    error: string | null;
  }[];
  events: (RunEvent & { evaluationId: string })[];
};

const STAGES = ["ingest", "scout", "code", "research", "judge", "codecheck", "verify", "score"];
const STAGE_LABELS: Record<string, string> = { codecheck: "code check" };

const isActive = (d: RunDetail | undefined) =>
  !!d && (d.run.status === "queued" || d.run.status === "running" || d.evaluations.some((e) => e.status === "running" || e.status === "queued"));

export function AdminRunDetail() {
  const { id } = useParams({ from: "/admin/runs/$id" });
  // Live events come over SSE. The run payload (evaluations plus the last 400 events) is refetched when an
  // evaluation changes stage, with a slow poll as a fallback, and not at all once the run has finished.
  const q = useAdmin<RunDetail>(["run", id], `/api/admin/runs/${id}`, {
    refetchInterval: (query) => (isActive(query.state.data) ? 10_000 : false),
    refetchOnWindowFocus: true,
  });
  const [live, setLive] = useState<RunEvent[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const keys = [["run", id], ["runs"], ["overview"]];
  const cancel = useAdminAction(() => api(`/api/admin/runs/${id}/cancel`, { method: "POST" }), { success: "Cancelling…", invalidate: keys });
  const resume = useAdminAction((evaluationId: string) => api(`/api/admin/evaluations/${evaluationId}/resume`, { method: "POST" }), {
    success: "Resuming from where it stopped",
    invalidate: keys,
  });

  const active = isActive(q.data);
  useEffect(() => {
    if (!active) return;
    const es = new EventSource(`/api/admin/runs/${id}/events`);
    const stages = new Map<string, string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    es.addEventListener("event", (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as RunEvent;
      setLive((l) => [...l.slice(-600), ev]);
      // A new stage, a finished stage or a failure changes the stage chips, status and cost: refresh them
      // (at most every 2 s) instead of polling the whole run every few seconds.
      const changed = stages.get(ev.evaluationId) !== ev.stage || ev.level === "success" || ev.level === "error";
      stages.set(ev.evaluationId, ev.stage);
      if (changed && !timer)
        timer = setTimeout(() => {
          timer = undefined;
          void qc.invalidateQueries({ queryKey: ["admin", "run", id] });
        }, 2000);
    });
    return () => {
      es.close();
      clearTimeout(timer);
    };
  }, [id, active, qc]);

  const seen = new Set(live.map((e) => e.id));
  const events = [...(q.data?.events ?? []).filter((e) => !seen.has(e.id)), ...live].sort((a, b) => a.id - b.id);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [events.length]);

  const d = q.data;
  if (!d) return <div className="h-40 shimmer rounded-2xl" />;
  return (
    <>
      <div className="mb-2 text-[13px] text-muted">
        <Link to="/admin/runs" className="hover:text-fg">
          Runs
        </Link>{" "}
        / {d.run.label || d.run.id}
      </div>
      <PageHeader
        title={d.run.label || "Benchmark run"}
        subtitle={
          <span className="flex items-center gap-2">
            <Status status={d.run.status} /> <span className="capitalize">{d.run.mode}</span> · {fmtUsd(d.run.costUsd)} so far
          </span>
        }
        actions={
          active && (
            <Button variant="danger" icon={<Square className="size-3.5" />} onClick={() => cancel.mutate()}>
              Cancel run
            </Button>
          )
        }
      />
      <div className="grid gap-4">
        {d.evaluations.map((e) => (
          <Panel
            key={e.id}
            title={
              <span className="flex items-center gap-2">
                <ProjectMark name={e.projectName} logoUrl={e.logoUrl} size={18} /> {e.projectName}
                {e.versionLabel && <span className="font-normal text-muted">· {e.versionLabel}</span>}
              </span>
            }
            actions={
              <span className="flex items-center gap-2">
                <span className="text-xs text-muted tabular">{fmtUsd(e.costUsd)}</span>
                <Status status={e.status} />
                {["review", "reviewed", "published"].includes(e.status) && (
                  <Link to="/admin/review/$id" params={{ id: e.id }} className="text-sm text-accent-fg hover:underline">
                    Review →
                  </Link>
                )}
              </span>
            }
          >
            <div className="flex items-center gap-2 overflow-x-auto px-4 py-3">
              {STAGES.filter(
                // Evaluations that finished verify before the code check existed never ran it.
                (s) => s !== "codecheck" || e.completedStages.includes(s) || !e.completedStages.includes("verify"),
              ).map((s, i, shown) => {
                const done = e.completedStages.includes(s);
                const cur = e.stage === s && e.status === "running";
                return (
                  <div key={s} className="flex items-center gap-2">
                    <span
                      className={cn(
                        "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium capitalize",
                        done
                          ? "border-strong-bd bg-strong-bg text-strong-fg"
                          : cur
                            ? "border-accent-line bg-accent-soft text-accent-fg"
                            : e.status === "failed" && e.stage === s
                              ? "border-poor-bd bg-poor-bg text-poor-fg"
                              : "border-line text-muted",
                      )}
                    >
                      {done ? (
                        <Check className="size-3" strokeWidth={3} />
                      ) : cur ? (
                        <span className="pulse-dot size-1.5 rounded-full bg-accent" />
                      ) : e.status === "failed" && e.stage === s ? (
                        <CircleX className="size-3" />
                      ) : null}
                      {STAGE_LABELS[s] ?? s}
                    </span>
                    {i < shown.length - 1 && <span className="h-px w-4 bg-line" />}
                  </div>
                );
              })}
            </div>
            {e.error && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-poor-fg">
                <span className="min-w-0 break-words">{e.error}</span>
                {(e.status === "failed" || e.status === "cancelled") && (
                  <Button size="sm" icon={<RotateCcw className="size-3.5" />} disabled={resume.isPending} onClick={() => resume.mutate(e.id)}>
                    Resume
                  </Button>
                )}
              </div>
            )}
          </Panel>
        ))}
      </div>
      <Panel
        title="Live activity"
        className="mt-6"
        actions={
          active && (
            <span className="flex items-center gap-1.5 text-xs text-accent-fg">
              <span className="pulse-dot size-1.5 rounded-full bg-accent" /> streaming
            </span>
          )
        }
      >
        <div ref={logRef} className="max-h-[480px] overflow-y-auto px-4 py-3 font-mono text-[12px] leading-[1.7]">
          {events.length === 0 && <div className="text-muted">Waiting for events…</div>}
          {events.map((ev) => (
            <div
              key={ev.id}
              className={cn(
                "flex gap-3",
                ev.level === "error" ? "text-poor-fg" : ev.level === "warn" ? "text-fair-fg" : ev.level === "success" ? "text-strong-fg" : "text-fg-3",
              )}
            >
              <span className="shrink-0 text-faint">{new Date(ev.ts).toLocaleTimeString()}</span>
              <span className="w-28 shrink-0 truncate text-muted">{ev.stage}</span>
              <span className="min-w-0 break-words">{ev.message}</span>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
