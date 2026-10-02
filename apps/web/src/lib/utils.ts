import { type ClassValue, clsx } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/**
 * Fixed-precision number for dense cells. Rounds half up at display precision, the same way the animated
 * hero numbers and best-in-row highlighting do (`toFixed` alone rounds 0.15 down to "0.1").
 */
export function fmtNum(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const p = 10 ** digits;
  return (Math.round(v * p) / p + 0).toFixed(digits);
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  const s = fmtNum(v, digits);
  return s === "—" ? s : `${s}%`;
}

export function round1(v: number) {
  return Math.round(v * 10) / 10;
}

export function fmtDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }) {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", opts);
}

export function fmtUsd(v: number) {
  return v < 0.01 && v > 0 ? "<$0.01" : `$${v.toFixed(v < 10 ? 2 : 0)}`;
}

export function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Deterministic pastel from a string, for logo fallbacks. */
export function hueOf(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** The phone breakpoint behind layout decisions: pivot table, bottom sheets, default column count. */
export const MOBILE_QUERY = "(max-width: 767px)";
export function isMobileViewport() {
  return typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches;
}

/** Runs `fn` once the browser is idle (a short timeout where requestIdleCallback is missing, e.g. Safari). Returns a cancel function. */
export function onIdle(fn: () => void, timeout = 2000): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(() => fn(), { timeout });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 1200);
  return () => clearTimeout(id);
}

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode or blocked storage; the setting just won't persist
  }
}

const EXPLORERS: Record<string, string> = {
  "1": "etherscan.io",
  "10": "optimistic.etherscan.io",
  "56": "bscscan.com",
  "137": "polygonscan.com",
  "8453": "basescan.org",
  "42161": "arbiscan.io",
  "11155111": "sepolia.etherscan.io",
};

/**
 * An href built from data (evidence, sources, websites, release links) or null. Only absolute http(s) URLs pass,
 * so a stored `javascript:` or `data:` URL can never become a clickable link.
 */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    // No base URL: relative and scheme-less input is rejected instead of resolving against this page.
    const u = new URL(url.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Onchain reads are stored as evm://<chainId>/<address>; link them to a block explorer. */
export function sourceLink(url: string): string | null {
  const evm = url.match(/^evm:\/\/(\d+)\/(0x[0-9a-fA-F]{40})/);
  if (evm) return EXPLORERS[evm[1]!] ? `https://${EXPLORERS[evm[1]!]}/address/${evm[2]}` : null;
  // Only real web links: attestations (attestation://), editor notes and local placeholders have no page to open.
  return !url.includes(".local/") ? safeHref(url) : null;
}
