import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";

const ACCENT = "#cf152d";

interface FoundRider { id: number; name: string; lastRaced: string | null; clubName: string | null; following: boolean }
interface Followed { riderId: number; name: string }

/** Find riders by name and follow them. Following puts their results in your feed and sends a push when results are in. */
export default function FollowScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { riderFetch } = useRiderAuth();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<FoundRider[]>([]);
  const [following, setFollowing] = useState<Followed[]>([]);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadFollowing = useCallback(async () => {
    const r = await riderFetch("/api/rider/follows");
    if (r.ok) setFollowing((await r.json()).following);
  }, [riderFetch]);
  useEffect(() => { loadFollowing(); }, [loadFollowing]);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (q.trim().length < 2) { setResults([]); return; }
    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await riderFetch(`/api/rider/riders/search?q=${encodeURIComponent(q.trim())}`);
        if (r.ok) setResults((await r.json()).riders);
      } finally { setSearching(false); }
    }, 300);
  }, [q, riderFetch]);

  const toggle = useCallback(async (riderId: number, follow: boolean) => {
    setResults(prev => prev.map(r => (r.id === riderId ? { ...r, following: follow } : r)));
    const r = await riderFetch(`/api/rider/follows/${riderId}`, { method: follow ? "POST" : "DELETE" });
    if (!r.ok) setResults(prev => prev.map(x => (x.id === riderId ? { ...x, following: !follow } : x)));
    loadFollowing();
  }, [loadFollowing, riderFetch]);

  const s = styles(colors, insets);
  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} style={({ pressed }) => [s.backBtn, { opacity: pressed ? 0.6 : 1 }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </Pressable>
        <Text style={s.headerTitle}>Find riders</Text>
      </View>
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <View style={s.searchBox}>
          <Feather name="search" size={16} color={colors.mutedForeground} />
          <TextInput value={q} onChangeText={setQ} placeholder="Search riders by name" placeholderTextColor={colors.mutedForeground}
            style={s.searchInput} autoCorrect={false} autoFocus returnKeyType="search" />
          {searching && <ActivityIndicator size="small" color={colors.mutedForeground} />}
        </View>
        <Text style={s.muted}>Follow friends, teammates or rivals. Their results show on your home screen, and you get a notification when their results are published.</Text>

        {results.map(r => (
          <RiderRow key={r.id} title={r.name} subtitle={[r.clubName, r.lastRaced && `Last raced ${r.lastRaced}`].filter(Boolean).join(" · ")}
            following={r.following} onToggle={() => toggle(r.id, !r.following)} onOpen={() => router.push(`/racer/${r.id}` as any)} colors={colors} />
        ))}
        {q.trim().length >= 2 && !searching && results.length === 0 && <Text style={s.muted}>No riders with published results match "{q.trim()}".</Text>}

        {following.length > 0 && <Text style={s.section}>Following</Text>}
        {following.map(f => (
          <RiderRow key={f.riderId} title={f.name} following onToggle={async () => {
            await riderFetch(`/api/rider/follows/${f.riderId}`, { method: "DELETE" }); loadFollowing();
            setResults(prev => prev.map(x => (x.id === f.riderId ? { ...x, following: false } : x)));
          }} onOpen={() => router.push(`/racer/${f.riderId}` as any)} colors={colors} />
        ))}
      </ScrollView>
    </View>
  );
}

function RiderRow({ title, subtitle, following, onToggle, onOpen, colors }: {
  title: string; subtitle?: string; following: boolean; onToggle: () => void; onOpen: () => void; colors: ReturnType<typeof useColors>;
}) {
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => ({
      flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 12, opacity: pressed ? 0.7 : 1,
      backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    })}>
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" }}>
        <Feather name="user" size={16} color={colors.mutedForeground} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, color: colors.foreground, fontFamily: "Inter_600SemiBold" }} numberOfLines={1}>{title}</Text>
        {!!subtitle && <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }} numberOfLines={1}>{subtitle}</Text>}
      </View>
      <Pressable onPress={onToggle} hitSlop={6} style={({ pressed }) => ({
        paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, opacity: pressed ? 0.7 : 1,
        backgroundColor: following ? "transparent" : ACCENT, borderWidth: 1, borderColor: following ? colors.border : ACCENT,
      })}>
        <Text style={{ fontSize: 13, color: following ? colors.foreground : "#fff", fontFamily: "Inter_700Bold" }}>{following ? "Following" : "Follow"}</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = (colors: ReturnType<typeof useColors>, insets: { bottom: number }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: 12 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" },
  content: { padding: 16, paddingBottom: insets.bottom + 32, gap: 10 },
  searchBox: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.card, borderRadius: 999, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 },
  searchInput: { flex: 1, paddingVertical: 12, color: colors.foreground, fontFamily: "Inter_400Regular" },
  section: { fontSize: 13, letterSpacing: 1.5, textTransform: "uppercase", color: colors.mutedForeground, fontFamily: "Inter_700Bold", marginTop: 10 },
  muted: { fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", lineHeight: 17 },
});
