/**
 * Small chart kit on react-native-svg (already in the app binary, so no new
 * native code). Colours come from the theme's chart tokens: the rider in
 * `chartYou`, the field in `chartField`, their best in `chartBest`. The brand
 * red is only used as a fill, never as a thin line or text on dark.
 */
import React, { useState } from "react";
import { Text, View } from "react-native";
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from "react-native-svg";

import { fonts } from "@/constants/fonts";
import { useColors } from "@/hooks/useColors";

export interface LineSeries {
  data: Array<number | null>;
  color: string;
  width?: number;
  dots?: boolean;
  /** Fill under the line (to the bottom of the plot). */
  area?: string;
}

export interface ChartMark { index: number; value: number; color: string; label?: string }

/**
 * Line chart with a value axis on the left. `invert` puts the smallest value at
 * the top (positions: P1 at the top). `band` shades a value range (the podium).
 */
export function LineChart({
  xLabels, series, yMin, yMax, yTicks, yFormat, invert, band, marks, height = 128, accessibilityLabel, padLeft = 42,
}: {
  /** Room for the value axis; use a small value for sparklines without ticks. */
  padLeft?: number;
  xLabels: string[];
  series: LineSeries[];
  yMin: number;
  yMax: number;
  yTicks: number[];
  yFormat: (v: number) => string;
  invert?: boolean;
  band?: [number, number];
  marks?: ChartMark[];
  height?: number;
  accessibilityLabel: string;
}) {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const L = padLeft, R = 10, T = 14, B = 20;
  const n = xLabels.length;
  const x = (i: number) => L + (n <= 1 ? (width - L - R) / 2 : (i * (width - L - R)) / (n - 1));
  const span = yMax - yMin || 1;
  const y = (v: number) => {
    const f = (v - yMin) / span;
    return invert ? T + f * (height - T - B) : height - B - f * (height - T - B);
  };
  // Thin out x labels so they never collide (about one per 34px).
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((width - L - R) / 34))));

  return (
    <View
      onLayout={e => setWidth(e.nativeEvent.layout.width)}
      style={{ height }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      {width > 0 && (
        <Svg width={width} height={height}>
          {band && (
            <Rect
              x={L} width={width - L - R}
              y={Math.min(y(band[0]), y(band[1]))} height={Math.abs(y(band[1]) - y(band[0]))}
              fill={colors.chartBest} opacity={0.14}
            />
          )}
          {yTicks.map(t => (
            <React.Fragment key={`t${t}`}>
              <Line x1={L} x2={width - R} y1={y(t)} y2={y(t)} stroke={colors.chartGrid} strokeWidth={1} />
              <SvgText x={L - 6} y={y(t) + 3.5} fontSize={10} fill={colors.mutedForeground} textAnchor="end" fontFamily={fonts.medium}>
                {yFormat(t)}
              </SvgText>
            </React.Fragment>
          ))}
          {xLabels.map((lab, i) => {
            if (!(i % every === 0 || i === n - 1)) return null;
            // Long labels (dates) at the ends are anchored inward so they aren't clipped.
            const long = lab.length > 3;
            const anchor = long && n > 1 && i === n - 1 ? "end" : long && i === 0 && L < 30 ? "start" : "middle";
            const dx = anchor === "end" ? 4 : anchor === "start" ? -4 : 0;
            return (
              <SvgText key={`x${i}`} x={x(i) + dx} y={height - 5} fontSize={10} fill={colors.mutedForeground} textAnchor={anchor} fontFamily={fonts.medium}>
                {lab}
              </SvgText>
            );
          })}
          {series.map((s, si) => {
            const pts = s.data.map((v, i) => (v == null ? null : ([x(i), y(v)] as const))).filter((p): p is readonly [number, number] => p != null);
            if (pts.length === 0) return null;
            const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
            const base = height - B;
            return (
              <React.Fragment key={`s${si}`}>
                {s.area && pts.length > 1 && (
                  <Path d={`${d} L${pts[pts.length - 1][0]} ${base} L${pts[0][0]} ${base} Z`} fill={s.area} />
                )}
                {pts.length > 1 && (
                  <Path d={d} fill="none" stroke={s.color} strokeWidth={s.width ?? 2.5} strokeLinejoin="round" strokeLinecap="round" />
                )}
                {(s.dots || pts.length === 1) && pts.map((p, i) => <Circle key={i} cx={p[0]} cy={p[1]} r={3} fill={s.color} />)}
              </React.Fragment>
            );
          })}
          {(marks ?? []).map((m, i) => (
            <React.Fragment key={`m${i}`}>
              <Circle cx={x(m.index)} cy={y(m.value)} r={5.5} fill={m.color} stroke={colors.card} strokeWidth={2} />
              {m.label ? (
                <SvgText
                  x={Math.min(Math.max(x(m.index), L + 18), width - R - 18)}
                  y={y(m.value) + (invert || y(m.value) < T + 14 ? 17 : -9)}
                  fontSize={11} fill={m.color} textAnchor="middle" fontFamily={fonts.bold}
                >
                  {m.label}
                </SvgText>
              ) : null}
            </React.Fragment>
          ))}
        </Svg>
      )}
    </View>
  );
}

/** Vertical bars with the value above each bar and a label below. */
export function ColumnChart({
  columns, max, height = 112, accessibilityLabel,
}: {
  columns: Array<{ key: string; label: string; value: number; valueLabel: string; color: string }>;
  max: number;
  height?: number;
  accessibilityLabel: string;
}) {
  const colors = useColors();
  const plot = height - 34;
  return (
    <View
      style={{ height, flexDirection: "row", alignItems: "flex-end", gap: 6, borderBottomWidth: 0 }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      {columns.map(c => (
        <View key={c.key} style={{ flex: 1, alignItems: "center", gap: 3 }}>
          <Text style={{ fontSize: 11, color: colors.foreground, fontFamily: fonts.bold, fontVariant: ["tabular-nums"] }} numberOfLines={1}>{c.valueLabel}</Text>
          <View style={{ width: "62%", maxWidth: 36, height: Math.max(3, (c.value / (max || 1)) * plot), borderTopLeftRadius: 3, borderTopRightRadius: 3, backgroundColor: c.color }} />
          <View style={{ alignSelf: "stretch", height: 1, backgroundColor: colors.chartGrid }} />
          <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.medium }} numberOfLines={1}>{c.label}</Text>
        </View>
      ))}
    </View>
  );
}

/** Horizontal bars with a label and a value on each row. */
export function BarList({
  rows, max, accessibilityLabel,
}: {
  rows: Array<{ key: string; label: string; value: number; valueLabel: string; color: string }>;
  max: number;
  accessibilityLabel: string;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: 8 }} accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
      {rows.map(r => (
        <View key={r.key} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text numberOfLines={1} style={{ width: 96, fontSize: 12, color: colors.foreground, fontFamily: fonts.medium }}>{r.label}</Text>
          <View style={{ flex: 1, height: 12, borderRadius: 3, backgroundColor: colors.muted, overflow: "hidden" }}>
            <View style={{ width: `${Math.max(2, Math.min(100, (r.value / (max || 1)) * 100))}%`, height: "100%", borderRadius: 3, backgroundColor: r.color }} />
          </View>
          <Text style={{ width: 52, textAlign: "right", fontSize: 12, color: colors.foreground, fontFamily: fonts.bold, fontVariant: ["tabular-nums"] }}>{r.valueLabel}</Text>
        </View>
      ))}
    </View>
  );
}

export function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      {items.map(it => (
        <View key={it.label} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <View style={{ width: 10, height: 3, borderRadius: 2, backgroundColor: it.color }} />
          <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.medium }}>{it.label}</Text>
        </View>
      ))}
    </View>
  );
}

/** A chart with its title, an optional legend or value on the right, and one takeaway. */
export function ChartCard({
  title, right, takeaway, children,
}: { title: string; right?: React.ReactNode; takeaway?: string | null; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 12, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1.2 }}>{title}</Text>
        {right}
      </View>
      {children}
      {takeaway ? (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <View style={{ width: 4, height: 16, marginTop: 1, backgroundColor: colors.primary, transform: [{ skewX: "-18deg" }] }} />
          <Text style={{ flex: 1, fontSize: 14, lineHeight: 18, color: colors.foreground, fontFamily: fonts.medium }}>{takeaway}</Text>
        </View>
      ) : null}
    </View>
  );
}
