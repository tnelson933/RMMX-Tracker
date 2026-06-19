import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";

const ACCENT = "#cf152d";

interface MaintenanceItem {
  id: number;
  riderId: number;
  itemKey: string;
  itemName: string;
  intervalDesc: string | null;
  intervalDays: number | null;
  lastServicedAt: string | null;
  notes: string | null;
  sortOrder: number;
  createdAt: string;
}

function getDaysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const ms = Date.now() - new Date(dateStr).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function getStatus(item: MaintenanceItem): "overdue" | "due_soon" | "ok" | "unknown" {
  const days = getDaysSince(item.lastServicedAt);
  if (days === null || !item.intervalDays) return "unknown";
  if (days >= item.intervalDays) return "overdue";
  if (days >= item.intervalDays * 0.8) return "due_soon";
  return "ok";
}

function StatusBadge({ item }: { item: MaintenanceItem }) {
  const colors = useColors();
  const status = getStatus(item);
  const days = getDaysSince(item.lastServicedAt);

  const map = {
    overdue:  { color: "#DC2626", bg: "#FEE2E2", label: "Overdue" },
    due_soon: { color: "#D97706", bg: "#FEF3C7", label: "Due Soon" },
    ok:       { color: "#16A34A", bg: "#DCFCE7", label: "OK" },
    unknown:  { color: colors.mutedForeground, bg: colors.muted, label: "Not logged" },
  };

  const s = map[status];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: s.bg }}>
        <Text style={{ fontSize: 10, fontWeight: "700", color: s.color, fontFamily: "Inter_700Bold" }}>
          {s.label}
        </Text>
      </View>
      {days !== null && (
        <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
          {days === 0 ? "Today" : `${days}d ago`}
        </Text>
      )}
    </View>
  );
}

export default function MaintenanceScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const { riderId: riderIdParam } = useLocalSearchParams<{ riderId: string }>();
  const riderId = parseInt(riderIdParam ?? "", 10);
  const { riderFetch, profiles } = useRiderAuth();

  const profile = profiles.find(p => p.id === riderId);
  const bikeStr = [profile?.bikeYear, profile?.bikeManufacturer, profile?.bikeModel]
    .filter(Boolean).join(" ");

  const [items, setItems] = useState<MaintenanceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [loggingKey, setLoggingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await riderFetch(`/api/rider/maintenance/${riderId}`);
      if (res.ok) setItems(await res.json());
    } catch { /* ignore */ }
  }, [riderFetch, riderId]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function handleGenerate() {
    setGenerating(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const res = await riderFetch(`/api/rider/maintenance/${riderId}/ai-generate`, { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        Alert.alert("Error", (d as any).error ?? "Could not generate schedule");
        return;
      }
      const data: MaintenanceItem[] = await res.json();
      setItems(data);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert("Error", "Network error. Please try again.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleLogService(item: MaintenanceItem) {
    setLoggingKey(item.itemKey);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const today = new Date().toISOString().slice(0, 10);
    try {
      const res = await riderFetch(`/api/rider/maintenance/${riderId}/${item.itemKey}`, {
        method: "PUT",
        body: JSON.stringify({
          itemName: item.itemName,
          intervalDesc: item.intervalDesc,
          intervalDays: item.intervalDays,
          lastServicedAt: today,
          notes: item.notes,
          sortOrder: item.sortOrder,
        }),
      });
      if (res.ok) {
        const updated: MaintenanceItem = await res.json();
        setItems(prev => prev.map(i => i.itemKey === item.itemKey ? updated : i));
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch { /* ignore */ }
    setLoggingKey(null);
  }

  async function handleDelete(item: MaintenanceItem) {
    Alert.alert(
      "Remove Item",
      `Remove "${item.itemName}" from your schedule?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove", style: "destructive",
          onPress: async () => {
            try {
              await riderFetch(`/api/rider/maintenance/${riderId}/${item.itemKey}`, { method: "DELETE" });
              setItems(prev => prev.filter(i => i.itemKey !== item.itemKey));
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            } catch { /* ignore */ }
          },
        },
      ],
    );
  }

  const overdueCount = items.filter(i => getStatus(i) === "overdue").length;
  const dueSoonCount = items.filter(i => getStatus(i) === "due_soon").length;

  const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: "row", alignItems: "center", gap: 12,
      paddingHorizontal: 16, paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" },
    headerCenter: { flex: 1 },
    headerTitle: { fontSize: 17, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" },
    headerSub: { fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 },
    genBtn: {
      flexDirection: "row", alignItems: "center", gap: 6,
      paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
      backgroundColor: ACCENT,
    },
    genBtnText: { fontSize: 12, color: "#fff", fontFamily: "Inter_700Bold" },
    scroll: { flex: 1 },
    content: { padding: 16, gap: 12, paddingBottom: insets.bottom + 32 },
    summaryRow: {
      flexDirection: "row", gap: 10,
    },
    summaryBox: {
      flex: 1, borderRadius: 12, padding: 14, alignItems: "center", gap: 4,
      borderWidth: 1,
    },
    summaryNum: { fontSize: 24, fontWeight: "800", fontFamily: "Inter_700Bold" },
    summaryLabel: { fontSize: 10, fontWeight: "700", fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.6 },
    emptyBox: {
      backgroundColor: colors.card, borderRadius: 14, padding: 32,
      alignItems: "center", gap: 10, borderWidth: 1, borderColor: colors.border,
    },
    emptyTitle: { fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" },
    emptyText: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 19 },
    itemCard: {
      backgroundColor: colors.card, borderRadius: 14,
      borderWidth: 1, borderColor: colors.border, overflow: "hidden",
    },
    itemInner: { padding: 14, gap: 8 },
    itemTopRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 },
    itemName: { fontSize: 14, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", flex: 1 },
    itemInterval: { fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" },
    itemNotes: { fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", fontStyle: "italic" },
    itemActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
    logBtn: {
      flexDirection: "row", alignItems: "center", gap: 6,
      paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8,
      backgroundColor: colors.primary,
    },
    logBtnText: { fontSize: 12, color: "#fff", fontFamily: "Inter_600SemiBold" },
    deleteBtn: { padding: 8, borderRadius: 8, backgroundColor: colors.muted },
  });

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable style={s.backBtn} onPress={() => router.back()}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </Pressable>
        <View style={s.headerCenter}>
          <Text style={s.headerTitle}>Maintenance</Text>
          {bikeStr ? (
            <Text style={s.headerSub}>{bikeStr}</Text>
          ) : (
            <Text style={s.headerSub}>{profile?.firstName} {profile?.lastName}</Text>
          )}
        </View>
        <Pressable
          style={[s.genBtn, generating && { opacity: 0.6 }]}
          onPress={handleGenerate}
          disabled={generating || !bikeStr}
        >
          {generating ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Feather name="zap" size={13} color="#fff" />
              <Text style={s.genBtnText}>{items.length > 0 ? "Refresh" : "AI Generate"}</Text>
            </>
          )}
        </Pressable>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.content}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        >
          {/* Summary */}
          {items.length > 0 && (
            <View style={s.summaryRow}>
              <View style={[s.summaryBox, { backgroundColor: overdueCount > 0 ? "#FEE2E2" : colors.card, borderColor: overdueCount > 0 ? "#FCA5A5" : colors.border }]}>
                <Text style={[s.summaryNum, { color: overdueCount > 0 ? "#DC2626" : colors.mutedForeground }]}>{overdueCount}</Text>
                <Text style={[s.summaryLabel, { color: overdueCount > 0 ? "#DC2626" : colors.mutedForeground }]}>Overdue</Text>
              </View>
              <View style={[s.summaryBox, { backgroundColor: dueSoonCount > 0 ? "#FEF3C7" : colors.card, borderColor: dueSoonCount > 0 ? "#FDE68A" : colors.border }]}>
                <Text style={[s.summaryNum, { color: dueSoonCount > 0 ? "#D97706" : colors.mutedForeground }]}>{dueSoonCount}</Text>
                <Text style={[s.summaryLabel, { color: dueSoonCount > 0 ? "#D97706" : colors.mutedForeground }]}>Due Soon</Text>
              </View>
              <View style={[s.summaryBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[s.summaryNum, { color: colors.primary }]}>{items.length}</Text>
                <Text style={[s.summaryLabel, { color: colors.mutedForeground }]}>Total Items</Text>
              </View>
            </View>
          )}

          {/* Empty state */}
          {items.length === 0 && (
            <View style={s.emptyBox}>
              <Feather name="tool" size={36} color={colors.mutedForeground + "50"} />
              <Text style={s.emptyTitle}>No Maintenance Schedule</Text>
              <Text style={s.emptyText}>
                {bikeStr
                  ? `Tap "AI Generate" to build a maintenance schedule for your ${bikeStr} using AI.`
                  : "Add your bike make and model to your profile first, then generate a maintenance schedule."}
              </Text>
            </View>
          )}

          {/* Items */}
          {items.map(item => {
            const status = getStatus(item);
            const leftBorderColor =
              status === "overdue" ? "#DC2626" :
              status === "due_soon" ? "#D97706" :
              status === "ok" ? "#16A34A" : colors.border;

            return (
              <View key={item.itemKey} style={[s.itemCard, { borderLeftWidth: 3, borderLeftColor: leftBorderColor }]}>
                <View style={s.itemInner}>
                  <View style={s.itemTopRow}>
                    <Text style={s.itemName}>{item.itemName}</Text>
                    <StatusBadge item={item} />
                  </View>

                  {item.intervalDesc && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                      <Feather name="clock" size={11} color={colors.mutedForeground} />
                      <Text style={s.itemInterval}>{item.intervalDesc}</Text>
                    </View>
                  )}

                  {item.lastServicedAt && (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                      <Feather name="check-circle" size={11} color={colors.mutedForeground} />
                      <Text style={s.itemInterval}>
                        Last serviced: {new Date(item.lastServicedAt + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      </Text>
                    </View>
                  )}

                  {item.notes && <Text style={s.itemNotes}>{item.notes}</Text>}

                  <View style={s.itemActions}>
                    <Pressable
                      style={[s.logBtn, loggingKey === item.itemKey && { opacity: 0.6 }]}
                      onPress={() => handleLogService(item)}
                      disabled={loggingKey !== null}
                    >
                      {loggingKey === item.itemKey ? (
                        <ActivityIndicator color="#fff" size="small" style={{ width: 90 }} />
                      ) : (
                        <>
                          <Feather name="check" size={13} color="#fff" />
                          <Text style={s.logBtnText}>Log Service Today</Text>
                        </>
                      )}
                    </Pressable>

                    <Pressable
                      style={s.deleteBtn}
                      onPress={() => handleDelete(item)}
                    >
                      <Feather name="trash-2" size={15} color="#DC2626" />
                    </Pressable>
                  </View>
                </View>
              </View>
            );
          })}

          {items.length > 0 && (
            <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 17 }}>
              Schedule generated by AI based on manufacturer guidelines.{"\n"}Always consult your owner's manual.
            </Text>
          )}
        </ScrollView>
      )}
    </View>
  );
}
