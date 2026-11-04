/**
 * Home screen cards: the next race as a photo hero with a countdown, recent
 * form as finishing badges, one trend chart with a takeaway, and a one-row
 * way into Rocky.
 */
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import { ChartCard, LineChart } from "@/components/charts";
import { eventImageUri } from "@/components/RaceReport";
import type { EventHistory } from "@/components/RaceSubScreens";
import { PositionBadge } from "@/components/RaceStats";
import { RockyAvatar } from "@/components/RockyAvatar";
import { PhotoFade, StockBackdrop } from "@/components/StockBackdrop";
import { fonts } from "@/constants/fonts";
import { useColors } from "@/hooks/useColors";
import { displayDate, placeLabel } from "@/lib/format";
import { countdownLabel } from "@/lib/home";
import { finishTakeaway, paceTakeaway, recentRounds } from "@/lib/season";

export interface NextRace {
  eventId: number;
  eventName: string;
  eventDate: string | null;
  eventEndDate?: string | null;
  eventState: string | null;
  eventLocation: string | null;
  eventImageUrl?: string | null;
  status: string;
  classes: string[];
}

/** Next race as a photo card; with no race booked, a prompt to find one. */
export function NextRaceHero({
  race, todayYmd, onOpen, onFind,
}: { race: NextRace | null; todayYmd: string; onOpen: () => void; onFind: () => void }) {
  const uri = eventImageUri(race?.eventImageUrl);
  const [photoFailed, setPhotoFailed] = useState(false);
  const label = race ? countdownLabel(race, todayYmd) : null;
  const live = label === "Racing today";
  const date = race?.eventDate
    ? displayDate(race.eventDate).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    : null;
  const place = race ? placeLabel(race.eventLocation, race.eventState) : null;
  return (
    <Pressable
      onPress={race ? onOpen : onFind}
      accessibilityRole="button"
      accessibilityLabel={race ? `Next race: ${race.eventName}, ${label}. Open details.` : "No race booked. Find a race."}
      style={({ pressed }) => ({ marginHorizontal: 16, borderRadius: 20, overflow: "hidden", minHeight: 210, justifyContent: "flex-end", backgroundColor: "#161616", opacity: pressed ? 0.92 : 1 })}
    >
      {uri && !photoFailed
        ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setPhotoFailed(true)} accessibilityIgnoresInvertColors />
        : <StockBackdrop />}
      <PhotoFade from={0.15} strength={0.92} />
      <View style={{ padding: 16, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {live && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#22c55e" }} />}
          <Text style={hs.eyebrow}>{race ? `Next gate drop  ·  ${label}` : "No race booked"}</Text>
        </View>
        <Text style={hs.title} numberOfLines={2}>{race ? race.eventName : "Find your next race"}</Text>
        {race ? (
          <Text style={hs.meta} numberOfLines={1}>{[date, place].filter(Boolean).join("  ·  ")}</Text>
        ) : (
          <Text style={hs.meta}>Open races near you are one tap away.</Text>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 8 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, flex: 1 }}>
            {(race?.classes ?? []).slice(0, 3).map(c => (
              <View key={c} style={{ borderWidth: 1, borderColor: "rgba(255,255,255,0.5)", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}>
                <Text style={{ fontSize: 12, color: "#FFFFFF", fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 0.8 }}>{c}</Text>
              </View>
            ))}
          </View>
          <View style={{ backgroundColor: "#B30000", borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8 }}>
            <Text style={{ fontSize: 14, color: "#FFFFFF", fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1 }}>
              {race ? (live ? "Race day" : "Details") : "Find a race"}
            </Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const hs = StyleSheet.create({
  eyebrow: { fontSize: 13, color: "#E6E6E6", fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1.2 },
  title: { fontSize: 30, lineHeight: 32, color: "#FFFFFF", fontFamily: fonts.displayItalic, textTransform: "uppercase" },
  meta: { fontSize: 14, color: "#E6E6E6", fontFamily: fonts.medium },
});

/** The last few finishes as podium-coloured badges, oldest on the left. */
export function FormStrip({ history, onOpen }: { history: EventHistory[]; onOpen: (ev: EventHistory) => void }) {
  const colors = useColors();
  const recent = [...history].sort((a, b) => a.eventDate.localeCompare(b.eventDate)).slice(-5);
  if (recent.length === 0) return null;
  return (
    <View style={{ marginHorizontal: 16, backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 12, gap: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1.2 }}>Recent form</Text>
        <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.medium }}>Latest on the right</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {recent.map(ev => {
          const finished = ev.motos.some(m => !m.dnf && !m.dns);
          return (
            <Pressable
              key={`${ev.eventId}-${ev.raceClass}-${ev.riderName ?? ""}`}
              onPress={() => onOpen(ev)}
              accessibilityRole="button"
              accessibilityLabel={`${ev.eventName}: ${ev.bestPosition != null ? `best finish P${ev.bestPosition}` : "no finish"}. Open the Race Report.`}
              style={({ pressed }) => ({ flex: 1, alignItems: "center", gap: 4, opacity: pressed ? 0.7 : 1 })}
            >
              {ev.bestPosition != null
                ? <PositionBadge position={ev.bestPosition} size="sm" />
                : <PositionBadge position={null} dnf={!finished} dns={false} size="sm" />}
              <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.medium }} numberOfLines={1}>
                {displayDate(ev.eventDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** One trend from the last five races: % off the winner's pace, or finishes if pace isn't available. */
export function FormTrendCard({ history }: { history: EventHistory[] }) {
  const colors = useColors();
  const rounds = recentRounds(history, 5);
  const xs = rounds.map(r => displayDate(r.eventDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  const pace = rounds.map(r => (r.pacePct == null ? null : Math.max(0, r.pacePct)));
  const paceVals = pace.filter((v): v is number => v != null);
  const scope = `in your last ${rounds.length} races`;

  if (paceVals.length >= 2) {
    const last = paceVals[paceVals.length - 1];
    const max = Math.max(1, ...paceVals) * 1.2;
    return (
      <View style={{ marginHorizontal: 16 }}>
        <ChartCard
          title="Pace vs the winner"
          right={<Text style={{ fontSize: 24, color: colors.foreground, fontFamily: fonts.displayItalic }}>{last.toFixed(1)}%</Text>}
          takeaway={paceTakeaway(rounds, scope)}
        >
          <LineChart
            xLabels={xs} padLeft={14} height={80}
            series={[{ data: pace, color: colors.chartYou, area: colors.chartArea, dots: true }]}
            yMin={0} yMax={max} yTicks={[]} yFormat={String}
            marks={[{ index: pace.lastIndexOf(last), value: last, color: colors.chartBest }]}
            accessibilityLabel={`Percent off the winner's pace in your last races: ${paceVals.map(v => `${v.toFixed(1)}%`).join(", ")}.`}
          />
        </ChartCard>
      </View>
    );
  }

  const fin = rounds.map(r => r.avgFinish);
  const finVals = fin.filter((v): v is number => v != null);
  if (finVals.length < 2) return null;
  const worst = Math.max(...finVals);
  return (
    <View style={{ marginHorizontal: 16 }}>
      <ChartCard title="Average moto finish" takeaway={finishTakeaway(rounds)}>
        <LineChart
          xLabels={xs} padLeft={14} height={80}
          series={[{ data: fin, color: colors.chartYou, dots: true }]}
          yMin={0.5} yMax={Math.max(worst + 0.5, 3.5)} invert band={[0.5, 3.5]} yTicks={[]} yFormat={String}
          accessibilityLabel={`Average moto finish in your last races: ${finVals.map(v => `P${Math.round(v)}`).join(", ")}.`}
        />
      </ChartCard>
    </View>
  );
}

/** Rocky in one row (he also floats on every screen). */
export function RockyRow() {
  const colors = useColors();
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push("/mechanic" as any)}
      accessibilityRole="button"
      accessibilityLabel="Ask Rocky, your AI mechanic and riding coach"
      style={({ pressed }) => ({
        marginHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 12, padding: 12,
        backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, opacity: pressed ? 0.8 : 1,
      })}
    >
      <RockyAvatar size={34} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 16, color: colors.foreground, fontFamily: fonts.displayItalic, textTransform: "uppercase" }}>Ask Rocky</Text>
        <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.regular }}>Setup, maintenance and riding tips</Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}
