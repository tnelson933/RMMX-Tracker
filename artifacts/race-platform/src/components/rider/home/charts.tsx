/**
 * Dark chart kit for the rider Home, ported from rider-app/components/charts.tsx
 * (inline SVG, same theme tokens): the rider in white, their best in gold, the
 * brand red only as a fill (area under the line, takeaway stripe).
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

export const DARK = {
  card: "#242424",
  border: "#3A3A3A",
  muted: "#2E2E2E",
  mutedText: "#A8A8A8",
  you: "#FFFFFF",
  best: "#F5B700",
  area: "rgba(179,0,0,0.35)",
  grid: "#3A3A3A",
  red: "#B30000",
};

export interface LineSeries {
  data: Array<number | null>;
  color: string;
  width?: number;
  dots?: boolean;
  /** Fill under the line (to the bottom of the plot). */
  area?: string;
}

export interface ChartMark { index: number; value: number; color: string; label?: string }

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Line chart. `invert` puts the smallest value at the top (positions: P1 at the
 * top). `band` shades a value range (the podium).
 */
export function LineChart({
  xLabels, series, yMin, yMax, yTicks = [], yFormat = String, invert, band, marks, height = 128, ariaLabel, padLeft = 42,
}: {
  padLeft?: number;
  xLabels: string[];
  series: LineSeries[];
  yMin: number;
  yMax: number;
  yTicks?: number[];
  yFormat?: (v: number) => string;
  invert?: boolean;
  band?: [number, number];
  marks?: ChartMark[];
  height?: number;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const L = padLeft, R = 10, T = 14, B = 20;
  const n = xLabels.length;
  const x = (i: number) => L + (n <= 1 ? (width - L - R) / 2 : (i * (width - L - R)) / (n - 1));
  const span = yMax - yMin || 1;
  const y = (v: number) => {
    const f = (v - yMin) / span;
    return invert ? T + f * (height - T - B) : height - B - f * (height - T - B);
  };
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((width - L - R) / 44))));

  return (
    <div ref={ref} role="img" aria-label={ariaLabel} style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} aria-hidden>
          {band && (
            <rect
              x={L} width={width - L - R}
              y={Math.min(y(band[0]), y(band[1]))} height={Math.abs(y(band[1]) - y(band[0]))}
              fill={DARK.best} opacity={0.14}
            />
          )}
          {yTicks.map(t => (
            <Fragment key={`t${t}`}>
              <line x1={L} x2={width - R} y1={y(t)} y2={y(t)} stroke={DARK.grid} strokeWidth={1} />
              <text x={L - 6} y={y(t) + 3.5} fontSize={11} fill={DARK.mutedText} textAnchor="end">{yFormat(t)}</text>
            </Fragment>
          ))}
          {xLabels.map((lab, i) => {
            if (!(i % every === 0 || i === n - 1)) return null;
            const long = lab.length > 3;
            const anchor = long && n > 1 && i === n - 1 ? "end" : long && i === 0 && L < 30 ? "start" : "middle";
            const dx = anchor === "end" ? 4 : anchor === "start" ? -4 : 0;
            return (
              <text key={`x${i}`} x={x(i) + dx} y={height - 5} fontSize={11} fill={DARK.mutedText} textAnchor={anchor}>{lab}</text>
            );
          })}
          {series.map((s, si) => {
            const pts = s.data
              .map((v, i) => (v == null ? null : ([x(i), y(v)] as const)))
              .filter((p): p is readonly [number, number] => p != null);
            if (pts.length === 0) return null;
            const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
            const base = height - B;
            return (
              <Fragment key={`s${si}`}>
                {s.area && pts.length > 1 && (
                  <path d={`${d} L${pts[pts.length - 1][0]} ${base} L${pts[0][0]} ${base} Z`} fill={s.area} />
                )}
                {pts.length > 1 && (
                  <path d={d} fill="none" stroke={s.color} strokeWidth={s.width ?? 2.5} strokeLinejoin="round" strokeLinecap="round" />
                )}
                {(s.dots || pts.length === 1) && pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={3} fill={s.color} />)}
              </Fragment>
            );
          })}
          {(marks ?? []).map((m, i) => (
            <Fragment key={`m${i}`}>
              <circle cx={x(m.index)} cy={y(m.value)} r={5.5} fill={m.color} stroke={DARK.card} strokeWidth={2} />
              {m.label ? (
                <text
                  x={Math.min(Math.max(x(m.index), L + 18), width - R - 18)}
                  y={y(m.value) + (invert || y(m.value) < T + 14 ? 17 : -9)}
                  fontSize={11} fontWeight={700} fill={m.color} textAnchor="middle"
                >
                  {m.label}
                </text>
              ) : null}
            </Fragment>
          ))}
        </svg>
      )}
    </div>
  );
}

/** Card with a muted uppercase title, the chart, and one takeaway behind a red race stripe. */
export function ChartCard({ title, right, takeaway, children }: {
  title: string; right?: ReactNode; takeaway?: string | null; children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[#3A3A3A] bg-[#242424] p-4 flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-heading font-bold uppercase tracking-[1.2px] text-[13px] text-[#A8A8A8]">{title}</h2>
        {right}
      </div>
      {children}
      {takeaway ? (
        <p className="flex items-start gap-2 text-[15px] leading-snug font-medium text-white">
          <span aria-hidden className="mt-[3px] inline-block h-4 w-1 shrink-0 -skew-x-[18deg] bg-[#B30000]" />
          {takeaway}
        </p>
      ) : null}
    </section>
  );
}
