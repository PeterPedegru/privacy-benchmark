import { m } from "motion/react";
import { useId } from "react";
import { spring } from "@/design/motion";
import { cn } from "@/lib/utils";

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  size?: "sm" | "md";
  className?: string;
}) {
  const id = useId();
  return (
    <div role="tablist" className={cn("relative inline-flex rounded-[10px] bg-surface p-[3px]", className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            type="button"
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative z-10 rounded-[8px] px-3 font-medium transition-colors duration-200",
              size === "sm" ? "h-7 text-xs" : "h-8 text-[13px]",
              active ? "text-fg" : "text-muted hover:text-fg-3",
            )}
          >
            {active && <m.span layoutId={`seg-${id}`} transition={spring} className="absolute inset-0 -z-10 rounded-[8px] bg-bg shadow-hairline" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
