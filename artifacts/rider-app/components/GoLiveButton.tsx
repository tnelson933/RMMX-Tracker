import { Feather } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";

import { RiderAvatar } from "@/components/RiderPhoto";
import { fonts } from "@/constants/fonts";
import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";

interface Eligible { riderId: number; allowed: boolean }

/** Which of this account's riders may go live now (race day, within 2 races of racing). Checked every 30 s. */
function useGoLiveRiders(): Set<number> {
  const { riderFetch, profiles } = useRiderAuth();
  const [allowed, setAllowed] = useState<Set<number>>(new Set());
  useFocusEffect(useCallback(() => {
    if (profiles.length === 0) return;
    let stopped = false;
    const load = async () => {
      try {
        const r = await riderFetch("/api/rider/live/eligible");
        if (!r.ok || stopped) return;
        const j = await r.json() as { riders: Eligible[] };
        setAllowed(new Set(j.riders.filter(x => x.allowed).map(x => x.riderId)));
      } catch { /* offline: keep what we had */ }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => { stopped = true; clearInterval(t); };
  }, [riderFetch, profiles.length]));
  return allowed;
}

/**
 * Home screen: go live from this phone as a rider on this account. Shown only on
 * race day when a rider here is within 2 races of racing (the server decides,
 * lib/riderRace.ts goLiveWindow), and only those riders can be picked.
 */
export function GoLiveButton() {
  const router = useRouter();
  const colors = useColors();
  const { profiles: allProfiles } = useRiderAuth();
  const allowed = useGoLiveRiders();
  const profiles = allProfiles.filter(p => allowed.has(p.id));
  const [picking, setPicking] = useState(false);
  if (profiles.length === 0) return null;

  const start = (riderId: number) => {
    setPicking(false);
    router.push(`/go-live/${riderId}` as any);
  };

  return (
    <>
      <Pressable
        onPress={() => (profiles.length === 1 ? start(profiles[0].id) : setPicking(true))}
        accessibilityRole="button"
        accessibilityLabel="Go live with video from this phone"
        style={({ pressed }) => ({
          marginHorizontal: 16, marginBottom: 12, borderRadius: 14, backgroundColor: "#B30000",
          flexDirection: "row", alignItems: "center", gap: 12, padding: 12, opacity: pressed ? 0.85 : 1,
        })}
      >
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" }}>
          <Feather name="video" size={20} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: "#fff", fontFamily: fonts.display, fontSize: 16, letterSpacing: 0.5 }}>GO LIVE</Text>
          {/* Wraps onto a second line on narrow phones instead of cutting off "notification". */}
          <Text style={{ color: "rgba(255,255,255,0.85)", fontFamily: fonts.regular, fontSize: 12, lineHeight: 16 }}>
            {profiles.length === 1
              ? `Stream ${profiles[0].firstName}'s race. Followers get a notification.`
              : "Stream a race from this phone. Followers get a notification."}
          </Text>
        </View>
        <Feather name="chevron-right" size={20} color="rgba(255,255,255,0.8)" />
      </Pressable>

      <Modal visible={picking} transparent animationType="fade" onRequestClose={() => setPicking(false)}>
        <Pressable onPress={() => setPicking(false)} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}>
          <Pressable onPress={() => {}} style={{ backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 36, gap: 10 }}>
            <Text style={{ fontFamily: fonts.display, fontSize: 18, color: colors.foreground, textTransform: "uppercase" }}>Who's racing?</Text>
            <Text style={{ fontFamily: fonts.regular, fontSize: 13, color: colors.mutedForeground, marginBottom: 6 }}>
              Pick the rider you're streaming. Their followers get a notification when you go live.
            </Text>
            {profiles.map(p => (
              <Pressable key={p.id} onPress={() => start(p.id)} accessibilityRole="button" accessibilityLabel={`Go live as ${p.firstName} ${p.lastName}`}
                style={({ pressed }) => ({
                  flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 12,
                  borderWidth: 1, borderColor: colors.border, opacity: pressed ? 0.7 : 1,
                })}>
                <RiderAvatar url={p.avatarUrl} name={`${p.firstName} ${p.lastName}`} size={40} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.foreground }} numberOfLines={1}>{p.firstName} {p.lastName}</Text>
                  {p.bibNumber ? <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground }}>#{p.bibNumber}</Text> : null}
                </View>
                <Feather name="video" size={18} color={colors.primaryText} />
              </Pressable>
            ))}
            <Pressable onPress={() => setPicking(false)} accessibilityRole="button" style={{ alignItems: "center", paddingTop: 8 }}>
              <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.mutedForeground }}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/** Racer profile: a "Live now" button while this rider is streaming and the viewer may watch. */
export function RiderLiveBanner({ riderId, live, canWatch, viewers }: { riderId: number; live: boolean; canWatch: boolean; viewers: number }) {
  const router = useRouter();
  if (!live || !canWatch) return null;
  return (
    <Pressable
      onPress={() => router.push(`/live/rider/${riderId}` as any)}
      accessibilityRole="button"
      accessibilityLabel="Watch this rider's live video"
      style={({ pressed }) => ({
        marginTop: 12, borderRadius: 999, backgroundColor: "#B30000", flexDirection: "row", alignItems: "center",
        justifyContent: "center", gap: 8, paddingVertical: 12, opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#fff" }} />
      <Text style={{ color: "#fff", fontFamily: fonts.display, fontSize: 15, letterSpacing: 0.5 }}>
        LIVE NOW · WATCH{viewers > 0 ? ` (${viewers})` : ""}
      </Text>
    </Pressable>
  );
}
