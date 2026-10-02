import { Link } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { PageHeader, Status, Td, Th, useAdmin } from "@/components/admin/kit";
import { ButtonLink } from "@/components/ui/button";
import { Empty } from "@/components/ui/misc";
import { fmtDate, fmtUsd } from "@/lib/utils";

type Run = {
  id: string;
  label: string;
  mode: string;
  status: string;
  costUsd: number;
  createdAt: string;
  evaluations: { id: string; projectName: string; status: string; stage: string }[];
};

export function AdminRuns() {
  // Polls only while a run is queued or running.
  const q = useAdmin<Run[]>(["runs"], "/api/admin/runs", {
    refetchInterval: (query) => (query.state.data?.some((r) => r.status === "running" || r.status === "queued") ? 10_000 : false),
    refetchOnWindowFocus: true,
  });
  return (
    <>
      <PageHeader
        title="Runs"
        subtitle="Each run gathers evidence with Claude Haiku 4.5, judges with Claude Opus 5.5, and lands results in review."
        actions={
          <ButtonLink to="/admin/runs/new" variant="primary" icon={<Play className="size-4" />}>
            Run benchmark
          </ButtonLink>
        }
      />
      {q.data && !q.data.length ? (
        <Empty title="No runs yet">Start one to evaluate projects against the rubric.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line">
          <table className="w-full min-w-[720px] border-collapse">
            <thead>
              <tr>
                <Th>Run</Th>
                <Th>Projects</Th>
                <Th>Mode</Th>
                <Th>Status</Th>
                <Th className="text-right">Cost</Th>
              </tr>
            </thead>
            <tbody>
              {q.data?.map((r) => (
                <tr key={r.id} className="hover:bg-bg-2">
                  <Td>
                    <Link to="/admin/runs/$id" params={{ id: r.id }} className="font-medium hover:text-accent-fg">
                      {r.label || fmtDate(r.createdAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </Link>
                  </Td>
                  <Td className="text-sm text-fg-3">{r.evaluations.map((e) => e.projectName).join(", ")}</Td>
                  <Td className="capitalize">{r.mode}</Td>
                  <Td>
                    <Status status={r.status} />
                  </Td>
                  <Td className="text-right tabular">{fmtUsd(r.costUsd)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
