import type { WeightingRef } from "@pb/core";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Rocket, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Field, Input, PageHeader, Panel, Status, Textarea, useAdmin, useAdminAction } from "@/components/admin/kit";
import { Chip } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { ProjectMark } from "@/components/ui/project-mark";
import { ApiError, api } from "@/lib/api";
import { invalidateReleaseData } from "@/lib/queries";
import { cn, fmtDate, fmtPct } from "@/lib/utils";

type Ev = {
  id: string;
  projectId: string;
  projectName: string;
  logoUrl: string | null;
  versionLabel: string | null;
  status: string;
  flagged: number;
  isDemo: boolean;
  /** Whether the summary can be published as it is; an override after it was written makes it stale. */
  summary: "current" | "stale" | "missing" | null;
  /** The weighting its scores are computed with; a release takes one. */
  weighting: WeightingRef;
};

/**
 * Summaries are written on the editor's machine through Claude Code (the server would need the API): the command
 * for the picked evaluations, flagging the ones publishing would refuse.
 */
function SummaryCommand({ picked }: { picked: Ev[] }) {
  const blocking = picked.filter((e) => e.summary === "stale" || e.summary === "missing");
  const command = `railway run --service bench-cli -- pnpm bench summarize ${picked.map((e) => e.id).join(" ")}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success("Command copied");
    } catch {
      toast.error("Couldn't copy; select the command instead.");
    }
  };
  return (
    <div className={cn("rounded-xl border p-3 text-[13px]", blocking.length ? "border-fair-bd bg-fair-bg" : "border-line bg-bg-2")}>
      <div className="font-medium">
        {blocking.length
          ? `${blocking.length} of ${picked.length} summaries must be regenerated before publishing: ${blocking.map((e) => e.projectName).join(", ")}.`
          : "Regenerate the summaries of everything selected"}
      </div>
      <div className="mt-0.5 text-muted">
        Runs on your machine through Claude Code, from the current answers with overrides included. This page updates when you come back to it.
      </div>
      <div className="mt-2 flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg border border-line bg-bg px-2 py-1.5 font-mono text-[11px] select-all">{command}</code>
        <Button size="sm" icon={<Copy className="size-3.5" />} onClick={copy}>
          Copy
        </Button>
      </div>
    </div>
  );
}
type Release = {
  id: string;
  label: string;
  publishedAt: string;
  isDemo: boolean;
  notesMd: string;
  weighting: WeightingRef | null;
  results: { projectId: string; name: string; overall: number | null; active: boolean; versionId: string | null }[];
};

export function AdminReleases() {
  // Refetched on focus: summaries regenerated in the terminal show up when the editor comes back.
  const evs = useAdmin<Ev[]>(["evaluations", "all"], "/api/admin/evaluations", { refetchOnWindowFocus: true });
  const rels = useAdmin<Release[]>(["releases"], "/api/admin/releases");
  const ready = (evs.data ?? []).filter((e) => ["review", "reviewed"].includes(e.status) && !e.isDemo);
  const [picked, setPicked] = useState<string[]>([]);
  // A release is scored with one weighting: once one evaluation is picked, the others must share its weighting.
  const releaseWeighting = ready.find((e) => picked.includes(e.id))?.weighting ?? null;
  const [label, setLabel] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [notes, setNotes] = useState("");
  // Publishing past unresolved review flags needs a written justification, which goes into the public notes.
  const [forceReason, setForceReason] = useState<string | null>(null);
  // Publishing changes the public site too: mark its cached data stale so the next public page refetches.
  const qc = useQueryClient();
  const publicChanged = () => {
    void qc.invalidateQueries({ queryKey: ["meta"] });
    void invalidateReleaseData(qc);
  };
  const keys = [["releases"], ["evaluations"], ["overview"], ["projects"], ["project"]];
  const publish = useAdminAction(
    async (force: boolean) => {
      const r = await api<{ id: string }>(`/api/admin/releases${force ? "?force=1" : ""}`, {
        json: { evaluationIds: picked, label, notes, forceReason: forceReason ?? "" },
      });
      publicChanged();
      return r;
    },
    { success: "Release published", invalidate: keys },
  );
  const unpublish = useAdminAction(
    async ({ projectId, versionId }: { projectId: string; versionId: string | null }) => {
      const r = await api(`/api/admin/projects/${projectId}/unpublish`, { json: { versionId } });
      publicChanged();
      return r;
    },
    { success: "Rolled back", invalidate: keys },
  );
  const go = (force = false) =>
    publish.mutate(force, {
      onSuccess: () => {
        setPicked([]);
        setForceReason(null);
      },
      onError: (e) => {
        if (e instanceof ApiError && (e.code === "unresolved_flags" || e.code === "quick_mode")) {
          toast.warning(`${e.message} To publish anyway, write why below; it's published with the release.`);
          setForceReason("");
        }
      },
    });
  return (
    <>
      <PageHeader
        title="Releases"
        subtitle="Publishing freezes reviewed evaluations into an immutable snapshot. The public site switches from demo data as soon as a real release exists."
      />
      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <Panel title="Ready to publish">
          {ready.length ? (
            ready.map((e) => {
              const on = picked.includes(e.id);
              const otherWeighting = !on && !!releaseWeighting && releaseWeighting.id !== e.weighting.id;
              return (
                <button
                  type="button"
                  key={e.id}
                  disabled={otherWeighting}
                  title={
                    otherWeighting
                      ? `Scored with ${e.weighting.label}; this release uses ${releaseWeighting?.label}. Re-score it in review, or publish it separately.`
                      : undefined
                  }
                  onClick={() => setPicked(on ? picked.filter((x) => x !== e.id) : [...picked, e.id])}
                  className={cn(
                    "flex w-full items-center gap-3 border-b border-line-weak px-4 py-2.5 text-left last:border-0 disabled:opacity-45",
                    on && "bg-accent-soft/40",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-[18px] items-center justify-center rounded-[5px] border",
                      on ? "border-accent bg-accent text-white" : "border-line-strong",
                    )}
                  >
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  <ProjectMark name={e.projectName} logoUrl={e.logoUrl} size={18} />
                  <span className="flex-1 text-sm font-medium">
                    {e.projectName} {e.versionLabel && <span className="font-normal text-muted">· {e.versionLabel}</span>}
                  </span>
                  <Chip title={e.weighting.title}>{e.weighting.label}</Chip>
                  {e.summary === "stale" && <Chip tone="fair">summary stale</Chip>}
                  {e.summary === "missing" && <Chip tone="poor">no summary</Chip>}
                  {e.flagged ? <Chip tone="fair">{e.flagged} flags</Chip> : <Chip tone="strong">clear</Chip>}
                  <Status status={e.status} />
                </button>
              );
            })
          ) : (
            <div className="px-4 py-10 text-center text-sm text-muted">No reviewed evaluations yet. Run the benchmark, then review.</div>
          )}
        </Panel>
        <Panel title="New release">
          <div className="flex flex-col gap-4 p-4">
            <Field label="Label">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <Field label="Release notes (markdown, public)">
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="What changed, notable corrections, golden-set accuracy…"
                className="min-h-32"
              />
            </Field>
            {picked.length > 0 && <SummaryCommand picked={ready.filter((e) => picked.includes(e.id))} />}
            {forceReason !== null && (
              <Field label="Why publish past the review gates? (public)" hint="At least a sentence. It's appended to the release notes.">
                <Textarea value={forceReason} onChange={(e) => setForceReason(e.target.value)} className="min-h-20" />
              </Field>
            )}
            {forceReason !== null && (
              <Button variant="danger" disabled={forceReason.trim().length < 10 || publish.isPending} onClick={() => go(true)}>
                Publish anyway
              </Button>
            )}
            {releaseWeighting && (
              <div className="text-xs text-muted">
                Scored with weighting {releaseWeighting.label} ({releaseWeighting.title}). Every result in this release names it.
              </div>
            )}
            <Button variant="primary" disabled={!picked.length || !label || publish.isPending} icon={<Rocket className="size-4" />} onClick={() => go(false)}>
              Publish {picked.length || ""} evaluation{picked.length === 1 ? "" : "s"}
            </Button>
          </div>
        </Panel>
      </div>
      <h2 className="mt-10 mb-3 text-lg font-semibold">History</h2>
      <div className="flex flex-col gap-3">
        {rels.data?.map((r) => (
          <Panel
            key={r.id}
            title={
              <span className="flex items-center gap-2">
                {r.label} {r.isDemo && <Chip tone="fair">demo</Chip>}
                {r.weighting && <Chip title={r.weighting.title}>{r.weighting.label}</Chip>}
                <span className="font-normal text-muted">· {fmtDate(r.publishedAt)}</span>
              </span>
            }
          >
            <div className="flex flex-col">
              {r.results.map((x) => (
                <div key={x.projectId + x.versionId} className="flex items-center gap-3 border-b border-line-weak px-4 py-2 text-sm last:border-0">
                  <span className="flex-1">{x.name}</span>
                  <span className="font-semibold tabular">{fmtPct(x.overall)}</span>
                  {x.active ? <Chip tone="strong">live</Chip> : <Chip>superseded</Chip>}
                  {x.active && !r.isDemo && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Undo2 className="size-3.5" />}
                      onClick={() => unpublish.mutate({ projectId: x.projectId, versionId: x.versionId })}
                    >
                      Roll back
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        ))}
      </div>
    </>
  );
}
