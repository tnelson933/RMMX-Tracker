import { Feather } from "@expo/vector-icons";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { useColors } from "@/hooks/useColors";

type FeatherName = React.ComponentProps<typeof Feather>["name"];

export interface EmptyStateAction {
  label: string;
  onPress: () => void;
  icon?: FeatherName;
}

/**
 * Race-themed empty state: a glowing icon badge over speed stripes and a
 * checkered strip, an uppercase headline, and a clear next step.
 * `card` sits inside a list (bordered panel); `screen` fills an empty tab.
 */
export function EmptyState({
  icon, title, message, primary, secondary, variant = "screen",
}: {
  icon: FeatherName;
  title: string;
  message: string;
  primary?: EmptyStateAction;
  secondary?: EmptyStateAction;
  variant?: "screen" | "card";
}) {
  const colors = useColors();
  const card = variant === "card";

  return (
    <View
      style={card
        ? { marginHorizontal: 16, marginBottom: 24, borderRadius: 18, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, paddingVertical: 22, paddingHorizontal: 20, alignItems: "center", overflow: "hidden" }
        : { alignItems: "center", paddingHorizontal: 32, paddingTop: 36, paddingBottom: 24 }}
    >
      {/* Badge with speed stripes behind it */}
      <View style={{ width: 200, height: card ? 76 : 96, alignItems: "center", justifyContent: "center", marginBottom: 10 }}>
        <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: card ? 20 : 30, transform: [{ rotate: "-14deg" }] }}>
          <View style={{ height: 3, backgroundColor: colors.primary, opacity: 0.55, marginRight: 70 }} />
          <View style={{ height: 6, backgroundColor: colors.primary, opacity: 0.25, marginTop: 8, marginLeft: 50 }} />
          <View style={{ height: 2, backgroundColor: colors.foreground, opacity: 0.12, marginTop: 8, marginRight: 30 }} />
        </View>
        <View style={{
          width: card ? 56 : 72, height: card ? 56 : 72, borderRadius: 999,
          backgroundColor: colors.primaryTint, borderWidth: 2, borderColor: colors.primary,
          alignItems: "center", justifyContent: "center",
          shadowColor: colors.primary, shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: { width: 0, height: 0 }, elevation: 6,
        }}>
          <Feather name={icon} size={card ? 24 : 30} color={colors.foreground} />
        </View>
      </View>

      {/* Checkered strip */}
      <View style={{ marginBottom: 12, opacity: 0.35 }}>
        {[0, 1].map(row => (
          <View key={row} style={{ flexDirection: "row" }}>
            {Array.from({ length: 10 }).map((_, i) => (
              <View key={i} style={{ width: 7, height: 7, backgroundColor: (i + row) % 2 === 0 ? colors.foreground : "transparent" }} />
            ))}
          </View>
        ))}
      </View>

      <Text style={{ fontSize: card ? 16 : 19, color: colors.foreground, fontFamily: "Inter_700Bold", letterSpacing: 1, textTransform: "uppercase", textAlign: "center" }}>
        {title}
      </Text>
      <Text style={{ marginTop: 6, fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20, maxWidth: 320 }}>
        {message}
      </Text>

      {primary && (
        <Pressable
          onPress={primary.onPress}
          style={({ pressed }) => ({
            marginTop: 16, flexDirection: "row", alignItems: "center", gap: 8,
            backgroundColor: colors.primary, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 22,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Text style={{ color: "#fff", fontSize: 14, fontFamily: "Inter_700Bold", letterSpacing: 0.8, textTransform: "uppercase" }}>{primary.label}</Text>
          <Feather name={primary.icon ?? "arrow-right"} size={16} color="#fff" />
        </Pressable>
      )}
      {secondary && (
        <Pressable onPress={secondary.onPress} hitSlop={8} style={{ marginTop: 12 }}>
          <Text style={{ color: colors.foreground, fontSize: 13, fontFamily: "Inter_600SemiBold", textDecorationLine: "underline" }}>{secondary.label}</Text>
        </Pressable>
      )}
    </View>
  );
}
