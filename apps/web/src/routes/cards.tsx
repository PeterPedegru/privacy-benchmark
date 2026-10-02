import type { CardConfig } from "@pb/core";
import { benchmarks, suites } from "@pb/rubric";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Check, Copy, Download, Link2, Loader2 } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ProjectPicker } from "@/components/bench/project-picker";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { focusIn } from "@/design/motion";
import { api } from "@/lib/api";
import { useLeaderboard } from "@/lib/queries";
import { cn } from "@/lib/utils";

const KEY = [
  "coverage.confidentiality",
  "coverage.unlinkability",
  "coverage.execution",
  "coverage.callstack",
  "trust.decryption",
  "custody.self-custody",
  "custody.pause",
  "custody.freeze",
  "custody.exit",
  "programmability.composability",
  "governance.upgrades",
  "decentralization.censorship",
  "security.soundness",
];

type Template = CardConfig["template"];
type RowSet = CardConfig["rowSet"];
type Size = CardConfig["size"];

function b64url(s: string) {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

const MAX: Record<Template, number> = { table: 5, headtohead: 2, spotlight: 1 };

export function CardsPage() {
  const search = useSearch({ from: "/public/cards" });
  const navigate = useNavigate({ from: "/cards" });
  const lb = useLeaderboard();
  const set = (patch: Partial<typeof search>) => navigate({ search: (s) => ({ ...s, ...patch, id: undefined }), replace: true, resetScroll: false });

  // A saved card id hydrates the builder once.
  useEffect(() => {
    if (!search.id) return;
    api<CardConfig>(`/api/public/cards/${search.id}`)
      .then((c) =>
        navigate({
          search: {
            p: c.projects.join(","),
            focus: c.focus ?? undefined,
            t: c.template,
            rows: c.rowSet === "custom" ? (c.rows ?? []).join(",") : c.rowSet,
            size: c.size,
            theme: c.theme,
            accent: c.accent,
          },
          replace: true,
        }),
      )
      .catch(() => toast.error("That card link has expired or is invalid."));
  }, [search.id, navigate]);

  const template = (search.t as Template) ?? "table";
  const defaultRefs = (lb.data?.rows ?? []).slice(0, MAX[template] === 5 ? 4 : MAX[template]).map((r) => r.slug);
  const refs = (search.p ? search.p.split(",").filter(Boolean) : defaultRefs).slice(0, MAX[template]);
  const rowsParam = search.rows ?? "suites";
  const rowSet: RowSet = ["suites", "key", "all"].includes(rowsParam) ? (rowsParam as RowSet) : "custom";
  const customRows = rowSet === "custom" ? rowsParam.split(",").filter((id) => benchmarks.some((b) => b.id === id)) : [];
  const config: CardConfig = {
    template,
    projects: refs,
    focus: search.focus ?? refs[0] ?? null,
    rowSet,
    rows: rowSet === "custom" ? customRows : undefined,
    size: (search.size as Size) ?? (template === "table" ? "auto" : "landscape"),
    theme: search.theme === "dark" ? "dark" : "light",
    accent: search.accent === "iris" ? "iris" : "classic",
  };
  const json = JSON.stringify(config);
  // Debounce the URL itself: checking the live refs against a 250 ms-old config requested a card with no
  // projects (a 400) right after the leaderboard loaded.
  const src = useDebounced(refs.length ? `/og/card.png?c=${b64url(json)}` : null, 250);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const saveLink = async () => {
    const { id } = await api<{ id: string }>("/api/public/cards", { json: config });
    return `${location.origin}/c/${id}`;
  };
  const withBusy = async (k: string, fn: () => Promise<void>) => {
    setBusy(k);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message || "Something went wrong");
    } finally {
      setBusy(null);
    }
  };
  const download = () =>
    withBusy("dl", async () => {
      const res = await fetch(`/og/card.png?c=${b64url(json)}`);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `privacy-benchmark-${refs.map((r) => r.split("@")[0]).join("-vs-")}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  const copyImage = () =>
    withBusy("img", async () => {
      const res = await fetch(`/og/card.png?c=${b64url(json)}`);
      const blob = await res.blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast.success("Image copied");
    });
  const copyLink = () =>
    withBusy("link", async () => {
      const url = await saveLink();
      await navigator.clipboard.writeText(url);
      toast.success("Share link copied", { description: url });
    });

  const rows = lb.data?.rows ?? [];
  const label = "mb-2 text-xs font-medium text-muted";
  return (
    <div className="mx-auto max-w-[var(--container-wide)] px-4 pt-10 sm:px-6 md:pt-14">
      <m.div variants={focusIn} initial="hidden" animate="show" className="max-w-3xl">
        <div className="eyebrow mb-3">Cards</div>
        <h1 className="text-[34px] leading-[1.12] font-semibold tracking-[-0.02em] text-balance md:text-5xl md:leading-[1.06]">
          Make a comparison card. <span className="text-muted">Every number on it sourced, dated and linked to the method.</span>
        </h1>
      </m.div>

      <div className="mt-10 grid gap-8 lg:grid-cols-[340px_1fr]">
        <div className="flex flex-col gap-6 lg:sticky lg:top-24 lg:self-start">
          <div>
            <div className={label}>Template</div>
            <Segmented
              value={template}
              onChange={(t) => set({ t, p: refs.slice(0, MAX[t]).join(",") || undefined })}
              options={[
                { value: "table", label: "Table" },
                { value: "headtohead", label: "Head to head" },
                { value: "spotlight", label: "Spotlight" },
              ]}
            />
          </div>
          <div>
            <div className={label}>
              Projects <span className="text-faint">· up to {MAX[template]}</span>
            </div>
            <ProjectPicker rows={rows} selected={refs} onChange={(next) => set({ p: next.join(",") || undefined })} max={MAX[template]} />
          </div>
          {template === "table" && (
            <>
              <div>
                <div className={label}>Focus column</div>
                <div className="flex flex-wrap gap-1.5">
                  {refs.map((r) => {
                    const row = rows.find((x) => x.slug === r.split("@")[0]);
                    const on = (config.focus ?? "") === r;
                    return (
                      <button
                        type="button"
                        key={r}
                        onClick={() => set({ focus: r })}
                        className={cn(
                          "h-7 rounded-lg border px-2.5 text-xs font-medium",
                          on ? "border-accent bg-accent-soft text-accent-fg" : "border-line text-fg-3",
                        )}
                      >
                        {row?.name ?? r}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className={label}>Rows</div>
                <Segmented
                  size="sm"
                  value={rowSet}
                  onChange={(v) => set({ rows: v === "custom" ? KEY.slice(0, 6).join(",") : v, size: v === "all" ? "auto" : search.size })}
                  options={[
                    { value: "suites", label: "Suites" },
                    { value: "key", label: "Key 13" },
                    { value: "all", label: "All 31" },
                    { value: "custom", label: "Custom" },
                  ]}
                />
                <AnimatePresence initial={false}>
                  {rowSet === "custom" && (
                    <m.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-line p-1.5">
                        {suites.map((su) => (
                          <div key={su.id} className="mb-1">
                            <div className="px-2 pt-1.5 pb-1 text-[11px] font-semibold text-muted">{su.name}</div>
                            {su.benchmarks.map((b) => {
                              const on = customRows.includes(b.id);
                              return (
                                <button
                                  type="button"
                                  key={b.id}
                                  onClick={() => set({ rows: (on ? customRows.filter((x) => x !== b.id) : [...customRows, b.id]).join(",") || "suites" })}
                                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-surface"
                                >
                                  <span
                                    className={cn(
                                      "flex size-3.5 items-center justify-center rounded-[4px] border",
                                      on ? "border-accent bg-accent text-white" : "border-line-strong",
                                    )}
                                  >
                                    {on && <Check className="size-2.5" strokeWidth={3} />}
                                  </span>
                                  {b.name}
                                </button>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </m.div>
                  )}
                </AnimatePresence>
              </div>
            </>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className={label}>Theme</div>
              <Segmented
                size="sm"
                value={config.theme}
                onChange={(v) => set({ theme: v === "light" ? undefined : v })}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
              />
            </div>
            <div>
              <div className={label}>Highlight</div>
              <Segmented
                size="sm"
                value={config.accent}
                onChange={(v) => set({ accent: v === "classic" ? undefined : v })}
                options={[
                  { value: "classic", label: "Blue" },
                  { value: "iris", label: "Iris" },
                ]}
              />
            </div>
          </div>
          <div>
            <div className={label}>Size</div>
            <Segmented
              size="sm"
              value={config.size}
              onChange={(v) => set({ size: v })}
              options={[
                ...(template === "table" ? [{ value: "auto" as Size, label: "Auto" }] : []),
                { value: "landscape" as Size, label: "1200×630" },
                { value: "square" as Size, label: "Square" },
                { value: "portrait" as Size, label: "Portrait" },
              ]}
            />
          </div>
          <div className="flex flex-wrap gap-2 border-t border-line pt-5">
            <Button
              variant="primary"
              onClick={download}
              disabled={!refs.length || !!busy}
              icon={busy === "dl" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            >
              Download PNG
            </Button>
            <Button
              onClick={copyImage}
              disabled={!refs.length || !!busy}
              icon={busy === "img" ? <Loader2 className="size-4 animate-spin" /> : <Copy className="size-4" />}
            >
              Copy image
            </Button>
            <Button
              onClick={copyLink}
              disabled={!refs.length || !!busy}
              icon={busy === "link" ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
            >
              Copy link
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted">
            Share links unfurl with this card on X, Telegram and Slack. Every card carries the release, rubric version and a methodology link.
          </p>
        </div>

        {/* Phones show the preview above the controls, so each change is visible where it's made. */}
        <div className="relative order-first min-h-[200px] rounded-3xl border border-line bg-bg-2 p-3 sm:p-6 lg:order-none lg:min-h-[320px]">
          <div className="pointer-events-none absolute inset-0 rounded-3xl dot-grid opacity-50" />
          <div className="relative flex min-h-[180px] items-start justify-center lg:min-h-[300px]">
            {src ? (
              <AnimatePresence mode="popLayout" initial={false}>
                <m.img
                  key={src}
                  src={src}
                  alt="Card preview"
                  onLoad={() => setLoaded(src)}
                  initial={{ opacity: 0, filter: "blur(4px)" }}
                  animate={{ opacity: loaded === src ? 1 : 0.5, filter: loaded === src ? "blur(0px)" : "blur(2px)" }}
                  transition={{ duration: 0.35 }}
                  className="w-full max-w-[900px] rounded-xl border border-line shadow-5"
                />
              </AnimatePresence>
            ) : (
              <div className="py-24 text-sm text-muted">Pick at least one project.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
