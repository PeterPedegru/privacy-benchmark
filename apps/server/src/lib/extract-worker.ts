/**
 * Extraction worker (EFF-13, SEC-3): HTML parsing, Readability and turndown run here, off the main thread, so a slow
 * or hostile page can't freeze the API. The pool in extract-pool.ts kills a worker that exceeds its per-task timeout
 * or heap limit. PDFs run in a child process instead (pdf-child.ts). Only erasable TypeScript and package/relative
 * `.ts` imports, so plain Node can run it.
 */
import { parentPort } from "node:worker_threads";
import { extractHtml, fragmentToMarkdown } from "./extract-core.ts";

/** `pdf` tasks never reach this worker: extract-pool.ts runs them in a child process (R3-SEC-1, see pdf-child.ts). */
export type ExtractTask =
  | { kind: "html"; html: string; url: string; readability?: boolean }
  | { kind: "fragment"; html: string }
  | { kind: "pdf"; bytes: Uint8Array };

export async function runTask(task: ExtractTask): Promise<unknown> {
  if (task.kind === "html") return extractHtml(task.html, task.url, { readability: task.readability });
  if (task.kind === "fragment") return fragmentToMarkdown(task.html);
  throw new Error("PDFs are extracted in a child process, not in the HTML worker");
}

parentPort?.on("message", async (m: { id: number; task: ExtractTask }) => {
  try {
    const result = await runTask(m.task);
    parentPort?.postMessage({ id: m.id, ok: true, result });
  } catch (e) {
    parentPort?.postMessage({ id: m.id, ok: false, error: (e as Error)?.message ?? String(e) });
  }
});
