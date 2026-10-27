import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";
import { StatsShareCard, formatLap, useShareCapture, type CareerStats } from "@/components/ShareCard";
import { parsePosition, podiumColor, podiumTextColor } from "@/components/RaceStats";
import { useTheme } from "@/context/ThemeContext";

interface Manager { id: number; email: string; joined: boolean; isYou: boolean }

/** Career stats, a shareable stats card, and who can manage this rider profile. */
export default function RiderStatsScreen() {
  const colors = useColors();
  const isDark = useTheme().resolvedScheme === "dark";
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { riderFetch } = useRiderAuth();
  const { ref: cardRef, share, sharing } = useShareCapture();

  const [name, setName] = useState("");
  const [stats, setStats] = useState<CareerStats | null>(null);
  const [managers, setManagers] = useState<Manager[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [sr, mr] = await Promise.all([
        riderFetch(`/api/rider/profiles/${id}/stats`),
        riderFetch(`/api/rider/profiles/${id}/managers`),
      ]);
      if (!sr.ok) throw new Error(((await sr.json().catch(() => ({}))) as any).error ?? `Error ${sr.status}`);
      const sj = await sr.json();
      setName(sj.name);
      setStats(sj.stats);
      if (mr.ok) {
        const mj = await mr.json();
        setManagers(mj.managers);
        setIsOwner(mj.isOwner);
      }
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [id, riderFetch]);

  useEffect(() => { (async () => { setLoading(true); await load(); setLoading(false); })(); }, [load]);

  const invite = useCallback(async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true);
    try {
      const r = await riderFetch(`/api/rider/profiles/${id}/managers`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as any).error ?? `Error ${r.status}`);
      setInviteEmail("");
      await load();
      Alert.alert("Manager added", `${email} can manage this profile after signing in to RM Roost with that email.`);
    } catch (e: any) {
      Alert.alert("Couldn't add manager", e.message);
    } finally {
      setInviting(false);
    }
  }, [id, inviteEmail, load, riderFetch]);

  const remove = useCallback((m: Manager) => {
    Alert.alert(m.isYou ? "Stop managing this profile?" : "Remove manager?",
      m.isYou ? "You'll lose access to this rider's profile." : `${m.email} will lose access to this rider's profile.`, [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: async () => {
          const r = await riderFetch(`/api/rider/profiles/${id}/managers/${m.id}`, { method: "DELETE" });
          if (!r.ok) { Alert.alert("Couldn't remove", `Error ${r.status}`); return; }
          if (m.isYou) router.back(); else load();
        } },
      ]);
  }, [id, load, riderFetch, router]);

  const s = styles(colors, insets);
  const tiles: Array<[string, string]> = stats ? [
    ["Races", String(stats.starts)],
    ["Wins", String(stats.wins)],
    ["Podiums", String(stats.podiums)],
    ["Top 5s", String(stats.top5s)],
    ["Avg finish", stats.avgFinish != null ? `P${stats.avgFinish}` : "—"],
    ["Laps", String(stats.totalLaps)],
    ["Laps led", String(stats.lapsLed)],
    ["% laps led", stats.pctLapsLed != null ? `${stats.pctLapsLed}%` : "—"],
    ["Led lap 1", String(stats.lap1Leads)],
    ["Avg lap-1 pos", stats.avgLap1Position != null ? `P${stats.avgLap1Position}` : "—"],
    ["Positions gained", `${stats.positionsGained > 0 ? "+" : ""}${stats.positionsGained}`],
    ["Best lap", stats.bestLap ? formatLap(stats.bestLap.ms) : "—"],
  ] : [];

  return (
    <View style={s.root}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} style={({ pressed }) => [s.backBtn, { opacity: pressed ? 0.6 : 1 }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </Pressable>
        <Text style={s.headerTitle} numberOfLines={1}>{name || "Rider stats"}</Text>
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator color={colors.primary} /></View>
      ) : error ? (
        <View style={s.center}><Text style={s.muted}>{error}</Text></View>
      ) : (
        <ScrollView contentContainerStyle={s.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
          <Text style={s.section}>Career stats</Text>
          {stats && stats.starts === 0 ? (
            <Text style={s.muted}>No races yet. Stats appear after your first timed moto.</Text>
          ) : (
            <View style={s.grid}>
              {tiles.map(([label, value]) => (
                <View key={label} style={[s.tile, podiumColor(parsePosition(value)) ? { borderColor: podiumColor(parsePosition(value))! } : null]}>
                  <View style={[s.tileStripe, { backgroundColor: podiumColor(parsePosition(value)) ?? colors.primary }]} />
                  <Text style={[s.tileValue, podiumTextColor(parsePosition(value), isDark) ? { color: podiumTextColor(parsePosition(value), isDark)! } : null]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
                  <Text style={s.tileLabel}>{label}</Text>
                </View>
              ))}
            </View>
          )}
          <Text style={s.note}>"Led lap 1" and laps led come from lap-by-lap timing, so they only count races with recorded laps.</Text>

          {stats && stats.starts > 0 && (
            <>
              <Text style={s.section}>Share</Text>
              <View style={{ alignItems: "center" }}>
                <StatsShareCard name={name} stats={stats} cardRef={cardRef} />
              </View>
              <Pressable onPress={() => share(`${name}'s RM Roost stats`)} disabled={sharing}
                style={({ pressed }) => [s.primaryBtn, { opacity: pressed || sharing ? 0.7 : 1 }]}>
                {sharing ? <ActivityIndicator color="#fff" /> : <Feather name="share" size={16} color="#fff" />}
                <Text style={s.primaryBtnText}>Share stats</Text>
              </Pressable>
            </>
          )}

          <Text style={s.section}>Who can manage this profile</Text>
          <Text style={s.muted}>
            {isOwner
              ? "Add a second parent or a coach. They'll see this rider's races, schedule and stats in their own RM Roost app."
              : "You're a manager of this profile. Only the profile owner can add people."}
          </Text>
          {managers.map(m => (
            <View key={m.id} style={s.managerRow}>
              <Feather name={m.joined ? "user-check" : "mail"} size={16} color={colors.mutedForeground} />
              <View style={{ flex: 1 }}>
                <Text style={s.managerEmail} numberOfLines={1}>{m.email}{m.isYou ? " (you)" : ""}</Text>
                <Text style={s.managerStatus}>{m.joined ? "Has access" : "Invited: gets access after signing in with this email"}</Text>
              </View>
              {(isOwner || m.isYou) && (
                <Pressable onPress={() => remove(m)} hitSlop={8}>
                  <Feather name="x-circle" size={18} color={colors.mutedForeground} />
                </Pressable>
              )}
            </View>
          ))}
          {isOwner && (
            <View style={s.inviteRow}>
              <TextInput value={inviteEmail} onChangeText={setInviteEmail} placeholder="Their email address"
                placeholderTextColor={colors.mutedForeground} autoCapitalize="none" keyboardType="email-address"
                autoCorrect={false} style={s.input} onSubmitEditing={invite} returnKeyType="send" />
              <Pressable onPress={invite} disabled={inviting || !inviteEmail.trim()}
                style={({ pressed }) => [s.addBtn, { opacity: pressed || inviting || !inviteEmail.trim() ? 0.6 : 1 }]}>
                {inviting ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryBtnText}>Add</Text>}
              </Pressable>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = (colors: ReturnType<typeof useColors>, insets: { bottom: number }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: 12 },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  content: { padding: 16, paddingBottom: insets.bottom + 32, gap: 12 },
  section: { fontSize: 13, letterSpacing: 1.5, textTransform: "uppercase", color: colors.mutedForeground, fontFamily: "Inter_700Bold", marginTop: 8 },
  muted: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", lineHeight: 18 },
  note: { fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", lineHeight: 15 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: { width: "31.5%", backgroundColor: colors.card, borderRadius: 14, paddingVertical: 16, paddingHorizontal: 6, alignItems: "center", borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  tileStripe: { position: "absolute", top: 0, left: 12, right: 12, height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 },
  tileValue: { fontSize: 26, color: colors.foreground, fontFamily: "Inter_700Bold", fontStyle: "italic", letterSpacing: -0.5 },
  tileLabel: { fontSize: 11, color: colors.mutedForeground, marginTop: 2, fontFamily: "Inter_500Medium", textAlign: "center" },
  primaryBtn: { flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary, borderRadius: 999, paddingVertical: 14 },
  primaryBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_700Bold" },
  managerRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.card, borderRadius: 12, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  managerEmail: { fontSize: 14, color: colors.foreground, fontFamily: "Inter_600SemiBold" },
  managerStatus: { fontSize: 11, color: colors.mutedForeground, marginTop: 2, fontFamily: "Inter_400Regular" },
  inviteRow: { flexDirection: "row", gap: 8 },
  input: { flex: 1, backgroundColor: colors.card, borderRadius: 999, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 16, paddingVertical: 12, color: colors.foreground, fontFamily: "Inter_400Regular" },
  addBtn: { backgroundColor: colors.primary, borderRadius: 999, paddingHorizontal: 20, alignItems: "center", justifyContent: "center" },
});
