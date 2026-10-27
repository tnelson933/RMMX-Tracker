import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";
import { EmptyState } from "@/components/EmptyState";

interface FeedItem {
  riderId: number; riderName: string; eventId: number; eventName: string; eventDate: string;
  raceClass: string; bestPosition: number | null; isMine: boolean;
  motos: Array<{ motoName: string; position: number | null; dnf: boolean; dns: boolean }>;
}

/** Home-screen "Following" section: published results of riders you follow. */
export function FollowingFeed({ refreshKey }: { refreshKey: number }) {
  const colors = useColors();
  const router = useRouter();
  const { riderFetch } = useRiderAuth();
  const [items, setItems] = useState<FeedItem[] | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await riderFetch("/api/rider/feed");
      if (r.ok) setItems(((await r.json()).items as FeedItem[]).filter(i => !i.isMine).slice(0, 8));
    } catch { /* offline: keep what we had */ }
  }, [riderFetch]);
  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <View style={{ marginBottom: 24 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, marginBottom: 10, gap: 8 }}>
        <Feather name="users" size={14} color={colors.mutedForeground} />
        <Text style={{ flex: 1, fontSize: 13, letterSpacing: 1.2, textTransform: "uppercase", color: colors.mutedForeground, fontFamily: "Inter_700Bold" }}>Following</Text>
        <Pressable onPress={() => router.push("/follow" as any)} hitSlop={8}>
          <Text style={{ fontSize: 13, color: colors.primary, fontFamily: "Inter_600SemiBold" }}>Find riders</Text>
        </Pressable>
      </View>
      {items && items.length === 0 ? (
        <EmptyState
          variant="card"
          icon="users"
          title="Ride with your crew"
          message="Follow friends, teammates or rivals. Their results show up here the moment they're posted."
          primary={{ label: "Find riders", icon: "user-plus", onPress: () => router.push("/follow" as any) }}
        />
      ) : (
        (items ?? []).map(i => (
          <Pressable key={`${i.riderId}-${i.eventId}-${i.raceClass}`} onPress={() => router.push(`/racer/${i.riderId}` as any)}
            style={({ pressed }) => ({
              marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 12, backgroundColor: colors.card,
              borderWidth: 1, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: 10, opacity: pressed ? 0.7 : 1,
            })}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, color: colors.foreground, fontFamily: "Inter_600SemiBold" }} numberOfLines={1}>{i.riderName}</Text>
              <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }} numberOfLines={1}>
                {i.raceClass} · {i.eventName}
              </Text>
            </View>
            <Text style={{ fontSize: 18, color: colors.foreground, fontFamily: "Inter_700Bold" }}>{i.bestPosition ? `P${i.bestPosition}` : "—"}</Text>
          </Pressable>
        ))
      )}
    </View>
  );
}
