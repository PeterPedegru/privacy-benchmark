import { suites } from "@pb/rubric";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ExternalLink, FileText, Globe, Play, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { m } from "motion/react";
import { useEffect, useState } from "react";
import { Field, Input, ListInput, PageHeader, Panel, Select, Status, Td, Textarea, Th, useAdmin, useAdminAction } from "@/components/admin/kit";
import { type KbSummary, KnowledgeBase } from "@/components/admin/knowledge-base";
import { Chip } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { ProjectMark } from "@/components/ui/project-mark";
import { Sheet } from "@/components/ui/sheet";
import { spring } from "@/design/motion";
import { api } from "@/lib/api";
import { cn, fmtDate, fmtPct, fmtUsd, hostOf, safeHref, timeAgo } from "@/lib/utils";
import { CATEGORIES, MECHANISMS } from "./project-new";

type Version = {
  id: string;
  version: string;
  label: string;
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
  deployment: Deployment | null;
};
type Deployment = {
  status: "mainnet" | "testnet" | "not_deployed";
  contracts: { chain: string; address: string; label: string }[];
  note: string;
  confirmedAt: string;
};
type Detail = {
  project: {
    id: string;
    slug: string;
    name: string;
    websiteUrl: string;
    logoUrl: string | null;
    tagline: string;
    description: string;
    category: string;
    mechanism: string;
    chains: string[];
    githubRepos: string[];
    trackVersions: boolean;
    versionTagPattern: string | null;
    l2beatSlug: string | null;
    defillamaSlug: string | null;
    xHandle: string | null;
    docsUrl: string | null;
    docsRoots: { url: string; prefix?: string }[];
    newsAliases: string[];
    extraDomains: string[];
    status: string;
  };
  kb: KbSummary | null;
  sources: { id: string; url: string; title: string; kind: string; sourceClass: string; origin: string; fetchedAt: string; size: number }[];
  versions: Version[];
  evaluations: {
    id: string;
    status: string;
    stage: string;
    mode: string;
    versionId: string | null;
    costUsd: number;
    createdAt: string;
    isDemo: boolean;
    error: string | null;
  }[];
  checks: { id: string; ranAt: string; newVersions: number; error: string | null; costUsd: number }[];
  published: { id: string; versionId: string | null; overall: number | null; active: boolean; createdAt: string }[];
};

type Tab = "knowledge" | "versions" | "sources" | "evaluations" | "settings";

export function AdminProjectDetail() {
  const { id } = useParams({ from: "/admin/projects/$id" });
  const q = useAdmin<Detail>(["project", id], `/api/admin/projects/${id}`);
  const [tab, setTab] = useState<Tab>("knowledge");
  const nav = useNavigate();
  const d = q.data;
  if (!d) return <div className="h-40 shimmer rounded-2xl" />;
  const p = d.project;
  return (
    <>
      <div className="mb-2 text-[13px] text-muted">
        <Link to="/admin/projects" className="hover:text-fg">
          Projects
        </Link>{" "}
        / {p.name}
      </div>
      <PageHeader
        title={p.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <ProjectMark name={p.name} logoUrl={p.logoUrl} size={16} />
            {safeHref(p.websiteUrl) ? (
              <a href={safeHref(p.websiteUrl)!} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-fg">
                {hostOf(p.websiteUrl)} <ExternalLink className="size-3" />
              </a>
            ) : (
              <span>{p.websiteUrl}</span>
            )}
            <Chip>{p.category}</Chip>
            <Chip>{p.mechanism}</Chip>
            {p.status !== "active" && <Status status={p.status} />}
            <Link to="/projects/$slug" params={{ slug: p.slug }} className="text-muted hover:text-fg">
              Public page →
            </Link>
          </span>
        }
        actions={
          <Button variant="primary" icon={<Play className="size-4" />} onClick={() => nav({ to: "/admin/runs/new", search: { project: p.id } as never })}>
            Evaluate
          </Button>
        }
      />
      <div className="mb-5 flex gap-1 border-b border-line">
        {(["knowledge", "versions", "sources", "evaluations", "settings"] as Tab[]).map((t) => (
          <button
            type="button"
            key={t}
            onClick={() => setTab(t)}
            className={cn("relative px-3 pt-1 pb-2.5 text-sm capitalize", tab === t ? "text-fg" : "text-muted hover:text-fg")}
          >
            {t}
            {t === "knowledge" && d.kb?.status === "refreshing" && (
              <span className="pulse-dot ml-1.5 inline-block size-1.5 rounded-full bg-accent align-middle" />
            )}
            {t === "versions" && d.versions.some((v) => v.status === "detected") && (
              <span className="ml-1.5 rounded bg-fair-bg px-1 text-[10px] font-semibold text-fair-fg">
                {d.versions.filter((v) => v.status === "detected").length}
              </span>
            )}
            {tab === t && <m.span layoutId="pd-tab" transition={spring} className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>
      {tab === "knowledge" && <KnowledgeBase projectId={p.id} versions={d.versions} />}
      {tab === "versions" && <Versions d={d} />}
      {tab === "sources" && <Sources d={d} />}
      {tab === "evaluations" && <Evaluations d={d} />}
      {tab === "settings" && <SettingsForm d={d} />}
    </>
  );
}

function Versions({ d }: { d: Detail }) {
  const p = d.project;
  const [adding, setAdding] = useState(false);
  const [deploying, setDeploying] = useState<Version | null>(null);
  const check = useAdminAction(
    () => api<{ newVersions: number; errors: string[]; usage: { costUsd: number } }>(`/api/admin/projects/${p.id}/versions/check`, { method: "POST" }),
    {
      success: (r) => `${r.newVersions} new version(s)${r.errors.length ? ` · ${r.errors[0]}` : ""} · ${fmtUsd(r.usage.costUsd)}`,
      invalidate: [["project", p.id], ["updates"], ["version-checks"], ["projects"], ["overview"]],
    },
  );
  const versionKeys = [["project", p.id], ["updates"], ["projects"], ["overview"]];
  const setStatus = useAdminAction(
    ({ id, status }: { id: string; status: string }) => api(`/api/admin/versions/${id}`, { method: "PATCH", json: { status } }),
    { invalidate: versionKeys },
  );
  const del = useAdminAction((id: string) => api(`/api/admin/versions/${id}`, { method: "DELETE" }), { success: "Version removed", invalidate: versionKeys });
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted">
          {p.githubRepos.length ? (
            <>
              Watching <span className="text-fg-2">{p.githubRepos.join(", ")}</span>. Claude Sonnet 5.5 triages new releases.
            </>
          ) : (
            "No GitHub repos. Add versions manually when a major announcement lands."
          )}
          {d.checks[0] && <span className="ml-2 text-xs">Last check {timeAgo(d.checks[0].ranAt)}</span>}
        </div>
        <div className="flex gap-2">
          {p.githubRepos.length > 0 && (
            <Button
              size="sm"
              icon={<RefreshCw className={check.isPending ? "size-3.5 animate-spin" : "size-3.5"} />}
              onClick={() => check.mutate()}
              disabled={check.isPending}
            >
              Check now
            </Button>
          )}
          <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
            Add version
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-line">
        <table className="w-full min-w-[720px] border-collapse">
          <thead>
            <tr>
              <Th>Version</Th>
              <Th>Released</Th>
              <Th>Triage</Th>
              <Th>Status</Th>
              <Th>Deployment</Th>
              <Th>Published</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {d.versions.map((v) => {
              const pub = d.published.find((x) => x.versionId === v.id && x.active);
              return (
                <tr key={v.id} className="align-top">
                  <Td>
                    <div className="font-medium">{v.label}</div>
                    <div className="text-xs text-muted">
                      {v.source === "manual" ? "manual" : `${v.repo}@${v.tag}`}
                      {safeHref(v.sourceUrl) && (
                        <a href={safeHref(v.sourceUrl)!} target="_blank" rel="noreferrer noopener" className="ml-1.5 inline-flex items-center hover:text-fg">
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                    {v.summary && <div className="mt-1 max-w-md text-xs leading-5 text-fg-3">{v.summary}</div>}
                  </Td>
                  <Td className="text-xs text-muted">{fmtDate(v.releasedAt)}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {v.isMajor && <Chip tone="accent">Major</Chip>}
                      {v.isPrerelease && <Chip>Pre-release</Chip>}
                      {v.privacyRelevant && <Chip tone="fair">Privacy-relevant</Chip>}
                      {v.affectedSuites.map((s) => (
                        <Chip key={s}>{suites.find((x) => x.id === s)?.shortName ?? s}</Chip>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    <Status status={v.status} />
                  </Td>
                  <Td>
                    <button type="button" onClick={() => setDeploying(v)} className="text-left text-xs hover:text-fg" title="Confirm what this version runs">
                      {v.deployment ? (
                        <>
                          <Chip tone={v.deployment.status === "mainnet" ? "strong" : "fair"}>{DEPLOYMENT_LABEL[v.deployment.status]}</Chip>
                          <div className="mt-1 text-muted">
                            {v.deployment.contracts.length} contract{v.deployment.contracts.length === 1 ? "" : "s"} · {fmtDate(v.deployment.confirmedAt)}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted underline decoration-dotted underline-offset-2">Not confirmed</span>
                      )}
                    </button>
                  </Td>
                  <Td className="font-semibold tabular">{pub ? fmtPct(pub.overall) : <span className="font-normal text-muted">—</span>}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1">
                      {v.status !== "tracked" && (
                        <Button size="sm" onClick={() => setStatus.mutate({ id: v.id, status: "tracked" })}>
                          Track
                        </Button>
                      )}
                      {v.status === "detected" && (
                        <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: v.id, status: "ignored" })}>
                          Ignore
                        </Button>
                      )}
                      {!pub && (
                        <button
                          type="button"
                          onClick={() => del.mutate(v.id)}
                          className="rounded-md p-1.5 text-faint hover:bg-surface hover:text-poor-fg"
                          aria-label="Delete version"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
            {!d.versions.length && (
              <tr>
                <Td className="py-8 text-center text-muted">No versions yet.</Td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <AddVersion open={adding} onOpenChange={setAdding} projectId={p.id} />
      {deploying && <DeploymentSheet key={deploying.id} version={deploying} projectId={p.id} onClose={() => setDeploying(null)} />}
    </>
  );
}

const DEPLOYMENT_LABEL: Record<Deployment["status"], string> = { mainnet: "Mainnet", testnet: "Testnet only", not_deployed: "Not deployed" };

const contractLine = (c: Deployment["contracts"][number]) => [c.chain, c.address, c.label].filter(Boolean).join(" ");

/**
 * The editor confirms what a version actually runs (JDG-32). Every stage's prompt names these contracts; onchain
 * reads of anything else count only as context.
 */
function DeploymentSheet({ version, projectId, onClose }: { version: Version; projectId: string; onClose: () => void }) {
  const d = version.deployment;
  const [status, setStatus] = useState<Deployment["status"]>(d?.status ?? "mainnet");
  const [lines, setLines] = useState((d?.contracts ?? []).map(contractLine).join("\n"));
  const [note, setNote] = useState(d?.note ?? "");
  const suggestions = useAdmin<{ chain: string; address: string; label: string; verified: boolean }[]>(
    ["deployment-suggestions", projectId],
    `/api/admin/projects/${projectId}/deployment-suggestions`,
  );
  const contracts = lines
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map(([chain, address, ...label]) => ({ chain: chain!, address: address!, label: label.join(" ") }));
  const keys = [["project", projectId]];
  const save = useAdminAction(() => api(`/api/admin/versions/${version.id}/deployment`, { method: "PUT", json: { status, contracts, note } }), {
    success: "Deployment confirmed",
    invalidate: keys,
  });
  const clear = useAdminAction(() => api(`/api/admin/versions/${version.id}/deployment`, { method: "PUT", json: null }), {
    success: "Deployment cleared",
    invalidate: keys,
  });
  const listed = new Set(contracts.map((c) => c.address.toLowerCase()));
  const add = (s: { chain: string; address: string; label: string }) => setLines((l) => `${l.trim() ? `${l.trim()}\n` : ""}${contractLine(s)}`);
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Deployment · ${version.label}`}
      subtitle="What this version actually runs. Evaluations treat these contracts as the version."
      width={560}
    >
      <div className="flex flex-col gap-4">
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as Deployment["status"])}>
            <option value="mainnet">Live on mainnet</option>
            <option value="testnet">Testnet only</option>
            <option value="not_deployed">Not deployed yet</option>
          </Select>
        </Field>
        <Field label="Contracts" hint="One per line: chain (an id like 1, or a network name like aztec), address, then an optional label.">
          <Textarea
            value={lines}
            onChange={(e) => setLines(e.target.value)}
            className="min-h-32 font-mono text-xs"
            placeholder="1 0x1234…abcd Privacy pool entrypoint"
          />
        </Field>
        <Field label="Note" hint="Optional: where you confirmed this (deployment docs, an explorer, a release post).">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} className="min-h-16 text-sm" />
        </Field>
        {!!suggestions.data?.length && (
          <div>
            <div className="text-xs font-medium text-muted">Found by the knowledge base (verify before adding)</div>
            <ul className="mt-1.5 flex max-h-56 flex-col gap-1 overflow-y-auto">
              {suggestions.data.map((s) => (
                <li key={`${s.chain}:${s.address}`} className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    disabled={listed.has(s.address.toLowerCase())}
                    onClick={() => add(s)}
                    className="rounded-md border border-line px-1.5 py-0.5 hover:bg-surface disabled:opacity-40"
                  >
                    Add
                  </button>
                  <code className="truncate font-mono">
                    {s.chain}:{s.address}
                  </code>
                  <span className="truncate text-muted">{s.label}</span>
                  {s.verified && <Chip tone="strong">Sourcify</Chip>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Confirm deployment
          </Button>
          {d && (
            <Button variant="ghost" disabled={clear.isPending} onClick={() => clear.mutate(undefined, { onSuccess: onClose })}>
              Clear
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

function AddVersion({ open, onOpenChange, projectId }: { open: boolean; onOpenChange: (o: boolean) => void; projectId: string }) {
  const [f, setF] = useState({ label: "", releasedAt: "", sourceUrl: "", summary: "", isMajor: true, privacyRelevant: true, affectedSuites: [] as string[] });
  const summarize = useAdminAction(
    () =>
      api<{ label: string; summary: string; isMajor: boolean; privacyRelevant: boolean; affectedSuites: string[]; costUsd: number }>(
        "/api/admin/versions/summarize",
        { json: { url: f.sourceUrl, projectId } },
      ),
    {
      invalidate: false,
      success: (r) => `Summarized with Sonnet 5.5 · ${fmtUsd(r.costUsd)}`,
    },
  );
  const save = useAdminAction(
    () =>
      api(`/api/admin/projects/${projectId}/versions`, {
        json: {
          label: f.label,
          releasedAt: f.releasedAt || null,
          sourceUrl: f.sourceUrl || null,
          summary: f.summary,
          isMajor: f.isMajor,
          privacyRelevant: f.privacyRelevant,
          affectedSuites: f.affectedSuites,
          status: "tracked",
        },
      }),
    { success: "Version added", invalidate: [["project", projectId], ["projects"]] },
  );
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add version"
      subtitle="For announcements without a GitHub release. Pin evaluations to it."
      width={520}
    >
      <div className="flex flex-col gap-4">
        <Field label="Announcement URL" hint="Optional. Sonnet 5.5 can read it and draft the fields below.">
          <div className="flex gap-2">
            <Input value={f.sourceUrl} onChange={(e) => setF({ ...f, sourceUrl: e.target.value })} placeholder="https://…" />
            <Button
              disabled={!f.sourceUrl || summarize.isPending}
              icon={<Sparkles className="size-3.5" />}
              onClick={() =>
                summarize.mutate(undefined, {
                  onSuccess: (r) =>
                    setF((x) => ({
                      ...x,
                      label: x.label || r.label,
                      summary: r.summary,
                      isMajor: r.isMajor,
                      privacyRelevant: r.privacyRelevant,
                      affectedSuites: r.affectedSuites,
                    })),
                })
              }
            >
              {summarize.isPending ? "Reading…" : "Summarize"}
            </Button>
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Label">
            <Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Alpha V6" />
          </Field>
          <Field label="Release date">
            <Input type="date" value={f.releasedAt} onChange={(e) => setF({ ...f, releasedAt: e.target.value })} />
          </Field>
        </div>
        <Field label="What changed">
          <Textarea value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} />
        </Field>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.isMajor} onChange={(e) => setF({ ...f, isMajor: e.target.checked })} /> Major version
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.privacyRelevant} onChange={(e) => setF({ ...f, privacyRelevant: e.target.checked })} /> Privacy-relevant
          </label>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {suites.map((s) => {
            const on = f.affectedSuites.includes(s.id);
            return (
              <button
                type="button"
                key={s.id}
                onClick={() => setF({ ...f, affectedSuites: on ? f.affectedSuites.filter((x) => x !== s.id) : [...f.affectedSuites, s.id] })}
                className={cn("h-7 rounded-lg border px-2 text-xs", on ? "border-accent bg-accent-soft text-accent-fg" : "border-line text-muted")}
              >
                {s.shortName}
              </button>
            );
          })}
        </div>
        <Button variant="primary" disabled={!f.label || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => onOpenChange(false) })}>
          Add version
        </Button>
      </div>
    </Sheet>
  );
}

function Sources({ d }: { d: Detail }) {
  const p = d.project;
  const [mode, setMode] = useState<"url" | "note" | null>(null);
  const [url, setUrl] = useState("");
  const [klass, setKlass] = useState("official_docs");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const add = useAdminAction(
    () =>
      api(`/api/admin/projects/${p.id}/sources`, {
        json: mode === "url" ? { type: "url", url, sourceClass: klass } : { type: "note", title, content, sourceClass: klass },
      }),
    { success: "Source added", invalidate: [["project", p.id]] },
  );
  const del = useAdminAction((id: string) => api(`/api/admin/sources/${id}`, { method: "DELETE" }), { invalidate: [["project", p.id]] });
  const setClass = useAdminAction(
    ({ id, sourceClass }: { id: string; sourceClass: string }) => api(`/api/admin/sources/${id}`, { method: "PATCH", json: { sourceClass } }),
    { invalidate: [["project", p.id]] },
  );
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted">
          {d.sources.length} sources you added or the agents found outside the knowledge base. Admin classifications override the agent's.
        </div>
        <div className="flex gap-2">
          <Button size="sm" icon={<Globe className="size-3.5" />} onClick={() => setMode("url")}>
            Add URL
          </Button>
          <Button size="sm" icon={<FileText className="size-3.5" />} onClick={() => setMode("note")}>
            Paste editor note
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-line">
        <table className="w-full min-w-[720px] border-collapse">
          <thead>
            <tr>
              <Th>Source</Th>
              <Th>Class</Th>
              <Th>Origin</Th>
              <Th>Fetched</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {d.sources.map((s) => (
              <tr key={s.id}>
                <Td>
                  <div className="max-w-md truncate font-medium">{s.title || s.url}</div>
                  <div className="text-xs text-muted">
                    {s.url.startsWith("note://") ? "editor note" : hostOf(s.url)} · {(s.size / 1000).toFixed(1)}k chars · {s.kind}
                  </div>
                </Td>
                <Td>
                  <select
                    value={s.sourceClass}
                    onChange={(e) => setClass.mutate({ id: s.id, sourceClass: e.target.value })}
                    className="rounded-md border border-line bg-bg px-1.5 py-0.5 text-xs"
                  >
                    {["code_onchain", "independent", "official_docs", "third_party", "marketing"].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Td>
                <Td className="text-xs text-muted">{s.origin}</Td>
                <Td className="text-xs text-muted">{timeAgo(s.fetchedAt)}</Td>
                <Td className="text-right">
                  <button
                    type="button"
                    onClick={() => del.mutate(s.id)}
                    className="rounded-md p-1.5 text-faint hover:bg-surface hover:text-poor-fg"
                    aria-label="Delete source"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Sheet
        open={!!mode}
        onOpenChange={(o) => !o && setMode(null)}
        title={mode === "url" ? "Add source URL" : "Paste editor note"}
        subtitle={
          mode === "note"
            ? "Research you trust. Quotes from it verify against this text and are labelled as editor notes publicly."
            : "Fetched through the SSRF-safe fetcher and stored as markdown."
        }
        width={560}
      >
        <div className="flex flex-col gap-4">
          {mode === "url" ? (
            <Field label="URL">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.example.org/security" />
            </Field>
          ) : (
            <>
              <Field label="Title">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} />
              </Field>
              <Field label="Content (markdown)">
                <Textarea value={content} onChange={(e) => setContent(e.target.value)} className="min-h-72 font-mono text-xs" />
              </Field>
            </>
          )}
          <Field label="Source class" hint="Drives the verifiability multiplier on favorable high-impact answers.">
            <Select value={klass} onChange={(e) => setKlass(e.target.value)}>
              <option value="code_onchain">Code / onchain (100%)</option>
              <option value="independent">Independent (100%)</option>
              <option value="official_docs">Official docs (90%)</option>
              <option value="third_party">News or third-party blog (80%)</option>
              <option value="marketing">Marketing (70%)</option>
            </Select>
          </Field>
          <Button
            variant="primary"
            disabled={add.isPending}
            onClick={() =>
              add.mutate(undefined, {
                onSuccess: () => {
                  setMode(null);
                  setUrl("");
                  setTitle("");
                  setContent("");
                },
              })
            }
          >
            {add.isPending ? "Adding…" : "Add source"}
          </Button>
        </div>
      </Sheet>
    </>
  );
}

function Evaluations({ d }: { d: Detail }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-line">
      <table className="w-full min-w-[640px] border-collapse">
        <thead>
          <tr>
            <Th>Created</Th>
            <Th>Version</Th>
            <Th>Mode</Th>
            <Th>Status</Th>
            <Th className="text-right">Cost</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {d.evaluations.map((e) => (
            <tr key={e.id}>
              <Td className="text-xs text-muted">{fmtDate(e.createdAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</Td>
              <Td>{d.versions.find((v) => v.id === e.versionId)?.label ?? "—"}</Td>
              <Td>
                {e.mode}
                {e.isDemo && <Chip className="ml-1.5">demo</Chip>}
              </Td>
              <Td>
                <Status status={e.status} />
                {e.error && <div className="mt-1 max-w-xs truncate text-xs text-poor-fg">{e.error}</div>}
              </Td>
              <Td className="text-right tabular">{fmtUsd(e.costUsd)}</Td>
              <Td className="text-right">
                <Link to="/admin/review/$id" params={{ id: e.id }} className="text-sm text-accent-fg hover:underline">
                  Open
                </Link>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SettingsForm({ d }: { d: Detail }) {
  const [f, setF] = useState(d.project);
  useEffect(() => setF(d.project), [d.project]);
  const save = useAdminAction(
    () =>
      api(`/api/admin/projects/${f.id}`, {
        method: "PATCH",
        json: {
          name: f.name,
          slug: f.slug,
          websiteUrl: f.websiteUrl,
          logoUrl: f.logoUrl || null,
          tagline: f.tagline,
          description: f.description,
          category: f.category,
          mechanism: f.mechanism,
          chains: f.chains,
          githubRepos: f.githubRepos,
          trackVersions: f.trackVersions,
          versionTagPattern: f.versionTagPattern || null,
          l2beatSlug: f.l2beatSlug || null,
          defillamaSlug: f.defillamaSlug || null,
          xHandle: f.xHandle || null,
          docsUrl: f.docsUrl || null,
          docsRoots: f.docsRoots,
          newsAliases: f.newsAliases,
          extraDomains: f.extraDomains,
          status: f.status,
        },
      }),
    { success: "Saved", invalidate: [["project", f.id], ["projects"], ["kb", f.id]] },
  );
  return (
    <Panel>
      <div className="grid gap-4 p-4 md:grid-cols-2">
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Slug">
          <Input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} />
        </Field>
        <Field label="Website">
          <Input value={f.websiteUrl} onChange={(e) => setF({ ...f, websiteUrl: e.target.value })} />
        </Field>
        <Field label="Logo URL">
          <Input value={f.logoUrl ?? ""} onChange={(e) => setF({ ...f, logoUrl: e.target.value })} />
        </Field>
        <Field label="Tagline" className="md:col-span-2">
          <Input value={f.tagline} onChange={(e) => setF({ ...f, tagline: e.target.value })} />
        </Field>
        <Field label="Description" className="md:col-span-2">
          <Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Category">
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field label="Mechanism">
          <Select value={f.mechanism} onChange={(e) => setF({ ...f, mechanism: e.target.value })}>
            {MECHANISMS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field label="GitHub repos" hint="owner/name, comma-separated">
          <ListInput value={f.githubRepos} onChange={(githubRepos) => setF({ ...f, githubRepos })} />
        </Field>
        <Field label="Docs URL" hint="Root of the docs site. Detected automatically when empty.">
          <Input value={f.docsUrl ?? ""} onChange={(e) => setF({ ...f, docsUrl: e.target.value })} placeholder="https://docs.example.org" />
        </Field>
        <Field
          label="Docs scopes"
          hint="One per line: a docs URL, optionally followed by a path prefix. Use for umbrella sites, e.g. https://docs.starknet.io /build/starknet-privacy"
          className="md:col-span-2"
        >
          <Textarea
            value={f.docsRoots.map((r) => [r.url, r.prefix].filter(Boolean).join(" ")).join("\n")}
            onChange={(e) =>
              setF({
                ...f,
                docsRoots: e.target.value
                  .split("\n")
                  .map((line) => line.trim().split(/\s+/))
                  .filter((parts) => parts[0])
                  .map(([url, prefix]) => ({ url: url!, ...(prefix ? { prefix } : {}) })),
              })
            }
            className="min-h-16 font-mono text-xs"
          />
        </Field>
        <Field label="News aliases" hint="Other names the press uses (comma-separated), e.g. RAILGUN, $RAIL">
          <ListInput value={f.newsAliases} onChange={(newsAliases) => setF({ ...f, newsAliases })} />
        </Field>
        <Field label="Other owned domains" hint="Blogs, Medium accounts or GitHub orgs the project runs, e.g. aztec-labs.com, github.com/noir-lang">
          <ListInput value={f.extraDomains} onChange={(extraDomains) => setF({ ...f, extraDomains })} />
        </Field>
        <Field label="X handle" hint="Official account, for announcements. Detected automatically when empty.">
          <Input value={f.xHandle ?? ""} onChange={(e) => setF({ ...f, xHandle: e.target.value })} placeholder="@example" />
        </Field>
        <Field label="Version tag pattern" hint="Optional regex, e.g. ^v\d+\.0\.0$ to watch majors only">
          <Input value={f.versionTagPattern ?? ""} onChange={(e) => setF({ ...f, versionTagPattern: e.target.value })} />
        </Field>
        <Field label="L2BEAT slug">
          <Input value={f.l2beatSlug ?? ""} onChange={(e) => setF({ ...f, l2beatSlug: e.target.value })} />
        </Field>
        <Field label="DefiLlama slug">
          <Input value={f.defillamaSlug ?? ""} onChange={(e) => setF({ ...f, defillamaSlug: e.target.value })} />
        </Field>
        <Field label="Chains" hint="Comma-separated">
          <ListInput value={f.chains} onChange={(chains) => setF({ ...f, chains })} />
        </Field>
        <Field label="Status">
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="active">active</option>
            <option value="archived">archived (hidden from the public site)</option>
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm md:col-span-2">
          <input type="checkbox" checked={f.trackVersions} onChange={(e) => setF({ ...f, trackVersions: e.target.checked })} /> Check GitHub for new versions
          automatically
        </label>
      </div>
      <div className="flex justify-end border-t border-line px-4 py-3">
        <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          Save changes
        </Button>
      </div>
    </Panel>
  );
}
