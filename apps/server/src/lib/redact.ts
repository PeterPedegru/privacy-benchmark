import { env } from "../env.ts";

/** Every configured secret long enough to be distinctive (RPC URLs often carry an API key in the path). */
function secrets(): string[] {
  const rpc = Object.entries(process.env)
    .filter(([k]) => k.startsWith("RPC_URL_"))
    .flatMap(([, v]) => {
      if (!v) return [];
      try {
        const u = new URL(v);
        // The path and query usually hold the key; redact them as well as the whole URL.
        return [v, u.pathname.length > 8 ? u.pathname : "", u.search.length > 8 ? u.search.slice(1) : ""];
      } catch {
        return [v];
      }
    });
  return [
    env.anthropicKey,
    env.githubToken,
    env.exaKey,
    env.newsApiKey,
    env.xBearer,
    env.etherscanKey,
    process.env.SESSION_SECRET,
    process.env.ADMIN_PASSWORD,
    process.env.GITHUB_AGENT_TOKEN,
    // Database URLs and the passwords inside them.
    ...["DATABASE_URL", "DATABASE_PUBLIC_URL", "KB_DATABASE_URL", "BENCH_DB_PASSWORD"].flatMap((k) => {
      const v = process.env[k];
      if (!v) return [];
      try {
        const u = new URL(v);
        return [v, u.password ? decodeURIComponent(u.password) : ""];
      } catch {
        return [v];
      }
    }),
    ...rpc,
  ]
    .filter((s): s is string => !!s && s.length >= 8)
    .sort((a, b) => b.length - a.length);
}

/** Replaces any configured secret in text bound for logs, run events, the model, or the database. */
export function redact(text: string): string {
  let out = text;
  for (const s of secrets()) if (out.includes(s)) out = out.split(s).join("[redacted]");
  return out;
}

/**
 * A short, secret-free message for a failed onchain read. viem's error messages embed the RPC URL (providers often
 * put the API key in the path) and the request body; only the one-line reason survives, with any URL removed.
 */
export function rpcErrorMessage(chainId: number, e: unknown): string {
  const short = (e as { shortMessage?: unknown } | null)?.shortMessage;
  const reason = typeof short === "string" && short ? short : e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e);
  return redact(`RPC call failed on chain ${chainId}: ${reason.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")}`).slice(0, 300);
}

/** Error for a failed upstream API call: host and status only. Response bodies can echo keys or queries back. */
export function upstreamError(url: string, status: number): Error {
  return new Error(`${new URL(url).host} returned HTTP ${status}`);
}
