/**
 * The rider's own RM TrackRs and RFID stickers (e.g. one per bike), on the
 * rider screen. Any of them times the rider. Riders add numbers nobody else has
 * and remove their own; a number on someone else's profile is refused (the
 * organizer moves those). Servers before this feature answer 404: then the
 * single numbers from the profile are shown read-only, as before.
 */
import { Feather } from "@expo/vector-icons";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, TextInput, View } from "react-native";

import { fonts } from "@/constants/fonts";
import { useColors } from "@/hooks/useColors";
import { NETWORK_ERROR_MESSAGE } from "@/lib/friendlyErrors";

export interface RiderTransponder {
  id: number;
  number: string;
  kind: "trackr" | "rfid";
  kindName: string;
  label: string | null;
  primary: boolean;
}

type Kind = "trackr" | "rfid";
const KIND_NAMES: Record<Kind, string> = { trackr: "RM TrackR", rfid: "RFID sticker" };

export function RiderTransponders({
  riderId, riderFetch, fallback,
}: {
  riderId: number;
  riderFetch: (path: string, options?: RequestInit) => Promise<Response>;
  /** The profile's single numbers, shown when the server has no list yet. */
  fallback: { trackr: string | null; rfid: string | null };
}) {
  const colors = useColors();
  const [list, setList] = useState<RiderTransponder[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [number, setNumber] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<Kind>("trackr");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await riderFetch(`/api/rider/profiles/${riderId}/transponders`);
      if (r.status === 404) { setUnsupported(true); return; }
      if (!r.ok) { setLoadFailed(true); return; }
      setList(await r.json());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [riderId, riderFetch]);
  useEffect(() => { void load(); }, [load]);

  const add = useCallback(async () => {
    const value = number.trim();
    if (!value || saving) return;
    setSaving(true);
    try {
      const r = await riderFetch(`/api/rider/profiles/${riderId}/transponders`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: value, kind, label: label.trim() || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `Error ${r.status}`);
      setList(j as RiderTransponder[]);
      setNumber("");
      setLabel("");
    } catch (e) {
      Alert.alert("Couldn't add it", e instanceof TypeError ? NETWORK_ERROR_MESSAGE : e instanceof Error ? e.message : "Try again.");
    } finally {
      setSaving(false);
    }
  }, [riderId, riderFetch, number, label, kind, saving]);

  const remove = useCallback((t: RiderTransponder) => {
    Alert.alert(`Remove ${t.kindName} ${t.number}?`, "It won't time you any more. You can add it back later.", [
      { text: "Keep", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: async () => {
        try {
          const r = await riderFetch(`/api/rider/profiles/${riderId}/transponders/${t.id}`, { method: "DELETE" });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { Alert.alert("Couldn't remove it", (j as { error?: string }).error ?? `Error ${r.status}`); return; }
          setList(j as RiderTransponder[]);
        } catch {
          Alert.alert("Couldn't remove it", NETWORK_ERROR_MESSAGE);
        }
      } },
    ]);
  }, [riderId, riderFetch]);

  const card = { backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 10, marginBottom: 16 } as const;
  const title = <Text style={{ fontSize: 18, color: colors.foreground, fontFamily: fonts.displayItalic, textTransform: "uppercase" }}>My transponders</Text>;
  const muted = { fontSize: 13, color: colors.mutedForeground, fontFamily: fonts.regular, lineHeight: 18 };
  const input = { borderRadius: 4, borderWidth: 2, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, color: colors.foreground, fontFamily: fonts.regular, fontSize: 15 } as const;

  if (unsupported) {
    // Older server: the single numbers, read-only (only organizers changed them then).
    return (
      <View style={card}>
        {title}
        <Text style={{ fontSize: 14, color: colors.foreground, fontFamily: fonts.semibold }} testID="rmtrackr-number">RM TrackR: {fallback.trackr ?? "None on file"}</Text>
        <Text style={{ fontSize: 14, color: colors.foreground, fontFamily: fonts.semibold }} testID="rfid-number">RFID sticker: {fallback.rfid ?? "None on file"}</Text>
        <Text style={muted}>Only the organizer can change these. If one is wrong, see the check-in booth.</Text>
      </View>
    );
  }

  return (
    <View style={card} testID="rider-transponders">
      {title}
      <Text style={muted}>Your RM TrackRs and RFID stickers, e.g. one per bike. Any of them times you at races and practice.</Text>
      {list == null && !loadFailed && <ActivityIndicator color={colors.mutedForeground} />}
      {loadFailed && (
        <Pressable onPress={() => void load()} accessibilityRole="button" hitSlop={8}>
          <Text style={muted}>Couldn't load your transponders. Check your signal. <Text style={{ color: colors.primaryText, fontFamily: fonts.semibold }}>Try again</Text></Text>
        </Pressable>
      )}
      {list?.length === 0 && <Text style={muted}>None on file yet. Add the number printed on your RM TrackR.</Text>}
      {list?.map(t => (
        <View key={t.id} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border }}>
          <Feather name="radio" size={16} color={colors.mutedForeground} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, color: colors.foreground, fontFamily: fonts.semibold, fontVariant: ["tabular-nums"] }}>{t.number}</Text>
            <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.regular, marginTop: 2 }}>
              {t.kindName}{t.label ? ` · ${t.label}` : ""}
            </Text>
          </View>
          <Pressable onPress={() => remove(t)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${t.kindName} ${t.number}`}>
            <Feather name="x-circle" size={18} color={colors.mutedForeground} />
          </Pressable>
        </View>
      ))}
      {list != null && (
        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 }}>
          <View style={{ flexDirection: "row", gap: 8 }} accessibilityRole="radiogroup">
            {(["trackr", "rfid"] as const).map(k => (
              <Pressable key={k} onPress={() => setKind(k)} accessibilityRole="radio" accessibilityState={{ checked: kind === k }}
                style={{ borderRadius: 999, borderWidth: 2, borderColor: kind === k ? colors.primary : colors.border, backgroundColor: kind === k ? colors.primary : "transparent", paddingHorizontal: 14, paddingVertical: 6 }}>
                <Text style={{ color: kind === k ? "#FFFFFF" : colors.foreground, fontFamily: fonts.semibold, fontSize: 13 }}>{KIND_NAMES[k]}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            value={number} onChangeText={setNumber} placeholder={kind === "trackr" ? "Number printed on your RM TrackR" : "Sticker number"}
            placeholderTextColor={colors.mutedForeground} autoCapitalize="characters" autoCorrect={false}
            accessibilityLabel={kind === "trackr" ? "RM TrackR number" : "RFID sticker number"} style={input}
          />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput
              value={label} onChangeText={setLabel} placeholder="Bike (optional)" maxLength={60}
              placeholderTextColor={colors.mutedForeground} onSubmitEditing={add} returnKeyType="done"
              accessibilityLabel="Bike (optional)" style={[input, { flex: 1 }]}
            />
            <Pressable onPress={add} disabled={saving || !number.trim()} accessibilityRole="button"
              style={({ pressed }) => ({ backgroundColor: colors.primary, borderRadius: 999, paddingHorizontal: 20, alignItems: "center", justifyContent: "center", opacity: pressed || saving || !number.trim() ? 0.6 : 1 })}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={{ color: "#FFFFFF", fontFamily: fonts.display, fontSize: 15, textTransform: "uppercase", letterSpacing: 1 }}>Add</Text>}
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}
