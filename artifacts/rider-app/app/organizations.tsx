import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";

const ACCENT = "#cf152d";

interface Organization {
  clubId: number;
  clubName: string;
  state: string;
  logoUrl: string | null;
  notificationsEnabled: boolean;
}

export default function OrganizationsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { riderFetch } = useRiderAuth();

  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [toggling, setToggling] = useState<Set<number>>(new Set());

  const fetchOrganizations = useCallback(async () => {
    try {
      const res = await riderFetch("/api/rider/my-organizations");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error ?? `Error ${res.status}`);
      }
      const data: Organization[] = await res.json();
      setOrganizations(data);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [riderFetch]);

  React.useEffect(() => {
    (async () => {
      setLoading(true);
      await fetchOrganizations();
      setLoading(false);
    })();
  }, [fetchOrganizations]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchOrganizations();
    setRefreshing(false);
  }, [fetchOrganizations]);

  const handleToggle = useCallback(
    async (clubId: number, newValue: boolean) => {
      setToggling((prev) => new Set(prev).add(clubId));
      setOrganizations((prev) =>
        prev.map((org) =>
          org.clubId === clubId ? { ...org, notificationsEnabled: newValue } : org,
        ),
      );
      try {
        const res = await riderFetch(`/api/rider/my-organizations/${clubId}/notifications`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: newValue }),
        });
        if (!res.ok) {
          // Revert on failure
          setOrganizations((prev) =>
            prev.map((org) =>
              org.clubId === clubId ? { ...org, notificationsEnabled: !newValue } : org,
            ),
          );
        }
      } catch {
        // Revert on network error
        setOrganizations((prev) =>
          prev.map((org) =>
            org.clubId === clubId ? { ...org, notificationsEnabled: !newValue } : org,
          ),
        );
      } finally {
        setToggling((prev) => {
          const next = new Set(prev);
          next.delete(clubId);
          return next;
        });
      }
    },
    [riderFetch],
  );

  const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: 12,
    },
    backBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.muted,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: {
      flex: 1,
      fontSize: 17,
      fontWeight: "700",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
    },
    scroll: { flex: 1 },
    content: {
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: insets.bottom + 32,
      gap: 12,
    },
    description: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      lineHeight: 18,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: "hidden",
    },
    orgRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 12,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginLeft: 16,
    },
    iconBox: {
      width: 40,
      height: 40,
      borderRadius: 10,
      backgroundColor: ACCENT + "15",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    orgName: {
      fontSize: 15,
      fontWeight: "700",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
    },
    orgState: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 1,
    },
    notifLabel: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
    },
    emptyBox: {
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 36,
      alignItems: "center",
      gap: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    emptyTitle: {
      fontSize: 16,
      fontWeight: "700",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
    },
    emptyText: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      textAlign: "center",
      lineHeight: 18,
    },
  });

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [s.backBtn, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </Pressable>
        <Text style={s.headerTitle}>My Race Organizations</Text>
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
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          }
        >
          <Text style={s.description}>
            Every club you've ever raced with appears here. Toggle notifications to control whether that club can send you push alerts.
          </Text>

          {error ? (
            <View style={s.emptyBox}>
              <Feather name="alert-circle" size={36} color={colors.mutedForeground + "60"} />
              <Text style={s.emptyTitle}>Couldn't Load</Text>
              <Text style={s.emptyText}>{error}</Text>
            </View>
          ) : organizations.length === 0 ? (
            <View style={s.emptyBox}>
              <Feather name="flag" size={36} color={colors.mutedForeground + "50"} />
              <Text style={s.emptyTitle}>No Organizations Yet</Text>
              <Text style={s.emptyText}>
                Once you register for an event, that club will appear here so you can manage their notifications.
              </Text>
            </View>
          ) : (
            <View style={s.card}>
              {organizations.map((org, idx) => (
                <React.Fragment key={org.clubId}>
                  {idx > 0 && <View style={s.divider} />}
                  <View style={s.orgRow}>
                    {/* Club icon */}
                    <View style={s.iconBox}>
                      <Feather name="flag" size={18} color={ACCENT} />
                    </View>

                    {/* Club info */}
                    <View style={{ flex: 1 }}>
                      <Text style={s.orgName} numberOfLines={1}>
                        {org.clubName}
                      </Text>
                      <Text style={s.orgState}>{org.state}</Text>
                    </View>

                    {/* Notification toggle */}
                    <View style={{ alignItems: "flex-end", gap: 2 }}>
                      <Text style={s.notifLabel}>Notifications</Text>
                      {toggling.has(org.clubId) ? (
                        <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: 4 }} />
                      ) : (
                        <Switch
                          value={org.notificationsEnabled}
                          onValueChange={(v) => handleToggle(org.clubId, v)}
                          trackColor={{ false: colors.border, true: ACCENT + "90" }}
                          thumbColor={org.notificationsEnabled ? ACCENT : colors.mutedForeground}
                          ios_backgroundColor={colors.border}
                        />
                      )}
                    </View>
                  </View>
                </React.Fragment>
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}
