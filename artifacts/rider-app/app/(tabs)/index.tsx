import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
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

import { BrandBar } from "@/components/BrandBar";
import { useColors } from "@/hooks/useColors";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN ?? ""}`;

interface Event {
  id: number;
  name: string;
  date: string;
  location: string | null;
  state: string | null;
  status: string;
  clubId: number;
  entryFee: string | null;
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  registration_open: { label: "Open", color: "#22c55e" },
  race_day: { label: "Live Now", color: "#ef4444" },
  draft: { label: "Draft", color: "#9ca3af" },
  completed: { label: "Completed", color: "#9ca3af" },
};

async function fetchEvents(): Promise<Event[]> {
  const res = await fetch(`${BASE_URL}/api/events`);
  if (!res.ok) throw new Error("Failed to fetch events");
  const all: Event[] = await res.json();
  return all
    .filter((e) => e.status === "registration_open" || e.status === "race_day")
    .sort((a, b) => {
      // race_day events first, then by date
      if (a.status === "race_day" && b.status !== "race_day") return -1;
      if (b.status === "race_day" && a.status !== "race_day") return 1;
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    });
}

function EventCard({
  event,
  colors,
  onPress,
}: {
  event: Event;
  colors: ReturnType<typeof useColors>;
  onPress: () => void;
}) {
  const statusInfo = STATUS_LABEL[event.status] ?? { label: event.status, color: "#9ca3af" };
  const isLive = event.status === "race_day";
  const dateStr = new Date(event.date).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const s = StyleSheet.create({
    card: {
      backgroundColor: colors.card,
      borderRadius: 12,
      borderWidth: isLive ? 1.5 : StyleSheet.hairlineWidth,
      borderColor: isLive ? "#ef4444" : colors.border,
      padding: 16,
      marginHorizontal: 16,
      marginBottom: 10,
    },
    topRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 8,
    },
    name: {
      flex: 1,
      fontSize: 16,
      fontWeight: "700",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
      lineHeight: 22,
    },
    badge: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 20,
      backgroundColor: statusInfo.color + "22",
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    badgeText: {
      fontSize: 11,
      fontWeight: "700",
      color: statusInfo.color,
      fontFamily: "Inter_600SemiBold",
    },
    liveDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: "#ef4444",
    },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: 8,
    },
    metaText: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
    },
    feeTag: {
      marginTop: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    feeText: {
      fontSize: 14,
      fontWeight: "600",
      color: colors.primary,
      fontFamily: "Inter_600SemiBold",
    },
    chevron: {
      position: "absolute",
      right: 0,
      top: 0,
    },
  });

  return (
    <Pressable
      style={({ pressed }) => [s.card, pressed && { opacity: 0.75 }]}
      onPress={onPress}
    >
      <View style={s.topRow}>
        <Text style={s.name}>{event.name}</Text>
        <View style={s.badge}>
          {isLive && <View style={s.liveDot} />}
          <Text style={s.badgeText}>{statusInfo.label}</Text>
        </View>
      </View>
      <View style={s.metaRow}>
        <Feather name="calendar" size={13} color={colors.mutedForeground} />
        <Text style={s.metaText}>{dateStr}</Text>
      </View>
      {(event.location || event.state) && (
        <View style={s.metaRow}>
          <Feather name="map-pin" size={13} color={colors.mutedForeground} />
          <Text style={s.metaText}>
            {[event.location, event.state].filter(Boolean).join(", ")}
          </Text>
        </View>
      )}
      {event.entryFee && (
        <View style={s.feeTag}>
          <Feather name="tag" size={13} color={colors.primary} />
          <Text style={s.feeText}>${event.entryFee} entry</Text>
        </View>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", marginTop: 10, gap: 4 }}>
        <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
          {isLive ? "View live schedule" : "View details"}
        </Text>
        <Feather name="chevron-right" size={14} color={colors.mutedForeground} />
      </View>
    </Pressable>
  );
}

export default function EventsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  const { data: events, isLoading, error, refetch } = useQuery<Event[], Error>({
    queryKey: ["mobile-events"],
    queryFn: fetchEvents,
    staleTime: 30_000,
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      paddingTop: insets.top + 16,
      paddingHorizontal: 20,
      paddingBottom: 16,
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
    headerSub: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 2,
    },
    listTop: { height: 12 },
    listBottom: { height: insets.bottom + 16 },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 32,
      gap: 8,
    },
    emptyTitle: {
      fontSize: 18,
      fontWeight: "700",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
      textAlign: "center",
    },
    emptyText: {
      fontSize: 14,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      textAlign: "center",
      lineHeight: 20,
    },
  });

  const liveCount = (events ?? []).filter(e => e.status === "race_day").length;
  const subLabel = isLoading
    ? "Loading…"
    : liveCount > 0
    ? `${liveCount} live now · ${(events?.length ?? 0) - liveCount} upcoming`
    : `${events?.length ?? 0} event${(events?.length ?? 1) !== 1 ? "s" : ""} open`;

  const ListHeader = () => (
    <>
      <View style={styles.header}>
        <BrandBar />
        <Text style={styles.headerTitle}>Upcoming Races</Text>
        <Text style={styles.headerSub}>{subLabel}</Text>
      </View>
      <View style={styles.listTop} />
    </>
  );

  if (isLoading) {
    return (
      <View style={styles.container}>
        <ListHeader />
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.container}>
        <ListHeader />
        <View style={styles.centered}>
          <Feather name="alert-circle" size={36} color={colors.mutedForeground} />
          <Text style={styles.emptyTitle}>Couldn't load events</Text>
          <Text style={styles.emptyText}>{error.message}</Text>
          <Pressable onPress={() => refetch()} style={{ marginTop: 12 }}>
            <Text style={{ color: colors.primary, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>
              Try again
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={events ?? []}
      keyExtractor={(item) => String(item.id)}
      renderItem={({ item }) => (
        <EventCard
          event={item}
          colors={colors}
          onPress={() => router.push(`/event/${item.id}` as any)}
        />
      )}
      ListHeaderComponent={<ListHeader />}
      ListFooterComponent={<View style={styles.listBottom} />}
      contentContainerStyle={(events?.length ?? 0) === 0 ? { flexGrow: 1 } : undefined}
      scrollEnabled={(events?.length ?? 0) > 0}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.primary}
        />
      }
      ListEmptyComponent={
        <View style={styles.centered}>
          <Feather name="calendar" size={40} color={colors.mutedForeground} />
          <Text style={styles.emptyTitle}>No upcoming races</Text>
          <Text style={styles.emptyText}>
            Check back soon — events will appear here when registration opens.
          </Text>
        </View>
      }
    />
  );
}
