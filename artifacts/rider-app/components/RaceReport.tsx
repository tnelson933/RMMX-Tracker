/**
 * Race Report: the photo hero, moto picker and per-moto charts (lap times,
 * position by lap, gap to the leader, sectors, teammates), each with one
 * plain-language takeaway. The full lap table stays one tap away under
 * "All laps and splits". Used by the result screens (RaceSubScreens'
 * EventDetailScreen and app/result/[id].tsx).
 */
import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";

import { BarList, ChartCard, Legend, LineChart } from "@/components/charts";
import type { MotoResult } from "@/components/RaceSubScreens";
import { PositionBadge } from "@/components/RaceStats";
import { fonts } from "@/constants/fonts";
import { useColors } from "@/hooks/useColors";
import { API_BASE_URL } from "@/lib/apiBase";
import { displayDate } from "@/lib/format";
import {
  fmtLapShort, fmtSecs, gapTakeaway, lapTakeaway, niceTicks, parseLap, positionTakeaway,
  sectorLosses, sectorTakeaway, summarizeLaps, teamTakeaway,
} from "@/lib/raceReport";

/** Event images are stored as "/api/storage/..." paths on the API host. */
export function eventImageUri(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return API_BASE_URL ? `${API_BASE_URL}${url.startsWith("/") ? "" : "/"}${url}` : null;
}

/** Dirt-track artwork for events without a photo. */
function HeroArt() {
  return (
    <Svg style={StyleSheet.absoluteFill} viewBox="0 0 300 200" preserveAspectRatio="none">
      <Defs>
        <LinearGradient id="sky" x1="0.9" y1="0" x2="0.2" y2="1">
          <Stop offset="0" stopColor="#8A6A4A" />
          <Stop offset="0.45" stopColor="#4A3726" />
          <Stop offset="1" stopColor="#161616" />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="300" height="200" fill="url(#sky)" />
      <Path d="M0 140 C60 112 110 150 170 124 S260 104 300 118 L300 200 L0 200Z" fill="#2A1E15" />
      <Path d="M0 160 C80 146 150 172 300 150 L300 200 L0 200Z" fill="#1C140E" />
      <Path d="M188 40 L300 10 L300 22 L196 50Z" fill="#B30000" opacity={0.85} />
      <Path d="M210 56 L300 34 L300 40 L214 62Z" fill="#B30000" opacity={0.45} />
    </Svg>
  );
}

export function RaceReportHero({
  imageUrl, eventName, dateIso, place, raceClass, riderName, position, fieldSize, motoCount, points,
}: {
  imageUrl?: string | null;
  eventName: string;
  dateIso?: string | null;
  place?: string | null;
  raceClass?: string | null;
  riderName?: string | null;
  position: number | null | undefined;
  fieldSize?: number | null;
  motoCount: number;
  points?: number | null;
}) {
  const uri = eventImageUri(imageUrl);
  const [photoFailed, setPhotoFailed] = useState(false);
  const date = dateIso ? displayDate(dateIso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;
  const eyebrow = [date, raceClass].filter(Boolean).join("  ·  ");
  const stats = [
    `${motoCount} ${motoCount === 1 ? "moto" : "motos"}`,
    points ? `${points} pts` : null,
    place || null,
  ].filter(Boolean).join("  ·  ");
  return (
    <View style={{ borderRadius: 20, overflow: "hidden", minHeight: 210, justifyContent: "flex-end", backgroundColor: "#161616" }}>
      {uri && !photoFailed
        ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setPhotoFailed(true)} accessibilityIgnoresInvertColors />
        : <HeroArt />}
      {/* Dark fade so white text reads on any photo. */}
      <Svg style={StyleSheet.absoluteFill} viewBox="0 0 10 10" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0.25" stopColor="#000" stopOpacity={0} />
            <Stop offset="1" stopColor="#000" stopOpacity={0.88} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="10" height="10" fill="url(#fade)" />
      </Svg>
      <View style={{ padding: 16, gap: 4 }}>
        {riderName ? <Text style={hs.eyebrow} numberOfLines={1}>{riderName}</Text> : null}
        {eyebrow ? <Text style={hs.eyebrow} numberOfLines={1}>{eyebrow}</Text> : null}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 12 }}>
          <Text style={hs.title} numberOfLines={2}>{eventName}</Text>
          {position != null ? <PositionBadge position={position} size="lg" /> : null}
        </View>
        <Text style={hs.meta} numberOfLines={1}>
          {position != null && fieldSize ? `of ${fieldSize} riders  ·  ` : ""}{stats}
        </Text>
      </View>
    </View>
  );
}

const hs = StyleSheet.create({
  eyebrow: { fontSize: 13, color: "#E6E6E6", fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1.2 },
  title: { flex: 1, fontSize: 28, lineHeight: 30, color: "#FFFFFF", fontFamily: fonts.displayItalic, textTransform: "uppercase" },
  meta: { fontSize: 13, color: "#E6E6E6", fontFamily: fonts.medium },
});

/** Pill chips to pick a moto; hidden when there's only one. */
export function MotoChips({ motos, selected, onSelect }: { motos: MotoResult[]; selected: number; onSelect: (i: number) => void }) {
  const colors = useColors();
  if (motos.length < 2) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }} accessibilityRole="tablist">
      {motos.map((m, i) => {
        const on = i === selected;
        const result = m.dnf ? "DNF" : m.dns ? "DNS" : m.position != null ? `P${m.position}` : "";
        return (
          <Pressable
            key={m.motoId}
            onPress={() => onSelect(i)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={({ pressed }) => ({
              paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1,
              borderColor: on ? colors.foreground : colors.border,
              backgroundColor: on ? colors.foreground : "transparent",
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text style={{ fontSize: 14, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 0.8, color: on ? colors.background : colors.foreground }}>
              {m.motoName}{result ? `  ·  ${result}` : ""}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Charts for one moto, with the existing lap table (children) behind "All laps and splits". */
export function MotoReport({ moto, raceStyle, children }: { moto: MotoResult; raceStyle?: string | null; children: React.ReactNode }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);

  const lapSum = summarizeLaps(moto.lapTimes, raceStyle === "motocross");
  const countedLaps = lapSum.laps.slice(lapSum.firstCounted);
  const countedVals = countedLaps.filter((v): v is number => v != null);
  const showLaps = countedVals.length >= 2;

  const positions = moto.positionByLap ?? [];
  const posVals = positions.filter((p): p is number => p != null);
  const showPositions = posVals.length >= 2 && (moto.fieldSize ?? 0) > 1;

  const gaps = (moto.lapGaps ?? []).map(g => g.leader);
  const gapVals = gaps.filter((g): g is number => g != null);
  const showGaps = gapVals.length >= 2;

  const sectorRows = moto.sectors ? sectorLosses(moto.sectors.names, moto.sectors.bestMs, moto.sectors.fieldBestMs) : [];
  const worstSector = sectorRows.reduce((m, r) => Math.max(m, r.lossMs), 0);

  const team = moto.team && moto.team.members.length > 1 ? moto.team : null;

  const nothing = !showLaps && !showPositions && !showGaps && sectorRows.length === 0 && !team;

  return (
    <View style={{ gap: 12 }}>
      {showLaps && (() => {
        const lo = Math.min(...countedVals), hi = Math.max(...countedVals);
        const pad = Math.max(500, (hi - lo) * 0.15);
        const ticks = niceTicks(lo - pad, hi + pad, 4);
        const bi = lapSum.bestIndex! - lapSum.firstCounted;
        return (
          <ChartCard
            title="Lap times"
            right={<Legend items={[{ label: "You", color: colors.chartYou }, { label: `Best ${fmtLapShort(lapSum.bestMs)}`, color: colors.chartBest }]} />}
            takeaway={lapTakeaway(lapSum)}
          >
            <LineChart
              xLabels={countedLaps.map((_, i) => `L${i + lapSum.firstCounted + 1}`)}
              series={[{ data: countedLaps, color: colors.chartYou, dots: true }]}
              yMin={lo - pad} yMax={hi + pad} yTicks={ticks} yFormat={fmtLapShort}
              marks={[{ index: bi, value: lapSum.bestMs!, color: colors.chartBest }]}
              accessibilityLabel={`Lap times. Best ${fmtLapShort(lapSum.bestMs)} on lap ${lapSum.bestIndex! + 1}.`}
            />
          </ChartCard>
        );
      })()}

      {showPositions && (() => {
        const worst = Math.max(...posVals);
        const yMax = Math.max(worst + 0.5, 3.5);
        // P1, the worst position, and one in between when there's room.
        const ticks = worst >= 5 ? [1, Math.round((1 + worst) / 2), worst] : worst > 1 ? [1, worst] : [1];
        return (
          <ChartCard
            title="Position by lap"
            right={moto.fieldSize ? <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.medium }}>{moto.fieldSize} riders</Text> : null}
            takeaway={positionTakeaway(positions)}
          >
            <LineChart
              xLabels={positions.map((_, i) => `L${i + 1}`)}
              series={[{ data: positions, color: colors.chartYou, dots: true }]}
              yMin={0.5} yMax={yMax} invert band={[0.5, 3.5]} yTicks={ticks} yFormat={v => `P${v}`}
              accessibilityLabel={`Position at the end of each lap: ${posVals.map(p => `P${p}`).join(", ")}.`}
            />
          </ChartCard>
        );
      })()}

      {showGaps && (() => {
        const hi = Math.max(...gapVals, 1000);
        const final = gapVals[gapVals.length - 1];
        return (
          <ChartCard
            title="Gap to leader"
            right={<Text style={{ fontSize: 13, color: colors.foreground, fontFamily: fonts.bold, fontVariant: ["tabular-nums"] }}>{final === 0 ? "Leader" : `+${fmtSecs(final)}`}</Text>}
            takeaway={gapTakeaway(gaps)}
          >
            <LineChart
              xLabels={gaps.map((_, i) => `L${i + 1}`)}
              series={[{ data: gaps, color: colors.chartYou, area: colors.chartArea }]}
              yMin={0} yMax={hi * 1.1} yTicks={niceTicks(0, hi * 1.1, 3)} yFormat={v => (v === 0 ? "0" : `+${Math.round(v / 1000)}s`)}
              accessibilityLabel={`Gap to the leader after each lap, ending ${final === 0 ? "in the lead" : `${fmtSecs(final)} back`}.`}
            />
          </ChartCard>
        );
      })()}

      {sectorRows.length > 0 && (
        <ChartCard title="Your best sectors vs the fastest" takeaway={sectorTakeaway(sectorRows)}>
          <BarList
            max={Math.max(worstSector, 500)}
            rows={sectorRows.map(r => ({
              key: String(r.index),
              label: `S${r.index + 1} ${r.name}`,
              value: r.lossMs,
              valueLabel: r.lossMs < 50 ? "Fastest" : `+${(r.lossMs / 1000).toFixed(1)}s`,
              color: r.lossMs === worstSector && worstSector >= 100 ? colors.chartYou : colors.chartField,
            }))}
            accessibilityLabel={`Seconds lost to the fastest split: ${sectorRows.map(r => `${r.name} ${(r.lossMs / 1000).toFixed(1)}`).join(", ")}.`}
          />
        </ChartCard>
      )}

      {team && (() => {
        const laps = team.members.map(m => m.lapTimes.map(parseLap));
        const all = laps.flat().filter((v): v is number => v != null);
        if (all.length < 2) return null;
        const lo = Math.min(...all), hi = Math.max(...all);
        const pad = Math.max(500, (hi - lo) * 0.15);
        const longest = Math.max(...laps.map(l => l.length));
        const pal = [colors.chartTeammate, colors.chartField];
        let other = 0;
        const series = team.members.map((m, i) => ({
          data: Array.from({ length: longest }, (_, k) => laps[i][k] ?? null),
          color: m.isYou ? colors.chartYou : pal[Math.min(other++, pal.length - 1)],
          dots: true,
        }));
        const firstName = (n: string) => n.split(" ")[0] || n;
        return (
          <ChartCard
            title={team.name ? `Team ${team.name}` : "Your team"}
            right={<Legend items={team.members.map((m, i) => ({ label: m.isYou ? "You" : firstName(m.name), color: series[i].color }))} />}
            takeaway={teamTakeaway(team.members)}
          >
            <LineChart
              xLabels={Array.from({ length: longest }, (_, k) => `L${k + 1}`)}
              series={series}
              yMin={lo - pad} yMax={hi + pad} yTicks={niceTicks(lo - pad, hi + pad, 4)} yFormat={fmtLapShort}
              accessibilityLabel={`Each team rider's lap times: ${team.members.map(m => `${m.isYou ? "you" : m.name} ${m.lapCount} laps`).join(", ")}.`}
            />
          </ChartCard>
        );
      })()}

      <View style={{ borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, overflow: "hidden" }}>
        <Pressable
          onPress={() => setOpen(o => !o)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open || nothing }}
          disabled={nothing}
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, opacity: pressed ? 0.7 : 1 })}
        >
          <Text style={{ fontSize: 14, color: colors.foreground, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1 }}>
            All laps and splits
          </Text>
          {!nothing && <Feather name={open ? "chevron-up" : "chevron-down"} size={18} color={colors.mutedForeground} />}
        </Pressable>
        {(open || nothing) && <View style={{ borderTopWidth: 1, borderTopColor: colors.border }}>{children}</View>}
      </View>
    </View>
  );
}
