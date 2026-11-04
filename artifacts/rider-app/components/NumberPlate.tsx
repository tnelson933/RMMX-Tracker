import React from "react";
import { Text, View } from "react-native";

import { fonts } from "@/constants/fonts";

import { PLATE_COLORS, PLATE_COLOR_NAMES } from "@workspace/rider-insights/plates";

/** Shared with the rider website. */
export { PLATE_COLORS, PLATE_COLOR_NAMES };

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
