import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as LocalAuthentication from "expo-local-authentication";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
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

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN ?? ""}`;

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { login, register, loginWithBiometric, biometricEnabled } = useRiderAuth();

  const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricType, setBiometricType] = useState<"face" | "fingerprint">("face");

  useEffect(() => {
    if (Platform.OS === "web") return;
    async function checkBiometrics() {
      const hasHw = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (hasHw && enrolled) {
        setBiometricAvailable(true);
        const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
        const hasFace = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
        setBiometricType(hasFace ? "face" : "fingerprint");
      }
    }
    void checkBiometrics();
  }, []);

  const showBiometric = biometricAvailable && biometricEnabled && mode === "login";

  async function handleBiometric() {
    setLoading(true);
    setError(null);
    try {
      await loginWithBiometric();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace("/(tabs)" as any);
    } catch (e: any) {
      setError(e.message ?? "Biometric sign-in failed");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit() {
    if (mode === "forgot") {
      if (!email.trim()) return;
      setLoading(true);
      setError(null);
      try {
        await fetch(`${BASE_URL}/api/rider/auth/forgot-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        setForgotSent(true);
      } catch {
        setError("Network error. Please try again.");
      } finally {
        setLoading(false);
      }
      return;
    }

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
    biometricBtn: {
      flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
      borderWidth: 1.5, borderColor: colors.border,
      paddingVertical: 15, borderRadius: 10, marginTop: 12,
    },
    biometricText: { fontSize: 15, fontWeight: "600", color: colors.foreground, fontFamily: "Inter_600SemiBold" },
    orRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 16 },
    orLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
    orText: { fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" },
    error: {
      backgroundColor: "#FEE2E2", borderRadius: 8, padding: 12,
      fontSize: 13, color: "#DC2626", fontFamily: "Inter_400Regular", marginBottom: 12,
    },
    success: {
      backgroundColor: "#D1FAE5", borderRadius: 8, padding: 12,
      fontSize: 13, color: "#065F46", fontFamily: "Inter_400Regular", marginBottom: 12,
    },
    footer: {
      marginTop: 24, alignItems: "center", gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
      paddingTop: 24,
    },
    footerText: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 18 },
    forgotLink: { marginTop: 4, alignItems: "center" },
    forgotText: { fontSize: 13, color: colors.primary, fontFamily: "Inter_400Regular" },
    backLink: { marginTop: 12, alignItems: "center" },
    backText: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular" },
  });

  // ── Forgot password view ──────────────────────────────────────────────────
  if (mode === "forgot") {
    return (
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: colors.background }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
          <View style={s.logoRow}>
            <View style={s.logoBox}>
              <Feather name="lock" size={30} color="#fff" />
            </View>
            <Text style={s.appName}>Forgot Password</Text>
            <Text style={s.tagline}>We'll email you a reset link</Text>
          </View>

          {error && <Text style={s.error}>{error}</Text>}

          {forgotSent ? (
            <>
              <Text style={s.success}>
                If an account exists for {email}, you'll receive a reset link shortly. Check your inbox and follow the link to set a new password.
              </Text>
              <Pressable style={s.backLink} onPress={() => { setMode("login"); setForgotSent(false); setEmail(""); }}>
                <Text style={s.forgotText}>← Back to Sign In</Text>
              </Pressable>
            </>
          ) : (
            <>
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
                  returnKeyType="send"
                  onSubmitEditing={handleSubmit}
                  autoFocus
                />
              </View>

              <Pressable
                style={[s.btn, (loading || !email.trim()) && s.btnDisabled]}
                onPress={handleSubmit}
                disabled={loading || !email.trim()}
              >
                {loading
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={s.btnText}>Send Reset Link</Text>
                }
              </Pressable>

              <Pressable style={s.backLink} onPress={() => { setMode("login"); setError(null); }}>
                <Text style={s.backText}>← Back to Sign In</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ── Login / Register view ─────────────────────────────────────────────────
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

        {/* Biometric quick-sign-in (login mode only, if enabled) */}
        {showBiometric && (
          <>
            <Pressable
              style={[s.biometricBtn, loading && s.btnDisabled]}
              onPress={handleBiometric}
              disabled={loading}
            >
              <Feather
                name={biometricType === "face" ? "aperture" : "check-circle"}
                size={20}
                color={colors.primary}
              />
              <Text style={s.biometricText}>
                {biometricType === "face" ? "Sign in with Face ID" : "Sign in with Fingerprint"}
              </Text>
            </Pressable>
            <View style={s.orRow}>
              <View style={s.orLine} />
              <Text style={s.orText}>or use password</Text>
              <View style={s.orLine} />
            </View>
          </>
        )}

        {/* Login / Register tab toggle */}
        <View style={[s.tabRow, showBiometric && { marginTop: 16 }]}>
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

        {/* Forgot password — login mode only */}
        {mode === "login" && (
          <Pressable style={s.forgotLink} onPress={() => { setMode("forgot"); setError(null); setForgotSent(false); }}>
            <Text style={s.forgotText}>Forgot password?</Text>
          </Pressable>
        )}

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
