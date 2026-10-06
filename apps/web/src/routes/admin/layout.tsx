import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  ArrowUpRight,
  Boxes,
  FileCheck2,
  GitBranch,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquareWarning,
  Play,
  Rocket,
  Scale,
  Settings,
} from "lucide-react";
import { m } from "motion/react";
import { useEffect, useState } from "react";
import { Drawer } from "vaul";
import { type OverviewData, useAdmin, useAdminAction, useOverview } from "@/components/admin/kit";
import { Logo } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { spring } from "@/design/motion";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
  { to: "/admin/projects", label: "Projects", icon: Boxes },
  { to: "/admin/updates", label: "Updates", icon: GitBranch, badge: "updates" },
  { to: "/admin/runs", label: "Runs", icon: Play, badge: "running" },
  { to: "/admin/review", label: "Review", icon: FileCheck2, badge: "awaitingReview" },
  { to: "/admin/releases", label: "Releases", icon: Rocket },
  { to: "/admin/weighting", label: "Weighting", icon: Scale },
  { to: "/admin/corrections", label: "Corrections", icon: MessageSquareWarning, badge: "corrections" },
  { to: "/admin/settings", label: "Settings", icon: Settings },
] as const;

export function AdminLayout() {
  const me = useAdmin<{ admin: boolean; configured: boolean }>(["me"], "/api/admin/me", { staleTime: 30_000 });
  if (me.isLoading) return <div className="min-h-dvh" />;
  if (!me.data?.admin) return <Login configured={me.data?.configured ?? true} />;
  return <Shell />;
}

function Sidebar({ counts, onNavigate }: { counts?: OverviewData; onNavigate?: () => void }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  // The page reloads after sign-out, so there is nothing to refetch.
  const logout = useAdminAction(() => api("/api/admin/logout", { method: "POST" }), { invalidate: false });
  return (
    <div className="flex h-full flex-col gap-1 p-3">
      <div className="px-2 pt-1 pb-4">
        <Logo />
        <div className="mt-1 pl-[30px] text-xs text-muted">Admin</div>
      </div>
      <div className="px-2 pb-1 text-[11px] font-medium text-faint">Workspace</div>
      {NAV.map((n) => {
        const active = "exact" in n && n.exact ? path === n.to || path === `${n.to}/` : path.startsWith(n.to);
        const count = "badge" in n && n.badge ? counts?.[n.badge as "updates" | "running" | "awaitingReview" | "corrections"] : 0;
        return (
          <Link
            key={n.to}
            to={n.to}
            onClick={onNavigate}
            className={cn(
              "relative flex h-8 items-center gap-2.5 rounded-lg px-2 text-sm transition-colors",
              active ? "text-fg" : "text-fg-3 hover:bg-surface hover:text-fg",
            )}
          >
            {active && <m.span layoutId="admin-nav" transition={spring} className="absolute inset-0 -z-10 rounded-lg bg-surface" />}
            <n.icon className="size-4 text-muted" strokeWidth={1.75} />
            <span className="flex-1">{n.label}</span>
            {!!count && <span className="rounded-md bg-accent-soft px-1.5 text-[11px] font-semibold text-accent-fg tabular">{count}</span>}
          </Link>
        );
      })}
      <div className="mt-auto flex flex-col gap-1 border-t border-line pt-3">
        <a href="/" className="flex h-8 items-center gap-2.5 rounded-lg px-2 text-sm text-fg-3 hover:bg-surface">
          <ArrowUpRight className="size-4 text-muted" strokeWidth={1.75} /> Public site
        </a>
        <button
          type="button"
          onClick={() => logout.mutate(undefined, { onSuccess: () => location.reload() })}
          className="flex h-8 items-center gap-2.5 rounded-lg px-2 text-left text-sm text-fg-3 hover:bg-surface"
        >
          <LogOut className="size-4 text-muted" strokeWidth={1.75} /> Sign out
        </button>
      </div>
    </div>
  );
}

function Shell() {
  const counts = useOverview({ poll: true });
  const [open, setOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => setOpen(false), [path]);
  return (
    <div className="flex min-h-dvh bg-bg">
      <aside className="sticky top-0 hidden h-dvh w-[240px] shrink-0 border-r border-line bg-bg-2 md:block">
        <Sidebar counts={counts.data} />
      </aside>
      <div className="min-w-0 flex-1">
        <div className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-bg/95 px-4 backdrop-blur-sm md:hidden">
          <Drawer.Root open={open} onOpenChange={setOpen} direction="left">
            <Drawer.Trigger className="rounded-lg p-1.5" aria-label="Menu">
              <Menu className="size-5" />
            </Drawer.Trigger>
            <Drawer.Portal>
              <Drawer.Overlay className="fixed inset-0 z-40 bg-black/30" />
              <Drawer.Content className="fixed top-0 bottom-0 left-0 z-50 w-[260px] border-r border-line bg-bg-2 outline-none">
                <Drawer.Title className="sr-only">Admin menu</Drawer.Title>
                <Sidebar counts={counts.data} onNavigate={() => setOpen(false)} />
              </Drawer.Content>
            </Drawer.Portal>
          </Drawer.Root>
          <Logo />
        </div>
        <main className="mx-auto max-w-[1180px] px-4 py-8 sm:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Login({ configured }: { configured: boolean }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api("/api/admin/login", { json: { password: pw } });
      location.reload();
    } catch (x) {
      setErr((x as Error).message === "invalid_password" ? "That password isn't right." : (x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative flex min-h-dvh items-center justify-center px-4">
      <div className="pointer-events-none absolute inset-0 dot-grid opacity-50 [mask-image:radial-gradient(50%_50%_at_50%_50%,#000,transparent)]" />
      <m.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 8, filter: "blur(3px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        className="relative w-full max-w-sm rounded-2xl border border-line bg-bg p-6 shadow-5"
      >
        <Logo />
        <h1 className="mt-6 text-xl font-semibold tracking-[-0.01em]">Admin sign in</h1>
        {!configured ? (
          <p className="mt-2 text-sm text-muted">
            Set <code className="font-mono text-fg">ADMIN_PASSWORD</code> in <code className="font-mono text-fg">apps/server/.env</code> and restart the server.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-muted">Use the password from apps/server/.env.</p>
            <input
              type="password"
              ref={(el) => el?.focus()}
              autoComplete="current-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="Password"
              className="mt-5 h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm outline-none focus:border-accent focus:ring-4 focus:ring-[var(--ring)]"
            />
            {err && <div className="mt-2 text-sm text-poor-fg">{err}</div>}
            <Button type="submit" variant="primary" className="mt-4 w-full" disabled={busy || !pw}>
              Sign in
            </Button>
          </>
        )}
        <Inbox className="hidden" />
      </m.form>
    </div>
  );
}
