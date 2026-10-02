/**
 * Deployed-address registry (P0): the addresses the project actually runs, collected from L2BEAT's
 * `discovered.json`, docs pages that list contracts, and repo deployment files. Each address is checked on
 * Sourcify (verified source and proxy resolution) and inspected onchain (owner, proxy admin, Safe threshold,
 * modules and guard, AccessControl admins). The result is one searchable registry source per project plus the
 * verified source of each contract, all `code_onchain`.
 *
 * Hygiene (R3-SRC-1): docs are mined only on listing-shaped lines (table rows, explorer links, list items) outside
 * code blocks; an explorer the lane doesn't know leaves the chain to Sourcify instead of a guess from the prose;
 * labels that look like code are rejected; well-known tokens and infrastructure (USDT, Permit2, Safe singletons,
 * Hardhat's default deployments...) are listed as third-party and never stored as the project's verified source;
 * and contracts that share one verified source are stored once, with every address listed.
 */

import { sql } from "drizzle-orm";
import { getAddress, isAddress } from "viem";
import { query } from "../../db/index.ts";
import { type AddressInspection, inspectAddressStructured, isSupportedChain, renderInspection } from "../../lib/evm.ts";
import { lookupSourcify, renderSourcify, type SourcifyContract, sourcifyChainsFor, sourcifyUrl } from "../../lib/sourcify.ts";
import { contentHash, purgeWhere, STALE } from "../kb-store.ts";
import { counted, type LaneContext, mapLimit, storeFor } from "./context.ts";

export interface FoundAddress {
  address: string;
  chainId: number | null;
  label: string | null;
  /** Where it was found: "l2beat", a docs URL, or a repo file URL. */
  origin: string;
  priority: number;
}

/**
 * Contracts that belong to someone else wherever they appear: tokens, shared infrastructure and local-devnet
 * defaults that docs and deploy scripts mention. Each was checked on Sourcify, the publisher's README or by
 * derivation (Hardhat/Anvil defaults come from the "test … junk" mnemonic) on 2026-10-01.
 */
export const THIRD_PARTY_CONTRACTS: Record<string, string> = {
  "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT (TetherToken)",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC (FiatTokenProxy)",
  "0x6b175474e89094c44da98b954eedeac495271d0f": "DAI",
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH9",
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "WBTC",
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
  "0xca11bde05977b3631167028862be2a173976ca11": "Multicall3",
  "0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed": "CreateX",
  "0x4e59b44847b379578588920ca78fbf26c0b4956c": "Deterministic deployment proxy (CREATE2)",
  "0x914d7fec6aac8cd542e72bca78b30650d45643d7": "Safe singleton factory",
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789": "ERC-4337 EntryPoint v0.6",
  "0x0000000071727de22e5e9d8baf0edac6f37da032": "ERC-4337 EntryPoint v0.7",
  "0x4337084d9e255ff0702461cf8895ce9e3b5ff108": "ERC-4337 EntryPoint v0.8",
  "0x433709009b8330fda32311df1c2afa402ed8d009": "ERC-4337 EntryPoint v0.9",
  "0x41675c099f32341bf84bfc5382af534df5c7461a": "Safe 1.4.1 singleton",
  "0x29fcb43b46531bca003ddc8fcb67ffe91900c762": "SafeL2 1.4.1 singleton",
  "0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67": "SafeProxyFactory 1.4.1",
  "0xfd0732dc9e303f09fcef3a7388ad10a83459ec99": "Safe CompatibilityFallbackHandler 1.4.1",
  "0x9641d764fc13c8b624c04430c7356c1c7c8102e2": "Safe MultiSendCallOnly 1.4.1",
  "0xd9db270c1b5e3bd161e8c8503c55ceabee709552": "GnosisSafe 1.3.0 singleton",
  "0x3e5c63644e683549055b9be8653de26e0b4cd36e": "GnosisSafeL2 1.3.0 singleton",
  "0xa6b71e26c5e0845f74c812102ca7114b6a896ab2": "GnosisSafeProxyFactory 1.3.0",
  "0xf48f2b2d2a534e402487b3ee7c18c33aec0fe5e4": "Safe CompatibilityFallbackHandler 1.3.0",
  "0x40a2accbd92bca938b02010e17a5b8929b49130d": "Safe MultiSendCallOnly 1.3.0",
  "0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761": "Safe MultiSend 1.3.0",
  "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432": "ERC-8004 IdentityRegistry",
  "0x8004baa17c55a88189ae136b182e5fda19de9b63": "ERC-8004 ReputationRegistry",
  // Hardhat and Anvil: the first ten default accounts, and the first ten contracts account #0 deploys.
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266": "Hardhat/Anvil default account #0",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8": "Hardhat/Anvil default account #1",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc": "Hardhat/Anvil default account #2",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906": "Hardhat/Anvil default account #3",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65": "Hardhat/Anvil default account #4",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc": "Hardhat/Anvil default account #5",
  "0x976ea74026e726554db657fa54763abd0c3a0aa9": "Hardhat/Anvil default account #6",
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955": "Hardhat/Anvil default account #7",
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f": "Hardhat/Anvil default account #8",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720": "Hardhat/Anvil default account #9",
  "0x5fbdb2315678afecb367f032d93f642f64180aa3": "Hardhat/Anvil default deployment #0",
  "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512": "Hardhat/Anvil default deployment #1",
  "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0": "Hardhat/Anvil default deployment #2",
  "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9": "Hardhat/Anvil default deployment #3",
  "0xdc64a140aa3e981100a9beca4e685f962f0cf6c9": "Hardhat/Anvil default deployment #4",
  "0x5fc8d32690cc91d4c39d9d3abcbd16989f875707": "Hardhat/Anvil default deployment #5",
  "0x0165878a594ca255338adfa4d48449f69242eb8f": "Hardhat/Anvil default deployment #6",
  "0xa513e6e4b8f2a923d98304ec87f64353c4d5c853": "Hardhat/Anvil default deployment #7",
  "0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6": "Hardhat/Anvil default deployment #8",
  "0x8a791620dd6260079bf849dc5567adc3f2fdc318": "Hardhat/Anvil default deployment #9",
};

/** What a well-known third-party address is, or null. */
export function thirdPartyContract(address: string | null | undefined): string | null {
  return address ? (THIRD_PARTY_CONTRACTS[address.toLowerCase()] ?? null) : null;
}

export const EXPLORERS: [RegExp, number][] = [
  [/^(www\.)?etherscan\.io$/, 1],
  [/^eth\.blockscout\.com$/, 1],
  [/^sepolia\.etherscan\.io$/, 11155111],
  [/^eth-sepolia\.blockscout\.com$/, 11155111],
  [/^holesky\.etherscan\.io$/, 17000],
  [/^(www\.)?basescan\.org$/, 8453],
  [/^base\.blockscout\.com$/, 8453],
  [/^sepolia\.basescan\.org$/, 84532],
  [/^(www\.)?arbiscan\.io$/, 42161],
  [/^sepolia\.arbiscan\.io$/, 421614],
  [/^optimistic\.etherscan\.io$/, 10],
  [/^(www\.)?polygonscan\.com$/, 137],
  [/^(www\.)?bscscan\.com$/, 56],
  [/^(www\.)?lineascan\.build$/, 59144],
  [/^(www\.)?scrollscan\.com$/, 534352],
  [/^(www\.)?gnosisscan\.io$/, 100],
  // Tempo mainnet (L2BEAT's tempo config: chainId 4217, explorerUrl https://explore.tempo.xyz).
  [/^explore\.tempo\.xyz$/, 4217],
];

/** A link that points at an address page on some block explorer, known or not. */
const EXPLORER_PATH = /\/(address|addresses|token|tokens|contract|contracts|account|accounts)\/0x[0-9a-fA-F]{40}/i;
const EXPLORER_HOST = /(^|\.)(explore|explorer|scan|blockscout)[.-]|scan\.(io|org|com|xyz|build)$|explorer\./i;

const CHAIN_WORDS: [RegExp, number][] = [
  [/\bsepolia\b/i, 11155111],
  [/\bholesky\b/i, 17000],
  [/\b(ethereum mainnet|ethereum l1|on ethereum|mainnet)\b/i, 1],
  [/\barbitrum( one)?\b/i, 42161],
  [/\b(optimism|op mainnet)\b/i, 10],
  [/\bpolygon( pos)?\b/i, 137],
  [/\bBase( mainnet| chain)?\b/, 8453],
  [/\bgnosis chain\b/i, 100],
  [/\b(bnb chain|bsc)\b/i, 56],
];

const NETWORK_NAMES: Record<string, number> = {
  mainnet: 1,
  ethereum: 1,
  eth: 1,
  "1": 1,
  sepolia: 11155111,
  "11155111": 11155111,
  holesky: 17000,
  base: 8453,
  "8453": 8453,
  arbitrum: 42161,
  arbitrumone: 42161,
  "42161": 42161,
  optimism: 10,
  "10": 10,
  polygon: 137,
  "137": 137,
  bsc: 56,
};

const IGNORE =
  /^0x(0{40}|0{39}[1-9a-f]|0{38}[0-9a-f]{2}|f{40}|0{24}dead[0-9a-f]{12}|000000000000000000000000000000000000dead|eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee)$/i;

export function chainFromExplorer(url: string): number | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [re, id] of EXPLORERS) if (re.test(host)) return id;
  } catch {
    // ignore
  }
  return null;
}

function chainFromContext(text: string): number | null {
  let best: { at: number; id: number } | null = null;
  for (const [re, id] of CHAIN_WORDS) {
    const all = [...text.matchAll(new RegExp(re.source, `${re.flags.replace("g", "")}g`))];
    const last = all[all.length - 1];
    if (last && (!best || (last.index ?? 0) > best.at)) best = { at: last.index ?? 0, id };
  }
  return best?.id ?? null;
}

/** Labels that are really code or markup (`const buyTokenAddress = '`, `](https://…)`). */
const CODE_LABEL = /[=;{}]|\bconst\b|\blet\b|\bvar\b|\]\(|=>|\breturn\b|["']\s*$|^\s*["']|"/;

function cleanLabel(s: string): string | null {
  if (CODE_LABEL.test(s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"))) return null;
  const t = s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/0x[0-9a-fA-F]{40}/g, "")
    .replace(/[*_`#>|[\]]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:–—-]+|[\s:–—-]+$/g, "")
    .trim();
  return t.length >= 2 && t.length <= 80 ? t : null;
}

/** The link on a line that points at this address's page on a block explorer, if any. */
function explorerLinkFor(line: string, address: string): string | null {
  const lower = address.toLowerCase();
  for (const m of line.matchAll(/https?:\/\/[^\s)<>\]"']{1,300}/g)) {
    const u = m[0];
    if (!u.toLowerCase().includes(lower)) continue;
    try {
      const x = new URL(u);
      if (chainFromExplorer(u) !== null || EXPLORER_PATH.test(x.pathname) || EXPLORER_HOST.test(x.hostname)) return u;
    } catch {
      // not a URL
    }
  }
  return null;
}

const LIST_ITEM = /^\s{0,12}([-*+]|\d{1,4}[.)])\s{1,8}/;
/** More addresses than any deployment list holds. */
const MAX_PAGE_ADDRESSES = 300;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.{1,120})$/;

/**
 * Addresses a markdown page lists (R3-SRC-1): table rows, list items and lines with an explorer link, outside fenced
 * code blocks, so code samples (`const usdt = '0xdAC1…'`) and config snippets are never mined. The chain comes from
 * a known explorer link; a link to an explorer this lane doesn't know leaves it unknown (Sourcify decides) rather
 * than guessing from the prose; only links-free listings fall back to the surrounding text. The label comes from
 * the same row or line, else the nearest heading above an address-only line. Pure.
 */
export function extractAddresses(markdown: string, origin: string): FoundAddress[] {
  const out = new Map<string, FoundAddress>();
  const lines = markdown.split("\n");
  let offset = 0;
  let inFence = false;
  let heading: { text: string; line: number } | null = null;
  for (const [n, line] of lines.entries()) {
    // A deployment list is never this long; past it the page is noise (or hostile), and checksums cost CPU.
    if (out.size >= MAX_PAGE_ADDRESSES) break;
    const lineStart = offset;
    offset += line.length + 1;
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = line.match(HEADING);
    if (h) heading = { text: h[1]!, line: n };
    if (!line.includes("0x")) continue;
    const table = line.trim().startsWith("|");
    const listItem = LIST_ITEM.test(line);
    let rowLabel: string | null | undefined;
    for (const m of line.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) {
      if (out.size >= MAX_PAGE_ADDRESSES) break;
      const address = m[0];
      if (IGNORE.test(address) || !isAddress(address, { strict: false })) continue;
      // The explorer link sits next to the address (`[0xabc…](https://explorer/address/0xabc…)`).
      const link = explorerLinkFor(line.slice(Math.max(0, (m.index ?? 0) - 400), (m.index ?? 0) + 400), address);
      if (!table && !listItem && !link) continue;
      const known = link ? chainFromExplorer(link) : null;
      const at = lineStart + (m.index ?? 0);
      // Bounded windows: a hostile one-line page mustn't make every address rescan the whole line (R3-SEC-2).
      const chainId = link ? known : chainFromContext(markdown.slice(Math.max(0, at - 600), at));
      let label: string | null = null;
      if (table) {
        if (rowLabel === undefined) {
          const cells = line.split("|", 40).map((c) => c.trim().slice(0, 300));
          rowLabel = cells.map((c) => cleanLabel(c)).find((c) => c && !/^(0x|address|addresses|contract|contracts|name|link)$/i.test(c)) ?? null;
        }
        label = rowLabel;
      } else {
        const idx = m.index ?? 0;
        const before = line.slice(Math.max(0, idx - 300), idx).replace(LIST_ITEM, "");
        label = cleanLabel(before) ?? cleanLabel(line.slice(idx + address.length, idx + address.length + 300).replace(/^[^\s]{0,400}\)/, ""));
        // An address on a line of its own (Tempo's predeploy list) takes the heading right above it.
        if (!label && heading && n - heading.line <= 6) label = cleanLabel(heading.text);
      }
      const key = `${chainId ?? "?"}:${address.toLowerCase()}`;
      if (!out.has(key)) out.set(key, { address: getAddress(address), chainId, label, origin, priority: 1 });
    }
  }
  return [...out.values()];
}

/** Addresses in a deployment file: Foundry broadcasts, hardhat-deploy artifacts, or any JSON map of names to addresses. Pure. */
export function extractFromDeploymentJson(text: string, path: string, origin: string): FoundAddress[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const segs = path.toLowerCase().split("/");
  const pathChain = segs.map((s) => NETWORK_NAMES[s.replace(/\.json$/, "")]).find((x) => x !== undefined) ?? null;
  const out: FoundAddress[] = [];
  const push = (address: unknown, label: string | null, chainId: number | null) => {
    if (typeof address !== "string" || !isAddress(address) || IGNORE.test(address)) return;
    out.push({ address: getAddress(address), chainId, label, origin, priority: 2 });
  };
  const j = json as Record<string, unknown>;
  // Foundry broadcast: broadcast/<Script>/<chainId>/run-latest.json
  if (Array.isArray(j.transactions)) {
    const chain = typeof j.chain === "number" ? j.chain : pathChain;
    for (const t of j.transactions as Record<string, unknown>[]) {
      if (t.transactionType === "CREATE" || t.transactionType === "CREATE2") push(t.contractAddress, (t.contractName as string) ?? null, chain);
    }
    return out;
  }
  // hardhat-deploy artifact: deployments/<network>/<Contract>.json
  if (typeof j.address === "string" && Array.isArray(j.abi)) {
    push(
      j.address,
      path
        .split("/")
        .pop()
        ?.replace(/\.json$/i, "") ?? null,
      pathChain,
    );
    return out;
  }
  const declared = typeof j.chainId === "number" ? j.chainId : typeof j.chainId === "string" ? Number(j.chainId) : null;
  const walk = (v: unknown, keyPath: string[], chain: number | null, depth: number) => {
    if (depth > 6) return;
    if (typeof v === "string") {
      push(
        v,
        keyPath
          .filter((k) => !/^\d+$/.test(k))
          .slice(-2)
          .join(".") || null,
        chain,
      );
      return;
    }
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) walk(x, [...keyPath, String(i)], chain, depth + 1);
    } else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, [...keyPath, k], NETWORK_NAMES[k.toLowerCase()] ?? chain, depth + 1);
  };
  walk(json, [], declared ?? pathChain, 0);
  return out;
}

/** Merges findings by (chain, address), keeping the best label and the highest-priority origin. Pure. */
export function mergeAddresses(found: FoundAddress[]): FoundAddress[] {
  const byKey = new Map<string, FoundAddress>();
  for (const f of found) {
    const key = `${f.chainId ?? "?"}:${f.address.toLowerCase()}`;
    const prev = byKey.get(key) ?? (f.chainId !== null ? byKey.get(`?:${f.address.toLowerCase()}`) : undefined);
    if (!prev) {
      byKey.set(key, f);
      continue;
    }
    if (prev.chainId === null && f.chainId !== null) byKey.delete(`?:${f.address.toLowerCase()}`);
    byKey.set(key, {
      address: f.address,
      chainId: prev.chainId ?? f.chainId,
      label: f.priority > prev.priority ? (f.label ?? prev.label) : (prev.label ?? f.label),
      origin: f.priority > prev.priority ? f.origin : prev.origin,
      priority: Math.max(prev.priority, f.priority),
    });
  }
  return [...byKey.values()].sort((a, b) => b.priority - a.priority);
}

interface RegistryRow extends FoundAddress {
  /** A well-known token or piece of infrastructure (USDT, Permit2, a Safe singleton...), not the project's contract. */
  thirdParty: string | null;
  sourcify: SourcifyContract | null;
  implementation: SourcifyContract | null;
  inspection: AddressInspection | null;
  l2beat?: { proxyType: string | null; owner: string | null; admin: string | null; safe: string | null; critical: boolean };
}

/** One verified source and every registry address that runs it (proxies pointing at it included). */
export interface SourceGroup {
  contract: SourcifyContract;
  addresses: { chainId: number; address: string; label: string | null; via: string | null }[];
}

/** Identity of a verified source: its files and their contents, not the address it was deployed at. */
export function sourceHash(c: SourcifyContract): string {
  return contentHash(c.sources.map((s) => `${s.path}\n${s.content}`).join("\n\u0000"));
}

/**
 * Groups registry rows by verified source (R3-SRC-1): fourteen pools deployed from one contract become one source
 * that lists fourteen addresses. Third-party contracts, and proxies whose implementation is third-party (a Safe
 * proxy's singleton), are left out. Pure.
 */
export function groupVerifiedSources(rows: Pick<RegistryRow, "address" | "chainId" | "label" | "thirdParty" | "sourcify" | "implementation">[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const r of rows) {
    if (r.thirdParty) continue;
    const c = r.implementation ?? (r.sourcify && !r.sourcify.proxy?.isProxy ? r.sourcify : null);
    if (!c || thirdPartyContract(c.address)) continue;
    const key = sourceHash(c);
    const entry = { chainId: c.chainId, address: c.address, label: r.label, via: r.address.toLowerCase() !== c.address.toLowerCase() ? r.address : null };
    const g = groups.get(key);
    if (!g) groups.set(key, { contract: c, addresses: [entry] });
    else if (!g.addresses.some((a) => a.chainId === entry.chainId && a.address.toLowerCase() === entry.address.toLowerCase() && a.via === entry.via))
      g.addresses.push(entry);
  }
  return [...groups.values()];
}

function renderGroup(g: SourceGroup): string {
  const body = renderSourcify(g.contract);
  if (g.addresses.length <= 1 && !g.addresses[0]?.via) return body;
  const list = g.addresses.map((a) => `- chain ${a.chainId} · ${a.address}${a.label ? ` (${a.label})` : ""}${a.via ? ` · behind proxy ${a.via}` : ""}`);
  const nl = body.indexOf("\n");
  return `${body.slice(0, nl)}\nThe same verified source runs at ${g.addresses.length} registry entr${g.addresses.length === 1 ? "y" : "ies"}:\n${list.join("\n")}\n${body.slice(nl + 1)}`;
}

/** Builds and stores the project's address registry. Runs after the docs, code and data lanes. */
export async function ingestAddressRegistry(
  ctx: LaneContext,
  opts: { maxLookups?: number; maxInspections?: number } = {},
): Promise<{ count: number; note: string }> {
  const found: FoundAddress[] = [];
  const l2 = new Map<string, RegistryRow["l2beat"]>();
  for (const c of ctx.shared.discovered) {
    if (!c.name && !c.safe) continue; // unnamed EOAs are listed through the contracts that point at them
    found.push({ address: getAddress(c.address), chainId: c.chainId, label: c.name, origin: "L2BEAT discovered.json", priority: c.critical ? 4 : 3 });
    l2.set(`${c.chainId}:${c.address.toLowerCase()}`, {
      proxyType: c.proxyType,
      owner: c.owner,
      admin: c.admin,
      safe: c.safe ? `${c.safe.threshold ?? "?"} of ${c.safe.members}` : null,
      critical: c.critical,
    });
  }
  // Repo deployment files and docs pages already in the knowledge base.
  const rows = await query<{ url: string; title: string; content: string; path: string | null; section: string }>(
    ctx.db,
    sql`SELECT url, title, content_md AS content, meta->>'path' AS path, meta->>'section' AS section FROM sources
       WHERE project_id = ${ctx.project.id} AND NOT ${STALE} AND (
         (meta->>'section' = 'code' AND meta->'tier' = '0'::jsonb) OR
         (meta->>'section' = 'docs' AND content_md LIKE '%0x%' AND (lower(url) LIKE '%address%' OR lower(url) LIKE '%deploy%' OR lower(url) LIKE '%contract%' OR lower(title) LIKE '%address%' OR lower(title) LIKE '%deploy%' OR lower(url) LIKE '%governance%' OR lower(url) LIKE '%security%'))
       ) LIMIT 200`,
  );
  for (const r of rows) {
    if (r.section === "code" && r.path && /\.json$/i.test(r.path)) found.push(...extractFromDeploymentJson(r.content, r.path, r.url));
    else if (r.section === "code" && r.path && /\.md$/i.test(r.path) && /deploy|address/i.test(r.path))
      found.push(...extractAddresses(r.content, r.url).map((f) => ({ ...f, priority: 2 })));
    else if (r.section === "docs") found.push(...extractAddresses(r.content, r.url));
  }
  let merged = mergeAddresses(found);
  if (!merged.length) {
    // Nothing listed any more (a code sample's EntryPoint used to be mined): an earlier registry goes with it.
    await purgeWhere(ctx.db, ctx.project.id, sql`meta->>'lane' = 'addresses'`);
    return { count: 0, note: "no addresses found in L2BEAT, docs or repo deployment files" };
  }
  // Unknown chains: ask Sourcify where the address is verified (not for third-party contracts, which are listed only).
  const unknown = merged.filter((m) => m.chainId === null && !thirdPartyContract(m.address)).slice(0, 100);
  await mapLimit(unknown, 4, async (m) => {
    const chains: number[] = await sourcifyChainsFor(m.address).catch(() => []);
    m.chainId = chains.includes(1) ? 1 : (chains[0] ?? null);
  });
  merged = mergeAddresses(merged).filter((m) => m.chainId !== null || thirdPartyContract(m.address));
  const maxLookups = opts.maxLookups ?? 300;
  const registry: RegistryRow[] = merged.slice(0, 500).map((m) => ({
    ...m,
    thirdParty: thirdPartyContract(m.address),
    sourcify: null,
    implementation: null,
    inspection: null,
    l2beat: l2.get(`${m.chainId}:${m.address.toLowerCase()}`),
  }));
  const own = registry.filter((r) => !r.thirdParty && r.chainId !== null);
  // Sourcify: mainnets first, then by priority.
  const lookupOrder = [...own].sort((a, b) => Number(b.chainId === 1) - Number(a.chainId === 1) || b.priority - a.priority).slice(0, maxLookups);
  await mapLimit(lookupOrder, 4, async (r) => {
    try {
      r.sourcify = await lookupSourcify(r.chainId!, r.address);
      const impl = r.sourcify?.proxy?.isProxy ? r.sourcify.proxy.implementations[0] : null;
      if (impl && !thirdPartyContract(impl.address)) r.implementation = await lookupSourcify(r.chainId!, impl.address).catch(() => null);
    } catch {
      // not verified or Sourcify unavailable
    }
  });
  // Onchain inspection: proxies, Safes and critical contracts first.
  const inspectOrder = own
    .filter((r) => isSupportedChain(r.chainId!))
    .sort(
      (a, b) =>
        Number(!!b.l2beat?.critical) - Number(!!a.l2beat?.critical) ||
        Number(!!b.sourcify?.proxy?.isProxy || !!b.l2beat?.safe) - Number(!!a.sourcify?.proxy?.isProxy || !!a.l2beat?.safe) ||
        b.priority - a.priority,
    )
    .slice(0, opts.maxInspections ?? 300);
  await mapLimit(inspectOrder, 3, async (r) => {
    try {
      r.inspection = await inspectAddressStructured(r.chainId!, r.address);
    } catch {
      // RPC unavailable
    }
  });
  let n = 0;
  // Verified sources: implementations and non-proxy contracts (proxy shells are boilerplate), one per source.
  const groups = groupVerifiedSources(registry);
  for (const g of groups.slice(0, 200)) {
    const c = g.contract;
    const more = g.addresses.length - 1;
    const { status } = await storeFor(ctx, "addresses", "addresses", {
      url: sourcifyUrl(c.chainId, c.address),
      title: `Verified source · ${c.name ?? "contract"} · chain ${c.chainId} · ${c.address}${more > 0 ? ` (+${more} more with the same source)` : ""}`,
      kind: "code",
      sourceClass: "code_onchain",
      content: renderGroup(g),
      date: c.verifiedAt?.slice(0, 10) ?? null,
      meta: {
        chainId: c.chainId,
        address: c.address,
        contract: c.name,
        verified: c.match,
        ...(more > 0 ? { sharedWith: g.addresses.slice(1).map((a) => `${a.chainId}:${a.via ?? a.address}`) } : {}),
      },
    });
    if (counted(status)) n++;
  }
  for (const r of own) {
    if (!r.inspection?.isContract) continue;
    await storeFor(ctx, "addresses", "addresses", {
      url: `evm://${r.chainId}/${r.address.toLowerCase()}#inspect`,
      title: `Onchain inspection · chain ${r.chainId} · ${r.label ?? r.sourcify?.name ?? r.address}`,
      kind: "code",
      sourceClass: "code_onchain",
      content: renderInspection(r.inspection),
      date: new Date().toISOString().slice(0, 10),
      meta: { chainId: r.chainId, address: r.address },
    });
  }
  const { status } = await storeFor(ctx, "addresses", "addresses", {
    url: `evm://registry/${ctx.project.slug}`,
    title: `Deployed address registry · ${ctx.project.name} (${own.length} addresses${registry.length > own.length ? `, ${registry.length - own.length} third-party` : ""})`,
    kind: "onchain",
    sourceClass: "code_onchain",
    content: renderRegistry(ctx.project.name, registry),
    date: new Date().toISOString().slice(0, 10),
    meta: { addresses: own.length, thirdParty: registry.length - own.length, verified: own.filter((r) => r.sourcify).length },
  });
  if (counted(status)) n++;
  const verified = own.filter((r) => r.sourcify).length;
  const inspected = own.filter((r) => r.inspection).length;
  const tp = registry.length - own.length;
  return {
    count: own.length,
    note: `${verified} verified on Sourcify, ${inspected} inspected onchain, ${groups.length} distinct verified sources, ${n} sources stored${tp ? `; ${tp} third-party contracts listed only` : ""}`,
  };
}

function short(a: string | null | undefined): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

function renderRegistry(project: string, rows: RegistryRow[]): string {
  const lines = [
    `# Deployed contracts and admin addresses · ${project}`,
    "",
    "Collected from L2BEAT's discovered.json, the project's docs pages and repo deployment files; checked on Sourcify and read onchain. Full addresses are listed under each entry. Rows marked third-party are tokens or shared infrastructure that the docs mention (USDT, Permit2, Safe singletons, local-devnet defaults): they are not the project's contracts.",
    "",
    "| Chain | Address | Name | Found in | Proxy | Verified (Sourcify) | Owner / admin |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const owner = r.inspection?.reads.find(([l]) => l === "owner")?.[1]?.replace(/"/g, "") ?? r.l2beat?.owner ?? null;
    const admin = r.inspection?.proxy.admin ?? r.l2beat?.admin ?? null;
    const proxy = r.sourcify?.proxy?.isProxy
      ? `${r.sourcify.proxy.type ?? "proxy"} → ${r.implementation?.name ?? r.sourcify.proxy.implementations[0]?.name ?? short(r.sourcify.proxy.implementations[0]?.address)}`
      : (r.l2beat?.proxyType ?? (r.inspection?.proxy.implementation ? "EIP-1967 proxy" : ""));
    const who = [owner ? `owner ${short(owner)}` : "", admin ? `admin ${short(admin)}` : "", r.l2beat?.safe ? `Safe ${r.l2beat.safe}` : ""]
      .filter(Boolean)
      .join(", ");
    const name = r.thirdParty ? `third-party token or infrastructure: ${r.thirdParty}` : (r.label ?? r.sourcify?.name ?? "");
    lines.push(
      `| ${r.chainId ?? "?"} | ${short(r.address)} | ${name.replace(/\|/g, "/")} | ${r.origin.startsWith("http") ? new URL(r.origin).pathname.split("/").slice(-2).join("/") : r.origin} | ${proxy} | ${r.thirdParty ? "not checked" : r.sourcify ? (r.sourcify.match ?? "yes") : "no"} | ${who} |`,
    );
  }
  lines.push("");
  for (const r of rows) {
    lines.push(`## ${r.thirdParty ?? r.label ?? r.sourcify?.name ?? "Address"} · chain ${r.chainId ?? "?"} · ${r.address}`);
    lines.push(`- Found in: ${r.origin}`);
    if (r.thirdParty) {
      lines.push(`- Third-party token or infrastructure (${r.thirdParty}), mentioned by the project; not its contract, so no source or inspection is stored.`);
      lines.push("");
      continue;
    }
    if (r.sourcify) {
      lines.push(`- Sourcify: ${r.sourcify.match} · ${r.sourcify.fullyQualifiedName ?? r.sourcify.name ?? ""} · ${sourcifyUrl(r.chainId!, r.address)}`);
      if (r.sourcify.proxy?.isProxy)
        lines.push(
          `- Proxy (${r.sourcify.proxy.type ?? "?"}) → ${r.sourcify.proxy.implementations.map((i) => `${thirdPartyContract(i.address) ?? i.name ?? "implementation"} ${i.address}`).join(", ")}`,
        );
    } else lines.push("- Sourcify: no verified source found");
    if (r.l2beat)
      lines.push(
        `- L2BEAT: ${[r.l2beat.proxyType, r.l2beat.safe ? `Safe ${r.l2beat.safe}` : "", r.l2beat.critical ? "critical" : ""].filter(Boolean).join(" · ")}`,
      );
    if (r.inspection)
      lines.push(
        ...renderInspection(r.inspection)
          .split("\n")
          .map((l) => `  ${l}`),
      );
    lines.push("");
  }
  return lines.join("\n");
}
