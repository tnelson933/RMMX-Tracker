import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import { ActivityIndicator, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useBottomSpace } from "@/hooks/useBottomSpace";
import { goBack } from "@/lib/navigation";
import { fonts } from "@/constants/fonts";
import { liveForLabel, useLiveStreams, type LiveStreamEvent } from "@/lib/liveStreams";

/** Every event streaming right now. Tap one to watch it in the app's player. */
export default function LiveNowScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const bottomSpace = useBottomSpace();
  const { events, loading, error, refresh } = useLiveStreams();
  const [refreshing, setRefreshing] = useState(false);
  const s = styles(colors);

  const onRefresh = async () => { setRefreshing(true); await refresh(); setRefreshing(false); };

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => goBack(router)} accessibilityRole="button" accessibilityLabel="Back" style={({ pressed }) => [s.backBtn, { opacity: pressed ? 0.6 : 1 }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </Pressable>
        <Text style={s.headerTitle}>Watch live</Text>
      </View>
      <ScrollView
        contentContainerStyle={[s.content, { paddingBottom: bottomSpace + 24 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {loading && events.length === 0 ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
        ) : events.length === 0 ? (
          <View style={s.empty}>
            <Feather name="video-off" size={36} color={colors.mutedForeground} />
            <Text style={s.emptyTitle}>Nothing streaming right now</Text>
            <Text style={s.muted}>
              {error ?? "When a track goes live, it shows up here. This list checks again every 30 seconds."}
            </Text>
          </View>
        ) : (
          events.map(e => <LiveCard key={e.eventId} event={e} colors={colors} onPress={() => router.push(`/live/${e.eventId}` as any)} />)
        )}
        {!!error && events.length > 0 && <Text style={[s.muted, { color: "#DC2626" }]}>{error}</Text>}
      </ScrollView>
    </View>
  );
}

function LiveCard({ event, colors, onPress }: { event: LiveStreamEvent; colors: ReturnType<typeof useColors>; onPress: () => void }) {
  const where = [event.trackName || event.location, event.state].filter(Boolean).join(", ");
  const cams = event.cameras.length;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Watch ${event.name} live`}
      style={({ pressed }) => ({ backgroundColor: colors.card, borderRadius: 14, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, opacity: pressed ? 0.8 : 1 })}>
      <View style={{ height: 140, backgroundColor: "#111", alignItems: "center", justifyContent: "center" }}>
        {event.imageUrl ? <Image source={{ uri: event.imageUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
        <View style={{ position: "absolute", top: 10, left: 10, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#B30000", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: "#fff" }} />
          <Text style={{ color: "#fff", fontFamily: fonts.display, fontSize: 12, letterSpacing: 1 }}>LIVE</Text>
        </View>
        <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" }}>
          <Feather name="play" size={24} color="#fff" style={{ marginLeft: 3 }} />
        </View>
      </View>
      <View style={{ padding: 12, gap: 2 }}>
        <Text style={{ fontFamily: fonts.display, fontSize: 18, color: colors.foreground }} numberOfLines={1}>{event.name}</Text>
        <Text style={{ fontFamily: fonts.regular, fontSize: 13, color: colors.mutedForeground }} numberOfLines={1}>
          {[event.clubName, where].filter(Boolean).join(" · ")}
        </Text>
        <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.mutedForeground, marginTop: 4 }}>
          {[liveForLabel(event.liveSince), `${cams} camera${cams === 1 ? "" : "s"}`, `${event.viewers} watching`].join(" · ")}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = (colors: ReturnType<typeof useColors>) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: 12 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, fontSize: 17, color: colors.foreground, fontFamily: fonts.bold },
  content: { padding: 16, gap: 14 },
  empty: { alignItems: "center", gap: 10, marginTop: 48, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 17, color: colors.foreground, fontFamily: fonts.bold, textAlign: "center" },
  muted: { fontSize: 13, color: colors.mutedForeground, fontFamily: fonts.regular, textAlign: "center", lineHeight: 19 },
});
