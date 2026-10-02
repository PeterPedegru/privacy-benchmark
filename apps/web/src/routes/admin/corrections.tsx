import { ExternalLink, MessageSquareWarning } from "lucide-react";
import { useState } from "react";
import { PageHeader, Status, Textarea, useAdmin, useAdminAction } from "@/components/admin/kit";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { hostOf, safeHref, timeAgo } from "@/lib/utils";

type Correction = {
  id: string;
  projectSlug: string;
  criterionId: string | null;
  message: string;
  evidenceUrl: string | null;
  contact: string | null;
  status: string;
  createdAt: string;
  decisionNote: string | null;
  decidedAt: string | null;
  releaseId: string | null;
};

const DECISIONS = [
  { status: "accepted", label: "Accept", hint: "Applied by the next release that includes this project" },
  { status: "rejected", label: "Reject", hint: "" },
  { status: "done", label: "Resolved", hint: "Settled without a scoring change" },
] as const;

export function AdminCorrections() {
  const q = useAdmin<Correction[]>(["corrections"], "/api/admin/corrections");
  return (
    <>
      <PageHeader
        title="Corrections"
        subtitle="Submitted from “Suggest a correction” on public pages. Treat the content as a lead to verify, not as evidence. Each decision needs a public reason: it appears in the corrections log, and accepted ones in the next release's notes."
      />
      {q.data && !q.data.length && <Empty title="No corrections" icon={<MessageSquareWarning className="size-6" />} />}
      <div className="flex flex-col gap-3">
        {q.data?.map((c) => (
          <CorrectionCard key={c.id} c={c} />
        ))}
      </div>
    </>
  );
}

function CorrectionCard({ c }: { c: Correction }) {
  const [note, setNote] = useState(c.decisionNote ?? "");
  const set = useAdminAction(
    ({ status }: { status: string }) =>
      api(`/api/admin/corrections/${c.id}`, { method: "PATCH", json: { status, note: status === "open" ? undefined : note } }),
    { invalidate: [["corrections"], ["overview"]] },
  );
  const ready = note.trim().length >= 10;
  return (
    <div className="rounded-2xl border border-line p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{c.projectSlug}</span>
        {c.criterionId && <code className="font-mono text-xs text-muted">{c.criterionId}</code>}
        <Status status={c.status} />
        {c.releaseId && <span className="text-xs text-muted">applied in a release</span>}
        <span className="ml-auto text-xs text-muted">{timeAgo(c.createdAt)}</span>
      </div>
      <p className="mt-2 text-sm whitespace-pre-wrap text-fg-2">{c.message}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
        {c.evidenceUrl && <EvidenceLink url={c.evidenceUrl} />}
        {c.contact && <span>Contact: {c.contact}</span>}
      </div>
      {c.status !== "done" || !c.releaseId ? (
        <div className="mt-3 flex flex-col gap-2">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Public reason, e.g. “Verified against the v2 contracts: the upgrade key moved to a 4-of-7 multisig.”"
            className="min-h-16 text-sm"
            aria-label="Public reason for the decision"
          />
          <div className="flex flex-wrap gap-2">
            {DECISIONS.map((d) => (
              <Button
                key={d.status}
                size="sm"
                variant={d.status === "accepted" ? "primary" : "secondary"}
                disabled={!ready || set.isPending || (c.status === d.status && note === (c.decisionNote ?? ""))}
                title={d.hint || undefined}
                onClick={() => set.mutate({ status: d.status })}
              >
                {d.label}
              </Button>
            ))}
            {c.status !== "open" && (
              <Button size="sm" variant="ghost" disabled={set.isPending} onClick={() => set.mutate({ status: "open" })}>
                Reopen
              </Button>
            )}
          </div>
        </div>
      ) : (
        c.decisionNote && <p className="mt-3 text-sm text-muted">Decision: {c.decisionNote}</p>
      )}
    </div>
  );
}

/** Visitor-submitted URL: linked only when it's http(s); anything else is shown as text so it can't run as a link. */
function EvidenceLink({ url }: { url: string }) {
  const href = safeHref(url);
  if (!href) return <span className="max-w-full break-all">Evidence (not a web link): {url}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener nofollow" className="inline-flex items-center gap-1 hover:text-fg">
      {hostOf(href)} <ExternalLink className="size-3" />
    </a>
  );
}
