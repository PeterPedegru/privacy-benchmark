import type { ReactNode } from "react";
import { Drawer } from "vaul";

/** The phone variant of <Sheet>: a vaul bottom sheet. Lazily loaded so vaul only ships to phones that open one. */
export function DrawerSheet({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    // repositionInputs off: vaul's keyboard repositioning made the drawer shift under the user's finger
    // while typing, so buttons below a focused field were hard to hit.
    <Drawer.Root open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88vh] flex-col rounded-t-2xl border-t border-line bg-bg outline-none">
          <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-line-strong" />
          <div className="border-b border-line px-4 pt-3 pb-3">
            <Drawer.Title className="text-base font-semibold">{title}</Drawer.Title>
            {subtitle && <Drawer.Description className="mt-0.5 text-sm text-muted">{subtitle}</Drawer.Description>}
          </div>
          <div className="overflow-y-auto px-4 pt-3 pb-[max(1.5rem,env(safe-area-inset-bottom))]">{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
