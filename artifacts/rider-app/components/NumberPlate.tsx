import React from "react";
import { Text, View } from "react-native";

import { fonts } from "@/constants/fonts";

/** Number-plate colours a rider can pick (matches the API's PLATE_COLORS). */
export const PLATE_COLORS: Record<string, { bg: string; fg: string; border: string }> = {
  white: { bg: "#FFFFFF", fg: "#161616", border: "#B30000" },
  black: { bg: "#161616", fg: "#FFFFFF", border: "#FFFFFF" },
  red: { bg: "#B30000", fg: "#FFFFFF", border: "#161616" },
  yellow: { bg: "#F5C400", fg: "#161616", border: "#161616" },
  blue: { bg: "#1F5FD6", fg: "#FFFFFF", border: "#161616" },
  green: { bg: "#2E8B3E", fg: "#FFFFFF", border: "#161616" },
  orange: { bg: "#F26B1D", fg: "#161616", border: "#161616" },
};
export const PLATE_COLOR_NAMES = Object.keys(PLATE_COLORS);

/** A race number on a plate graphic, in the rider's chosen colour (white by default). */
export function NumberPlate({ number, color, size = 30 }: { number: string; color?: string | null; size?: number }) {
  const c = PLATE_COLORS[color ?? "white"] ?? PLATE_COLORS.white;
  return (
    <View
      accessibilityLabel={`Number ${number}`}
      style={{
        minWidth: size * 1.5, height: size, paddingHorizontal: size * 0.25, borderRadius: size * 0.2,
        backgroundColor: c.bg, borderBottomWidth: Math.max(3, size * 0.13), borderBottomColor: c.border,
        alignItems: "center", justifyContent: "center",
      }}
    >
      <Text style={{ color: c.fg, fontFamily: fonts.displayItalic, fontSize: size * 0.68, lineHeight: size * 0.8 }}>{number}</Text>
    </View>
  );
}
