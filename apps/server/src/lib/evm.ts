/**
 * Read-only onchain inspection for the code-analysis stage: who owns a contract, whether it's a proxy
 * and who administers it, Safe signers, thresholds, modules and guard, timelock delays, AccessControl admins,
 * and arbitrary view calls. Reads run in parallel (EFF-23) on one cached client per chain.
 */
import {
  type Abi,
  type AbiFunction,
  type Address,
  createPublicClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  type PublicClient,
  parseAbiItem,
  toHex,
} from "viem";
import { redact } from "./redact.ts";

const DEFAULT_RPC: Record<number, string> = {
  1: "https://ethereum-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  56: "https://bsc-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  8453: "https://base-rpc.publicnode.com",
  42161: "https://arbitrum-one-rpc.publicnode.com",
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
};

export const SUPPORTED_CHAINS = Object.keys(DEFAULT_RPC).map(Number);

const clients = new Map<number, PublicClient>();

function client(chainId: number): PublicClient {
  const cached = clients.get(chainId);
  if (cached) return cached;
  const url = process.env[`RPC_URL_${chainId}`] || DEFAULT_RPC[chainId];
  if (!url) throw new Error(`Unsupported chain ${chainId}. Supported: ${SUPPORTED_CHAINS.join(", ")} (or set RPC_URL_${chainId})`);
  const c = createPublicClient({ transport: http(url, { timeout: 20_000, retryCount: 2, batch: { batchSize: 20, wait: 10 } }) }) as PublicClient;
  clients.set(chainId, c);
  return c;
}

export function isSupportedChain(chainId: number): boolean {
  return !!(process.env[`RPC_URL_${chainId}`] || DEFAULT_RPC[chainId]);
}

const SLOTS = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  /** keccak256("org.zeppelinos.proxy.implementation"), older OpenZeppelin proxies. */
  zosImplementation: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
  /** keccak256("guard_manager.guard.address"), the Safe transaction guard. */
  safeGuard: "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8",
  /** keccak256("fallback_manager.handler.address"), the Safe fallback handler. */
  safeFallback: "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5",
} as const;

const SENTINEL = "0x0000000000000000000000000000000000000001";
const ZERO_ROLE = `0x${"0".repeat(64)}` as const;

function slotAddress(v: `0x${string}` | undefined): string | null {
  if (!v || /^0x0*$/.test(v)) return null;
  return getAddress(`0x${v.slice(-40)}`);
}

function fmt(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}

async function tryRead(c: PublicClient, address: Address, sig: string, args: unknown[] = []): Promise<unknown> {
  try {
    const item = parseAbiItem(sig) as AbiFunction;
    return await c.readContract({ address, abi: [item] as Abi, functionName: item.name, args: args as never });
  } catch {
    return undefined;
  }
}

export interface AddressInspection {
  chainId: number;
  address: string;
  block: string;
  isContract: boolean;
  bytecodeBytes: number;
  proxy: {
    implementation: string | null;
    admin: string | null;
    beacon: string | null;
    beaconImplementation: string | null;
    legacyImplementation: string | null;
    /** True when proxiableUUID() returns the EIP-1967 slot (UUPS: the implementation carries the upgrade logic). */
    uups: boolean;
  };
  /** Labelled view-call results that answered (owner, admin, paused, delays...). */
  reads: [label: string, value: string][];
  safe: { threshold: string; owners: string[]; version: string | null; modules: string[] | null; guard: string | null; fallbackHandler: string | null } | null;
  accessControl: {
    defaultAdminHolders: string[] | null;
    defaultAdmin: string | null;
    defaultAdminDelay: string | null;
    ownerIsDefaultAdmin: boolean | null;
  } | null;
}

const PROBES: [string, string][] = [
  ["owner", "function owner() view returns (address)"],
  ["pendingOwner", "function pendingOwner() view returns (address)"],
  ["admin", "function admin() view returns (address)"],
  ["governance", "function governance() view returns (address)"],
  ["guardian", "function guardian() view returns (address)"],
  ["paused", "function paused() view returns (bool)"],
  ["getMinDelay (timelock)", "function getMinDelay() view returns (uint256)"],
  ["delay (timelock)", "function delay() view returns (uint256)"],
  ["implementation()", "function implementation() view returns (address)"],
  ["UPGRADE_INTERFACE_VERSION", "function UPGRADE_INTERFACE_VERSION() view returns (string)"],
];

/** Proxy, ownership, multisig and access-control facts for one address. */
export async function inspectAddressStructured(chainId: number, addr: string): Promise<AddressInspection> {
  if (!isAddress(addr)) throw new Error("Invalid address");
  const c = client(chainId);
  const address = getAddress(addr);
  try {
    const [code, block] = await Promise.all([c.getCode({ address }), c.getBlockNumber()]);
    const out: AddressInspection = {
      chainId,
      address,
      block: block.toString(),
      isContract: !!code && code !== "0x",
      bytecodeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
      proxy: { implementation: null, admin: null, beacon: null, beaconImplementation: null, legacyImplementation: null, uups: false },
      reads: [],
      safe: null,
      accessControl: null,
    };
    if (!out.isContract) return out;
    const slot = (s: `0x${string}`) => c.getStorageAt({ address, slot: s }).catch(() => undefined);
    const [impl, admin, beacon, zos, guard, fallback, uuid, probeValues, threshold, owners, version, modules, defaultAdmin, defaultAdminDelay, roleCount] =
      await Promise.all([
        slot(SLOTS.implementation),
        slot(SLOTS.admin),
        slot(SLOTS.beacon),
        slot(SLOTS.zosImplementation),
        slot(SLOTS.safeGuard),
        slot(SLOTS.safeFallback),
        tryRead(c, address, "function proxiableUUID() view returns (bytes32)"),
        Promise.all(PROBES.map(([, sig]) => tryRead(c, address, sig))),
        tryRead(c, address, "function getThreshold() view returns (uint256)"),
        tryRead(c, address, "function getOwners() view returns (address[])"),
        tryRead(c, address, "function VERSION() view returns (string)"),
        tryRead(c, address, "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)", [SENTINEL, 50n]),
        tryRead(c, address, "function defaultAdmin() view returns (address)"),
        tryRead(c, address, "function defaultAdminDelay() view returns (uint48)"),
        tryRead(c, address, "function getRoleMemberCount(bytes32 role) view returns (uint256)", [ZERO_ROLE]),
      ]);
    out.proxy.implementation = slotAddress(impl);
    out.proxy.admin = slotAddress(admin);
    out.proxy.beacon = slotAddress(beacon);
    out.proxy.legacyImplementation = slotAddress(zos);
    out.proxy.uups = typeof uuid === "string" && uuid.toLowerCase() === SLOTS.implementation;
    if (out.proxy.beacon) {
      const bi = await tryRead(c, out.proxy.beacon as Address, "function implementation() view returns (address)");
      out.proxy.beaconImplementation = typeof bi === "string" ? bi : null;
    }
    PROBES.forEach(([label], i) => {
      const v = probeValues[i];
      if (v !== undefined) out.reads.push([label, fmt(v)]);
    });
    if (threshold !== undefined && Array.isArray(owners)) {
      const mods = Array.isArray(modules) ? ((modules as unknown[])[0] as string[]) : null;
      out.safe = {
        threshold: fmt(threshold),
        owners: owners as string[],
        version: typeof version === "string" ? version : null,
        modules: mods,
        guard: slotAddress(guard),
        fallbackHandler: slotAddress(fallback),
      };
    }
    // AccessControl: enumerable holders of DEFAULT_ADMIN_ROLE, OZ v5 default-admin rules, and whether the owner holds it.
    const ownerRead = out.reads.find(([l]) => l === "owner")?.[1];
    const ownerAddr = ownerRead ? (JSON.parse(ownerRead) as string) : null;
    let holders: string[] | null = null;
    if (typeof roleCount === "bigint") {
      const n = Number(roleCount > 20n ? 20n : roleCount);
      const members = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          tryRead(c, address, "function getRoleMember(bytes32 role, uint256 index) view returns (address)", [ZERO_ROLE, BigInt(i)]),
        ),
      );
      holders = members.filter((m): m is string => typeof m === "string");
    }
    const ownerIsAdmin =
      ownerAddr && isAddress(ownerAddr)
        ? await tryRead(c, address, "function hasRole(bytes32 role, address account) view returns (bool)", [ZERO_ROLE, ownerAddr])
        : undefined;
    if (holders || typeof defaultAdmin === "string" || typeof ownerIsAdmin === "boolean") {
      out.accessControl = {
        defaultAdminHolders: holders,
        defaultAdmin: typeof defaultAdmin === "string" ? defaultAdmin : null,
        defaultAdminDelay: defaultAdminDelay !== undefined ? fmt(defaultAdminDelay) : null,
        ownerIsDefaultAdmin: typeof ownerIsAdmin === "boolean" ? ownerIsAdmin : null,
      };
    }
    return out;
  } catch (e) {
    throw new Error(redact((e as Error).message).slice(0, 500));
  }
}

/** The inspection as readable lines (the format the evm_inspect tool returns). */
export function renderInspection(r: AddressInspection): string {
  const lines = [`chain ${r.chainId} · ${r.address} · block ${r.block}`];
  if (!r.isContract) {
    lines.push("Externally owned account (no contract code).");
    return lines.join("\n");
  }
  lines.push(`Contract bytecode: ${r.bytecodeBytes} bytes`);
  if (r.proxy.implementation) lines.push(`EIP-1967 proxy implementation: ${r.proxy.implementation}`);
  if (r.proxy.admin) lines.push(`EIP-1967 proxy admin: ${r.proxy.admin}`);
  if (r.proxy.beacon)
    lines.push(`EIP-1967 beacon: ${r.proxy.beacon}${r.proxy.beaconImplementation ? ` (implementation ${r.proxy.beaconImplementation})` : ""}`);
  if (r.proxy.legacyImplementation) lines.push(`Legacy (ZeppelinOS) proxy implementation: ${r.proxy.legacyImplementation}`);
  if (r.proxy.uups) lines.push("UUPS: proxiableUUID() returns the EIP-1967 slot, so upgrades are authorized by the implementation's own logic");
  for (const [label, v] of r.reads) lines.push(`${label}: ${v}`);
  if (r.safe) {
    lines.push(`Safe getThreshold: ${r.safe.threshold}`);
    lines.push(`Safe getOwners: ${fmt(r.safe.owners)}`);
    if (r.safe.version) lines.push(`Safe VERSION: ${fmt(r.safe.version)}`);
    lines.push(`Safe modules: ${r.safe.modules ? (r.safe.modules.length ? r.safe.modules.join(", ") : "none") : "unknown"}`);
    lines.push(`Safe guard: ${r.safe.guard ?? "none"}`);
    if (r.safe.fallbackHandler) lines.push(`Safe fallback handler: ${r.safe.fallbackHandler}`);
  }
  if (r.accessControl) {
    const a = r.accessControl;
    if (a.defaultAdminHolders)
      lines.push(`AccessControl DEFAULT_ADMIN_ROLE holders: ${a.defaultAdminHolders.length ? a.defaultAdminHolders.join(", ") : "none"}`);
    if (a.defaultAdmin) lines.push(`AccessControl defaultAdmin: ${a.defaultAdmin}${a.defaultAdminDelay ? ` (delay ${a.defaultAdminDelay} s)` : ""}`);
    if (a.ownerIsDefaultAdmin !== null) lines.push(`owner holds DEFAULT_ADMIN_ROLE: ${a.ownerIsDefaultAdmin}`);
  }
  return lines.join("\n");
}

/** Proxy, ownership and multisig facts for one address, as readable lines. */
export async function inspectAddress(chainId: number, addr: string): Promise<string> {
  return renderInspection(await inspectAddressStructured(chainId, addr));
}

/** Call any view function by its human-readable signature, e.g. "function hasRole(bytes32,address) view returns (bool)". */
export async function readFunction(chainId: number, addr: string, signature: string, args: string[]): Promise<string> {
  if (!isAddress(addr)) throw new Error("Invalid address");
  const item = parseAbiItem(signature.startsWith("function") ? signature : `function ${signature}`) as AbiFunction;
  if (item.type !== "function" || !["view", "pure"].includes(item.stateMutability)) throw new Error("Only view or pure functions can be read");
  const coerced = item.inputs.map((inp, idx) => {
    const raw = args[idx] ?? "";
    if (/^u?int/.test(inp.type)) return BigInt(raw);
    if (inp.type === "bool") return raw === "true";
    if (inp.type.endsWith("[]")) return JSON.parse(raw);
    return raw;
  });
  const c = client(chainId);
  try {
    const [value, block] = await Promise.all([
      c.readContract({ address: getAddress(addr), abi: [item] as Abi, functionName: item.name, args: coerced as never }),
      c.getBlockNumber(),
    ]);
    return `chain ${chainId} · ${getAddress(addr)} · block ${block}\n${signature}\nargs: ${fmt(args)}\nresult: ${fmt(value)}`;
  } catch (e) {
    throw new Error(redact((e as Error).message).slice(0, 500));
  }
}

/** keccak256 of a role name, e.g. roleId("PAUSER_ROLE"), for hasRole reads. */
export function roleId(name: string): `0x${string}` {
  return name === "DEFAULT_ADMIN_ROLE" ? ZERO_ROLE : keccak256(toHex(name));
}
