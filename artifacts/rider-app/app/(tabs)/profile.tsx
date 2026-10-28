import { API_BASE_URL } from "@/lib/apiBase";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
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
import { BottomTabBarHeightContext } from "@react-navigation/bottom-tabs";

import { DirtBikeIcon } from "@/components/DirtBikeIcon";
import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";
import { useTheme, type ThemePreference } from "@/context/ThemeContext";
import { BrandBar } from "@/components/BrandBar";
import { NETWORK_ERROR_MESSAGE, postJson } from "@/lib/friendlyErrors";
import { PositionBadge, StatTile } from "@/components/RaceStats";
import { displayDate } from "@/lib/format";

const BASE_URL = API_BASE_URL;
const PRIVACY_URL = `${BASE_URL}/privacy`;

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
      width: 52, height: 52, borderRadius: 14,
      backgroundColor: colors.primary,
      alignItems: "center", justifyContent: "center", marginBottom: 8,
    },
    title: { fontSize: 26, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", letterSpacing: 1, textTransform: "uppercase" },
    subtitle: { fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginBottom: 8 },
    inputWrapper: {
      flexDirection: "row", alignItems: "center",
      backgroundColor: colors.muted, borderRadius: 10,
      paddingHorizontal: 14, borderWidth: 1, borderColor: colors.border,
    },
    input: { flex: 1, paddingVertical: 14, fontSize: 15, color: colors.foreground, fontFamily: "Inter_400Regular" },
    btn: { backgroundColor: colors.primary, paddingVertical: 14, borderRadius: 10, alignItems: "center", marginTop: 4 },
    btnDisabled: { opacity: 0.5 },
    btnText: { color: "#fff", fontWeight: "700", fontSize: 15, fontFamily: "Inter_700Bold" },
    switchRow: { flexDirection: "row", justifyContent: "center", gap: 6, marginTop: 4 },
    switchText: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular" },
    switchLink: { fontSize: 13, color: colors.primary, fontFamily: "Inter_600SemiBold" },
    error: { backgroundColor: colors.dangerTint, borderRadius: 8, padding: 12, fontSize: 13, color: colors.destructive, fontFamily: "Inter_400Regular" },
  });

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
        <View style={s.logo}><Feather name="user" size={24} color="#fff" /></View>
        <Text style={s.title}>{mode === "login" ? "Rider Login" : "Create Account"}</Text>
        <Text style={s.subtitle}>
          {mode === "login" ? "Sign in to view your race history and profile." : "Create an account to track your races."}
        </Text>

        {error && <Text style={s.error}>{error}</Text>}

        <View style={s.inputWrapper}>
          <Feather name="mail" size={16} color={colors.mutedForeground} style={{ marginRight: 8 }} />
          <TextInput
            style={s.input} placeholder="Email address" placeholderTextColor={colors.mutedForeground}
            value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoCorrect={false}
          />
        </View>

        <View style={s.inputWrapper}>
          <Feather name="lock" size={16} color={colors.mutedForeground} style={{ marginRight: 8 }} />
          <TextInput
            style={s.input} placeholder="Password" placeholderTextColor={colors.mutedForeground}
            value={password} onChangeText={setPassword} secureTextEntry={!showPassword}
          />
          <Pressable onPress={() => setShowPassword(v => !v)}>
            <Feather name={showPassword ? "eye-off" : "eye"} size={16} color={colors.mutedForeground} />
          </Pressable>
        </View>

        <Pressable
          style={[s.btn, (loading || !email.trim() || !password) && s.btnDisabled]}
          onPress={handleSubmit}
          disabled={loading || !email.trim() || !password}
        >
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>{mode === "login" ? "Sign In" : "Create Account"}</Text>}
        </Pressable>

        <View style={s.switchRow}>
          <Text style={s.switchText}>{mode === "login" ? "Don't have an account?" : "Already have an account?"}</Text>
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
  const { preference: themePref, setPreference: setThemePref } = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarHeight = React.useContext(BottomTabBarHeightContext) ?? 0;
  const router = useRouter();
  const {
    account, profiles, activeProfiles, selectedProfileIds,
    setSelectedProfileIds, logout, refreshProfiles,
    bikeInfoMap, setBikeInfo, riderFetch,
    changePassword, enableBiometric, disableBiometric, biometricEnabled,
  } = useRiderAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedGarageId, setExpandedGarageId] = useState<number | null>(null);
  const [expandedRiderId, setExpandedRiderId] = useState<number | null>(null);
  const [showLinkHelp, setShowLinkHelp] = useState(false);
  const [garageEdit, setGarageEdit] = useState<{ rideExperience: string; bikeHours: string; raceTypes: string[] }>({ rideExperience: "", bikeHours: "", raceTypes: [] });
  const [garageSaving, setGarageSaving] = useState(false);
  const [showAddBike, setShowAddBike] = useState<number | null>(null);
  const [addBikeForm, setAddBikeForm] = useState({ manufacturer: "", model: "", year: "" });
  const [addBikeSaving, setAddBikeSaving] = useState(false);

  // Security / Change password state
  const [showSecurity, setShowSecurity] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [biometricHardware, setBiometricHardware] = useState(false);
  const [biometricType, setBiometricType] = useState<"face" | "fingerprint">("face");
  // Enabling biometric sign-in asks for the password once so it can be saved securely.
  const [bioSetupOpen, setBioSetupOpen] = useState(false);
  const [bioPassword, setBioPassword] = useState("");
  const [bioSaving, setBioSaving] = useState(false);
  const [bioError, setBioError] = useState<string | null>(null);
  const [deletingAccount, setDeletingAccount] = useState(false);

  React.useEffect(() => {
    if (Platform.OS === "web") return;
    async function checkBio() {
      try {
        const LocalAuth = await import("expo-local-authentication");
        const hasHw = await LocalAuth.hasHardwareAsync();
        const enrolled = await LocalAuth.isEnrolledAsync();
        if (hasHw && enrolled) {
          setBiometricHardware(true);
          const types = await LocalAuth.supportedAuthenticationTypesAsync();
          const hasFace = types.includes(LocalAuth.AuthenticationType.FACIAL_RECOGNITION);
          setBiometricType(hasFace ? "face" : "fingerprint");
        }
      } catch { /* ignore */ }
    }
    void checkBio();
  }, []);

  async function handleChangePassword() {
    if (!pwCurrent || !pwNew || !pwConfirm) { setPwError("All fields are required"); return; }
    if (pwNew !== pwConfirm) { setPwError("New passwords don't match"); return; }
    if (pwNew.length < 8) { setPwError("New password must be at least 8 characters"); return; }
    setPwSaving(true);
    setPwError(null);
    try {
      await changePassword(pwCurrent, pwNew);
      setPwSuccess(true);
      setPwCurrent(""); setPwNew(""); setPwConfirm("");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => { setPwSuccess(false); setShowSecurity(false); }, 2000);
    } catch (e: any) {
      setPwError(e.message ?? "Failed to update password");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setPwSaving(false);
    }
  }

  async function handleToggleBiometric() {
    if (biometricEnabled) {
      await disableBiometric();
      await Haptics.selectionAsync();
    } else {
      setBioError(null);
      setBioPassword("");
      setBioSetupOpen(v => !v);
    }
  }

  async function handleConfirmBiometric() {
    if (!bioPassword) { setBioError("Enter your password"); return; }
    setBioSaving(true);
    setBioError(null);
    try {
      await enableBiometric(bioPassword);
      setBioSetupOpen(false);
      setBioPassword("");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      setBioError(e.message ?? "Couldn't turn on biometric sign-in");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBioSaving(false);
    }
  }

  function handleOpenPrivacy() {
    void WebBrowser.openBrowserAsync(PRIVACY_URL).catch(() => {
      Alert.alert("Couldn't open the privacy policy", NETWORK_ERROR_MESSAGE);
    });
  }

  async function submitDeletion() {
    if (!account) return;
    setDeletingAccount(true);
    try {
      await postJson(`${BASE_URL}/api/account-deletion-request`,
        { email: account.email, reason: "Requested in the RM Roost app" },
        "Couldn't send your deletion request");
    } catch (e: any) {
      setDeletingAccount(false);
      Alert.alert("Request not sent", e.message ?? "Couldn't send your deletion request");
      return;
    }
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const done = async () => {
      await disableBiometric();
      await logout();
      setDeletingAccount(false);
    };
    const message = "We received your request to delete your RM Roost account and its data. " +
      "We'll confirm by email when it's complete. You'll now be signed out.";
    if (Platform.OS === "web") {
      (globalThis as Record<string, any>)["alert"]?.(message);
      await done();
      return;
    }
    Alert.alert("Deletion requested", message, [{ text: "OK", onPress: () => { void done(); } }], { cancelable: false });
  }

  function handleDeleteAccount() {
    const prompt = "This permanently deletes your RM Roost account, rider profiles and race history. This can't be undone.";
    if (Platform.OS === "web") {
      if (!(globalThis as Record<string, any>)["confirm"]?.(`Delete your account? ${prompt}`)) return;
      void submitDeletion();
      return;
    }
    Alert.alert("Delete account?", prompt, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete Account", style: "destructive", onPress: () => { void submitDeletion(); } },
    ]);
  }

  const RACE_TYPES = ["Motocross", "Supercross", "Desert", "Cross Country", "Flat / Dirt Track", "Supermoto"] as const;

  async function handleRefresh() {
    setRefreshing(true);
    await refreshProfiles();
    setRefreshing(false);
  }

  function handleSignOut() {
    if (Platform.OS === "web") {
      if (!(globalThis as Record<string, any>)["confirm"]?.("Sign out of your rider account?")) return;
      setLoggingOut(true);
      void logout().finally(() => setLoggingOut(false));
      return;
    }
    Alert.alert("Sign Out", "Sign out of your rider account?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out", style: "destructive",
        onPress: async () => {
          setLoggingOut(true);
          await logout();
          setLoggingOut(false);
        },
      },
    ]);
  }

  async function toggleProfile(profileId: number) {
    const isSelected = selectedProfileIds.includes(profileId);
    if (isSelected && selectedProfileIds.length === 1) return; // always keep at least 1
    const newIds = isSelected
      ? selectedProfileIds.filter(id => id !== profileId)
      : [...selectedProfileIds, profileId];
    await setSelectedProfileIds(newIds);
    await Haptics.selectionAsync();
  }

  async function handleSelectAll() {
    if (activeProfiles.length === profiles.length) {
      // Collapse to solo — first profile only
      await setSelectedProfileIds([profiles[0].id]);
    } else {
      // Expand to all profiles
      await setSelectedProfileIds(profiles.map(p => p.id));
    }
    await Haptics.selectionAsync();
  }

  const allSelected = activeProfiles.length === profiles.length;

  function activeSummary(): string {
    if (activeProfiles.length === 0) return "";
    if (activeProfiles.length === 1) {
      return `${activeProfiles[0].firstName} ${activeProfiles[0].lastName}`;
    }
    const names = activeProfiles.map(p => p.firstName).join(", ");
    return `${names} (${activeProfiles.length} riders)`;
  }

  const s = StyleSheet.create({
    scroll: { flex: 1 },
    headerBand: {
      marginHorizontal: -16, marginTop: -16, marginBottom: 14,
      paddingHorizontal: 16, paddingTop: insets.top + 16, paddingBottom: 16,
      backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border,
    },
    container: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: (tabBarHeight > 0 ? tabBarHeight : 49 + insets.bottom) + 96, gap: 14 },
    pageTitle: { fontSize: 26, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", letterSpacing: 1, textTransform: "uppercase" },
    pageSubtitle: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 },
    accountCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 16,
      borderWidth: 1, borderColor: colors.border,
      flexDirection: "row", alignItems: "center", gap: 12,
    },
    accountIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primary + "20", alignItems: "center", justifyContent: "center" },
    accountEmail: { fontSize: 14, fontWeight: "600", color: colors.foreground, fontFamily: "Inter_600SemiBold" },
    accountLabel: { fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginBottom: 2 },
    sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 2 },
    sectionLabel: { fontSize: 11, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", letterSpacing: 0.8, textTransform: "uppercase" },
    sectionHint: { fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular" },
    listCard: { backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
    riderRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
    riderInitials: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
    riderName: { fontSize: 15, color: colors.foreground, fontFamily: "Inter_700Bold" },
    riderMeta: { fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 },
    expandBtn: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
    actionPill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: colors.primaryTint, borderWidth: 1, borderColor: colors.primary + "44" },
    actionPillText: { fontSize: 12, color: colors.foreground, fontFamily: "Inter_600SemiBold" },
    settingRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 13 },
    settingIcon: { width: 32, height: 32, borderRadius: 10, backgroundColor: colors.primaryTint, alignItems: "center", justifyContent: "center" },
    settingLabel: { fontSize: 15, color: colors.foreground, fontFamily: "Inter_600SemiBold" },
    settingSub: { fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 },
    settingDivider: { height: 1, backgroundColor: colors.border, marginLeft: 58 },
    miniSeg: { flexDirection: "row", backgroundColor: colors.muted, borderRadius: 999, padding: 3, gap: 2 },
    miniSegBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
    // Active summary banner
    activeBanner: {
      flexDirection: "row", alignItems: "center", gap: 8,
      backgroundColor: colors.primary + "14", borderRadius: 10, padding: 10,
      borderWidth: 1, borderColor: colors.primary + "35",
    },
    activeBannerText: { flex: 1, fontSize: 13, fontWeight: "600", color: colors.primary, fontFamily: "Inter_600SemiBold" },
    activeBannerBtn: {
      paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20,
      backgroundColor: colors.primary, flexDirection: "row", alignItems: "center", gap: 4,
    },
    activeBannerBtnText: { fontSize: 11, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
    // Profile card
    profileCard: {
      backgroundColor: colors.card, borderRadius: 14,
      borderWidth: 1, borderColor: colors.border, overflow: "hidden",
    },
    profileCardSelected: { borderWidth: 1.5, borderColor: colors.primary },
    profileCardInner: { padding: 14 },
    profileRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    profileLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
    profileAvatar: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
    profileName: { fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" },
    profileBib: { fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 },
    statsRow: { flexDirection: "row", marginTop: 12, gap: 8 },
    statBox: { flex: 1, backgroundColor: colors.muted, borderRadius: 8, padding: 10, alignItems: "center" },
    statLabel: { fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginBottom: 2 },
    statValue: { fontSize: 18, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold" },
    statValuePrimary: { fontSize: 18, fontWeight: "800", color: colors.primary, fontFamily: "Inter_700Bold" },
    lastRaced: { fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 8 },
    // Checkbox
    checkOuter: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: "center", justifyContent: "center" },
    // Other
    addBtn: {
      backgroundColor: colors.muted, borderRadius: 14, padding: 16,
      flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
      borderWidth: 1, borderColor: colors.border, borderStyle: "dashed",
    },
    addBtnText: { fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_600SemiBold" },
    signOutBtn: {
      backgroundColor: colors.muted, borderRadius: 14, padding: 14,
      flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
      borderWidth: 1, borderColor: colors.border,
    },
    signOutText: { fontSize: 14, color: "#DC2626", fontFamily: "Inter_600SemiBold" },
    emptyBox: {
      backgroundColor: colors.card, borderRadius: 14, padding: 32,
      alignItems: "center", gap: 8,
      borderWidth: 1, borderColor: colors.border,
    },
    emptyTitle: { fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" },
    emptyText: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" },
    infoCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 14,
      borderWidth: 1, borderColor: colors.border, gap: 4,
    },
    infoTitle: { fontSize: 11, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 },
    infoText: { fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", lineHeight: 18 },
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
        <View style={s.headerBand}>
          <BrandBar />
          <Text style={s.pageTitle}>My Profiles</Text>
          <Text style={s.pageSubtitle} numberOfLines={1}>
            Signed in as <Text style={{ fontFamily: "Inter_700Bold", color: colors.foreground }}>{account?.email}</Text>
          </Text>
        </View>
      </View>

      {/* Rider profiles */}
      <View style={s.sectionRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.sectionLabel}>Riders</Text>
          <Text style={s.sectionHint}>Checked riders drive the app. Tap a rider to show or hide them.</Text>
        </View>
        {profiles.length > 1 && (
          <Pressable
            onPress={handleSelectAll}
            style={({ pressed }) => ({
              paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
              backgroundColor: allSelected ? colors.primary : colors.muted,
              borderWidth: 1, borderColor: allSelected ? colors.primary : colors.border,
              opacity: pressed ? 0.7 : 1, flexDirection: "row", alignItems: "center", gap: 4,
            })}
          >
            <Feather name={allSelected ? "minus" : "check-square"} size={12} color={allSelected ? "#fff" : colors.mutedForeground} />
            <Text style={{ fontSize: 12, fontWeight: "700", color: allSelected ? "#fff" : colors.mutedForeground, fontFamily: "Inter_700Bold" }}>
              {allSelected ? "Solo" : "All"}
            </Text>
          </Pressable>
        )}
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
        <View style={s.listCard}>
          {profiles.map((profile, idx) => {
            const isSelected = selectedProfileIds.includes(profile.id);
            const isOnlyOne = selectedProfileIds.length === 1 && isSelected;
            const isOpen = expandedRiderId === profile.id;
            const initials = `${profile.firstName?.[0] ?? ""}${profile.lastName?.[0] ?? ""}`.toUpperCase();
            return (
              <View key={profile.id} style={idx > 0 ? { borderTopWidth: 1, borderTopColor: colors.border } : null}>
                <Pressable
                  onPress={() => toggleProfile(profile.id)}
                  style={({ pressed }) => [s.riderRow, { opacity: pressed ? 0.8 : 1 }]}
                >
                  <View style={[s.riderInitials, { backgroundColor: isSelected ? colors.primary : colors.muted }]}>
                    <Text style={{ fontSize: 14, color: isSelected ? "#fff" : colors.mutedForeground, fontFamily: "Inter_700Bold" }}>{initials || "?"}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.riderName} numberOfLines={1}>{profile.firstName} {profile.lastName}</Text>
                    <Text style={s.riderMeta} numberOfLines={1}>
                      {profile.bibNumber ? `#${profile.bibNumber}` : "No bib"} · {profile.eventsRaced} {profile.eventsRaced === 1 ? "event" : "events"}{profile.totalPoints ? ` · ${profile.totalPoints} pts` : ""}
                    </Text>
                  </View>
                  {profile.bestPosition ? <PositionBadge position={profile.bestPosition} size="sm" /> : null}
                  <View style={[s.checkOuter, { borderColor: isSelected ? colors.primary : colors.border, backgroundColor: isSelected ? colors.primary : "transparent" }]}>
                    {isSelected && <Feather name="check" size={13} color="#fff" />}
                  </View>
                  <Pressable
                    onPress={() => setExpandedRiderId(isOpen ? null : profile.id)}
                    hitSlop={10}
                    accessibilityLabel={isOpen ? "Hide rider details" : "Show rider details"}
                    style={({ pressed }) => [s.expandBtn, { backgroundColor: colors.muted, opacity: pressed ? 0.6 : 1 }]}
                  >
                    <Feather name={isOpen ? "chevron-up" : "chevron-down"} size={16} color={colors.foreground} />
                  </Pressable>
                </Pressable>

                {isOpen && (
                  <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 10 }}>
                    <View style={s.statsRow}>
                      <StatTile compact value={profile.eventsRaced} label="Events" />
                      <StatTile compact value={profile.bestPosition ? `P${profile.bestPosition}` : "—"} label="Best Finish" />
                      <StatTile compact value={profile.totalPoints} label="Points" highlight />
                    </View>
                    {profile.lastRaced && (
                      <Text style={s.lastRaced}>
                        Last raced {displayDate(profile.lastRaced).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        {isOnlyOne ? " · at least one rider must stay checked" : ""}
                      </Text>
                    )}
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                      {([
                        ["edit-2", "Edit profile", `/rider/${profile.id}`],
                        ["bar-chart-2", "Stats & managers", `/stats/${profile.id}`],
                        ["tool", "Maintenance", `/maintenance/${profile.id}`],
                      ] as const).map(([icon, label, href]) => (
                        <Pressable
                          key={label}
                          onPress={() => router.push(href as any)}
                          style={({ pressed }) => [s.actionPill, { opacity: pressed ? 0.7 : 1 }]}
                        >
                          <Feather name={icon} size={13} color={colors.primary} />
                          <Text style={s.actionPillText}>{label}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}

      <Pressable style={s.addBtn} onPress={() => router.push("/rider/new" as any)}>
        <Feather name="user-plus" size={16} color={colors.mutedForeground} />
        <Text style={s.addBtnText}>Add Rider Profile</Text>
      </Pressable>

      {/* ─── My Garage ───────────────────────────────── */}
      {profiles.length > 0 && (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8, marginTop: 4 }}>
            <Text style={{ fontSize: 11, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", letterSpacing: 0.8, textTransform: "uppercase" }}>My Garage</Text>
            <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>— riding level & maintenance</Text>
          </View>

          {profiles.map(profile => {
            const info = bikeInfoMap[profile.id] ?? {};
            // Bike make/model/year come from the server-stored rider profile
            const defaultBike = profile.bikes?.find(b => b.isDefault) ?? profile.bikes?.[0];
            const bikeStr = defaultBike
              ? [defaultBike.bikeYear, defaultBike.bikeManufacturer, defaultBike.bikeModel].filter(Boolean).join(" ")
              : "";
            const isExpanded = expandedGarageId === profile.id;
            const LEVELS = ["Beginner", "Intermediate", "Advanced", "Expert"];

            return (
              <View key={`garage-${profile.id}`} style={{
                backgroundColor: colors.card, borderRadius: 14, marginBottom: 10,
                borderWidth: 1, borderColor: colors.border, overflow: "hidden",
              }}>
                {/* Header row — tap to expand experience picker */}
                <Pressable
                  onPress={() => {
                    if (isExpanded) {
                      setExpandedGarageId(null);
                    } else {
                      setExpandedGarageId(profile.id);
                      setGarageEdit({ rideExperience: info.rideExperience ?? "", bikeHours: info.bikeHours ?? "", raceTypes: profile.raceTypes ?? [] });
                    }
                  }}
                  style={({ pressed }) => ({
                    flexDirection: "row", alignItems: "center", gap: 10,
                    padding: 14, opacity: pressed ? 0.75 : 1,
                  })}
                >
                  <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: colors.primary + "18", alignItems: "center", justifyContent: "center" }}>
                    <DirtBikeIcon size={20} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
                      {profile.firstName} {profile.lastName}
                    </Text>
                    {(profile.bikes && profile.bikes.length > 0) ? (
                      <Text style={{ fontSize: 12, color: colors.primary, fontFamily: "Inter_500Medium", marginTop: 1 }}>
                        {bikeStr || `${profile.bikes.length} bike${profile.bikes.length === 1 ? "" : "s"}`}
                      </Text>
                    ) : (
                      <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>
                        No bikes yet — expand to add one
                      </Text>
                    )}
                    {info.rideExperience && (
                      <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1, textTransform: "capitalize" }}>
                        {info.rideExperience} rider
                      </Text>
                    )}
                  </View>
                  <Feather
                    name={isExpanded ? "chevron-up" : "chevron-down"}
                    size={16} color={colors.mutedForeground}
                  />
                </Pressable>

                {/* Expanded: experience picker + link to full edit */}
                {isExpanded && (
                  <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
                    <View style={{ height: 6 }} />

                    {/* Bike garage list */}
                    <View>
                      <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>My Bikes</Text>
                      {(!profile.bikes || profile.bikes.length === 0) && showAddBike !== profile.id && (
                        <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", fontStyle: "italic", marginBottom: 8 }}>No bikes yet</Text>
                      )}
                      {(profile.bikes ?? []).map(bike => {
                        const bs = [bike.bikeYear, bike.bikeManufacturer, bike.bikeModel].filter(Boolean).join(" ") || "Unnamed bike";
                        return (
                          <Pressable
                            key={bike.id}
                            onPress={async () => {
                              if (!bike.isDefault) {
                                await riderFetch(`/api/rider/profiles/${profile.id}/bikes/${bike.id}/set-default`, { method: "POST" });
                                await refreshProfiles();
                                await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                              }
                            }}
                            style={({ pressed }) => ({
                              flexDirection: "row", alignItems: "center", gap: 10,
                              paddingHorizontal: 12, paddingVertical: 10,
                              borderRadius: 10, borderWidth: 1.5,
                              borderColor: bike.isDefault ? colors.primary : colors.border,
                              backgroundColor: bike.isDefault ? colors.primary + "10" : colors.background,
                              marginBottom: 6, opacity: pressed ? 0.75 : 1,
                            })}
                          >
                            <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: bike.isDefault ? colors.primary : colors.border, backgroundColor: bike.isDefault ? colors.primary : "transparent", alignItems: "center", justifyContent: "center" }}>
                              {bike.isDefault && <Feather name="check" size={11} color="#fff" />}
                            </View>
                            <Text style={{ flex: 1, fontSize: 13, color: colors.foreground, fontFamily: "Inter_600SemiBold" }}>{bs}</Text>
                            <Pressable
                              onPress={async () => {
                                await riderFetch(`/api/rider/profiles/${profile.id}/bikes/${bike.id}`, { method: "DELETE" });
                                await refreshProfiles();
                                await Haptics.selectionAsync();
                              }}
                              style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.6 : 1 })}
                              hitSlop={8}
                            >
                              <Feather name="trash-2" size={14} color="#DC2626" />
                            </Pressable>
                          </Pressable>
                        );
                      })}
                      {showAddBike === profile.id ? (
                        <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, gap: 8, backgroundColor: colors.background }}>
                          <TextInput
                            placeholder="Year (e.g. 2024)"
                            placeholderTextColor={colors.mutedForeground}
                            value={addBikeForm.year}
                            onChangeText={v => setAddBikeForm(f => ({ ...f, year: v }))}
                            keyboardType="numeric"
                            style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: colors.foreground, fontFamily: "Inter_400Regular", backgroundColor: colors.card }}
                          />
                          <TextInput
                            placeholder="Make (e.g. KTM)"
                            placeholderTextColor={colors.mutedForeground}
                            value={addBikeForm.manufacturer}
                            onChangeText={v => setAddBikeForm(f => ({ ...f, manufacturer: v }))}
                            style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: colors.foreground, fontFamily: "Inter_400Regular", backgroundColor: colors.card }}
                          />
                          <TextInput
                            placeholder="Model (e.g. 450 SX-F)"
                            placeholderTextColor={colors.mutedForeground}
                            value={addBikeForm.model}
                            onChangeText={v => setAddBikeForm(f => ({ ...f, model: v }))}
                            style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: colors.foreground, fontFamily: "Inter_400Regular", backgroundColor: colors.card }}
                          />
                          <View style={{ flexDirection: "row", gap: 8 }}>
                            <Pressable
                              onPress={() => { setShowAddBike(null); setAddBikeForm({ manufacturer: "", model: "", year: "" }); }}
                              style={({ pressed }) => ({ flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: 8, backgroundColor: colors.muted, opacity: pressed ? 0.7 : 1 })}
                            >
                              <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_600SemiBold" }}>Cancel</Text>
                            </Pressable>
                            <Pressable
                              disabled={addBikeSaving}
                              onPress={async () => {
                                setAddBikeSaving(true);
                                try {
                                  await riderFetch(`/api/rider/profiles/${profile.id}/bikes`, {
                                    method: "POST",
                                    body: JSON.stringify({ bikeManufacturer: addBikeForm.manufacturer || null, bikeModel: addBikeForm.model || null, bikeYear: addBikeForm.year || null }),
                                  });
                                  await refreshProfiles();
                                  setShowAddBike(null);
                                  setAddBikeForm({ manufacturer: "", model: "", year: "" });
                                  await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                                } finally {
                                  setAddBikeSaving(false);
                                }
                              }}
                              style={({ pressed }) => ({ flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: 8, backgroundColor: colors.primary, opacity: pressed || addBikeSaving ? 0.75 : 1 })}
                            >
                              {addBikeSaving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={{ fontSize: 13, color: "#fff", fontFamily: "Inter_700Bold" }}>Add Bike</Text>}
                            </Pressable>
                          </View>
                        </View>
                      ) : (
                        <Pressable
                          onPress={() => { setShowAddBike(profile.id); setAddBikeForm({ manufacturer: "", model: "", year: "" }); }}
                          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, borderStyle: "dashed", opacity: pressed ? 0.7 : 1, backgroundColor: colors.background })}
                        >
                          <Feather name="plus" size={14} color={colors.mutedForeground} />
                          <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_600SemiBold" }}>Add bike</Text>
                        </Pressable>
                      )}
                    </View>

                    {/* Engine Hours */}
                    <View>
                      <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
                        Current Engine Hours — used for maintenance intervals
                      </Text>
                      <TextInput
                        keyboardType="numeric"
                        returnKeyType="done"
                        placeholder="e.g. 48"
                        placeholderTextColor={colors.mutedForeground}
                        value={garageEdit.bikeHours}
                        onChangeText={v => setGarageEdit(prev => ({ ...prev, bikeHours: v.replace(/[^0-9]/g, "") }))}
                        style={{
                          borderWidth: 1, borderColor: colors.border, borderRadius: 10,
                          paddingHorizontal: 12, paddingVertical: 10,
                          fontSize: 15, color: colors.foreground, fontFamily: "Inter_400Regular",
                          backgroundColor: colors.background,
                        }}
                      />
                    </View>

                    {/* Experience Level */}
                    <View>
                      <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
                        Riding Experience — used by Rocky AI
                      </Text>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                        {LEVELS.map(lvl => {
                          const selected = garageEdit.rideExperience.toLowerCase() === lvl.toLowerCase();
                          return (
                            <Pressable
                              key={lvl}
                              onPress={() => setGarageEdit(prev => ({ ...prev, rideExperience: lvl.toLowerCase() }))}
                              style={({ pressed }) => ({
                                paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
                                backgroundColor: selected ? colors.primary : colors.background,
                                borderWidth: 1.5, borderColor: selected ? colors.primary : colors.border,
                                opacity: pressed ? 0.75 : 1,
                              })}
                            >
                              <Text style={{ fontSize: 13, fontWeight: "600", color: selected ? "#fff" : colors.mutedForeground, fontFamily: "Inter_600SemiBold" }}>{lvl}</Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>

                    {/* Race Types */}
                    <View>
                      <Text style={{ fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
                        Race Types — used by Rocky AI
                      </Text>
                      <View style={{ gap: 6 }}>
                        {RACE_TYPES.map(discipline => {
                          const isChecked = garageEdit.raceTypes.includes(discipline);
                          return (
                            <Pressable
                              key={discipline}
                              onPress={() => {
                                const next = isChecked
                                  ? garageEdit.raceTypes.filter(t => t !== discipline)
                                  : [...garageEdit.raceTypes, discipline];
                                setGarageEdit(prev => ({ ...prev, raceTypes: next }));
                                void Haptics.selectionAsync();
                              }}
                              style={({ pressed }) => ({
                                flexDirection: "row", alignItems: "center", gap: 10,
                                paddingHorizontal: 12, paddingVertical: 10,
                                borderRadius: 10, borderWidth: 1.5,
                                borderColor: isChecked ? colors.primary : colors.border,
                                backgroundColor: isChecked ? colors.primary + "12" : colors.background,
                                opacity: pressed ? 0.75 : 1,
                              })}
                            >
                              <View style={{
                                width: 20, height: 20, borderRadius: 4,
                                borderWidth: 2, borderColor: isChecked ? colors.primary : colors.border + "aa",
                                backgroundColor: isChecked ? colors.primary : "transparent",
                                alignItems: "center", justifyContent: "center",
                              }}>
                                {isChecked && <Feather name="check" size={12} color="#fff" />}
                              </View>
                              <Text style={{ fontSize: 14, fontWeight: "600", color: isChecked ? colors.primary : colors.foreground, fontFamily: "Inter_600SemiBold" }}>
                                {discipline}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>

                    {/* Save experience */}
                    <Pressable
                      onPress={async () => {
                        setGarageSaving(true);
                        try {
                          const [, res] = await Promise.all([
                            setBikeInfo(profile.id, { rideExperience: garageEdit.rideExperience, bikeHours: garageEdit.bikeHours }),
                            riderFetch(`/api/rider/profiles/${profile.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ raceTypes: garageEdit.raceTypes }),
                            }),
                          ]);
                          if (!res.ok) {
                            const data = await res.json().catch(() => null);
                            throw new Error(data?.error ?? `Couldn't save your race types (error ${res.status}).`);
                          }
                          await refreshProfiles();
                          setExpandedGarageId(null);
                          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        } catch (e: any) {
                          const msg = e instanceof TypeError ? NETWORK_ERROR_MESSAGE : (e?.message ?? "Couldn't save garage settings");
                          Alert.alert("Garage not saved", msg);
                          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                        } finally {
                          setGarageSaving(false);
                        }
                      }}
                      disabled={garageSaving}
                      style={({ pressed }) => ({
                        backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 12,
                        alignItems: "center", opacity: pressed || garageSaving ? 0.75 : 1,
                      })}
                    >
                      {garageSaving ? (
                        <ActivityIndicator color="#fff" size="small" />
                      ) : (
                        <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700", fontFamily: "Inter_700Bold" }}>Save Garage Settings</Text>
                      )}
                    </Pressable>
                  </View>
                )}

              </View>
            );
          })}
        </>
      )}

      {/* ─── Settings ─────────────────────────────────── */}
      <Text style={[s.sectionLabel, { marginTop: 6 }]}>Settings</Text>
      <View style={s.listCard}>
          <Pressable onPress={() => router.push("/organizations" as any)} style={({ pressed }) => [s.settingRow, { opacity: pressed ? 0.75 : 1 }]}>
            <View style={s.settingIcon}><Feather name="flag" size={15} color={colors.primary} /></View>
            <View style={{ flex: 1 }}>
              <Text style={s.settingLabel}>Race organizations</Text>
              <Text style={s.settingSub}>Clubs you race with and their alerts</Text>
            </View>
            <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
          </Pressable>
        <View style={s.settingDivider} />
        <View style={s.settingRow}>
          <View style={s.settingIcon}><Feather name={themePref === "dark" ? "moon" : "sun"} size={15} color={colors.primary} /></View>
          <Text style={[s.settingLabel, { flex: 1 }]}>Appearance</Text>
          <View style={s.miniSeg}>
            {(["light", "dark"] as ThemePreference[]).map(option => {
              const isActive = themePref === option;
              return (
                <Pressable
                  key={option}
                  onPress={async () => { setThemePref(option); await Haptics.selectionAsync(); }}
                  style={[s.miniSegBtn, isActive && { backgroundColor: colors.primary }]}
                >
                  <Feather name={option === "light" ? "sun" : "moon"} size={12} color={isActive ? "#fff" : colors.mutedForeground} />
                  <Text style={{ fontSize: 11, fontFamily: "Inter_700Bold", color: isActive ? "#fff" : colors.mutedForeground }}>{option === "light" ? "Light" : "Dark"}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        <View style={s.settingDivider} />
          <Pressable onPress={() => { setShowSecurity(v => !v); setPwError(null); setPwSuccess(false); }} style={({ pressed }) => [s.settingRow, { opacity: pressed ? 0.75 : 1 }]}>
            <View style={s.settingIcon}><Feather name="lock" size={15} color={colors.primary} /></View>
            <View style={{ flex: 1 }}>
              <Text style={s.settingLabel}>Security</Text>
              <Text style={s.settingSub}>{biometricHardware ? "Face ID / fingerprint and password" : "Change your password"}</Text>
            </View>
            <Feather name={showSecurity ? "chevron-up" : "chevron-down"} size={16} color={colors.mutedForeground} />
          </Pressable>
        <View style={{ paddingHorizontal: 12 }}>
        {showSecurity && (
            <View style={{
              backgroundColor: colors.card, borderRadius: 14,
              borderWidth: 1, borderColor: colors.border, padding: 16, gap: 12,
            }}>
              {/* Biometric toggle */}
              {biometricHardware && (
                <Pressable
                  onPress={handleToggleBiometric}
                  style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
                >
                  <Feather
                    name={biometricType === "face" ? "aperture" : "check-circle"}
                    size={18}
                    color={biometricEnabled ? colors.primary : colors.mutedForeground}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: colors.foreground, fontFamily: "Inter_600SemiBold" }}>
                      {biometricType === "face" ? "Face ID" : "Fingerprint"} sign-in
                    </Text>
                    <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>
                      {biometricEnabled ? "Enabled — tap to disable" : "Tap to enable quick biometric sign-in"}
                    </Text>
                  </View>
                  <View style={{
                    width: 44, height: 26, borderRadius: 13,
                    backgroundColor: biometricEnabled ? colors.primary : colors.muted,
                    justifyContent: "center",
                    paddingHorizontal: 3,
                  }}>
                    <View style={{
                      width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff",
                      alignSelf: biometricEnabled ? "flex-end" : "flex-start",
                    }} />
                  </View>
                </Pressable>
              )}
  
              {biometricHardware && !biometricEnabled && bioSetupOpen && (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                    Enter your password once. It's stored in this device's secure keychain and used only for {biometricType === "face" ? "Face ID" : "fingerprint"} sign-in.
                  </Text>
                  {bioError && (
                    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: colors.dangerTint, borderRadius: 8, padding: 10 }}>
                      <Feather name="alert-circle" size={14} color={colors.destructive} style={{ marginTop: 1 }} />
                      <Text style={{ flex: 1, fontSize: 13, color: colors.destructive, fontFamily: "Inter_400Regular" }}>{bioError}</Text>
                    </View>
                  )}
                  <View style={{
                    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
                    borderRadius: 10, backgroundColor: colors.muted, paddingHorizontal: 12,
                  }}>
                    <TextInput
                      style={{ paddingVertical: 12, fontSize: 14, color: colors.foreground, fontFamily: "Inter_400Regular" }}
                      placeholder="Your password"
                      placeholderTextColor={colors.mutedForeground}
                      secureTextEntry
                      value={bioPassword}
                      onChangeText={setBioPassword}
                      autoCapitalize="none"
                      returnKeyType="done"
                      onSubmitEditing={handleConfirmBiometric}
                    />
                  </View>
                  <Pressable
                    onPress={handleConfirmBiometric}
                    disabled={bioSaving}
                    style={({ pressed }) => ({
                      backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 13,
                      alignItems: "center", opacity: pressed || bioSaving ? 0.75 : 1,
                    })}
                  >
                    {bioSaving
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700", fontFamily: "Inter_700Bold" }}>
                          Turn On {biometricType === "face" ? "Face ID" : "Fingerprint"}
                        </Text>
                    }
                  </Pressable>
                </View>
              )}
  
              {biometricHardware && (
                <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />
              )}
  
              {/* Change password */}
              <Text style={{ fontSize: 13, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5 }}>
                Change Password
              </Text>
  
              {pwSuccess ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.successTint, borderRadius: 8, padding: 10 }}>
                  <Feather name="check-circle" size={14} color={colors.success} />
                  <Text style={{ fontSize: 13, color: colors.success, fontFamily: "Inter_400Regular" }}>Password updated successfully</Text>
                </View>
              ) : (
                <>
                  {pwError && (
                    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: colors.dangerTint, borderRadius: 8, padding: 10 }}>
                      <Feather name="alert-circle" size={14} color={colors.destructive} style={{ marginTop: 1 }} />
                      <Text style={{ flex: 1, fontSize: 13, color: colors.destructive, fontFamily: "Inter_400Regular" }}>{pwError}</Text>
                    </View>
                  )}
                  <View style={{
                    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
                    borderRadius: 10, backgroundColor: colors.muted, paddingHorizontal: 12,
                  }}>
                    <TextInput
                      style={{ paddingVertical: 12, fontSize: 14, color: colors.foreground, fontFamily: "Inter_400Regular" }}
                      placeholder="Current password"
                      placeholderTextColor={colors.mutedForeground}
                      secureTextEntry
                      value={pwCurrent}
                      onChangeText={setPwCurrent}
                      autoCapitalize="none"
                    />
                  </View>
                  <View style={{
                    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
                    borderRadius: 10, backgroundColor: colors.muted, paddingHorizontal: 12,
                  }}>
                    <TextInput
                      style={{ paddingVertical: 12, fontSize: 14, color: colors.foreground, fontFamily: "Inter_400Regular" }}
                      placeholder="New password (min 8 characters)"
                      placeholderTextColor={colors.mutedForeground}
                      secureTextEntry
                      value={pwNew}
                      onChangeText={setPwNew}
                      autoCapitalize="none"
                    />
                  </View>
                  <View style={{
                    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
                    borderRadius: 10, backgroundColor: colors.muted, paddingHorizontal: 12,
                  }}>
                    <TextInput
                      style={{ paddingVertical: 12, fontSize: 14, color: colors.foreground, fontFamily: "Inter_400Regular" }}
                      placeholder="Confirm new password"
                      placeholderTextColor={colors.mutedForeground}
                      secureTextEntry
                      value={pwConfirm}
                      onChangeText={setPwConfirm}
                      autoCapitalize="none"
                      returnKeyType="done"
                      onSubmitEditing={handleChangePassword}
                    />
                  </View>
                  <Pressable
                    onPress={handleChangePassword}
                    disabled={pwSaving}
                    style={({ pressed }) => ({
                      backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 13,
                      alignItems: "center", opacity: pressed || pwSaving ? 0.75 : 1,
                    })}
                  >
                    {pwSaving
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700", fontFamily: "Inter_700Bold" }}>Update Password</Text>
                    }
                  </Pressable>
                </>
              )}
            </View>
          )}
        </View>
        <View style={s.settingDivider} />
          <Pressable onPress={() => setShowLinkHelp(v => !v)} style={({ pressed }) => [s.settingRow, { opacity: pressed ? 0.75 : 1 }]}>
            <View style={s.settingIcon}><Feather name="link" size={15} color={colors.primary} /></View>
            <View style={{ flex: 1 }}>
              <Text style={s.settingLabel}>How profiles link</Text>
            </View>
            <Feather name={showLinkHelp ? "chevron-up" : "chevron-down"} size={16} color={colors.mutedForeground} />
          </Pressable>
        {showLinkHelp && (
          <Text style={[s.infoText, { paddingHorizontal: 16, paddingBottom: 14 }]}>
            Rider profiles link by email. Register a family member with this email and they show up here. Check several riders to see their combined schedule, history and stats.
          </Text>
        )}
        <View style={s.settingDivider} />
          <Pressable onPress={handleOpenPrivacy} style={({ pressed }) => [s.settingRow, { opacity: pressed ? 0.75 : 1 }]}>
            <View style={s.settingIcon}><Feather name="shield" size={15} color={colors.primary} /></View>
            <View style={{ flex: 1 }}>
              <Text style={s.settingLabel}>Privacy policy</Text>
            </View>
            <Feather name="external-link" size={15} color={colors.mutedForeground} />
          </Pressable>
      </View>

      {/* ─── Account ──────────────────────────────────── */}
      <View style={s.listCard}>
        <Pressable onPress={handleSignOut} disabled={loggingOut} style={({ pressed }) => [s.settingRow, { opacity: pressed ? 0.75 : 1 }]}>
          <View style={[s.settingIcon, { backgroundColor: colors.dangerTint }]}>
            {loggingOut ? <ActivityIndicator color={colors.destructive} size="small" /> : <Feather name="log-out" size={15} color={colors.destructive} />}
          </View>
          <Text style={[s.settingLabel, { flex: 1, color: colors.destructive }]}>Sign out</Text>
        </Pressable>
        <View style={s.settingDivider} />
        <Pressable onPress={handleDeleteAccount} disabled={deletingAccount || loggingOut} style={({ pressed }) => [s.settingRow, { opacity: pressed ? 0.75 : 1 }]}>
          <View style={[s.settingIcon, { backgroundColor: colors.dangerTint }]}>
            {deletingAccount ? <ActivityIndicator color={colors.destructive} size="small" /> : <Feather name="trash-2" size={15} color={colors.destructive} />}
          </View>
          <Text style={[s.settingLabel, { flex: 1, color: colors.destructive }]}>Delete account</Text>
        </Pressable>
      </View>
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
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {isAuthenticated ? <ProfileList /> : <View style={{ flex: 1, paddingTop: insets.top }}><AuthForm /></View>}
    </View>
  );
}
