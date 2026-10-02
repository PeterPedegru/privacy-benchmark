import { RotateCw } from "lucide-react";
import { m } from "motion/react";
import type { ReactNode } from "react";
import { inView } from "@/design/motion";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("shimmer rounded-md", className)} />;
}

export function Reveal({
  children,
  className,
  delay = 0,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: "div" | "section" | "li";
}) {
  const C = m[as];
  const variants = {
    hidden: { opacity: 0, filter: "blur(2px)", y: 6 },
    show: { opacity: 1, filter: "blur(0px)", y: 0, transition: { duration: 0.6, ease: [0.33, 1, 0.68, 1] as const, delay } },
  };
  return (
    <C className={className} variants={variants} {...inView}>
      {children}
    </C>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-bg-2 px-1 font-mono text-[10px] text-muted">
      {children}
    </kbd>
  );
}

/**
 * A request that failed for a reason other than "not found" (R3-REL-14): the network, or the server mid-deploy.
 * Always offers a retry, so a visitor is never told a published project doesn't exist when it just didn't load.
 */
export function LoadError({ title = "Couldn't load this.", onRetry, busy }: { title?: string; onRetry: () => void; busy?: boolean }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong px-6 py-14 text-center">
      <div className="text-[15px] font-semibold text-fg">{title}</div>
      <div className="mt-1 max-w-md text-sm text-muted">The server didn't answer. It may be restarting after an update.</div>
      <Button className="mt-4" size="sm" icon={<RotateCw className={cn("size-3.5", busy && "animate-spin")} />} disabled={busy} onClick={onRetry}>
        {busy ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong px-6 py-14 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <div className="text-[15px] font-semibold text-fg">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  muted,
  className,
  children,
}: {
  eyebrow?: string;
  title: string;
  muted?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-3 md:flex-row md:items-end md:justify-between", className)}>
      <div className="min-w-0 max-w-3xl flex-1">
        {eyebrow && <div className="eyebrow mb-3">{eyebrow}</div>}
        <h2 className="text-[28px] leading-[1.2] font-medium tracking-[-0.01em] text-balance md:text-4xl md:leading-[1.12]">
          {title}
          {muted && <span className="text-muted"> {muted}</span>}
        </h2>
      </div>
      {children}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-2xl border border-line bg-bg shadow-1", className)}>{children}</div>;
}
