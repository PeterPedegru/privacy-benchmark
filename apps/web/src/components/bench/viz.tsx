import type { ProjectSnapshot } from "@pb/core";
import { ADVERSARIES, MATRIX_FIELDS, MATRIX_STATES, suites } from "@pb/rubric";
import { m, useReducedMotion } from "motion/react";
import { useState } from "react";
import { easeOut } from "@/design/motion";
import { cn } from "@/lib/utils";
import { Pct } from "../ui/number";
import { Tip } from "../ui/tooltip";

export function Bar({ value, tone = "accent", delay = 0, className }: { value: number | null; tone?: "accent" | "muted"; delay?: number; className?: string }) {
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-surface", className)}>
      <m.div
        className={cn("h-full origin-left rounded-full", tone === "accent" ? "bg-accent" : "bg-fg-3/50")}
        initial={{ scaleX: 0 }}
        whileInView={{ scaleX: (value ?? 0) / 100 }}
        viewport={{ once: true }}
        transition={{ duration: 0.8, ease: easeOut, delay }}
      />
    </div>
  );
}

export function ScoreRing({
  value,
  size = 120,
  stroke = 9,
  label = "Privacy score",
}: {
  value: number | null;
  size?: number;
  stroke?: number;
  label?: string;
}) {
  const r = (size - stroke) / 2;
  const reduce = useReducedMotion();
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
        <m.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={stroke}
          strokeLinecap="round"
          initial={{ pathLength: reduce ? (value ?? 0) / 100 : 0 }}
          animate={{ pathLength: (value ?? 0) / 100 }}
          transition={{ duration: 1, ease: easeOut }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-semibold tracking-[-0.02em] tabular" style={{ fontSize: size * 0.2 }}>
          <Pct value={value} />
        </span>
        {size >= 100 && <span className="text-[11px] text-muted">{label}</span>}
      </div>
    </div>
  );
}

/** Seven-petal suite rosette (petal length = suite score), a nod to L2BEAT's risk rosette. */
/**
 * Suite scores as petals. `gutter` is room beside the circle for full suite names, anchored away from the petals
 * (the longest, "Decentralization", sits at the left).
 */
export function Rosette({
  snapshot,
  size = 212,
  gutter = 64,
  compare,
}: {
  snapshot: ProjectSnapshot;
  size?: number;
  gutter?: number;
  compare?: ProjectSnapshot | null;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const c = size / 2;
  const R = size / 2 - 26;
  const width = size + gutter * 2;
  const n = suites.length;
  const petal = (i: number, v: number) => {
    const a0 = (i / n) * 2 * Math.PI - Math.PI / 2 - Math.PI / n + 0.05;
    const a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2 - Math.PI / n - 0.05;
    const r = 10 + (R - 10) * Math.max(0, Math.min(1, v / 100));
    const p = (a: number, rr: number) => `${c + gutter + rr * Math.cos(a)},${c + rr * Math.sin(a)}`;
    return `M ${p(a0, 10)} L ${p(a0, r)} A ${r} ${r} 0 0 1 ${p(a1, r)} L ${p(a1, 10)} A 10 10 0 0 0 ${p(a0, 10)} Z`;
  };
  return (
    <div className="relative" style={{ width, height: size }}>
      <svg width={width} height={size} role="img" aria-label="Suite scores rosette">
        {[25, 50, 75, 100].map((g) => (
          <circle
            key={g}
            cx={c + gutter}
            cy={c}
            r={10 + ((R - 10) * g) / 100}
            fill="none"
            stroke="var(--line)"
            strokeDasharray={g === 100 ? undefined : "2 3"}
          />
        ))}
        {suites.map((su, i) => {
          const v = snapshot.scores.suites.find((x) => x.suiteId === su.id)?.score ?? 0;
          const cv = compare?.scores.suites.find((x) => x.suiteId === su.id)?.score;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: hover only highlights a petal; every value is also listed in the Suites panel.
            <g key={su.id} onMouseEnter={() => setHover(su.id)} onMouseLeave={() => setHover(null)}>
              {cv !== undefined && <path d={petal(i, cv ?? 0)} fill="none" stroke="var(--fg-3)" strokeDasharray="3 3" />}
              <m.path
                d={petal(i, v)}
                fill="var(--accent)"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: hover && hover !== su.id ? 0.35 : 0.9, scale: 1 }}
                transition={{ duration: 0.6, ease: easeOut, delay: i * 0.05 }}
                style={{ transformOrigin: `${c + gutter}px ${c}px` }}
              />
            </g>
          );
        })}
        {suites.map((su, i) => {
          const a = ((i + 0.5) / n) * 2 * Math.PI - Math.PI / 2 - Math.PI / n;
          const cos = Math.cos(a);
          const x = c + gutter + (R + 10) * cos;
          const y = c + (R + 12) * Math.sin(a);
          return (
            <text
              key={su.id}
              x={x}
              y={y}
              textAnchor={cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle"}
              dominantBaseline="middle"
              className="fill-[var(--muted)] text-[10px] font-medium"
            >
              {su.shortName}
            </text>
          );
        })}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 text-center text-xs text-fg-2">
          {suites.find((s) => s.id === hover)?.name} · <Pct value={snapshot.scores.suites.find((x) => x.suiteId === hover)?.score} />
        </div>
      )}
    </div>
  );
}

const STATE_CLASS: Record<string, string> = {
  private: "bg-strong-bg text-strong-fg border-strong-bd",
  at_risk: "bg-fair-bg text-fair-fg border-fair-bd",
  exposed: "bg-poor-bg text-poor-fg border-poor-bd",
  unverifiable: "bg-surface text-muted border-line",
  n_a: "bg-bg text-faint border-line-weak",
};

export function AdversaryMatrixView({ snapshot }: { snapshot: ProjectSnapshot }) {
  const matrix = snapshot.matrix ?? {};
  if (!Object.keys(matrix).length) return <div className="text-sm text-muted">No adversary matrix for this evaluation.</div>;
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className="w-full min-w-[640px] border-separate border-spacing-1 text-left">
        <thead>
          <tr>
            <th className="w-44 pb-1 text-xs font-medium text-muted">Adversary</th>
            {MATRIX_FIELDS.map((f) => (
              <th key={f.id} className="pb-1 text-center text-xs font-medium text-muted">
                {f.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ADVERSARIES.map((a) => (
            <tr key={a.id}>
              <td className="pr-2 align-middle">
                <Tip content={a.description}>
                  <span className="text-[13px] font-medium text-fg">{a.name}</span>
                </Tip>
              </td>
              {MATRIX_FIELDS.map((f) => {
                const cell = matrix[a.id]?.[f.id];
                const st = MATRIX_STATES.find((s) => s.id === (cell?.state ?? "unverifiable"));
                return (
                  <td key={f.id} className="p-0">
                    <Tip content={cell ? `${st?.name}${cell.note ? ` · ${cell.note}` : ""}` : "Not assessed"}>
                      <div
                        className={cn(
                          "flex h-8 items-center justify-center rounded-md border text-[13px] font-semibold",
                          STATE_CLASS[cell?.state ?? "unverifiable"],
                        )}
                      >
                        {st?.glyph ?? "?"}
                      </div>
                    </Tip>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted">
        {MATRIX_STATES.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1.5">
            <span className={cn("inline-flex size-4 items-center justify-center rounded border text-[10px]", STATE_CLASS[s.id])}>{s.glyph}</span>
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}
