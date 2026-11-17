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
  const { account, logout, refreshProfiles, profilesStatus } = useRiderAuth();
  const [checking, setChecking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const card = variant === "card";

  // A profile links as soon as a race registration uses this email, so let the
  // rider re-check without signing out or restarting the app.
  async function checkAgain() {
    setChecking(true);
    try { await refreshProfiles(); } finally { setChecking(false); }
  }

  // Signing out tells the server first, which can take a few seconds on a weak signal.
  async function switchAccount() {
    if (switching) return;
    setSwitching(true);
    try {
      await logout();
      router.replace("/login" as any);
    } catch {
      setSwitching(false);
    }
  }

  const boxStyle = card
    ? { marginHorizontal: 16, marginBottom: 24, borderRadius: 14, backgroundColor: colors.card, padding: 20, alignItems: "center" as const, gap: 8, borderWidth: 1, borderColor: colors.border }
    : { flex: 1, alignItems: "center" as const, justifyContent: "center" as const, padding: 32, gap: 8, backgroundColor: colors.background };

  // The rider list is still loading (right after sign-in or at launch): don't
  // claim the account has no riders yet.
  if (profilesStatus === "loading") {
    return (
      <View style={boxStyle} accessibilityLabel="Loading your riders">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  // The list couldn't be fetched (no signal, server trouble): say so and offer a retry.
  if (profilesStatus === "failed") {
    return (
      <View style={boxStyle}>
        <Feather name="wifi-off" size={card ? 32 : 40} color={colors.mutedForeground} />
        <Text style={{ fontSize: card ? 15 : 18, fontWeight: "700", color: colors.foreground, fontFamily: "Roboto_700Bold", textAlign: "center" }}>
          Couldn't load your riders
        </Text>
        <Text style={{ fontSize: card ? 13 : 14, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", textAlign: "center", lineHeight: card ? 18 : 20 }}>
          RM Roost couldn't be reached. Check that you have signal or Wi-Fi, then try again.
        </Text>
        <Pressable
          onPress={checkAgain}
          disabled={checking}
          accessibilityRole="button"
          style={{ marginTop: 6, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.primary, flexDirection: "row", alignItems: "center", gap: 8, opacity: checking ? 0.7 : 1 }}
        >
          {checking && <ActivityIndicator size="small" color="#fff" />}
          <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700", fontFamily: "Roboto_700Bold" }}>{checking ? "Trying…" : "Try again"}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={boxStyle}>
      <Feather name="user-x" size={card ? 32 : 40} color={colors.mutedForeground} />
      <Text style={{ fontSize: card ? 15 : 18, fontWeight: "700", color: colors.foreground, fontFamily: "Roboto_700Bold", textAlign: "center" }}>
        No rider profile linked
      </Text>
      {account?.email ? (
        <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", textAlign: "center" }}>
          Signed in as <Text style={{ fontFamily: "Roboto_700Bold", color: colors.foreground }}>{account.email}</Text>
        </Text>
      ) : null}
      <Text style={{ fontSize: card ? 13 : 14, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", textAlign: "center", lineHeight: card ? 18 : 20 }}>
        Profiles link by email. If you've raced before, you probably registered with a different email: sign in with that one instead. New rider? Register for an event with this email.
      </Text>
      <Pressable
        onPress={switchAccount}
        disabled={switching}
        accessibilityRole="button"
        style={{ marginTop: 6, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.primary, flexDirection: "row", alignItems: "center", gap: 8, opacity: switching ? 0.7 : 1 }}
      >
        {switching && <ActivityIndicator size="small" color="#fff" />}
        <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700", fontFamily: "Roboto_700Bold" }}>{switching ? "Signing out…" : "Sign in with a different email"}</Text>
      </Pressable>
      <Pressable onPress={checkAgain} disabled={checking} style={{ paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 6 }}>
        {checking && <ActivityIndicator size="small" color={colors.mutedForeground} />}
        <Text style={{ color: colors.foreground, fontSize: 13, fontFamily: "Roboto_600SemiBold", textDecorationLine: "underline" }}>
          {checking ? "Checking…" : "Just registered? Check again"}
        </Text>
      </Pressable>
    </View>
  );
}
