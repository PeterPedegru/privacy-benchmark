import { suites } from "@pb/rubric";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Check, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { KeyBanner } from "@/components/admin/key-banner";
import { Field, Input, PageHeader, Panel, useAdmin, useAdminAction } from "@/components/admin/kit";
import { Button } from "@/components/ui/button";
import { ProjectMark } from "@/components/ui/project-mark";
import { Segmented } from "@/components/ui/segmented";
import { api } from "@/lib/api";
import { cn, fmtUsd } from "@/lib/utils";
import type { AdminProjectRow } from "./projects";

type Mode = "quick" | "standard" | "deep";
const MODE_TEXT: Record<Mode, string> = {
  quick:
    "~12 scout calls, a short code and mechanics audit, 10 research calls per suite, an 8-call code check per suite, single judge vote. A first look only.",
  standard:
    "~25 scout calls, ~45-call code audit plus ~35-call mechanics audit, 22 research calls per suite, a 16-call code check per suite, 3 votes on high-impact criteria, skeptic pass.",
  deep: "Exhaustive, for published results (runs are weekly): ~50 scout calls, ~120-call code audit plus ~100-call mechanics audit, 50 research calls per suite, a 35-call code check per suite on every unknown, 3 votes on every criterion, skeptic on all favorable answers.",
};

export function AdminRunNew() {
  const search = useSearch({ strict: false }) as { project?: string; version?: string };
  const projects = useAdmin<AdminProjectRow[]>(["projects"], "/api/admin/projects");
  const settings = useAdmin<{
    anthropicKey: boolean;
    anthropicStatus: { state: string };
    models: { tiers: { gather: string; write: string; reason: string } };
  }>(["settings"], "/api/admin/settings");
  const [picked, setPicked] = useState<string[]>([]);
  const [versions, setVersions] = useState<Record<string, string | null>>({});
  const [mode, setMode] = useState<Mode>("deep");
  const [suiteSel, setSuiteSel] = useState<string[]>(suites.map((s) => s.id));
  const [label, setLabel] = useState("");
  const nav = useNavigate();

  useEffect(() => {
    if (search.project) setPicked([search.project]);
    if (search.project && search.version) setVersions({ [search.project]: search.version });
  }, [search.project, search.version]);

  const estimate = useAdmin<{ low: number; high: number }>(
    ["estimate", mode, picked.length, suiteSel.length],
    `/api/admin/estimate?mode=${mode}&projects=${Math.max(1, picked.length)}&suites=${suiteSel.length}`,
  );
  const start = useAdminAction(
    () =>
      api<{ id: string }>("/api/admin/runs", {
        json: {
          projectIds: picked,
          versions: Object.fromEntries(picked.map((id) => [id, versions[id] ?? tracked(id)[0]?.id ?? null])),
          mode,
          suites: suiteSel.length === suites.length ? undefined : suiteSel,
          label: label || undefined,
        },
      }),
    { success: "Run queued", invalidate: [["runs"], ["overview"], ["project"]] },
  );
  const rows = projects.data ?? [];
  const tracked = useMemo(() => (id: string) => (rows.find((p) => p.id === id)?.versions ?? []).filter((v) => v.status === "tracked"), [rows]);

  return (
    <>
      <PageHeader
        title="Run benchmark"
        subtitle={`Gathering: ${settings.data?.models.tiers.gather ?? "claude-haiku-4-5"} · judging: ${settings.data?.models.tiers.reason ?? "claude-opus-5-5"} · summaries: ${settings.data?.models.tiers.write ?? "claude-sonnet-5-5"}. Results land in the review queue; nothing is published automatically.`}
      />
      <KeyBanner context="Runs" />
      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <Panel
          title="Projects"
          actions={
            <button
              type="button"
              onClick={() => setPicked(picked.length === rows.length ? [] : rows.filter((r) => r.status === "active").map((r) => r.id))}
              className="text-xs text-muted hover:text-fg"
            >
              {picked.length === rows.length ? "Clear" : "Select all active"}
            </button>
          }
        >
          {rows.map((p) => {
            const on = picked.includes(p.id);
            const vs = tracked(p.id);
            return (
              <div key={p.id} className={cn("flex items-center gap-3 border-b border-line-weak px-4 py-2.5 last:border-0", on && "bg-accent-soft/40")}>
                <button
                  type="button"
                  onClick={() => setPicked(on ? picked.filter((x) => x !== p.id) : [...picked, p.id])}
                  className={cn(
                    "flex size-[18px] items-center justify-center rounded-[5px] border",
                    on ? "border-accent bg-accent text-white" : "border-line-strong",
                  )}
                  aria-label={`Select ${p.name}`}
                >
                  {on && <Check className="size-3" strokeWidth={3} />}
                </button>
                <ProjectMark name={p.name} logoUrl={p.logoUrl} size={20} />
                <span className="flex-1 text-sm font-medium">{p.name}</span>
                <select
                  value={versions[p.id] ?? vs[0]?.id ?? ""}
                  onChange={(e) => setVersions({ ...versions, [p.id]: e.target.value || null })}
                  className="h-7 max-w-[180px] rounded-md border border-line bg-bg px-1.5 text-xs"
                  aria-label={`${p.name} version`}
                >
                  {vs.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                  <option value="">Unpinned (live today)</option>
                </select>
              </div>
            );
          })}
        </Panel>
        <div className="flex flex-col gap-4">
          <Panel title="Settings">
            <div className="flex flex-col gap-4 p-4">
              <Field label="Mode" hint={MODE_TEXT[mode]}>
                <Segmented
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "quick", label: "Quick" },
                    { value: "standard", label: "Standard" },
                    { value: "deep", label: "Deep" },
                  ]}
                />
              </Field>
              <Field label="Suites">
                <div className="flex flex-wrap gap-1.5">
                  {suites.map((s) => {
                    const on = suiteSel.includes(s.id);
                    return (
                      <button
                        type="button"
                        key={s.id}
                        onClick={() => setSuiteSel(on ? suiteSel.filter((x) => x !== s.id) : [...suiteSel, s.id])}
                        className={cn("h-7 rounded-lg border px-2 text-xs", on ? "border-accent bg-accent-soft text-accent-fg" : "border-line text-muted")}
                      >
                        {s.shortName}
                      </button>
                    );
                  })}
                </div>
              </Field>
              <Field label="Label (optional)">
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="October release" />
              </Field>
            </div>
          </Panel>
          <Panel>
            <div className="p-4">
              <div className="text-xs text-muted">Estimated cost</div>
              <div className="mt-1 text-2xl font-semibold tabular">{estimate.data ? `${fmtUsd(estimate.data.low)} – ${fmtUsd(estimate.data.high)}` : "—"}</div>
              <div className="mt-1 text-xs text-muted">
                Order of magnitude. Real token usage is metered per call; each evaluation stops at the server's cost cap.
              </div>
              <Button
                variant="primary"
                size="lg"
                className="mt-4 w-full"
                disabled={
                  !picked.length || !suiteSel.length || start.isPending || !settings.data?.anthropicKey || settings.data?.anthropicStatus.state === "rejected"
                }
                icon={<Play className="size-4" />}
                onClick={() => start.mutate(undefined, { onSuccess: (r) => nav({ to: "/admin/runs/$id", params: { id: r.id } }) })}
              >
                Start run · {picked.length} project{picked.length === 1 ? "" : "s"}
              </Button>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
