import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useState } from "react";
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

import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";

const BIKE_BRANDS = [
  { name: "KTM",       color: "#FF6600", text: "#ffffff" },
  { name: "Honda",     color: "#CC0000", text: "#ffffff" },
  { name: "Gas Gas",   color: "#E30613", text: "#ffffff" },
  { name: "Husqvarna", color: "#F5C222", text: "#000000" },
  { name: "Yamaha",    color: "#003087", text: "#ffffff" },
  { name: "Kawasaki",  color: "#3D9B35", text: "#ffffff" },
  { name: "Suzuki",    color: "#FFDE00", text: "#000000" },
  { name: "Beta",      color: "#E8220D", text: "#ffffff" },
] as const;

export default function NewRiderScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const { riderFetch, refreshProfiles } = useRiderAuth();

  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    dateOfBirth: "",
    bibNumber: "",
    amaNumber: "",
    bikeManufacturer: "",
    bikeModel: "",
    bikeYear: "",
    sponsors: "",
    homeState: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setField(key: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleCreate() {
    if (!form.firstName.trim() || !form.lastName.trim()) {
      setError("First and last name are required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await riderFetch("/api/rider/profiles", {
        method: "POST",
        body: JSON.stringify({
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          phone: form.phone.trim() || null,
          dateOfBirth: form.dateOfBirth.trim() || null,
          bibNumber: form.bibNumber.trim() || null,
          amaNumber: form.amaNumber.trim() || null,
          bikeManufacturer: form.bikeManufacturer.trim() || null,
          bikeModel: form.bikeModel.trim() || null,
          bikeYear: form.bikeYear.trim() || null,
          sponsors: form.sponsors.trim() || null,
          homeState: form.homeState.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error ?? `Error ${res.status}`);
      }
      await refreshProfiles();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (e: any) {
      setError(e.message);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setSaving(false);
    }
  }

  const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: 12,
    },
    backBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.muted,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: {
      flex: 1,
      fontSize: 17,
      fontWeight: "700",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
    },
    createBtn: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      backgroundColor: colors.primary,
      borderRadius: 8,
    },
    createBtnText: {
      fontSize: 13,
      color: "#fff",
      fontFamily: "Inter_600SemiBold",
    },
    scroll: { flex: 1 },
    scrollContent: {
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: insets.bottom + 32,
      gap: 16,
    },
    section: {
      backgroundColor: colors.card,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: "hidden",
    },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      backgroundColor: colors.muted + "60",
    },
    sectionTitle: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.mutedForeground,
      fontFamily: "Inter_700Bold",
      textTransform: "uppercase",
      letterSpacing: 0.8,
    },
    fieldRow: {
      paddingHorizontal: 16,
      paddingVertical: 13,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    fieldRowLast: {
      paddingHorizontal: 16,
      paddingVertical: 13,
    },
    fieldLabel: {
      fontSize: 10,
      fontWeight: "700",
      color: colors.mutedForeground,
      fontFamily: "Inter_700Bold",
      textTransform: "uppercase",
      letterSpacing: 0.6,
      marginBottom: 4,
    },
    fieldInput: {
      fontSize: 15,
      color: colors.foreground,
      fontFamily: "Inter_400Regular",
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderColor: colors.primary,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      backgroundColor: colors.background,
    },
    twoCol: { flexDirection: "row" },
    twoColField: { flex: 1, paddingHorizontal: 16, paddingVertical: 13 },
    twoColDivider: { width: StyleSheet.hairlineWidth, backgroundColor: colors.border },
    brandGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      paddingHorizontal: 16,
      paddingBottom: 12,
    },
    brandBtn: {
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderWidth: 2,
      minWidth: 72,
      alignItems: "center",
    },
    brandBtnText: {
      fontSize: 12,
      fontWeight: "800",
      fontFamily: "Inter_700Bold",
      letterSpacing: 0.4,
    },
    brandOtherInput: {
      fontSize: 14,
      color: colors.foreground,
      fontFamily: "Inter_400Regular",
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      backgroundColor: colors.background,
      marginHorizontal: 16,
      marginBottom: 14,
    },
    errorBanner: {
      backgroundColor: "#FEE2E2",
      borderRadius: 10,
      padding: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    errorText: {
      flex: 1,
      fontSize: 13,
      color: "#DC2626",
      fontFamily: "Inter_400Regular",
    },
    note: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      textAlign: "center",
      lineHeight: 18,
    },
  });

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable style={s.backBtn} onPress={() => router.back()} disabled={saving}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </Pressable>
        <Text style={s.headerTitle}>New Rider Profile</Text>
        <Pressable style={s.createBtn} onPress={handleCreate} disabled={saving}>
          {saving ? (
            <ActivityIndicator color="#fff" size="small" style={{ width: 50 }} />
          ) : (
            <Text style={s.createBtnText}>Create</Text>
          )}
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {error && (
            <View style={s.errorBanner}>
              <Feather name="alert-circle" size={15} color="#DC2626" />
              <Text style={s.errorText}>{error}</Text>
            </View>
          )}

          {/* Personal */}
          <View style={s.section}>
            <View style={s.sectionHeader}>
              <Feather name="user" size={13} color={colors.mutedForeground} />
              <Text style={s.sectionTitle}>Personal</Text>
            </View>

            <View style={[s.twoCol, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
              <View style={s.twoColField}>
                <Text style={s.fieldLabel}>First Name *</Text>
                <TextInput
                  style={s.fieldInput}
                  value={form.firstName}
                  onChangeText={(v) => setField("firstName", v)}
                  placeholder="First name"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="words"
                />
              </View>
              <View style={s.twoColDivider} />
              <View style={s.twoColField}>
                <Text style={s.fieldLabel}>Last Name *</Text>
                <TextInput
                  style={s.fieldInput}
                  value={form.lastName}
                  onChangeText={(v) => setField("lastName", v)}
                  placeholder="Last name"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="words"
                />
              </View>
            </View>

            <View style={[s.twoCol, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
              <View style={s.twoColField}>
                <Text style={s.fieldLabel}>Phone</Text>
                <TextInput
                  style={s.fieldInput}
                  value={form.phone}
                  onChangeText={(v) => setField("phone", v)}
                  placeholder="555-867-5309"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="phone-pad"
                />
              </View>
              <View style={s.twoColDivider} />
              <View style={s.twoColField}>
                <Text style={s.fieldLabel}>Date of Birth</Text>
                <TextInput
                  style={s.fieldInput}
                  value={form.dateOfBirth}
                  onChangeText={(v) => setField("dateOfBirth", v)}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.mutedForeground}
                  autoCorrect={false}
                />
              </View>
            </View>

            <View style={[s.twoCol]}>
              <View style={s.twoColField}>
                <Text style={s.fieldLabel}>Home State</Text>
                <TextInput
                  style={s.fieldInput}
                  value={form.homeState}
                  onChangeText={(v) => setField("homeState", v)}
                  placeholder="e.g. AZ"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="characters"
                  maxLength={2}
                />
              </View>
              <View style={s.twoColDivider} />
              <View style={s.twoColField} />
            </View>
          </View>

          {/* Racing */}
          <View style={s.section}>
            <View style={s.sectionHeader}>
              <Feather name="flag" size={13} color={colors.mutedForeground} />
              <Text style={s.sectionTitle}>Racing Info</Text>
            </View>

            <View style={[s.twoCol, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
              <View style={s.twoColField}>
                <Text style={s.fieldLabel}>Bib / Plate #</Text>
                <TextInput
                  style={s.fieldInput}
                  value={form.bibNumber}
                  onChangeText={(v) => setField("bibNumber", v)}
                  placeholder="42"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numeric"
                />
              </View>
              <View style={s.twoColDivider} />
              <View style={s.twoColField}>
                <Text style={s.fieldLabel}>AMA Number</Text>
                <TextInput
                  style={s.fieldInput}
                  value={form.amaNumber}
                  onChangeText={(v) => setField("amaNumber", v)}
                  placeholder="AMA #"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numeric"
                />
              </View>
            </View>

            {/* Bike brand */}
            <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
              <View style={{ paddingHorizontal: 16, paddingTop: 13, paddingBottom: 8 }}>
                <Text style={s.fieldLabel}>Bike Brand</Text>
              </View>
              <View style={s.brandGrid}>
                {BIKE_BRANDS.map((brand) => {
                  const selected = form.bikeManufacturer === brand.name;
                  return (
                    <Pressable
                      key={brand.name}
                      style={[
                        s.brandBtn,
                        {
                          backgroundColor: selected ? brand.color : "transparent",
                          borderColor: selected ? brand.color : brand.color + "80",
                        },
                      ]}
                      onPress={() =>
                        setField("bikeManufacturer", selected ? "" : brand.name)
                      }
                    >
                      <Text
                        style={[
                          s.brandBtnText,
                          { color: selected ? brand.text : colors.foreground },
                        ]}
                      >
                        {brand.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <TextInput
                style={s.brandOtherInput}
                value={
                  BIKE_BRANDS.some((b) => b.name === form.bikeManufacturer)
                    ? ""
                    : form.bikeManufacturer
                }
                onChangeText={(v) => setField("bikeManufacturer", v)}
                placeholder="Other brand (e.g. Sherco, TM, Rieju…)"
                placeholderTextColor={colors.mutedForeground}
                autoCorrect={false}
              />
            </View>

            <View style={[s.twoCol, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
              <View style={s.twoColField}>
                <Text style={s.fieldLabel}>Bike Model</Text>
                <TextInput
                  style={s.fieldInput}
                  value={form.bikeModel}
                  onChangeText={(v) => setField("bikeModel", v)}
                  placeholder="e.g. EXC 450"
                  placeholderTextColor={colors.mutedForeground}
                  autoCorrect={false}
                  autoCapitalize="none"
                />
              </View>
              <View style={s.twoColDivider} />
              <View style={s.twoColField}>
                <Text style={s.fieldLabel}>Bike Year</Text>
                <TextInput
                  style={s.fieldInput}
                  value={form.bikeYear}
                  onChangeText={(v) => setField("bikeYear", v)}
                  placeholder="e.g. 2024"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numeric"
                  maxLength={4}
                />
              </View>
            </View>

            <View style={s.fieldRowLast}>
              <Text style={s.fieldLabel}>Sponsors</Text>
              <TextInput
                style={[s.fieldInput, { minHeight: 70, textAlignVertical: "top" }]}
                value={form.sponsors}
                onChangeText={(v) => setField("sponsors", v)}
                placeholder="e.g. Local Moto Shop, Fox Racing"
                placeholderTextColor={colors.mutedForeground}
                multiline
                numberOfLines={3}
              />
            </View>
          </View>

          <Text style={s.note}>
            After creating the profile, you can add your address, emergency contact,
            RFID transponder, and MyLaps number from the profile detail screen.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
