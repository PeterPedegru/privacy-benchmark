import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { easeOut } from "@/design/motion";
import { isMobileViewport, MOBILE_QUERY, onIdle } from "@/lib/utils";

function useIsMobile() {
  const [mobile, setMobile] = useState(isMobileViewport);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const on = () => setMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

// vaul only matters on phones, so it loads separately (prefetched once the page is idle on a phone).
const loadDrawer = () => import("./drawer-sheet");
const DrawerSheet = lazy(() => loadDrawer().then((x) => ({ default: x.DrawerSheet })));

/** Side panel on desktop, bottom sheet on mobile. */
export function Sheet({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
  width = 560,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  const mobile = useIsMobile();
  // The drawer mounts the first time it opens and stays mounted, so it can animate closed.
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  useEffect(() => (mobile ? onIdle(() => void loadDrawer().catch(() => {})) : undefined), [mobile]);
  if (mobile) {
    if (!opened) return null;
    return (
      <Suspense fallback={null}>
        <DrawerSheet open={open} onOpenChange={onOpenChange} title={title} subtitle={subtitle}>
          {children}
        </DrawerSheet>
      </Suspense>
    );
  }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <m.div
                className="fixed inset-0 z-40 bg-black/20 dark:bg-black/50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined}>
              <m.div
                style={{ width }}
                className="fixed top-2 right-2 bottom-2 z-50 flex max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-2xl border border-line bg-bg shadow-5 outline-none"
                initial={{ opacity: 0, x: 24, filter: "blur(4px)" }}
                animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, x: 24, filter: "blur(4px)" }}
                transition={{ duration: 0.25, ease: easeOut }}
              >
                <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
                  <div className="min-w-0">
                    <Dialog.Title className="text-base font-semibold text-fg">{title}</Dialog.Title>
                    {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
                  </div>
                  <Dialog.Close className="-mr-1 rounded-lg p-1.5 text-muted hover:bg-surface hover:text-fg" aria-label="Close">
                    <X className="size-4" />
                  </Dialog.Close>
                </div>
                <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

export { useIsMobile };
