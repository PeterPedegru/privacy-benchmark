/** Every failed request: `status` is the HTTP status, or 0 when the server couldn't be reached at all. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Worth trying again: the network failed or the server had a problem (5xx, including a deploy in progress). */
export function isRetryable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}

export const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

/**
 * Query retries (R3-REL-14): network errors and 5xx up to 3 times with backoff (0.5 s, 1 s, 2 s); never 4xx, so a
 * missing project says so at once. Mutations aren't retried: they aren't idempotent.
 */
export const retryQuery = (failureCount: number, error: unknown) => failureCount < 3 && isRetryable(error);
export const retryDelay = (attempt: number) => Math.min(500 * 2 ** attempt, 4000);

function csrf(): string {
  const m = document.cookie.match(/(?:^|; )pb_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : "";
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  let body = init.body;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const method = (init.method ?? (init.json !== undefined ? "POST" : "GET")).toUpperCase();
  if (method !== "GET" && path.startsWith("/api/admin")) headers["x-csrf-token"] = csrf();
  let res: Response;
  try {
    res = await fetch(path, { ...init, method, headers, body, credentials: "same-origin" });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError(0, "network", "Couldn't reach the server. Check your connection and try again.");
  }
  if (!res.ok) {
    let j: { error?: string; message?: string } | null = null;
    try {
      j = await res.json();
    } catch {
      // not json: a proxy's error page, or an empty body
    }
    // Our API explains its own 503s (e.g. "set ANTHROPIC_API_KEY"); a gateway error without one is a deploy or restart.
    if (!j?.error && (res.status === 502 || res.status === 503 || res.status === 504)) {
      throw new ApiError(res.status, "unavailable", "The server is restarting (usually a deploy in progress). Try again in a minute.");
    }
    throw new ApiError(res.status, j?.error ?? "error", j?.message ?? j?.error ?? res.statusText);
  }
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("json") ? res.json() : res.text()) as Promise<T>;
}
