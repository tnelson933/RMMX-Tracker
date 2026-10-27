import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as LocalAuthentication from "expo-local-authentication";
import { useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";
import { postJson } from "@/lib/friendlyErrors";
import { suggestEmailFix } from "@/lib/emailTypos";

/** Show an alert and resolve with the value of the button the user tapped. */
function choose<T>(title: string, message: string, buttons: { text: string; value: T; style?: "cancel" | "destructive" }[]): Promise<T> {
  return new Promise(resolve => {
    Alert.alert(title, message, buttons.map(b => ({ text: b.text, style: b.style, onPress: () => resolve(b.value) })), { cancelable: false });
  });
}

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN ?? ""}`;

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { login, register, logout, loginWithBiometric, biometricEnabled } = useRiderAuth();

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
        await postJson(`${BASE_URL}/api/rider/auth/forgot-password`, { email }, "Couldn't send the reset email");
        setForgotSent(true);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!email.trim() || !password) return;
    setError(null);

    // A mistyped email signs in to nothing, or worse, creates a second empty
    // account that isn't linked to the rider's race history.
    let target = email.trim().toLowerCase();
    const fix = suggestEmailFix(target);
    if (fix) {
      const useFix = await choose("Check your email", `Did you mean ${fix}?`, [
        { text: `Keep ${target}`, value: false, style: "cancel" },
        { text: `Use ${fix}`, value: true },
      ]);
      if (useFix) { target = fix; setEmail(fix); }
    }

    if (mode === "register") {
      const confirmed = await choose(
        "Create account?",
        `Create an RM Roost account for\n${target}\n\nUse the same email you register for races with. That's how your rider profiles and results link to this account.`,
        [
          { text: "Edit email", value: false, style: "cancel" },
          { text: "Create account", value: true },
        ],
      );
      if (!confirmed) return;
    }

    setLoading(true);
    try {
      if (mode === "login") {
        await login(target, password);
      } else {
        const linked = await register(target, password);
        if (linked === 0) {
          setLoading(false);
          const signOut = await choose(
            "No rider profiles found",
            `No race registrations use ${target} yet.\n\nIf you've raced before, you probably registered with a different email. Sign out and sign in (or create your account) with that email instead.\n\nNew to racing? Continue, then register for an event with this email.`,
            [
              { text: "Use a different email", value: true, style: "cancel" },
              { text: "Continue", value: false },
            ],
          );
          if (signOut) {
            await logout();
            setMode("login");
            setPassword("");
            return;
          }
        }
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace("/(tabs)" as any);
    } catch (e: any) {
      setError(e.message ?? "Sign-in failed. Please try again.");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }


  // Dark, race-themed palette for the sign-in screens (the brand art is built for black)
  const ink = "#0B0B0C";
  const panel = "#17171A";
  const field = "#232327";
  const line = "#2E2E33";
  const text = "#FFFFFF";
  const muted = "#A1A1AA";
  const red = colors.primary;
  const { width: screenWidth } = useWindowDimensions();
  const bannerWidth = Math.min(screenWidth - 44, 440);

  const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: ink },
    container: {
      flexGrow: 1,
      paddingTop: insets.top + 24,
      paddingBottom: insets.bottom + 28,
      paddingHorizontal: 22,
    },
    hero: { alignItems: "center", marginBottom: 22 },
    headline: {
      marginTop: 14, fontSize: 26, color: text, fontFamily: "Inter_700Bold",
      letterSpacing: 1.5, textTransform: "uppercase", textAlign: "center",
    },
    subhead: {
      marginTop: 6, fontSize: 14, color: muted, fontFamily: "Inter_400Regular",
      textAlign: "center", lineHeight: 20, maxWidth: 320,
    },
    chips: { flexDirection: "row", justifyContent: "center", flexWrap: "wrap", gap: 6, marginTop: 14 },
    chip: {
      flexDirection: "row", alignItems: "center", gap: 6,
      backgroundColor: panel, borderColor: line, borderWidth: 1,
      paddingVertical: 5, paddingLeft: 5, paddingRight: 9, borderRadius: 999,
    },
    chipDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: red, alignItems: "center", justifyContent: "center" },
    chipText: { fontSize: 11, color: text, fontFamily: "Inter_600SemiBold" },
    card: {
      backgroundColor: panel, borderRadius: 22, padding: 18,
      borderWidth: 1, borderColor: line,
      shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 8,
    },
    cardTitle: { fontSize: 20, color: text, fontFamily: "Inter_700Bold", textAlign: "center" },
    cardSub: { fontSize: 13, color: muted, fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 4, marginBottom: 16 },
    tabRow: { flexDirection: "row", backgroundColor: ink, borderRadius: 999, padding: 4, marginBottom: 16 },
    tab: { flex: 1, paddingVertical: 10, borderRadius: 999, alignItems: "center" },
    tabActive: { backgroundColor: red },
    tabText: { fontSize: 14, color: muted, fontFamily: "Inter_600SemiBold" },
    tabTextActive: { color: "#fff" },
    inputWrapper: {
      flexDirection: "row", alignItems: "center",
      backgroundColor: field, borderRadius: 14,
      paddingHorizontal: 14, borderWidth: 1, borderColor: line, marginBottom: 12,
    },
    input: { flex: 1, paddingVertical: 15, fontSize: 15, color: text, fontFamily: "Inter_400Regular" },
    btn: {
      flexDirection: "row", gap: 8, backgroundColor: red, paddingVertical: 16,
      borderRadius: 999, alignItems: "center", justifyContent: "center", marginTop: 6,
    },
    btnDisabled: { opacity: 0.45 },
    btnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_700Bold", letterSpacing: 1, textTransform: "uppercase" },
    biometricBtn: {
      flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
      borderWidth: 1.5, borderColor: line, backgroundColor: field,
      paddingVertical: 15, borderRadius: 999, marginBottom: 14,
    },
    biometricText: { fontSize: 15, color: text, fontFamily: "Inter_600SemiBold" },
    orRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 14 },
    orLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: line },
    orText: { fontSize: 12, color: muted, fontFamily: "Inter_400Regular" },
    error: {
      backgroundColor: "rgba(239,68,68,0.14)", borderColor: "rgba(239,68,68,0.4)", borderWidth: 1,
      borderRadius: 12, padding: 12, fontSize: 13, color: "#FCA5A5", fontFamily: "Inter_400Regular", marginBottom: 12,
    },
    success: {
      backgroundColor: "rgba(16,185,129,0.14)", borderColor: "rgba(16,185,129,0.4)", borderWidth: 1,
      borderRadius: 12, padding: 12, fontSize: 13, color: "#A7F3D0", fontFamily: "Inter_400Regular", marginBottom: 12,
    },
    forgotLink: { alignSelf: "flex-end", marginTop: -2, marginBottom: 8 },
    forgotText: { fontSize: 13, color: text, fontFamily: "Inter_500Medium", textDecorationLine: "underline" },
    backLink: { marginTop: 16, alignItems: "center" },
    backText: { fontSize: 14, color: text, fontFamily: "Inter_500Medium" },
    footerText: { fontSize: 12, color: muted, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 18, marginTop: 18 },
    poweredBy: { fontSize: 11, color: "#71717A", fontFamily: "Inter_500Medium", textAlign: "center", marginTop: 14, letterSpacing: 1, textTransform: "uppercase" },
  });

  // Hero slides in on first paint
  const heroAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(heroAnim, { toValue: 1, duration: 650, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [heroAnim]);
  const heroStyle = {
    opacity: heroAnim,
    transform: [{ translateX: heroAnim.interpolate({ inputRange: [0, 1], outputRange: [-40, 0] }) }],
  };

  // Shared backdrop: speed stripes and a checkered-flag band echoing the logo
  const backdrop = (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={{ position: "absolute", top: insets.top - 10, left: -80, right: -80, height: 160, transform: [{ rotate: "-14deg" }] }}>
        <View style={{ height: 3, backgroundColor: red, opacity: 0.55, marginTop: 30, marginRight: 140 }} />
        <View style={{ height: 8, backgroundColor: red, opacity: 0.35, marginTop: 18, marginLeft: 90 }} />
        <View style={{ height: 2, backgroundColor: "#fff", opacity: 0.12, marginTop: 26, marginRight: 60 }} />
      </View>
      <View style={{ position: "absolute", bottom: insets.bottom, left: 0, right: 0, opacity: 0.07 }}>
        {[0, 1].map(row => (
          <View key={row} style={{ flexDirection: "row" }}>
            {Array.from({ length: 24 }).map((_, i) => (
              <View key={i} style={{ width: 18, height: 18, backgroundColor: (i + row) % 2 === 0 ? "#fff" : "transparent" }} />
            ))}
          </View>
        ))}
      </View>
    </View>
  );

  const hero = (compact: boolean) => (
    <Animated.View style={[s.hero, heroStyle]}>
      <Image
        source={require("../assets/images/brand-banner-hero.png")}
        style={{ width: compact ? bannerWidth * 0.8 : bannerWidth, height: (compact ? bannerWidth * 0.8 : bannerWidth) * 501 / 1600 }}
        resizeMode="contain"
      />
      {!compact && (
        <>
          <Text style={s.headline}>Race day starts here</Text>
          <Text style={s.subhead}>Live timing, results and race-day alerts for every event you enter.</Text>
          <View style={s.chips}>
            {([["clock", "Live timing"], ["bar-chart-2", "Results & stats"], ["bell", "Race alerts"]] as const).map(([icon, label]) => (
              <View key={label} style={s.chip}>
                <View style={s.chipDot}><Feather name={icon} size={11} color="#fff" /></View>
                <Text style={s.chipText}>{label}</Text>
              </View>
            ))}
          </View>
        </>
      )}
    </Animated.View>
  );

  const shell = (children: React.ReactNode, compact = false) => (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <StatusBar barStyle="light-content" />
      {backdrop}
      <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
        {hero(compact)}
        <View style={s.card}>{children}</View>
        <Text style={s.poweredBy}>Rocky Mountain ATV/MC</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );

  // ── Forgot password view ──────────────────────────────────────────────────
  if (mode === "forgot") {
    return shell(
      <>
        <Text style={s.cardTitle}>Forgot your password?</Text>
        <Text style={s.cardSub}>We'll email you a link to set a new one.</Text>

        {error && <Text style={s.error}>{error}</Text>}

        {forgotSent ? (
          <>
            <Text style={s.success}>
              If an account exists for {email}, you'll receive a reset link shortly. Check your inbox and follow the link to set a new password.
            </Text>
            <Pressable style={s.backLink} onPress={() => { setMode("login"); setForgotSent(false); setEmail(""); }}>
              <Text style={s.backText}>← Back to Sign In</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={s.inputWrapper}>
              <Feather name="mail" size={16} color={muted} style={{ marginRight: 10 }} />
              <TextInput
                style={s.input}
                placeholder="Email address"
                placeholderTextColor={muted}
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
      </>,
      true,
    );
  }

  // ── Login / Register view ─────────────────────────────────────────────────
  return shell(
    <>
      {/* Biometric quick-sign-in (login mode only, if enabled) */}
      {showBiometric && (
        <>
          <Pressable
            style={[s.biometricBtn, loading && s.btnDisabled]}
            onPress={handleBiometric}
            disabled={loading}
          >
            <Feather name={biometricType === "face" ? "aperture" : "check-circle"} size={20} color={text} />
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
        <Feather name="mail" size={16} color={muted} style={{ marginRight: 10 }} />
        <TextInput
          style={s.input}
          placeholder="Email address"
          placeholderTextColor={muted}
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
        <Feather name="lock" size={16} color={muted} style={{ marginRight: 10 }} />
        <TextInput
          style={s.input}
          placeholder="Password"
          placeholderTextColor={muted}
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!showPassword}
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
        />
        <Pressable onPress={() => setShowPassword(v => !v)} hitSlop={8}>
          <Feather name={showPassword ? "eye-off" : "eye"} size={16} color={muted} />
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
          : (
            <>
              <Text style={s.btnText}>{mode === "login" ? "Let's Ride" : "Create Account"}</Text>
              <Feather name="arrow-right" size={18} color="#fff" />
            </>
          )
        }
      </Pressable>

      <Text style={s.footerText}>
        {mode === "login"
          ? "Use the email you register for races with to see your schedule, laps and results."
          : "Use the email you register for races with. Every rider registered under it, your whole family included, links to this account."}
      </Text>
    </>,
  );
}
