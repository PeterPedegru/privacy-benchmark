import { benchmarks, suites } from "@pb/rubric";
import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { BarChart3, BookOpen, FileText, Image, LayoutGrid, Search, Trophy } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useLeaderboard } from "@/lib/queries";
import { fmtPct } from "@/lib/utils";
import { ProjectMark } from "./ui/project-mark";

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const nav = useNavigate();
  // Mounted lazily on first open; once closed it stays mounted (for the exit animation) without observing the query.
  const lb = useLeaderboard({ enabled: open });
  const go = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };
  const item = "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-fg-2 data-[selected=true]:bg-surface data-[selected=true]:text-fg";
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <m.div className="fixed inset-0 z-50 bg-black/20 dark:bg-black/50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined}>
              <m.div
                className="fixed top-[12vh] left-1/2 z-50 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-bg shadow-5"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.18 }}
              >
                <Dialog.Title className="sr-only">Search</Dialog.Title>
                <Command loop>
                  <div className="flex items-center gap-2 border-b border-line px-4">
                    <Search className="size-4 text-muted" strokeWidth={1.75} />
                    <Command.Input
                      autoFocus
                      placeholder="Search projects, benchmarks, pages…"
                      className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
                    />
                  </div>
                  <Command.List className="max-h-[60vh] overflow-y-auto p-2">
                    <Command.Empty className="px-3 py-8 text-center text-sm text-muted">No results.</Command.Empty>
                    <Command.Group
                      heading="Projects"
                      className="[&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-2"
                    >
                      {(lb.data?.rows ?? []).map((r) => (
                        <Command.Item
                          key={r.slug}
                          value={`${r.name} ${r.slug}`}
                          className={item}
                          onSelect={() => go(() => nav({ to: "/projects/$slug", params: { slug: r.slug } }))}
                        >
                          <ProjectMark name={r.name} logoUrl={r.logoUrl} size={18} />
                          <span className="flex-1">{r.name}</span>
                          <span className="text-xs text-muted tabular">{fmtPct(r.overall)}</span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                    <Command.Group heading="Pages" className="[&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-2">
                      {[
                        { label: "Benchmark table", icon: LayoutGrid, to: "/" },
                        { label: "Rankings", icon: Trophy, to: "/rankings" },
                        { label: "Projects", icon: BarChart3, to: "/projects" },
                        { label: "Make a comparison card", icon: Image, to: "/cards" },
                        { label: "Methodology", icon: BookOpen, to: "/methodology" },
                        { label: "Releases & data", icon: FileText, to: "/releases" },
                      ].map((p) => (
                        <Command.Item key={p.to} value={p.label} className={item} onSelect={() => go(() => nav({ to: p.to }))}>
                          <p.icon className="size-4 text-muted" strokeWidth={1.75} />
                          {p.label}
                        </Command.Item>
                      ))}
                    </Command.Group>
                    <Command.Group
                      heading="Benchmarks"
                      className="[&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-2"
                    >
                      {benchmarks.map((b) => (
                        <Command.Item
                          key={b.id}
                          value={`${b.name} ${b.question}`}
                          className={item}
                          onSelect={() => go(() => nav({ to: "/rankings", search: { tab: b.id } }))}
                        >
                          <span className="flex-1">{b.name}</span>
                          <span className="text-xs text-muted">{suites.find((s) => s.id === b.suite)?.shortName}</span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  </Command.List>
                </Command>
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
