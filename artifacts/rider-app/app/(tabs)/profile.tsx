import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";

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
      fontSize: 15,
      fontWeight: "700",
      fontFamily: "Inter_700Bold",
    },
    errorBox: {
      backgroundColor: "#fef2f2",
      borderRadius: 8,
      padding: 12,
    },
    errorText: {
      color: colors.destructive,
      fontSize: 13,
      fontFamily: "Inter_500Medium",
    },
    toggle: {
      flexDirection: "row",
      justifyContent: "center",
      gap: 4,
      marginTop: 8,
    },
    toggleText: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
    },
    toggleLink: {
      fontSize: 13,
      color: colors.primary,
      fontFamily: "Inter_600SemiBold",
    },
  });

  return (
    <View style={s.container}>
      <View style={s.logo}>
        <Feather name="flag" size={26} color="#fff" />
      </View>
      <Text style={s.title}>{mode === "login" ? "Welcome back" : "Create account"}</Text>
      <Text style={s.subtitle}>
        {mode === "login"
          ? "Sign in to view your race history and get notifications."
          : "Create an account to track your results and get race alerts."}
      </Text>

      <View style={s.inputWrapper}>
        <TextInput
          style={s.input}
          value={email}
          onChangeText={setEmail}
          placeholder="Email address"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          keyboardType="email-address"
          autoCorrect={false}
          returnKeyType="next"
        />
      </View>

      <View style={s.inputWrapper}>
        <TextInput
          style={s.input}
          value={password}
          onChangeText={setPassword}
          placeholder={mode === "register" ? "Password (8+ characters)" : "Password"}
          placeholderTextColor={colors.mutedForeground}
          secureTextEntry={!showPassword}
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
        />
        <Pressable onPress={() => setShowPassword(!showPassword)} hitSlop={10}>
          <Feather
            name={showPassword ? "eye-off" : "eye"}
            size={18}
            color={colors.mutedForeground}
          />
        </Pressable>
      </View>

      {error && (
        <View style={s.errorBox}>
          <Text style={s.errorText}>{error}</Text>
        </View>
      )}

      <Pressable
        style={[s.btn, (!email.trim() || !password || loading) && s.btnDisabled]}
        onPress={handleSubmit}
        disabled={!email.trim() || !password || loading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={s.btnText}>{mode === "login" ? "Sign In" : "Create Account"}</Text>
        )}
      </Pressable>

      <View style={s.toggle}>
        <Text style={s.toggleText}>
          {mode === "login" ? "Don't have an account?" : "Already have an account?"}
        </Text>
        <Pressable onPress={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}>
          <Text style={s.toggleLink}>{mode === "login" ? "Sign up" : "Sign in"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function ProfileScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { account, profiles, isAuthenticated, isLoading, logout } = useRiderAuth();
  const [loggingOut, setLoggingOut] = useState(false);

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: {
      paddingTop: insets.top + 16,
      paddingHorizontal: 20,
      paddingBottom: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    headerTitle: {
      fontSize: 26,
      fontWeight: "800",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
      letterSpacing: -0.5,
    },
    content: { padding: 20, gap: 16 },
    avatar: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarText: {
      fontSize: 24,
      fontWeight: "700",
      color: "#fff",
      fontFamily: "Inter_700Bold",
    },
    profileSection: {
      flexDirection: "row",
      alignItems: "center",
      gap: 16,
      backgroundColor: colors.card,
      padding: 16,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    profileInfo: { flex: 1 },
    profileEmail: {
      fontSize: 15,
      fontWeight: "600",
      color: colors.foreground,
      fontFamily: "Inter_600SemiBold",
    },
    profileRole: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 2,
    },
    riderCard: {
      backgroundColor: colors.card,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      padding: 16,
    },
    cardLabel: {
      fontSize: 11,
      color: colors.mutedForeground,
      fontFamily: "Inter_600SemiBold",
      textTransform: "uppercase",
      letterSpacing: 0.8,
      marginBottom: 10,
    },
    riderName: {
      fontSize: 17,
      fontWeight: "700",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
    },
    riderMeta: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 2,
    },
    statsRow: { flexDirection: "row", gap: 10, marginTop: 12 },
    statBox: {
      flex: 1,
      backgroundColor: colors.muted,
      borderRadius: 8,
      padding: 10,
      alignItems: "center",
    },
    statValue: {
      fontSize: 18,
      fontWeight: "700",
      color: colors.primary,
      fontFamily: "Inter_700Bold",
    },
    statLabel: {
      fontSize: 10,
      color: colors.mutedForeground,
      fontFamily: "Inter_500Medium",
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginTop: 1,
    },
    logoutBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: colors.muted,
      paddingVertical: 14,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    logoutText: {
      fontSize: 15,
      fontWeight: "600",
      color: colors.destructive,
      fontFamily: "Inter_600SemiBold",
    },
    footer: { height: insets.bottom + 16 },
  });

  if (isLoading) {
    return (
      <View style={[styles.container, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!isAuthenticated) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={{ flex: 1 }}
        >
          <ScrollView keyboardShouldPersistTaps="handled">
            <View style={styles.header}>
              <Text style={styles.headerTitle}>Profile</Text>
            </View>
            <AuthForm />
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  const primaryProfile = profiles[0];
  const initials = account?.email?.slice(0, 2).toUpperCase() ?? "?";

  async function handleLogout() {
    Alert.alert("Sign out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          setLoggingOut(true);
          await logout();
          setLoggingOut(false);
        },
      },
    ]);
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Profile</Text>
      </View>

      <View style={styles.content}>
        <View style={styles.profileSection}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.profileEmail}>{account?.email}</Text>
            <Text style={styles.profileRole}>Rider Account</Text>
          </View>
        </View>

        {primaryProfile && (
          <View style={styles.riderCard}>
            <Text style={styles.cardLabel}>Rider Profile</Text>
            <Text style={styles.riderName}>
              {primaryProfile.firstName} {primaryProfile.lastName}
            </Text>
            {primaryProfile.bibNumber && (
              <Text style={styles.riderMeta}>Bib #{primaryProfile.bibNumber}</Text>
            )}
            <View style={styles.statsRow}>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>{primaryProfile.eventsRaced}</Text>
                <Text style={styles.statLabel}>Events</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>{primaryProfile.totalPoints}</Text>
                <Text style={styles.statLabel}>Points</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>
                  {primaryProfile.bestPosition != null ? `P${primaryProfile.bestPosition}` : "—"}
                </Text>
                <Text style={styles.statLabel}>Best</Text>
              </View>
            </View>
          </View>
        )}

        {profiles.length === 0 && (
          <View style={styles.riderCard}>
            <Text style={styles.cardLabel}>Rider Profile</Text>
            <Text style={{ color: colors.mutedForeground, fontFamily: "Inter_400Regular", fontSize: 14 }}>
              No rider profile linked yet. Register for an event using this email address to link your profile.
            </Text>
          </View>
        )}

        <Pressable
          style={styles.logoutBtn}
          onPress={handleLogout}
          disabled={loggingOut}
        >
          <Feather name="log-out" size={16} color={colors.destructive} />
          <Text style={styles.logoutText}>
            {loggingOut ? "Signing out…" : "Sign Out"}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
