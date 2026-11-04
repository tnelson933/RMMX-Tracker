/**
 * Who can manage a rider profile (a second parent or a coach), on the rider
 * screen. Moved here from the career stats screen.
 */
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, TextInput, View } from "react-native";

import { fonts } from "@/constants/fonts";
import { useColors } from "@/hooks/useColors";
import { goBack } from "@/lib/navigation";

interface Manager { id: number; email: string; joined: boolean; isYou: boolean }

export function ProfileManagers({
  riderId, riderFetch,
}: { riderId: number; riderFetch: (path: string, options?: RequestInit) => Promise<Response> }) {
  const colors = useColors();
  const router = useRouter();
  const [managers, setManagers] = useState<Manager[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await riderFetch(`/api/rider/profiles/${riderId}/managers`);
      if (r.ok) {
        const j = await r.json();
        setManagers(j.managers ?? []);
        setIsOwner(!!j.isOwner);
      }
    } finally {
      setLoaded(true);
    }
  }, [riderId, riderFetch]);
  useEffect(() => { void load(); }, [load]);

  const invite = useCallback(async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true);
    try {
      const r = await riderFetch(`/api/rider/profiles/${riderId}/managers`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `Error ${r.status}`);
      setInviteEmail("");
      await load();
      Alert.alert("Manager added", `${email} can manage this profile after signing in to RM Roost with that email.`);
    } catch (e) {
      Alert.alert("Couldn't add manager", e instanceof Error ? e.message : "Try again.");
    } finally {
      setInviting(false);
    }
  }, [riderId, inviteEmail, load, riderFetch]);

  const remove = useCallback((m: Manager) => {
    Alert.alert(m.isYou ? "Stop managing this profile?" : "Remove manager?",
      m.isYou ? "You'll lose access to this rider's profile." : `${m.email} will lose access to this rider's profile.`, [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: async () => {
          const r = await riderFetch(`/api/rider/profiles/${riderId}/managers/${m.id}`, { method: "DELETE" });
          if (!r.ok) { Alert.alert("Couldn't remove", `Error ${r.status}`); return; }
          if (m.isYou) goBack(router); else void load();
        } },
      ]);
  }, [riderId, load, riderFetch, router]);

  if (!loaded) return null;
  const muted = { fontSize: 13, color: colors.mutedForeground, fontFamily: fonts.regular, lineHeight: 18 };

  return (
    <View style={{ backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 10, marginBottom: 16 }}>
      <Text style={{ fontSize: 18, color: colors.foreground, fontFamily: fonts.displayItalic, textTransform: "uppercase" }}>Who can manage this profile</Text>
      <Text style={muted}>
        {isOwner
          ? "Add a second parent or a coach. They'll see this rider's races, schedule and stats in their own RM Roost app."
          : "You're a manager of this profile. Only the profile owner can add people."}
      </Text>
      {managers.map(m => (
        <View key={m.id} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border }}>
          <Feather name={m.joined ? "user-check" : "mail"} size={16} color={colors.mutedForeground} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, color: colors.foreground, fontFamily: fonts.semibold }} numberOfLines={1}>{m.email}{m.isYou ? " (you)" : ""}</Text>
            <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.regular, marginTop: 2 }}>
              {m.joined ? "Has access" : "Invited: gets access after signing in with this email"}
            </Text>
          </View>
          {(isOwner || m.isYou) && (
            <Pressable onPress={() => remove(m)} hitSlop={8} accessibilityRole="button" accessibilityLabel={m.isYou ? "Stop managing this profile" : `Remove ${m.email}`}>
              <Feather name="x-circle" size={18} color={colors.mutedForeground} />
            </Pressable>
          )}
        </View>
      ))}
      {isOwner && (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TextInput
            value={inviteEmail} onChangeText={setInviteEmail} placeholder="Their email address"
            placeholderTextColor={colors.mutedForeground} autoCapitalize="none" keyboardType="email-address"
            autoCorrect={false} onSubmitEditing={invite} returnKeyType="send" accessibilityLabel="Manager's email address"
            style={{ flex: 1, borderRadius: 4, borderWidth: 2, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, color: colors.foreground, fontFamily: fonts.regular, fontSize: 15 }}
          />
          <Pressable onPress={invite} disabled={inviting || !inviteEmail.trim()} accessibilityRole="button"
            style={({ pressed }) => ({ backgroundColor: colors.primary, borderRadius: 999, paddingHorizontal: 20, alignItems: "center", justifyContent: "center", opacity: pressed || inviting || !inviteEmail.trim() ? 0.6 : 1 })}>
            {inviting ? <ActivityIndicator color="#fff" /> : <Text style={{ color: "#FFFFFF", fontFamily: fonts.display, fontSize: 15, textTransform: "uppercase", letterSpacing: 1 }}>Add</Text>}
          </Pressable>
        </View>
      )}
    </View>
  );
}
