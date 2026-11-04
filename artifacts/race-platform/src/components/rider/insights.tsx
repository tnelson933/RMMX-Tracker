/**
 * Chart pieces for the rider website, matching the rider app: the rider in
 * charcoal, the field in grey, their best in gold, one plain-language takeaway
 * per chart. The maths and takeaways come from @workspace/rider-insights,
 * shared with the app.
 */
import type { ReactNode } from "react";
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

export const CHART = {
  you: "#242424",
  field: "#A3A3A0",
  best: "#B8860B",
  teammate: "#2F6FD6",
  area: "rgba(179,0,0,0.14)",
  grid: "#E4E4E2",
  muted: "#707070",
  red: "#B30000",
};

/** Stock riding photo used until riders upload their own. */
export const STOCK_PHOTO = "/brand/stock/rider-sand.jpg";

/** Event images are stored as "/api/storage/..." paths, served same-origin. */
export function eventImage(url: string | null | undefined): string | null {
  return url ? url : null;
}

export function ChartCard({ title, right, takeaway, children }: {
  title: string; right?: ReactNode; takeaway?: string | null; children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[#E2E2E2] bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="font-heading font-bold text-[14px] uppercase tracking-[1px] text-[#707070]">{title}</h4>
        {right}
      </div>
      {children}
      {takeaway ? <Takeaway text={takeaway} /> : null}
    </div>
  );
}

export function Takeaway({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 text-[15px] font-medium text-[#242424] leading-snug">
      <span aria-hidden className="mt-[3px] inline-block h-4 w-1 shrink-0 -skew-x-[18deg] bg-[#B30000]" />
      {text}
    </p>
  );
}

export function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <div className="flex flex-wrap gap-3 text-[12px] text-[#707070]">
      {items.map(it => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[3px] w-3 rounded" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export interface TrendSeries { key: string; name: string; color: string; dots?: boolean; area?: boolean; width?: number }

/**
 * Line chart over labelled points. `invert` puts the smallest value on top
 * (positions). `band` shades a value range (the podium). `mark` highlights one
 * point (the best).
 */
export function TrendChart({
  data, series, yMin, yMax, yTicks, yFormat, invert, band, mark, height = 180, ariaLabel,
}: {
  data: Array<Record<string, string | number | null>>;
  series: TrendSeries[];
  yMin: number; yMax: number; yTicks?: number[];
  yFormat: (v: number) => string;
  invert?: boolean;
  band?: [number, number];
  mark?: { x: string; y: number };
  height?: number;
  ariaLabel: string;
}) {
  return (
    <div role="img" aria-label={ariaLabel} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="x" tick={{ fontSize: 11, fill: CHART.muted }} tickLine={false} axisLine={{ stroke: CHART.grid }} interval="preserveStartEnd" />
          <YAxis
            domain={[yMin, yMax]} ticks={yTicks} reversed={invert} allowDataOverflow
            tickFormatter={v => yFormat(Number(v))} tick={{ fontSize: 11, fill: CHART.muted }} tickLine={false} axisLine={false} width={52}
          />
          {band && <ReferenceArea y1={band[0]} y2={band[1]} fill={CHART.best} fillOpacity={0.12} stroke="none" ifOverflow="extendDomain" />}
          <Tooltip
            formatter={(v: number | string, n: string) => [typeof v === "number" ? yFormat(v) : v, n]}
            contentStyle={{ borderRadius: 8, border: `1px solid ${CHART.grid}`, fontSize: 13 }}
          />
          {series.map(s => s.area ? (
            <Area key={s.key} type="linear" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={s.width ?? 2.5}
              fill={CHART.area} connectNulls dot={s.dots ? { r: 3, fill: s.color, strokeWidth: 0 } : false} isAnimationActive={false} />
          ) : (
            <Line key={s.key} type="linear" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={s.width ?? 2.5}
              connectNulls={false} dot={s.dots ? { r: 3, fill: s.color, strokeWidth: 0 } : false} isAnimationActive={false} />
          ))}
          {mark && <ReferenceDot x={mark.x} y={mark.y} r={6} fill={CHART.best} stroke="#fff" strokeWidth={2} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Vertical bars with the value above each one. */
export function Columns({ columns, ariaLabel }: {
  columns: Array<{ key: string; label: string; value: number; valueLabel: string; highlight?: boolean }>;
  ariaLabel: string;
}) {
  const max = Math.max(1, ...columns.map(c => c.value));
  return (
    <div role="img" aria-label={ariaLabel} className="flex items-end gap-2 h-36">
      {columns.map(c => (
        <div key={c.key} className="flex-1 flex flex-col items-center gap-1 min-w-0">
          <span className="text-[12px] font-bold text-[#242424] tabular-nums">{c.valueLabel}</span>
          <div className="w-3/5 max-w-[40px] rounded-t" style={{ height: `${Math.max(3, (c.value / max) * 96)}px`, background: c.highlight ? CHART.you : CHART.field }} />
          <div className="self-stretch h-px bg-[#E4E4E2]" />
          <span className="text-[11px] text-[#707070] truncate max-w-full">{c.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Horizontal bars with a label and value on each row. */
export function HBars({ rows, max, ariaLabel }: {
  rows: Array<{ key: string; label: string; value: number; valueLabel: string; color: string }>;
  max: number; ariaLabel: string;
}) {
  return (
    <div role="img" aria-label={ariaLabel} className="space-y-2">
      {rows.map(r => (
        <div key={r.key} className="flex items-center gap-3">
          <span className="w-32 shrink-0 truncate text-[13px] text-[#242424]">{r.label}</span>
          <div className="flex-1 h-3 rounded bg-[#EFEFEF] overflow-hidden">
            <div className="h-full rounded" style={{ width: `${Math.max(2, Math.min(100, (r.value / (max || 1)) * 100))}%`, background: r.color }} />
          </div>
          <span className="w-16 text-right text-[13px] font-bold tabular-nums text-[#242424]">{r.valueLabel}</span>
        </div>
      ))}
    </div>
  );
}

/** A photo header with a dark fade so white text reads on any image. */
export function PhotoHero({ src, children, className = "" }: { src?: string | null; children: ReactNode; className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-2xl bg-[#161616] ${className}`}>
      <img
        src={src || STOCK_PHOTO}
        onError={e => { const img = e.currentTarget; if (!img.src.endsWith(STOCK_PHOTO)) img.src = STOCK_PHOTO; }}
        alt="" aria-hidden
        className="absolute inset-0 h-full w-full object-cover object-[50%_20%]"
      />
      <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-black/0 via-black/35 to-black/90" />
      <div className="relative h-full">{children}</div>
    </div>
  );
}

/** Finish position badge: podium metal for P1–P3, brand red otherwise. */
export function PosBadge({ position, size = "md" }: { position: number | null | undefined; size?: "sm" | "md" | "lg" }) {
  if (position == null) return null;
  const metal = position === 1 ? "#F5B700" : position === 2 ? "#C9D1DB" : position === 3 ? "#D08A4A" : null;
  const cls = size === "lg" ? "h-14 min-w-[72px] px-4 text-[32px]" : size === "sm" ? "h-6 min-w-[36px] px-2 text-[14px]" : "h-8 min-w-[44px] px-3 text-[18px]";
  return (
    <span className={`inline-flex items-center justify-center rounded-md -skew-x-[8deg] font-heading font-extrabold italic ${cls}`}
      style={{ background: metal ?? CHART.red, color: metal ? "#14110A" : "#fff" }}>
      P{position}
    </span>
  );
}
