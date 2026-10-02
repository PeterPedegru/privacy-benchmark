import { type UseQueryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export function useAdmin<T>(key: unknown[], path: string, opts: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({ queryKey: ["admin", ...key], queryFn: () => api<T>(path), ...opts });
}

/**
 * Mutation that toasts errors and refreshes admin data on success.
 *
 * `invalidate` lists the keys this action changes, written as for useAdmin (without "admin") and matched as
 * prefixes: `[["project", id], ["overview"]]`. Matching queries on screen refetch; the rest are only marked stale.
 * Omit it to invalidate every admin query except the session; pass `false` to invalidate nothing.
 */
export function useAdminAction<V = void, R = unknown>(
  fn: (v: V) => Promise<R>,
  opts: { success?: string | ((r: R) => string); invalidate?: boolean | string[][] } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      if (opts.success) toast.success(typeof opts.success === "function" ? opts.success(r) : opts.success);
      if (opts.invalidate === false) return;
      if (Array.isArray(opts.invalidate)) for (const key of opts.invalidate) void qc.invalidateQueries({ queryKey: ["admin", ...key] });
      else void qc.invalidateQueries({ queryKey: ["admin"], predicate: (q) => q.queryKey[1] !== "me" });
    },
    onError: (e) => toast.error((e as Error).message),
  });
}

export type OverviewData = {
  projects: number;
  releases: number;
  spendThisMonth: number;
  awaitingReview: number;
  running: number;
  updates: number;
  corrections: number;
  lastRelease: { id: string; label: string; publishedAt: string; isDemo: boolean } | null;
  recentRuns: { id: string; label: string; mode: string; status: string; costUsd: number; createdAt: string }[];
};

/**
 * The counts behind the sidebar badges and the overview page: one ["overview"] query for both. Only the layout
 * polls (`poll`), every 10 s while evaluations are running; otherwise it refreshes on window focus, on mount
 * when older than 5 s, and after admin actions that invalidate it.
 */
export function useOverview({ poll = false }: { poll?: boolean } = {}) {
  return useAdmin<OverviewData>(["overview"], "/api/admin/overview", {
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    refetchInterval: poll ? (q) => (q.state.data?.running ? 10_000 : false) : false,
  });
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.015em]">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const STATUS: Record<string, string> = {
  queued: "bg-surface text-fg-3 border-line",
  running: "bg-accent-soft text-accent-fg border-accent-line",
  review: "bg-fair-bg text-fair-fg border-fair-bd",
  reviewed: "bg-strong-bg text-strong-fg border-strong-bd",
  published: "bg-strong-bg text-strong-fg border-strong-bd",
  failed: "bg-poor-bg text-poor-fg border-poor-bd",
  cancelled: "bg-surface text-muted border-line",
  detected: "bg-fair-bg text-fair-fg border-fair-bd",
  tracked: "bg-strong-bg text-strong-fg border-strong-bd",
  ignored: "bg-surface text-muted border-line",
  open: "bg-fair-bg text-fair-fg border-fair-bd",
  accepted: "bg-strong-bg text-strong-fg border-strong-bd",
  rejected: "bg-surface text-muted border-line",
  done: "bg-strong-bg text-strong-fg border-strong-bd",
  active: "bg-strong-bg text-strong-fg border-strong-bd",
  archived: "bg-surface text-muted border-line",
  empty: "bg-surface text-muted border-line",
  refreshing: "bg-accent-soft text-accent-fg border-accent-line",
  ready: "bg-strong-bg text-strong-fg border-strong-bd",
  error: "bg-poor-bg text-poor-fg border-poor-bd",
};

export function Status({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex h-[22px] items-center gap-1.5 rounded-md border px-1.5 text-xs font-medium capitalize", STATUS[status] ?? STATUS.queued)}>
      {(status === "running" || status === "refreshing") && <span className="pulse-dot size-1.5 rounded-full bg-accent" />}
      {status}
    </span>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-fg-3">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

const inputCls =
  "h-9 w-full rounded-lg border border-line bg-bg px-3 text-sm text-fg outline-none transition-shadow placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-[var(--ring)]";
export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cn(inputCls, p.className)} />;
}
const parseList = (text: string) =>
  text
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Comma-separated list input that keeps what you type (trailing commas included) and reports the parsed list. */
export function ListInput({
  value,
  onChange,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => {
    // Only adopt outside changes (e.g. a refetch), never re-format while typing.
    setText((t) => (parseList(t).join("\u0000") === value.join("\u0000") ? t : value.join(", ")));
  }, [value]);
  return (
    <Input
      {...rest}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseList(e.target.value));
      }}
    />
  );
}

export function Textarea(p: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cn(inputCls, "h-auto min-h-24 py-2", p.className)} />;
}
export function Select(p: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cn(inputCls, "pr-8", p.className)} />;
}

export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-2xl border border-line bg-bg", className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="text-sm font-semibold">{title}</div>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-bg p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-[-0.02em] tabular">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cn("border-b border-line bg-bg-2 px-3 py-2 text-left text-xs font-medium text-muted", className)}>{children}</th>;
}
export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn("border-b border-line-weak px-3 py-2.5 align-middle text-sm", className)}>{children}</td>;
}
