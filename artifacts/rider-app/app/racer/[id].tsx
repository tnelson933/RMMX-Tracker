import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";
import { formatLap, type CareerStats } from "@/components/ShareCard";
import { NETWORK_ERROR_MESSAGE } from "@/lib/friendlyErrors";
import { parsePosition, podiumColor, podiumTextColor } from "@/components/RaceStats";
import { useTheme } from "@/context/ThemeContext";

interface Recent { eventId: number; eventName: string; eventDate: string; raceClass: string; bestPosition: number | null; motos: Array<{ motoName: string; position: number | null; dnf: boolean; dns: boolean }> }

/** Another rider's public profile: published results only. */
export default function RacerScreen() {
  const colors = useColors();
  const isDark = useTheme().resolvedScheme === "dark";
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { riderFetch } = useRiderAuth();
  const [data, setData] = useState<{ name: string; following: boolean; stats: CareerStats; recent: Recent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await riderFetch(`/api/rider/riders/${id}/public`);
      if (!r.ok) { setError(r.status === 404 ? "This rider has no published results yet." : `Couldn't load this rider (error ${r.status}).`); return; }
      setData(await r.json());
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    }
  }, [id, riderFetch]);
  useEffect(() => { void load(); }, [load]);

  const toggle = useCallback(async () => {
    if (!data) return;
    const follow = !data.following;
    setData({ ...data, following: follow });
    const rollback = () => setData(d => (d ? { ...d, following: !follow } : d));
    try {
      const r = await riderFetch(`/api/rider/follows/${id}`, { method: follow ? "POST" : "DELETE" });
      if (!r.ok) { rollback(); Alert.alert(follow ? "Couldn't follow" : "Couldn't unfollow", `Try again (error ${r.status}).`); }
    } catch {
      rollback();
      Alert.alert(follow ? "Couldn't follow" : "Couldn't unfollow", NETWORK_ERROR_MESSAGE);
    }
  }, [data, id, riderFetch]);

  const s = styles(colors, insets);
  const st = data?.stats;
  const tiles: Array<[string, string]> = st ? [
    ["Races", String(st.starts)], ["Wins", String(st.wins)], ["Podiums", String(st.podiums)],
    ["Avg finish", st.avgFinish != null ? `P${st.avgFinish}` : "—"], ["Laps led", String(st.lapsLed)],
    ["Best lap", st.bestLap ? formatLap(st.bestLap.ms) : "—"],
  ] : [];

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} style={({ pressed }) => [s.backBtn, { opacity: pressed ? 0.6 : 1 }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </Pressable>
        <Text style={s.headerTitle} numberOfLines={1}>{data?.name ?? "Rider"}</Text>
        {data && (
          <Pressable onPress={toggle} style={({ pressed }) => [s.followBtn, data.following ? s.followingBtn : null, { opacity: pressed ? 0.7 : 1 }]}>
            <Text style={[s.followText, data.following ? { color: colors.foreground } : null]}>{data.following ? "Following" : "Follow"}</Text>
          </Pressable>
        )}
      </View>
      {!data && !error ? (
        <View style={s.center}><ActivityIndicator color={colors.primary} /></View>
      ) : error ? (
        <View style={s.center}>
          <Text style={[s.muted, { textAlign: "center" }]}>{error}</Text>
          <Pressable onPress={() => { void load(); }} style={({ pressed }) => ({ marginTop: 12, opacity: pressed ? 0.6 : 1 })}>
            <Text style={{ color: colors.primary, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={s.content}>
          <View style={s.grid}>
            {tiles.map(([label, value]) => (
              <View key={label} style={[s.tile, podiumColor(parsePosition(value)) ? { borderColor: podiumColor(parsePosition(value))! } : null]}><View style={[s.tileStripe, { backgroundColor: podiumColor(parsePosition(value)) ?? colors.primary }]} /><Text style={[s.tileValue, podiumTextColor(parsePosition(value), isDark) ? { color: podiumTextColor(parsePosition(value), isDark)! } : null]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text><Text style={s.tileLabel}>{label}</Text></View>
            ))}
          </View>
          <Text style={s.section}>Recent results</Text>
          {data!.recent.map(r => (
            <Pressable key={`${r.eventId}-${r.raceClass}`} onPress={() => router.push(`/event/${r.eventId}` as any)}
              style={({ pressed }) => [s.resultRow, { opacity: pressed ? 0.7 : 1 }]}>
              <View style={{ flex: 1 }}>
                <Text style={s.resultTitle} numberOfLines={1}>{r.eventName}</Text>
                <Text style={s.muted} numberOfLines={1}>{r.raceClass} · {r.eventDate} · {r.motos.map(m => (m.dns ? "DNS" : m.dnf ? "DNF" : m.position ? `P${m.position}` : "—")).join(" / ")}</Text>
              </View>
              <Text style={s.pos}>{r.bestPosition ? `P${r.bestPosition}` : "—"}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = (colors: ReturnType<typeof useColors>, insets: { bottom: number }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: 12 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" },
  followBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: colors.primary, borderWidth: 1, borderColor: colors.primary },
  followingBtn: { backgroundColor: "transparent", borderColor: colors.border },
  followText: { color: "#fff", fontSize: 13, fontFamily: "Inter_700Bold" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  content: { padding: 16, paddingBottom: insets.bottom + 32, gap: 10 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: { width: "31.5%", backgroundColor: colors.card, borderRadius: 14, paddingVertical: 16, paddingHorizontal: 6, alignItems: "center", borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  tileStripe: { position: "absolute", top: 0, left: 12, right: 12, height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 },
  tileValue: { fontSize: 26, color: colors.foreground, fontFamily: "Inter_700Bold", fontStyle: "italic", letterSpacing: -0.5 },
  tileLabel: { fontSize: 11, color: colors.mutedForeground, marginTop: 2, fontFamily: "Inter_500Medium" },
  section: { fontSize: 13, letterSpacing: 1.5, textTransform: "uppercase", color: colors.mutedForeground, fontFamily: "Inter_700Bold", marginTop: 8 },
  muted: { fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" },
  resultRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.card, borderRadius: 12, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  resultTitle: { fontSize: 14, color: colors.foreground, fontFamily: "Inter_600SemiBold" },
  pos: { fontSize: 18, color: colors.foreground, fontFamily: "Inter_700Bold" },
});
