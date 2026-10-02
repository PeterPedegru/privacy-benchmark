import { Link } from "@tanstack/react-router";
import { FileCheck2 } from "lucide-react";
import { useState } from "react";
import { PageHeader, Status, Td, Th, useAdmin } from "@/components/admin/kit";
import { Chip } from "@/components/ui/badges";
import { Empty } from "@/components/ui/misc";
import { ProjectMark } from "@/components/ui/project-mark";
import { Segmented } from "@/components/ui/segmented";
import { fmtDate, fmtUsd } from "@/lib/utils";

type Ev = {
  id: string;
  projectName: string;
  projectSlug: string;
  logoUrl: string | null;
  versionLabel: string | null;
  status: string;
  mode: string;
  createdAt: string;
  costUsd: number;
  flagged: number;
  isDemo: boolean;
  reviewedSuites: string[];
};

export function AdminReviewList() {
  const [filter, setFilter] = useState<"review" | "all">("review");
  const q = useAdmin<Ev[]>(["evaluations", filter], filter === "review" ? "/api/admin/evaluations?status=review" : "/api/admin/evaluations");
  return (
    <>
      <PageHeader
        title="Review"
        subtitle="Resolve flags, override with reasons, then publish from Releases."
        actions={
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: "review", label: "Awaiting review" },
              { value: "all", label: "All evaluations" },
            ]}
          />
        }
      />
      {q.data && !q.data.length ? (
        <Empty title="Nothing to review" icon={<FileCheck2 className="size-6" />}>
          Finished runs land here.
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line">
          <table className="w-full min-w-[720px] border-collapse">
            <thead>
              <tr>
                <Th>Project</Th>
                <Th>Status</Th>
                <Th>Flags</Th>
                <Th>Reviewed suites</Th>
                <Th>Created</Th>
                <Th className="text-right">Cost</Th>
              </tr>
            </thead>
            <tbody>
              {q.data?.map((e) => (
                <tr key={e.id} className="hover:bg-bg-2">
                  <Td>
                    <Link to="/admin/review/$id" params={{ id: e.id }} className="flex items-center gap-2 font-medium hover:text-accent-fg">
                      <ProjectMark name={e.projectName} logoUrl={e.logoUrl} size={18} />
                      {e.projectName}
                      {e.versionLabel && <span className="font-normal text-muted">· {e.versionLabel}</span>}
                      {e.isDemo && <Chip>demo</Chip>}
                    </Link>
                  </Td>
                  <Td>
                    <Status status={e.status} />
                  </Td>
                  <Td>{e.flagged ? <Chip tone="fair">{e.flagged} flagged</Chip> : <Chip tone="strong">clear</Chip>}</Td>
                  <Td className="text-xs text-muted tabular">{e.reviewedSuites.length}/7</Td>
                  <Td className="text-xs text-muted">{fmtDate(e.createdAt)}</Td>
                  <Td className="text-right tabular">{fmtUsd(e.costUsd)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
