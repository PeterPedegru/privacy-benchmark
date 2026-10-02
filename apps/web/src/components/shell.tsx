import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Command, Menu, Moon, Sun } from "lucide-react";
import { m } from "motion/react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { spring } from "@/design/motion";
import { useMeta, useReleaseSync } from "@/lib/queries";
import { useTheme } from "@/lib/theme";
import { cn, fmtDate } from "@/lib/utils";
import { Kbd } from "./ui/misc";

// Both load on first use (cmdk, Radix Dialog and @pb/rubric for the palette; vaul for the menu) and are
// prefetched on hover or touch of their buttons, so they open without a visible delay.
const loadPalette = () => import("./command-palette");
const loadMobileNav = () => import("./mobile-nav");
const CommandPalette = lazy(() => loadPalette().then((x) => ({ default: x.CommandPalette })));
const MobileNav = lazy(() => loadMobileNav().then((x) => ({ default: x.MobileNav })));
// A failed prefetch is retried (and reported) by lazy() when the component is actually needed.
const prefetch = (load: () => Promise<unknown>) => () => void load().catch(() => {});

// The benchmark table is the landing page, so "Benchmarks" is home.
const NAV = [
  { to: "/", label: "Benchmarks" },
  { to: "/rankings", label: "Rankings" },
  { to: "/projects", label: "Projects" },
  { to: "/cards", label: "Cards" },
  { to: "/methodology", label: "Methodology" },
] as const;
const MOBILE_NAV = NAV;

export function Logo({ className }: { className?: string }) {
  return (
    <Link to="/" className={cn("group flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em] text-fg", className)}>
      <svg viewBox="0 0 32 32" className="size-[22px] transition-transform duration-300 group-hover:rotate-[-6deg]" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-accent" />
        <path
          d="M9 21.5V10.5h7.2c2.9 0 4.8 1.7 4.8 4.2s-1.9 4.2-4.8 4.2H12.6"
          fill="none"
          stroke="#fff"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="21.5" cy="21.5" r="2" fill="#fff" />
      </svg>
      Privacy Benchmark
    </Link>
  );
}

function ThemeToggle() {
  const { dark, toggle } = useTheme();
  return (
    <button type="button" onClick={toggle} aria-label="Toggle theme" className="rounded-lg p-2 text-muted transition-colors hover:bg-surface hover:text-fg">
      {dark ? <Sun className="size-4" strokeWidth={1.75} /> : <Moon className="size-4" strokeWidth={1.75} />}
    </button>
  );
}

function Header({ onCommand }: { onCommand: () => void }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  // Mounted on first open and kept, so the drawer can animate closed.
  const [menuMounted, setMenuMounted] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 4);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useEffect(() => setOpen(false), [path]);
  return (
    <header
      className={cn("sticky top-0 z-30 border-b bg-bg/95 backdrop-blur-sm transition-colors duration-300", scrolled ? "border-line" : "border-transparent")}
    >
      <div className="mx-auto flex h-16 max-w-[var(--container-wide)] items-center gap-6 px-4 sm:px-6">
        <Logo />
        <nav className="hidden items-center gap-0.5 md:flex">
          {NAV.map((n) => {
            const active = n.to === "/" ? path === "/" || path === "/benchmarks" : path.startsWith(n.to);
            return (
              <Link
                key={n.to}
                to={n.to}
                className={cn("relative rounded-lg px-3 py-1.5 text-sm transition-colors duration-200", active ? "text-fg" : "text-muted hover:text-fg")}
              >
                {active && <m.span layoutId="nav-active" transition={spring} className="absolute inset-0 -z-10 rounded-lg bg-surface" />}
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onCommand}
            onPointerEnter={prefetch(loadPalette)}
            onFocus={prefetch(loadPalette)}
            className="hidden h-8 items-center gap-2 rounded-lg border border-line bg-bg-2 pr-1.5 pl-2.5 text-[13px] text-muted transition-colors hover:border-line-strong hover:text-fg sm:flex"
          >
            <Command className="size-3.5" strokeWidth={1.75} />
            Search
            <Kbd>⌘K</Kbd>
          </button>
          <ThemeToggle />
          <button
            ref={menuButton}
            type="button"
            aria-label="Menu"
            aria-haspopup="dialog"
            aria-expanded={open}
            onPointerDown={prefetch(loadMobileNav)}
            onClick={() => {
              setMenuMounted(true);
              setOpen(true);
            }}
            className="rounded-lg p-2 text-fg md:hidden"
          >
            <Menu className="size-5" strokeWidth={1.75} />
          </button>
          {menuMounted && (
            <Suspense fallback={null}>
              <MobileNav open={open} onOpenChange={setOpen} links={MOBILE_NAV} onCommand={onCommand} returnFocus={menuButton} />
            </Suspense>
          )}
        </div>
      </div>
    </header>
  );
}

function DemoBanner() {
  const meta = useMeta();
  if (!meta.data?.isDemo) return null;
  return (
    <div className="border-b border-fair-bd bg-fair-bg text-fair-fg">
      <div className="mx-auto max-w-[var(--container-wide)] px-4 py-2 text-center text-[13px] sm:px-6">
        Demo data: hand-labelled from a sourced review dated Sep 30, 2026, not an official evaluation run.{" "}
        <Link to="/methodology" hash="evaluation" className="underline decoration-dotted underline-offset-4">
          How evaluations work
        </Link>
      </div>
    </div>
  );
}

function Footer() {
  const meta = useMeta();
  const rel = meta.data?.release;
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto grid max-w-[var(--container-wide)] grid-cols-2 gap-x-6 gap-y-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="col-span-2 md:col-span-1">
          <Logo />
          <p className="mt-3 max-w-sm text-sm text-muted">
            An independent, open-source benchmark of crypto privacy systems. Published rubric, cited evidence, human-reviewed releases. Not financial or legal
            advice.
          </p>
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <div className="eyebrow mb-1">Benchmark</div>
          <Link to="/" className="text-fg-3 hover:text-fg">
            Benchmark table
          </Link>
          <Link to="/rankings" className="text-fg-3 hover:text-fg">
            Rankings
          </Link>
          <Link to="/projects" className="text-fg-3 hover:text-fg">
            Projects
          </Link>
          <Link to="/cards" className="text-fg-3 hover:text-fg">
            Make a card
          </Link>
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <div className="eyebrow mb-1">Transparency</div>
          <Link to="/methodology" className="text-fg-3 hover:text-fg">
            Methodology
          </Link>
          <Link to="/methodology" hash="rubric" className="text-fg-3 hover:text-fg">
            Full rubric
          </Link>
          <Link to="/methodology" hash="prompts" className="text-fg-3 hover:text-fg">
            Evaluator prompts
          </Link>
          <Link to="/releases" className="text-fg-3 hover:text-fg">
            Releases & data
          </Link>
          <a href="https://github.com/rolldavid/privacy-benchmark" target="_blank" rel="noreferrer" className="text-fg-3 hover:text-fg">
            Source code (MIT)
          </a>
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <div className="eyebrow mb-1">Current release</div>
          <span className="text-fg-3">{rel ? rel.label : "—"}</span>
          <span className="text-muted">{rel ? `Published ${fmtDate(rel.publishedAt)}` : ""}</span>
          {meta.data?.rubricVersion && <span className="text-muted">Rubric v{meta.data.rubricVersion}</span>}
        </div>
      </div>
    </footer>
  );
}

/** Its own component so a meta refresh doesn't re-render the whole layout. */
function ReleaseSync() {
  useReleaseSync();
  return null;
}

export function PublicLayout() {
  const [cmd, setCmd] = useState(false);
  // The palette mounts on first open and stays mounted so its exit animation can play.
  const [cmdMounted, setCmdMounted] = useState(false);
  const openCmd = () => {
    setCmdMounted(true);
    setCmd(true);
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdMounted(true);
        setCmd((c) => !c);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  return (
    <div className="flex min-h-dvh flex-col">
      <ReleaseSync />
      <DemoBanner />
      <Header onCommand={openCmd} />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
      {cmdMounted && (
        <Suspense fallback={null}>
          <CommandPalette open={cmd} onOpenChange={setCmd} />
        </Suspense>
      )}
    </div>
  );
}
