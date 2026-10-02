/**
 * Audits lane (P0, SRC-17, SRC-8, R3-SRC-4): audit reports from the project's repos (`audit(s)/` folders, PDFs
 * included), DefiLlama `audit_links`, and undated Exa searches (PDF category, plus auditor sites). PDFs are
 * extracted through Exa `/contents` or pdf.js.
 *
 * - A report counts only when its first page names the project, because portfolio file names give false positives.
 *   A third-party document must also be anchored: an auditor detected, or the project's domain, repo or one of its
 *   contract addresses on page one. A name match alone (a case study about another "Tempo") is at most an analysis.
 * - Class follows the publisher (R3-SEC-4): `independent` only on the auditor's own host or report repository;
 *   the project's copy is `official_docs`; elsewhere `third_party`. The firm a document names is kept as
 *   `meta.audit.claimedAuditor`.
 * - One report, one row: copies of the same report (auditor PDF, repo markdown, a web stub) are grouped by auditor,
 *   month and text overlap; the best copy is kept and the others are listed in `meta.mirrors`.
 */

import { sql } from "drizzle-orm";
import { query } from "../../db/index.ts";
import { exaSearch, hasExa } from "../../lib/externals.ts";
import { fetchPage } from "../../lib/extract.ts";
import { stripDataUris } from "../../lib/extract-core.ts";
import { ghRaw } from "../../lib/github.ts";
import { extractPdf, extractPdfFromAnywhere } from "../../lib/pdf.ts";
import { AUDITORS, aliasMentions, auditorForUrl, canonicalKey, detectAuditor, githubParts, githubRawToBlob, normalizeUrl } from "../classify.ts";
import { keepAlive, purgeWhere, type Section, STALE } from "../kb-store.ts";
import { thirdPartyContract } from "./addresses.ts";
import { classify, counted, type LaneContext, mapLimit, storeFor } from "./context.ts";
import { CRYPTO } from "./news.ts";

export interface AuditMeta {
  /** The auditor, when the report is on its own host or report repository (the only verified attribution). */
  auditor: string | null;
  /** The auditor the file name or first page names (a claim). */
  claimedAuditor: string | null;
  date: string | null;
  commits: string[];
  scope: string | null;
  findings: Record<string, number> | null;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

function monthNum(m: string): string {
  const i = MONTHS.findIndex((x) => x.startsWith(m.toLowerCase().slice(0, 3)));
  return String(i + 1).padStart(2, "0");
}

const pad = (n: string | number) => String(n).padStart(2, "0");

/** The first plausible report date (YYYY-MM-DD or YYYY-MM) in a string. */
export function findDate(s: string): string | null {
  const iso = s.match(/\b(20[12]\d)[-_./](0[1-9]|1[0-2])[-_./](0[1-9]|[12]\d|3[01])\b/);
  const mdy = s.match(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20[12]\\d)\\b`, "i"));
  const dmy = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?,?\\s+(20[12]\\d)\\b`, "i"));
  const my = s.match(new RegExp(`\\b${MONTH_RE}\\.?,?\\s+(20[12]\\d)\\b`, "i"));
  const compact = s.match(/\b(20[12]\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/);
  const found: { at: number; v: string }[] = [];
  if (iso) found.push({ at: iso.index ?? 0, v: `${iso[1]}-${iso[2]}-${iso[3]}` });
  if (mdy) found.push({ at: mdy.index ?? 0, v: `${mdy[3]}-${monthNum(mdy[1]!)}-${pad(mdy[2]!)}` });
  if (dmy) found.push({ at: dmy.index ?? 0, v: `${dmy[3]}-${monthNum(dmy[2]!)}-${pad(dmy[1]!)}` });
  if (compact) found.push({ at: compact.index ?? 0, v: `${compact[1]}-${compact[2]}-${compact[3]}` });
  if (!found.length && my) found.push({ at: my.index ?? 0, v: `${my[2]}-${monthNum(my[1]!)}` });
  found.sort((a, b) => a.at - b.at);
  return found[0]?.v ?? null;
}

/** Auditor, date, audited commits, scope and finding counts parsed from a report. Pure and best-effort. */
export function parseAuditMeta(text: string, url = ""): AuditMeta {
  let file = "";
  try {
    file = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    // not a URL
  }
  const head = text.slice(0, 6000);
  // Where a report is published is the only attribution that can't be faked; the file name and text are claims.
  const auditor = auditorForUrl(url);
  const claimedAuditor = detectAuditor(file.replace(/[-_]/g, " ")) ?? detectAuditor(text);
  const date = findDate(file) ?? findDate(head);
  const commits = new Set<string>();
  const body = text.slice(0, 40_000);
  for (const m of body.matchAll(/\b(?:commit|commit hash|revision|sha|git ref)\b[^0-9a-f\n]{0,60}\b([0-9a-f]{7,40})\b/gi)) {
    const c = m[1]!.toLowerCase();
    if (/[a-f]/.test(c) && /\d/.test(c)) commits.add(c);
  }
  for (const m of body.matchAll(/\/(?:commit|tree)\/([0-9a-f]{40})\b/gi)) commits.add(m[1]!.toLowerCase());
  let scope: string | null = null;
  const sm = body.match(/^[ \t]*(?:#+[ \t]*)?(?:\d+(?:\.\d+)*\.?[ \t]+)?(?:audit[ \t]+|engagement[ \t]+)?scope\b.*$/im);
  if (sm?.index !== undefined) {
    const after = body.slice(sm.index + sm[0].length, sm.index + sm[0].length + 1200);
    const cut = after.search(/\n[ \t]*(#+[ \t]|\d+(\.\d+)*\.?[ \t]+[A-Z][a-z]+)/);
    scope = (cut > 40 ? after.slice(0, cut) : after.slice(0, 800)).replace(/\s+/g, " ").trim().slice(0, 800) || null;
  }
  const findings: Record<string, number> = {};
  for (const sev of ["critical", "high", "medium", "low", "informational"]) {
    const m = body.match(new RegExp(`\\b${sev}(?:[ \\t]+(?:severity|risk|issues?|findings?))?[ \\t]*[:|\\-–][ \\t]*(\\d{1,3})\\b`, "i"));
    if (m) findings[sev] = Number(m[1]);
  }
  return {
    auditor,
    claimedAuditor: claimedAuditor ?? auditor,
    date,
    commits: [...commits].slice(0, 5),
    scope,
    findings: Object.keys(findings).length >= 2 ? findings : null,
  };
}

/** Domains of the auditor allowlist, for Exa `includeDomains`. */
export function auditorDomains(): string[] {
  return [...new Set(AUDITORS.flatMap((a) => a.hosts.filter((h) => !h.includes("/"))))];
}

/** Looks like a security report (not a news piece that mentions an audit). */
/** Reports older than this many years describe code that has usually changed since: newer ones are what count. */
export const AUDIT_RECENT_YEARS = 3;
/** Older reports kept as history (the newest of them), however many exist. */
export const MAX_OLD_AUDITS = 2;

/** The date before which a report is old (YYYY-MM-DD). */
export function auditCutoff(now = Date.now()): string {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - AUDIT_RECENT_YEARS);
  return d.toISOString().slice(0, 10);
}

/**
 * Which report groups to keep: every recent or undated one, and only the newest `MAX_OLD_AUDITS` of those dated
 * before the cutoff. Returns the indexes to drop. Pure.
 */
export function oldAuditsToDrop(dates: (string | null)[], cutoff: string, keepOld = MAX_OLD_AUDITS): number[] {
  const old = dates
    .map((d, i) => ({ d, i }))
    .filter((x): x is { d: string; i: number } => !!x.d && x.d < cutoff)
    .sort((a, b) => b.d.localeCompare(a.d));
  return old.slice(keepOld).map((x) => x.i);
}

/** An auditor's homepage or listing page: it names its clients, it isn't a report. Pure. */
export function isListingPage(url: string): boolean {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, "");
    return p === "" || /^\/(audits?|portfolio|reports?|clients|case-studies|security-audits?|services|blog|news|research)$/i.test(p);
  } catch {
    return false;
  }
}

/** Industry reports (annual reviews, AML reports) mention many projects; they're analyses, never a project's audit. */
export const INDUSTRY_REPORT =
  /annual report|year in review|mid-year|half-year|quarterly report|industry report|state of (web3|crypto|defi|blockchain)|security and anti-money laundering|\baml\b.*\breport|hack(s|ing)? report|threat report|landscape report/i;

export function looksLikeAudit(text: string, minMarkers = 2): boolean {
  const head = text.slice(0, 8000);
  const markers = [
    /\baudit(ed|ing)? report\b|\bsecurity (review|assessment|audit)\b/i,
    /\bfindings?\b/i,
    /\b(critical|high|medium|low)\b[^\n]{0,40}\b(severity|risk|issues?)\b|\bseverity\b/i,
    /\bscope\b/i,
    /\b(commit|revision)\b[^\n]{0,40}\b[0-9a-f]{7,40}\b/i,
  ];
  return markers.filter((m) => m.test(head)).length >= minMarkers;
}

/**
 * Whether page one ties a document to this project beyond its name: one of its domains, its repo (owner/name, or a
 * repo name containing the project's name), or one of its contract addresses. Pure.
 */
export function anchoredToProject(firstPage: string, p: { domains: string[]; repos: string[]; tokens: string[]; addresses: string[] }): boolean {
  const t = firstPage.toLowerCase();
  if (p.domains.some((d) => d.includes(".") && t.includes(d.toLowerCase()))) return true;
  for (const r of p.repos) {
    const full = r.toLowerCase();
    if (t.includes(full)) return true;
    const name = (full.split("/")[1] ?? "").replace(/[-_.]/g, "");
    if (name.length >= 6 && p.tokens.some((tok) => tok.length >= 4 && name.includes(tok)) && t.replace(/[-_.]/g, "").includes(name)) return true;
  }
  for (const a of firstPage.match(/0x[0-9a-fA-F]{40}/g) ?? []) if (p.addresses.includes(a.toLowerCase())) return true;
  return false;
}

// ---------- de-duplication (pure) ----------

/** 3-word shingles of a report's normalized text (first 40,000 characters), for overlap tests. */
export function shingles(text: string): Set<string> {
  const words =
    stripDataUris(text.slice(0, 40_000))
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/** Share of the smaller set's shingles found in the larger one. */
export function containment(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (!small.size) return 0;
  let hit = 0;
  for (const s of small) if (large.has(s)) hit++;
  return hit / small.size;
}

export interface ReportCopy {
  /** Existing row id, when the copy is already stored. */
  id?: string;
  url: string;
  text: string;
  length: number;
  auditor: string | null;
  claimedAuditor: string | null;
  date: string | null;
  /** Higher is better: auditor-hosted > repo file at the snapshotted ref > other repo or project PDF > other. */
  rank: number;
}

/** Below this, a copy is a landing page or summary of a report rather than the report. */
const STUB_CHARS = 5000;

/**
 * Whether two copies are the same report: compatible auditor and month, and nearly the same text (a short web
 * stub needs only half of its text in the full report). Pure.
 */
export function sameReport(a: ReportCopy & { sh?: Set<string> }, b: ReportCopy & { sh?: Set<string> }): boolean {
  const wa = a.auditor ?? a.claimedAuditor;
  const wb = b.auditor ?? b.claimedAuditor;
  if (wa && wb && wa !== wb) return false;
  if (a.date && b.date && a.date.slice(0, 7) !== b.date.slice(0, 7)) return false;
  const c = containment(a.sh ?? shingles(a.text), b.sh ?? shingles(b.text));
  if (c >= 0.8) return true;
  return Math.min(a.length, b.length) < STUB_CHARS && !!wa && wa === wb && c >= 0.5;
}

/** Groups copies of the same report; each group's first element is the copy to keep. Pure. */
export function groupReports(copies: ReportCopy[]): ReportCopy[][] {
  const items = copies.map((c) => ({ ...c, sh: shingles(c.text) }));
  const score = (c: ReportCopy) => c.rank * 10 - (c.length < STUB_CHARS ? 100 : 0) + Math.min(9, c.length / 50_000);
  items.sort((x, y) => score(y) - score(x));
  const groups: (typeof items)[] = [];
  for (const it of items) {
    // Any member counts: a web stub overlaps the markdown copy more than the PDF's extracted text.
    const g = groups.find((grp) => grp.some((m) => sameReport(m, it)));
    if (g) g.push(it);
    else groups.push([it]);
  }
  return groups.map((g) => g.map(({ sh: _sh, ...c }) => c));
}

const AUDIT_ANY = /(^|\/)(audits?|audit-reports?|security-reviews?|security\/audits?)\/(?!.*\b(test|mock|example)s?\/).+\.(pdf|md)$/i;

interface Candidate {
  url: string;
  title: string;
  text?: string;
  via: string;
}

function auditTitle(original: string, meta: AuditMeta, project: string): string {
  const t = original.replace(/\s+/g, " ").trim();
  const firm = meta.auditor ?? meta.claimedAuditor;
  const informative = t.length >= 12 && !/\.(pdf|md)$/i.test(t) && !/^(smart contract audit|audit report|security review|untitled|[\w-]+_?)$/i.test(t);
  const prefix = `${firm ?? "Audit"}${meta.date ? ` (${meta.date})` : ""}`;
  if (informative && firm && t.toLowerCase().includes(firm.toLowerCase())) return t.slice(0, 300);
  return `${prefix}: ${informative ? t : `${project} security audit report`}`.slice(0, 300);
}

interface Accepted {
  url: string;
  title: string;
  text: string;
  kind: "audit" | "analysis";
  sourceClass: ReturnType<typeof classify>["sourceClass"];
  meta: AuditMeta;
  via: string;
  rank: number;
}

/** Audits lane. `full` runs the paid Exa searches; incremental runs re-read repo folders and DefiLlama links only. */
export async function ingestAudits(ctx: LaneContext, opts: { full: boolean; auditLinks: string[] }): Promise<{ count: number; note: string }> {
  const name = ctx.registry.aliases[0] ?? ctx.project.name;
  const candidates: Candidate[] = [];
  const keys = new Set<string>();
  const add = (c: Candidate) => {
    const n = normalizeUrl(githubRawToBlob(c.url), { keepQuery: true });
    if (!n) return;
    const k = canonicalKey(n);
    const file = decodeURIComponent(new URL(n).pathname.split("/").pop() ?? "").toLowerCase();
    const fk = /\.pdf$/.test(file) && file.length > 8 ? `file:${file}` : null;
    if (keys.has(k) || (fk && keys.has(fk))) return;
    keys.add(k);
    if (fk) keys.add(fk);
    candidates.push({ ...c, url: n });
  };

  // 1. Repo audit folders, at the snapshotted ref and on the default branch (reports are often added later).
  //    A report present at the snapshotted ref isn't read again from the default branch.
  for (const repo of ctx.shared.repos) {
    try {
      const meta = await ctx.gh.get<{ default_branch: string }>(`/repos/${repo}`);
      const refs = [...new Set([ctx.shared.repoRefs.get(repo), meta.default_branch].filter((r): r is string => !!r))];
      const seenPaths = new Set<string>();
      for (const ref of refs) {
        const tree = await ctx.gh.get<{ tree: { path: string; type: string; size?: number }[] }>(
          `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        );
        const files = tree.tree.filter((t) => t.type === "blob" && AUDIT_ANY.test(t.path) && !/(^|\/)(readme|index)\.md$/i.test(t.path)).slice(0, 25);
        for (const f of files) {
          if (seenPaths.has(f.path)) continue;
          seenPaths.add(f.path);
          add({ url: `https://github.com/${repo}/blob/${ref}/${f.path}`, title: f.path.split("/").pop() ?? f.path, via: "repo" });
        }
      }
    } catch (e) {
      ctx.log(`audits: couldn't list ${repo}: ${(e as Error).message}`);
    }
  }
  // 2. DefiLlama audit links.
  for (const l of opts.auditLinks.slice(0, 15)) add({ url: l, title: "", via: "defillama" });
  // 3. Undated Exa searches: PDFs anywhere, and auditor sites.
  if (opts.full && hasExa()) {
    // Recent reports are searched for on their own: an undated search is dominated by the oldest, most-linked ones.
    const recent = `${auditCutoff()}T00:00:00Z`;
    const queries: [string, Parameters<typeof exaSearch>[1]][] = [
      [`${name} security audit report`, { category: "pdf", numResults: 10, maxCharacters: 150_000 }],
      [`${name} smart contract security audit`, { includeDomains: auditorDomains(), numResults: 10, maxCharacters: 150_000 }],
      [`${name} security audit report`, { category: "pdf", startPublishedDate: recent, numResults: 10, maxCharacters: 150_000 }],
      [`${name} security review audit findings`, { includeDomains: auditorDomains(), startPublishedDate: recent, numResults: 10, maxCharacters: 150_000 }],
    ];
    for (const [q, o] of queries) {
      try {
        for (const r of await exaSearch(q, o)) add({ url: r.url, title: r.title, text: r.text, via: "exa" });
      } catch (e) {
        ctx.log(`audits: Exa search failed: ${(e as Error).message}`);
      }
    }
  }

  // What ties a third-party document to this project beyond its name.
  const anchors = {
    domains: [...ctx.registry.domains, ...ctx.registry.siteHosts],
    repos: ctx.shared.repos,
    tokens: ctx.registry.tokens,
    addresses: await knownAddresses(ctx),
  };
  const snapshotRefs = new Set([...ctx.shared.repoRefs.entries()].map(([repo, ref]) => `${repo}/blob/${ref}/`.toLowerCase()));
  const rankOf = (url: string, auditor: string | null, isPdf: boolean, owner: string): number => {
    if (auditor) return isPdf ? 5 : 4;
    if (owner === "project_github")
      return snapshotRefs.has(
        `${url
          .replace(/^https:\/\/github\.com\//, "")
          .split("/")
          .slice(0, 4)
          .join("/")}/`.toLowerCase(),
      )
        ? 3
        : 2;
    if (owner === "project" && isPdf) return 2;
    return isPdf ? 1 : 0;
  };

  const accepted: Accepted[] = [];
  let toAnalysis = 0;
  let rejected = 0;
  // Strongest sources first (auditor-hosted, then DefiLlama and Exa finds, then repo copies) so a repo with many
  // audit files can't crowd out the independent reports; 200 candidates in all.
  const viaRank: Record<string, number> = { exa: 2, defillama: 2, repo: 1 };
  const ordered = [...candidates].sort((a, b) => (auditorForUrl(b.url) ? 3 : (viaRank[b.via] ?? 0)) - (auditorForUrl(a.url) ? 3 : (viaRank[a.via] ?? 0)));
  await mapLimit(ordered.slice(0, 200), 4, async (c) => {
    try {
      let text = c.text ?? "";
      let title = c.title;
      // A dead link may be read from a mirror (another IPFS gateway, https): the report is stored at the one that works.
      let url = c.url;
      // A report the link already dates as old isn't worth looking for elsewhere when its link is dead.
      const hinted = findDate(`${decodeURIComponent(c.url)} ${c.title}`);
      const old = !!hinted && hinted < auditCutoff();
      const gh = githubParts(c.url);
      const ownRepo = !!gh && ctx.registry.githubOwners.includes(gh.owner.toLowerCase());
      if (!text || text.length < 500) {
        if (/\.pdf($|\?)/i.test(c.url)) {
          const pdf = old ? await extractPdf(c.url, { maxCharacters: 300_000 }) : await extractPdfFromAnywhere(c.url, { maxCharacters: 300_000 });
          url = pdf.url;
          text = pdf.text;
          title = title || pdf.title;
        } else if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\//.test(c.url)) {
          const m = c.url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([^/]+)\/(.+)$/)!;
          // The server token is for the project's own repos; links from DefiLlama or Exa are read anonymously.
          const body = await ghRaw(m[1]!, m[2]!, decodeURIComponent(m[3]!), 8 * 1024 * 1024, { token: ownRepo });
          text = body?.toString("utf8") ?? "";
        } else {
          const page = await fetchPage(c.url);
          if (page.status >= 400) return;
          text = page.markdown;
          title = title || page.title;
        }
      }
      // Embedded images (inline or reference-style base64) are noise for search and quoting.
      text = stripDataUris(text).slice(0, 400_000);
      if (text.length < 500) return;
      const fromRepo = c.via === "repo";
      const firstPage = `${title}\n${text.slice(0, 3000)}`;
      // Page 1 must name the project, and the document must read like a security report.
      if (!fromRepo && !aliasMentions(firstPage, ctx.registry.aliases).length) return;
      if (!looksLikeAudit(text)) return;
      const cls = classify(ctx, url, "audits", { title, text });
      if (cls.drop) return;
      const isPdf = /\.pdf($|\?)/i.test(url);
      // An auditor's homepage or portfolio names the project as a client; it isn't a report.
      if (!isPdf && !fromRepo && isListingPage(url)) {
        rejected++;
        return;
      }
      // An industry report that mentions the project is an analysis at most.
      if (!fromRepo && INDUSTRY_REPORT.test(`${title}\n${text.slice(0, 1500)}`)) {
        if (!CRYPTO.test(firstPage)) {
          rejected++;
          return;
        }
        toAnalysis++;
        accepted.push({
          url,
          title: title || url,
          text,
          kind: "analysis",
          sourceClass: cls.sourceClass,
          meta: parseAuditMeta(text, url),
          via: c.via,
          rank: -1,
        });
        return;
      }
      // The project's own web pages about audits are its blog, not reports; the blog and analysis lanes keep them.
      if (cls.owner === "project" && !isPdf) return;
      const meta = parseAuditMeta(text, url);
      const auditor = cls.auditor ?? meta.auditor;
      const claimed = cls.claimedAuditor ?? meta.claimedAuditor;
      const thirdParty = cls.owner !== "project" && cls.owner !== "project_github" && cls.owner !== "auditor";
      // A web page that isn't from an auditor counts as a report only when it says so and reads like one
      // (post-mortems go to analyses; audit-service landing pages are dropped).
      if (
        !auditor &&
        !fromRepo &&
        !isPdf &&
        (!/\baudit|security review|security assessment/i.test(`${title}\n${text.slice(0, 500)}`) || !looksLikeAudit(text, 3))
      )
        return;
      // A third-party document needs more than the project's name (R3-SRC-4): an auditor, or the project's domain,
      // repo or contract on page one. Otherwise it's at most an analysis, and only with crypto context.
      if (thirdParty && !auditor && !claimed && !anchoredToProject(firstPage, anchors)) {
        if (!CRYPTO.test(firstPage)) {
          rejected++;
          return;
        }
        toAnalysis++;
        accepted.push({ url, title: title || url, text, kind: "analysis", sourceClass: cls.sourceClass, meta, via: c.via, rank: -1 });
        return;
      }
      accepted.push({
        url,
        title: auditTitle(title, { ...meta, auditor, claimedAuditor: claimed }, ctx.project.name),
        text,
        kind: "audit",
        sourceClass: cls.sourceClass,
        meta: { ...meta, auditor, claimedAuditor: claimed },
        via: c.via,
        rank: rankOf(url, auditor, isPdf, cls.owner),
      });
    } catch (e) {
      ctx.log(`audits: skipped ${c.url}: ${(e as Error).message}`);
    }
  });

  // Group the accepted reports with the audit rows already stored (code lane copies, earlier Exa finds).
  const existing = (await query(
    ctx.db,
    sql`SELECT id, url, title, origin, source_class AS "sourceClass", substr(content_md, 1, 40000) AS text, content_len AS length,
              meta->>'lane' AS lane, meta#>>'{audit,auditor}' AS auditor,
              meta#>>'{audit,claimedAuditor}' AS "claimedAuditor", meta#>>'{audit,date}' AS date
       FROM sources WHERE project_id = ${ctx.project.id} AND kind = 'audit' AND origin = 'kb' AND coalesce(content_len, 0) > 0
         AND (NOT ${STALE} OR (meta->>'mirrorOf') IS NOT NULL)`,
  )) as unknown as {
    id: string;
    url: string;
    title: string;
    origin: string;
    sourceClass: string;
    text: string;
    length: number;
    lane: string | null;
    auditor: string | null;
    claimedAuditor: string | null;
    date: string | null;
  }[];
  // Rows kept from earlier runs get today's classes and gates: attribution comes from the host, not the text
  // (R3-SEC-4), and a third-party document stored by an older, looser run must still be tied to the project.
  const current = new Map(
    existing.map((e) => {
      const cls = classify(ctx, e.url, "audits", { title: e.title, text: e.text.slice(0, 3000) });
      const auditor = cls.auditor ?? auditorForUrl(e.url);
      return [e.id, { cls, auditor, claimed: e.claimedAuditor ?? cls.claimedAuditor ?? e.auditor ?? auditor }] as const;
    }),
  );
  const invalid = existing.filter((e) => {
    if (e.lane !== "audits") return false;
    const cur = current.get(e.id)!;
    if (cur.cls.drop) return true;
    const pdf = /\.pdf($|\?)/i.test(e.url);
    if (!pdf && isListingPage(e.url)) return true;
    if (!/github\.com\//.test(e.url) && INDUSTRY_REPORT.test(`${e.title}\n${e.text.slice(0, 1500)}`)) return true;
    const thirdParty = cur.cls.owner !== "project" && cur.cls.owner !== "project_github" && cur.cls.owner !== "auditor";
    return thirdParty && !cur.auditor && !cur.claimed && !anchoredToProject(`${e.title}\n${e.text.slice(0, 3000)}`, anchors);
  });
  for (const e of invalid) await purgeWhere(ctx.db, ctx.project.id, sql`id = ${e.id}`);
  const invalidIds = new Set(invalid.map((e) => e.id));
  const reclass = (cls: string, auditor: string | null, claimed: string | null, id: string) =>
    ctx.db.execute(
      sql`UPDATE sources SET source_class = ${cls},
        meta = meta || jsonb_build_object('audit', coalesce(meta->'audit', '{}'::jsonb) || jsonb_build_object('auditor', ${auditor}::text, 'claimedAuditor', ${claimed}::text))
        WHERE id = ${id} AND origin = 'kb'`,
    );
  const byUrl = new Map(existing.map((e) => [e.url, e]));
  const accUrls = new Set(accepted.map((a) => a.url));
  const copies: ReportCopy[] = [
    // A candidate that is already stored (the code lane's copy of a repo report) carries that row's id, so it can be
    // hidden when another copy wins.
    ...accepted
      .filter((a) => a.kind === "audit")
      .map((a) => ({
        ...(byUrl.has(a.url) ? { id: byUrl.get(a.url)!.id } : {}),
        url: a.url,
        text: a.text,
        length: a.text.length,
        auditor: a.meta.auditor,
        claimedAuditor: a.meta.claimedAuditor,
        date: a.meta.date,
        rank: a.rank,
      })),
    ...existing
      .filter((e) => !accUrls.has(e.url) && !invalidIds.has(e.id))
      .map((e) => {
        const cur = current.get(e.id)!;
        const isPdf = /\.pdf($|\?)/i.test(e.url);
        return {
          id: e.id,
          url: e.url,
          text: e.text,
          length: e.length,
          auditor: cur.auditor,
          claimedAuditor: cur.claimed,
          date: e.date,
          rank: rankOf(e.url, cur.auditor, isPdf, cur.cls.owner),
        };
      }),
  ];
  const grouped = groupReports(copies);
  // Old reports beyond the newest few describe superseded code: they're left out, and earlier copies purged.
  const dropIdx = new Set(
    oldAuditsToDrop(
      grouped.map((g) => g[0]!.date ?? null),
      auditCutoff(),
    ),
  );
  const groups = grouped.filter((_, i) => !dropIdx.has(i));
  const superseded = grouped.filter((_, i) => dropIdx.has(i)).flatMap((g) => g.map((c) => c.id).filter((id): id is string => !!id));
  if (superseded.length)
    await purgeWhere(
      ctx.db,
      ctx.project.id,
      // Only this lane's rows: a repo's own copy stays with its code.
      sql`meta->>'lane' = 'audits' AND id IN (${sql.join(
        superseded.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  let stored = 0;
  let mirrored = 0;
  const setMirrors = (mirrorsJson: string, id: string) =>
    ctx.db.execute(sql`UPDATE sources SET meta = meta || jsonb_build_object('mirrors', ${mirrorsJson}::jsonb) WHERE id = ${id}`);
  const hide = (mirrorOf: string, id: string) =>
    ctx.db.execute(
      sql`UPDATE sources SET meta = meta || jsonb_build_object('stale', true, 'mirrorOf', ${mirrorOf}::text) WHERE id = ${id} AND origin = 'kb' AND NOT ${STALE}`,
    );
  const clearMirrorStale = (id: string) =>
    ctx.db.execute(sql`UPDATE sources SET meta = meta - 'mirrorOf' - 'stale' WHERE id = ${id} AND (meta->>'mirrorOf') IS NOT NULL`);
  for (const g of groups) {
    const keep = g[0]!;
    const mirrors = g.slice(1).map((m) => m.url);
    mirrored += mirrors.length;
    let keepId = keep.id;
    const fresh = accepted.find((x) => x.url === keep.url && x.kind === "audit");
    if (fresh) {
      // Found this run: (re)store it with today's text and class. A copy the code lane owns stays the code lane's.
      const r = await storeFor(ctx, "audits", "audits", {
        url: fresh.url,
        title: fresh.title,
        kind: "audit",
        sourceClass: fresh.sourceClass,
        content: fresh.text,
        date: fresh.meta.date && fresh.meta.date.length === 10 ? fresh.meta.date : null,
        meta: { audit: fresh.meta, via: fresh.via, ...(mirrors.length ? { mirrors } : {}) },
      });
      keepId = r.id;
      if (counted(r.status)) stored++;
      if (r.status === "kept_stronger_lane") {
        await clearMirrorStale(r.id);
        await setMirrors(JSON.stringify(mirrors), r.id);
      }
    } else if (keep.id) {
      await clearMirrorStale(keep.id);
      await setMirrors(JSON.stringify(mirrors), keep.id);
      const cur = current.get(keep.id);
      const row = existing.find((e) => e.id === keep.id);
      if (cur && row && !cur.cls.drop && (row.sourceClass !== cur.cls.sourceClass || row.auditor !== cur.auditor))
        await reclass(cur.cls.sourceClass, cur.auditor ?? null, cur.claimed ?? null, keep.id);
      // An earlier run's copy chosen as the report: keep it through this run's prune.
      if (row?.lane === "audits") await keepAlive(ctx.db, ctx.project.id, "audits", ctx.runId, [keep.url]);
    }
    for (const m of g.slice(1)) if (m.id && m.id !== keepId) await hide(keep.url, m.id);
  }
  // Documents that read like reports but are only tied to the project by name are analyses (third-party).
  for (const a of accepted.filter((x) => x.kind === "analysis")) {
    const section: Section = "analysis";
    const r = await storeFor(ctx, "audits", section, {
      url: a.url,
      title: a.title,
      kind: "analysis",
      sourceClass: a.sourceClass,
      content: a.text,
      date: a.meta.date && a.meta.date.length === 10 ? a.meta.date : null,
      meta: { via: a.via, note: "reads like a report but nothing on page one ties it to the project beyond its name" },
    });
    if (counted(r.status)) stored++;
  }
  return {
    count: stored,
    note: `${groups.length} distinct reports${dropIdx.size ? `, ${dropIdx.size} older than ${AUDIT_RECENT_YEARS} years left out` : ""}${mirrored ? `, ${mirrored} copies kept as mirrors` : ""}${toAnalysis ? `, ${toAnalysis} name-only matches stored as analyses` : ""}${rejected || invalid.length ? `, ${rejected + invalid.length} rejected (nothing ties them to the project)` : ""}`,
  };
}

/** The project's contract addresses known so far: L2BEAT's discovered contracts and the last registry. */
async function knownAddresses(ctx: LaneContext): Promise<string[]> {
  const out = new Set(ctx.shared.discovered.map((c) => c.address.toLowerCase()));
  const [reg] = await query<{ c: string }>(
    ctx.db,
    sql`SELECT content_md AS c FROM sources WHERE project_id = ${ctx.project.id} AND url LIKE 'evm://registry/%' LIMIT 1`,
  );
  for (const a of reg?.c.match(/0x[0-9a-fA-F]{40}/g) ?? []) out.add(a.toLowerCase());
  // Tokens and infrastructure the docs mention say nothing about which project a document covers.
  return [...out].filter((a) => !thirdPartyContract(a));
}
