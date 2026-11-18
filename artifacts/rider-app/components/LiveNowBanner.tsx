import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React from "react";
import { Pressable, Text, View } from "react-native";

import { fonts } from "@/constants/fonts";
import { useLiveStreams } from "@/lib/liveStreams";

/**
 * Home screen: shows only while an event is streaming. One live event opens
 * its player straight away; several open the Live now list.
 */
export function LiveNowBanner() {
  const router = useRouter();
  const { events } = useLiveStreams();
  if (events.length === 0) return null;
  const one = events.length === 1 ? events[0] : null;
  const title = one ? one.name : `${events.length} events streaming now`;
  const sub = one ? `${one.clubName} · tap to watch` : "Tap to pick a race to watch";
  return (
    <Pressable
      onPress={() => router.push((one ? `/live/${one.eventId}` : "/live") as any)}
      accessibilityRole="button"
      accessibilityLabel={one ? `Watch ${one.name} live` : "See live streams"}
      style={({ pressed }) => ({
        marginHorizontal: 16, marginBottom: 12, borderRadius: 14, backgroundColor: "#1A1A1A",
        flexDirection: "row", alignItems: "center", gap: 12, padding: 12, opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#B30000", alignItems: "center", justifyContent: "center" }}>
        <Feather name="play" size={20} color="#fff" style={{ marginLeft: 2 }} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: "#FF3B3B" }} />
          <Text style={{ color: "#FF6B6B", fontFamily: fonts.display, fontSize: 12, letterSpacing: 1 }}>LIVE NOW</Text>
        </View>
        <Text style={{ color: "#fff", fontFamily: fonts.display, fontSize: 16 }} numberOfLines={1}>{title}</Text>
        <Text style={{ color: "rgba(255,255,255,0.65)", fontFamily: fonts.regular, fontSize: 12 }} numberOfLines={1}>{sub}</Text>
      </View>
      <Feather name="chevron-right" size={20} color="rgba(255,255,255,0.6)" />
    </Pressable>
  );
}

/** Event screen: a "Watch live" button, shown only while this event is streaming. */
export function EventLiveButton({ eventId }: { eventId: number }) {
  const router = useRouter();
  const { events } = useLiveStreams();
  const live = events.find(e => e.eventId === eventId);
  if (!live) return null;
  const cams = live.cameras.length;
  return (
    <Pressable
      onPress={() => router.push(`/live/${eventId}` as any)}
      accessibilityRole="button"
      accessibilityLabel="Watch this event live"
      style={({ pressed }) => ({
        marginHorizontal: 16, marginBottom: 12, borderRadius: 999, backgroundColor: "#B30000",
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12, opacity: pressed ? 0.85 : 1,
      })}
    >
      <Feather name="play-circle" size={18} color="#fff" />
      <Text style={{ color: "#fff", fontFamily: fonts.bold, fontSize: 15 }}>
        Watch live{cams > 1 ? ` · ${cams} cameras` : ""}
      </Text>
    </Pressable>
  );
}
