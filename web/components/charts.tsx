"use client";

import { useState, type ReactNode } from "react";

/**
 * Small, dependency-free charts for the benchmark page.
 * Marks follow one spec: thin bars with 4px rounded data-ends anchored at the baseline, a 2px
 * surface gap between stacked segments, direct value labels in text ink (never series color),
 * a recessive grid, and a hover/focus tooltip per mark.
 */

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

function useTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const bind = (content: ReactNode) => ({
    onMouseMove: (e: React.MouseEvent<HTMLElement>) => {
      const host = e.currentTarget.closest("[data-chart]")!.getBoundingClientRect();
      setTip({ x: e.clientX - host.left, y: e.clientY - host.top, content });
    },
    onMouseLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      const host = e.currentTarget.closest("[data-chart]")!.getBoundingClientRect();
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ x: r.left - host.left + r.width / 2, y: r.top - host.top, content });
    },
    onBlur: () => setTip(null),
    tabIndex: 0,
  });
  const layer = tip && (
    <div role="tooltip" className="pointer-events-none absolute z-20 w-max max-w-64 -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-card" style={{ left: tip.x, top: tip.y }}>
      {tip.content}
    </div>
  );
  return { bind, layer };
}

/** Plot width: the rest of the row is left for the end-of-bar labels. */
const PLOT = "w-[60%] sm:w-[80%]";

function niceMax(v: number) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export interface RangeRow {
  label: string;
  sub?: string;
  color: string;
  p50: number;
  p95: number;
}

/** Typical (p50, bar) and slowest-5% (p95, whisker) payment latency per method, on one linear axis. */
export function LatencyChart({ rows, unit = "ms" }: { rows: RangeRow[]; unit?: string }) {
  const { bind, layer } = useTip();
  const max = niceMax(Math.max(...rows.map((r) => r.p95)));
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const pct = (v: number) => `${(v / max) * 100}%`;
  return (
    <div data-chart className="relative">
      <div className="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-2">
          <span aria-hidden className="h-2 w-5 rounded-sm bg-muted/70" /> p50 (typical)
        </span>
        <span className="flex items-center gap-2">
          <span aria-hidden className="flex w-5 items-center">
            <span className="h-px flex-1 bg-muted" />
            <span className="h-2.5 w-px bg-muted" />
          </span>
          p95 (slowest 5%)
        </span>
      </div>
      <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-[11rem_minmax(0,1fr)]">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <div className="flex flex-col justify-center pt-3 sm:py-3">
              <span className="flex items-center gap-2 text-sm font-medium">
                <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: r.color }} />
                {r.label}
              </span>
              {r.sub && <span className="pl-4 text-xs text-faint">{r.sub}</span>}
            </div>
            <div
              className="relative flex items-center pt-2 pb-3 outline-none sm:py-3 focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label={`${r.label}: p50 ${r.p50} ${unit}, p95 ${r.p95} ${unit}`}
              {...bind(
                <>
                  <div className="mb-1 font-medium">{r.label}</div>
                  <div className="font-mono text-muted">
                    p50 {r.p50.toLocaleString()} {unit}
                    <br />
                    p95 {r.p95.toLocaleString()} {unit}
                  </div>
                </>,
              )}
            >
              <div aria-hidden className={`absolute inset-y-0 left-0 ${PLOT}`}>
                {ticks.slice(1).map((t) => (
                  <span key={t} className="absolute inset-y-0 w-px bg-line/70" style={{ left: pct(t) }} />
                ))}
              </div>
              <div className={`relative h-3.5 ${PLOT}`}>
                {/* whisker from p50 to p95 */}
                <span aria-hidden className="absolute top-1/2 h-px -translate-y-1/2 bg-muted" style={{ left: pct(r.p50), width: `calc(${pct(r.p95 - r.p50)})` }} />
                <span aria-hidden className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-muted" style={{ left: pct(r.p95) }} />
                <span aria-hidden className="absolute inset-y-0 left-0 rounded-r-[4px]" style={{ width: `max(3px, ${pct(r.p50)})`, background: r.color }} />
                <span className="absolute top-1/2 -translate-y-1/2 pl-2 font-mono text-xs whitespace-nowrap text-fg tabular-nums" style={{ left: pct(r.p95) }}>
                  {r.p50.toLocaleString()} <span className="text-faint">/ {r.p95.toLocaleString()} {unit}</span>
                </span>
              </div>
            </div>
          </div>
        ))}
        <div className="hidden sm:block" />
        <div aria-hidden className={`relative mt-1 h-5 border-t border-line font-mono text-[11px] text-faint ${PLOT}`}>
          {ticks.map((t, i) => (
            <span key={t} className={`absolute top-1 ${i === 0 ? "" : i === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2"}`} style={{ left: pct(t) }}>
              {t >= 1000 ? `${t / 1000}s` : `${t}`}
            </span>
          ))}
        </div>
      </div>
      {layer}
    </div>
  );
}

export interface BarRow {
  label: string;
  sub?: string;
  color: string;
  value: number;
  display?: string;
  note?: string;
}

/** One value per row on a shared linear axis, labelled at the end of each bar. */
export function BarChart({ rows, max: maxIn }: { rows: BarRow[]; max?: number }) {
  const { bind, layer } = useTip();
  const max = maxIn ?? niceMax(Math.max(1, ...rows.map((r) => r.value)));
  return (
    <div data-chart className="relative">
      <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-[11rem_minmax(0,1fr)]">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <div className="flex flex-col justify-center pt-3 sm:py-3">
              <span className="flex items-center gap-2 text-sm font-medium">
                <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: r.color }} />
                {r.label}
              </span>
              {r.sub && <span className="pl-4 text-xs text-faint">{r.sub}</span>}
            </div>
            <div
              className="relative flex items-center pt-2 pb-3 outline-none sm:border-l sm:border-line sm:py-3 focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label={`${r.label}: ${r.display ?? r.value}`}
              {...bind(
                <>
                  <div className="mb-1 font-medium">{r.label}</div>
                  <div className="font-mono text-muted">{r.display ?? r.value.toLocaleString()}</div>
                  {r.note && <div className="mt-1 max-w-56 text-faint">{r.note}</div>}
                </>,
              )}
            >
              {/* The track stops short of the edge so the end label always has room. */}
              <div className="relative h-3.5 w-[62%] sm:w-[72%]">
                {r.value > 0 && <span aria-hidden className="absolute inset-y-0 left-0 rounded-r-[4px]" style={{ width: `max(3px, ${(r.value / max) * 100}%)`, background: r.color }} />}
                <span className="absolute top-1/2 -translate-y-1/2 pl-2 font-mono text-xs whitespace-nowrap text-fg tabular-nums" style={{ left: `${(r.value / max) * 100}%` }}>
                  {r.display ?? r.value.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
      {layer}
    </div>
  );
}

export interface Segment {
  label: string;
  value: number;
  color: string;
  /** Diagonal hatch, so a segment never relies on color alone. */
  hatch?: boolean;
}

/** 100% stacked bars (out of `total`), with a legend above and counts in the tooltip. */
export function StackedBars({ rows, total, legend }: { rows: { label: string; sub?: string; segments: Segment[] }[]; total: number; legend: Segment[] }) {
  const { bind, layer } = useTip();
  return (
    <div data-chart className="relative">
      <ul className="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        {legend.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span aria-hidden className="h-2.5 w-4 rounded-sm" style={swatch(s)} />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="space-y-5">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">{r.label}</span>
              {r.sub && <span className="text-xs text-faint">{r.sub}</span>}
            </div>
            <div className="flex h-7 w-full gap-[2px]">
              {r.segments
                .filter((s) => s.value > 0)
                .map((s, i, arr) => (
                  <div
                    key={s.label}
                    aria-label={`${r.label}, ${s.label}: ${s.value} of ${total}`}
                    className={`relative flex items-center justify-center outline-none first:rounded-l-[4px] focus-visible:ring-2 focus-visible:ring-accent/40 ${i === arr.length - 1 ? "rounded-r-[4px]" : ""}`}
                    style={{ width: `${(s.value / total) * 100}%`, ...swatch(s) }}
                    {...bind(
                      <>
                        <div className="mb-1 font-medium">{s.label}</div>
                        <div className="font-mono text-muted">
                          {s.value} of {total} calls
                        </div>
                      </>,
                    )}
                  >
                    {s.value / total >= 0.08 && <span className="rounded bg-surface/85 px-1.5 font-mono text-[11px] font-medium text-fg tabular-nums">{s.value}</span>}
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
      {layer}
    </div>
  );
}

function swatch(s: Segment): React.CSSProperties {
  return s.hatch
    ? { backgroundColor: s.color, backgroundImage: "repeating-linear-gradient(45deg, rgb(255 255 255 / 0.35) 0 2px, transparent 2px 6px)" }
    : { backgroundColor: s.color };
}
