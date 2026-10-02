import { Link } from "@tanstack/react-router";
import type { RefObject } from "react";
import { Drawer } from "vaul";

/** Phone menu as a bottom sheet. Lazily loaded by the shell (with vaul) the first time the menu button is tapped. */
export function MobileNav({
  open,
  onOpenChange,
  links,
  onCommand,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  links: readonly { to: string; label: string }[];
  onCommand: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-line bg-bg pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none"
          // The trigger lives in the shell (outside the drawer), so hand focus back to it ourselves.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            returnFocus.current?.focus();
          }}
        >
          <Drawer.Title className="sr-only">Menu</Drawer.Title>
          <div className="mx-auto mt-2.5 mb-2 h-1 w-10 rounded-full bg-line-strong" />
          <nav className="flex flex-col px-2">
            {links.map((n) => (
              <Link key={n.to} to={n.to} className="border-b border-line-weak px-3 py-3.5 text-base text-fg last:border-0">
                {n.label}
              </Link>
            ))}
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onCommand();
              }}
              className="px-3 py-3.5 text-left text-base text-muted"
            >
              Search projects…
            </button>
          </nav>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
