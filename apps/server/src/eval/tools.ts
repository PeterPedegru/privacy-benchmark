import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { findCriterion } from "@pb/rubric";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type DB, query, schema } from "../db/index.ts";
import { exaSearch, type FoundDoc, hasExa, hasNews, hasX, newsSearch, normalizeHandle, postsToMarkdown, xPosts, xSearch } from "../lib/externals.ts";
import { fetchPage } from "../lib/extract.ts";
import { safeFetch } from "../lib/fetcher.ts";
import { agentGhHeaders, agentGithubToken, agentMayReadRepo, rawFileUrl, safeRepoPath, sanitizeCodeSearch } from "../lib/github.ts";
import { newId } from "../lib/ids.ts";
import { inspectAddress, readFunction } from "../lib/rpc.ts";
import { lookupSourcify, renderSourcify, sourcifyUrl } from "../lib/sourcify.ts";
import { auditorForUrl, classifyUrl } from "../services/classify.ts";
import { attestationFilterSql, kbOverview, kindFilterSql, type Section, searchSources, storeKbSource } from "../services/kb.ts";
import { assertBudget, capContent, MAX_REPORT_CHARS, maxCharsFor, noteWrite } from "../services/kb-store.ts";
import type { KbMeta } from "../services/lanes/context.ts";
import { fetchDefillamaProtocol, L2beatSlugError, readL2beatProject } from "../services/lanes/data.ts";
import { ownershipFor, ownershipRegistry } from "../services/ownership.ts";
import { findQuoteSource, normalizeText, verifyQuote } from "../services/quotes.ts";
import { ABSENCE_POLICY, absenceRefusal, patternMatcher } from "./absence.ts";
import type { Emit } from "./events.ts";

type ProjectRow = typeof schema.projects.$inferSelect;
type VersionRow = typeof schema.projectVersions.$inferSelect;
type SourceRow = typeof schema.sources.$inferSelect;
type SourceClassName = "code_onchain" | "independent" | "official_docs" | "third_party" | "marketing";

export const PAGE_CHARS = 14_000;
const SOURCE_KINDS = [
  "docs",
  "website",
  "code",
  "code_thirdparty",
  "changes",
  "announcement",
  "audit",
  "advisory",
  "incident",
  "forum",
  "registry",
  "attestation",
  "onchain",
  "l2beat",
  "defillama",
  "governance",
  "blog",
  "news",
  "analysis",
  "editor_note",
] as const;

export interface ToolContext {
  db: DB;
  evaluationId: string;
  project: ProjectRow;
  version: VersionRow | null;
  stage: string;
  /** Criteria this agent may record evidence for. */
  allowedCriteria: Set<string>;
  emit: Emit;
  evidenceCount: { n: number };
  /** Golden-set runs must not see editor notes (the labels were made from them). */
  excludeEditorNotes?: boolean;
  /** The skeptic's verdict per answer it was given (report_challenge); only "answer_holds" earns "skeptic checked". */
  challengeReports?: Map<string, { outcome: ChallengeOutcome; searched: string[] }>;
}

export type ChallengeOutcome = "answer_holds" | "evidence_against" | "not_examined";

export type ToolName =
  | "search_sources"
  | "kb_overview"
  | "evm_inspect"
  | "evm_read"
  | "exa_search"
  | "news_search"
  | "x_posts"
  | "x_search"
  | "fetch_page"
  | "read_source"
  | "list_sources"
  | "github_repo"
  | "github_list_files"
  | "github_read_file"
  | "github_search_code"
  | "sourcify_contract"
  | "defillama_protocol"
  | "l2beat_scaling"
  | "l2beat_privacy"
  | "record_evidence"
  | "record_absence"
  | "record_search"
  | "report_challenge";

type Schema = Anthropic.Tool["input_schema"];
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)): Schema =>
  ({ type: "object", properties, required, additionalProperties: false }) as Schema;
const str = (description: string) => ({ type: "string", description });

export function toolDefinitions(names: readonly ToolName[], criterionIds: string[]): Anthropic.Tool[] {
  const defs = allToolDefinitions(criterionIds);
  return names.map((n) => defs[n]);
}

export function allToolDefinitions(criterionIds: string[]): Record<ToolName, Anthropic.Tool> {
  return {
    search_sources: {
      name: "search_sources",
      description:
        "Full-text search across this project's knowledge base: its docs site, website, open-source code snapshot at the pinned version, release notes and diffs, X posts, news coverage, independent analyses and audits, and L2BEAT/DefiLlama data. Returns ranked passages with source ids. Search here first; then read_source for the full text. Use specific terms (function names, modifiers, contract names, 'pause', 'onlyOwner', 'viewing key', 'escape hatch').",
      input_schema: obj({
        query: str("Search terms"),
        kinds: {
          type: "array",
          items: { type: "string", enum: [...SOURCE_KINDS, "website", "announcement", "changes"] },
          description: "Optional filter by kind, e.g. ['code'] or ['docs']; [] for all",
        },
      }),
      strict: true,
    },
    kb_overview: {
      name: "kb_overview",
      description: "What the project's knowledge base contains (counts by kind, repository maps). Call this first.",
      input_schema: obj({}, []),
      strict: true,
    },
    evm_inspect: {
      name: "evm_inspect",
      description:
        "Inspect a deployed EVM contract: EIP-1967 proxy implementation/admin/beacon, owner/admin/governance, paused(), timelock delay, and Safe multisig signers and threshold when the address is a Safe. Use it to find out who actually holds admin keys. The result is stored as an onchain source you can quote.",
      input_schema: obj({
        chainId: { type: "integer", description: "1 Ethereum, 10 Optimism, 56 BNB, 137 Polygon, 8453 Base, 42161 Arbitrum, 11155111 Sepolia" },
        address: str("0x-prefixed address"),
      }),
      strict: true,
    },
    evm_read: {
      name: "evm_read",
      description:
        "Call any view/pure function on a deployed EVM contract, e.g. 'function hasRole(bytes32,address) view returns (bool)'. Args as strings. The result is stored as an onchain source you can quote.",
      input_schema: obj({
        chainId: { type: "integer" },
        address: str("0x-prefixed address"),
        signature: str("Human-readable function signature"),
        args: { type: "array", items: { type: "string" } },
      }),
      strict: true,
    },
    exa_search: {
      name: "exa_search",
      description:
        "Semantic web search with page text (Exa). Good for audits, incident post-mortems, security analyses and research write-ups. Results are stored as sources you can quote.",
      input_schema: obj({ query: str("What to find"), sinceDate: str("YYYY-MM-DD or ''") }),
      strict: true,
    },
    news_search: {
      name: "news_search",
      description: "Search news coverage and press releases (NewsAPI.ai). Results are stored as sources you can quote.",
      input_schema: obj({ keyword: str("Keyword or exact phrase"), sinceDate: str("YYYY-MM-DD or ''") }),
      strict: true,
    },
    x_posts: {
      name: "x_posts",
      description: "Read an account's own recent X posts (no replies or reposts), e.g. the project's announcements. Stored as a source you can quote.",
      input_schema: obj({ handle: str("X handle without @"), sinceDate: str("YYYY-MM-DD or ''") }),
      strict: true,
    },
    x_search: {
      name: "x_search",
      description: "Search recent public X posts (about the last 7 days), e.g. for live incidents or disputes. Stored as a source you can quote.",
      input_schema: obj({ query: str("X search query") }),
      strict: true,
    },
    fetch_page: {
      name: "fetch_page",
      description:
        "Fetch a public web page or PDF (docs, blog, audit report, forum, GitHub page) and store it as a source. Returns the source id, title and the first page of its text as markdown. The source's class (official docs, independent, marketing, code) is set from who publishes it; mirrors, AI summaries and pages about other projects aren't stored.",
      input_schema: obj({ url: str("Absolute http(s) URL") }),
      strict: true,
    },
    read_source: {
      name: "read_source",
      description: "Read another page of a source that is already stored (from fetch_page, github_read_file or the admin). Pages are 1-indexed.",
      // Strict tool schemas reject numeric constraints (minimum, maximum), so the range lives in the description.
      input_schema: obj({ sourceId: str("Source id"), page: { type: "integer", description: "Page number, starting at 1" } }),
      strict: true,
    },
    list_sources: {
      name: "list_sources",
      description:
        "List stored sources for this project (id, kind, class, pages, title, url), newest first, at most 150. Filter by kinds; use search_sources to find content.",
      input_schema: obj({ kinds: { type: "array", items: { type: "string", enum: SOURCE_KINDS }, description: "Kinds to list; [] for all" } }),
      strict: true,
    },
    github_repo: {
      name: "github_repo",
      description: "Metadata for a public GitHub repo: license, default branch, last push, archived flag, stars, recent releases.",
      input_schema: obj({ repo: str("owner/name") }),
      strict: true,
    },
    github_list_files: {
      name: "github_list_files",
      description:
        "List files and folders at a path in a public GitHub repo. Use an empty path for the root and an empty ref for the version under evaluation.",
      input_schema: obj({
        repo: str("owner/name"),
        path: str("Directory path, '' for root"),
        ref: str("Tag, branch or commit; '' for the pinned version or default branch"),
      }),
      strict: true,
    },
    github_read_file: {
      name: "github_read_file",
      description:
        "Read a file from a public GitHub repo and store it as a code source (sourceClass code_onchain). Use it to check contracts for pause, owner, upgrade, blocklist and timelock logic. An empty ref reads the tag of the version under evaluation (or the default branch).",
      input_schema: obj({ repo: str("owner/name"), path: str("File path"), ref: str("Tag, branch or commit; '' for the pinned version") }),
      strict: true,
    },
    github_search_code: {
      name: "github_search_code",
      description:
        "Search code in a public GitHub repo (e.g. 'pause', 'onlyOwner', 'upgradeTo', 'blacklist', 'timelock', 'viewingKey'). Needs a server GitHub token; if unavailable, use github_list_files and github_read_file.",
      input_schema: obj({ repo: str("owner/name"), query: str("Search terms") }),
      strict: true,
    },
    sourcify_contract: {
      name: "sourcify_contract",
      description: "Check whether a deployed contract's source is verified on Sourcify (exact or partial match).",
      input_schema: obj({ chainId: { type: "integer", description: "EVM chain id, e.g. 1 for Ethereum" }, address: str("0x-prefixed contract address") }),
      strict: true,
    },
    defillama_protocol: {
      name: "defillama_protocol",
      description: "Current value locked, chains and audits for a protocol on DefiLlama, by slug (e.g. railgun, privacy-pools, zama).",
      input_schema: obj({ slug: str("DefiLlama protocol slug") }),
      strict: true,
    },
    l2beat_scaling: {
      name: "l2beat_scaling",
      description:
        "L2BEAT scaling data for a rollup or chain: stage, risk rosette (state validation, data availability, exit window, sequencer and proposer failure) and value secured.",
      input_schema: obj({ slug: str("L2BEAT project slug, e.g. aztecnetwork or starknet") }),
      strict: true,
    },
    l2beat_privacy: {
      name: "l2beat_privacy",
      description:
        "L2BEAT's privacy-dashboard configuration for a project (adversary matrix, exit window, walkaway test, trusted setup), read from their public GitHub config and stored as an independent source.",
      input_schema: obj({ slug: str("L2BEAT privacy slug, e.g. railgun, privacy-pools, strk20, zama-cw") }),
      strict: true,
    },
    record_evidence: {
      name: "record_evidence",
      description:
        "Record evidence for rubric criteria: a list of items, so batch everything you've found in one call. Each quote must be copied verbatim from a stored source (search_sources / read_source / fetch_page / github_read_file output). Record evidence that cuts against a favorable answer too (stance 'contradicts'). Recording never counts against your research budget. The result says, per item, whether the quote was found in the source.",
      input_schema: obj({
        items: {
          type: "array",
          minItems: 1,
          description: "Evidence items, one per quote",
          items: obj({
            criterionId: { type: "string", enum: criterionIds.length ? criterionIds : ["none"], description: "Rubric criterion id" },
            sourceId: str("Id of the stored source the quote comes from"),
            quote: str("Verbatim text from the source, ideally one or two sentences"),
            claim: str("What this quote shows, in one plain sentence"),
            stance: {
              type: "string",
              enum: ["supports", "contradicts", "context"],
              description: "supports = backs a favorable (low-risk) answer; contradicts = shows a lever or weakness; context = neutral",
            },
          }),
        },
      }),
      strict: true,
    },
    record_absence: {
      name: "record_absence",
      description:
        "Show with a reproducible search that a POWER is absent from the code (no pause function, no blocklist, no upgrade path: favorable), or that a FEATURE is absent (no Tor support, no stealth addresses: counts against). The server searches every stored source in the scope for your patterns plus standard ones for the criterion (short patterns as whole words, longer ones as substrings). If nothing matches, it stores a search attestation listing exactly what was searched. If anything matches, you get the matching lines back to inspect and record instead. A power's absence is searched over the whole code snapshot. It can't show that something never happened (incidents, pauses, audits, usage): those need a dated statement from a source that tracks them. Recording never counts against your research budget.",
      input_schema: obj({
        criterionId: { type: "string", enum: criterionIds.length ? criterionIds : ["none"], description: "Rubric criterion id" },
        scope: {
          type: "string",
          enum: ["code", "docs"],
          description: "code = the code snapshot at the pinned version; docs = the docs and website pages in the knowledge base",
        },
        patterns: { type: "array", items: { type: "string" }, description: "Literal substrings to search for, e.g. ['pause', 'whenNotPaused', 'Pausable']" },
        claim: str("What the absence shows, in one plain sentence"),
      }),
      strict: true,
    },
    report_challenge: {
      name: "report_challenge",
      description:
        "Report your verdict on one answer you were asked to test: answer_holds (you searched and found nothing against it), evidence_against (you recorded evidence that it's wrong), or not_examined (you didn't get to it). Call it once per listed answer before finishing. Reporting never counts against your budget.",
      input_schema: obj({
        criterionId: { type: "string", enum: criterionIds.length ? criterionIds : ["none"], description: "Rubric criterion id of the answer" },
        outcome: { type: "string", enum: ["answer_holds", "evidence_against", "not_examined"], description: "Your verdict" },
        searched: { type: "array", items: { type: "string" }, description: "What you searched or read for this answer; [] if not examined" },
      }),
      strict: true,
    },
    record_search: {
      name: "record_search",
      description:
        'When a genuine search found nothing that settles a criterion, record what you searched. It\'s published next to the unknown answer as "not disclosed (searched: …)", so readers can tell a diligent search from a gap. List the queries you ran and the sources you read. Recording never counts against your research budget.',
      input_schema: obj({
        criterionId: { type: "string", enum: criterionIds.length ? criterionIds : ["none"], description: "Rubric criterion id" },
        searched: {
          type: "array",
          items: { type: "string" },
          description: "Each query run and each source read, e.g. 'search_sources: viewing key auditor', 'read docs.example.org/privacy'",
        },
        note: str("What you looked for and why nothing settled it, in one or two plain sentences"),
      }),
      strict: true,
    },
  };
}

// ---------- helpers ----------

function pageOf(text: string, page: number): { text: string; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(text.length / PAGE_CHARS));
  const p = Math.min(Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1), pages);
  return { text: text.slice((p - 1) * PAGE_CHARS, p * PAGE_CHARS), page: p, pages };
}

function hash(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

/**
 * Stores what an agent read (R3-REL-12, R3-SEC-8): text capped like a knowledge-base page, unchanged text not
 * rewritten (so the FTS index isn't churned), the project's byte budget enforced, and a knowledge-base or editor
 * row's text and classification never replaced by the agent's copy unless that row is empty.
 */
async function storeSource(
  ctx: ToolContext,
  input: { url: string; title: string; kind: string; sourceClass: string; content: string; status?: number; date?: string | null },
): Promise<SourceRow> {
  const existing = (
    await ctx.db
      .select()
      .from(schema.sources)
      .where(and(eq(schema.sources.projectId, ctx.project.id), eq(schema.sources.url, input.url)))
  )[0];
  // Pages at 300 KB, everything else (code, reports, verified sources) at 400 KB (R3-SEC-8).
  const content = capContent(input.content, Math.min(maxCharsFor(input.kind), MAX_REPORT_CHARS));
  const contentHash = hash(content);
  const now = new Date().toISOString();
  const values = {
    title: input.title.slice(0, 300),
    kind: input.kind,
    sourceClass: input.sourceClass,
    contentMd: content,
    contentHash,
    httpStatus: input.status ?? null,
    origin: "agent",
    date: input.date ?? null,
    fetchedAt: now,
  };
  if (existing) {
    // Admin and knowledge-base classification win over the agent's guess, and a re-fetch doesn't change who owns
    // the row (agents re-reading a KB page used to flip it to origin "agent").
    const owned = existing.origin === "admin" || existing.origin === "kb";
    const keep = owned ? { kind: existing.kind, sourceClass: existing.sourceClass, origin: existing.origin } : {};
    // The knowledge base's copy is what lanes and evidence rely on: an agent's extraction replaces it only when empty.
    // Onchain reads (evm://) are the exception: a later read of chain state is newer, not a different extraction.
    if (owned && (existing.contentLen ?? existing.contentMd.length) > 0 && !input.url.startsWith("evm://")) return existing;
    // Same text: nothing to write but the fetch time.
    if (existing.contentHash === contentHash && existing.contentMd.length > 0) {
      await ctx.db.update(schema.sources).set({ fetchedAt: now }).where(eq(schema.sources.id, existing.id));
      return { ...existing, fetchedAt: now };
    }
    const delta = content.length - (existing.contentLen ?? existing.contentMd.length);
    await assertBudget(ctx.db, ctx.project.id, delta);
    await ctx.db
      .update(schema.sources)
      .set({ ...values, ...keep })
      .where(eq(schema.sources.id, existing.id));
    noteWrite(ctx.project.id, delta);
    return { ...existing, ...values, ...keep };
  }
  await assertBudget(ctx.db, ctx.project.id, content.length);
  const row = { id: newId(), projectId: ctx.project.id, url: input.url, ...values };
  await ctx.db.insert(schema.sources).values(row);
  noteWrite(ctx.project.id, content.length);
  return row as SourceRow;
}

/** A knowledge-base row maintenance hid (`meta.stale`) or one from before the lanes existed (`legacy`, no lane). */
function hiddenKbRow(row: { origin: string; meta: Record<string, unknown> | null }): boolean {
  const m = row.meta ?? {};
  return row.origin === "kb" && (m.stale === true || m.legacy === true || !m.lane);
}

/**
 * fetch_page's store (R4-30). A stale or legacy knowledge-base row holds text maintenance retired, so it doesn't
 * count as owned and the page just fetched replaces it: in place when nothing cites the row (it becomes an agent row
 * with today's class and is searchable again), or as a new row when evidence cites it, which keeps the text its quotes
 * were checked against under a marked URL (`…#superseded-<id>`). Every other case is storeSource's.
 */
async function storeFetchedPage(ctx: ToolContext, input: Parameters<typeof storeSource>[1]): Promise<SourceRow> {
  const existing = (
    await ctx.db
      .select({ id: schema.sources.id, url: schema.sources.url, origin: schema.sources.origin, meta: schema.sources.meta })
      .from(schema.sources)
      .where(and(eq(schema.sources.projectId, ctx.project.id), eq(schema.sources.url, input.url)))
  )[0];
  if (existing && hiddenKbRow(existing)) {
    const [cited] = await query(ctx.db, sql`SELECT 1 FROM evidence WHERE source_id = ${existing.id} LIMIT 1`);
    if (cited) {
      await ctx.db
        .update(schema.sources)
        .set({ url: `${existing.url}#superseded-${existing.id}` })
        .where(eq(schema.sources.id, existing.id));
    } else {
      await ctx.db.execute(
        sql`UPDATE sources SET origin = 'agent', kind = ${input.kind}, source_class = ${input.sourceClass}, meta = meta - 'stale' - 'legacy' WHERE id = ${existing.id}`,
      );
    }
  }
  return storeSource(ctx, input);
}

function renderSource(src: SourceRow, requested = 1): string {
  const { text, page, pages } = pageOf(src.contentMd, requested);
  return `sourceId: ${src.id}\ntitle: ${src.title}\nurl: ${src.url}\nkind: ${src.kind} · class: ${src.sourceClass} · page ${page}/${pages}\n---\n${text || "(empty)"}`;
}

async function jsonGet(url: string, headers: Record<string, string> = {}, maxBytes?: number): Promise<unknown> {
  const res = await safeFetch(url, { headers: { accept: "application/json", ...headers }, maxBytes });
  if (res.status >= 400) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return JSON.parse(res.body.toString("utf8"));
}

/** GitHub API headers for agent tools: the agent token, never more (R3-SEC-5). */
function ghHeaders(): Record<string, string> {
  return agentGhHeaders();
}

/** The ref the knowledge base snapshotted a repo at (`kb_meta.lanes["code:<repo>"].ref`, without its "(sha)"). */
function kbRefFor(ctx: ToolContext, repo: string): string | null {
  const lanes = ((ctx.project.kbMeta ?? {}) as KbMeta).lanes ?? {};
  const hit = Object.entries(lanes).find(([k]) => k.toLowerCase() === `code:${repo.toLowerCase()}`)?.[1];
  const ref = hit?.ok ? hit.ref?.replace(/\s*\([0-9a-f]{6,40}\)\s*$/i, "").trim() : null;
  return ref || null;
}

/** The repo as configured (the knowledge base stores URLs with the configured casing). */
function canonicalRepo(ctx: ToolContext, repo: string): string {
  return ctx.project.githubRepos.find((r) => r.toLowerCase() === repo.toLowerCase()) ?? repo;
}

/** Refusal text when an agent asks for a repo outside the project's GitHub owners and the auditor allowlist. */
async function repoGuard(ctx: ToolContext, repo: string): Promise<string | null> {
  const owners = (await ownershipRegistry(ctx.db, ctx.project))?.githubOwners ?? [];
  if (agentMayReadRepo(repo, owners)) return null;
  return `Not read: ${repo} isn't one of the project's GitHub owners (${owners.join(", ") || "none configured"}) or an auditor's report repository. Use fetch_page for other public pages; its class is set from who publishes it.`;
}

/** owner/name with no "." or ".." segments, so it can't walk to other GitHub API endpoints with the server's token. */
const REPO_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const validRepo = (r: string) => {
  const parts = r.split("/");
  return parts.length === 2 && parts.every((p) => REPO_SEGMENT.test(p));
};

let l2beatCache: { at: number; data: Record<string, unknown> } | null = null;

// ---------- executors ----------

async function storeFound(ctx: ToolContext, docs: FoundDoc[], lane: "news" | "analysis", section: Section): Promise<string> {
  const own = await ownershipFor(ctx.db, ctx.project);
  const lines: string[] = [];
  let dropped = 0;
  for (const d of docs) {
    if (!d.text || d.text.length < 100) continue;
    // Who publishes it decides the class (project, auditor, independent), and irrelevant or junk results
    // (mirrors, AI summaries, other projects) are dropped instead of stored as "independent".
    const c = classifyUrl(d.url, lane, { ...own, title: d.title, text: d.text, requireRelevance: true });
    if (c.drop) {
      dropped++;
      continue;
    }
    const id = await storeKbSource(ctx.db, ctx.project.id, {
      url: d.url,
      title: d.title,
      kind: c.kind,
      sourceClass: c.sourceClass,
      content: d.text,
      date: d.publishedAt?.slice(0, 10) ?? null,
      meta: { section: c.kind === "audit" ? ("audits" as Section) : section, lane: "agent" },
    });
    lines.push(
      `- ${id} · ${c.sourceClass} · ${d.publishedAt?.slice(0, 10) ?? "undated"} · ${d.title.slice(0, 100)} · ${d.url}\n  ${d.text.slice(0, 280).replace(/\s+/g, " ")}…`,
    );
  }
  const note = dropped ? `\n(${dropped} irrelevant or untrustworthy results were dropped.)` : "";
  return lines.length ? `Stored ${lines.length} sources:\n${lines.join("\n")}${note}` : `No usable results.${note}`;
}

export async function runTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  switch (name) {
    case "kb_overview":
      return kbOverview(ctx.db, ctx.project.id, { excludeEditorNotes: ctx.excludeEditorNotes });
    case "search_sources": {
      const kinds = Array.isArray(input.kinds) ? (input.kinds as string[]).filter(Boolean) : [];
      // Only this evaluation's attestations are searchable; older runs' absence claims aren't evidence (R3-SRC-6).
      const hits = await searchSources(ctx.db, ctx.project.id, String(input.query ?? ""), {
        kinds,
        limit: 25,
        excludeEditorNotes: ctx.excludeEditorNotes,
        evaluationId: ctx.evaluationId ?? null,
      });
      if (!hits.length) return "No matches. Try other terms, or fetch the page you need.";
      return hits.map((h) => `- ${h.id} · ${h.kind}/${h.sourceClass} · ${h.title.slice(0, 120)}\n  ${h.url}\n  ${h.snippet.replace(/\s+/g, " ")}`).join("\n");
    }
    case "evm_inspect": {
      const out = await inspectAddress(Number(input.chainId), String(input.address));
      const src = await storeSource(ctx, {
        url: `evm://${Number(input.chainId)}/${String(input.address).toLowerCase()}#inspect`,
        title: `Onchain inspection · chain ${Number(input.chainId)} · ${input.address}`,
        kind: "code",
        sourceClass: "code_onchain",
        content: out,
        date: new Date().toISOString().slice(0, 10),
      });
      return `sourceId: ${src.id}\n${out}`;
    }
    case "evm_read": {
      const args = Array.isArray(input.args) ? (input.args as unknown[]).map(String) : [];
      const out = await readFunction(Number(input.chainId), String(input.address), String(input.signature), args);
      const key = createHash("sha256")
        .update(`${input.signature}|${args.join(",")}`)
        .digest("hex")
        .slice(0, 10);
      const src = await storeSource(ctx, {
        url: `evm://${Number(input.chainId)}/${String(input.address).toLowerCase()}#${key}`,
        title: `Onchain read · chain ${Number(input.chainId)} · ${input.address} · ${String(input.signature).slice(0, 60)}`,
        kind: "code",
        sourceClass: "code_onchain",
        content: out,
        date: new Date().toISOString().slice(0, 10),
      });
      return `sourceId: ${src.id}\n${out}`;
    }
    case "exa_search": {
      if (!hasExa()) return "Exa isn't configured (EXA_API_KEY). Use the knowledge base or web_search.";
      const docs = await exaSearch(String(input.query), {
        numResults: 15,
        startPublishedDate: input.sinceDate ? `${input.sinceDate}T00:00:00Z` : undefined,
        excludeDomains: ["x.com", "twitter.com"],
      });
      return storeFound(ctx, docs, "analysis", "analysis");
    }
    case "news_search": {
      if (!hasNews()) return "News search isn't configured (NEWSAPI_AI_KEY).";
      const docs = await newsSearch(String(input.keyword), { dateStart: String(input.sinceDate || "") || undefined, count: 20 });
      return storeFound(ctx, docs, "news", "news");
    }
    case "x_posts": {
      if (!hasX()) return "X isn't configured (X_BEARER_TOKEN).";
      const handle = normalizeHandle(String(input.handle));
      if (!handle) return "Invalid handle.";
      const posts = await xPosts(handle, { max: 200, sinceIso: input.sinceDate ? `${input.sinceDate}T00:00:00Z` : undefined });
      if (!posts.length) return "No posts found.";
      // Only the project's verified account counts as its announcements; anyone else's posts are third-party
      // social media (partners, fans, critics) and are labelled that way.
      const own = !!ctx.project.xHandle && ctx.project.xHandle.toLowerCase() === handle.toLowerCase();
      const src = await storeSource(ctx, {
        url: `https://x.com/${handle}#posts-${new Date().toISOString().slice(0, 10)}`,
        title: `X posts by @${handle}${own ? "" : " (not the project's account)"} (${posts.length}, fetched ${new Date().toISOString().slice(0, 10)})`,
        kind: own ? "announcement" : "news",
        sourceClass: "marketing",
        content: postsToMarkdown(posts),
        date: posts[0]?.createdAt.slice(0, 10) ?? null,
      });
      return renderSource(src);
    }
    case "x_search": {
      if (!hasX()) return "X isn't configured (X_BEARER_TOKEN).";
      const posts = await xSearch(String(input.query), 50);
      if (!posts.length) return "No recent posts found.";
      const src = await storeSource(ctx, {
        url: `https://x.com/search?q=${encodeURIComponent(String(input.query))}#${new Date().toISOString().slice(0, 13)}`,
        title: `X search “${String(input.query).slice(0, 60)}” (${posts.length} posts)`,
        kind: "news",
        sourceClass: "marketing",
        content: postsToMarkdown(posts),
        date: new Date().toISOString().slice(0, 10),
      });
      return renderSource(src);
    }
    case "fetch_page": {
      const url = String(input.url ?? "");
      // A long query string is how injected instructions smuggle context out (R3-SEC-5).
      try {
        const u = new URL(url);
        if (u.search.length > 200) return "Not fetched: the URL's query string is too long. Fetch the page without its query parameters.";
        // Data can leave in a path as easily as in a query string.
        if (url.length > 1024 || u.pathname.length > 600) return "Not fetched: the URL is too long.";
      } catch {
        return "Invalid URL.";
      }
      const page = await fetchPage(url);
      if (page.status >= 400) return `Fetch failed with HTTP ${page.status} for ${url}.`;
      // The class comes from who publishes the page, never from the agent's label (a page can't promote itself
      // to "independent" by saying so). Its links let a domain named after the project prove it's the project's.
      const c = classifyUrl(page.url, "agent", {
        ...(await ownershipFor(ctx.db, ctx.project)),
        title: page.title,
        text: page.markdown.slice(0, 6000),
        links: page.meta.links.map((l) => l.href),
      });
      if (c.drop) return `Not stored: ${c.drop}. Find a primary source instead.`;
      const src = await storeFetchedPage(ctx, {
        url: page.url,
        title: page.title,
        kind: c.kind,
        sourceClass: c.sourceClass,
        content: page.markdown,
        status: page.status,
      });
      ctx.emit("info", ctx.stage, `Fetched ${page.title.slice(0, 80)}`, { url: page.url, sourceId: src.id });
      const thin =
        page.markdown.length < 500
          ? "\n\nNote: very little text was extracted (the page may need JavaScript). Look for a docs or GitHub version of this content."
          : "";
      return renderSource(src) + thin;
    }
    case "read_source": {
      const src = (
        await ctx.db
          .select()
          .from(schema.sources)
          .where(and(eq(schema.sources.id, String(input.sourceId)), eq(schema.sources.projectId, ctx.project.id)))
      )[0];
      if (!src || (ctx.excludeEditorNotes && src.kind === "editor_note")) return "No stored source with that id for this project. Use list_sources.";
      return renderSource(src, Number(input.page ?? 1));
    }
    case "list_sources": {
      // Metadata only (content_len, not the content): a knowledge base can hold thousands of rows. The advertised
      // kinds map to what rows carry (incident/advisory subkinds, forum topics, the registry); stale rows and other
      // evaluations' attestations are hidden, as in search (R3-SRC-6).
      const kinds = Array.isArray(input.kinds) ? (input.kinds as string[]).filter(Boolean) : [];
      const kf = kindFilterSql(kinds);
      const att = attestationFilterSql(ctx.evaluationId ?? null);
      const rows = (
        await query<{ id: string; kind: string; sourceClass: string; title: string; url: string; len: number | null }>(
          ctx.db,
          sql`SELECT s.id, s.kind, s.source_class AS "sourceClass", s.title, s.url, s.content_len AS len FROM sources s
             WHERE s.project_id = ${ctx.project.id} ${kf ? sql`AND ${kf}` : sql``} AND ${att} AND NOT coalesce(s.meta->'stale' = 'true'::jsonb, false)
             ORDER BY s.fetched_at DESC LIMIT 150`,
        )
      ).filter((r) => !(ctx.excludeEditorNotes && r.kind === "editor_note"));
      if (!rows.length) return "No sources stored yet.";
      return `${rows
        .map((s) => `${s.id} · ${s.kind}/${s.sourceClass} · ${Math.max(1, Math.ceil((s.len ?? 0) / PAGE_CHARS))}p · ${s.title.slice(0, 80)} · ${s.url}`)
        .join("\n")}${rows.length === 150 ? "\n(newest 150 shown; filter by kinds, or use search_sources)" : ""}`;
    }
    case "github_repo": {
      const repo = String(input.repo);
      if (!validRepo(repo)) return "Invalid repo; use owner/name.";
      const refused = await repoGuard(ctx, repo);
      if (refused) return refused;
      const r = (await jsonGet(`https://api.github.com/repos/${repo}`, ghHeaders())) as Record<string, unknown>;
      let releases: { tag_name: string; published_at: string; name: string }[] = [];
      try {
        releases = ((await jsonGet(`https://api.github.com/repos/${repo}/releases?per_page=5`, ghHeaders())) as typeof releases) ?? [];
      } catch {
        // releases are optional
      }
      return JSON.stringify(
        {
          full_name: r.full_name,
          description: r.description,
          license: (r.license as { spdx_id?: string } | null)?.spdx_id ?? null,
          default_branch: r.default_branch,
          pushed_at: r.pushed_at,
          archived: r.archived,
          stars: r.stargazers_count,
          open_issues: r.open_issues_count,
          recent_releases: releases.map((x) => ({ tag: x.tag_name, name: x.name, published_at: x.published_at })),
        },
        null,
        2,
      );
    }
    case "github_list_files": {
      const repo = canonicalRepo(ctx, String(input.repo));
      if (!validRepo(repo)) return "Invalid repo; use owner/name.";
      const refused = await repoGuard(ctx, repo);
      if (refused) return refused;
      // The pinned tag belongs to the version's repo only; otherwise the ref the knowledge base snapshotted (R3-SRC-12),
      // else the default branch.
      const ref = String(input.ref || (ctx.version?.repo === repo ? ctx.version.tag : "") || kbRefFor(ctx, repo) || "");
      const asked = String(input.path ?? "").replace(/^\/+|\/+$/g, "");
      // Decoded and checked segment by segment: an encoded `..` can't reach other API endpoints with the token.
      const path = asked ? safeRepoPath(asked) : "";
      if (path === null) return "Give a directory path inside the repository (no '.' or '..' segments).";
      const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const list = (await jsonGet(`https://api.github.com/repos/${repo}/contents/${path}${q}`, ghHeaders())) as {
        name: string;
        type: string;
        path: string;
        size: number;
      }[];
      if (!Array.isArray(list)) return "That path is a file; use github_read_file.";
      return `${ref ? `At ${ref}:\n` : ""}${list.map((f) => `${f.type === "dir" ? "📁" : "📄"} ${f.path}${f.type === "file" ? ` (${f.size} B)` : ""}`).join("\n")}`;
    }
    case "github_read_file": {
      const repo = canonicalRepo(ctx, String(input.repo));
      if (!validRepo(repo)) return "Invalid repo; use owner/name.";
      const refused = await repoGuard(ctx, repo);
      if (refused) return refused;
      // Decoded and re-encoded segment by segment: `%2e%2e` can't walk out of the repo (and pass another repo's file
      // off as the project's).
      const encoded = safeRepoPath(String(input.path ?? ""));
      if (!encoded) return "Give a file path inside the repository (no '.' or '..' segments).";
      const path = decodeURIComponent(encoded);
      const pinned = ctx.version?.repo === repo ? ctx.version.tag : null;
      // With no version pinned, read the ref the knowledge base snapshotted, not HEAD (R3-SRC-12).
      const kbRef = kbRefFor(ctx, repo);
      const ref = String(input.ref || pinned || kbRef || "HEAD");
      const url = `https://github.com/${repo}/blob/${ref}/${path}`;
      if (!input.ref || ref === pinned || ref === kbRef) {
        // The knowledge base usually has this file already at the right ref: look it up by its exact URL instead of
        // loading every code row (R3-REL-17).
        const snap = (
          await ctx.db
            .select()
            .from(schema.sources)
            .where(and(eq(schema.sources.projectId, ctx.project.id), eq(schema.sources.url, url)))
        )[0];
        if (snap && (snap.contentLen ?? snap.contentMd.length) > 0) return renderSource(snap);
      }
      const raw = rawFileUrl(repo, ref, path);
      if (!raw) return "Not read: that path or ref would leave the repository.";
      const token = agentGithubToken();
      const res = await safeFetch(raw, { maxBytes: 8 * 1024 * 1024, headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (res.status >= 400) return `Could not read ${path} at ${ref} (HTTP ${res.status}). Check the path with github_list_files.`;
      const content = res.body.toString("utf8");
      // Who owns the repo decides the class (R3-JDG-6, R3-SEC-4): the project's own repos follow the classifier (code
      // is code_onchain, prose official docs, a kept audit report official docs); an auditor's report repo is
      // independent; any other repo is third-party code, never the project's.
      const own = await ownershipFor(ctx.db, ctx.project);
      const ownerOk = own.registry.githubOwners.includes(repo.split("/")[0]!.toLowerCase());
      let kind: string;
      let sourceClass: SourceClassName;
      if (ownerOk) {
        const c = classifyUrl(url, "agent", { ...own, title: path, text: content.slice(0, 6000) });
        kind = c.kind;
        sourceClass = c.sourceClass;
      } else if (auditorForUrl(url)) {
        kind = "audit";
        sourceClass = "independent";
      } else {
        kind = "code_thirdparty";
        // Code4rena files other than the published report are unjudged submissions.
        sourceClass = /^code-423n4\//i.test(repo) ? "third_party" : "independent";
      }
      const src = await storeSource(ctx, { url, title: `${repo}/${path}@${ref}`, kind, sourceClass, content, status: res.status });
      ctx.emit("info", ctx.stage, `Read ${repo}/${path}@${ref}`, { sourceId: src.id });
      return renderSource(src);
    }
    case "github_search_code": {
      if (!agentGithubToken()) return "Code search needs a GitHub token on the server. Use github_list_files and github_read_file instead.";
      const repo = String(input.repo);
      if (!validRepo(repo)) return "Invalid repo; use owner/name.";
      const refused = await repoGuard(ctx, repo);
      if (refused) return refused;
      // Qualifiers, boolean operators and grouping could widen the search beyond this repo (R3-SEC-5).
      const terms = sanitizeCodeSearch(String(input.query).slice(0, 400));
      if (!terms) return "Give search terms.";
      const q = encodeURIComponent(`${terms} repo:${repo}`);
      const r = (await jsonGet(`https://api.github.com/search/code?q=${q}&per_page=20`, ghHeaders())) as { items?: { path: string }[] };
      const items = r.items ?? [];
      return items.length ? items.map((i) => i.path).join("\n") : "No matches.";
    }
    case "sourcify_contract": {
      const address = String(input.address);
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return "Invalid address.";
      const chainId = Number(input.chainId);
      const c = await lookupSourcify(chainId, address, { sources: true });
      if (!c || !c.match) return `Not verified on Sourcify (chain ${chainId}, ${address}).`;
      // Verified deployed source is the strongest evidence of what the live contract can do.
      const src = await storeSource(ctx, {
        url: sourcifyUrl(chainId, address),
        title: `Sourcify · ${c.name ?? address} (chain ${chainId}${c.proxy?.isProxy ? `, ${c.proxy.type ?? "proxy"}` : ""})`,
        kind: "code",
        sourceClass: "code_onchain",
        content: renderSourcify(c),
        date: c.verifiedAt?.slice(0, 10) ?? null,
      });
      ctx.emit("info", ctx.stage, `Read verified source for ${c.name ?? address} on chain ${chainId}`, { sourceId: src.id });
      return renderSource(src);
    }
    case "defillama_protocol": {
      const slug = String(input.slug).replace(/[^a-z0-9-]/gi, "");
      // Cached per slug for an hour and stripped of the TVL history (R3-SEC-10).
      const r = (await fetchDefillamaProtocol(slug)) as unknown as Record<string, unknown>;
      const current = (r.currentChainTvls ?? {}) as Record<string, number>;
      const total = Object.entries(current)
        .filter(([k]) => !k.includes("-") && !["borrowed", "staking", "pool2"].includes(k))
        .reduce((s, [, v]) => s + (v ?? 0), 0);
      const summary = {
        name: r.name,
        category: r.category,
        chains: r.chains,
        tvlUsd: Math.round(total),
        currentChainTvls: current,
        audits: r.audits,
        audit_links: r.audit_links,
        url: r.url,
      };
      await storeSource(ctx, {
        url: `https://defillama.com/protocol/${slug}`,
        title: `DefiLlama · ${String(r.name ?? slug)}`,
        kind: "defillama",
        sourceClass: "independent",
        content: JSON.stringify(summary, null, 2),
        date: new Date().toISOString().slice(0, 10),
      });
      return JSON.stringify(summary, null, 2);
    }
    case "l2beat_scaling": {
      if (!l2beatCache || Date.now() - l2beatCache.at > 3600_000) {
        const data = (await jsonGet("https://l2beat.com/api/scaling/summary")) as { projects?: Record<string, unknown> };
        l2beatCache = { at: Date.now(), data: data.projects ?? {} };
      }
      const slug = String(input.slug);
      const p = l2beatCache.data[slug] as Record<string, unknown> | undefined;
      if (!p) return `L2BEAT has no scaling project "${slug}". Known slugs include: ${Object.keys(l2beatCache.data).slice(0, 40).join(", ")}…`;
      const content = JSON.stringify({ name: p.name, stage: p.stage, category: p.category, risks: p.risks, tvs: p.tvs, badges: p.badges }, null, 2);
      const src = await storeSource(ctx, {
        url: `https://l2beat.com/scaling/projects/${slug}`,
        title: `L2BEAT · ${String(p.name ?? slug)}`,
        kind: "l2beat",
        sourceClass: "independent",
        content,
        date: new Date().toISOString().slice(0, 10),
      });
      return renderSource(src);
    }
    case "l2beat_privacy": {
      const slug = String(input.slug).replace(/[^a-z0-9-]/gi, "");
      let proj: Awaited<ReturnType<typeof readL2beatProject>>;
      try {
        proj = await readL2beatProject(slug);
      } catch (e) {
        return e instanceof L2beatSlugError ? e.message : `Couldn't read L2BEAT config for "${slug}": ${(e as Error).message}`;
      }
      const stored: SourceRow[] = [];
      for (const f of proj.files)
        stored.push(await storeSource(ctx, { url: f.url, title: f.title, kind: "l2beat", sourceClass: "independent", content: f.content }));
      ctx.emit("info", ctx.stage, `Read ${stored.length} L2BEAT files for ${slug}`);
      return `Stored ${stored.length} L2BEAT sources (${proj.contracts.length} discovered contracts):\n${stored.map((x) => `- ${x.id} · ${x.title}`).join("\n")}\nUse read_source to read them.`;
    }
    case "record_absence":
      return recordAbsence(input, ctx);
    case "record_search":
      return recordSearch(input, ctx);
    case "report_challenge": {
      const criterionId = String(input.criterionId);
      const outcome = String(input.outcome) as ChallengeOutcome;
      if (!ctx.challengeReports) return "Nothing to report in this stage.";
      if (!["answer_holds", "evidence_against", "not_examined"].includes(outcome)) return "outcome must be answer_holds, evidence_against or not_examined.";
      const searched = (Array.isArray(input.searched) ? input.searched : []).map((x) => String(x).slice(0, 200)).slice(0, 20);
      if (outcome === "answer_holds" && !searched.length) return "An answer can only hold after a search: list what you searched, or report not_examined.";
      ctx.challengeReports.set(criterionId, { outcome, searched });
      return `Reported ${outcome} for ${criterionId}.`;
    }
    case "record_evidence": {
      // Accepts a batch ({ items: [...] }); a bare single item is still understood.
      const items = Array.isArray(input.items) ? (input.items as Record<string, unknown>[]) : [input];
      if (!items.length) return "No items given. Pass items: [{ criterionId, sourceId, quote, claim, stance }, ...].";
      // One item at a time, yielding between them: verification can scan large sources, and the server keeps
      // answering public requests meanwhile.
      const out: string[] = [];
      for (const [i, item] of items.slice(0, 25).entries()) {
        if (i) await new Promise((r) => setImmediate(r));
        out.push(`${i + 1}. ${await recordEvidence(item, ctx)}`);
      }
      if (items.length > 25) out.push(`Only the first 25 items were processed; send the other ${items.length - 25} in another call.`);
      return out.join("\n");
    }
    default:
      return `Unknown tool ${name}`;
  }
}

async function recordEvidence(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const criterionId = String(input.criterionId);
  if (!findCriterion(criterionId) || !ctx.allowedCriteria.has(criterionId)) return `Criterion ${criterionId} is not part of this task.`;
  const src = (
    await ctx.db
      .select({
        id: schema.sources.id,
        url: schema.sources.url,
        kind: schema.sources.kind,
        sourceClass: schema.sources.sourceClass,
        contentMd: schema.sources.contentMd,
      })
      .from(schema.sources)
      .where(and(eq(schema.sources.id, String(input.sourceId)), eq(schema.sources.projectId, ctx.project.id)))
  )[0];
  if (!src || (ctx.excludeEditorNotes && src.kind === "editor_note"))
    return `Unknown sourceId ${String(input.sourceId)}. Quotes must come from stored sources (use the ids search_sources and read_source show).`;
  // An attestation is evidence only for the criterion and scope it was made for (by record_absence).
  if (src.kind === "attestation")
    return `Source ${src.id} is a search attestation. Attestations are recorded with record_absence for one criterion; quote the code or docs instead.`;
  const quote = String(input.quote ?? "").slice(0, 1200);
  let check = verifyQuote(quote, src.contentMd);
  let source = src;
  let note: string | null = null;
  if (!check.verified) {
    // Researchers often cite the page they were on instead of the one the text came from: look for the quote in
    // the project's other sources (full-text candidates first) before rejecting it.
    const words = normalizeText(quote)
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((w) => w.length > 3)
      .slice(0, 12)
      .join(" ");
    const ids = words ? (await searchSources(ctx.db, ctx.project.id, words, { limit: 12, excludeEditorNotes: ctx.excludeEditorNotes })).map((h) => h.id) : [];
    const candidates = ids.length
      ? await ctx.db
          .select({
            id: schema.sources.id,
            url: schema.sources.url,
            kind: schema.sources.kind,
            sourceClass: schema.sources.sourceClass,
            contentMd: schema.sources.contentMd,
          })
          .from(schema.sources)
          .where(
            and(
              eq(schema.sources.projectId, ctx.project.id),
              inArray(
                schema.sources.id,
                ids.filter((id) => id !== src.id),
              ),
            ),
          )
      : [];
    const found = findQuoteSource(
      quote,
      candidates.filter((c) => c.kind !== "attestation"),
    );
    if (found) {
      source = found.source;
      check = found.check;
      note = `re-attributed from ${src.id}`;
    }
  }
  if (!check.verified) {
    // Unverified quotes are not stored: they can't support an answer, and paraphrases clutter the public trail.
    ctx.emit("warn", ctx.stage, `Quote not found · ${criterionId}: ${String(input.claim ?? "").slice(0, 100)}`, { criterionId, sourceId: src.id });
    return `NOT recorded for ${criterionId}: ${check.reason ?? "quote not found"}${
      check.closest
        ? ` Closest passage in ${src.id}: «${check.closest.slice(0, 400)}». Copy the exact text and record it again.`
        : ` Re-read ${src.id} with read_source and copy the exact text.`
    }`;
  }
  const span = check.span ?? quote;
  // The same quote from the same source for the same criterion is one piece of evidence, however often it's sent.
  const dup = (
    await ctx.db
      .select({ id: schema.evidence.id, quote: schema.evidence.quote })
      .from(schema.evidence)
      .where(and(eq(schema.evidence.evaluationId, ctx.evaluationId), eq(schema.evidence.criterionId, criterionId), eq(schema.evidence.sourceId, source.id)))
  ).find((e) => normalizeText(e.quote) === normalizeText(span));
  if (dup) return `Already recorded as ${dup.id} for ${criterionId}.`;
  const id = newId();
  await ctx.db.insert(schema.evidence).values({
    id,
    evaluationId: ctx.evaluationId,
    criterionId,
    claim: String(input.claim ?? "").slice(0, 500),
    quote: span,
    agentQuote: span.trim() === quote.trim() ? null : quote,
    quoteContext: check.context ?? null,
    sourceId: source.id,
    url: source.url,
    stance: ["supports", "contradicts", "context"].includes(String(input.stance)) ? String(input.stance) : "context",
    sourceClass: source.sourceClass,
    verified: true,
    verifyMethod: check.method,
    verifyNote: [check.method === "fuzzy" ? `near match ${check.score.toFixed(2)}; stored the source's text` : null, note].filter(Boolean).join("; ") || null,
    createdByStage: ctx.stage,
  });
  ctx.evidenceCount.n++;
  ctx.emit("info", ctx.stage, `Evidence · ${criterionId}: ${String(input.claim ?? "").slice(0, 120)}`, { evidenceId: id, criterionId, verified: true });
  return `Recorded ${id} for ${criterionId} (quote verified, ${check.method}${check.method === "fuzzy" ? "; stored the source's exact wording" : ""}${note ? `; found in source ${source.id}, not ${src.id}` : ""}).`;
}

const MAX_ABSENCE_HITS = 12;

/**
 * Deterministic absence check: searches stored sources for literal patterns. Zero hits becomes a reproducible
 * attestation source (what was searched, where, when) plus supporting evidence quoting its result line. Any hit
 * is returned to the agent instead, so absence is never asserted while matching text exists.
 */
async function recordAbsence(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const criterionId = String(input.criterionId);
  if (!findCriterion(criterionId) || !ctx.allowedCriteria.has(criterionId)) return `Criterion ${criterionId} is not part of this task.`;
  const scope = input.scope === "docs" ? "docs" : "code";
  const refusal = absenceRefusal(criterionId, scope);
  if (refusal) return refusal;
  const policy = ABSENCE_POLICY[criterionId]!;
  const asked = (Array.isArray(input.patterns) ? input.patterns : []).map((p) => String(p).trim()).filter((p) => p.length >= 3 && p.length <= 80);
  if (!asked.length && !policy.patterns.length)
    return "Give 1–12 patterns of 3–80 characters (identifiers or phrases such as 'stealth address', 'viewing key').";
  // The standard patterns for the criterion are always searched: an agent can widen the search, not narrow it.
  const patterns = [...new Set([...policy.patterns, ...asked.slice(0, 12)])];
  const matchers = patterns.map((p) => ({ p, match: patternMatcher(p) }));
  // Always the whole snapshot: narrowing to some repos could miss where a power or feature lives (the client repo
  // for Tor support, say) (R4-21).
  const repos: string[] = [];
  const kinds = scope === "code" ? ["code"] : ["docs", "website", "blog"];
  const inScope = sql`project_id = ${ctx.project.id} AND kind IN (${sql.join(
    kinds.map((k) => sql`${k}`),
    sql`, `,
  )}) AND coalesce(meta->>'map', 'false') <> 'true' AND coalesce(meta->>'stale', 'false') <> 'true'`;
  // Metadata for every file in scope, and content only for files containing a pattern: the snapshot can be
  // hundreds of MB, and every match contains its pattern as plain lowercase text, so the database narrows it.
  const files = (
    await query<{ id: string; url: string; title: string; truncated: boolean }>(
      ctx.db,
      sql`SELECT id, url, title, right(content_md, 120) LIKE '%(truncated: the original was %' AS truncated FROM sources WHERE ${inScope}`,
    )
  ).filter((f) => !repos.length || repos.some((r) => f.url.startsWith(`https://github.com/${r}/`)));
  const minFiles = scope === "code" ? 5 : 10;
  if (files.length < minFiles)
    return `Only ${files.length} ${scope} sources are stored${repos.length ? ` for ${repos.join(", ")}` : ""}, too few to attest an absence. Read the relevant files first, or record what you can quote.`;
  const hits: string[] = [];
  // Truncated files were only partly searched; the attestation says so (R4-20).
  const truncated = files.filter((f) => f.truncated);
  const inFiles = new Set(files.map((f) => f.id));
  const candidates = (
    await query<{ id: string; title: string; contentMd: string }>(
      ctx.db,
      sql`SELECT id, title, content_md AS "contentMd" FROM sources WHERE ${inScope} AND (${sql.join(
        patterns.map((p) => sql`strpos(lower(content_md), ${p.toLowerCase()}) > 0`),
        sql` OR `,
      )})`,
    )
  ).filter((f) => inFiles.has(f.id));
  for (const f of candidates) {
    const lines = f.contentMd.split("\n");
    for (let i = 0; i < lines.length && hits.length < MAX_ABSENCE_HITS; i++) {
      const lower = lines[i]!.toLowerCase();
      const m = matchers.find((x) => x.match(lines[i]!, lower));
      if (m) hits.push(`- ${f.id} · ${f.title.slice(0, 80)} line ${i + 1} ("${m.p}"): ${lines[i]!.trim().slice(0, 160)}`);
    }
    if (hits.length >= MAX_ABSENCE_HITS) break;
  }
  if (hits.length)
    return `Not an absence: these stored sources match. Read them and record what they show (with record_evidence) instead.\n${hits.join("\n")}${hits.length >= MAX_ABSENCE_HITS ? "\n(more matches not shown)" : ""}`;
  const refs = [...new Set(files.map((f) => f.url.match(/github\.com\/[^/]+\/[^/]+\/blob\/([^/]+)\//)?.[1]).filter(Boolean))];
  const date = new Date().toISOString().slice(0, 10);
  const coverage = scope === "code" ? await coreContractCoverage(ctx, files) : null;
  const result = `Searched ${files.length} ${scope === "code" ? "code files" : "docs and website pages"} for ${patterns.map((p) => `"${p}"`).join(", ")} (case-insensitive): no file contains any of them.${coverage ? ` ${coverage}` : ""}${
    truncated.length
      ? ` ${truncated.length} file(s) were stored truncated and only partly searched: ${truncated
          .slice(0, 5)
          .map((f) => f.title.slice(0, 60))
          .join(", ")}.`
      : ""
  }`;
  const content = [
    `# Search attestation: ${findCriterion(criterionId)!.label}`,
    "",
    result,
    "",
    `Scope: ${scope}${repos.length ? ` in ${repos.join(", ")}` : ""}${refs.length ? ` at ${refs.join(", ")}` : ""}. Generated ${date} by the evaluation's deterministic search; anyone can repeat it on the same files.`,
    "",
    "Files searched:",
    ...files.map((f) => `- ${f.title} (${f.url})`),
  ].join("\n");
  const key = createHash("sha256")
    .update(`${criterionId}|${scope}|${patterns.join("|")}|${repos.join("|")}`)
    .digest("hex")
    .slice(0, 12);
  const src = await storeSource(ctx, {
    url: `attestation://${ctx.evaluationId}/${criterionId}/${key}`,
    title: `Search attestation · ${findCriterion(criterionId)!.label} · ${patterns.slice(0, 3).join(", ")}`,
    kind: "attestation",
    sourceClass: scope === "code" ? "code_onchain" : "official_docs",
    content,
    date,
  });
  const id = newId();
  await ctx.db.insert(schema.evidence).values({
    id,
    evaluationId: ctx.evaluationId,
    criterionId,
    claim: String(input.claim ?? "").slice(0, 500),
    quote: result,
    sourceId: src.id,
    url: src.url,
    // A missing power backs a favorable answer; a missing feature counts against one.
    stance: policy.favorableWhenAbsent ? "supports" : "contradicts",
    sourceClass: src.sourceClass,
    verified: true,
    verifyMethod: "exact",
    verifyNote: "search attestation",
    createdByStage: ctx.stage,
  });
  ctx.evidenceCount.n++;
  ctx.emit("info", ctx.stage, `Absence attested · ${criterionId}: ${result.slice(0, 120)}`, { evidenceId: id, criterionId, verified: true });
  return `Recorded attestation ${id} for ${criterionId}: ${result}`;
}

/**
 * Which core contracts named in the structured code map have a source file among those searched, so the judge
 * can tell when an attestation missed the contract that matters.
 */
async function coreContractCoverage(ctx: ToolContext, files: { url: string; title: string }[]): Promise<string | null> {
  const settings = (
    await ctx.db.select({ settings: schema.evaluations.settings }).from(schema.evaluations).where(eq(schema.evaluations.id, ctx.evaluationId))
  )[0]?.settings as { codeMap?: { contracts?: { name: string }[] } } | undefined;
  const names = [
    ...new Set((settings?.codeMap?.contracts ?? []).map((c) => /[A-Za-z_][A-Za-z0-9_]{2,}/.exec(c.name)?.[0]).filter((n): n is string => !!n)),
  ].slice(0, 40);
  if (!names.length) return null;
  const haystack = files.map((f) => `${f.url} ${f.title}`.toLowerCase());
  const missing = names.filter((n) => !haystack.some((h) => h.includes(n.toLowerCase())));
  return `Core contracts named in the code map with a source file among those searched: ${names.length - missing.length} of ${names.length}${missing.length ? ` (no file for ${missing.slice(0, 8).join(", ")})` : ""}.`;
}

/** A per-criterion search log for an unknown answer: published as "not disclosed (searched: …)" (R3-JDG-13). */
async function recordSearch(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const criterionId = String(input.criterionId);
  if (!findCriterion(criterionId) || !ctx.allowedCriteria.has(criterionId)) return `Criterion ${criterionId} is not part of this task.`;
  const searched = [
    ...new Set(
      (Array.isArray(input.searched) ? input.searched : []).map((s) => String(s).replace(/\s+/g, " ").trim().slice(0, 200)).filter((s) => s.length >= 3),
    ),
  ].slice(0, 20);
  if (searched.length < 2) return "List at least two searches or sources you actually tried.";
  const note = String(input.note ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  await ctx.db
    .delete(schema.searchLogs)
    .where(
      and(
        eq(schema.searchLogs.evaluationId, ctx.evaluationId),
        eq(schema.searchLogs.criterionId, criterionId),
        eq(schema.searchLogs.createdByStage, ctx.stage),
      ),
    );
  await ctx.db.insert(schema.searchLogs).values({ id: newId(), evaluationId: ctx.evaluationId, criterionId, searched, note, createdByStage: ctx.stage });
  ctx.emit("info", ctx.stage, `Not found · ${criterionId}: ${note.slice(0, 120)}`, { criterionId });
  return `Recorded the search for ${criterionId} (${searched.length} entries). If you later find evidence, record it: evidence replaces the log.`;
}
