import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
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

// ─── Types ────────────────────────────────────────────────────────────────────

interface RiderFull {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  emergencyContact: string | null;
  emergencyPhone: string | null;
  rfidNumber: string | null;
  bibNumber: string | null;
  amaNumber: string | null;
  bikeManufacturer: string | null;
  bikeModel: string | null;
  bikeYear: string | null;
  sponsors: string | null;
  myLapsTransponderNumber: string | null;
  streetAddress: string | null;
  city: string | null;
  homeState: string | null;
  zip: string | null;
}

type EditForm = Omit<RiderFull, "id" | "email">;

// ─── Bike brands ─────────────────────────────────────────────────────────────

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

// ─── Shared style/color prop types ───────────────────────────────────────────

type ColorsType = ReturnType<typeof useColors>;
type StylesType = { [key: string]: any };

// ─── Module-level field components (stable references across renders) ─────────

function SimpleField({
  label,
  value,
  keyboardType = "default",
  placeholder,
  onChangeText,
  isEdit,
  editValue,
  s,
  colors,
}: {
  label: string;
  value: string | null | undefined;
  keyboardType?: "default" | "phone-pad" | "numeric";
  placeholder?: string;
  onChangeText?: (v: string) => void;
  isEdit: boolean;
  editValue?: string;
  s: StylesType;
  colors: ColorsType;
}) {
  return (
    <>
      <Text style={s.fieldLabel}>{label}</Text>
      {isEdit ? (
        <TextInput
          style={s.fieldInput}
          value={editValue ?? ""}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.mutedForeground}
          keyboardType={keyboardType}
          autoCorrect={false}
          autoCapitalize={keyboardType === "default" ? "words" : "none"}
        />
      ) : value ? (
        <Text style={s.fieldValue}>{value}</Text>
      ) : (
        <Text style={s.fieldEmpty}>Not set</Text>
      )}
    </>
  );
}

const STATE_LIST = [
  { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" }, { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" }, { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" }, { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" }, { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" }, { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" }, { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" }, { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" }, { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" }, { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" }, { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" }, { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" }, { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" }, { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" }, { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" }, { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" }, { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" }, { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" }, { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" }, { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" },
];

function StatePickerField({
  label,
  value,
  isEdit,
  editValue,
  onChangeText,
  s,
  colors,
}: {
  label: string;
  value: string | null | undefined;
  isEdit: boolean;
  editValue?: string;
  onChangeText?: (v: string) => void;
  s: StylesType;
  colors: ColorsType;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? STATE_LIST.filter(
        (st) =>
          st.code.toLowerCase().includes(query.toLowerCase()) ||
          st.name.toLowerCase().includes(query.toLowerCase()),
      )
    : STATE_LIST;

  const selected = STATE_LIST.find(
    (st) => st.code === (editValue ?? "").toUpperCase(),
  );

  return (
    <>
      <Text style={s.fieldLabel}>{label}</Text>
      {isEdit ? (
        <Pressable
          onPress={() => { setQuery(""); setOpen(true); }}
          style={[
            s.fieldInput,
            { justifyContent: "center", paddingVertical: 0 },
          ]}
        >
          <Text style={{ color: selected ? colors.foreground : colors.mutedForeground, fontSize: 14 }}>
            {selected ? `${selected.code} — ${selected.name}` : "Select state…"}
          </Text>
        </Pressable>
      ) : value ? (
        <Text style={s.fieldValue}>{value}</Text>
      ) : (
        <Text style={s.fieldEmpty}>Not set</Text>
      )}

      <Modal visible={open} animationType="slide" transparent>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "75%", paddingBottom: 24 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <Text style={{ fontSize: 16, fontWeight: "600", color: colors.foreground }}>Select State</Text>
              <Pressable onPress={() => setOpen(false)}>
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </Pressable>
            </View>
            <TextInput
              style={{ margin: 12, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, color: colors.foreground, fontSize: 14 }}
              placeholder="Search state…"
              placeholderTextColor={colors.mutedForeground}
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
            />
            <FlatList
              data={filtered}
              keyExtractor={(item) => item.code}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable
                  style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}
                  onPress={() => {
                    onChangeText?.(item.code);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <Text style={{ fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 13, width: 32, color: colors.foreground }}>{item.code}</Text>
                  <Text style={{ fontSize: 14, color: colors.foreground, flex: 1 }}>{item.name}</Text>
                  {(editValue ?? "").toUpperCase() === item.code && (
                    <Feather name="check" size={16} color={colors.primary} />
                  )}
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

function Field({
  label,
  valueKey,
  riderKey,
  placeholder,
  keyboardType = "default",
  isLast = false,
  multiline = false,
  s,
  colors,
  editing,
  form,
  rider,
  setField,
}: {
  label: string;
  valueKey: keyof EditForm;
  riderKey: keyof RiderFull;
  placeholder?: string;
  keyboardType?: "default" | "phone-pad" | "numeric";
  isLast?: boolean;
  multiline?: boolean;
  s: StylesType;
  colors: ColorsType;
  editing: boolean;
  form: EditForm | null;
  rider: RiderFull | null;
  setField: (key: keyof EditForm, value: string) => void;
}) {
  const displayValue = rider?.[riderKey];
  return (
    <View style={isLast ? s.fieldRowLast : s.fieldRow}>
      <Text style={s.fieldLabel}>{label}</Text>
      {editing && form ? (
        multiline ? (
          <TextInput
            style={s.fieldInputMulti}
            value={String(form[valueKey] ?? "")}
            onChangeText={(v) => setField(valueKey, v)}
            placeholder={placeholder}
            placeholderTextColor={colors.mutedForeground}
            multiline
            numberOfLines={3}
          />
        ) : (
          <TextInput
            style={s.fieldInput}
            value={String(form[valueKey] ?? "")}
            onChangeText={(v) => setField(valueKey, v)}
            placeholder={placeholder}
            placeholderTextColor={colors.mutedForeground}
            keyboardType={keyboardType}
            autoCorrect={false}
            autoCapitalize={keyboardType === "default" ? "words" : "none"}
          />
        )
      ) : displayValue ? (
        <Text style={s.fieldValue}>{String(displayValue)}</Text>
      ) : (
        <Text style={s.fieldEmpty}>Not set</Text>
      )}
    </View>
  );
}

function TwoColFields({
  left,
  right,
  isLast = false,
  s,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  isLast?: boolean;
  s: StylesType;
}) {
  return (
    <View style={[s.twoColRow, isLast ? s.fieldRowLast : s.fieldRow, { paddingHorizontal: 0, paddingVertical: 0 }]}>
      <View style={[s.twoColField, { paddingHorizontal: 16, paddingVertical: 13 }]}>{left}</View>
      <View style={s.twoColDivider} />
      <View style={[s.twoColField, { paddingHorizontal: 16, paddingVertical: 13 }]}>{right}</View>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function RiderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const riderId = parseInt(id ?? "", 10);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const { riderFetch, refreshProfiles } = useRiderAuth();

  const [rider, setRider] = useState<RiderFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  // RFID edit state
  const [rfidEditing, setRfidEditing] = useState(false);
  const [rfidValue, setRfidValue] = useState("");
  const [rfidSaving, setRfidSaving] = useState(false);

  useEffect(() => {
    if (isNaN(riderId)) return;
    loadRider();
  }, [riderId]);

  async function loadRider() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await riderFetch(`/api/rider/profiles/${riderId}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error ?? `Error ${res.status}`);
      }
      const data: RiderFull = await res.json();
      setRider(data);
      setRfidValue(data.rfidNumber ?? "");
    } catch (e: any) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function startEdit() {
    if (!rider) return;
    setForm({
      firstName: rider.firstName,
      lastName: rider.lastName,
      phone: rider.phone ?? "",
      dateOfBirth: rider.dateOfBirth ?? "",
      emergencyContact: rider.emergencyContact ?? "",
      emergencyPhone: rider.emergencyPhone ?? "",
      rfidNumber: rider.rfidNumber ?? "",
      bibNumber: rider.bibNumber ?? "",
      amaNumber: rider.amaNumber ?? "",
      bikeManufacturer: rider.bikeManufacturer ?? "",
      bikeModel: rider.bikeModel ?? "",
      bikeYear: rider.bikeYear ?? "",
      sponsors: rider.sponsors ?? "",
      myLapsTransponderNumber: rider.myLapsTransponderNumber ?? "",
      streetAddress: rider.streetAddress ?? "",
      city: rider.city ?? "",
      homeState: rider.homeState ?? "",
      zip: rider.zip ?? "",
    });
    setSaveError(null);
    setSavedOk(false);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setSaveError(null);
  }

  const setField = useCallback((key: keyof EditForm, value: string) => {
    setForm((f) => f ? { ...f, [key]: value } : f);
  }, []);

  async function saveProfile() {
    if (!form || !rider) return;
    if (!form.firstName?.trim() || !form.lastName?.trim()) {
      setSaveError("First and last name are required");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await riderFetch(`/api/rider/profiles/${riderId}`, {
        method: "PATCH",
        body: JSON.stringify({
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          phone: form.phone?.trim() || null,
          dateOfBirth: form.dateOfBirth?.trim() || null,
          emergencyContact: form.emergencyContact?.trim() || null,
          emergencyPhone: form.emergencyPhone?.trim() || null,
          bibNumber: form.bibNumber?.trim() || null,
          amaNumber: form.amaNumber?.trim() || null,
          bikeManufacturer: form.bikeManufacturer?.trim() || null,
          bikeModel: form.bikeModel?.trim() || null,
          bikeYear: form.bikeYear?.trim() || null,
          sponsors: form.sponsors?.trim() || null,
          myLapsTransponderNumber: form.myLapsTransponderNumber?.trim() || null,
          streetAddress: form.streetAddress?.trim() || null,
          city: form.city?.trim() || null,
          homeState: form.homeState?.trim() || null,
          zip: form.zip?.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error ?? `Error ${res.status}`);
      }
      const updated: RiderFull = await res.json();
      setRider({ ...updated, rfidNumber: rider.rfidNumber });
      setEditing(false);
      setSavedOk(true);
      await refreshProfiles();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => setSavedOk(false), 3000);
    } catch (e: any) {
      setSaveError(e.message);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setSaving(false);
    }
  }

  async function saveRfid() {
    if (!rider) return;
    setRfidSaving(true);
    try {
      const res = await riderFetch(`/api/rider/profiles/${riderId}/rfid`, {
        method: "PATCH",
        body: JSON.stringify({ rfidNumber: rfidValue.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error ?? `Error ${res.status}`);
      }
      const data = await res.json();
      setRider((r) => r ? { ...r, rfidNumber: data.rfidNumber } : r);
      setRfidEditing(false);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setRfidSaving(false);
    }
  }

  // ─── Styles ──────────────────────────────────────────────────────────────

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
    editBtn: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      backgroundColor: colors.muted,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
    },
    editBtnText: {
      fontSize: 13,
      color: colors.foreground,
      fontFamily: "Inter_600SemiBold",
    },
    saveBtn: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      backgroundColor: colors.primary,
      borderRadius: 8,
    },
    saveBtnText: {
      fontSize: 13,
      color: "#fff",
      fontFamily: "Inter_600SemiBold",
    },
    cancelBtn: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      backgroundColor: colors.muted,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    cancelBtnText: {
      fontSize: 13,
      color: colors.foreground,
      fontFamily: "Inter_400Regular",
    },
    scroll: { flex: 1 },
    scrollContent: {
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: insets.bottom + 32,
      gap: 16,
    },
    heroCard: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 20,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      alignItems: "center",
      gap: 4,
    },
    heroAvatar: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: colors.primary + "15",
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 8,
    },
    heroName: {
      fontSize: 22,
      fontWeight: "800",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
    },
    heroBib: {
      fontSize: 14,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
    },
    heroEmail: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      marginTop: 2,
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
    fieldValue: {
      fontSize: 15,
      color: colors.foreground,
      fontFamily: "Inter_400Regular",
    },
    fieldEmpty: {
      fontSize: 15,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      fontStyle: "italic",
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
    fieldInputMulti: {
      fontSize: 14,
      color: colors.foreground,
      fontFamily: "Inter_400Regular",
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderColor: colors.primary,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      backgroundColor: colors.background,
      minHeight: 80,
      textAlignVertical: "top",
    },
    twoColRow: {
      flexDirection: "row",
      gap: 0,
    },
    twoColField: {
      flex: 1,
    },
    twoColDivider: {
      width: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
    },
    brandGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      paddingHorizontal: 16,
      paddingBottom: 14,
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
    brandDisplay: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    brandBadge: {
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    brandBadgeText: {
      fontSize: 12,
      fontWeight: "800",
      fontFamily: "Inter_700Bold",
    },
    rfidRow: {
      paddingHorizontal: 16,
      paddingVertical: 13,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    rfidLeft: { flex: 1 },
    rfidEditRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 6,
    },
    rfidInput: {
      flex: 1,
      fontSize: 14,
      color: colors.foreground,
      fontFamily: "Inter_400Regular",
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderColor: colors.primary,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: colors.background,
      fontVariant: ["tabular-nums"],
    },
    rfidSaveBtn: {
      backgroundColor: colors.primary,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    rfidCancelBtn: {
      backgroundColor: colors.muted,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    rfidEditBtn: {
      padding: 6,
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
    savedBanner: {
      backgroundColor: "#DCFCE7",
      borderRadius: 10,
      padding: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    savedText: {
      fontSize: 13,
      color: "#16A34A",
      fontFamily: "Inter_600SemiBold",
    },
    emailNote: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      textAlign: "center",
      paddingHorizontal: 8,
      lineHeight: 18,
    },
    headerBtnRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
  });

  // ─── Loading / error states ───────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[s.root, { paddingTop: insets.top }]}>
        <View style={s.header}>
          <Pressable style={s.backBtn} onPress={() => router.back()}>
            <Feather name="arrow-left" size={18} color={colors.foreground} />
          </Pressable>
          <Text style={s.headerTitle}>Rider Profile</Text>
        </View>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </View>
    );
  }

  if (loadError || !rider) {
    return (
      <View style={[s.root, { paddingTop: insets.top }]}>
        <View style={s.header}>
          <Pressable style={s.backBtn} onPress={() => router.back()}>
            <Feather name="arrow-left" size={18} color={colors.foreground} />
          </Pressable>
          <Text style={s.headerTitle}>Rider Profile</Text>
        </View>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32 }}>
          <Text style={{ color: colors.mutedForeground, textAlign: "center" }}>
            {loadError ?? "Could not load profile."}
          </Text>
          <Pressable
            style={[s.editBtn, { marginTop: 16 }]}
            onPress={loadRider}
          >
            <Text style={s.editBtnText}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const knownBrand = BIKE_BRANDS.find((b) => b.name === rider.bikeManufacturer);

  // ─── Full render ──────────────────────────────────────────────────────────

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable style={s.backBtn} onPress={() => router.back()}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </Pressable>
        <Text style={s.headerTitle} numberOfLines={1}>
          {rider.firstName} {rider.lastName}
        </Text>
        {editing ? (
          <View style={s.headerBtnRow}>
            <Pressable style={s.cancelBtn} onPress={cancelEdit} disabled={saving}>
              <Text style={s.cancelBtnText}>Cancel</Text>
            </Pressable>
            <Pressable style={s.saveBtn} onPress={saveProfile} disabled={saving}>
              {saving ? (
                <ActivityIndicator color="#fff" size="small" style={{ width: 50 }} />
              ) : (
                <Text style={s.saveBtnText}>Save</Text>
              )}
            </Pressable>
          </View>
        ) : (
          <Pressable style={s.editBtn} onPress={startEdit}>
            <Feather name="edit-2" size={13} color={colors.foreground} />
            <Text style={s.editBtnText}>Edit</Text>
          </Pressable>
        )}
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Save feedback banners */}
          {saveError && (
            <View style={s.errorBanner}>
              <Feather name="alert-circle" size={15} color="#DC2626" />
              <Text style={s.errorText}>{saveError}</Text>
            </View>
          )}
          {savedOk && (
            <View style={s.savedBanner}>
              <Feather name="check-circle" size={15} color="#16A34A" />
              <Text style={s.savedText}>Profile saved successfully</Text>
            </View>
          )}

          {/* Hero card */}
          <View style={s.heroCard}>
            <View style={s.heroAvatar}>
              <Feather name="user" size={28} color={colors.primary} />
            </View>
            <Text style={s.heroName}>
              {editing && form
                ? `${form.firstName || "—"} ${form.lastName || "—"}`
                : `${rider.firstName} ${rider.lastName}`}
            </Text>
            {rider.bibNumber && (
              <Text style={s.heroBib}>#{rider.bibNumber}</Text>
            )}
            <Text style={s.heroEmail}>{rider.email}</Text>
          </View>

          {/* ── Personal Info ─────────────────────────────────────────────── */}
          <View style={s.section}>
            <View style={s.sectionHeader}>
              <Feather name="user" size={13} color={colors.mutedForeground} />
              <Text style={s.sectionTitle}>Personal</Text>
            </View>

            <TwoColFields
              s={s}
              left={
                <SimpleField
                  s={s}
                  colors={colors}
                  label="First Name"
                  value={rider.firstName}
                  isEdit={editing}
                  editValue={form?.firstName ?? ""}
                  onChangeText={(v) => setField("firstName", v)}
                  placeholder="First name"
                />
              }
              right={
                <SimpleField
                  s={s}
                  colors={colors}
                  label="Last Name"
                  value={rider.lastName}
                  isEdit={editing}
                  editValue={form?.lastName ?? ""}
                  onChangeText={(v) => setField("lastName", v)}
                  placeholder="Last name"
                />
              }
            />

            <TwoColFields
              s={s}
              left={
                <SimpleField
                  s={s}
                  colors={colors}
                  label="Phone"
                  value={rider.phone}
                  isEdit={editing}
                  editValue={form?.phone ?? ""}
                  onChangeText={(v) => setField("phone", v)}
                  placeholder="555-867-5309"
                  keyboardType="phone-pad"
                />
              }
              right={
                <SimpleField
                  s={s}
                  colors={colors}
                  label="Date of Birth"
                  value={rider.dateOfBirth}
                  isEdit={editing}
                  editValue={form?.dateOfBirth ?? ""}
                  onChangeText={(v) => setField("dateOfBirth", v)}
                  placeholder="YYYY-MM-DD"
                />
              }
            />

            <View style={s.fieldRow}>
              <Text style={s.fieldLabel}>Street Address</Text>
              {editing && form ? (
                <TextInput
                  style={s.fieldInput}
                  value={form.streetAddress ?? ""}
                  onChangeText={(v) => setField("streetAddress", v)}
                  placeholder="123 Main St"
                  placeholderTextColor={colors.mutedForeground}
                  autoCorrect={false}
                />
              ) : rider.streetAddress ? (
                <Text style={s.fieldValue}>{rider.streetAddress}</Text>
              ) : (
                <Text style={s.fieldEmpty}>Not set</Text>
              )}
            </View>

            <TwoColFields
              s={s}
              left={
                <SimpleField
                  s={s}
                  colors={colors}
                  label="City"
                  value={rider.city}
                  isEdit={editing}
                  editValue={form?.city ?? ""}
                  onChangeText={(v) => setField("city", v)}
                  placeholder="City"
                />
              }
              right={
                <StatePickerField
                  s={s}
                  colors={colors}
                  label="State"
                  value={rider.homeState}
                  isEdit={editing}
                  editValue={form?.homeState ?? ""}
                  onChangeText={(v) => setField("homeState", v)}
                />
              }
            />

            <TwoColFields
              s={s}
              isLast
              left={
                <SimpleField
                  s={s}
                  colors={colors}
                  label="Zip Code"
                  value={rider.zip}
                  isEdit={editing}
                  editValue={form?.zip ?? ""}
                  onChangeText={(v) => setField("zip", v)}
                  placeholder="85001"
                  keyboardType="numeric"
                />
              }
              right={<View />}
            />
          </View>

          {/* ── Racing Info ───────────────────────────────────────────────── */}
          <View style={s.section}>
            <View style={s.sectionHeader}>
              <Feather name="flag" size={13} color={colors.mutedForeground} />
              <Text style={s.sectionTitle}>Racing Info</Text>
            </View>

            <TwoColFields
              s={s}
              left={
                <SimpleField
                  s={s}
                  colors={colors}
                  label="Bib / Plate #"
                  value={rider.bibNumber}
                  isEdit={editing}
                  editValue={form?.bibNumber ?? ""}
                  onChangeText={(v) => setField("bibNumber", v)}
                  placeholder="42"
                  keyboardType="numeric"
                />
              }
              right={
                <SimpleField
                  s={s}
                  colors={colors}
                  label="AMA Number"
                  value={rider.amaNumber}
                  isEdit={editing}
                  editValue={form?.amaNumber ?? ""}
                  onChangeText={(v) => setField("amaNumber", v)}
                  placeholder="AMA #"
                  keyboardType="numeric"
                />
              }
            />

            {/* Bike Brand */}
            <View style={s.fieldRow}>
              <Text style={s.fieldLabel}>Bike Brand</Text>
              {!editing && (
                knownBrand ? (
                  <View style={[s.brandBadge, { backgroundColor: knownBrand.color, alignSelf: "flex-start" }]}>
                    <Text style={[s.brandBadgeText, { color: knownBrand.text }]}>{knownBrand.name}</Text>
                  </View>
                ) : rider.bikeManufacturer ? (
                  <Text style={s.fieldValue}>{rider.bikeManufacturer}</Text>
                ) : (
                  <Text style={s.fieldEmpty}>Not set</Text>
                )
              )}
            </View>
            {editing && form && (
              <>
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
                      : (form.bikeManufacturer ?? "")
                  }
                  onChangeText={(v) => setField("bikeManufacturer", v)}
                  placeholder="Other brand (e.g. Sherco, TM, Rieju…)"
                  placeholderTextColor={colors.mutedForeground}
                  autoCorrect={false}
                />
              </>
            )}

            <TwoColFields
              s={s}
              left={
                <SimpleField
                  s={s}
                  colors={colors}
                  label="Bike Model"
                  value={rider.bikeModel}
                  isEdit={editing}
                  editValue={form?.bikeModel ?? ""}
                  onChangeText={(v) => setField("bikeModel", v)}
                  placeholder="e.g. EXC 450"
                />
              }
              right={
                <SimpleField
                  s={s}
                  colors={colors}
                  label="Bike Year"
                  value={rider.bikeYear}
                  isEdit={editing}
                  editValue={form?.bikeYear ?? ""}
                  onChangeText={(v) => setField("bikeYear", v)}
                  placeholder="e.g. 2024"
                  keyboardType="numeric"
                />
              }
            />

            {/* MyLaps transponder */}
            <View style={s.fieldRow}>
              <Text style={s.fieldLabel}>MyLaps Transponder #</Text>
              {editing && form ? (
                <TextInput
                  style={s.fieldInput}
                  value={form.myLapsTransponderNumber ?? ""}
                  onChangeText={(v) => setField("myLapsTransponderNumber", v)}
                  placeholder="e.g. 4012345"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numeric"
                  autoCorrect={false}
                />
              ) : rider.myLapsTransponderNumber ? (
                <Text style={[s.fieldValue, { fontVariant: ["tabular-nums"] }]}>
                  {rider.myLapsTransponderNumber}
                </Text>
              ) : (
                <Text style={s.fieldEmpty}>Not set</Text>
              )}
            </View>

            {/* RFID transponder — always separate inline edit */}
            <View style={[s.rfidRow, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
              <View style={s.rfidLeft}>
                <Text style={s.fieldLabel}>RFID Transponder</Text>
                {rfidEditing ? (
                  <View style={s.rfidEditRow}>
                    <TextInput
                      style={s.rfidInput}
                      value={rfidValue}
                      onChangeText={setRfidValue}
                      placeholder="e.g. AB12CD34"
                      placeholderTextColor={colors.mutedForeground}
                      autoCorrect={false}
                      autoCapitalize="characters"
                      autoFocus
                      onSubmitEditing={saveRfid}
                    />
                    <Pressable style={s.rfidSaveBtn} onPress={saveRfid} disabled={rfidSaving}>
                      {rfidSaving ? (
                        <ActivityIndicator color="#fff" size="small" />
                      ) : (
                        <Feather name="check" size={16} color="#fff" />
                      )}
                    </Pressable>
                    <Pressable
                      style={s.rfidCancelBtn}
                      onPress={() => { setRfidEditing(false); setRfidValue(rider.rfidNumber ?? ""); }}
                      disabled={rfidSaving}
                    >
                      <Feather name="x" size={16} color={colors.foreground} />
                    </Pressable>
                  </View>
                ) : rider.rfidNumber ? (
                  <Text style={[s.fieldValue, { fontVariant: ["tabular-nums"] }]}>
                    {rider.rfidNumber}
                  </Text>
                ) : (
                  <Text style={s.fieldEmpty}>No transponder set</Text>
                )}
              </View>
              {!rfidEditing && (
                <Pressable
                  style={s.rfidEditBtn}
                  onPress={() => { setRfidValue(rider.rfidNumber ?? ""); setRfidEditing(true); }}
                >
                  <Feather name="edit-2" size={14} color={colors.mutedForeground} />
                </Pressable>
              )}
            </View>

            {/* Sponsors */}
            <View style={s.fieldRowLast}>
              <Text style={s.fieldLabel}>Sponsors</Text>
              {editing && form ? (
                <TextInput
                  style={s.fieldInputMulti}
                  value={form.sponsors ?? ""}
                  onChangeText={(v) => setField("sponsors", v)}
                  placeholder="e.g. Local Moto Shop, Fox Racing"
                  placeholderTextColor={colors.mutedForeground}
                  multiline
                  numberOfLines={3}
                />
              ) : rider.sponsors ? (
                <Text style={s.fieldValue}>{rider.sponsors}</Text>
              ) : (
                <Text style={s.fieldEmpty}>Not set</Text>
              )}
            </View>
          </View>

          {/* ── Emergency Contact ─────────────────────────────────────────── */}
          <View style={s.section}>
            <View style={s.sectionHeader}>
              <Feather name="shield" size={13} color={colors.mutedForeground} />
              <Text style={s.sectionTitle}>Emergency Contact</Text>
            </View>

            <TwoColFields
              s={s}
              isLast
              left={
                <SimpleField
                  s={s}
                  colors={colors}
                  label="Contact Name"
                  value={rider.emergencyContact}
                  isEdit={editing}
                  editValue={form?.emergencyContact ?? ""}
                  onChangeText={(v) => setField("emergencyContact", v)}
                  placeholder="Full name"
                />
              }
              right={
                <SimpleField
                  s={s}
                  colors={colors}
                  label="Contact Phone"
                  value={rider.emergencyPhone}
                  isEdit={editing}
                  editValue={form?.emergencyPhone ?? ""}
                  onChangeText={(v) => setField("emergencyPhone", v)}
                  placeholder="555-867-5309"
                  keyboardType="phone-pad"
                />
              }
            />
          </View>

          {/* Email note */}
          <Text style={s.emailNote}>
            Email address cannot be changed here — it links your race history.
            Contact your event organizer to update your email.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
