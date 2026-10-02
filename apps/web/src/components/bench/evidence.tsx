import type { ProjectSnapshot, SnapshotEvidence } from "@pb/core";
import { BadgeCheck, CircleHelp, ExternalLink } from "lucide-react";
import { cn, fmtDate, hostOf, sourceLink } from "@/lib/utils";
import { Chip } from "../ui/badges";

const CLASS_LABEL: Record<string, string> = {
  code_onchain: "Code / onchain",
  independent: "Independent",
  official_docs: "Official docs",
  third_party: "News / third party",
  marketing: "Marketing",
};

const STANCE: Record<string, { label: string; tone: "strong" | "poor" | "neutral" }> = {
  supports: { label: "Supports", tone: "strong" },
  contradicts: { label: "Counts against", tone: "poor" },
  context: { label: "Context", tone: "neutral" },
};

/** The quote highlighted inside the surrounding source text, so readers see what was left out around it. */
function InContext({ quote, context }: { quote: string; context: string }) {
  const at = context.indexOf(quote.slice(0, 80));
  if (at < 0) return null;
  const before = context.slice(Math.max(0, at - 260), at);
  const after = context.slice(at + quote.length, at + quote.length + 260);
  return (
    <details className="group mt-2 text-[13px] text-muted">
      <summary className="cursor-pointer select-none text-xs text-fg-3 hover:text-fg">Show surrounding text</summary>
      <p className="mt-1.5 rounded-lg bg-bg p-2.5 leading-[1.5] whitespace-pre-wrap">
        {before.length >= 260 ? "…" : ""}
        {before}
        <mark className="rounded-sm bg-accent-soft px-0.5 text-fg">{quote}</mark>
        {after}
        {after.length >= 260 ? "…" : ""}
      </p>
    </details>
  );
}

export function EvidenceItem({ e, snapshot }: { e: SnapshotEvidence; snapshot: ProjectSnapshot }) {
  const src = snapshot.sources.find((s) => s.id === e.sourceId);
  const isCode = src?.kind === "code";
  const attestation = e.match === "attestation" || src?.kind === "attestation";
  const link = (e.citedUrl && sourceLink(e.citedUrl)) || (src ? sourceLink(src.url) : null);
  const stance = e.stance ? STANCE[e.stance] : null;
  const cls = e.sourceClass ?? src?.sourceClass;
  return (
    <div className="rounded-xl border border-line bg-bg-2 p-3">
      {attestation ? (
        <div className="text-[14px] leading-[1.5] text-fg-2">
          <span className="mr-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Search attestation</span>
          {e.quote}
        </div>
      ) : (
        <blockquote
          className={cn("text-[14px] leading-[1.5] text-fg-2", isCode ? "font-mono text-[12px] whitespace-pre-wrap" : "font-serif text-[15px] italic")}
        >
          “{e.quote}”
        </blockquote>
      )}
      {e.claim && <div className="mt-2 text-[13px] text-muted">{e.claim}</div>}
      {!attestation && e.context && <InContext quote={e.quote} context={e.context} />}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        {e.verified ? (
          <Chip tone="strong">
            <BadgeCheck className="size-3" />{" "}
            {attestation
              ? "Reproducible search"
              : e.match === "fuzzy"
                ? "Verified (source wording)"
                : e.match === "stitched"
                  ? "Verified (excerpts joined; see context)"
                  : "Quote verified"}
          </Chip>
        ) : (
          <Chip tone="fair">
            <CircleHelp className="size-3" /> Not verified
          </Chip>
        )}
        {stance && <Chip tone={stance.tone}>{stance.label}</Chip>}
        {cls && <Chip>{CLASS_LABEL[cls] ?? cls}</Chip>}
        <span className="min-w-0 truncate">{src?.title ?? "Source"}</span>
        {src?.date && <span>· {fmtDate(src.date)}</span>}
        {link && (
          <a href={link} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-fg-3 hover:text-fg">
            {hostOf(link)} <ExternalLink className="size-3" />
          </a>
        )}
      </div>
    </div>
  );
}
