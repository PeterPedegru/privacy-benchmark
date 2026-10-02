/**
 * Data lane (SRC-10, P1 incidents): the whole L2BEAT config folder for the project (prose, config and a digest of
 * `discovered.json`, the best deployed-address source there is), the folder of the chain it runs on when that chain
 * is an L2BEAT-tracked network (STRK20 inherits Starknet's Security Council and sequencers, R3-SRC-15), L2BEAT's
 * scaling summary entry, DefiLlama's protocol summary (responses up to 64 MB, summarised and cached for an hour,
 * R3-SEC-10), and DefiLlama hacks that match the project, each with its post-mortem.
 */
import { fetchPage } from "../../lib/extract.ts";
import { safeFetch } from "../../lib/fetcher.ts";
import { encodePath, GithubError, GithubMemo, ghRaw } from "../../lib/github.ts";
import { aliasMentions, normalizeUrl } from "../classify.ts";
import { classify, counted, type DiscoveredContract, type LaneContext, mapLimit, storeFor } from "./context.ts";

const L2BEAT_REPO = "l2beat/l2beat";
const L2BEAT_DIR = "packages/config/src/projects";
const BIG = 64 * 1024 * 1024;

/** L2BEAT chain prefixes ("eth:0x…") → chain ids. */
export const L2BEAT_CHAINS: Record<string, number> = {
  eth: 1,
  arb1: 42161,
  oeth: 10,
  base: 8453,
  linea: 59144,
  scr: 534352,
  zksync2: 324,
  zkevm: 1101,
  matic: 137,
  bsc: 56,
  gno: 100,
  sep: 11155111,
  sepolia: 11155111,
  avax: 43114,
  blast: 81457,
  mantle: 5000,
  taiko: 167000,
  unichain: 130,
  ink: 57073,
  celo: 42220,
  // L2BEAT's tempo config: chainConfig { name: "tempo", chainId: 4217 }.
  tempo: 4217,
};

/** Levenshtein distance (small strings only). */
export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

/** The folder name closest to a wrong slug: shared name tokens first, then edit distance. Pure. */
export function closestSlug(slug: string, folders: string[], extraTokens: string[] = []): string | null {
  const tokens = [...new Set([...slug.toLowerCase().split(/[^a-z0-9]+/), ...extraTokens.map((t) => t.toLowerCase())])].filter((t) => t.length >= 3);
  let best: { f: string; score: number } | null = null;
  for (const f of folders) {
    const fl = f.toLowerCase();
    const shared = tokens.filter((t) => fl.includes(t) || t.includes(fl)).length;
    const score = shared * 10 - editDistance(slug.toLowerCase(), fl) / 4;
    if (!best || score > best.score) best = { f, score };
  }
  return best && best.score > 0 ? best.f : null;
}

type Entry = {
  name?: string;
  address: string;
  type?: string;
  proxyType?: string;
  description?: string;
  critical?: boolean;
  implementationNames?: Record<string, string>;
  values?: Record<string, unknown>;
  category?: { name?: string } | null;
};

type Discovered = {
  name?: string;
  timestamp?: number;
  entries?: Entry[];
  permissions?: Record<string, { receivedPermissions?: { permission?: string; from?: string; role?: string; description?: string; delay?: number }[] }>;
};

function splitAddress(a: string): { chain: string; chainId: number | null; address: string } {
  const m = a.match(/^([a-z0-9]+):(0x[0-9a-fA-F]{40})$/);
  if (!m) return { chain: "eth", chainId: 1, address: a };
  return { chain: m[1]!, chainId: L2BEAT_CHAINS[m[1]!] ?? null, address: m[2]! };
}

const addr = (v: unknown): string | null => (typeof v === "string" && /^([a-z0-9]+:)?0x[0-9a-fA-F]{40}$/.test(v) ? v : null);

/**
 * Compact digest of L2BEAT's `discovered.json`: one entry per contract with proxy type, implementation, admin,
 * owner, Safe threshold, role holders and the permissions L2BEAT attributes to each address. Pure.
 */
export function digestDiscovered(json: Discovered): { markdown: string; contracts: DiscoveredContract[] } {
  const entries = json.entries ?? [];
  const names = new Map<string, string>();
  for (const e of entries) if (e.name) names.set(e.address.toLowerCase(), e.name);
  const label = (a: string | null) => (a ? `${names.get(a.toLowerCase()) ? `${names.get(a.toLowerCase())} ` : ""}${splitAddress(a).address}` : "none");
  const contracts: DiscoveredContract[] = [];
  const lines: string[] = [
    `# L2BEAT discovered contracts · ${json.name ?? ""}`,
    `Snapshot: ${json.timestamp ? new Date(json.timestamp * 1000).toISOString().slice(0, 10) : "unknown"} · ${entries.length} addresses`,
    "",
  ];
  const sorted = [...entries].sort((a, b) => Number(!!b.critical) - Number(!!a.critical) || (a.type === "EOA" ? 1 : 0) - (b.type === "EOA" ? 1 : 0));
  for (const e of sorted) {
    const { chain, chainId, address } = splitAddress(e.address);
    const v = e.values ?? {};
    const impl = addr(v.$implementation) ?? (Array.isArray(v.$implementation) ? addr(v.$implementation[0]) : null);
    const admin = addr(v.$admin);
    const owner = addr(v.owner) ?? addr(v.getOwner) ?? addr(v.admin);
    const threshold = typeof v.$threshold === "number" ? v.$threshold : null;
    const members = Array.isArray(v.$members) ? v.$members.length : 0;
    const isSafe = /safe/i.test(e.proxyType ?? "") || threshold !== null;
    contracts.push({
      chainId,
      chain,
      address,
      name: e.name ?? null,
      proxyType: e.proxyType ?? null,
      implementation: impl ? splitAddress(impl).address : null,
      admin: admin ? splitAddress(admin).address : null,
      owner: owner ? splitAddress(owner).address : null,
      safe: isSafe ? { threshold, members } : null,
      critical: !!e.critical,
      description: e.description ?? null,
    });
    const head = `## ${e.name ?? (e.type === "EOA" ? "EOA" : "Unnamed contract")} · ${chain}:${address}`;
    const facts: string[] = [];
    facts.push(
      `- Type: ${e.type ?? "?"}${e.proxyType ? ` · ${e.proxyType}` : ""}${e.critical ? " · critical" : ""}${e.category?.name ? ` · ${e.category.name}` : ""}`,
    );
    if (e.description) facts.push(`- ${e.description}`);
    if (impl) {
      const implName = e.implementationNames?.[impl] ?? e.implementationNames?.[impl.toLowerCase()];
      facts.push(`- Implementation: ${implName ? `${implName} ` : ""}${splitAddress(impl).address}`);
    }
    if (admin && !/0x0{40}$/.test(admin)) facts.push(`- Proxy admin: ${label(admin)}`);
    if (owner) facts.push(`- Owner: ${label(owner)}`);
    if (isSafe) {
      facts.push(`- Safe: threshold ${threshold ?? "?"} of ${members} signers${typeof v.multisigThreshold === "string" ? ` (${v.multisigThreshold})` : ""}`);
      if (Array.isArray(v.GnosisSafe_modules) && v.GnosisSafe_modules.length)
        facts.push(`- Safe modules: ${(v.GnosisSafe_modules as string[]).map((m) => label(m)).join(", ")}`);
    }
    if (typeof v.$upgradeCount === "number") {
      const past = Array.isArray(v.$pastUpgrades) ? (v.$pastUpgrades as unknown[][]) : [];
      const last = past.length ? String(past[past.length - 1]?.[0] ?? "").slice(0, 10) : "";
      facts.push(`- Upgrades: ${v.$upgradeCount}${last ? ` (last ${last})` : ""}`);
    }
    for (const k of ["getMinDelay", "minDelay", "delay", "upgradeDelay", "exitWindow", "paused"]) if (k in v) facts.push(`- ${k}: ${JSON.stringify(v[k])}`);
    if (v.accessControl && typeof v.accessControl === "object") {
      for (const [role, info] of Object.entries(v.accessControl as Record<string, { members?: string[]; adminRole?: string }>)) {
        const ms = (info.members ?? []).map((m) => label(m));
        if (ms.length) facts.push(`- Role ${role}${info.adminRole ? ` (admin role ${info.adminRole})` : ""}: ${ms.join(", ")}`);
      }
    }
    const perms = json.permissions?.[e.address]?.receivedPermissions ?? [];
    for (const p of perms.slice(0, 12))
      facts.push(`- Can ${p.description ?? p.permission ?? "act"} on ${label(p.from ?? null)}${p.delay ? ` (delay ${p.delay}s)` : ""}`);
    if (e.type === "EOA" && !perms.length && !e.name) continue;
    lines.push(head, ...facts, "");
  }
  return { markdown: lines.join("\n"), contracts };
}

/** L2BEAT config folder for the project; on a wrong slug, an error naming the closest folder. */
export interface L2beatProject {
  slug: string;
  /** Every config file (prose, TypeScript config, JSONC) plus the discovered.json digest. */
  files: { name: string; url: string; title: string; content: string }[];
  contracts: DiscoveredContract[];
}

/**
 * Reads an L2BEAT project folder without touching the database (usable from the evaluation tools). Throws, naming
 * the closest folder, when the slug doesn't exist.
 */
export async function readL2beatProject(slug: string, opts: { gh?: GithubMemo; nameTokens?: string[] } = {}): Promise<L2beatProject> {
  if (!/^[a-z0-9-]+$/i.test(slug)) throw new Error(`Invalid L2BEAT slug "${slug}"`);
  const memo = opts.gh ?? new GithubMemo();
  type Item = { name: string; path: string; type: string; size: number };
  let items: Item[];
  try {
    items = await memo.get<Item[]>(`/repos/${L2BEAT_REPO}/contents/${L2BEAT_DIR}/${encodePath(slug)}`);
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) {
      const listing = await memo
        .get<{ tree: { path: string; type: string }[] }>(`/repos/${L2BEAT_REPO}/git/trees/main:${L2BEAT_DIR}`)
        .catch(() => ({ tree: [] }));
      const folders = listing.tree.filter((t) => t.type === "tree").map((t) => t.path);
      throw new L2beatSlugError(slug, closestSlug(slug, folders, opts.nameTokens ?? []));
    }
    throw e;
  }
  const out: L2beatProject = { slug, files: [], contracts: [] };
  const files = items.filter((i) => i.type === "file" && /\.(md|ts|jsonc|json)$/i.test(i.name) && !/^(tvs|stake-distribution)\.json$/i.test(i.name));
  await mapLimit(files, 4, async (f) => {
    const body = await ghRaw(L2BEAT_REPO, "main", f.path, BIG);
    if (!body) return;
    let text = body.toString("utf8");
    if (f.name === "discovered.json") {
      const digest = digestDiscovered(JSON.parse(text) as Discovered);
      out.contracts.push(...digest.contracts);
      text = digest.markdown;
    } else if (f.name === "diffHistory.md") {
      text = text.slice(0, 80_000); // newest entries come first
    }
    out.files.push({
      name: f.name,
      url: `https://github.com/${L2BEAT_REPO}/blob/main/${f.path}`,
      title: `L2BEAT config · ${slug}/${f.name}${f.name === "discovered.json" ? " (digest)" : ""}`,
      content: text,
    });
  });
  out.files.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export class L2beatSlugError extends Error {
  constructor(
    public slug: string,
    public suggestion: string | null,
  ) {
    super(`L2BEAT has no project folder "${slug}"${suggestion ? `; the closest is "${suggestion}" (set it in project settings)` : ""}`);
  }
}

/**
 * L2BEAT folders of the network a project runs on, when it runs on exactly one L2BEAT-tracked chain (from the
 * project's `chains`). Each folder was checked to exist in l2beat/l2beat on 2026-10-01.
 */
const HOST_CHAIN_L2BEAT: Record<string, string> = {
  starknet: "starknet",
  arbitrum: "arbitrum",
  "arbitrum one": "arbitrum",
  optimism: "optimism",
  "op mainnet": "optimism",
  base: "base",
  "zksync era": "zksync2",
  zksync: "zksync2",
  scroll: "scroll",
  linea: "linea",
};

/** The host chain's L2BEAT slug for a single-chain project, unless it is the project's own slug. Pure. */
export function hostChainSlug(project: { chains?: string[] | null; l2beatSlug?: string | null }): string | null {
  const chains = (project.chains ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (chains.length !== 1) return null;
  const slug = HOST_CHAIN_L2BEAT[chains[0]!] ?? null;
  return slug && slug !== project.l2beatSlug ? slug : null;
}

/** L2BEAT prose files are templates; their {{placeholders}} are filled from discovered.json on the site (R3-SRC-14). */
export function templateNote(content: string): string | null {
  const at = content.indexOf("{{");
  if (at < 0) return null;
  const end = content.indexOf("}}", at);
  const name = end > at && end - at < 64 ? content.slice(at + 2, end).trim() : "";
  return `Template: values such as {{${name || "…"}}} are filled in on l2beat.com from discovered.json; read the discovered.json digest for them.`;
}

const SUMMARY_TTL = 3_600_000;
let scalingSummary: { at: number; projects: Record<string, Record<string, unknown>> } | null = null;

/** L2BEAT's scaling summary (summary fields only), fetched at most once an hour (R3-SEC-10). */
export async function l2beatScalingSummary(): Promise<Record<string, Record<string, unknown>>> {
  if (scalingSummary && Date.now() - scalingSummary.at < SUMMARY_TTL) return scalingSummary.projects;
  const res = await safeFetch("https://l2beat.com/api/scaling/summary", { maxBytes: BIG, timeoutMs: 60_000 });
  if (res.status >= 400) throw new Error(`L2BEAT ${res.status}`);
  const projects = (JSON.parse(res.body.toString("utf8")) as { projects?: Record<string, Record<string, unknown>> }).projects ?? {};
  const slim: Record<string, Record<string, unknown>> = {};
  for (const [k, p] of Object.entries(projects)) slim[k] = { name: p.name, stage: p.stage, category: p.category, risks: p.risks, tvs: p.tvs, badges: p.badges };
  scalingSummary = { at: Date.now(), projects: slim };
  return slim;
}

async function storeL2beatFolder(ctx: LaneContext, slug: string, host: boolean): Promise<number> {
  let project: L2beatProject;
  try {
    project = await readL2beatProject(slug, { gh: ctx.gh, nameTokens: ctx.registry.tokens });
  } catch (e) {
    if (!host && e instanceof L2beatSlugError) ctx.meta.suggestions = { ...(ctx.meta.suggestions ?? {}), l2beatSlug: e.suggestion };
    throw e;
  }
  // The host chain's contracts aren't the project's own: they stay in the digest, out of the address registry.
  if (!host) ctx.shared.discovered.push(...project.contracts);
  const suffix = host ? ` (host chain of ${ctx.project.name})` : "";
  let n = 0;
  for (const f of project.files) {
    const note = /\.md$/i.test(f.name) ? templateNote(f.content) : null;
    const { status } = await storeFor(ctx, "l2beat", "data", {
      url: f.url,
      title: `${f.title}${suffix}${note ? " (template)" : ""}`,
      kind: "l2beat",
      sourceClass: "independent",
      content: note ? `${note}\n\n${f.content}` : f.content,
      date: new Date().toISOString().slice(0, 10),
      meta: { provider: "l2beat", file: f.name, ...(host ? { hostChain: slug } : {}) },
    });
    if (counted(status)) n++;
  }
  // Scaling projects also have a summary entry (stage, risk rosette, value secured).
  try {
    const p = (await l2beatScalingSummary())[slug];
    if (p) {
      const { status } = await storeFor(ctx, "l2beat", "data", {
        url: `https://l2beat.com/scaling/projects/${slug}`,
        title: `L2BEAT · ${String(p.name ?? slug)}${suffix}`,
        kind: "l2beat",
        sourceClass: "independent",
        content: JSON.stringify(p, null, 2),
        date: new Date().toISOString().slice(0, 10),
        meta: { provider: "l2beat", file: "scaling-summary", ...(host ? { hostChain: slug } : {}) },
      });
      if (counted(status)) n++;
    }
  } catch {
    // the summary is optional
  }
  return n;
}

/** The project's L2BEAT folder, plus its host chain's (R3-SRC-15). */
export async function ingestL2beat(ctx: LaneContext): Promise<{ count: number; ref?: string }> {
  const slug = ctx.project.l2beatSlug;
  const host = hostChainSlug(ctx.project);
  let n = 0;
  if (slug) n += await storeL2beatFolder(ctx, slug, false);
  if (host) {
    try {
      n += await storeL2beatFolder(ctx, host, true);
    } catch (e) {
      ctx.log(`l2beat: couldn't read the host chain's folder "${host}": ${(e as Error).message}`);
    }
  }
  const ref = [slug, host ? `${host} (host chain)` : null].filter(Boolean).join(", ");
  return { count: n, ...(ref ? { ref } : {}) };
}

export interface DefillamaProtocol {
  id?: string;
  name?: string;
  category?: string;
  chains?: string[];
  currentChainTvls?: Record<string, number>;
  audits?: string;
  audit_note?: string | null;
  audit_links?: string[];
  url?: string;
  github?: string[];
  twitter?: string;
  parentProtocol?: string;
  hallmarks?: [number, string][];
  tvl?: { date: number; totalLiquidityUSD: number }[];
}

const defillamaCache = new Map<string, { at: number; p: Promise<DefillamaProtocol> }>();

/**
 * DefiLlama's protocol entry without its TVL histories (Railgun's full response is 15.7 MB), cached per slug for an
 * hour and shared by the lanes and the evaluation tool (R3-SEC-10).
 */
export function fetchDefillamaProtocol(slug: string): Promise<DefillamaProtocol> {
  const key = slug.toLowerCase();
  const hit = defillamaCache.get(key);
  if (hit && Date.now() - hit.at < SUMMARY_TTL) return hit.p;
  const p = (async () => {
    const res = await safeFetch(`https://api.llama.fi/protocol/${encodeURIComponent(slug)}`, { maxBytes: BIG, timeoutMs: 60_000 });
    if (res.status === 404 || res.status === 400) throw new Error(`DefiLlama has no protocol "${slug}"`);
    if (res.status >= 400) throw new Error(`DefiLlama ${res.status} for ${slug}`);
    const j = JSON.parse(res.body.toString("utf8")) as DefillamaProtocol & { chainTvls?: unknown; tokens?: unknown; tokensInUsd?: unknown };
    const { tvl: _tvl, chainTvls: _chainTvls, tokens: _tokens, tokensInUsd: _tokensInUsd, ...summary } = j;
    return summary;
  })();
  defillamaCache.set(key, { at: Date.now(), p });
  p.catch(() => defillamaCache.delete(key));
  if (defillamaCache.size > 200) {
    const oldest = defillamaCache.keys().next().value;
    if (oldest !== undefined) defillamaCache.delete(oldest);
  }
  return p;
}

/** DefiLlama protocol entry for the project being refreshed (summary fields only). */
export function defillamaProtocol(ctx: LaneContext): Promise<DefillamaProtocol | null> {
  const slug = ctx.project.defillamaSlug;
  if (!slug) return Promise.resolve(null);
  return fetchDefillamaProtocol(slug);
}

export async function ingestDefillama(ctx: LaneContext): Promise<number> {
  const j = await defillamaProtocol(ctx);
  if (!j) return 0;
  const current = j.currentChainTvls ?? {};
  const total = Object.entries(current)
    .filter(([k]) => !k.includes("-") && !["borrowed", "staking", "pool2"].includes(k))
    .reduce((s, [, v]) => s + (v ?? 0), 0);
  const summary = {
    name: j.name,
    id: j.id,
    category: j.category,
    chains: j.chains,
    tvlUsd: Math.round(total),
    currentChainTvls: current,
    audits: j.audits,
    audit_note: j.audit_note,
    audit_links: j.audit_links,
    url: j.url,
    github: j.github,
    twitter: j.twitter,
    parentProtocol: j.parentProtocol,
    hallmarks: (j.hallmarks ?? []).map(([t, label]) => `${new Date(t * 1000).toISOString().slice(0, 10)} ${label}`),
  };
  ctx.shared.defillama = { id: j.id ?? null, parentId: j.parentProtocol ?? null, auditLinks: j.audit_links ?? [] };
  const { status } = await storeFor(ctx, "defillama", "data", {
    url: `https://defillama.com/protocol/${ctx.project.defillamaSlug}`,
    title: `DefiLlama · ${j.name ?? ctx.project.defillamaSlug}`,
    kind: "defillama",
    sourceClass: "independent",
    content: JSON.stringify(summary, null, 2),
    date: new Date().toISOString().slice(0, 10),
    meta: { provider: "defillama" },
  });
  return counted(status) ? 1 : 0;
}

export interface Hack {
  date: number;
  name: string;
  classification?: string | null;
  technique?: string | null;
  amount?: number | null;
  chain?: string[];
  bridgeHack?: boolean;
  targetType?: string | null;
  source?: string | null;
  returnedFunds?: number | null;
  defillamaId?: string | null;
  parentProtocolId?: string | null;
  language?: string | null;
}

/** Hacks that belong to the project: its DefiLlama id or parent, or its name as a whole word. Pure. */
export function matchHacks(hacks: Hack[], opts: { aliases: string[]; id?: string | null; parentId?: string | null }): Hack[] {
  return hacks.filter(
    (h) =>
      (opts.id && h.defillamaId === opts.id) ||
      (opts.parentId && h.parentProtocolId === opts.parentId) ||
      aliasMentions(
        h.name ?? "",
        opts.aliases.filter((a) => a.length >= 4),
      ).length > 0,
  );
}

/** DefiLlama hacks for the project, stored as incidents, with each linked post-mortem fetched and classified. */
export async function ingestHacks(ctx: LaneContext): Promise<number> {
  const res = await safeFetch("https://api.llama.fi/hacks", { maxBytes: BIG, timeoutMs: 60_000 });
  if (res.status >= 400) throw new Error(`DefiLlama hacks ${res.status}`);
  const hacks = JSON.parse(res.body.toString("utf8")) as Hack[];
  const proto = ctx.project.defillamaSlug ? await defillamaProtocol(ctx).catch(() => null) : null;
  const matched = matchHacks(hacks, { aliases: ctx.registry.aliases, id: proto?.id ?? null, parentId: proto?.parentProtocol ?? null });
  let n = 0;
  for (const h of matched.slice(0, 20)) {
    const date = new Date(h.date * 1000).toISOString().slice(0, 10);
    const slug = h.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const lines = [
      `# ${h.name} incident (${date})`,
      `Source: DefiLlama hacks database`,
      `- Date: ${date}`,
      `- Amount lost: ${h.amount ? `$${Math.round(h.amount).toLocaleString("en-US")}` : "unknown"}`,
      `- Classification: ${h.classification ?? "?"}; technique: ${h.technique ?? "?"}`,
      `- Chains: ${(h.chain ?? []).join(", ") || "?"}; target: ${h.targetType ?? "?"}${h.bridgeHack ? " (bridge)" : ""}`,
      `- Language: ${h.language ?? "?"}`,
      `- Returned funds: ${h.returnedFunds ?? "none reported"}`,
      h.source ? `- Report: ${h.source}` : "",
    ].filter(Boolean);
    const { status } = await storeFor(ctx, "hacks", "data", {
      url: `https://defillama.com/hacks#${slug}-${date}`,
      title: `DefiLlama hack record · ${h.name} · ${date}`,
      kind: "defillama",
      sourceClass: "independent",
      content: lines.join("\n"),
      date,
      meta: { provider: "defillama", subkind: "incident", hack: h.name },
    });
    if (counted(status)) n++;
    const src = h.source ? normalizeUrl(h.source, { keepQuery: true }) : null;
    if (src && !/(^|\.)(x|twitter)\.com$/.test(new URL(src).hostname)) {
      try {
        const page = await fetchPage(src);
        const c = classify(ctx, page.url, "incidents", { title: page.title, text: page.markdown });
        if (page.status < 400 && page.markdown.length > 300 && !c.drop) {
          await storeFor(ctx, "hacks", c.kind === "audit" ? "audits" : "analysis", {
            url: normalizeUrl(page.url, { keepQuery: true }) ?? page.url,
            title: page.title,
            kind: c.kind === "news" ? "analysis" : c.kind,
            sourceClass: c.sourceClass,
            content: page.markdown,
            date,
            meta: { subkind: "incident", hack: h.name },
          });
        }
      } catch {
        // the record itself is stored
      }
    }
  }
  return n;
}
