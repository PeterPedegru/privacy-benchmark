import { lazy, Suspense, useEffect, useState } from "react";
import { onIdle } from "@/lib/utils";

const Toaster = lazy(() => import("sonner").then((m) => ({ default: m.Toaster })));

/**
 * sonner's Toaster, mounted once the browser is idle so it stays off the critical path.
 * Toasts fired before it mounts aren't lost: sonner replays active toasts to a new Toaster.
 */
export function DeferredToaster() {
  const [ready, setReady] = useState(false);
  useEffect(() => onIdle(() => setReady(true)), []);
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <Toaster position="bottom-right" toastOptions={{ className: "!rounded-xl !border-line !bg-bg !text-fg !shadow-5 !font-sans" }} />
    </Suspense>
  );
}
