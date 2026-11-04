/**
 * Racer profile settings on the rider screen: profile and background photos,
 * who can see the profile, the number-plate colour, and a short bio, with a link to the profile itself.
 * Riders under 18 are private unless a parent or manager makes them public.
 */
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { NumberPlate, PLATE_COLORS, PLATE_COLOR_NAMES } from "@/components/NumberPlate";
import { RacerPhotos } from "@/components/RacerPhotos";
import { fonts } from "@/constants/fonts";
import { useColors } from "@/hooks/useColors";

const BIO_MAX = 160;

export interface RacerProfileFields {
  bio: string | null;
  plateColor: string | null;
  profileVisibility: "public" | "private" | null;
  effectiveVisibility: "public" | "private";
  isMinor: boolean;
  bibNumber: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
}

export function RacerProfileSettings({
  riderId, initial, riderFetch, name, onPhotosChanged,
}: {
  riderId: number;
  initial: RacerProfileFields;
  riderFetch: (path: string, options?: RequestInit) => Promise<Response>;
  name: string;
  onPhotosChanged?: () => void;
}) {
  const colors = useColors();
  const router = useRouter();
  const [fields, setFields] = useState(initial);
  const [bio, setBio] = useState(initial.bio ?? "");
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(key: string, body: Record<string, unknown>) {
    setSaving(key);
    setError(null);
    try {
      const res = await riderFetch(`/api/rider/profiles/${riderId}`, { method: "PATCH", body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `Error ${res.status}`);
      setFields(f => ({
        ...f,
        bio: data.bio ?? null,
        plateColor: data.plateColor ?? null,
        profileVisibility: data.profileVisibility ?? null,
        effectiveVisibility: data.effectiveVisibility ?? f.effectiveVisibility,
      }));
      setBio(data.bio ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save. Try again.");
    } finally {
      setSaving(null);
    }
  }

  const label = { fontSize: 13, color: colors.mutedForeground, fontFamily: fonts.display, textTransform: "uppercase" as const, letterSpacing: 1.1 };
  const isPublic = fields.effectiveVisibility === "public";

  return (
    <View style={{ backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 14, marginBottom: 16 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 18, color: colors.foreground, fontFamily: fonts.displayItalic, textTransform: "uppercase" }}>Racer profile</Text>
        <Pressable onPress={() => router.push(`/racer/${riderId}` as any)} accessibilityRole="button"
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 4, opacity: pressed ? 0.6 : 1 })}>
          <Text style={{ fontSize: 14, color: colors.primaryText, fontFamily: fonts.semibold }}>View</Text>
          <Feather name="chevron-right" size={16} color={colors.primaryText} />
        </Pressable>
      </View>

      {/* Profile photo and background photo */}
      <RacerPhotos riderId={riderId} name={name} riderFetch={riderFetch} onChanged={onPhotosChanged}
        initial={{ avatarUrl: initial.avatarUrl, coverUrl: initial.coverUrl }} />

      {/* Who can see it */}
      <View style={{ gap: 8 }}>
        <Text style={label}>Who can see the photos, bio and home state</Text>
        <View style={{ flexDirection: "row", borderRadius: 999, borderWidth: 1, borderColor: colors.border, padding: 3 }} accessibilityRole="radiogroup">
          {(["public", "private"] as const).map(v => {
            const on = fields.effectiveVisibility === v;
            return (
              <Pressable
                key={v}
                onPress={() => !on && save("visibility", { profileVisibility: v })}
                disabled={saving != null}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                style={{ flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 999, backgroundColor: on ? colors.foreground : "transparent" }}
              >
                <Text style={{ fontSize: 14, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1, color: on ? colors.background : colors.foreground }}>
                  {v === "public" ? "Everyone" : "Only us"}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={{ fontSize: 12, lineHeight: 17, color: colors.mutedForeground, fontFamily: fonts.regular }}>
          {isPublic
            ? "Signed-in riders can find this profile and see the photos, bio and home state."
            : "Other riders see published results only, with initials instead of photos. The profile isn't listed in rider search."}
          {fields.isMinor && fields.profileVisibility == null ? " Riders under 18 start private." : ""}
        </Text>
      </View>

      {/* Plate colour */}
      <View style={{ gap: 8 }}>
        <Text style={label}>Number plate</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          {PLATE_COLOR_NAMES.map(c => {
            const on = (fields.plateColor ?? "white") === c;
            return (
              <Pressable
                key={c}
                onPress={() => !on && save("plate", { plateColor: c })}
                disabled={saving != null}
                accessibilityRole="radio"
                accessibilityLabel={`${c} plate`}
                accessibilityState={{ selected: on }}
                style={{ borderRadius: 8, borderWidth: 2, borderColor: on ? colors.foreground : "transparent", padding: 2 }}
              >
                {fields.bibNumber
                  ? <NumberPlate number={fields.bibNumber} color={c} size={26} />
                  : <View style={{ width: 34, height: 24, borderRadius: 5, backgroundColor: PLATE_COLORS[c].bg, borderBottomWidth: 4, borderBottomColor: PLATE_COLORS[c].border }} />}
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Bio */}
      <View style={{ gap: 8 }}>
        <Text style={label}>Bio</Text>
        <TextInput
          value={bio}
          onChangeText={t => setBio(t.slice(0, BIO_MAX))}
          placeholder="e.g. 250 B rider out of Boise. Chasing the Snake River title."
          placeholderTextColor={colors.mutedForeground}
          multiline
          maxLength={BIO_MAX}
          style={{ minHeight: 64, borderWidth: 2, borderColor: colors.border, borderRadius: 4, padding: 10, color: colors.foreground, fontFamily: fonts.regular, fontSize: 15, textAlignVertical: "top" }}
          accessibilityLabel="Bio"
        />
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.regular }}>{bio.length}/{BIO_MAX}</Text>
          <Pressable
            onPress={() => save("bio", { bio })}
            disabled={saving != null || bio === (fields.bio ?? "")}
            accessibilityRole="button"
            style={({ pressed }) => ({
              paddingHorizontal: 18, paddingVertical: 8, borderRadius: 999, backgroundColor: colors.primary,
              opacity: bio === (fields.bio ?? "") ? 0.4 : pressed ? 0.7 : 1,
            })}
          >
            {saving === "bio" ? <ActivityIndicator color="#fff" size="small" /> : (
              <Text style={{ color: "#FFFFFF", fontFamily: fonts.display, fontSize: 14, textTransform: "uppercase", letterSpacing: 1 }}>Save bio</Text>
            )}
          </Pressable>
        </View>
      </View>

      {saving && saving !== "bio" ? <ActivityIndicator color={colors.primaryText} size="small" /> : null}
      {error ? <Text style={{ fontSize: 13, color: colors.destructive, fontFamily: fonts.medium }}>{error}</Text> : null}
    </View>
  );
}
