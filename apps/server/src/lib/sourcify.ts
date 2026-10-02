/**
 * Sourcify v2 reader: verification status, contract name, compiler, proxy resolution and verified sources of a
 * deployed contract. Used by the address-registry lane and exposable as an evaluation tool.
 */
import { safeFetch } from "./fetcher.ts";

export interface SourcifyContract {
  chainId: number;
  address: string;
  /** "match" (exact), "partial" (metadata differs) or null when not verified. */
  match: string | null;
  name: string | null;
  fullyQualifiedName: string | null;
  compiler: string | null;
  verifiedAt: string | null;
  proxy: { isProxy: boolean; type: string | null; implementations: { address: string; name: string | null }[] } | null;
  /** Source files by path; library code (OpenZeppelin, forge-std, node_modules) is listed after the project's own. */
  sources: { path: string; content: string; library: boolean }[];
  abiFunctions: string[];
}

const LIBRARY_PATH = /(^|\/)(node_modules|lib|dependencies|@openzeppelin|openzeppelin-contracts|forge-std|solmate|solady)(\/|$)|^@/i;

/** The human-facing Sourcify page for a contract. */
export function sourcifyUrl(chainId: number, address: string): string {
  return `https://repo.sourcify.dev/${chainId}/${address}`;
}

/** Looks a contract up on Sourcify. Null when Sourcify has no verified source for it. */
export async function lookupSourcify(chainId: number, address: string, opts: { sources?: boolean } = {}): Promise<SourcifyContract | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !Number.isInteger(chainId) || chainId <= 0) throw new Error("Invalid chain id or address");
  const fields = opts.sources === false ? "proxyResolution,compilation,abi" : "sources,abi,proxyResolution,compilation";
  const res = await safeFetch(`https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=${fields}`, {
    headers: { accept: "application/json" },
    maxBytes: 32 * 1024 * 1024,
    timeoutMs: 30_000,
  });
  if (res.status === 404) return null;
  if (res.status >= 400) throw new Error(`Sourcify ${res.status} for ${chainId}:${address}`);
  type R = {
    match?: string | null;
    verifiedAt?: string | null;
    compilation?: { name?: string; fullyQualifiedName?: string; compilerVersion?: string; language?: string };
    proxyResolution?: { isProxy?: boolean; proxyType?: string | null; implementations?: { address: string; name?: string | null }[] } | null;
    sources?: Record<string, { content?: string }>;
    abi?: { type?: string; name?: string; inputs?: { type: string }[]; stateMutability?: string }[];
  };
  const j = JSON.parse(res.body.toString("utf8")) as R;
  if (!j.match) return null;
  const sources = Object.entries(j.sources ?? {})
    .map(([path, s]) => ({ path, content: s.content ?? "", library: LIBRARY_PATH.test(path) }))
    .sort((a, b) => Number(a.library) - Number(b.library) || a.path.localeCompare(b.path));
  return {
    chainId,
    address,
    match: j.match ?? null,
    name: j.compilation?.name ?? null,
    fullyQualifiedName: j.compilation?.fullyQualifiedName ?? null,
    compiler: j.compilation ? `${j.compilation.language ?? ""} ${j.compilation.compilerVersion ?? ""}`.trim() : null,
    verifiedAt: j.verifiedAt ?? null,
    proxy: j.proxyResolution
      ? {
          isProxy: !!j.proxyResolution.isProxy,
          type: j.proxyResolution.proxyType ?? null,
          implementations: (j.proxyResolution.implementations ?? []).map((i) => ({ address: i.address, name: i.name ?? null })),
        }
      : null,
    sources,
    abiFunctions: (j.abi ?? [])
      .filter((f) => f.type === "function" && f.name)
      .map(
        (f) =>
          `${f.name}(${(f.inputs ?? []).map((i) => i.type).join(",")})${f.stateMutability && f.stateMutability !== "nonpayable" ? ` ${f.stateMutability}` : ""}`,
      ),
  };
}

/** Chains where Sourcify has a verified contract at this address. */
export async function sourcifyChainsFor(address: string): Promise<number[]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return [];
  const res = await safeFetch(`https://sourcify.dev/server/v2/contract/all-chains/${address}`, { headers: { accept: "application/json" }, timeoutMs: 20_000 });
  if (res.status >= 400) return [];
  const j = JSON.parse(res.body.toString("utf8")) as { results?: { chainId: string; match?: string | null }[] };
  return (j.results ?? []).filter((r) => r.match).map((r) => Number(r.chainId));
}

/** Readable summary plus sources, for storing as a code source (sources capped at `maxChars`). */
export function renderSourcify(c: SourcifyContract, maxChars = 400_000): string {
  const head = [
    `# ${c.name ?? "Contract"} · chain ${c.chainId} · ${c.address}`,
    `Sourcify: ${c.match === "exact_match" || c.match === "match" ? "exact match" : (c.match ?? "not verified")}${c.verifiedAt ? ` (verified ${c.verifiedAt.slice(0, 10)})` : ""}`,
    c.fullyQualifiedName ? `Contract: ${c.fullyQualifiedName}` : "",
    c.compiler ? `Compiler: ${c.compiler}` : "",
    c.proxy?.isProxy
      ? `Proxy: ${c.proxy.type ?? "yes"} → ${c.proxy.implementations.map((i) => `${i.name ?? "implementation"} ${i.address}`).join(", ") || "implementation unknown"}`
      : "Proxy: no",
    c.abiFunctions.length ? `\nFunctions: ${c.abiFunctions.join(", ")}` : "",
  ].filter(Boolean);
  let body = "";
  for (const s of c.sources) {
    const block = `\n\n## ${s.path}${s.library ? " (library)" : ""}\n\`\`\`solidity\n${s.content}\n\`\`\``;
    if (body.length + block.length > maxChars) {
      body += `\n\n(${c.sources.length} source files in total; the rest were omitted for size.)`;
      break;
    }
    body += block;
  }
  return `${head.join("\n")}${body}`;
}
