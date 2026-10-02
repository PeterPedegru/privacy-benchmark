import { Check, X } from "lucide-react";
import { PageHeader, Panel, useAdmin, useAdminAction } from "@/components/admin/kit";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { fmtUsd } from "@/lib/utils";

type S = {
  anthropicKey: boolean;
  anthropicStatus: { state: string; message: string; checkedAt: string | null };
  anthropicWorkspaceId: boolean;
  seedDemo: boolean;
  githubToken: boolean;
  etherscanKey: boolean;
  research: Record<"exa" | "news" | "x", { set: boolean; placeholder: boolean }>;
  kb: { maxDocsPages: number; maxSitePages: number; maxCodeFiles: number; maxCodeBytes: number; staleDays: number };
  models: { tiers: { gather: string; write: string; reason: string }; stages: Record<string, string> };
  costCapUsd: number;
  maxConcurrentProjects: number;
  versionCheckHours: number;
  rubricVersion: string;
};

function Row({ k, v, ok }: { k: string; v: React.ReactNode; ok?: boolean }) {
  return (
    <div className="grid grid-cols-[200px_1fr] items-center gap-3 border-b border-line-weak px-4 py-2.5 text-sm last:border-0">
      <span className="text-muted">{k}</span>
      <span className="flex items-center gap-2">
        {ok !== undefined && (ok ? <Check className="size-4 text-strong-fg" /> : <X className="size-4 text-poor-fg" />)}
        {v}
      </span>
    </div>
  );
}

export function AdminSettings() {
  const q = useAdmin<S>(["settings"], "/api/admin/settings");
  const verify = useAdminAction(() => api<{ state: string; message: string }>("/api/admin/settings/verify-key", { method: "POST" }), {
    success: (r) => (r.state === "ok" ? "Key accepted" : `Key ${r.state}: ${r.message}`),
    invalidate: [["settings"]],
  });
  const s = q.data;
  if (!s) return null;
  return (
    <>
      <PageHeader title="Settings" subtitle="Configured through apps/server/.env (see .env.example). Restart the server after changes." />
      <div className="flex flex-col gap-6">
        <Panel title="Keys">
          <Row
            k="ANTHROPIC_API_KEY"
            v={
              s.anthropicStatus.state === "ok"
                ? "Accepted by Anthropic"
                : s.anthropicStatus.state === "rejected"
                  ? `Rejected: ${s.anthropicStatus.message}`
                  : s.anthropicKey
                    ? "Set (not verified yet)"
                    : "Not set: evaluations and Haiku checks disabled"
            }
            ok={s.anthropicStatus.state === "ok"}
          />
          <Row
            k="ANTHROPIC_WORKSPACE_ID"
            v={s.anthropicWorkspaceId ? "Set (sent as anthropic-workspace-id)" : "Not set (only needed for organization-level keys)"}
          />
          <div className="px-4 py-2.5">
            <Button size="sm" onClick={() => verify.mutate()} disabled={verify.isPending}>
              {verify.isPending ? "Checking…" : "Re-check key"}
            </Button>
          </div>
          <Row k="GITHUB_TOKEN" v={s.githubToken ? "Set: 5,000 req/h and code search" : "Not set: 60 req/h, no code search"} ok={s.githubToken} />
          <Row k="ETHERSCAN_API_KEY" v={s.etherscanKey ? "Set" : "Optional"} ok={s.etherscanKey} />
        </Panel>
        <Panel title="Research sources">
          {(
            [
              ["EXA_API_KEY", "exa", "Independent analyses, audits and incident reports"],
              ["NEWSAPI_AI_KEY", "news", "News coverage (NewsAPI.ai / Event Registry)"],
              ["X_BEARER_TOKEN", "x", "The project's own announcements on X"],
            ] as const
          ).map(([k, key, what]) => {
            const r = s.research[key];
            return (
              <Row
                key={k}
                k={k}
                v={r.set ? `Set: ${what}` : r.placeholder ? "Placeholder value: replace it with a real key" : `Not set: ${what.toLowerCase()} skipped`}
                ok={r.set}
              />
            );
          })}
          <Row
            k="Knowledge base limits"
            v={`${s.kb.maxDocsPages} docs pages · ${s.kb.maxSitePages} site pages · ${s.kb.maxCodeFiles} code files (${Math.round(s.kb.maxCodeBytes / 1e6)} MB) · refreshed after ${s.kb.staleDays} days`}
          />
        </Panel>
        <Panel title="Models">
          <Row k="Gather (scout, research)" v={<code className="font-mono">{s.models.tiers.gather}</code>} />
          <Row k="Write (triage, summaries, intake)" v={<code className="font-mono">{s.models.tiers.write}</code>} />
          <Row k="Reason (code audit, judge, skeptic)" v={<code className="font-mono">{s.models.tiers.reason}</code>} />
          <Row
            k="Effective per stage"
            v={
              <span className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs">
                {Object.entries(s.models.stages).map(([k, v]) => (
                  <span key={k}>
                    {k}: {v}
                  </span>
                ))}
              </span>
            }
          />
        </Panel>
        <Panel title="Limits">
          <Row k="Cost cap per evaluation" v={fmtUsd(s.costCapUsd)} />
          <Row k="Concurrent projects" v={s.maxConcurrentProjects} />
          <Row k="Automatic update checks" v={s.versionCheckHours ? `Every ${s.versionCheckHours}h while the server runs` : "Off"} />
          <Row k="Rubric version" v={`v${s.rubricVersion}`} />
          <Row k="Demo data" v={s.seedDemo ? "On (SEED_DEMO=1)" : "Off: only live evaluations are published"} />
        </Panel>
      </div>
    </>
  );
}
