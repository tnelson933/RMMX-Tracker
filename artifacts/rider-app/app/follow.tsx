import { Feather } from "@expo/vector-icons";
import { RiderAvatar } from "@/components/RiderPhoto";
import { useBottomSpace } from "@/hooks/useBottomSpace";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";
import { NETWORK_ERROR_MESSAGE } from "@/lib/friendlyErrors";
import { goBack } from "@/lib/navigation";
import { displayDate } from "@/lib/format";

interface FoundRider { id: number; name: string; avatarUrl?: string | null; lastRaced: string | null; clubName: string | null; following: boolean }
interface Followed { riderId: number; name: string; avatarUrl?: string | null; raceAlerts?: boolean }
interface Suggested { id: number; name: string; avatarUrl?: string | null; number?: string | null; state?: string | null; reason?: string | null }
interface Suggestions { competitors?: Suggested[]; nearby?: Suggested[]; top?: Suggested[] }

const SUGGESTION_SECTIONS: Array<{ key: keyof Suggestions; title: string }> = [
  { key: "competitors", title: "Riders you race against" },
  { key: "nearby", title: "Riders near you" },
  { key: "top", title: "Top riders" },
];

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
  const [searchError, setSearchError] = useState<string | null>(null);
  const [followingError, setFollowingError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only the newest search may fill the list; one follow/unfollow per rider at a time.
  const searchSeq = useRef(0);
  const toggling = useRef(new Set<number>());
  // Who to follow, shown while the search box is empty. Missing on older servers: the sections just don't show.
  const [suggestions, setSuggestions] = useState<Suggestions>({});
  const [followedSuggestions, setFollowedSuggestions] = useState<Set<number>>(new Set());

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await riderFetch("/api/rider/riders/suggested");
        if (!r.ok) return;
        const body = await r.json();
        const list = (v: unknown): Suggested[] => (Array.isArray(v) ? v.filter(x => x && typeof x.id === "number" && typeof x.name === "string") : []);
        if (alive) setSuggestions({ competitors: list(body?.competitors), nearby: list(body?.nearby), top: list(body?.top) });
      } catch { /* suggestions are optional */ }
    })();
    return () => { alive = false; };
  }, [riderFetch]);

  const loadFollowing = useCallback(async () => {
    try {
      const r = await riderFetch("/api/rider/follows");
      if (!r.ok) { setFollowingError(`Couldn't load who you follow (error ${r.status}).`); return; }
      const list = (await r.json()).following;
      setFollowing(Array.isArray(list) ? list : []);
      setFollowingError(null);
    } catch {
      setFollowingError(NETWORK_ERROR_MESSAGE);
    }
  }, [riderFetch]);
  useEffect(() => { void loadFollowing(); }, [loadFollowing]);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    const seq = ++searchSeq.current;
    if (q.trim().length < 2) { setResults([]); setSearchError(null); setSearching(false); return; }
    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await riderFetch(`/api/rider/riders/search?q=${encodeURIComponent(q.trim())}`);
        // A slower answer for an earlier search must not replace a newer one.
        if (seq !== searchSeq.current) return;
        if (!r.ok) { setSearchError(`Search failed (error ${r.status}). Try again.`); return; }
        const found = (await r.json()).riders;
        if (seq !== searchSeq.current) return;
        setResults(Array.isArray(found) ? found : []);
        setSearchError(null);
      } catch {
        if (seq === searchSeq.current) setSearchError(NETWORK_ERROR_MESSAGE);
      } finally { if (seq === searchSeq.current) setSearching(false); }
    }, 300);
  }, [q, riderFetch]);

  const toggle = useCallback(async (riderId: number, follow: boolean) => {
    if (toggling.current.has(riderId)) return;
    toggling.current.add(riderId);
    const mark = (on: boolean) => {
      setResults(prev => prev.map(r => (r.id === riderId ? { ...r, following: on } : r)));
      setFollowedSuggestions(prev => { const next = new Set(prev); if (on) next.add(riderId); else next.delete(riderId); return next; });
    };
    mark(follow);
    const rollback = () => mark(!follow);
    try {
      const r = await riderFetch(`/api/rider/follows/${riderId}`, { method: follow ? "POST" : "DELETE" });
      if (!r.ok) { rollback(); Alert.alert(follow ? "Couldn't follow" : "Couldn't unfollow", `Try again (error ${r.status}).`); }
    } catch {
      rollback();
      Alert.alert(follow ? "Couldn't follow" : "Couldn't unfollow", NETWORK_ERROR_MESSAGE);
    } finally {
      toggling.current.delete(riderId);
    }
    void loadFollowing();
  }, [loadFollowing, riderFetch]);

  const unfollow = useCallback(async (riderId: number) => {
    // Optimistic: drop from the list, restore on failure.
    const before = following;
    setFollowing(prev => prev.filter(f => f.riderId !== riderId));
    try {
      const r = await riderFetch(`/api/rider/follows/${riderId}`, { method: "DELETE" });
      if (!r.ok) { setFollowing(before); Alert.alert("Couldn't unfollow", `Try again (error ${r.status}).`); return; }
      setResults(prev => prev.map(x => (x.id === riderId ? { ...x, following: false } : x)));
      setFollowedSuggestions(prev => { const next = new Set(prev); next.delete(riderId); return next; });
    } catch {
      setFollowing(before);
      Alert.alert("Couldn't unfollow", NETWORK_ERROR_MESSAGE);
      return;
    }
    void loadFollowing();
  }, [following, loadFollowing, riderFetch]);

  // "About to start their race" pushes for one followed rider. Optimistic, restored on failure.
  const setRaceAlerts = useCallback(async (riderId: number, on: boolean) => {
    const flip = (value: boolean) => setFollowing(prev => prev.map(f => (f.riderId === riderId ? { ...f, raceAlerts: value } : f)));
    flip(on);
    try {
      const r = await riderFetch(`/api/rider/follows/${riderId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raceAlerts: on }),
      });
      if (!r.ok) { flip(!on); Alert.alert("Couldn't change race alerts", `Try again (error ${r.status}).`); }
    } catch {
      flip(!on);
      Alert.alert("Couldn't change race alerts", NETWORK_ERROR_MESSAGE);
    }
  }, [riderFetch]);

  const bottomSpace = useBottomSpace();
  const s = styles(colors, { bottom: bottomSpace });
  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => goBack(router)} accessibilityRole="button" accessibilityLabel="Back" style={({ pressed }) => [s.backBtn, { opacity: pressed ? 0.6 : 1 }]}>
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
        <Text style={s.muted}>Follow friends, teammates or rivals. Their results show on your home screen. You get a notification when they're about to start a race (turn it off with the bell) and when their results are official.</Text>

        {results.map(r => (
          <RiderRow key={r.id} title={r.name} avatarUrl={r.avatarUrl} subtitle={[r.clubName, r.lastRaced && `Last raced ${displayDate(r.lastRaced).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`].filter(Boolean).join(" · ")}
            following={r.following} onToggle={() => toggle(r.id, !r.following)} onOpen={() => router.push(`/racer/${r.id}` as any)} colors={colors} />
        ))}
        {searchError && q.trim().length >= 2 && !searching && <Text style={[s.muted, { color: "#DC2626" }]}>{searchError}</Text>}
        {q.trim().length >= 2 && !searching && !searchError && results.length === 0 && <Text style={s.muted}>No riders with results match "{q.trim()}".</Text>}

        {q.trim().length === 0 && SUGGESTION_SECTIONS.map(section => {
          const riders = suggestions[section.key] ?? [];
          if (riders.length === 0) return null;
          return (
            <React.Fragment key={section.key}>
              <Text style={s.section}>{section.title}</Text>
              {riders.map(r => {
                const isFollowing = followedSuggestions.has(r.id);
                return (
                  <RiderRow key={r.id} title={r.name} avatarUrl={r.avatarUrl} subtitle={[r.number ? `#${r.number}` : null, r.reason].filter(Boolean).join(" · ")}
                    following={isFollowing} onToggle={() => { void toggle(r.id, !isFollowing); }} onOpen={() => router.push(`/racer/${r.id}` as any)} colors={colors} />
                );
              })}
            </React.Fragment>
          );
        })}

        {(following.length > 0 || followingError) && <Text style={s.section}>Following</Text>}
        {followingError && (
          <Pressable onPress={() => { void loadFollowing(); }}>
            <Text style={[s.muted, { color: "#DC2626" }]}>{followingError} Tap to retry.</Text>
          </Pressable>
        )}
        {following.map(f => (
          <RiderRow key={f.riderId} title={f.name} avatarUrl={f.avatarUrl} following onToggle={() => { void unfollow(f.riderId); }}
            raceAlerts={f.raceAlerts !== false} onRaceAlerts={on => { void setRaceAlerts(f.riderId, on); }}
            onOpen={() => router.push(`/racer/${f.riderId}` as any)} colors={colors} />
        ))}
      </ScrollView>
    </View>
  );
}

function RiderRow({ title, subtitle, following, onToggle, onOpen, colors, avatarUrl, raceAlerts, onRaceAlerts }: {
  title: string; subtitle?: string; following: boolean; onToggle: () => void; onOpen: () => void; colors: ReturnType<typeof useColors>; avatarUrl?: string | null;
  raceAlerts?: boolean; onRaceAlerts?: (on: boolean) => void;
}) {
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => ({
      flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 12, opacity: pressed ? 0.7 : 1,
      backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    })}>
      <RiderAvatar url={avatarUrl} name={title} size={36} background={colors.muted} color={colors.mutedForeground} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, color: colors.foreground, fontFamily: "Roboto_600SemiBold" }} numberOfLines={1}>{title}</Text>
        {!!subtitle && <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }} numberOfLines={1}>{subtitle}</Text>}
      </View>
      {onRaceAlerts && (
        <Pressable onPress={() => onRaceAlerts(!raceAlerts)} hitSlop={6} accessibilityRole="switch"
          accessibilityState={{ checked: !!raceAlerts }}
          accessibilityLabel={`Notify me when ${title} is about to race`}
          style={({ pressed }) => ({ width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.6 : 1, backgroundColor: colors.muted })}>
          <Feather name={raceAlerts ? "bell" : "bell-off"} size={16} color={raceAlerts ? colors.foreground : colors.mutedForeground} />
        </Pressable>
      )}
      <Pressable onPress={onToggle} hitSlop={6} style={({ pressed }) => ({
        paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, opacity: pressed ? 0.7 : 1,
        backgroundColor: following ? "transparent" : colors.primary, borderWidth: 1, borderColor: following ? colors.border : colors.primary,
      })}>
        <Text style={{ fontSize: 13, color: following ? colors.foreground : "#fff", fontFamily: "Roboto_700Bold" }}>{following ? "Following" : "Follow"}</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = (colors: ReturnType<typeof useColors>, insets: { bottom: number }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: 12 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: "700", color: colors.foreground, fontFamily: "Roboto_700Bold" },
  content: { padding: 16, paddingBottom: insets.bottom, gap: 10 },
  searchBox: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.card, borderRadius: 999, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 },
  searchInput: { flex: 1, paddingVertical: 12, color: colors.foreground, fontFamily: "Roboto_400Regular" },
  section: { fontSize: 14, letterSpacing: 1.5, textTransform: "uppercase", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", marginTop: 10 },
  muted: { fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", lineHeight: 17 },
});
