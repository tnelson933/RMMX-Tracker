import { Feather } from "@expo/vector-icons";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "@/context/ThemeContext";
import { useColors } from "@/hooks/useColors";

/** Gold, silver and bronze for P1–P3; null off the podium. */
export function podiumColor(position: number | null | undefined): string | null {
  if (position === 1) return "#F5B700";
  if (position === 2) return "#C9D1DB";
  if (position === 3) return "#D08A4A";
  return null;
}

/** Deeper podium shades for text on a light background, where pale silver/gold wash out. */
export function podiumTextColor(position: number | null | undefined, dark: boolean): string | null {
  if (dark) return podiumColor(position);
  if (position === 1) return "#B8860B";
  if (position === 2) return "#6B7785";
  if (position === 3) return "#9A5B22";
  return null;
}

/** Parse a "P2"-style finish label into a position (plain numbers are counts, not finishes). */
export function parsePosition(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return null;
  const m = /^P(\d+)$/.exec(String(value ?? "").trim());
  return m ? Number(m[1]) : null;
}

/**
 * Finishing position as a race badge: metallic on the podium (with a trophy on P1),
 * brand red elsewhere, muted for DNF/DNS.
 */
export function PositionBadge({
  position, dnf, dns, size = "md",
}: { position: number | null | undefined; dnf?: boolean; dns?: boolean; size?: "sm" | "md" | "lg" }) {
  const colors = useColors();
  const dims = { sm: { h: 24, px: 9, fs: 12 }, md: { h: 30, px: 11, fs: 15 }, lg: { h: 52, px: 14, fs: 26 } }[size];
  if (dnf || dns) {
    return (
      <View style={{ height: dims.h, paddingHorizontal: dims.px, borderRadius: 8, backgroundColor: colors.muted, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: dims.fs - 2, color: colors.mutedForeground, fontFamily: "Inter_700Bold", letterSpacing: 0.5 }}>{dnf ? "DNF" : "DNS"}</Text>
      </View>
    );
  }
  if (position == null) return null;
  const metal = podiumColor(position);
  return (
    <View style={{
      height: dims.h, minWidth: dims.h, paddingHorizontal: dims.px, borderRadius: 8,
      backgroundColor: metal ?? colors.primary, flexDirection: "row", gap: 4,
      alignItems: "center", justifyContent: "center",
      transform: [{ skewX: "-8deg" }],
      shadowColor: metal ?? colors.primary, shadowOpacity: metal ? 0.45 : 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3,
    }}>
      {position === 1 && size !== "sm" && <Feather name="award" size={dims.fs - 2} color="#1A1300" />}
      <Text style={{ fontSize: dims.fs, color: metal ? "#14110A" : "#fff", fontFamily: "Inter_700Bold", fontStyle: "italic", letterSpacing: 0.3 }}>
        P{position}
      </Text>
    </View>
  );
}

/**
 * Big-number stat tile with a red race stripe. A "P1"–"P3" value takes its
 * podium colour; `highlight` paints the number red.
 */
export function StatTile({
  value, label, onPress, highlight, compact,
}: { value: string | number; label: string; onPress?: () => void; highlight?: boolean; compact?: boolean }) {
  const colors = useColors();
  const dark = useTheme().resolvedScheme === "dark";
  const position = parsePosition(value);
  const metal = podiumColor(position);
  const metalText = podiumTextColor(position, dark);
  const body = (
    <>
      <View style={{ position: "absolute", top: 0, left: 14, right: 14, height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3, backgroundColor: metal ?? colors.primary }} />
      <Text
        style={{ fontSize: compact ? 22 : 30, color: metalText ?? (highlight ? colors.primary : colors.foreground), fontFamily: "Inter_700Bold", fontStyle: "italic", letterSpacing: -0.5 }}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>
      <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_700Bold", marginTop: 2, textTransform: "uppercase", letterSpacing: 1 }} numberOfLines={1}>
        {label}
      </Text>
      {onPress && <Feather name="chevron-right" size={12} color={colors.mutedForeground} style={{ position: "absolute", right: 7, top: 9 }} />}
    </>
  );
  const style = {
    flex: 1, backgroundColor: colors.card, borderRadius: 14, paddingVertical: compact ? 12 : 16, paddingHorizontal: 8,
    alignItems: "center" as const, borderWidth: 1, borderColor: metal ? metal + "66" : colors.border, overflow: "hidden" as const,
  };
  return onPress ? (
    <Pressable onPress={onPress} style={({ pressed }) => [style, { opacity: pressed ? 0.75 : 1 }]}>{body}</Pressable>
  ) : (
    <View style={style}>{body}</View>
  );
}
