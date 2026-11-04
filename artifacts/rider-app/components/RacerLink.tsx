import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React from "react";
import { Pressable, Text } from "react-native";

import { fonts } from "@/constants/fonts";
import { useColors } from "@/hooks/useColors";

/** "Racer profile ›": opens a rider's profile (where people can follow them) from results. */
export function RacerLink({ riderId, onBeforeOpen }: { riderId: number; onBeforeOpen?: () => void }) {
  const colors = useColors();
  const router = useRouter();
  return (
    <Pressable
      onPress={() => { onBeforeOpen?.(); router.push(`/racer/${riderId}` as any); }}
      accessibilityRole="link"
      accessibilityLabel="Open racer profile"
      hitSlop={8}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "center", gap: 2, alignSelf: "flex-start", marginTop: 6,
        paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: colors.border,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text style={{ fontSize: 13, color: colors.foreground, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 0.8 }}>Racer profile</Text>
      <Feather name="chevron-right" size={14} color={colors.foreground} />
    </Pressable>
  );
}
