/**
 * Racer profile photos: a headshot shown in place of the initials circle, and a
 * background photo shown in place of the stock riding photo. Both come from the
 * API as /api/storage/... paths; null means "use initials / the stock photo"
 * (no photo set, or a private profile the viewer doesn't manage).
 */
import React from "react";
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { StockBackdrop } from "@/components/StockBackdrop";
import { fonts } from "@/constants/fonts";
import { API_BASE_URL } from "@/lib/apiBase";

/** Full URL for a stored photo path (paths are relative to the API). */
export function photoUri(path: string | null | undefined): string | null {
  if (!path) return null;
  return /^https?:\/\//.test(path) ? path : `${API_BASE_URL}${path}`;
}

export function initialsOf(name: string): string {
  return name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}

/** Round headshot, or the rider's initials when there's no photo to show. */
export function RiderAvatar({ url, name, size, background = "#3A3A3A", color = "#FFFFFF", style }: {
  url: string | null | undefined; name: string; size: number; background?: string; color?: string; style?: StyleProp<ViewStyle>;
}) {
  const uri = photoUri(url);
  return (
    <View
      accessibilityLabel={uri ? `Photo of ${name}` : undefined}
      style={[{ width: size, height: size, borderRadius: size / 2, overflow: "hidden", alignItems: "center", justifyContent: "center", backgroundColor: background }, style]}
    >
      {uri
        ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityIgnoresInvertColors />
        : <Text style={{ color, fontFamily: fonts.displayHeavy, fontSize: size * 0.34 }}>{initialsOf(name)}</Text>}
    </View>
  );
}

/** The rider's background photo filling its parent, or the stock riding photo. */
export function CoverBackdrop({ url }: { url: string | null | undefined }) {
  const uri = photoUri(url);
  if (!uri) return <StockBackdrop />;
  return (
    <View style={[StyleSheet.absoluteFill, { overflow: "hidden" }]} pointerEvents="none">
      <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityIgnoresInvertColors />
    </View>
  );
}
