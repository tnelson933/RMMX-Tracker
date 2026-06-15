import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";
import { BrandBar } from "@/components/BrandBar";

function fmtLap(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "—";
  const totalSec = ms / 1000;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0
    ? `${mins}:${secs.toFixed(3).padStart(6, "0")}`
    : `${secs.toFixed(3)}s`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
}

interface PracticeLap {
  lapNumber: number;
  lapTimeMs: number | null;
  crossingTime: string;
}

interface PracticeSession {
  sessionId: number;
  sessionName: string;
  startedAt: string | null;
  endedAt: string | null;
  lapCount: number;
  bestLapMs: number | null;
  laps: PracticeLap[];
}

const ACCENT = "#f59e0b";

function PracticeCard({ session, colors }: { session: PracticeSession; colors: ReturnType<typeof useColors> }) {
  const validLaps = session.laps.filter(l => (l.lapTimeMs ?? 0) > 0);
  const bestMs = session.bestLapMs ?? (validLaps.length ? Math.min(...validLaps.map(l => l.lapTimeMs!)) : null);

  return (
    <View style={{
      marginHorizontal: 16, marginBottom: 12,
      borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border, backgroundColor: colors.card, overflow: "hidden",
    }}>
      <View style={{
        flexDirection: "row", alignItems: "center", justifyContent: "space-between",
        padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
        backgroundColor: ACCENT + "0a",
      }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
            {session.sessionName}
          </Text>
          {session.startedAt && (
            <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
              {fmtDate(session.startedAt)}
            </Text>
          )}
        </View>
        <View style={{ alignItems: "flex-end", gap: 2 }}>
          <Text style={{ fontSize: 22, fontWeight: "800", color: ACCENT, fontFamily: "Inter_700Bold" }}>
            {fmtLap(bestMs)}
          </Text>
          <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.5 }}>
            Best Lap
          </Text>
        </View>
      </View>

      <View style={{ paddingVertical: 4 }}>
        {validLaps.slice(0, 8).map((lap, i, arr) => {
          const isBest = lap.lapTimeMs === bestMs;
          return (
            <View key={i} style={{
              flexDirection: "row", alignItems: "center",
              paddingHorizontal: 14, paddingVertical: 9,
              borderBottomWidth: i < arr.length - 1 ? StyleSheet.hairlineWidth : 0,
              borderBottomColor: colors.border,
              backgroundColor: isBest ? ACCENT + "0d" : "transparent",
            }}>
              <Text style={{ width: 32, fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>
                L{lap.lapNumber}
              </Text>
              <Text style={{ flex: 1, fontSize: 14, color: isBest ? ACCENT : colors.foreground, fontFamily: isBest ? "Inter_700Bold" : "Inter_500Medium" }}>
                {fmtLap(lap.lapTimeMs)}
              </Text>
              {isBest && (
                <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5, backgroundColor: ACCENT + "22" }}>
                  <Text style={{ fontSize: 10, fontWeight: "700", color: ACCENT, fontFamily: "Inter_700Bold" }}>BEST</Text>
                </View>
              )}
            </View>
          );
        })}
      </View>

      {session.lapCount > 8 && (
        <View style={{ paddingVertical: 10, alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
            +{session.lapCount - 8} more laps
          </Text>
        </View>
      )}
    </View>
  );
}

export default function TrainScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading, profiles, riderFetch } = useRiderAuth();

  const [sessions, setSessions] = useState<PracticeSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const primaryProfile = profiles[0] ?? null;

  const loadData = useCallback(async () => {
    if (!primaryProfile) return;
    setError(null);
    setLoading(true);
    try {
      const res = await riderFetch(`/api/rider/profiles/${primaryProfile.id}/practice`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions ?? []);
      }
    } catch {
      setError("Couldn't load practice data. Pull to refresh.");
    } finally {
      setLoading(false);
    }
  }, [primaryProfile?.id, riderFetch]);

  useEffect(() => {
    if (isAuthenticated && primaryProfile) void loadData();
  }, [isAuthenticated, primaryProfile?.id]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      paddingTop: insets.top + 16, paddingHorizontal: 20, paddingBottom: 16,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    headerTitle: { fontSize: 26, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", letterSpacing: -0.5 },
    headerSub: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 },
    statsRow: { flexDirection: "row", gap: 10, marginTop: 14 },
    statBox: { flex: 1, backgroundColor: colors.muted, borderRadius: 10, padding: 12, alignItems: "center" },
    statValue: { fontSize: 20, fontWeight: "700", color: ACCENT, fontFamily: "Inter_700Bold" },
    statLabel: { fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_500Medium", marginTop: 2, textTransform: "uppercase", letterSpacing: 0.5 },
    footer: { height: insets.bottom + 32 },
  });

  if (authLoading) {
    return (
      <View style={[styles.container, { flex: 1, alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={ACCENT} />
      </View>
    );
  }

  if (!isAuthenticated) {
    return (
      <View style={[styles.container, { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }]}>
        <Feather name="activity" size={48} color={colors.mutedForeground} />
        <Text style={{ fontSize: 18, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>Your training lives here</Text>
        <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>
          Sign in to see your practice sessions and lap times.
        </Text>
        <Pressable
          style={{ marginTop: 12, backgroundColor: ACCENT, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 10 }}
          onPress={() => router.push("/(tabs)/profile")}
        >
          <Text style={{ color: "#fff", fontSize: 15, fontWeight: "700", fontFamily: "Inter_700Bold" }}>Sign In</Text>
        </Pressable>
      </View>
    );
  }

  if (!primaryProfile) {
    return (
      <View style={[styles.container, { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }]}>
        <Feather name="user-x" size={40} color={colors.mutedForeground} />
        <Text style={{ fontSize: 18, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>No rider profile linked</Text>
        <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>
          Register for an event using this email to link your rider profile.
        </Text>
      </View>
    );
  }

  const totalLaps = sessions.reduce((sum, s) => sum + s.lapCount, 0);
  const allBestLaps = sessions.map(s => s.bestLapMs).filter((ms): ms is number => ms != null && ms > 0);
  const overallBest = allBestLaps.length ? Math.min(...allBestLaps) : null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <BrandBar />
        <Text style={styles.headerTitle}>Train</Text>
        <Text style={styles.headerSub}>Practice sessions & lap times</Text>
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{sessions.length}</Text>
            <Text style={styles.statLabel}>Sessions</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{totalLaps}</Text>
            <Text style={styles.statLabel}>Total Laps</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{fmtLap(overallBest)}</Text>
            <Text style={styles.statLabel}>Best Ever</Text>
          </View>
        </View>
      </View>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
      >
        <View style={{ paddingTop: 16 }}>
          {loading && !refreshing ? (
            <View style={{ marginTop: 60, alignItems: "center" }}>
              <ActivityIndicator color={ACCENT} />
            </View>
          ) : error ? (
            <View style={{ padding: 32, alignItems: "center", gap: 8 }}>
              <Feather name="alert-circle" size={32} color={colors.mutedForeground} />
              <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>{error}</Text>
            </View>
          ) : sessions.length === 0 ? (
            <View style={{ padding: 40, alignItems: "center", gap: 10 }}>
              <Feather name="activity" size={40} color={colors.mutedForeground} />
              <Text style={{ fontSize: 17, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>No practice sessions yet</Text>
              <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>
                Practice session lap times will appear here once recorded at an event.
              </Text>
            </View>
          ) : (
            sessions.map(s => <PracticeCard key={s.sessionId} session={s} colors={colors} />)
          )}
        </View>
        <View style={styles.footer} />
      </ScrollView>
    </View>
  );
}
