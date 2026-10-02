import NumberFlow from "@number-flow/react";
import { useReducedMotion } from "motion/react";

/**
 * Animated percentage (digits roll when the value changes) for hero and headline numbers. Each one is a custom
 * element with its own shadow root, so dense tables print `fmtPct(value)` instead.
 */
export function Pct({
  value,
  digits = 1,
  className,
  suffix = "%",
}: {
  value: number | null | undefined;
  digits?: number;
  className?: string;
  suffix?: string;
}) {
  const reduce = useReducedMotion();
  if (value === null || value === undefined) return <span className={className}>—</span>;
  return (
    <NumberFlow
      className={className}
      value={Math.round(value * 10 ** digits) / 10 ** digits}
      format={{ minimumFractionDigits: digits, maximumFractionDigits: digits }}
      suffix={suffix}
      animated={!reduce}
    />
  );
}
