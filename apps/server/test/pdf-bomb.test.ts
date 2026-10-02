/**
 * PDF decompression bombs (R3-SEC-1) and extraction limits (R3-REL-18). A two-layer FlateDecode stream decodes at
 * about a million to one; pdf.js would decode it into memory outside the V8 heap and take the server down. The
 * guard refuses it before pdf.js runs, and the child process's memory watchdog stops what the guard can't see.
 */
import { fork } from "node:child_process";
import { constants, createDeflate, deflateSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  checkExtraction,
  closeExtractPool,
  ExtractMemoryError,
  extractionStatus,
  extractPdfInChild,
  nodeStripsTypesByDefault,
  PDF_CHILD_PATH,
  pdfChildExecArgv,
  runExtract,
} from "../src/lib/extract-pool.ts";
import { buildPdf, inspectPdf, MAX_FILTERS, PdfRejectedError, streamFilters, textPdf } from "../src/lib/pdf-guard.ts";

afterAll(() => closeExtractPool());

const MB = 1024 * 1024;
/** `size` zero bytes behind two layers of deflate: a few hundred bytes on disk. */
const doubleDeflate = (size: number) => deflateSync(deflateSync(Buffer.alloc(size)));

/**
 * One deflate stream whose first block is stored, so its raw bytes contain `endstream`, followed by `size` spaces
 * compressed (the round-4 review's bomb2.mts).
 */
async function plantedEndstream(size: number): Promise<Buffer> {
  const d = createDeflate({ level: 0 });
  const chunks: Buffer[] = [];
  d.on("data", (c: Buffer) => chunks.push(c));
  const ended = new Promise((r) => d.on("end", r));
  d.write(Buffer.from(" % endstream \n"));
  await new Promise((r) => d.flush(constants.Z_FULL_FLUSH, () => r(null)));
  await new Promise((r) => d.params(9, constants.Z_DEFAULT_STRATEGY, () => r(null)));
  const spaces = Buffer.alloc(4 * MB, 0x20);
  for (let written = 0; written < size; written += spaces.length) if (!d.write(spaces)) await new Promise((r) => d.once("drain", r));
  d.end();
  await ended;
  return Buffer.concat(chunks);
}

/** A PDF whose content stream takes its length from object 6 (`/Length 6 0 R`). */
function indirectLengthPdf(data: Buffer, filters = "/FlateDecode"): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(`%PDF-1.4\n4 0 obj\n<< /Length 6 0 R /Filter ${filters} >>\nstream\n`, "latin1"),
      data,
      Buffer.from(`\nendstream\nendobj\n6 0 obj\n${data.length}\nendobj\n`, "latin1"),
    ]),
  );
}

describe("stream guard", () => {
  it("passes ordinary PDFs and counts what they decode to", () => {
    const plain = inspectPdf(textPdf("Audit report"));
    expect(plain.streams).toBe(1);
    const zipped = inspectPdf(buildPdf(deflateSync("BT /F1 12 Tf 72 720 Td (Compressed text) Tj ET"), { filters: ["FlateDecode"] }));
    expect(zipped.decodedBytes).toBe("BT /F1 12 Tf 72 720 Td (Compressed text) Tj ET".length);
  });

  it("refuses a double-FlateDecode bomb without decoding it all", () => {
    const bomb = buildPdf(doubleDeflate(100 * MB), { filters: ["FlateDecode", "FlateDecode"] });
    expect(bomb.length).toBeLessThan(2000);
    const started = Date.now();
    expect(() => inspectPdf(bomb)).toThrow(PdfRejectedError);
    expect(() => inspectPdf(bomb)).toThrow(/decode to more than 64 MB/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("adds up many streams against one budget", () => {
    // Twenty 4 MB streams: each is harmless, together they pass 64 MB.
    const one = deflateSync(Buffer.alloc(4 * MB));
    let body = "";
    const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
    for (let i = 0; i < 20; i++) {
      parts.push(Buffer.from(`${i + 1} 0 obj\n<< /Length ${one.length} /Filter /FlateDecode >>\nstream\n`), one, Buffer.from("\nendstream\nendobj\n"));
      body += ".";
    }
    expect(body.length).toBe(20);
    expect(() => inspectPdf(new Uint8Array(Buffer.concat(parts)))).toThrow(/decode to more than/);
  });

  it("checks image streams one by one, so an image-labelled bomb is caught too", () => {
    const img = buildPdf(doubleDeflate(100 * MB), { filters: ["FlateDecode", "FlateDecode"], extraDict: " /Subtype /Image" });
    expect(() => inspectPdf(img)).toThrow(/decode to more than/);
    // Big but real images don't count against the text budget.
    const pic = deflateSync(Buffer.alloc(40 * MB, 7));
    const parts = [Buffer.from("%PDF-1.4\n")];
    for (let i = 0; i < 3; i++)
      parts.push(
        Buffer.from(`${i + 1} 0 obj\n<< /Subtype /Image /Length ${pic.length} /Filter /FlateDecode >>\nstream\n`),
        pic,
        Buffer.from("\nendstream\nendobj\n"),
      );
    expect(inspectPdf(new Uint8Array(Buffer.concat(parts))).images).toBe(3);
  });

  it("refuses long filter chains, indirect and repeated /Filter keys, and sees through name escapes", () => {
    expect(() => inspectPdf(buildPdf("x", { filters: ["ASCIIHexDecode", "FlateDecode", "FlateDecode"] }))).toThrow(`at most ${MAX_FILTERS}`);
    expect(() => streamFilters("<< /Length 5 /Filter 7 0 R")).toThrow(/indirect/);
    expect(() => streamFilters("<< /Filter /FlateDecode /Filter /LZWDecode")).toThrow(/more than one/);
    expect(streamFilters("<< /Filter [/Fl /AHx] /Length 3")).toEqual(["FlateDecode", "ASCIIHexDecode"]);
    expect(streamFilters("<< /FilterX /Foo /Length 3")).toBeNull();
    // `/#46lateDecode` is `/FlateDecode` to pdf.js.
    const escaped = Buffer.concat([
      Buffer.from("%PDF-1.4\n1 0 obj\n<< /Fil#74er [/#46lateDecode /Fl#61teDecode] >>\nstream\n"),
      doubleDeflate(100 * MB),
      Buffer.from("\nendstream\nendobj\n"),
    ]);
    expect(() => inspectPdf(new Uint8Array(escaped))).toThrow(/decode to more than/);
  });

  it("decodes ASCII85, ASCIIHex, RunLength and LZW chains within the budget", () => {
    // LZW of "-----A---B" (the PDF reference's example), then a RunLength run of 120 bytes.
    const lzw = Buffer.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]);
    expect(inspectPdf(buildPdf(lzw, { filters: ["LZWDecode"] })).decodedBytes).toBe(10);
    expect(inspectPdf(buildPdf(Buffer.from([256 - 119, 65, 128]), { filters: ["RunLengthDecode"] })).decodedBytes).toBe(120);
    expect(inspectPdf(buildPdf("48656C6C6F>", { filters: ["ASCIIHexDecode"] })).decodedBytes).toBe(5);
    // Two "z" groups (4 zero bytes each), one full group and a 2-character tail (1 byte).
    expect(inspectPdf(buildPdf("zz!!!!!!!~>", { filters: ["ASCII85Decode"] })).decodedBytes).toBe(13);
    const a85zeros = "z".repeat(20 * MB);
    expect(() => inspectPdf(buildPdf(a85zeros, { filters: ["ASCII85Decode"] }))).toThrow(/decode to more than/);
  });
});

describe("pre-check bypasses (R4-14)", () => {
  it("refuses a dictionary padded past 64 KB, which used to hide its filters from the check", () => {
    // bomb.mts: the /Filter sat more than 64 KB before `stream`, so the check saw no filter and passed the bomb.
    const padded = buildPdf(doubleDeflate(100 * MB), { filters: ["FlateDecode", "FlateDecode"], extraDict: ` /Junk (${"a".repeat(70_000)})` });
    expect(padded.length).toBeLessThan(80_000);
    expect(() => inspectPdf(padded)).toThrow(PdfRejectedError);
    expect(() => inspectPdf(padded)).toThrow(/larger than 64 KB/);
  });

  it("finds the filters however the dictionary is dressed: a decoy 'obj', names, strings, comments", () => {
    const bomb = doubleDeflate(100 * MB);
    const filters = ["FlateDecode", "FlateDecode"];
    // The old check read from the last "obj" before `stream`, which a string or a name can supply.
    for (const extraDict of [" /Junk (1 0 obj)", " /Name /Xobj", " /T (a \\) obj << /Filter /Foo >> \\( b)"])
      expect(() => inspectPdf(buildPdf(bomb, { filters, extraDict })), extraDict).toThrow(PdfRejectedError);
    // A comment can hide a "<<" (and with it the real start) from a backward scan: refused rather than guessed.
    const commented = Buffer.concat([
      Buffer.from("%PDF-1.4\n4 0 obj\n<< /Filter [/FlateDecode /FlateDecode] % <<\n /Length 5 >>\nstream\n", "latin1"),
      bomb,
      Buffer.from("\nendstream\nendobj\n", "latin1"),
    ]);
    expect(() => inspectPdf(new Uint8Array(commented))).toThrow(/can't be read unambiguously/);
  });

  it("follows /Length past an 'endstream' planted in the data, so the bomb behind it is decoded and refused", async () => {
    // bomb2.mts: the first `endstream` sits 7 bytes into the data, so the old check decoded 7 bytes; pdf.js follows
    // /Length and decodes all of it, and so does the guard now (R4-14, R5-10).
    const data = await plantedEndstream(100 * MB);
    expect(data.indexOf("endstream")).toBeGreaterThan(0);
    expect(data.indexOf("endstream")).toBeLessThan(20);
    const direct = buildPdf(data, { filters: ["FlateDecode"] });
    expect(() => inspectPdf(direct)).toThrow(/decode to more than/);
    // The same through an indirect /Length (`6 0 R`), which pdf.js resolves.
    expect(() => inspectPdf(indirectLengthPdf(data))).toThrow(/decode to more than/);
    // And the child refuses it before pdf.js runs.
    await expect(runExtract({ kind: "pdf", bytes: direct }, 60_000)).rejects.toThrow(/decode to more than/);
  });

  it("reads a stream whose /Length is slightly wrong the way pdf.js does: up to the first endstream (R5-10)", () => {
    const text = "BT /F1 12 Tf 72 720 Td (Audit report with a wrong length) Tj ET";
    const zipped = deflateSync(text);
    const pdf = Buffer.from(buildPdf(zipped, { filters: ["FlateDecode"] }));
    // A common producer bug: every /Length a little short.
    const broken = Buffer.from(pdf.toString("latin1").replace(`/Length ${zipped.length}`, `/Length ${zipped.length - 2}`), "latin1");
    expect(inspectPdf(new Uint8Array(broken))).toMatchObject({ streams: 1, decodedBytes: text.length });
  });

  it("still reads honest streams: nested dictionaries, strings with brackets, hex strings, indirect lengths", () => {
    const text = "BT /F1 12 Tf 72 720 Td (Audit report) Tj ET";
    const zipped = deflateSync(text);
    const nested = buildPdf(zipped, {
      filters: ["FlateDecode"],
      extraDict: " /DecodeParms << /Predictor 1 >> /T (a (nested) string with >> and << and \\) inside) /H <48656C6C6F> /Note (100% sure)",
    });
    expect(inspectPdf(nested)).toMatchObject({ streams: 1, decodedBytes: text.length });
    expect(inspectPdf(indirectLengthPdf(zipped))).toMatchObject({ streams: 1, decodedBytes: text.length });
    // Without a /Length, the first `endstream` ends the data, as in pdf.js.
    const noLength = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Filter /ASCIIHexDecode >>\nstream\n48656C6C6F>\nendstream\nendobj\n`, "latin1");
    expect(inspectPdf(new Uint8Array(noLength)).decodedBytes).toBe(5);
    // "stream" as part of other words or outside a dictionary isn't a stream.
    const words = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Title (the upstream\nstream\n) >>\nendobj\n`, "latin1");
    expect(inspectPdf(new Uint8Array(words)).streams).toBe(0);
  });
});

describe("PDF child process", () => {
  it("extracts text, capped by pages and characters", async () => {
    const r = await extractPdfInChild(textPdf("Audit report by Zellic (v2) for Aztec"), 60_000);
    expect(r.text).toContain("Audit report by Zellic (v2) for Aztec");
    expect(r.pages).toBe(1);
    const capped = await extractPdfInChild(textPdf("Audit report by Zellic for Aztec"), 60_000, { maxChars: 5 });
    expect(capped.text).toBe("Audit");
    expect(capped.truncated).toBe(true);
  });

  it("refuses the bomb in the child, through the same runExtract the knowledge base uses", async () => {
    const bomb = buildPdf(doubleDeflate(100 * MB), { filters: ["FlateDecode", "FlateDecode"] });
    const before = process.memoryUsage().rss;
    await expect(runExtract({ kind: "pdf", bytes: bomb }, 60_000)).rejects.toThrow(/decode to more than/);
    // Nothing was decoded in this process.
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * MB);
  });

  it("kills a child whose memory passes the limit (the backstop for what the guard can't see)", async () => {
    // A legitimate but slow document (60,000 text operations), and a limit below what Node itself needs.
    const slow = buildPdf(deflateSync("BT /F1 12 Tf 72 720 Td (x) Tj ET\n".repeat(60_000)), { filters: ["FlateDecode"] });
    vi.stubEnv("KB_PDF_MAX_RSS_MB", "1");
    try {
      await expect(extractPdfInChild(slow, 60_000)).rejects.toThrow(ExtractMemoryError);
    } finally {
      vi.unstubAllEnvs();
    }
    // The next task gets a fresh process.
    expect((await extractPdfInChild(textPdf("after the kill"), 60_000)).text).toContain("after the kill");
  });

  it("passes the boot self-test from source, which /api/health reports (R3-SEC-11)", async () => {
    expect(extractionStatus().pdf).toBe("unchecked");
    expect(await checkExtraction()).toEqual({ html: "ok", pdf: "ok" });
    expect(extractionStatus()).toEqual({ html: "ok", pdf: "ok" });
  });

  it("forks the child from source on a Node that can't strip types, through tsx's loader (R4-32)", async () => {
    for (const [v, native] of [
      ["22.0.0", false],
      ["22.17.1", false],
      ["22.18.0", true],
      ["23.5.0", false],
      ["23.6.0", true],
      ["24.13.1", true],
    ] as const)
      expect(nodeStripsTypesByDefault(v), v).toBe(native);
    const loader = pdfChildExecArgv({ fromSource: true, nativeTypeScript: false });
    expect(loader).toEqual(expect.arrayContaining(["--import", expect.stringMatching(/^file:.*\/tsx\/dist\/loader\.mjs$/)]));
    expect(pdfChildExecArgv({ fromSource: true, nativeTypeScript: true })).not.toContain("--import");
    expect(pdfChildExecArgv({ fromSource: false, nativeTypeScript: false })).not.toContain("--import");
    expect(PDF_CHILD_PATH.endsWith("pdf-child.ts")).toBe(true);

    // This Node strips types by itself; with that turned off it behaves like Node 22.0 to 22.17.
    const run = (execArgv: string[]) =>
      new Promise<{ ok: boolean; result?: { text: string }; exit?: number | null }>((resolve) => {
        const child = fork(PDF_CHILD_PATH, [], {
          execArgv: [...execArgv, "--no-experimental-strip-types"],
          env: { PATH: process.env.PATH ?? "", PB_PDF_CHILD: "1" },
          serialization: "advanced",
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        child.once("message", (m) => resolve(m as { ok: boolean; result?: { text: string } }));
        child.once("exit", (code) => resolve({ ok: false, exit: code }));
        child.send({ bytes: textPdf("Loaded through the loader"), maxPages: 5, maxChars: 1000 }, () => {});
      });
    // Before R4-32: no loader, so the .ts child can't start.
    expect(await run(pdfChildExecArgv({ fromSource: false }))).toMatchObject({ ok: false, exit: 1 });
    const loaded = await run(loader);
    expect(loaded.ok).toBe(true);
    expect(loaded.result?.text).toContain("Loaded through the loader");
  });

  it("fails a garbage PDF cleanly", async () => {
    await expect(runExtract({ kind: "pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) }, 60_000)).rejects.toThrow();
  });
});
