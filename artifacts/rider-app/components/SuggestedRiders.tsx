import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { PressableScale } from "@/components/PressableScale";
import { haptics } from "@/lib/haptics";

import { RiderAvatar } from "@/components/RiderPhoto";
import { fonts } from "@/constants/fonts";
import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";
import { NETWORK_ERROR_MESSAGE } from "@/lib/friendlyErrors";

interface Suggested { id: number; name: string; avatarUrl: string | null; number: string | null; state: string | null; reason: string }

/**
 * Home screen "Riders to follow": a sideways row of the riders yours race
 * against, riders from your state and recent winners (the same lists as the
 * Find riders screen), with one-tap Follow. Hidden when there's nobody to suggest.
 */
export function SuggestedRiders({ refreshKey, onFollowed }: { refreshKey: number; onFollowed?: () => void }) {
  const colors = useColors();
  const router = useRouter();
  const { riderFetch } = useRiderAuth();
  const [riders, setRiders] = useState<Suggested[] | null>(null);
  const [followed, setFollowed] = useState<Set<number>>(new Set());
  const busy = useRef(new Set<number>());

  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const r = await riderFetch("/api/rider/riders/suggested");
        if (!r.ok) return;
        const j = await r.json() as { competitors?: Suggested[]; nearby?: Suggested[]; top?: Suggested[] };
        // The API already lists each rider once; keep its order: competitors, nearby, then winners.
        if (!stale) { setRiders([...(j.competitors ?? []), ...(j.nearby ?? []), ...(j.top ?? [])].slice(0, 12)); setFollowed(new Set()); }
      } catch { /* offline: keep what we had */ }
    })();
    return () => { stale = true; };
  }, [riderFetch, refreshKey]);

  const follow = useCallback(async (id: number) => {
    if (busy.current.has(id)) return;
    busy.current.add(id);
    setFollowed(prev => new Set(prev).add(id));
    const undo = () => setFollowed(prev => { const n = new Set(prev); n.delete(id); return n; });
    try {
      const r = await riderFetch(`/api/rider/follows/${id}`, { method: "POST" });
      if (!r.ok) {
        undo();
        // A rider whose profile turned private since the list loaded answers 403 with a message.
        const message = r.status === 403 ? ((await r.json().catch(() => null))?.error as string | undefined) : undefined;
        Alert.alert("Couldn't follow", message ?? `Try again (error ${r.status}).`);
      }
      else { haptics.success(); onFollowed?.(); }
    } catch {
      undo();
      Alert.alert("Couldn't follow", NETWORK_ERROR_MESSAGE);
    } finally {
      busy.current.delete(id);
    }
  }, [riderFetch, onFollowed]);

  if (!riders || riders.length === 0) return null;
  return (
    <View style={{ marginBottom: 24 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, marginBottom: 10, gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 14, letterSpacing: 1.2, textTransform: "uppercase", color: colors.mutedForeground, fontFamily: "Barlow_700Bold" }}>Riders to follow</Text>
        <Pressable onPress={() => router.push("/follow" as any)} hitSlop={8} accessibilityRole="button">
          <Text style={{ fontSize: 13, color: colors.primaryText, fontFamily: "Roboto_600SemiBold" }}>See all</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
        {riders.map(r => {
          const isFollowing = followed.has(r.id);
          return (
            <PressableScale key={r.id} onPress={() => router.push(`/racer/${r.id}` as any)} accessibilityRole="button"
              accessibilityLabel={`${r.name}. ${r.reason}. Open profile`}
              style={{
                width: 150, padding: 12, gap: 6, alignItems: "center", borderRadius: 14, borderWidth: 1,
                borderColor: colors.border, backgroundColor: colors.card,
              }}>
              <RiderAvatar url={r.avatarUrl} name={r.name} size={56} />
              <Text numberOfLines={1} style={{ color: colors.foreground, fontFamily: fonts.bold, fontSize: 14, textAlign: "center" }}>
                {r.number ? `#${r.number} ` : ""}{r.name}
              </Text>
              <Text numberOfLines={2} style={{ minHeight: 30, color: colors.mutedForeground, fontFamily: fonts.regular, fontSize: 11, lineHeight: 15, textAlign: "center" }}>
                {r.reason}
              </Text>
              <PressableScale onPress={() => { if (!isFollowing) void follow(r.id); }} disabled={isFollowing} accessibilityRole="button"
                accessibilityLabel={isFollowing ? `Following ${r.name}` : `Follow ${r.name}`} accessibilityState={{ selected: isFollowing }}
                scaleTo={0.94}
                style={{
                  alignSelf: "stretch", alignItems: "center", paddingVertical: 7, borderRadius: 999, borderWidth: 1,
                  borderColor: isFollowing ? colors.border : colors.primary, backgroundColor: isFollowing ? "transparent" : colors.primary,
                }}>
                <Text style={{ color: isFollowing ? colors.foreground : "#FFFFFF", fontFamily: fonts.display, fontSize: 13, textTransform: "uppercase", letterSpacing: 1 }}>
                  {isFollowing ? "Following" : "Follow"}
                </Text>
              </PressableScale>
            </PressableScale>
          );
        })}
      </ScrollView>
    </View>
  );
}
