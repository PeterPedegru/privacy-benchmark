/**
 * Recovery from a deploy that replaced the code a tab expects (R3-REL-14). A tab left open across a deploy asks for
 * route chunks that no longer exist; the server answers 404. Vite reports that as `vite:preloadError`: the page
 * reloads to pick up the new build. The time of that reload is kept in session storage, so if it happens again
 * within ten minutes the route's error component offers a Reload button instead of looping; after that, it's another
 * deploy, and the tab reloads again (R4-35).
 */

/** A route's code couldn't be loaded (usually because a deploy replaced the chunk this tab expected). */
export class ChunkLoadError extends Error {
  constructor(cause?: unknown) {
    // Deliberately not one of the messages TanStack Router reloads on by itself: recovery reloads once, here.
    super("This page's code couldn't be loaded.", { cause });
    this.name = "ChunkLoadError";
  }
}

const RELOAD_KEY = "pb:chunk-reload";
/** A missing chunk this long after the last reload is another deploy, and earns another reload (R4-35). */
export const RELOAD_AGAIN_AFTER_MS = 10 * 60_000;
let reloading = false;

/**
 * Reloads the page unless this tab already did for the same reason in the last ten minutes (a reload that didn't
 * help). Storage that can't be used means no reload. A stored time in the future (the clock moved) doesn't block one.
 */
export function reloadForNewBuild(now = Date.now()): boolean {
  try {
    const last = Date.parse(sessionStorage.getItem(RELOAD_KEY) ?? "");
    if (Number.isFinite(last) && now >= last && now - last < RELOAD_AGAIN_AFTER_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, new Date(now).toISOString());
  } catch {
    return false;
  }
  reloading = true;
  location.reload();
  return true;
}

export function installChunkRecovery() {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForNewBuild()) event.preventDefault();
  });
}

/**
 * Wraps a route's dynamic import: a failure becomes a ChunkLoadError for the error component, and while the page is
 * reloading the import just waits, so the error screen doesn't flash first.
 */
export function chunk<T>(load: () => Promise<T>): () => Promise<T> {
  const wait = () => new Promise<T>(() => {});
  return () =>
    load().then(
      (m) => {
        // Vite resolves to undefined when a preload error was handled (prevented) by the listener above.
        if (m !== undefined) return m;
        if (reloading) return wait();
        throw new ChunkLoadError();
      },
      (e: unknown) => {
        if (reloading) return wait();
        throw new ChunkLoadError(e);
      },
    );
}

export function isChunkError(error: unknown): boolean {
  return (
    error instanceof ChunkLoadError ||
    /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(String((error as Error | undefined)?.message ?? ""))
  );
}
