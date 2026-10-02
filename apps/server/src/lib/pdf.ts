/**
 * PDF text extraction (SRC-17): Exa `/contents` first (it caches and extracts most public PDFs), then pdf.js via
 * unpdf in a child process (R3-SEC-1). GitHub `blob` links are rewritten to raw URLs, which both paths can read.
 */
import { githubBlobToRaw } from "../services/classify.ts";
import { exaContents, hasExa } from "./externals.ts";
import { extractPdfInChild, PDF_MAX_PAGES } from "./extract-pool.ts";
import { safeFetch } from "./fetcher.ts";

export const PDF_MAX_BYTES = 40 * 1024 * 1024;
const PDF_TIMEOUT_MS = 90_000;

export interface PdfExtraction {
  url: string;
  title: string;
  text: string;
  via: "exa" | "unpdf";
  pages?: number;
}

/**
 * pdf.js text of a PDF body, in a child process with a memory limit and a deadline, after a decompression-bomb check
 * (R3-SEC-1, see pdf-child.ts). Reads at most PDF_MAX_PAGES pages and about `maxChars` characters.
 */
export async function pdfBytesToText(bytes: Uint8Array, opts: { maxChars?: number } = {}): Promise<{ text: string; pages: number }> {
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) throw new Error("not a PDF");
  const r = await extractPdfInChild(bytes, PDF_TIMEOUT_MS, { maxPages: PDF_MAX_PAGES, maxChars: opts.maxChars });
  return { text: r.text, pages: r.pages };
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find((l) => l.length >= 4 && l.length <= 160) ?? ""
  );
}

/**
 * Extracts a PDF's text. `bytes` skips the download when the caller already has the body. Throws when neither
 * path yields text (scanned PDFs without OCR, broken files).
 */
export async function extractPdf(url: string, opts: { bytes?: Uint8Array; maxCharacters?: number; preferLocal?: boolean } = {}): Promise<PdfExtraction> {
  const fetchUrl = githubBlobToRaw(url);
  const max = opts.maxCharacters ?? 300_000;
  const viaExa = async (): Promise<PdfExtraction | null> => {
    if (!hasExa()) return null;
    try {
      const [r] = await exaContents([fetchUrl], { maxCharacters: max });
      if (r?.ok && r.text.trim().length > 200) return { url, title: r.title || firstLine(r.text), text: r.text, via: "exa" };
    } catch {
      // fall back to local extraction
    }
    return null;
  };
  const viaLocal = async (): Promise<PdfExtraction | null> => {
    let bytes = opts.bytes;
    if (!bytes) {
      const res = await safeFetch(fetchUrl, { maxBytes: PDF_MAX_BYTES, timeoutMs: 60_000 });
      if (res.status >= 400) throw new Error(`HTTP ${res.status} for ${new URL(fetchUrl).host}`);
      bytes = new Uint8Array(res.body.buffer, res.body.byteOffset, res.body.byteLength);
    }
    // A little over `max`: the cleanup below only removes whitespace before the final cut.
    const { text, pages } = await pdfBytesToText(bytes, { maxChars: Math.ceil(max * 1.2) });
    const clean = text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (clean.length < 100) return null;
    return { url, title: firstLine(clean), text: clean.slice(0, max), via: "unpdf", pages };
  };
  const order = opts.preferLocal && opts.bytes ? [viaLocal, viaExa] : [viaExa, viaLocal];
  let lastError: Error | null = null;
  for (const step of order) {
    try {
      const r = await step();
      if (r) return r;
    } catch (e) {
      lastError = e as Error;
    }
  }
  throw lastError ?? new Error("no text could be extracted from the PDF");
}

/** IPFS gateways that still serve files to servers (ipfs.io and dweb.link now answer only in browsers; cf-ipfs.com closed). */
const IPFS_GATEWAYS = ["https://gateway.pinata.cloud", "https://ipfs.filebase.io"];
const CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;

/**
 * Other addresses of the same document, for when its link is dead: IPFS content, which is addressed by its CID,
 * through gateways that still serve it, and an http:// link over https. Pure.
 */
export function documentMirrors(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const out: string[] = [];
  const labels = u.hostname.split(".");
  const path = u.pathname.match(/^\/ipfs\/([^/]+)(\/.*)?$/);
  const [cid, rest] =
    labels.length > 2 && labels[1] === "ipfs" && CID.test(labels[0]!)
      ? [labels[0]!, u.pathname]
      : path && CID.test(path[1]!)
        ? [path[1]!, path[2] ?? ""]
        : [null, ""];
  if (cid) for (const g of IPFS_GATEWAYS) if (new URL(g).host !== u.host) out.push(`${g}/ipfs/${cid}${rest}${u.search}`);
  if (u.protocol === "http:") out.push(`https:${url.slice("http:".length)}`);
  return out;
}

/** `extractPdf`, then each mirror of the URL in turn; the result's `url` is the address that worked. */
export async function extractPdfFromAnywhere(url: string, opts: { maxCharacters?: number } = {}): Promise<PdfExtraction> {
  try {
    return await extractPdf(url, opts);
  } catch (e) {
    for (const alt of documentMirrors(url)) {
      try {
        return await extractPdf(alt, opts);
      } catch {
        // the next mirror
      }
    }
    throw e;
  }
}
