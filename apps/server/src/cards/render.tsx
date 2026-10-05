import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import type { CardConfig, ProjectSnapshot } from "@pb/core";
import { benchmarks, fmtScore, getBenchmark, privacyText, rubric, suites } from "@pb/rubric";
import { renderAsync } from "@resvg/resvg-js";
import type { ReactNode } from "react";
import satori from "satori";
import { env } from "../env.ts";

/**
 * A WOFF 1.0 font unpacked to the TrueType/OpenType file inside it: each table inflated where it was compressed, then
 * laid out with a fresh table directory. Satori shapes text with HarfBuzz, which reads only the uncompressed formats;
 * handed a WOFF, it finds no glyphs and every character draws as the font's "NO GLYPH" box.
 */
export function woffToSfnt(woff: Buffer): Buffer {
  if (woff.toString("latin1", 0, 4) !== "wOFF") throw new Error("Not a WOFF 1.0 font");
  const count = woff.readUInt16BE(12);
  const tables = Array.from({ length: count }, (_, i) => {
    const at = 44 + i * 20;
    const offset = woff.readUInt32BE(at + 4);
    const compressed = woff.readUInt32BE(at + 8);
    const length = woff.readUInt32BE(at + 12);
    const raw = woff.subarray(offset, offset + compressed);
    return { tag: woff.readUInt32BE(at), checksum: woff.readUInt32BE(at + 16), data: compressed < length ? inflateSync(raw) : raw };
  });
  const padded = (n: number) => (n + 3) & ~3;
  const headerSize = 12 + 16 * count;
  const out = Buffer.alloc(tables.reduce((n, t) => n + padded(t.data.length), headerSize));
  // Offset table: the font's flavor, the table count, and the binary-search fields derived from it.
  const searchTables = 2 ** Math.floor(Math.log2(count));
  out.writeUInt32BE(woff.readUInt32BE(4), 0);
  out.writeUInt16BE(count, 4);
  out.writeUInt16BE(searchTables * 16, 6);
  out.writeUInt16BE(Math.log2(searchTables), 8);
  out.writeUInt16BE((count - searchTables) * 16, 10);
  let at = headerSize;
  tables.forEach((t, i) => {
    const record = 12 + i * 16;
    out.writeUInt32BE(t.tag, record);
    out.writeUInt32BE(t.checksum, record + 4);
    out.writeUInt32BE(at, record + 8);
    out.writeUInt32BE(t.data.length, record + 12);
    t.data.copy(out, at);
    at += padded(t.data.length);
  });
  return out;
}

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve("@fontsource/inter/package.json")), "files");
const font = (w: number) => woffToSfnt(readFileSync(join(fontDir, `inter-latin-${w}-normal.woff`)));
export const FONTS = [400, 500, 600, 700].map((weight) => ({
  name: "Inter",
  data: font(weight),
  weight: weight as 400 | 500 | 600 | 700,
  style: "normal" as const,
}));

export const KEY_BENCHMARKS = [
  "coverage.confidentiality",
  "coverage.unlinkability",
  "coverage.execution",
  "coverage.callstack",
  "trust.decryption",
  "custody.self-custody",
  "custody.pause",
  "custody.freeze",
  "custody.exit",
  "programmability.composability",
  "governance.upgrades",
  "decentralization.censorship",
  "security.soundness",
];

type Theme = ReturnType<typeof theme>;
function theme(cfg: CardConfig) {
  const dark = cfg.theme === "dark";
  const iris = cfg.accent === "iris";
  return {
    bg: dark ? "#0e0e10" : "#ffffff",
    fg: dark ? "#f5f6f8" : "#1f1f1f",
    muted: dark ? "#9aa3af" : "#5f6368",
    faint: dark ? "#6b7280" : "#8a8f96",
    line: dark ? "#2a2c31" : "#d9dbde",
    groupLine: dark ? "#3a3d44" : "#bfc3c8",
    outline: iris ? (dark ? "#8e84ff" : "#5b4cf0") : dark ? "#5aa2ff" : "#4a8fe7",
    focusFill: iris ? (dark ? "#3a3470" : "#dcd7ff") : dark ? "#1d4f8a" : "#a8d4ff",
    otherFill: dark ? "#26282d" : "#e3e6ea",
    track: dark ? "#26282d" : "#eef0f3",
    good: dark ? "#5fe0a8" : "#0a6b45",
    bad: dark ? "#ff8e8c" : "#a3272a",
  };
}

export const SIZES = { landscape: [1200, 630], square: [1080, 1080], portrait: [1080, 1350] } as const;

interface Row {
  group: string | null;
  name: string;
  sub: string | null;
  values: (number | null)[];
  strong?: boolean;
}

function projectLabel(s: ProjectSnapshot): [string, string] {
  return [s.project.name, s.version?.label ?? ""];
}

function buildRows(cfg: CardConfig, snaps: ProjectSnapshot[]): Row[] {
  const bench = (id: string) => snaps.map((s) => s.scores.suites.flatMap((x) => x.benchmarks).find((b) => b.benchmarkId === id)?.score ?? null);
  if (cfg.rowSet === "suites") {
    return [
      ...suites.map((su) => ({
        group: null,
        name: su.name,
        sub: su.tagline,
        values: snaps.map((s) => s.scores.suites.find((x) => x.suiteId === su.id)?.score ?? null),
      })),
      { group: null, name: "Overall", sub: "Weighted", values: snaps.map((s) => s.scores.overall), strong: true },
    ];
  }
  const ids =
    cfg.rowSet === "all"
      ? benchmarks.map((b) => b.id)
      : cfg.rowSet === "key"
        ? KEY_BENCHMARKS
        : (cfg.rows ?? KEY_BENCHMARKS).filter((id) => benchmarks.some((b) => b.id === id));
  let lastSuite = "";
  const rows: Row[] = ids.map((id) => {
    const b = getBenchmark(id);
    const su = suites.find((x) => x.id === b.suite)!;
    const group = su.id !== lastSuite ? su.shortName : null;
    lastSuite = su.id;
    return { group, name: b.name, sub: null, values: bench(id) };
  });
  rows.push({ group: "Overall", name: "Privacy score", sub: "Weighted", values: snaps.map((s) => s.scores.overall), strong: true });
  return rows;
}

function bestIdx(values: (number | null)[]): number[] {
  const nums = values.map((v) => (v === null ? Number.NEGATIVE_INFINITY : Math.round(v * 10) / 10));
  const max = Math.max(...nums);
  if (!Number.isFinite(max)) return [];
  return nums.map((v, i) => (v === max ? i : -1)).filter((i) => i >= 0);
}

function Footer({ t, snaps, width }: { t: Theme; snaps: ProjectSnapshot[]; width: number }) {
  const rel = snaps[0]?.release;
  const site = env.publicUrl.replace(/^https?:\/\//, "");
  return (
    <div style={{ display: "flex", width, fontSize: 14, color: t.muted, marginTop: 14 }}>
      {`Methodology: ${site}/methodology · Rubric v${rubric.version}${rel?.label ? ` · Release ${rel.label}` : ""}${rel?.isDemo ? " · Demo data" : ""}`}
    </div>
  );
}

function Header({ t, width, title }: { t: Theme; width: number; title: string }) {
  return (
    <div style={{ display: "flex", width, height: 22, justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", fontSize: 18, fontWeight: 600, color: t.fg, letterSpacing: -0.2 }}>
        <div style={{ display: "flex", width: 18, height: 18, borderRadius: 5, background: t.outline, marginRight: 10 }} />
        Privacy Benchmark
      </div>
      <div style={{ display: "flex", fontSize: 14, color: t.muted }}>{title}</div>
    </div>
  );
}

// ---------- table card (a benchmark table) ----------

function tableCard(cfg: CardConfig, snaps: ProjectSnapshot[]): { node: ReactNode; width: number; height: number } {
  const t = theme(cfg);
  let rows = buildRows(cfg, snaps);
  const fixed = cfg.size !== "auto" ? SIZES[cfg.size] : null;
  const width = fixed ? fixed[0] : 1200;
  const pad = 40;
  const inner = width - pad * 2;
  const hasGroups = rows.some((r) => r.group);
  const groupW = hasGroups ? 150 : 0;
  const n = snaps.length;
  const colW = Math.min(170, Math.floor((inner - groupW - 300) / n));
  const nameW = inner - groupW - colW * n;
  const headerH = 72;
  const chrome = 36 + 18 + 22 + headerH + 14 + 20 + 36;
  let rowH = 46;
  // Square and portrait cards have room for taller rows; landscape keeps the compact table.
  const tall = !!fixed && fixed[1] >= fixed[0];
  if (fixed) {
    const avail = fixed[1] - chrome;
    rowH = Math.min(tall ? 72 : 52, Math.floor(avail / rows.length));
    if (rowH < 26) {
      rowH = 26;
      rows = rows.slice(0, Math.floor(avail / 26));
    }
  }
  const height = fixed ? fixed[1] : chrome + rowH * rows.length;
  // What a fixed size leaves over: half above the table, half between it and the footer.
  const slack = fixed ? Math.max(0, height - chrome - rowH * rows.length) : 0;
  const fs = rowH >= 64 ? 19 : rowH >= 40 ? 17 : rowH >= 32 ? 15 : 13;
  // Each row's hint ("What's hidden") needs room beside its name; with many projects the names keep it all.
  const showHints = nameW >= 440;
  const focusIdx = snaps.findIndex((s) => `${s.project.slug}@${s.version?.version ?? ""}` === cfg.focus || s.project.slug === cfg.focus);
  const tableTop = 36 + 22 + 18 + Math.floor(slack / 2);
  const tableH = headerH + rowH * rows.length;

  const node = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width,
        height,
        background: t.bg,
        padding: `36px ${pad}px`,
        fontFamily: "Inter",
        color: t.fg,
        position: "relative",
      }}
    >
      <Header
        t={t}
        width={inner}
        title={
          snaps[0]?.release.publishedAt
            ? new Date(snaps[0].release.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
            : ""
        }
      />
      {slack ? <div style={{ display: "flex", height: Math.floor(slack / 2) }} /> : null}
      {/* header row */}
      <div style={{ display: "flex", width: inner, height: headerH, alignItems: "flex-end", paddingBottom: 10 }}>
        {hasGroups ? <div style={{ display: "flex", width: groupW }} /> : null}
        <div style={{ display: "flex", width: nameW, fontSize: 15, fontWeight: 600, color: t.fg }}>Benchmark</div>
        {snaps.map((s) => {
          const [name, ver] = projectLabel(s);
          return (
            <div
              key={s.project.slug + ver}
              style={{
                display: "flex",
                flexDirection: "column",
                width: colW,
                alignItems: "center",
                fontSize: 16,
                fontWeight: 500,
                lineHeight: 1.25,
                textAlign: "center",
              }}
            >
              <div style={{ display: "flex" }}>{name}</div>
              <div style={{ display: "flex", color: t.muted, fontSize: 14 }}>{ver || " "}</div>
            </div>
          );
        })}
      </div>
      {/* rows */}
      {rows.map((r, i) => {
        const best = bestIdx(r.values);
        const groupStart = !!r.group || i === 0;
        return (
          <div key={`${r.name}-${i}`} style={{ display: "flex", width: inner, height: rowH }}>
            {hasGroups ? (
              <div
                style={{
                  display: "flex",
                  width: groupW,
                  height: rowH,
                  fontSize: 14,
                  color: t.fg,
                  paddingTop: Math.max(6, rowH / 2 - 16),
                  paddingRight: 12,
                  borderTop: `1px solid ${groupStart ? t.groupLine : t.bg}`,
                }}
              >
                {r.group ?? ""}
              </div>
            ) : null}
            <div
              style={{
                display: "flex",
                width: inner - groupW,
                height: rowH,
                alignItems: "stretch",
                borderTop: `1px solid ${groupStart ? t.groupLine : t.line}`,
              }}
            >
              <div
                style={{
                  display: "flex",
                  width: nameW,
                  justifyContent: "space-between",
                  alignItems: "center",
                  paddingRight: 16,
                  fontSize: fs - 1,
                  fontWeight: r.strong ? 700 : 500,
                }}
              >
                <div style={{ display: "flex" }}>{r.name}</div>
                {r.sub && showHints ? <div style={{ display: "flex", fontSize: 13, fontWeight: 400, color: t.muted }}>{r.sub}</div> : null}
              </div>
              {r.values.map((v, j) => {
                const isBest = best.includes(j);
                const fill = isBest ? (j === focusIdx ? t.focusFill : t.otherFill) : t.bg;
                return (
                  <div
                    key={j}
                    style={{
                      display: "flex",
                      width: colW,
                      alignItems: "center",
                      justifyContent: "center",
                      background: fill,
                      fontSize: fs,
                      fontWeight: isBest || r.strong ? 700 : 500,
                    }}
                  >
                    {v === null ? "—" : fmtScore(v)}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div style={{ display: "flex", width: inner, borderTop: `1px solid ${t.groupLine}` }} />
      {slack ? <div style={{ display: "flex", flexGrow: 1 }} /> : null}
      {focusIdx >= 0 ? (
        <div
          style={{
            display: "flex",
            position: "absolute",
            left: pad + groupW + nameW + focusIdx * colW,
            top: tableTop,
            width: colW,
            height: tableH + 1,
            border: `2px solid ${t.outline}`,
          }}
        />
      ) : null}
      <Footer t={t} snaps={snaps} width={inner} />
    </div>
  );
  return { node, width, height };
}

// ---------- head-to-head ----------

function Badges({ s, t, align }: { s: ProjectSnapshot; t: Theme; align: "flex-start" | "flex-end" | "center" }) {
  const chip = (text: string, color: string) => (
    <div
      style={{
        display: "flex",
        fontSize: 14,
        fontWeight: 600,
        color,
        border: `1px solid ${t.line}`,
        borderRadius: 7,
        padding: "3px 9px",
        marginRight: 6,
        marginLeft: 6,
      }}
    >
      {text}
    </div>
  );
  const w = s.scores.walkaway.passed;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: align, marginTop: 10, rowGap: 6 }}>
      {chip(privacyText(s.scores.level, s.scores.trustTier), t.fg)}
      {chip(w === null ? "Walkaway —" : w ? "Walkaway pass" : "Walkaway fail", w ? t.good : w === false ? t.bad : t.muted)}
    </div>
  );
}

function headToHeadCard(cfg: CardConfig, snaps: ProjectSnapshot[]) {
  const t = theme(cfg);
  const [W, H] = cfg.size === "auto" ? SIZES.landscape : SIZES[cfg.size];
  const a = snaps[0]!;
  const b = snaps[1] ?? snaps[0]!;
  const pad = 48;
  const inner = W - pad * 2;
  // Square and portrait: taller rows and larger type, the whole comparison centred between header and footer.
  const tall = H >= W;
  const labelW = tall ? 264 : 220;
  const barW = (inner - labelW) / 2 - 70;
  const rowH = Math.min(tall ? 64 : 46, Math.floor((H - 330) / suites.length));
  const k = tall ? 1.2 : 1;
  const side = (s: ProjectSnapshot, align: "flex-start" | "flex-end") => (
    <div style={{ display: "flex", flexDirection: "column", alignItems: align, width: inner / 2 }}>
      <div style={{ display: "flex", fontSize: Math.round(22 * k), fontWeight: 600 }}>{s.project.name}</div>
      <div style={{ display: "flex", fontSize: Math.round(15 * k), color: t.muted }}>{s.version?.label ?? " "}</div>
      <div style={{ display: "flex", fontSize: Math.round(64 * k), fontWeight: 700, letterSpacing: -2, marginTop: 4 }}>{fmtScore(s.scores.overall)}</div>
      <Badges s={s} t={t} align={align} />
    </div>
  );
  const node = (
    <div
      style={{ display: "flex", flexDirection: "column", width: W, height: H, background: t.bg, padding: `36px ${pad}px`, fontFamily: "Inter", color: t.fg }}
    >
      <Header t={t} width={inner} title="Head to head" />
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: tall ? "center" : "flex-start" }}>
        <div style={{ display: "flex", width: inner, justifyContent: "space-between" }}>
          {side(a, "flex-start")}
          {side(b, "flex-end")}
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 22, borderTop: `1px solid ${t.groupLine}` }}>
          {suites.map((su) => {
            const va = a.scores.suites.find((x) => x.suiteId === su.id)?.score ?? null;
            const vb = b.scores.suites.find((x) => x.suiteId === su.id)?.score ?? null;
            const aWins = (va ?? -1) >= (vb ?? -1);
            const bWins = (vb ?? -1) >= (va ?? -1);
            return (
              <div key={su.id} style={{ display: "flex", alignItems: "center", height: rowH, borderBottom: `1px solid ${t.line}` }}>
                <div style={{ display: "flex", width: 70, fontSize: Math.round(16 * k), fontWeight: aWins ? 700 : 500 }}>{fmtScore(va)}</div>
                <div style={{ display: "flex", width: barW, height: 10, justifyContent: "flex-end", background: t.track, borderRadius: 5 }}>
                  <div
                    style={{ display: "flex", width: `${Math.max(0, va ?? 0)}%`, height: 10, borderRadius: 5, background: aWins ? t.outline : t.groupLine }}
                  />
                </div>
                <div style={{ display: "flex", width: labelW, justifyContent: "center", fontSize: Math.round(15 * k), fontWeight: 500, color: t.fg }}>
                  {su.name}
                </div>
                <div style={{ display: "flex", width: barW, height: 10, background: t.track, borderRadius: 5 }}>
                  <div
                    style={{ display: "flex", width: `${Math.max(0, vb ?? 0)}%`, height: 10, borderRadius: 5, background: bWins ? t.outline : t.groupLine }}
                  />
                </div>
                <div style={{ display: "flex", width: 70, justifyContent: "flex-end", fontSize: Math.round(16 * k), fontWeight: bWins ? 700 : 500 }}>
                  {fmtScore(vb)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <Footer t={t} snaps={snaps} width={inner} />
    </div>
  );
  return { node, width: W, height: H };
}

// ---------- spotlight ----------

function spotlightCard(cfg: CardConfig, snaps: ProjectSnapshot[]) {
  const t = theme(cfg);
  const [W, H] = cfg.size === "auto" ? SIZES.landscape : SIZES[cfg.size];
  const s = snaps[0]!;
  const pad = 48;
  const inner = W - pad * 2;
  // Square and portrait stack the ring over the bars, scaled up to use the height; landscape sets them side by side.
  const vertical = H >= W;
  const k = vertical ? Math.min(1.35, H / 1000) : 1;
  const ring = Math.round(200 * k);
  const side = 380;
  const R = 86;
  const C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(100, s.scores.overall ?? 0));
  const node = (
    <div
      style={{ display: "flex", flexDirection: "column", width: W, height: H, background: t.bg, padding: `36px ${pad}px`, fontFamily: "Inter", color: t.fg }}
    >
      <Header t={t} width={inner} title={s.version?.label ? `${s.project.name} · ${s.version.label}` : s.project.name} />
      {/* Portrait and square: the ring and the bars sit together, centred between header and footer. */}
      <div
        style={{
          display: "flex",
          flexDirection: vertical ? "column" : "row",
          width: inner,
          flexGrow: 1,
          alignItems: vertical ? "stretch" : "center",
          justifyContent: vertical ? "center" : "flex-start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", width: vertical ? inner : side, alignItems: vertical ? "center" : "flex-start" }}>
          <div style={{ display: "flex", fontSize: Math.round(34 * k), fontWeight: 600, letterSpacing: -0.8 }}>{s.project.name}</div>
          <div style={{ display: "flex", fontSize: Math.round(16 * k), color: t.muted, marginTop: 2 }}>{s.project.tagline.slice(0, 70)}</div>
          <div style={{ display: "flex", position: "relative", width: ring, height: ring, marginTop: 22, alignItems: "center", justifyContent: "center" }}>
            <svg width={ring} height={ring} viewBox="0 0 200 200" style={{ position: "absolute", left: 0, top: 0 }}>
              <circle cx="100" cy="100" r={R} fill="none" stroke={t.track} strokeWidth="12" />
              <circle
                cx="100"
                cy="100"
                r={R}
                fill="none"
                stroke={t.outline}
                strokeWidth="12"
                strokeLinecap="round"
                strokeDasharray={`${(C * pct) / 100} ${C}`}
                transform="rotate(-90 100 100)"
              />
            </svg>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ display: "flex", fontSize: Math.round(40 * k), fontWeight: 700, letterSpacing: -1.5 }}>{fmtScore(s.scores.overall)}</div>
              <div style={{ display: "flex", fontSize: Math.round(13 * k), color: t.muted }}>Privacy score</div>
            </div>
          </div>
          <Badges s={s} t={t} align={vertical ? "center" : "flex-start"} />
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            // A fixed width: without one, the summary's single long line would push the bars off the card.
            width: vertical ? inner : inner - side - 40,
            justifyContent: "center",
            marginLeft: vertical ? 0 : 40,
            marginTop: vertical ? 36 : 0,
          }}
        >
          {s.scores.suites.map((su) => {
            const def = suites.find((x) => x.id === su.suiteId)!;
            return (
              <div key={su.suiteId} style={{ display: "flex", flexDirection: "column", marginBottom: Math.round(12 * k) }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: Math.round(16 * k), fontWeight: 500 }}>
                  <div style={{ display: "flex" }}>{def.name}</div>
                  <div style={{ display: "flex", fontWeight: 700 }}>{fmtScore(su.score)}</div>
                </div>
                <div style={{ display: "flex", height: 8, background: t.track, borderRadius: 4, marginTop: 6 }}>
                  <div style={{ display: "flex", width: `${Math.max(0, su.score ?? 0)}%`, height: 8, borderRadius: 4, background: t.outline }} />
                </div>
              </div>
            );
          })}
          {s.summary ? (
            <div style={{ display: "flex", fontSize: Math.round(15 * k), color: t.muted, marginTop: 6, lineHeight: 1.4 }}>{s.summary.slice(0, 220)}</div>
          ) : null}
        </div>
      </div>
      <Footer t={t} snaps={snaps} width={inner} />
    </div>
  );
  return { node, width: W, height: H };
}

// ---------- render ----------

/**
 * Rasterizes at 1× (a landscape card is 1200×630, the Open Graph size). resvg runs on the libuv thread pool via
 * renderAsync, so only satori's layout uses the main thread. Callers cache the result (routes/cards.ts).
 */
async function rasterize(node: ReactNode, width: number, height: number, background: string): Promise<Buffer> {
  const svg = await satori(node as never, { width, height, fonts: FONTS });
  const img = await renderAsync(svg, { fitTo: { mode: "width", value: width }, background });
  return Buffer.from(img.asPng());
}

export async function renderCard(cfg: CardConfig, snaps: ProjectSnapshot[]): Promise<Buffer> {
  const built = cfg.template === "headtohead" ? headToHeadCard(cfg, snaps) : cfg.template === "spotlight" ? spotlightCard(cfg, snaps) : tableCard(cfg, snaps);
  return rasterize(built.node, built.width, built.height, theme(cfg).bg);
}

let brandCard: Promise<Buffer> | null = null;

/** Share image used before anything is published (the home page's og:image must always resolve). */
export function renderBrandCard(): Promise<Buffer> {
  brandCard ??= buildBrandCard().catch((e) => {
    brandCard = null;
    throw e;
  });
  return brandCard;
}

async function buildBrandCard(): Promise<Buffer> {
  const t = theme({ theme: "light", accent: "iris" } as CardConfig);
  const W = 1200;
  const H = 630;
  const node = (
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: W, height: H, padding: 72, background: t.bg, color: t.fg }}>
      <div style={{ display: "flex", alignItems: "center", fontSize: 28, fontWeight: 700 }}>
        <div style={{ display: "flex", width: 40, height: 40, borderRadius: 10, background: t.outline, marginRight: 16 }} />
        Privacy Benchmark
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontSize: 64, fontWeight: 700, lineHeight: 1.08, letterSpacing: -1.5 }}>
          Who can see, stop, or seize your private transactions?
        </div>
        <div style={{ display: "flex", fontSize: 28, color: t.muted, marginTop: 24 }}>Crypto privacy systems on a published rubric. Every number sourced.</div>
      </div>
      <div style={{ display: "flex", fontSize: 20, color: t.faint }}>31 benchmarks · 7 suites · published rubric and evaluator prompts</div>
    </div>
  );
  return rasterize(node, W, H, t.bg);
}
