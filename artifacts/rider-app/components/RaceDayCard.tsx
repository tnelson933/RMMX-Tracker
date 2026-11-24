/**
 * Race-day mode: while one of the account's events is racing, the top of Home
 * becomes a high-contrast card readable in sun and with gloves on: the race
 * running now with your live position, or your next race, gate and how many
 * races are before it. Built from the rider schedule Home already polls.
 */
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming, ReduceMotion } from "react-native-reanimated";

import { PressableScale } from "@/components/PressableScale";
import { TopoTexture } from "@/components/StockBackdrop";
import { fonts } from "@/constants/fonts";
import { useRiderAuth } from "@/context/AuthContext";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { aheadLabel, gateLabel, raceDayState, type RaceDayMoto } from "@/lib/raceDay";

const BG = "#161616";
const GREEN = "#22c55e";

interface LeaderRow { riderId: number | null; position: number | null; laps: number; riderName: string; isFamilyMember?: boolean; dnf?: boolean | null }

function motoTitle(m: RaceDayMoto): string {
  return m.raceClass && !m.name.includes(m.raceClass) ? `${m.name} · ${m.raceClass}` : m.name;
}

function LiveDot() {
  const o = useSharedValue(1);
  useEffect(() => {
    o.value = withRepeat(withTiming(0.25, { duration: 800, reduceMotion: ReduceMotion.System }), -1, true);
  }, [o]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[{ width: 10, height: 10, borderRadius: 5, backgroundColor: GREEN }, style]} />;
}

/** Your position in the race running now, refreshed every 5 seconds. */
function useLivePosition(motoId: number | null, riderIds: number[]) {
  const { riderFetch } = useRiderAuth();
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  useEffect(() => { setRows(null); }, [motoId]);
  const load = useCallback(async () => {
    if (motoId == null) return;
    try {
      const r = await riderFetch(`/api/rider/motos/${motoId}/detail`);
      if (r.ok) setRows(((await r.json()).leaderboard ?? []) as LeaderRow[]);
    } catch { /* offline: keep the last one */ }
  }, [motoId, riderFetch]);
  useEffect(() => { void load(); }, [load]);
  useVisibleInterval(load, 5_000, motoId != null);
  return rows?.filter(r => r.riderId != null && riderIds.includes(r.riderId)) ?? null;
}

export function RaceDayCard({ eventId, eventName, motos, multiRider }: {
  eventId: number; eventName: string; motos: RaceDayMoto[]; multiRider: boolean;
}) {
  const router = useRouter();
  const s = raceDayState(motos);
  const mine = useLivePosition(s.racing?.motoId ?? null, s.racing?.familyGates.map(g => g.riderId) ?? []);
  if (s.total === 0) return null;

  const openLive = () => router.push(`/live/${eventId}` as any);
  let kicker: string;
  let title: string;
  let big: string | null = null;
  let detail: string | null = null;

  if (s.racing) {
    kicker = "On track now";
    title = motoTitle(s.racing);
    const me = mine?.[0];
    big = me?.position ? `P${me.position}` : "Racing";
    detail = !mine || mine.length === 0 ? "Waiting for the first lap"
      : mine.length === 1
        ? (me!.dnf ? "DNF" : me!.laps > 0 ? `Lap ${me!.laps}` : "Waiting for the first lap")
        : mine.map(r => `${r.riderName.split(" ")[0]} ${r.dnf ? "DNF" : `P${r.position ?? "–"}${r.laps > 0 ? ` · Lap ${r.laps}` : ""}`}`).join("   ");
  } else if (s.next) {
    kicker = aheadLabel(s.racesAhead) ?? "Up next";
    title = motoTitle(s.next);
    big = gateLabel(s.next, multiRider);
    detail = s.onTrack ? `On track: ${motoTitle(s.onTrack)}` : null;
  } else {
    kicker = "All your races are done";
    title = eventName;
    detail = "Results are in on the live timing screen.";
  }

  return (
    <View style={{ marginHorizontal: 16, marginBottom: 16, borderRadius: 20, backgroundColor: BG, borderWidth: 2, borderColor: s.racing ? GREEN : "#333", overflow: "hidden" }}
      accessible accessibilityLabel={`Race day at ${eventName}. ${kicker}. ${title}. ${big ?? ""}. ${detail ?? ""}`}>
      <TopoTexture opacity={0.55} />
      <View style={{ height: 4, backgroundColor: s.racing ? GREEN : "#B30000" }} />
      <View style={{ padding: 18, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {s.racing || s.onTrack ? <LiveDot /> : <Feather name="flag" size={14} color="#FFFFFF" />}
          <Text style={st.eyebrow} numberOfLines={1}>Race day  ·  {eventName}</Text>
        </View>
        <Text style={[st.kicker, s.racing && { color: GREEN }]}>{kicker}</Text>
        <Text style={st.title} numberOfLines={2}>{title}</Text>
        {big && <Text style={st.big} adjustsFontSizeToFit numberOfLines={1}>{big}</Text>}
        {detail && <Text style={st.detail} numberOfLines={2}>{detail}</Text>}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
          {Array.from({ length: s.total }, (_, i) => (
            <View key={i} style={{ flex: 1, maxWidth: 40, height: 6, borderRadius: 3, backgroundColor: i < s.done ? "#FFFFFF" : "#3a3a3a" }} />
          ))}
          <Text style={st.progress}>{s.done} of {s.total} done</Text>
        </View>
        <PressableScale onPress={openLive} accessibilityRole="button" accessibilityLabel="Open live timing"
          style={{ marginTop: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 999, backgroundColor: "#B30000" }}>
          <Feather name="activity" size={18} color="#FFFFFF" />
          <Text style={st.button}>Live timing</Text>
        </PressableScale>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  eyebrow: { flex: 1, fontSize: 13, color: "#E6E6E6", fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1.2 },
  kicker: { fontSize: 16, color: "#FFFFFF", fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1, marginTop: 4 },
  title: { fontSize: 26, lineHeight: 28, color: "#FFFFFF", fontFamily: fonts.displayItalic, textTransform: "uppercase" },
  big: { fontSize: 56, lineHeight: 60, color: "#FFFFFF", fontFamily: fonts.displayItalic, textTransform: "uppercase" },
  detail: { fontSize: 16, color: "#E6E6E6", fontFamily: fonts.medium },
  progress: { marginLeft: 6, fontSize: 13, color: "#E6E6E6", fontFamily: fonts.medium },
  button: { fontSize: 16, color: "#FFFFFF", fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1 },
});
