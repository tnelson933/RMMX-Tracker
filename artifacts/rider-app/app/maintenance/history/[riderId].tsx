import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";

const ACCENT = "#cf152d";

interface HistoryEntry {
  id: number;
  riderId: number;
  itemKey: string;
  itemName: string;
  servicedAt: string;
  notes: string | null;
  createdAt: string;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function toInputDate(dateStr: string): string {
  return dateStr.slice(0, 10);
}

function EditModal({
  entry,
  visible,
  onClose,
  onSave,
}: {
  entry: HistoryEntry | null;
  visible: boolean;
  onClose: () => void;
  onSave: (id: number, servicedAt: string, notes: string) => Promise<void>;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [servicedAt, setServicedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (entry) {
      setServicedAt(toInputDate(entry.servicedAt));
      setNotes(entry.notes ?? "");
    }
  }, [entry]);

  async function handleSave() {
    if (!entry) return;
    if (!servicedAt.match(/^\d{4}-\d{2}-\d{2}$/)) {
      Alert.alert("Invalid date", "Enter a date in YYYY-MM-DD format.");
      return;
    }
    setSaving(true);
    try {
      await onSave(entry.id, servicedAt, notes);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const s = StyleSheet.create({
    overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
    sheet: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 20, borderTopRightRadius: 20,
      paddingHorizontal: 20, paddingTop: 20,
      paddingBottom: insets.bottom + 24,
    },
    handle: {
      width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border,
      alignSelf: "center", marginBottom: 16,
    },
    title: { fontSize: 17, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", marginBottom: 20 },
    label: { fontSize: 12, fontWeight: "600", color: colors.mutedForeground, fontFamily: "Inter_600SemiBold", marginBottom: 6 },
    input: {
      backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border,
      borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11,
      fontSize: 14, color: colors.foreground, fontFamily: "Inter_400Regular",
    },
    inputArea: { height: 80, textAlignVertical: "top" },
    row: { flexDirection: "row", gap: 12, marginTop: 20 },
    cancelBtn: {
      flex: 1, paddingVertical: 13, borderRadius: 12,
      borderWidth: 1, borderColor: colors.border,
      alignItems: "center",
    },
    cancelText: { fontSize: 14, fontWeight: "600", color: colors.foreground, fontFamily: "Inter_600SemiBold" },
    saveBtn: { flex: 1, paddingVertical: 13, borderRadius: 12, backgroundColor: ACCENT, alignItems: "center" },
    saveText: { fontSize: 14, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" },
  });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={s.overlay}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={s.sheet}>
          <View style={s.handle} />
          <Text style={s.title}>Edit Entry — {entry?.itemName}</Text>

          <Text style={s.label}>SERVICE DATE (YYYY-MM-DD)</Text>
          <TextInput
            style={s.input}
            value={servicedAt}
            onChangeText={setServicedAt}
            placeholder="2024-06-15"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="numbers-and-punctuation"
            maxLength={10}
          />

          <Text style={[s.label, { marginTop: 14 }]}>NOTES (OPTIONAL)</Text>
          <TextInput
            style={[s.input, s.inputArea]}
            value={notes}
            onChangeText={setNotes}
            placeholder="e.g. Used Motul 10W-40"
            placeholderTextColor={colors.mutedForeground}
            multiline
            maxLength={300}
          />

          <View style={s.row}>
            <Pressable style={s.cancelBtn} onPress={onClose}>
              <Text style={s.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable style={s.saveBtn} onPress={handleSave} disabled={saving}>
              {saving ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={s.saveText}>Save</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function HistoryRow({
  entry,
  colors,
  onEdit,
  onDelete,
}: {
  entry: HistoryEntry;
  colors: ReturnType<typeof useColors>;
  onEdit: (entry: HistoryEntry) => void;
  onDelete: (entry: HistoryEntry) => void;
}) {
  const swipeableRef = useRef<Swipeable>(null);

  function renderRightActions() {
    return (
      <View style={{ flexDirection: "row", marginBottom: 0 }}>
        <Pressable
          style={{
            backgroundColor: "#3B82F6",
            justifyContent: "center",
            alignItems: "center",
            width: 72,
            borderRadius: 12,
            marginLeft: 6,
          }}
          onPress={() => {
            swipeableRef.current?.close();
            onEdit(entry);
          }}
        >
          <Feather name="edit-2" size={18} color="#fff" />
          <Text style={{ fontSize: 10, color: "#fff", fontFamily: "Inter_600SemiBold", marginTop: 3 }}>Edit</Text>
        </Pressable>
        <Pressable
          style={{
            backgroundColor: "#EF4444",
            justifyContent: "center",
            alignItems: "center",
            width: 72,
            borderRadius: 12,
            marginLeft: 6,
          }}
          onPress={() => {
            swipeableRef.current?.close();
            onDelete(entry);
          }}
        >
          <Feather name="trash-2" size={18} color="#fff" />
          <Text style={{ fontSize: 10, color: "#fff", fontFamily: "Inter_600SemiBold", marginTop: 3 }}>Delete</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Swipeable
      ref={swipeableRef}
      renderRightActions={renderRightActions}
      rightThreshold={40}
      overshootRight={false}
      onSwipeableWillOpen={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
    >
      <Pressable
        onPress={() => onEdit(entry)}
        style={({ pressed }) => ({
          backgroundColor: pressed ? colors.muted : colors.card,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          padding: 14,
          gap: 4,
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 14, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", flex: 1 }}>
            {entry.itemName}
          </Text>
          <Feather name="chevron-right" size={14} color={colors.mutedForeground} style={{ opacity: 0.5 }} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Feather name="calendar" size={11} color={colors.mutedForeground} />
          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
            {formatDate(entry.servicedAt)}
          </Text>
        </View>
        {entry.notes ? (
          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", fontStyle: "italic", marginTop: 2 }}>
            {entry.notes}
          </Text>
        ) : null}
      </Pressable>
    </Swipeable>
  );
}

export default function MaintenanceHistoryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const { riderId: riderIdParam } = useLocalSearchParams<{ riderId: string }>();
  const riderId = parseInt(riderIdParam ?? "", 10);
  const { riderFetch, profiles } = useRiderAuth();

  const profile = profiles.find(p => p.id === riderId);
  const bikeStr = [profile?.bikeYear, profile?.bikeManufacturer, profile?.bikeModel]
    .filter(Boolean).join(" ");
  const nameStr = bikeStr || `${profile?.firstName ?? ""} ${profile?.lastName ?? ""}`.trim();

  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editEntry, setEditEntry] = useState<HistoryEntry | null>(null);
  const [editVisible, setEditVisible] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await riderFetch(`/api/rider/maintenance/${riderId}/history`);
      if (res.ok) setEntries(await res.json());
    } catch { }
  }, [riderFetch, riderId]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function openEdit(entry: HistoryEntry) {
    setEditEntry(entry);
    setEditVisible(true);
  }

  async function handleSave(id: number, servicedAt: string, notes: string) {
    const res = await riderFetch(`/api/rider/maintenance/${riderId}/history/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ servicedAt, notes: notes.trim() || null }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Failed to save");
    }
    const updated: HistoryEntry = await res.json();
    setEntries(prev => prev.map(e => e.id === id ? updated : e));
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function handleDelete(entry: HistoryEntry) {
    Alert.alert(
      "Delete Entry",
      `Remove the "${entry.itemName}" entry from ${formatDate(entry.servicedAt)}? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            const res = await riderFetch(`/api/rider/maintenance/${riderId}/history/${entry.id}`, {
              method: "DELETE",
            });
            if (res.ok) {
              setEntries(prev => prev.filter(e => e.id !== entry.id));
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            } else {
              Alert.alert("Error", "Could not delete the entry. Please try again.");
            }
          },
        },
      ]
    );
  }

  const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: "row", alignItems: "center", gap: 12,
      paddingHorizontal: 16, paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    backBtn: {
      width: 36, height: 36, borderRadius: 18, backgroundColor: colors.muted,
      alignItems: "center", justifyContent: "center",
    },
    headerCenter: { flex: 1 },
    headerTitle: { fontSize: 17, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" },
    headerSub: { fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 },
    hint: {
      fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular",
      textAlign: "center", marginBottom: 2, opacity: 0.7,
    },
    scroll: { flex: 1 },
    content: { padding: 16, gap: 10, paddingBottom: insets.bottom + 32 },
    emptyBox: {
      backgroundColor: colors.card, borderRadius: 14, padding: 40,
      alignItems: "center", gap: 12, borderWidth: 1, borderColor: colors.border,
      marginTop: 16,
    },
    emptyTitle: { fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" },
    emptyText: {
      fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular",
      textAlign: "center", lineHeight: 19,
    },
    countLabel: {
      fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular",
      textAlign: "center", marginBottom: 4,
    },
  });

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable style={s.backBtn} onPress={() => router.back()}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </Pressable>
        <View style={s.headerCenter}>
          <Text style={s.headerTitle}>Service History</Text>
          {nameStr ? <Text style={s.headerSub}>{nameStr}</Text> : null}
        </View>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={ACCENT} />
        </View>
      ) : (
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.content}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        >
          {entries.length === 0 ? (
            <View style={s.emptyBox}>
              <Feather name="clock" size={36} color={colors.mutedForeground + "50"} />
              <Text style={s.emptyTitle}>No Service History</Text>
              <Text style={s.emptyText}>
                Every time you log a service on the maintenance screen, it will appear here.
              </Text>
            </View>
          ) : (
            <>
              <Text style={s.countLabel}>
                {entries.length} {entries.length === 1 ? "entry" : "entries"} — newest first
              </Text>
              <Text style={s.hint}>Tap to edit · Swipe left to edit or delete</Text>
              {entries.map(entry => (
                <HistoryRow
                  key={entry.id}
                  entry={entry}
                  colors={colors}
                  onEdit={openEdit}
                  onDelete={handleDelete}
                />
              ))}
            </>
          )}
        </ScrollView>
      )}

      <EditModal
        entry={editEntry}
        visible={editVisible}
        onClose={() => setEditVisible(false)}
        onSave={handleSave}
      />
    </View>
  );
}
