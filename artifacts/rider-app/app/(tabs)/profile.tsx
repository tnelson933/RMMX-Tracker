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
import { BottomTabBarHeightContext } from "@react-navigation/bottom-tabs";

import { DirtBikeIcon } from "@/components/DirtBikeIcon";
import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";
import { useTheme, type ThemePreference } from "@/context/ThemeContext";
import { BrandBar } from "@/components/BrandBar";

const ACCENT = "#cf152d";

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
    title: { fontSize: 26, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", letterSpacing: -0.5 },
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
    error: { backgroundColor: "#FEE2E2", borderRadius: 8, padding: 12, fontSize: 13, color: "#DC2626", fontFamily: "Inter_400Regular" },
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
  } = useRiderAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedGarageId, setExpandedGarageId] = useState<number | null>(null);
  const [garageEdit, setGarageEdit] = useState<{ rideExperience: string; bikeHours: string; raceTypes: string[] }>({ rideExperience: "", bikeHours: "", raceTypes: [] });
  const [garageSaving, setGarageSaving] = useState(false);
  const [showAddBike, setShowAddBike] = useState<number | null>(null);
  const [addBikeForm, setAddBikeForm] = useState({ manufacturer: "", model: "", year: "" });
  const [addBikeSaving, setAddBikeSaving] = useState(false);

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
    container: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: (tabBarHeight > 0 ? tabBarHeight : 49 + insets.bottom) + 16, gap: 14 },
    pageTitle: { fontSize: 26, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", letterSpacing: -0.5 },
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
    // Active summary banner
    activeBanner: {
      flexDirection: "row", alignItems: "center", gap: 8,
      backgroundColor: ACCENT + "14", borderRadius: 10, padding: 10,
      borderWidth: 1, borderColor: ACCENT + "35",
    },
    activeBannerText: { flex: 1, fontSize: 13, fontWeight: "600", color: ACCENT, fontFamily: "Inter_600SemiBold" },
    activeBannerBtn: {
      paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20,
      backgroundColor: ACCENT, flexDirection: "row", alignItems: "center", gap: 4,
    },
    activeBannerBtnText: { fontSize: 11, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
    // Profile card
    profileCard: {
      backgroundColor: colors.card, borderRadius: 14,
      borderWidth: 1, borderColor: colors.border, overflow: "hidden",
    },
    profileCardSelected: { borderWidth: 1.5, borderColor: ACCENT },
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
        <BrandBar />
        <Text style={s.pageTitle}>My Profiles</Text>
        <Text style={s.pageSubtitle}>Select which riders drive the app data</Text>
      </View>

      {/* Account email */}
      <View style={s.accountCard}>
        <View style={s.accountIcon}>
          <Feather name="mail" size={18} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.accountLabel}>Account Email</Text>
          <Text style={s.accountEmail} numberOfLines={1}>{account?.email}</Text>
        </View>
      </View>

      {/* Rider profiles section */}
      {profiles.length > 0 && (
        <>
          <View style={s.sectionRow}>
            <View>
              <Text style={s.sectionLabel}>Rider Profiles</Text>
              <Text style={s.sectionHint}>Tap a card to activate or deactivate</Text>
            </View>
            {profiles.length > 1 && (
              <Pressable
                onPress={handleSelectAll}
                style={({ pressed }) => ({
                  paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
                  backgroundColor: allSelected ? ACCENT : colors.muted,
                  borderWidth: 1, borderColor: allSelected ? ACCENT : colors.border,
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

          {/* Active summary banner */}
          <View style={s.activeBanner}>
            <Feather name="check-circle" size={14} color={ACCENT} />
            <Text style={s.activeBannerText} numberOfLines={1}>
              Showing: {activeSummary()}
            </Text>
          </View>
        </>
      )}

      {/* Profile cards */}
      {profiles.length === 0 ? (
        <View style={s.emptyBox}>
          <Feather name="user" size={36} color={colors.mutedForeground + "50"} />
          <Text style={s.emptyTitle}>No Rider Profiles</Text>
          <Text style={s.emptyText}>
            No profiles linked yet. Register for an event with this email or add a profile manually.
          </Text>
        </View>
      ) : (
        profiles.map((profile) => {
          const isSelected = selectedProfileIds.includes(profile.id);
          const isOnlyOne = selectedProfileIds.length === 1 && isSelected;
          return (
            <Pressable
              key={profile.id}
              onPress={() => toggleProfile(profile.id)}
              style={({ pressed }) => [
                s.profileCard,
                isSelected && s.profileCardSelected,
                { opacity: pressed ? 0.85 : 1 },
              ]}
            >
              {/* Selected accent bar */}
              {isSelected && (
                <View style={{ height: 3, backgroundColor: ACCENT }} />
              )}

              <View style={s.profileCardInner}>
                <View style={s.profileRow}>
                  <View style={s.profileLeft}>
                    {/* Avatar */}
                    <View style={[s.profileAvatar, { backgroundColor: isSelected ? ACCENT + "20" : colors.primary + "12" }]}>
                      <Feather name="user" size={20} color={isSelected ? ACCENT : colors.primary} />
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

                  {/* Checkbox */}
                  <View style={[
                    s.checkOuter,
                    { borderColor: isSelected ? ACCENT : colors.border + "aa", backgroundColor: isSelected ? ACCENT : "transparent" },
                  ]}>
                    {isSelected ? (
                      <Feather name="check" size={14} color="#fff" />
                    ) : (
                      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.muted }} />
                    )}
                  </View>
                </View>

                {/* Stats */}
                <View style={s.statsRow}>
                  <View style={s.statBox}>
                    <Text style={s.statLabel}>Events</Text>
                    <Text style={s.statValue}>{profile.eventsRaced}</Text>
                  </View>
                  <View style={s.statBox}>
                    <Text style={s.statLabel}>Best Finish</Text>
                    <Text style={s.statValue}>{profile.bestPosition ? `P${profile.bestPosition}` : "—"}</Text>
                  </View>
                  <View style={s.statBox}>
                    <Text style={s.statLabel}>Points</Text>
                    <Text style={s.statValuePrimary}>{profile.totalPoints}</Text>
                  </View>
                </View>

                {profile.lastRaced && (
                  <Text style={s.lastRaced}>
                    Last raced:{" "}
                    {new Date(profile.lastRaced.includes("T") ? profile.lastRaced : profile.lastRaced + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </Text>
                )}

                {/* Can't-deselect hint */}
                {isOnlyOne && (
                  <Text style={{ fontSize: 10, color: colors.mutedForeground + "70", fontFamily: "Inter_400Regular", marginTop: 6 }}>
                    At least one rider must be active
                  </Text>
                )}

                {/* Edit profile button — nested Pressable captures touch before outer toggle */}
                <Pressable
                  onPress={() => router.push(`/rider/${profile.id}` as any)}
                  style={({ pressed }) => ({
                    marginTop: 10,
                    paddingTop: 10,
                    borderTopWidth: 1,
                    borderTopColor: colors.border + "80",
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    opacity: pressed ? 0.5 : 1,
                  })}
                >
                  <Feather name="edit-2" size={12} color={colors.primary} />
                  <Text style={{ fontSize: 12, fontWeight: "600", color: colors.primary, fontFamily: "Inter_600SemiBold" }}>
                    Edit Profile
                  </Text>
                  <Feather name="chevron-right" size={12} color={colors.primary} />
                </Pressable>
              </View>
            </Pressable>
          );
        })
      )}

      {/* ─── My Race Organizations ───────────────────── */}
      {profiles.length > 0 && (
        <Pressable
          onPress={() => router.push("/organizations" as any)}
          style={({ pressed }) => ({
            backgroundColor: colors.card,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.border,
            flexDirection: "row",
            alignItems: "center",
            padding: 16,
            gap: 12,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: ACCENT + "15", alignItems: "center", justifyContent: "center" }}>
            <Feather name="flag" size={18} color={ACCENT} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
              My Race Organizations
            </Text>
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>
              Clubs you've raced with &amp; notification settings
            </Text>
          </View>
          <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
        </Pressable>
      )}

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
                  <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: ACCENT + "18", alignItems: "center", justifyContent: "center" }}>
                    <DirtBikeIcon size={20} color={ACCENT} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
                      {profile.firstName} {profile.lastName}
                    </Text>
                    {bikeStr ? (
                      <Text style={{ fontSize: 12, color: ACCENT, fontFamily: "Inter_500Medium", marginTop: 1 }}>{bikeStr}</Text>
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
                              borderColor: bike.isDefault ? ACCENT : colors.border,
                              backgroundColor: bike.isDefault ? ACCENT + "10" : colors.background,
                              marginBottom: 6, opacity: pressed ? 0.75 : 1,
                            })}
                          >
                            <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: bike.isDefault ? ACCENT : colors.border, backgroundColor: bike.isDefault ? ACCENT : "transparent", alignItems: "center", justifyContent: "center" }}>
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
                              style={({ pressed }) => ({ flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: 8, backgroundColor: ACCENT, opacity: pressed || addBikeSaving ? 0.75 : 1 })}
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
                                backgroundColor: selected ? ACCENT : colors.background,
                                borderWidth: 1.5, borderColor: selected ? ACCENT : colors.border,
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
                                borderColor: isChecked ? ACCENT : colors.border,
                                backgroundColor: isChecked ? ACCENT + "12" : colors.background,
                                opacity: pressed ? 0.75 : 1,
                              })}
                            >
                              <View style={{
                                width: 20, height: 20, borderRadius: 4,
                                borderWidth: 2, borderColor: isChecked ? ACCENT : colors.border + "aa",
                                backgroundColor: isChecked ? ACCENT : "transparent",
                                alignItems: "center", justifyContent: "center",
                              }}>
                                {isChecked && <Feather name="check" size={12} color="#fff" />}
                              </View>
                              <Text style={{ fontSize: 14, fontWeight: "600", color: isChecked ? ACCENT : colors.foreground, fontFamily: "Inter_600SemiBold" }}>
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
                          await Promise.all([
                            setBikeInfo(profile.id, { rideExperience: garageEdit.rideExperience, bikeHours: garageEdit.bikeHours }),
                            riderFetch(`/api/rider/profiles/${profile.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ raceTypes: garageEdit.raceTypes }),
                            }),
                          ]);
                          await refreshProfiles();
                          setExpandedGarageId(null);
                          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        } finally {
                          setGarageSaving(false);
                        }
                      }}
                      disabled={garageSaving}
                      style={({ pressed }) => ({
                        backgroundColor: ACCENT, borderRadius: 10, paddingVertical: 12,
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

                {/* Maintenance schedule link */}
                <Pressable
                  onPress={() => router.push(`/maintenance/${profile.id}` as any)}
                  style={({ pressed }) => ({
                    flexDirection: "row", alignItems: "center", gap: 8,
                    paddingHorizontal: 14, paddingVertical: 11,
                    opacity: pressed ? 0.7 : 1,
                    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
                  })}
                >
                  <Feather name="tool" size={14} color={colors.primary} />
                  <Text style={{ flex: 1, fontSize: 13, color: colors.primary, fontFamily: "Inter_600SemiBold" }}>
                    Maintenance Schedule
                  </Text>
                  <Feather name="chevron-right" size={14} color={colors.primary} />
                </Pressable>
              </View>
            );
          })}
        </>
      )}

      {/* Add profile */}
      <Pressable style={s.addBtn} onPress={() => router.push("/rider/new" as any)}>
        <Feather name="user-plus" size={16} color={colors.mutedForeground} />
        <Text style={s.addBtnText}>Add Rider Profile</Text>
      </Pressable>

      {/* Info */}
      <View style={s.infoCard}>
        <Text style={s.infoTitle}>How profiles are linked</Text>
        <Text style={s.infoText}>
          Rider profiles are automatically linked by email address. If you register a family member using this email, their profile will appear here. Select multiple riders to view their combined schedule, history, and stats across the app.
        </Text>
      </View>

      {/* ─── Appearance ──────────────────────────────── */}
      <View>
        <Text style={[s.sectionLabel, { marginBottom: 8 }]}>Appearance</Text>
        <View style={{
          backgroundColor: colors.card, borderRadius: 14,
          borderWidth: 1, borderColor: colors.border,
          flexDirection: "row", overflow: "hidden",
        }}>
          {(["light", "dark"] as ThemePreference[]).map((option, idx) => {
            const isActive = themePref === option;
            const label = option === "light" ? "Light" : "Dark";
            const icon = option === "light" ? "sun" : "moon";
            return (
              <Pressable
                key={option}
                onPress={async () => {
                  setThemePref(option);
                  await Haptics.selectionAsync();
                }}
                style={({ pressed }) => ({
                  flex: 1,
                  alignItems: "center",
                  justifyContent: "center",
                  paddingVertical: 12,
                  gap: 4,
                  backgroundColor: isActive ? ACCENT : "transparent",
                  borderLeftWidth: idx > 0 ? 1 : 0,
                  borderLeftColor: colors.border,
                  opacity: pressed ? 0.75 : 1,
                })}
              >
                <Feather
                  name={icon as any}
                  size={16}
                  color={isActive ? "#fff" : colors.mutedForeground}
                />
                <Text style={{
                  fontSize: 12, fontWeight: "700",
                  fontFamily: "Inter_700Bold",
                  color: isActive ? "#fff" : colors.mutedForeground,
                }}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Sign out */}
      <Pressable style={s.signOutBtn} onPress={handleSignOut} disabled={loggingOut}>
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
