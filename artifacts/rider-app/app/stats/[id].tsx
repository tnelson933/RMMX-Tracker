import { Feather } from "@expo/vector-icons";
import { useBottomSpace } from "@/hooks/useBottomSpace";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BarList, ChartCard } from "@/components/charts";
import { StatsShareCard, formatLap, useShareCapture, type CareerStats } from "@/components/ShareCard";
import { fonts } from "@/constants/fonts";
import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";
import { finishSpread, lapsLedTakeaway, spreadTakeaway, startTakeaway } from "@/lib/career";
import { goBack } from "@/lib/navigation";
import { fmtLapShort } from "@/lib/raceReport";

/**
 * Career stats as pictures: how finishes split up, where the rider is after
 * lap 1 against where they finish, and laps led, each with a takeaway. Plus a
 * shareable stats card. Profile managers moved to the rider screen.
 */
export default function RiderStatsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { riderFetch } = useRiderAuth();
  const { ref: cardRef, share, sharing } = useShareCapture();
  const [name, setName] = useState("");
  const [stats, setStats] = useState<CareerStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const sr = await riderFetch(`/api/rider/profiles/${id}/stats`);
      if (!sr.ok) throw new Error(((await sr.json().catch(() => ({}))) as { error?: string }).error ?? `Error ${sr.status}`);
      const sj = await sr.json();
      setName(sj.name);
      setStats(sj.stats);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load stats.");
    }
  }, [id, riderFetch]);
  useEffect(() => { (async () => { setLoading(true); await load(); setLoading(false); })(); }, [load]);

  const bottomSpace = useBottomSpace();
  const s = styles(colors, { bottom: bottomSpace });
  const spread = stats ? finishSpread(stats) : [];
  const spreadTotal = spread.reduce((a, x) => a + x.count, 0);
  const segColor: Record<string, string> = {
    wins: colors.chartBest, podiums: colors.chartYou, top5: colors.chartTeammate, rest: colors.chartField, dnf: colors.destructive,
  };

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => goBack(router)} accessibilityRole="button" accessibilityLabel="Back"
          style={({ pressed }) => [s.backBtn, { opacity: pressed ? 0.6 : 1 }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.eyebrow}>Career stats</Text>
          <Text style={s.headerTitle} numberOfLines={1}>{name || "Rider"}</Text>
        </View>
        <Pressable onPress={() => router.push(`/racer/${id}` as any)} accessibilityRole="link"
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 2, opacity: pressed ? 0.6 : 1 })}>
          <Text style={{ fontSize: 14, color: colors.primaryText, fontFamily: fonts.semibold }}>Profile</Text>
          <Feather name="chevron-right" size={16} color={colors.primaryText} />
        </Pressable>
      </View>
      {loading ? (
        <View style={s.center}><ActivityIndicator color={colors.primaryText} /></View>
      ) : error ? (
        <View style={s.center}><Text style={s.muted}>{error}</Text></View>
      ) : !stats || stats.starts === 0 ? (
        <View style={s.center}><Text style={s.muted}>No races yet. Stats appear after your first timed moto.</Text></View>
      ) : (
        <ScrollView contentContainerStyle={s.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {[
              { v: String(stats.starts), l: "Motos" },
              { v: String(stats.totalLaps), l: "Laps" },
              { v: stats.avgFinish != null ? `P${stats.avgFinish.toFixed(1)}` : "—", l: "Avg finish" },
              { v: stats.bestLap ? fmtLapShort(stats.bestLap.ms) : "—", l: "Best lap" },
            ].map(t => (
              <View key={t.l} style={s.tile}>
                <Text style={s.tileValue} numberOfLines={1} adjustsFontSizeToFit>{t.v}</Text>
                <Text style={s.tileLabel}>{t.l}</Text>
              </View>
            ))}
          </View>

          <ChartCard title="How your motos finish" takeaway={spreadTakeaway(stats)}>
            {/* One bar split by result, with counts below. */}
            <View style={{ flexDirection: "row", height: 18, borderRadius: 4, overflow: "hidden", backgroundColor: colors.muted }}
              accessible accessibilityRole="image"
              accessibilityLabel={spread.map(x => `${x.label} ${x.count}`).join(", ")}>
              {spread.filter(x => x.count > 0).map(x => (
                <View key={x.key} style={{ flex: x.count, backgroundColor: segColor[x.key] }} />
              ))}
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
              {spread.map(x => (
                <View key={x.key} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: segColor[x.key] }} />
                  <Text style={{ fontSize: 12, color: colors.foreground, fontFamily: fonts.medium }}>
                    {x.label} <Text style={{ fontFamily: fonts.bold }}>{x.count}</Text>
                  </Text>
                </View>
              ))}
            </View>
            {spreadTotal === 0 ? <Text style={s.muted}>No finishes yet.</Text> : null}
          </ChartCard>

          {stats.avgLap1Position != null && stats.avgFinish != null && (
            <ChartCard title="After lap 1 vs the finish" takeaway={startTakeaway(stats)}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-around" }}
                accessible accessibilityLabel={`Average position after lap 1 P${stats.avgLap1Position}, average finish P${stats.avgFinish}.`}>
                <View style={{ alignItems: "center" }}>
                  <Text style={s.big}>P{stats.avgLap1Position.toFixed(1)}</Text>
                  <Text style={s.tileLabel}>After lap 1</Text>
                </View>
                <Feather name="arrow-right" size={22} color={colors.mutedForeground} />
                <View style={{ alignItems: "center" }}>
                  <Text style={s.big}>P{stats.avgFinish.toFixed(1)}</Text>
                  <Text style={s.tileLabel}>Finish</Text>
                </View>
              </View>
            </ChartCard>
          )}

          <ChartCard title="Laps led" takeaway={lapsLedTakeaway(stats)}>
            {/* Each bar is a share of its own total: laps for laps led, motos for lap-1 leads. */}
            <BarList
              max={100}
              rows={[
                { key: "led", label: "Laps led", value: (stats.lapsLed / Math.max(1, stats.totalLaps)) * 100, valueLabel: `${stats.lapsLed}/${stats.totalLaps}`, color: colors.chartBest },
                { key: "lap1", label: "Led lap 1", value: (stats.lap1Leads / Math.max(1, stats.starts)) * 100, valueLabel: `${stats.lap1Leads}/${stats.starts}`, color: colors.chartYou },
              ]}
              accessibilityLabel={`Led ${stats.lapsLed} of ${stats.totalLaps} laps. Led lap 1 in ${stats.lap1Leads} of ${stats.starts} motos.`}
            />
          </ChartCard>

          <Text style={s.note}>From lap-by-lap timing, so laps led and lap-1 positions only count races with recorded laps.</Text>

          <Text style={s.section}>Share</Text>
          <View style={{ alignItems: "center" }}>
            <StatsShareCard name={name} stats={stats} cardRef={cardRef} />
          </View>
          <Pressable onPress={() => share(`${name}'s RM Roost stats`)} disabled={sharing} accessibilityRole="button"
            style={({ pressed }) => [s.primaryBtn, { opacity: pressed || sharing ? 0.7 : 1 }]}>
            {sharing ? <ActivityIndicator color="#fff" /> : <Feather name="share" size={16} color="#fff" />}
            <Text style={s.primaryBtnText}>Share stats</Text>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

const styles = (colors: ReturnType<typeof useColors>, insets: { bottom: number }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: 12 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" },
  eyebrow: { fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1.2 },
  headerTitle: { fontSize: 22, color: colors.foreground, fontFamily: fonts.displayItalic, textTransform: "uppercase" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  content: { padding: 16, paddingBottom: insets.bottom, gap: 12 },
  section: { fontSize: 14, letterSpacing: 1.5, textTransform: "uppercase", color: colors.mutedForeground, fontFamily: fonts.display, marginTop: 8 },
  muted: { fontSize: 13, color: colors.mutedForeground, fontFamily: fonts.regular, lineHeight: 18, textAlign: "center" },
  note: { fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.regular, lineHeight: 15 },
  tile: { flex: 1, backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, paddingVertical: 10, paddingHorizontal: 4, alignItems: "center" },
  tileValue: { fontSize: 22, color: colors.foreground, fontFamily: fonts.displayItalic },
  tileLabel: { fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1, marginTop: 2 },
  big: { fontSize: 32, color: colors.foreground, fontFamily: fonts.displayItalic },
  primaryBtn: { flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary, borderRadius: 999, paddingVertical: 14 },
  primaryBtnText: { color: "#fff", fontSize: 16, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1 },
});
