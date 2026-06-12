import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";

interface MotoResult {
  motoId: number;
  motoName: string;
  position: number | null;
  points: number | null;
  dnf: boolean;
  dns: boolean;
  totalTime: string | null;
  raceClass: string;
}

interface EventHistory {
  eventId: number;
  eventName: string;
  eventDate: string;
  eventState: string;
  eventLocation: string | null;
  raceClass: string;
  motos: MotoResult[];
  bestPosition: number | null;
  totalPoints: number;
}

export default function MyRacesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading, profiles, riderFetch } = useRiderAuth();

  const [history, setHistory] = useState<EventHistory[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const primaryProfile = profiles[0] ?? null;

  const loadHistory = useCallback(async () => {
    if (!primaryProfile) return;
    setLoading(true);
    setError(null);
    try {
      const res = await riderFetch(`/api/rider/profiles/${primaryProfile.id}/history`);
      if (!res.ok) throw new Error("Failed to load history");
      const data: EventHistory[] = await res.json();
      setHistory(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [primaryProfile, riderFetch]);

  useEffect(() => {
    if (isAuthenticated && primaryProfile) void loadHistory();
  }, [isAuthenticated, primaryProfile?.id]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadHistory();
    setRefreshing(false);
  }, [loadHistory]);

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      paddingTop: insets.top + 16,
      paddingHorizontal: 20,
      paddingBottom: 16,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    headerTitle: {
      fontSize: 26,
      fontWeight: "800",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
      letterSpacing: -0.5,
    },
    statsRow: {
      flexDirection: "row",
      gap: 12,
      marginTop: 12,
    },
    statBox: {
      flex: 1,
      backgroundColor: colors.muted,
      borderRadius: 10,
      padding: 12,
      alignItems: "center",
    },
    statValue: {
      fontSize: 22,
      fontWeight: "700",
      color: colors.primary,
      fontFamily: "Inter_700Bold",
    },
    statLabel: {
      fontSize: 11,
      color: colors.mutedForeground,
      fontFamily: "Inter_500Medium",
      marginTop: 2,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    eventCard: {
      marginHorizontal: 16,
      marginTop: 12,
      backgroundColor: colors.card,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: "hidden",
    },
    eventHeader: {
      padding: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    eventName: {
      fontSize: 15,
      fontWeight: "700",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
    },
    eventMeta: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 2,
    },
    motoRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    motoName: {
      flex: 1,
      fontSize: 13,
      color: colors.foreground,
      fontFamily: "Inter_500Medium",
    },
    positionBadge: {
      paddingHorizontal: 10,
      paddingVertical: 3,
      borderRadius: 20,
      backgroundColor: colors.primary,
    },
    positionText: {
      fontSize: 12,
      fontWeight: "700",
      color: "#fff",
      fontFamily: "Inter_700Bold",
    },
    dnfBadge: {
      paddingHorizontal: 10,
      paddingVertical: 3,
      borderRadius: 20,
      backgroundColor: colors.muted,
    },
    dnfText: {
      fontSize: 12,
      fontWeight: "600",
      color: colors.mutedForeground,
      fontFamily: "Inter_600SemiBold",
    },
    pointsText: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_500Medium",
      marginRight: 8,
    },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 32,
    },
    emptyTitle: {
      fontSize: 18,
      fontWeight: "700",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
      marginTop: 12,
      textAlign: "center",
    },
    emptyText: {
      fontSize: 14,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 6,
      textAlign: "center",
      lineHeight: 20,
    },
    signInBtn: {
      marginTop: 20,
      backgroundColor: colors.primary,
      paddingHorizontal: 28,
      paddingVertical: 12,
      borderRadius: 10,
    },
    signInBtnText: {
      color: "#fff",
      fontSize: 15,
      fontWeight: "700",
      fontFamily: "Inter_700Bold",
    },
    listFooter: { height: insets.bottom + 16 },
  });

  if (authLoading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!isAuthenticated) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Feather name="award" size={48} color={colors.mutedForeground} />
        <Text style={styles.emptyTitle}>Your race history lives here</Text>
        <Text style={styles.emptyText}>
          Sign in to see your results, points, and lap times from every race.
        </Text>
        <Pressable style={styles.signInBtn} onPress={() => router.push("/(tabs)/profile")}>
          <Text style={styles.signInBtnText}>Sign In</Text>
        </Pressable>
      </View>
    );
  }

  if (!primaryProfile) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Feather name="user-x" size={40} color={colors.mutedForeground} />
        <Text style={styles.emptyTitle}>No rider profile linked</Text>
        <Text style={styles.emptyText}>
          Register for an event using this email address to link your rider profile.
        </Text>
      </View>
    );
  }

  const renderEventCard = ({ item }: { item: EventHistory }) => (
    <View style={styles.eventCard}>
      <View style={styles.eventHeader}>
        <Text style={styles.eventName}>{item.eventName}</Text>
        <Text style={styles.eventMeta}>
          {new Date(item.eventDate).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}{" "}
          · {item.eventLocation ?? item.eventState} · {item.raceClass}
        </Text>
      </View>
      {item.motos.map((moto) => (
        <View key={moto.motoId} style={styles.motoRow}>
          <Text style={styles.motoName}>{moto.motoName}</Text>
          {moto.points != null && moto.points > 0 && (
            <Text style={styles.pointsText}>{moto.points}pts</Text>
          )}
          {moto.dnf || moto.dns ? (
            <View style={styles.dnfBadge}>
              <Text style={styles.dnfText}>{moto.dnf ? "DNF" : "DNS"}</Text>
            </View>
          ) : moto.position != null ? (
            <View style={styles.positionBadge}>
              <Text style={styles.positionText}>P{moto.position}</Text>
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );

  const ListHeader = () => (
    <View style={styles.header}>
      <Text style={styles.headerTitle}>My Races</Text>
      {primaryProfile && (
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{primaryProfile.eventsRaced}</Text>
            <Text style={styles.statLabel}>Events</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{primaryProfile.totalPoints}</Text>
            <Text style={styles.statLabel}>Points</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>
              {primaryProfile.bestPosition != null ? `P${primaryProfile.bestPosition}` : "—"}
            </Text>
            <Text style={styles.statLabel}>Best</Text>
          </View>
        </View>
      )}
    </View>
  );

  return (
    <FlatList
      style={styles.container}
      data={history}
      keyExtractor={(item) => String(item.eventId)}
      renderItem={renderEventCard}
      ListHeaderComponent={ListHeader}
      ListFooterComponent={<View style={styles.listFooter} />}
      contentContainerStyle={history.length === 0 ? { flexGrow: 1 } : undefined}
      scrollEnabled={history.length > 0}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.primary}
        />
      }
      ListEmptyComponent={
        loading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : error ? (
          <View style={styles.centered}>
            <Feather name="alert-circle" size={32} color={colors.mutedForeground} />
            <Text style={styles.emptyTitle}>Couldn't load history</Text>
            <Text style={styles.emptyText}>{error}</Text>
          </View>
        ) : (
          <View style={styles.centered}>
            <Feather name="flag" size={40} color={colors.mutedForeground} />
            <Text style={styles.emptyTitle}>No races yet</Text>
            <Text style={styles.emptyText}>
              Your results will appear here after your first race.
            </Text>
          </View>
        )
      }
    />
  );
}
