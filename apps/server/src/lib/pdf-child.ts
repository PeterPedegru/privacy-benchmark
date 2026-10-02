/**
 * PDF text extraction in its own process (R3-SEC-1). pdf.js decodes streams into buffers outside the V8 heap, so a
 * worker thread's `resourceLimits` can't contain a decompression bomb, and running out of memory would take the
 * whole server with it. Here a bomb ends this process: the parent (extract-pool.ts) kills it above a resident-memory
 * limit or a deadline, and the task fails.
 *
 * One task per process: the parent sends `{ bytes, maxPages, maxChars }` over IPC and gets `{ ok, result }` or
 * `{ ok: false, error }` back. Before pdf.js sees the file, every stream is decoded against a 64 MB budget
 * (pdf-guard.ts). At most `maxPages` pages are read, and reading stops once `maxChars` characters are collected.
 *
 * Erasable TypeScript only, so plain Node runs it from source; scripts/bundle.mjs ships it as dist/pdf-child.js.
 */
import { inspectPdf } from "./pdf-guard.ts";

export interface PdfTask {
  bytes: Uint8Array;
  maxPages: number;
  maxChars: number;
}

export interface PdfText {
  text: string;
  /** Pages in the document (only the first `maxPages` are read). */
  pages: number;
  pagesRead: number;
  truncated: boolean;
}

/** unpdf's merge: collapse whitespace, keep line breaks, at most one blank line. */
function merge(texts: string[]): string {
  return texts
    .join("\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

export async function extractPdfText(task: PdfTask): Promise<PdfText> {
  inspectPdf(task.bytes);
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(task.bytes, { disableFontFace: true, stopAtErrors: false });
  try {
    const pagesToRead = Math.min(doc.numPages, task.maxPages);
    const texts: string[] = [];
    let chars = 0;
    let read = 0;
    for (let i = 1; i <= pagesToRead && chars < task.maxChars; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let t = "";
      for (const item of content.items) if ("str" in item && item.str != null) t += item.str + (item.hasEOL ? "\n" : "");
      texts.push(t);
      chars += t.length;
      read = i;
      page.cleanup();
    }
    const text = merge(texts);
    const truncated = read < doc.numPages || text.length > task.maxChars;
    return { text: text.slice(0, task.maxChars), pages: doc.numPages, pagesRead: read, truncated };
  } finally {
    await doc.loadingTask.destroy();
  }
}

// Only when started by the pool (which sets PB_PDF_CHILD): importing this module elsewhere must not take over IPC.
if (process.send && process.env.PB_PDF_CHILD === "1") {
  process.once("message", (task: PdfTask) => {
    if (!(task?.bytes instanceof Uint8Array)) {
      process.send!({ ok: false, error: "bad task" }, () => process.exit(0));
      return;
    }
    extractPdfText(task).then(
      (result) => process.send!({ ok: true, result }, () => process.exit(0)),
      (e: unknown) => process.send!({ ok: false, error: (e as Error)?.message ?? String(e) }, () => process.exit(0)),
    );
  });
}
