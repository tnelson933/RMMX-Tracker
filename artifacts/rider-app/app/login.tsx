import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
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
      router.replace("/(tabs)" as any);
    } catch (e: any) {
      setError(e.message ?? "Something went wrong");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }

  const s = StyleSheet.create({
    container: {
      flexGrow: 1,
      backgroundColor: colors.background,
      paddingTop: insets.top + 40,
      paddingBottom: insets.bottom + 32,
      paddingHorizontal: 28,
    },
    logoRow: { alignItems: "center", marginBottom: 36 },
    logoBox: {
      width: 72, height: 72, borderRadius: 20,
      backgroundColor: colors.primary,
      alignItems: "center", justifyContent: "center",
      marginBottom: 16,
    },
    appName: {
      fontSize: 28, fontWeight: "800", color: colors.foreground,
      fontFamily: "Inter_700Bold", letterSpacing: -0.5, textAlign: "center",
    },
    tagline: {
      fontSize: 14, color: colors.mutedForeground,
      fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 4,
    },
    tabRow: {
      flexDirection: "row", backgroundColor: colors.muted,
      borderRadius: 10, padding: 3, marginBottom: 24,
    },
    tab: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: "center" },
    tabActive: { backgroundColor: colors.card },
    tabText: { fontSize: 14, fontWeight: "600", color: colors.mutedForeground, fontFamily: "Inter_600SemiBold" },
    tabTextActive: { color: colors.foreground },
    inputWrapper: {
      flexDirection: "row", alignItems: "center",
      backgroundColor: colors.muted, borderRadius: 10,
      paddingHorizontal: 14, borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border, marginBottom: 12,
    },
    input: {
      flex: 1, paddingVertical: 14,
      fontSize: 15, color: colors.foreground,
      fontFamily: "Inter_400Regular",
    },
    btn: {
      backgroundColor: colors.primary, paddingVertical: 16,
      borderRadius: 10, alignItems: "center", marginTop: 8,
    },
    btnDisabled: { opacity: 0.5 },
    btnText: { color: "#fff", fontWeight: "700", fontSize: 16, fontFamily: "Inter_700Bold" },
    error: {
      backgroundColor: "#FEE2E2", borderRadius: 8, padding: 12,
      fontSize: 13, color: "#DC2626", fontFamily: "Inter_400Regular", marginBottom: 12,
    },
    footer: {
      marginTop: 24, alignItems: "center", gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
      paddingTop: 24,
    },
    footerText: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 18 },
  });

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
        {/* Logo + name */}
        <View style={s.logoRow}>
          <View style={s.logoBox}>
            <Feather name="flag" size={30} color="#fff" />
          </View>
          <Text style={s.appName}>RM Tracker</Text>
          <Text style={s.tagline}>Your race schedule, results & more</Text>
        </View>

        {/* Login / Register tab toggle */}
        <View style={s.tabRow}>
          <Pressable style={[s.tab, mode === "login" && s.tabActive]} onPress={() => { setMode("login"); setError(null); }}>
            <Text style={[s.tabText, mode === "login" && s.tabTextActive]}>Sign In</Text>
          </Pressable>
          <Pressable style={[s.tab, mode === "register" && s.tabActive]} onPress={() => { setMode("register"); setError(null); }}>
            <Text style={[s.tabText, mode === "register" && s.tabTextActive]}>Create Account</Text>
          </Pressable>
        </View>

        {error && <Text style={s.error}>{error}</Text>}

        {/* Email */}
        <View style={s.inputWrapper}>
          <Feather name="mail" size={16} color={colors.mutedForeground} style={{ marginRight: 10 }} />
          <TextInput
            style={s.input}
            placeholder="Email address"
            placeholderTextColor={colors.mutedForeground}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoCorrect={false}
            returnKeyType="next"
          />
        </View>

        {/* Password */}
        <View style={s.inputWrapper}>
          <Feather name="lock" size={16} color={colors.mutedForeground} style={{ marginRight: 10 }} />
          <TextInput
            style={s.input}
            placeholder="Password"
            placeholderTextColor={colors.mutedForeground}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            returnKeyType="done"
            onSubmitEditing={handleSubmit}
          />
          <Pressable onPress={() => setShowPassword(v => !v)} hitSlop={8}>
            <Feather name={showPassword ? "eye-off" : "eye"} size={16} color={colors.mutedForeground} />
          </Pressable>
        </View>

        <Pressable
          style={[s.btn, (loading || !email.trim() || !password) && s.btnDisabled]}
          onPress={handleSubmit}
          disabled={loading || !email.trim() || !password}
        >
          {loading
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.btnText}>{mode === "login" ? "Sign In" : "Create Account"}</Text>
          }
        </Pressable>

        <View style={s.footer}>
          <Text style={s.footerText}>
            {mode === "login"
              ? "RM Tracker gives you real-time race schedules,\nlap times, and results for every event you enter."
              : "Your account links to all riders with the same email\nso your whole family's schedule is in one place."}
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
