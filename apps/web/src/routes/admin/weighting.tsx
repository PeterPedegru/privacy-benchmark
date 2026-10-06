import type { PollInfo, PollStats, WeightingChange, WeightingSummary } from "@pb/core";
import { Ban, ExternalLink, Play } from "lucide-react";
import { useState } from "react";
import { Field, Input, PageHeader, Panel, Select, Stat, Status, Textarea, useAdmin, useAdminAction } from "@/components/admin/kit";
import { Chip } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn, fmtDate, fmtNum } from "@/lib/utils";
import { fmtWeight } from "@/lib/weighting";

type AdminWeighting = WeightingSummary & { evaluations: number };
type PollDetail = PollInfo & { stats: PollStats | null; networks: number | null; quorum: boolean | null; changes: WeightingChange[] | null };

/**
 * Community weighting for editors: open a five-day poll on a weighting, watch its turnout and the result it would
 * have, and retire a weighting that shouldn't score new runs. Runs pick their weighting on Run benchmark.
 */
export function AdminWeighting() {
  const polls = useAdmin<{ xEnabled: boolean; polls: PollInfo[] }>(["polls"], "/api/admin/polls");
  const weightings = useAdmin<AdminWeighting[]>(["weightings"], "/api/admin/weightings");
  const open = polls.data?.polls.find((p) => p.status === "open") ?? null;
  return (
    <>
      <PageHeader
        title="Weighting"
        subtitle="The public votes on weights and answer credits for five days; the result becomes the next weighting and the default for new runs. Published results link to the weighting they were scored with."
        actions={
          <a href="/weighting" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
            Public page <ExternalLink className="size-3.5" />
          </a>
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[1.2fr_1fr]">
        {open ? <OpenPollPanel poll={open} /> : <NewPollPanel weightings={weightings.data ?? []} xEnabled={!!polls.data?.xEnabled} />}
        <Panel title="Weightings">
          {(weightings.data ?? []).map((w) => (
            <WeightingRow key={w.id} w={w} />
          ))}
          {weightings.isLoading && <div className="px-4 py-6 text-sm text-muted">Loading…</div>}
        </Panel>
      </div>
      <h2 className="mt-10 mb-3 text-lg font-semibold">Polls</h2>
      <Panel>
        {(polls.data?.polls ?? []).map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-3 border-b border-line-weak px-4 py-2.5 text-sm last:border-0">
            <span className="min-w-0 flex-1 truncate font-medium">{p.title}</span>
            <span className="text-xs text-muted">
              {fmtDate(p.opensAt)} → {fmtDate(p.closesAt)} · base {p.base.label} · {p.ballots} ballots · {p.requireX ? "X sign-in" : "browser"}
            </span>
            <Status status={p.status} />
            {p.outcome === "adopted" && p.result && <Chip tone="strong">adopted as {p.result.label}</Chip>}
            {p.outcome === "no_quorum" && <Chip tone="fair">no quorum ({p.minBallots})</Chip>}
          </div>
        ))}
        {!polls.data?.polls.length && <div className="px-4 py-8 text-center text-sm text-muted">No polls yet.</div>}
      </Panel>
    </>
  );
}

function NewPollPanel({ weightings, xEnabled }: { weightings: AdminWeighting[]; xEnabled: boolean }) {
  const usable = weightings.filter((w) => !w.retired);
  const [baseId, setBaseId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [minBallots, setMinBallots] = useState("10");
  const [requireX, setRequireX] = useState(true);
  const xMode = requireX && xEnabled;
  const start = useAdminAction(
    () =>
      api<PollInfo>("/api/admin/polls", {
        json: {
          baseId: baseId || undefined,
          title: title || undefined,
          description: description || undefined,
          minBallots: Math.max(1, Number(minBallots) || 1),
          requireX: xMode,
        },
      }),
    {
      success: (p) => `Poll open until ${fmtDate(p.closesAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
      invalidate: [["polls"], ["weightings"], ["overview"]],
    },
  );
  return (
    <Panel title="Open a poll">
      <div className="flex flex-col gap-4 p-4">
        <Field label="Base weighting" hint="Voters start from these weights; a ballot that changes nothing is a vote for them.">
          <Select value={baseId} onChange={(e) => setBaseId(e.target.value)}>
            <option value="">The current weighting{usable.find((w) => w.current) ? ` (${usable.find((w) => w.current)!.label})` : ""}</option>
            {usable.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label} · {w.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title (public)">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Community weighting poll #1" />
        </Field>
        <Field label="Note to voters (optional, public)">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-20" placeholder="What's up for review this time…" />
        </Field>
        <Field label="Quorum" hint="Fewer ballots than this when the poll closes and the weights stay as they are.">
          <Input type="number" min={1} value={minBallots} onChange={(e) => setMinBallots(e.target.value)} className="w-32" />
        </Field>
        <label className={cn("flex items-start gap-2.5 text-sm", !xEnabled && "opacity-60")}>
          <input type="checkbox" className="mt-1" checked={xMode} disabled={!xEnabled} onChange={(e) => setRequireX(e.target.checked)} />
          <span>
            <span className="font-medium">Require Sign in with X</span>
            <span className="block text-xs text-muted">
              {xEnabled
                ? "One ballot per X account (30+ days old). Without it, one ballot per browser: fine for a dry run, easy to repeat."
                : "Not configured: set X_OAUTH_CLIENT_ID and X_OAUTH_CLIENT_SECRET on the server. Until then polls count one ballot per browser."}
            </span>
          </span>
        </label>
        <Button
          variant="primary"
          icon={<Play className="size-4" />}
          disabled={start.isPending}
          onClick={() => {
            if (confirm("Open a five-day public poll now? It can be cancelled but not shortened.")) start.mutate();
          }}
        >
          Open a five-day poll
        </Button>
      </div>
    </Panel>
  );
}

function OpenPollPanel({ poll }: { poll: PollInfo }) {
  const d = useAdmin<PollDetail>(["poll", poll.id], `/api/admin/polls/${poll.id}`, { refetchInterval: 30_000 });
  const cancel = useAdminAction(() => api(`/api/admin/polls/${poll.id}/cancel`, { json: {} }), {
    success: "Poll cancelled",
    invalidate: [["polls"], ["poll"], ["overview"]],
  });
  const changes = d.data?.changes ?? [];
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {poll.title} <Status status="open" />
        </span>
      }
      actions={
        <Button
          size="sm"
          variant="danger"
          icon={<Ban className="size-3.5" />}
          disabled={cancel.isPending}
          onClick={() => {
            if (confirm("Cancel this poll? Its ballots are deleted and the weights stay as they are.")) cancel.mutate();
          }}
        >
          Cancel poll
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
        <Stat label="Ballots" value={d.data?.ballots ?? poll.ballots} hint={`quorum ${poll.minBallots}`} />
        <Stat label="Networks" value={d.data?.networks ?? "—"} hint="distinct /24s" />
        <Stat label="Kept everything" value={d.data?.stats ? d.data.stats.unchanged : "—"} hint="ballots with no change" />
        <Stat
          label="Closes"
          value={fmtDate(poll.closesAt, { month: "short", day: "numeric" })}
          hint={fmtDate(poll.closesAt, { hour: "numeric", minute: "2-digit" })}
        />
      </div>
      <div className="border-t border-line px-4 py-3 text-sm">
        <div className="font-medium">If it closed now {d.data?.quorum === false ? <Chip tone="fair">below quorum: nothing would change</Chip> : null}</div>
        <div className="mt-0.5 text-xs text-muted">
          Base {poll.base.label} · {poll.requireX ? "one ballot per X account" : "one ballot per browser"}
        </div>
      </div>
      {changes.length ? (
        changes.slice(0, 30).map((c) => (
          <div key={c.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-line-weak px-4 py-2 text-[13px]">
            <span className="min-w-0 truncate">
              {c.label} <span className="text-muted">· {c.context}</span>
              {d.data?.stats?.changedBy[c.key] ? <span className="text-faint"> · {d.data.stats.changedBy[c.key]} ballots</span> : null}
            </span>
            <span className="tabular">
              {fmtWeight(c.from)} → <span className="font-semibold">{fmtWeight(c.to)}</span>{" "}
              <span className={c.to > c.from ? "text-strong-fg" : "text-poor-fg"}>
                ({c.to > c.from ? "+" : "−"}
                {fmtNum(Math.abs(c.to - c.from), 1)})
              </span>
            </span>
          </div>
        ))
      ) : (
        <div className="border-t border-line-weak px-4 py-4 text-sm text-muted">No weight would change.</div>
      )}
      {changes.length > 30 && <div className="border-t border-line-weak px-4 py-2 text-xs text-muted">and {changes.length - 30} more</div>}
    </Panel>
  );
}

function WeightingRow({ w }: { w: AdminWeighting }) {
  const toggle = useAdminAction(() => api(`/api/admin/weightings/${w.id}`, { method: "PATCH", json: { retired: !w.retired } }), {
    success: w.retired ? `${w.label} restored` : `${w.label} retired`,
    invalidate: [["weightings"]],
  });
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line-weak px-4 py-2.5 last:border-0">
      <a href={`/weighting/${w.label}`} target="_blank" rel="noreferrer" className="w-9 text-sm font-semibold tabular hover:underline">
        {w.label}
      </a>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{w.title}</span>
        <span className="block truncate text-xs text-muted">
          {fmtDate(w.createdAt)} · {w.evaluations} evaluation{w.evaluations === 1 ? "" : "s"} · {w.results} live result{w.results === 1 ? "" : "s"}
          {w.poll ? ` · ${w.poll.ballots} ballots` : ""}
        </span>
      </span>
      {w.current && <Chip tone="accent">default for new runs</Chip>}
      {w.retired && <Chip>retired</Chip>}
      <Button size="sm" variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
        {w.retired ? "Restore" : "Retire"}
      </Button>
    </div>
  );
}
