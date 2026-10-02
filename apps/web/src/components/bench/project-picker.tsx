import type { LeaderboardRow } from "@pb/core";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, Plus, X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useState } from "react";
import { spring } from "@/design/motion";
import { cn, fmtPct } from "@/lib/utils";
import { ProjectMark } from "../ui/project-mark";

export function ProjectPicker({
  rows,
  selected,
  onChange,
  max = 8,
}: {
  rows: LeaderboardRow[];
  selected: string[];
  onChange: (refs: string[]) => void;
  max?: number;
}) {
  const [open, setOpen] = useState(false);
  const slugOf = (ref: string) => ref.split("@")[0]!;
  const selectedSlugs = selected.map(slugOf);
  const toggle = (slug: string) => {
    if (selectedSlugs.includes(slug)) onChange(selected.filter((r) => slugOf(r) !== slug));
    else if (selected.length < max) onChange([...selected, slug]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <AnimatePresence initial={false}>
        {selected.map((ref) => {
          const row = rows.find((r) => r.slug === slugOf(ref));
          if (!row) return null;
          return (
            <m.span
              key={ref}
              layout
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={spring}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-bg pr-1 pl-1.5 text-[13px] font-medium shadow-1"
            >
              <ProjectMark name={row.name} logoUrl={row.logoUrl} size={16} />
              {row.name}
              <button
                type="button"
                onClick={() => onChange(selected.filter((r) => r !== ref))}
                className="rounded p-0.5 text-faint hover:bg-surface hover:text-fg"
                aria-label={`Remove ${row.name}`}
              >
                <X className="size-3" />
              </button>
            </m.span>
          );
        })}
      </AnimatePresence>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <m.button
            type="button"
            layout
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-dashed border-line-strong px-2.5 text-[13px] text-muted transition-colors hover:border-accent hover:text-fg"
          >
            <Plus className="size-3.5" /> Add project
          </m.button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={6} className="z-50 w-72 overflow-hidden rounded-xl border border-line bg-bg shadow-5">
            <Command>
              <Command.Input
                autoFocus
                placeholder="Find a project…"
                className="h-10 w-full border-b border-line bg-transparent px-3 text-sm outline-none placeholder:text-faint"
              />
              <Command.List className="max-h-72 overflow-y-auto p-1.5">
                <Command.Empty className="p-4 text-center text-sm text-muted">No match.</Command.Empty>
                {rows.map((r) => {
                  const on = selectedSlugs.includes(r.slug);
                  return (
                    <Command.Item
                      key={r.slug}
                      value={r.name}
                      onSelect={() => toggle(r.slug)}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm data-[selected=true]:bg-surface",
                        !on && selected.length >= max && "opacity-40",
                      )}
                    >
                      <ProjectMark name={r.name} logoUrl={r.logoUrl} size={18} />
                      <span className="flex-1">{r.name}</span>
                      <span className="text-xs text-muted tabular">{fmtPct(r.overall)}</span>
                      <Check className={cn("size-3.5 text-accent", on ? "opacity-100" : "opacity-0")} />
                    </Command.Item>
                  );
                })}
              </Command.List>
            </Command>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
