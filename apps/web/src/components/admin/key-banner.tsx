import { useAdmin } from "./kit";

export type KeyStatus = { state: "missing" | "ok" | "rejected" | "unchecked"; message: string; checkedAt: string | null };

/** Shows why Claude calls can't run: missing key, or the exact error Anthropic returned. */
export function KeyBanner({ context }: { context: string }) {
  // The key status only changes when a call fails or the key is re-verified (which invalidates "settings"),
  // so no polling: refresh on mount when older than 30 s and on window focus.
  const s = useAdmin<{ anthropicStatus: KeyStatus }>(["settings"], "/api/admin/settings", { staleTime: 30_000, refetchOnWindowFocus: true });
  const k = s.data?.anthropicStatus;
  if (!k || k.state === "ok" || k.state === "unchecked") return null;
  return (
    <div className="mb-6 rounded-xl border border-poor-bd bg-poor-bg px-4 py-3 text-sm text-poor-fg">
      <span className="font-semibold">{k.state === "missing" ? "ANTHROPIC_API_KEY isn't set." : "Anthropic rejected the API key."}</span>{" "}
      {k.state === "rejected" ? k.message : `${context} are disabled until it's set.`}
    </div>
  );
}
