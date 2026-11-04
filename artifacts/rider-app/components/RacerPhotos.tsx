/**
 * Profile photo and background photo on the rider's racer profile settings.
 * Choose from the library or take one with the camera (permission is asked
 * only when tapped), crop, shrink to a sensible size, then upload.
 *
 * The picker and manipulator are native modules added after store build 1.0.21.
 * They're loaded only when the running build has them, so this screen is safe
 * to ship over the air: on an older build the photos still show, and the
 * Choose / Take photo buttons are replaced by a note to update the app.
 */
import { Feather } from "@expo/vector-icons";
import { requireOptionalNativeModule } from "expo";
import type * as ImageManipulatorT from "expo-image-manipulator";
import type * as ImagePickerT from "expo-image-picker";
import React, { useState } from "react";
import { ActivityIndicator, Alert, Linking, Platform, Pressable, Text, View } from "react-native";

import { CoverBackdrop, RiderAvatar } from "@/components/RiderPhoto";
import { PhotoFade } from "@/components/StockBackdrop";
import { fonts } from "@/constants/fonts";
import { useColors } from "@/hooks/useColors";

/** True when this build includes the photo picker and manipulator (always on web). */
export const PHOTO_PICKER_AVAILABLE = Platform.OS === "web" || (
  requireOptionalNativeModule("ExponentImagePicker") != null &&
  requireOptionalNativeModule("ExpoImageManipulator") != null
);

// Loaded on first use only: importing them on a build without the native code throws.
/* eslint-disable @typescript-eslint/no-require-imports */
const loadPicker = () => require("expo-image-picker") as typeof ImagePickerT;
const loadManipulator = () => require("expo-image-manipulator") as typeof ImageManipulatorT;
/* eslint-enable @typescript-eslint/no-require-imports */

type Kind = "avatar" | "cover";
type Source = "library" | "camera";

/** Longest edge after shrinking: a headshot is shown small, a background full width. */
const MAX_WIDTH: Record<Kind, number> = { avatar: 600, cover: 1600 };

function say(title: string, message: string, settings = false) {
  if (Platform.OS === "web") { (globalThis as { alert?: (m: string) => void }).alert?.(`${title}\n\n${message}`); return; }
  Alert.alert(title, message, settings
    ? [{ text: "Not now", style: "cancel" }, { text: "Open Settings", onPress: () => { void Linking.openSettings(); } }]
    : undefined);
}

async function pick(kind: Kind, source: Source): Promise<ImagePickerT.ImagePickerAsset | null> {
  const ImagePicker = loadPicker();
  const options: ImagePickerT.ImagePickerOptions = {
    mediaTypes: ["images"],
    // A square crop for the headshot. iOS only offers a square crop, so the
    // background isn't cropped there (it's shown with "cover" anyway).
    allowsEditing: kind === "avatar" || Platform.OS === "android",
    aspect: kind === "avatar" ? [1, 1] : [16, 9],
    quality: 1,
  };
  if (source === "camera") {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      say("Camera is off for RM Roost", "To take a photo, allow camera access for RM Roost in your phone's Settings.", !perm.canAskAgain);
      return null;
    }
    const r = await ImagePicker.launchCameraAsync(options);
    return r.canceled ? null : r.assets[0] ?? null;
  }
  if (Platform.OS !== "web") {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      say("Photos are off for RM Roost", "To choose a photo, allow photo access for RM Roost in your phone's Settings.", !perm.canAskAgain);
      return null;
    }
  }
  const r = await ImagePicker.launchImageLibraryAsync(options);
  return r.canceled ? null : r.assets[0] ?? null;
}

/** JPEG no wider than the kind's limit, about 80% quality. */
async function shrink(kind: Kind, asset: ImagePickerT.ImagePickerAsset): Promise<string> {
  const ImageManipulator = loadManipulator();
  const actions = asset.width > MAX_WIDTH[kind] ? [{ resize: { width: MAX_WIDTH[kind] } }] : [];
  const out = await ImageManipulator.manipulateAsync(asset.uri, actions, { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG });
  return out.uri;
}

export function RacerPhotos({ riderId, name, initial, riderFetch, onChanged }: {
  riderId: number;
  name: string;
  initial: { avatarUrl: string | null; coverUrl: string | null };
  riderFetch: (path: string, options?: RequestInit) => Promise<Response>;
  /** Called after a change so the rest of the app (Profile tab, header) picks it up. */
  onChanged?: () => void;
}) {
  const colors = useColors();
  const [photos, setPhotos] = useState(initial);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(kind: Kind, source: Source) {
    setError(null);
    try {
      const asset = await pick(kind, source);
      if (!asset) return;
      setBusy(kind);
      const uri = await shrink(kind, asset);
      const blob = await (await fetch(uri)).blob();
      const res = await riderFetch(`/api/rider/profiles/${riderId}/photo?kind=${kind}`, {
        method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `Error ${res.status}`);
      setPhotos({ avatarUrl: data.avatarUrl ?? null, coverUrl: data.coverUrl ?? null });
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't upload the photo. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(kind: Kind) {
    setError(null);
    setBusy(kind);
    try {
      const res = await riderFetch(`/api/rider/profiles/${riderId}/photo?kind=${kind}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `Error ${res.status}`);
      setPhotos({ avatarUrl: data.avatarUrl ?? null, coverUrl: data.coverUrl ?? null });
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove the photo. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const label = { fontSize: 13, color: colors.mutedForeground, fontFamily: fonts.display, textTransform: "uppercase" as const, letterSpacing: 1.1 };
  const Actions = ({ kind, has }: { kind: Kind; has: boolean }) => {
    const what = kind === "avatar" ? "profile photo" : "background photo";
    const btn = (icon: React.ComponentProps<typeof Feather>["name"], text: string, onPress: () => void, a11y: string) => (
      <Pressable
        onPress={onPress}
        disabled={busy != null}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        style={({ pressed }) => ({
          flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999,
          borderWidth: 1.5, borderColor: colors.border, opacity: busy != null ? 0.5 : pressed ? 0.7 : 1,
        })}
      >
        <Feather name={icon} size={14} color={colors.foreground} />
        <Text style={{ fontSize: 13, color: colors.foreground, fontFamily: fonts.semibold }}>{text}</Text>
      </Pressable>
    );
    if (!PHOTO_PICKER_AVAILABLE) {
      return (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {has && btn("trash-2", "Remove", () => { void remove(kind); }, `Remove the ${what}`)}
          <Text style={{ flexShrink: 1, fontSize: 12, lineHeight: 17, color: colors.mutedForeground, fontFamily: fonts.regular }}>
            Update RM Roost from the app store to add photos here, or add them on rmroost.com.
          </Text>
        </View>
      );
    }
    return (
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {btn("image", "Choose", () => { void choose(kind, "library"); }, `Choose a ${what}`)}
        {Platform.OS !== "web" && btn("camera", "Take photo", () => { void choose(kind, "camera"); }, `Take a ${what}`)}
        {has && btn("trash-2", "Remove", () => { void remove(kind); }, `Remove the ${what}`)}
      </View>
    );
  };

  return (
    <View style={{ gap: 14 }}>
      {/* Profile photo */}
      <View style={{ gap: 8 }}>
        <Text style={label}>Profile photo</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
          <View>
            <RiderAvatar url={photos.avatarUrl} name={name} size={72} background={colors.muted} color={colors.foreground} />
            {busy === "avatar" && (
              <View style={{ position: "absolute", inset: 0, borderRadius: 36, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" }}>
                <ActivityIndicator color="#fff" />
              </View>
            )}
          </View>
          <View style={{ flex: 1 }}><Actions kind="avatar" has={!!photos.avatarUrl} /></View>
        </View>
      </View>

      {/* Background photo */}
      <View style={{ gap: 8 }}>
        <Text style={label}>Background photo</Text>
        <View style={{ height: 120, borderRadius: 10, overflow: "hidden", backgroundColor: "#161616", justifyContent: "flex-end" }}>
          <CoverBackdrop url={photos.coverUrl} />
          <PhotoFade from={0.4} strength={0.7} />
          <Text style={{ color: "#FFFFFF", fontFamily: fonts.medium, fontSize: 12, padding: 8 }}>
            {photos.coverUrl ? "Your background photo" : "Stock photo (shown until you add your own)"}
          </Text>
          {busy === "cover" && (
            <View style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" }}>
              <ActivityIndicator color="#fff" />
            </View>
          )}
        </View>
        <Actions kind="cover" has={!!photos.coverUrl} />
      </View>

      <Text style={{ fontSize: 12, lineHeight: 17, color: colors.mutedForeground, fontFamily: fonts.regular }}>
        Photos follow the same setting as the bio: on a private profile only you and the profile's managers see them.
      </Text>
      {error ? <Text style={{ fontSize: 13, color: colors.destructive, fontFamily: fonts.medium }}>{error}</Text> : null}
    </View>
  );
}
