import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";

// ─── Auth form (shown when logged out) ──────────────────────────────────────

function AuthForm() {
  const colors = useColors();
  const { login, register } = useRiderAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit() {
    if (!email.trim() || !password) return;
    setLoading(true);
    setError(null);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await register(email, password);
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      setError(e.message);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }

  const s = StyleSheet.create({
    container: { padding: 24, gap: 12 },
    logo: {
      width: 52,
      height: 52,
      borderRadius: 14,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 8,
    },
    title: {
      fontSize: 26,
      fontWeight: "800",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
      letterSpacing: -0.5,
    },
    subtitle: {
      fontSize: 14,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginBottom: 8,
    },
    inputWrapper: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.muted,
      borderRadius: 10,
      paddingHorizontal: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    input: {
      flex: 1,
      paddingVertical: 14,
      fontSize: 15,
      color: colors.foreground,
      fontFamily: "Inter_400Regular",
    },
    btn: {
      backgroundColor: colors.primary,
      paddingVertical: 14,
      borderRadius: 10,
      alignItems: "center",
      marginTop: 4,
    },
    btnDisabled: { opacity: 0.5 },
    btnText: {
      color: "#fff",
      fontWeight: "700",
      fontSize: 15,
      fontFamily: "Inter_700Bold",
    },
    switchRow: { flexDirection: "row", justifyContent: "center", gap: 6, marginTop: 4 },
    switchText: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular" },
    switchLink: { fontSize: 13, color: colors.primary, fontFamily: "Inter_600SemiBold" },
    error: {
      backgroundColor: "#FEE2E2",
      borderRadius: 8,
      padding: 12,
      fontSize: 13,
      color: "#DC2626",
      fontFamily: "Inter_400Regular",
    },
  });

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
        <View style={s.logo}>
          <Feather name="user" size={24} color="#fff" />
        </View>
        <Text style={s.title}>{mode === "login" ? "Rider Login" : "Create Account"}</Text>
        <Text style={s.subtitle}>
          {mode === "login"
            ? "Sign in to view your race history and profile."
            : "Create an account to track your races."}
        </Text>

        {error && <Text style={s.error}>{error}</Text>}

        <View style={s.inputWrapper}>
          <Feather name="mail" size={16} color={colors.mutedForeground} style={{ marginRight: 8 }} />
          <TextInput
            style={s.input}
            placeholder="Email address"
            placeholderTextColor={colors.mutedForeground}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoCorrect={false}
          />
        </View>

        <View style={s.inputWrapper}>
          <Feather name="lock" size={16} color={colors.mutedForeground} style={{ marginRight: 8 }} />
          <TextInput
            style={s.input}
            placeholder="Password"
            placeholderTextColor={colors.mutedForeground}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
          />
          <Pressable onPress={() => setShowPassword((v) => !v)}>
            <Feather name={showPassword ? "eye-off" : "eye"} size={16} color={colors.mutedForeground} />
          </Pressable>
        </View>

        <Pressable
          style={[s.btn, (loading || !email.trim() || !password) && s.btnDisabled]}
          onPress={handleSubmit}
          disabled={loading || !email.trim() || !password}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={s.btnText}>{mode === "login" ? "Sign In" : "Create Account"}</Text>
          )}
        </Pressable>

        <View style={s.switchRow}>
          <Text style={s.switchText}>
            {mode === "login" ? "Don't have an account?" : "Already have an account?"}
          </Text>
          <Pressable onPress={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}>
            <Text style={s.switchLink}>{mode === "login" ? "Sign up" : "Sign in"}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Profile list (shown when logged in) ────────────────────────────────────

function ProfileList() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { account, profiles, logout, refreshProfiles } = useRiderAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    await refreshProfiles();
    setRefreshing(false);
  }

  function handleSignOut() {
    Alert.alert("Sign Out", "Sign out of your rider account?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          setLoggingOut(true);
          await logout();
          setLoggingOut(false);
        },
      },
    ]);
  }

  const s = StyleSheet.create({
    scroll: { flex: 1 },
    container: {
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: insets.bottom + 24,
      gap: 16,
    },
    pageTitle: {
      fontSize: 26,
      fontWeight: "800",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
      letterSpacing: -0.5,
    },
    pageSubtitle: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 2,
    },
    accountCard: {
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    accountIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.primary + "20",
      alignItems: "center",
      justifyContent: "center",
    },
    accountEmail: {
      fontSize: 14,
      fontWeight: "600",
      color: colors.foreground,
      fontFamily: "Inter_600SemiBold",
    },
    accountLabel: {
      fontSize: 11,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginBottom: 2,
    },
    sectionLabel: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.mutedForeground,
      fontFamily: "Inter_700Bold",
      letterSpacing: 0.8,
      textTransform: "uppercase",
      marginBottom: 2,
    },
    profileCard: {
      backgroundColor: colors.card,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: "hidden",
    },
    profileCardInner: {
      padding: 16,
    },
    profileRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    profileLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
    profileAvatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.primary + "15",
      alignItems: "center",
      justifyContent: "center",
    },
    profileName: {
      fontSize: 16,
      fontWeight: "700",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
    },
    profileBib: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 1,
    },
    statsRow: {
      flexDirection: "row",
      marginTop: 12,
      gap: 8,
    },
    statBox: {
      flex: 1,
      backgroundColor: colors.muted,
      borderRadius: 8,
      padding: 10,
      alignItems: "center",
    },
    statLabel: {
      fontSize: 10,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginBottom: 2,
    },
    statValue: {
      fontSize: 18,
      fontWeight: "800",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
    },
    statValuePrimary: {
      fontSize: 18,
      fontWeight: "800",
      color: colors.primary,
      fontFamily: "Inter_700Bold",
    },
    lastRaced: {
      fontSize: 11,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 8,
    },
    addBtn: {
      backgroundColor: colors.muted,
      borderRadius: 14,
      padding: 16,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderStyle: "dashed",
    },
    addBtnText: {
      fontSize: 14,
      color: colors.mutedForeground,
      fontFamily: "Inter_600SemiBold",
    },
    signOutBtn: {
      backgroundColor: colors.muted,
      borderRadius: 14,
      padding: 14,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    signOutText: {
      fontSize: 14,
      color: "#DC2626",
      fontFamily: "Inter_600SemiBold",
    },
    emptyBox: {
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 32,
      alignItems: "center",
      gap: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    emptyTitle: {
      fontSize: 16,
      fontWeight: "700",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
    },
    emptyText: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      textAlign: "center",
    },
    infoCard: {
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      gap: 4,
    },
    infoTitle: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.mutedForeground,
      fontFamily: "Inter_700Bold",
      textTransform: "uppercase",
      letterSpacing: 0.6,
      marginBottom: 4,
    },
    infoText: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      lineHeight: 18,
    },
  });

  return (
    <ScrollView
      style={s.scroll}
      contentContainerStyle={s.container}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
    >
      {/* Account section */}
      <View>
        <Text style={s.pageTitle}>My Profiles</Text>
        <Text style={s.pageSubtitle}>All rider profiles linked to your account</Text>
      </View>

      <View style={s.accountCard}>
        <View style={s.accountIcon}>
          <Feather name="mail" size={18} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.accountLabel}>Account Email</Text>
          <Text style={s.accountEmail} numberOfLines={1}>{account?.email}</Text>
        </View>
      </View>

      {/* Rider profiles */}
      <View style={{ gap: 4 }}>
        <Text style={s.sectionLabel}>Rider Profiles</Text>
      </View>

      {profiles.length === 0 ? (
        <View style={s.emptyBox}>
          <Feather name="user" size={36} color={colors.mutedForeground + "50"} />
          <Text style={s.emptyTitle}>No Rider Profiles</Text>
          <Text style={s.emptyText}>
            No profiles linked yet. Register for an event with this email or add a profile manually.
          </Text>
        </View>
      ) : (
        profiles.map((profile) => (
          <Pressable
            key={profile.id}
            style={s.profileCard}
            onPress={() => router.push(`/rider/${profile.id}` as any)}
          >
            <View style={s.profileCardInner}>
              <View style={s.profileRow}>
                <View style={s.profileLeft}>
                  <View style={s.profileAvatar}>
                    <Feather name="user" size={20} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.profileName}>
                      {profile.firstName} {profile.lastName}
                    </Text>
                    <Text style={s.profileBib}>
                      {profile.bibNumber ? `#${profile.bibNumber}` : "No bib number"}
                    </Text>
                  </View>
                </View>
                <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
              </View>

              <View style={s.statsRow}>
                <View style={s.statBox}>
                  <Text style={s.statLabel}>Events</Text>
                  <Text style={s.statValue}>{profile.eventsRaced}</Text>
                </View>
                <View style={s.statBox}>
                  <Text style={s.statLabel}>Best Finish</Text>
                  <Text style={s.statValue}>
                    {profile.bestPosition ? `P${profile.bestPosition}` : "—"}
                  </Text>
                </View>
                <View style={s.statBox}>
                  <Text style={s.statLabel}>Points</Text>
                  <Text style={s.statValuePrimary}>{profile.totalPoints}</Text>
                </View>
              </View>

              {profile.lastRaced && (
                <Text style={s.lastRaced}>
                  Last raced:{" "}
                  {new Date(profile.lastRaced).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </Text>
              )}
            </View>
          </Pressable>
        ))
      )}

      {/* Add profile */}
      <Pressable style={s.addBtn} onPress={() => router.push("/rider/new" as any)}>
        <Feather name="user-plus" size={16} color={colors.mutedForeground} />
        <Text style={s.addBtnText}>Add Rider Profile</Text>
      </Pressable>

      {/* How profiles are linked info */}
      <View style={s.infoCard}>
        <Text style={s.infoTitle}>How profiles are linked</Text>
        <Text style={s.infoText}>
          Rider profiles are automatically linked by email address. If you register a family member using this email, their profile will also appear here as a separate entry.
        </Text>
      </View>

      {/* Sign out */}
      <Pressable
        style={s.signOutBtn}
        onPress={handleSignOut}
        disabled={loggingOut}
      >
        {loggingOut ? (
          <ActivityIndicator color="#DC2626" size="small" />
        ) : (
          <>
            <Feather name="log-out" size={16} color="#DC2626" />
            <Text style={s.signOutText}>Sign Out</Text>
          </>
        )}
      </Pressable>
    </ScrollView>
  );
}

// ─── Root screen ─────────────────────────────────────────────────────────────

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const { isAuthenticated, isLoading } = useRiderAuth();

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}>
      {isAuthenticated ? <ProfileList /> : <AuthForm />}
    </View>
  );
}
