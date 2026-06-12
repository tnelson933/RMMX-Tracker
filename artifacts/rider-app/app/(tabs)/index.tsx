import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
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
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

function EventCard({ event, colors }: { event: Event; colors: ReturnType<typeof useColors> }) {
  const statusInfo = STATUS_LABEL[event.status] ?? { label: event.status, color: "#9ca3af" };
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
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
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
    },
    badgeText: {
      fontSize: 11,
      fontWeight: "700",
      color: statusInfo.color,
      fontFamily: "Inter_600SemiBold",
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
    divider: { color: colors.border, fontSize: 13 },
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
  });

  return (
    <View style={s.card}>
      <View style={s.topRow}>
        <Text style={s.name}>{event.name}</Text>
        <View style={s.badge}>
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
    </View>
  );
}

export default function EventsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);

  const { data: events, isLoading, error, refetch } = useQuery<Event[], Error>({
    queryKey: ["mobile-events"],
    queryFn: fetchEvents,
    staleTime: 60_000,
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

  const ListHeader = () => (
    <>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Upcoming Races</Text>
        <Text style={styles.headerSub}>
          {events ? `${events.length} event${events.length !== 1 ? "s" : ""} open` : "Loading…"}
        </Text>
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
      renderItem={({ item }) => <EventCard event={item} colors={colors} />}
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
