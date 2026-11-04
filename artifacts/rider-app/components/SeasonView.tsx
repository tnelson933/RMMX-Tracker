/**
 * My Season (My Races › Season): finishes, points, % off the winner's pace and
 * lap spread across a season, each with one plain-language takeaway. Built from
 * the rider history the screen already loads, plus /rider/series for the
 * rider's series position.
 */
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { ChartCard, ColumnChart, Legend, LineChart } from "@/components/charts";
import type { EventHistory, RiderSeriesEntry } from "@/components/RaceSubScreens";
import { PositionBadge } from "@/components/RaceStats";
import { PhotoFade, StockBackdrop } from "@/components/StockBackdrop";
import { fonts } from "@/constants/fonts";
import { useColors } from "@/hooks/useColors";
import { niceTicks } from "@/lib/raceReport";
import {
  finishTakeaway, ordinal, paceTakeaway, pointsTakeaway, seasonClasses, seasonRounds, seasonYears, spreadTakeaway,
} from "@/lib/season";

function Chips({ items, selected, onSelect }: { items: string[]; selected: string; onSelect: (v: string) => void }) {
  const colors = useColors();
  if (items.length < 2) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {items.map(it => {
        const on = it === selected;
        return (
          <Pressable
            key={it}
            onPress={() => onSelect(it)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={({ pressed }) => ({
              paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, borderWidth: 1,
              borderColor: on ? colors.foreground : colors.border, backgroundColor: on ? colors.foreground : "transparent",
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text style={{ fontSize: 14, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 0.8, color: on ? colors.background : colors.foreground }}>{it}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SeasonView({
  history, profiles, riderFetch, onOpenEvent, onOpenSeries,
}: {
  history: EventHistory[];
  /** The profiles the history was loaded for (riderName is "First Last" when there are several). */
  profiles: Array<{ id: number; firstName: string; lastName: string }>;
  riderFetch: (path: string, options?: RequestInit) => Promise<Response>;
  onOpenEvent: (ev: EventHistory) => void;
  onOpenSeries: (s: RiderSeriesEntry, riderId: number) => void;
}) {
  const colors = useColors();

  // Several profiles on one account: one season at a time per rider.
  const riders = useMemo(() => [...new Set(history.map(e => e.riderName ?? ""))], [history]);
  const [rider, setRider] = useState(riders[0] ?? "");
  const activeRider = riders.includes(rider) ? rider : riders[0];
  const mine = useMemo(() => history.filter(e => (e.riderName ?? "") === activeRider), [history, activeRider]);
  const riderId = (profiles.length === 1 ? profiles[0] : profiles.find(p => `${p.firstName} ${p.lastName}` === activeRider))?.id ?? null;

  const years = useMemo(() => seasonYears(mine), [mine]);
  const [year, setYear] = useState(years[0] ?? "");
  const activeYear = years.includes(year) ? year : years[0] ?? "";
  const classes = useMemo(() => seasonClasses(mine, activeYear), [mine, activeYear]);
  const [raceClass, setRaceClass] = useState(classes[0] ?? "");
  const activeClass = classes.includes(raceClass) ? raceClass : classes[0] ?? "";
  const rounds = useMemo(() => seasonRounds(mine, activeYear, activeClass), [mine, activeYear, activeClass]);
  const roundEvents = useMemo(
    () => mine.filter(e => e.eventDate.startsWith(activeYear) && e.raceClass === activeClass),
    [mine, activeYear, activeClass],
  );

  const [series, setSeries] = useState<RiderSeriesEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    setSeries([]);
    if (riderId == null) return;
    // Only this rider's series, not another rider's on the same account.
    riderFetch(`/api/rider/series?riderId=${riderId}`)
      .then(r => (r.ok ? r.json() : []))
      .then((d: RiderSeriesEntry[]) => { if (!cancelled) setSeries(Array.isArray(d) ? d : []); })
      .catch(() => { if (!cancelled) setSeries([]); });
    return () => { cancelled = true; };
  }, [riderFetch, riderId]);
  // The series this season's races belong to, in this class.
  const ids = new Set(rounds.map(r => r.eventId));
  const seasonSeries = series
    .filter(s => s.raceClass === activeClass && ((s.eventIds ?? []).some(id => ids.has(id)) || String(s.season ?? "") === activeYear))
    .sort((a, b) => a.position - b.position)[0] ?? null;

  if (history.length === 0 || rounds.length === 0) return null;

  const xs = rounds.map((_, i) => `R${i + 1}`);
  const podiums = roundEvents.filter(e => e.bestPosition != null && e.bestPosition <= 3).length;
  const totalPoints = rounds.reduce((a, r) => a + r.points, 0);

  const finishes = rounds.map(r => r.avgFinish);
  const finVals = finishes.filter((v): v is number => v != null);
  const worst = finVals.length ? Math.max(...finVals) : 3;
  const bestIdx = finVals.length ? finishes.indexOf(Math.min(...finVals)) : -1;

  const pace = rounds.map(r => r.pacePct);
  const paceVals = pace.filter((v): v is number => v != null);
  const paceMax = Math.max(1, ...paceVals) * 1.15;

  const spreads = rounds.map(r => r.spreadMs);
  const spreadVals = spreads.filter((v): v is number => v != null);

  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 16, gap: 12 }}>
      {riders.length > 1 && <Chips items={riders} selected={activeRider} onSelect={setRider} />}
      {/* Photo header: a stock riding photo until riders can add their own (phase 5). */}
      <View style={{ height: 150, borderRadius: 18, overflow: "hidden", justifyContent: "flex-end", backgroundColor: "#161616" }}>
        <StockBackdrop />
        <PhotoFade from={0.2} strength={0.9} />
        <View style={{ padding: 14, flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, color: "#E6E6E6", fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1.2 }} numberOfLines={1}>
              {activeClass}{riders.length > 1 && activeRider ? `  ·  ${activeRider}` : ""}
            </Text>
            <Text style={{ fontSize: 30, lineHeight: 32, color: "#FFFFFF", fontFamily: fonts.displayItalic, textTransform: "uppercase" }}>
              {activeYear} season
            </Text>
          </View>
        </View>
      </View>
      <Chips items={years} selected={activeYear} onSelect={setYear} />
      <Chips items={classes} selected={activeClass} onSelect={setRaceClass} />

      <View style={{ flexDirection: "row", gap: 8 }}>
        {[
          { v: String(rounds.length), l: rounds.length === 1 ? "Race" : "Races" },
          { v: String(podiums), l: podiums === 1 ? "Podium" : "Podiums" },
          { v: String(totalPoints), l: "Points" },
        ].map(t => (
          <View key={t.l} style={{ flex: 1, backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, paddingVertical: 10, alignItems: "center" }}>
            <Text style={{ fontSize: 26, color: colors.foreground, fontFamily: fonts.displayItalic }}>{t.v}</Text>
            <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1 }}>{t.l}</Text>
          </View>
        ))}
      </View>

      {finVals.length > 0 && (
        <ChartCard
          title="Average moto finish"
          right={<Legend items={[{ label: "Podium", color: colors.chartBest }]} />}
          takeaway={finishTakeaway(rounds)}
        >
          <LineChart
            xLabels={xs}
            series={[{ data: finishes, color: colors.chartYou, dots: true }]}
            yMin={0.5} yMax={Math.max(worst + 0.5, 3.5)} invert band={[0.5, 3.5]}
            yTicks={worst >= 5 ? [1, Math.round((1 + worst) / 2), Math.ceil(worst)] : worst > 1 ? [1, Math.ceil(worst)] : [1]}
            yFormat={v => `P${v}`}
            marks={bestIdx >= 0 ? [{ index: bestIdx, value: finishes[bestIdx]!, color: colors.chartBest }] : []}
            accessibilityLabel={`Average moto finish by race: ${rounds.map(r => (r.avgFinish == null ? "no finish" : `P${Math.round(r.avgFinish)}`)).join(", ")}.`}
          />
        </ChartCard>
      )}

      <ChartCard
        title="Points by race"
        right={seasonSeries ? (
          <Pressable onPress={() => riderId != null && onOpenSeries(seasonSeries, riderId)} accessibilityRole="button" accessibilityLabel={`${ordinal(seasonSeries.position)} in ${seasonSeries.seriesName}. Open standings.`}
            style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, opacity: pressed ? 0.7 : 1 })}>
            <PositionBadge position={seasonSeries.position} size="sm" />
            <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
        takeaway={pointsTakeaway(rounds, seasonSeries)}
      >
        <ColumnChart
          max={Math.max(1, ...rounds.map(r => r.points))}
          columns={rounds.map((r, i) => ({
            key: String(r.eventId), label: xs[i], value: r.points, valueLabel: String(r.points),
            color: i === rounds.length - 1 ? colors.chartYou : colors.chartField,
          }))}
          accessibilityLabel={`Points by race: ${rounds.map(r => `${r.eventName} ${r.points}`).join(", ")}.`}
        />
      </ChartCard>

      {paceVals.length > 0 && (
        <ChartCard title="% off the winner's pace" takeaway={paceTakeaway(rounds)}>
          <LineChart
            xLabels={xs}
            series={[{ data: pace.map(v => (v == null ? null : Math.max(0, v))), color: colors.chartYou, dots: true, area: colors.chartArea }]}
            yMin={0} yMax={paceMax} yTicks={niceTicks(0, paceMax, 3)} yFormat={v => `${v}%`}
            accessibilityLabel={`Percent slower than the winner's average lap: ${rounds.map(r => (r.pacePct == null ? "no data" : `${r.pacePct}%`)).join(", ")}.`}
          />
        </ChartCard>
      )}

      {spreadVals.length > 0 && (
        <ChartCard title="Lap spread (lower is steadier)" takeaway={spreadTakeaway(rounds)}>
          <ColumnChart
            max={Math.max(...spreadVals)}
            columns={rounds.map((r, i) => ({
              key: String(r.eventId), label: xs[i], value: r.spreadMs ?? 0,
              valueLabel: r.spreadMs == null ? "—" : `${(r.spreadMs / 1000).toFixed(1)}s`,
              color: i === rounds.length - 1 ? colors.chartYou : colors.chartField,
            }))}
            accessibilityLabel={`Gap between fastest and slowest lap by race: ${rounds.map(r => (r.spreadMs == null ? "no data" : `${(r.spreadMs / 1000).toFixed(1)} seconds`)).join(", ")}.`}
          />
        </ChartCard>
      )}

      <View style={{ backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, overflow: "hidden" }}>
        {rounds.map((r, i) => {
          const ev = roundEvents.find(e => e.eventId === r.eventId);
          return (
            <Pressable
              key={r.eventId}
              onPress={() => ev && onOpenEvent(ev)}
              accessibilityRole="button"
              style={({ pressed }) => ({
                flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 11,
                borderTopWidth: i ? 1 : 0, borderTopColor: colors.border, opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ width: 28, fontSize: 14, color: colors.mutedForeground, fontFamily: fonts.display }}>{xs[i]}</Text>
              <Text style={{ flex: 1, fontSize: 14, color: colors.foreground, fontFamily: fonts.medium }} numberOfLines={1}>{r.eventName}</Text>
              {ev?.bestPosition != null && <PositionBadge position={ev.bestPosition} size="sm" />}
              <Text style={{ width: 52, textAlign: "right", fontSize: 13, color: colors.mutedForeground, fontFamily: fonts.medium }}>{r.points} pts</Text>
              <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
