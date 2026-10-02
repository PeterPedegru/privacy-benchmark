import { Link, type LinkProps } from "@tanstack/react-router";
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "accent" | "danger";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium select-none transition-[background-color,border-color,color,box-shadow,transform] duration-300 active:duration-[50ms] hover:duration-[50ms] active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none";
const variants: Record<Variant, string> = {
  primary: "btn-primary text-white dark:text-[#111] border border-[#505967] dark:border-white/40 shadow-1",
  secondary: "bg-bg text-fg border border-line-strong hover:bg-bg-2 shadow-1",
  ghost: "text-fg-3 hover:text-fg hover:bg-surface",
  accent: "bg-accent text-white hover:bg-accent-hover shadow-1",
  danger: "bg-bg text-poor-fg border border-poor-bd hover:bg-poor-bg",
};
const sizes: Record<Size, string> = {
  sm: "h-8 px-2.5 text-[13px] rounded-lg",
  md: "h-9 px-3.5 text-sm rounded-[10px]",
  lg: "h-11 px-5 text-[15px] rounded-xl",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, className, children, ...rest },
  ref,
) {
  return (
    <button ref={ref} type={rest.type ?? "button"} className={cn(base, variants[variant], sizes[size], className)} {...rest}>
      {icon}
      {children}
    </button>
  );
});

export function ButtonLink({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  ...rest
}: LinkProps & { variant?: Variant; size?: Size; icon?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <Link className={cn(base, variants[variant], sizes[size], className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
