/**
 * Decompression-bomb check for PDFs (R3-SEC-1), run in the PDF child process before pdf.js sees the file.
 *
 * Two layers of FlateDecode compress about a million to one: a 2 KB PDF can declare a gigabyte of content, and
 * pdf.js decodes it into buffers outside the V8 heap. So every stream is decoded here first, through its filter
 * chain, with `zlib`'s `maxOutputLength` against one budget for the whole file (64 MB). Chains longer than two
 * filters are refused, as are filters given by indirect reference (an obfuscation pdf.js would follow).
 *
 * Streams marked `/Subtype /Image` don't count against the shared budget (text extraction doesn't decode images, and
 * audit reports carry megabytes of screenshots), but each must still decode within the budget on its own, so an
 * image-labelled bomb used as page content is caught too. Encrypted streams can't be inspected before pdf.js
 * decrypts them; the RSS watchdog on the child process (extract-pool.ts) is the backstop for those.
 *
 * The check must see each stream the way pdf.js reads it (R4-14). A stream's dictionary is read back from the
 * `stream` keyword to its opening `<<`, through nested dictionaries and strings, and refused when it is over 64 KB or
 * can't be delimited without guessing (a comment, an unbalanced string): a `/Filter` hidden before a decoy `obj` or
 * behind padding used to go unseen. A stream's data is read like pdf.js reads it: what `/Length` says (resolved when
 * it's an indirect reference to a plain integer object) when an `endstream` follows it, so an `endstream` planted
 * inside the data can't cut the check short; otherwise up to the first `endstream`, as pdf.js repairs a wrong length.
 *
 * Plain erasable TypeScript with node: imports only, so the child process runs it from source and from dist/.
 */
import { constants, inflateRawSync, inflateSync } from "node:zlib";

export const PDF_DECODE_BUDGET = 64 * 1024 * 1024;
export const MAX_FILTERS = 2;
/** Stream dictionaries larger than this are refused (R4-14); real ones are a few hundred bytes. */
export const MAX_STREAM_DICT = 64 * 1024;

export class PdfRejectedError extends Error {}

export interface PdfInspection {
  streams: number;
  /** Bytes the inspected streams decode to. */
  decodedBytes: number;
  /** Image streams (checked one by one, not counted in decodedBytes). */
  images: number;
}

const ALIASES: Record<string, string> = { Fl: "FlateDecode", AHx: "ASCIIHexDecode", A85: "ASCII85Decode", LZW: "LZWDecode", RL: "RunLengthDecode" };
/** Image codecs: text extraction never decodes them, so a chain stops counting there. */
const IMAGE_CODECS = new Set(["DCTDecode", "JPXDecode", "JBIG2Decode", "CCITTFaxDecode", "DCT", "CCF"]);

/** `#xx` escapes in PDF names (`/Fl#61teDecode` is `/FlateDecode` to pdf.js). */
function decodeNames(text: string): string {
  return text.includes("#") ? text.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16))) : text;
}

/** The filter names in a stream dictionary (name escapes decoded), in order; null when there's no /Filter. */
export function streamFilters(dict: string): string[] | null {
  const keys = [...dict.matchAll(/\/Filter(?=[\s[/\d<(%])/g)];
  if (!keys.length) return null;
  if (keys.length > 1) throw new PdfRejectedError("a stream dictionary has more than one /Filter");
  const at = keys[0]!.index;
  const rest = dict.slice(at + 7, at + 7 + 600).trimStart();
  if (/^\d+\s+\d+\s+R/.test(rest)) throw new PdfRejectedError("a stream's /Filter is an indirect reference");
  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    if (end < 0) throw new PdfRejectedError("a stream's /Filter array isn't closed");
    const inner = rest.slice(1, end);
    if (/\d+\s+\d+\s+R/.test(inner)) throw new PdfRejectedError("a stream's /Filter array holds an indirect reference");
    return [...inner.matchAll(/\/([A-Za-z0-9]{1,40})/g)].map((m) => ALIASES[m[1]!] ?? m[1]!);
  }
  const name = /^\/([A-Za-z0-9]{1,40})/.exec(rest);
  return name ? [ALIASES[name[1]!] ?? name[1]!] : null;
}

function inflate(data: Buffer, max: number): Buffer {
  const opts = { maxOutputLength: Math.max(1, max), finishFlush: constants.Z_SYNC_FLUSH };
  try {
    return inflateSync(data, opts);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError) throw e;
    // Some writers emit raw deflate without the zlib header; pdf.js copes, so this check must too.
    return inflateRawSync(data, opts);
  }
}

/** A growable output buffer that refuses to pass `max` bytes. */
class Sink {
  private buf = Buffer.allocUnsafe(64 * 1024);
  private readonly max: number;
  len = 0;
  constructor(max: number) {
    this.max = max;
  }
  private room(n: number) {
    if (this.len + n > this.max) throw new RangeError("decoded output over budget");
    if (this.len + n <= this.buf.length) return;
    const next = Buffer.allocUnsafe(Math.min(Math.max(this.buf.length * 2, this.len + n), Math.max(this.max, this.len + n)));
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  byte(b: number) {
    this.room(1);
    this.buf[this.len++] = b;
  }
  fill(b: number, n: number) {
    this.room(n);
    this.buf.fill(b, this.len, this.len + n);
    this.len += n;
  }
  bytes(src: Buffer) {
    this.room(src.length);
    src.copy(this.buf, this.len);
    this.len += src.length;
  }
  result(): Buffer {
    return this.buf.subarray(0, this.len);
  }
}

function asciiHex(data: Buffer): Buffer {
  const out = new Sink(data.length);
  let hi = -1;
  for (const c of data) {
    if (c === 0x3e) break; // ">" ends the data
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out.byte(hi * 16 + v);
      hi = -1;
    }
  }
  if (hi >= 0) out.byte(hi * 16);
  return out.result();
}

function ascii85(data: Buffer, max: number): Buffer {
  const out = new Sink(max);
  const group: number[] = [];
  const flush = (n: number) => {
    let v = 0;
    for (let k = 0; k < 5; k++) v = v * 85 + (group[k] ?? 84);
    for (let k = 0; k < n; k++) out.byte(Math.floor(v / 256 ** (3 - k)) % 256);
    group.length = 0;
  };
  for (const c of data) {
    if (c === 0x7e) break; // "~>" ends the data
    if (c === 0x7a && group.length === 0) out.fill(0, 4);
    else if (c >= 0x21 && c <= 0x75) {
      group.push(c - 33);
      if (group.length === 5) flush(4);
    }
  }
  if (group.length > 1) flush(group.length - 1);
  return out.result();
}

function runLength(data: Buffer, max: number): Buffer {
  const out = new Sink(max);
  for (let i = 0; i < data.length; ) {
    const n = data[i]!;
    if (n === 128) break;
    if (n < 128) {
      out.bytes(data.subarray(i + 1, i + 2 + n));
      i += n + 2;
    } else {
      out.fill(data[i + 1] ?? 0, 257 - n);
      i += 2;
    }
  }
  return out.result();
}

/** LZW, PDF flavour: MSB-first codes of 9 to 12 bits, 256 clears the table, 257 ends the data. */
function lzw(data: Buffer, max: number, earlyChange = 1): Buffer {
  const prefix = new Int16Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    suffix[i] = i;
    first[i] = i;
    length[i] = 1;
  }
  const out = new Sink(max);
  const scratch = Buffer.alloc(4096);
  const emit = (code: number) => {
    const n = length[code]!;
    for (let c = code, k = n - 1; k >= 0; k--, c = prefix[c]!) scratch[k] = suffix[c]!;
    out.bytes(scratch.subarray(0, n));
  };
  let next = 258;
  let width = 9;
  let prev = -1;
  let bits = 0;
  let acc = 0;
  for (const byte of data) {
    acc = ((acc << 8) | byte) & 0xffffff;
    bits += 8;
    while (bits >= width) {
      bits -= width;
      const code = (acc >>> bits) & ((1 << width) - 1);
      if (code === 257) return out.result();
      if (code === 256) {
        next = 258;
        width = 9;
        prev = -1;
        continue;
      }
      if (prev < 0) {
        if (code > 255) throw new PdfRejectedError("malformed LZW data");
        emit(code);
        prev = code;
        continue;
      }
      if (code > next || (code === next && next >= 4096)) throw new PdfRejectedError("malformed LZW data");
      if (next < 4096) {
        // The new entry is the previous string plus the first byte of this one (of itself, when code === next).
        prefix[next] = prev;
        suffix[next] = code === next ? first[prev]! : first[code]!;
        first[next] = first[prev]!;
        length[next] = length[prev]! + 1;
        next++;
        if (next + earlyChange >= 1 << width && width < 12) width++;
      }
      emit(code);
      prev = code;
    }
  }
  return out.result();
}

/** PDF whitespace: NUL, tab, LF, FF, CR, space. */
function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0c || code === 0x00;
}

function isHexOrSpace(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66) || isSpace(code);
}

/**
 * Start of the line holding position `i` (just after the previous CR or LF), looking back at most MAX_STREAM_DICT
 * characters; -1 when the line is longer than that.
 */
function lineStart(s: string, i: number): number {
  const floor = Math.max(0, i - MAX_STREAM_DICT);
  for (let j = i - 1; j >= floor; j--) {
    const c = s.charCodeAt(j);
    if (c === 0x0a || c === 0x0d) return j + 1;
  }
  return floor === 0 ? 0 : -1;
}

/**
 * Characters the backward dictionary scans may read in one file. Honest dictionaries never overlap, so this stays
 * near the file's size; overlapping ones (a dictionary swallowing earlier streams) would make the check quadratic.
 */
class ScanBudget {
  private left: number;
  constructor(fileLength: number) {
    this.left = 2 * fileLength + 1024 * 1024;
  }
  spend(n: number) {
    this.left -= n;
    if (this.left < 0) throw new PdfRejectedError("the PDF's stream dictionaries overlap (malformed or hostile)");
  }
}

const unclearDict = (why: string) => new PdfRejectedError(`a stream dictionary can't be read unambiguously (${why})`);
const dictTooBig = () => new PdfRejectedError(`a stream dictionary is larger than ${MAX_STREAM_DICT / 1024} KB`);

/**
 * End (exclusive, just after its `>>`) of the dictionary in front of the `stream` keyword at `at`, skipping
 * whitespace and comments as pdf.js does; -1 when no dictionary is there, in which case pdf.js doesn't read a stream.
 */
function dictEndBefore(s: string, at: number, scan: ScanBudget): number {
  let i = at;
  for (let lines = 0; lines < 64; lines++) {
    const from = i;
    while (i > 0 && isSpace(s.charCodeAt(i - 1))) i--;
    scan.spend(from - i);
    if (s[i - 1] === ">" && s[i - 2] === ">") return i;
    // A comment between the dictionary and the keyword: drop it and look at what's before.
    const line = lineStart(s, i);
    if (line < 0) throw unclearDict("a line over 64 KB before 'stream'");
    scan.spend(i - line);
    const pct = s.indexOf("%", line);
    if (pct < 0 || pct >= i) return -1;
    i = pct;
  }
  return -1;
}

/** Index of the `(` that opens the literal string closed by the `)` at `close`, honouring escapes and nesting. */
function literalStart(s: string, close: number, floor: number): number {
  let depth = 1;
  for (let j = close - 1; j >= 0; j--) {
    if (j < floor) throw dictTooBig();
    const c = s[j];
    if (c !== "(" && c !== ")") continue;
    // An odd run of backslashes escapes the parenthesis; the run is inside the dictionary, so it's bounded too.
    let k = j;
    while (k > 0 && s[k - 1] === "\\") {
      k--;
      if (k < floor) throw dictTooBig();
    }
    if ((j - k) % 2 === 1) continue;
    depth += c === ")" ? 1 : -1;
    if (depth === 0) return j;
  }
  throw unclearDict("an unbalanced ')'");
}

/**
 * Start of the stream dictionary that ends (exclusive) at `end`, read backwards through nested dictionaries and
 * literal and hex strings the way pdf.js reads it forwards. Refuses a dictionary over MAX_STREAM_DICT, and one that
 * can't be delimited without guessing (a comment could hide its `<<` or a `/Filter` from this scan but not from pdf.js).
 */
function streamDictStart(s: string, end: number, scan: ScanBudget): number {
  const floor = end - MAX_STREAM_DICT;
  let depth = 0;
  let i = end;
  while (i > 0) {
    if (i < floor) throw dictTooBig();
    const c = s[i - 1];
    if (c === ">") {
      if (s[i - 2] === ">") {
        depth++;
        i -= 2;
        continue;
      }
      // A hex string: hex digits and whitespace back to its "<".
      let j = i - 2;
      while (j >= 0 && j >= floor && isHexOrSpace(s.charCodeAt(j))) j--;
      if (j < floor) throw dictTooBig();
      if (j < 0 || s[j] !== "<") throw unclearDict("a stray '>'");
      i = j;
      continue;
    }
    if (c === "<") {
      if (s[i - 2] !== "<") throw unclearDict("a stray '<'");
      depth--;
      i -= 2;
      if (depth > 0) continue;
      scan.spend(end - i);
      // A comment earlier on this line would hide this "<<" from pdf.js, and the real start with it.
      const line = lineStart(s, i);
      if (line < 0 || s.slice(line, i).includes("%")) throw unclearDict("a comment, or a line over 64 KB, before its '<<'");
      return i;
    }
    if (c === ")") {
      i = literalStart(s, i - 1, floor);
      continue;
    }
    if (c === "(") throw unclearDict("an unbalanced '('");
    if (c === "%") throw unclearDict("a comment");
    i--;
  }
  throw unclearDict("no opening '<<'");
}

type StreamLength = { direct: number } | { ref: string } | null;

/** The dictionary's `/Length`: a direct integer, an indirect reference ("12 0"), or null when absent or unusable. */
function streamLength(dict: string): StreamLength {
  const keys = [...dict.matchAll(/\/Length(?=[\s/<>[\]()%])/g)];
  if (!keys.length) return null;
  if (keys.length > 1) throw new PdfRejectedError("a stream dictionary has more than one /Length");
  const rest = dict.slice(keys[0]!.index + 7, keys[0]!.index + 7 + 60);
  const ref = /^\s*(\d{1,10})\s+(\d{1,5})\s+R(?![A-Za-z0-9])/.exec(rest);
  if (ref) return { ref: `${Number(ref[1])} ${Number(ref[2])}` };
  // pdf.js reads "+1234" and "1234.0" as the integer 1234; anything else falls back to the first `endstream`.
  const n = /^\s*\+?(\d{1,15})(?:\.0*)?(?![\d.])/.exec(rest);
  return n ? { direct: Number(n[1]) } : null;
}

/** Integer objects written in plain text (`12 0 obj 3456 endobj`), for indirect `/Length`s; built on first use. */
function integerObjects(s: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const m of s.matchAll(/(?<![\d])(\d{1,10})\s+(\d{1,5})\s+obj\s*(\d{1,15})\s*endobj/g)) {
    const key = `${Number(m[1])} ${Number(m[2])}`;
    out.set(key, [...(out.get(key) ?? []), Number(m[3])]);
  }
  return out;
}

/** Where an `endstream` keyword starts after `from`, allowing only whitespace in between; -1 when there's none. */
function endstreamAt(s: string, from: number): number {
  let k = from;
  while (k < s.length && isSpace(s.charCodeAt(k))) k++;
  return s.startsWith("endstream", k) ? k : -1;
}

/**
 * Walks every `stream … endstream` in the file, decodes it through its filters against the shared budget, and
 * throws PdfRejectedError when the file declares more decoded content than the budget or uses a chain longer than
 * MAX_FILTERS, or when a stream's dictionary or length can't be read the way pdf.js reads them (R4-14). Damaged
 * streams that can't be decoded count at their raw size, as pdf.js would skip or repair them.
 */
export function inspectPdf(bytes: Uint8Array, budget = PDF_DECODE_BUDGET): PdfInspection {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const s = buf.toString("latin1");
  let remaining = budget;
  let streams = 0;
  let images = 0;
  let pos = 0;
  const scan = new ScanBudget(s.length);
  let integers: Map<string, number[]> | null = null;
  const overBudget = () =>
    new PdfRejectedError(`the PDF's streams decode to more than ${Math.round(budget / 1024 / 1024)} MB (a decompression bomb, or too big to extract)`);
  for (;;) {
    const at = s.indexOf("stream", pos);
    if (at < 0) break;
    pos = at + 6;
    if (s.startsWith("end", at - 3)) continue;
    // The keyword is followed by CRLF or LF; anything else is a name or text that merely contains "stream".
    let start = at + 6;
    if (s[start] === "\r") start++;
    if (s[start] !== "\n") {
      if (start === at + 6) continue;
    } else start++;
    // Part of a longer word ("upstream"), or not after a dictionary: pdf.js doesn't read a stream here either.
    if (at > 0 && !isSpace(s.charCodeAt(at - 1)) && s[at - 1] !== ">") continue;
    const dictEnd = dictEndBefore(s, at, scan);
    if (dictEnd < 0) continue;
    const dict = decodeNames(s.slice(streamDictStart(s, dictEnd, scan), dictEnd));
    // The data, read the way pdf.js reads it (R5-10): `/Length` when an `endstream` follows it (so an `endstream`
    // planted inside the data can't end this check early), otherwise up to the first `endstream`. A file with
    // neither is refused.
    const first = s.indexOf("endstream", start);
    const length = streamLength(dict);
    let candidates: number[] = [];
    if (length && "direct" in length) candidates = [length.direct];
    else if (length) {
      integers ??= integerObjects(s);
      candidates = integers.get(length.ref) ?? [];
    }
    const byLength = candidates.map((n) => ({ n, k: endstreamAt(s, start + n) })).find((x) => x.k >= 0);
    let stop: number;
    if (byLength) {
      stop = start + byLength.n;
      pos = byLength.k;
    } else if (first >= 0) {
      stop = first;
      pos = first;
    } else throw new PdfRejectedError("a stream has neither a usable /Length nor an 'endstream' (malformed or hostile)");
    streams++;
    // Images don't count against the shared budget, but each must fit in it on its own.
    const image = /\/Subtype\s*\/Image\b/.test(dict);
    if (image) images++;
    const cap = image ? budget : remaining;
    let data: Buffer = buf.subarray(start, stop);
    const filters = streamFilters(dict) ?? [];
    if (filters.length > MAX_FILTERS) throw new PdfRejectedError(`a stream uses ${filters.length} filters (at most ${MAX_FILTERS} are accepted)`);
    try {
      for (const f of filters) {
        if (IMAGE_CODECS.has(f) || f === "Crypt") break;
        if (f === "FlateDecode") data = inflate(data, cap);
        else if (f === "LZWDecode") data = lzw(data, cap);
        else if (f === "ASCIIHexDecode") data = asciiHex(data);
        else if (f === "ASCII85Decode") data = ascii85(data, cap);
        else if (f === "RunLengthDecode") data = runLength(data, cap);
        else break; // unknown filter: pdf.js passes the bytes through
        if (data.length > cap) throw overBudget();
      }
    } catch (e) {
      if (e instanceof PdfRejectedError) throw e;
      if (e instanceof RangeError || (e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw overBudget();
      // Undecodable (damaged or encrypted): count the bytes as they are.
    }
    if (image) continue;
    remaining -= data.length;
    if (remaining < 0) throw overBudget();
  }
  return { streams, decodedBytes: budget - remaining, images };
}

/** A one-page PDF with real xref offsets (boot self-test and tests). `content` is the raw page content stream. */
export function buildPdf(content: Buffer | string, opts: { filters?: string[]; extraDict?: string } = {}): Uint8Array {
  const body = typeof content === "string" ? Buffer.from(content, "latin1") : content;
  const filter = opts.filters?.length ? ` /Filter [${opts.filters.map((f) => `/${f}`).join(" ")}]` : "";
  const head = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let size = parts[0]!.length;
  const push = (b: Buffer) => {
    parts.push(b);
    size += b.length;
  };
  head.forEach((o, i) => {
    offsets.push(size);
    push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, "latin1"));
  });
  offsets.push(size);
  push(Buffer.from(`4 0 obj\n<< /Length ${body.length}${filter}${opts.extraDict ?? ""} >>\nstream\n`, "latin1"));
  push(body);
  push(Buffer.from("\nendstream\nendobj\n", "latin1"));
  offsets.push(size);
  push(Buffer.from("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n", "latin1"));
  const xref = size;
  push(
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
      "latin1",
    ),
  );
  return new Uint8Array(Buffer.concat(parts));
}

/** A one-page PDF showing `text` (escaped for a PDF string). */
export function textPdf(text: string): Uint8Array {
  const esc = text.replace(/[\\()]/g, (c) => `\\${c}`);
  return buildPdf(`BT /F1 12 Tf 72 720 Td (${esc}) Tj ET`);
}
