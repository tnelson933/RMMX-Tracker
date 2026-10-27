import { Feather } from "@expo/vector-icons";
import React from "react";
import { View } from "react-native";
import { useColors } from "@/hooks/useColors";

type FeatherName = React.ComponentProps<typeof Feather>["name"];

/** Starter questions for Rocky, shared by the Home card and the chat screen. */
export const ROCKY_QUICK_QUESTIONS: { label: string; icon: FeatherName; question: string }[] = [
  { label: "Suspension setup", icon: "sliders", question: "How do I set up my suspension for a motocross track?" },
  { label: "Fix arm pump", icon: "activity", question: "How do I fix arm pump while riding?" },
  { label: "Corner faster", icon: "rotate-cw", question: "What's the best technique for cornering faster on a dirt bike?" },
  { label: "Jetting help", icon: "droplet", question: "How do I know if my jetting is off and how do I fix it?" },
  { label: "Nail the start", icon: "zap", question: "How do I get a better holeshot start?" },
  { label: "Pre-race checklist", icon: "check-square", question: "What should be on my pre-race bike checklist?" },
];

/** Rocky's badge: a wrench in a glowing red ring with an "online" dot. */
export function RockyAvatar({ size = 40, online = true }: { size?: number; online?: boolean }) {
  const colors = useColors();
  const dot = Math.max(8, Math.round(size * 0.24));
  return (
    <View style={{ width: size, height: size }}>
      <View style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: colors.primary, alignItems: "center", justifyContent: "center",
        borderWidth: Math.max(2, size * 0.06), borderColor: colors.primaryTint,
        shadowColor: colors.primary, shadowOpacity: 0.6, shadowRadius: size * 0.35, shadowOffset: { width: 0, height: 0 }, elevation: 8,
      }}>
        <Feather name="tool" size={size * 0.46} color="#fff" />
      </View>
      {online && (
        <View style={{
          position: "absolute", right: -1, bottom: -1, width: dot, height: dot, borderRadius: dot / 2,
          backgroundColor: colors.success, borderWidth: 2, borderColor: colors.card,
        }} />
      )}
    </View>
  );
}
