import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";

/**
 * Shown when the signed-in account links to no rider profile. Names the email
 * that's signed in, because the usual cause is signing up with a different (or
 * mistyped) email than the one used to register for races, and offers a quick
 * way to switch accounts.
 */
export function NoProfileLinked({ variant = "screen" }: { variant?: "screen" | "card" }) {
  const colors = useColors();
  const router = useRouter();
  const { account, logout, refreshProfiles } = useRiderAuth();
  const [checking, setChecking] = useState(false);
  const card = variant === "card";

  // A profile links as soon as a race registration uses this email, so let the
  // rider re-check without signing out or restarting the app.
  async function checkAgain() {
    setChecking(true);
    try { await refreshProfiles(); } finally { setChecking(false); }
  }

  async function switchAccount() {
    await logout();
    router.replace("/login" as any);
  }

  return (
    <View
      style={card
        ? { marginHorizontal: 16, marginBottom: 24, borderRadius: 14, backgroundColor: colors.card, padding: 20, alignItems: "center", gap: 8, borderWidth: 1, borderColor: colors.border }
        : { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8, backgroundColor: colors.background }}
    >
      <Feather name="user-x" size={card ? 32 : 40} color={colors.mutedForeground} />
      <Text style={{ fontSize: card ? 15 : 18, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>
        No rider profile linked
      </Text>
      {account?.email ? (
        <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>
          Signed in as <Text style={{ fontFamily: "Inter_700Bold", color: colors.foreground }}>{account.email}</Text>
        </Text>
      ) : null}
      <Text style={{ fontSize: card ? 13 : 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: card ? 18 : 20 }}>
        Profiles link by email. If you've raced before, you probably registered with a different email: sign in with that one instead. New rider? Register for an event with this email.
      </Text>
      <Pressable
        onPress={switchAccount}
        style={{ marginTop: 6, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.primary }}
      >
        <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700", fontFamily: "Inter_700Bold" }}>Sign in with a different email</Text>
      </Pressable>
      <Pressable onPress={checkAgain} disabled={checking} style={{ paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 6 }}>
        {checking && <ActivityIndicator size="small" color={colors.mutedForeground} />}
        <Text style={{ color: colors.foreground, fontSize: 13, fontFamily: "Inter_600SemiBold", textDecorationLine: "underline" }}>
          {checking ? "Checking…" : "Just registered? Check again"}
        </Text>
      </Pressable>
    </View>
  );
}
