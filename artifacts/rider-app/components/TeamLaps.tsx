import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useColors } from "@/hooks/useColors";

/** Group races: the team's riders and the laps each of them rode (from the rider history API). */
export interface TeamBreakdown {
  name: string | null;
  members: Array<{ position: number; name: string; isYou: boolean; lapCount: number; lapTimes: string[]; totalTime: string | null; bestLap: string | null }>;
}

/**
 * A team race's result is the team's total (shown above it); this lists each
 * rider's own laps so teammates can compare them.
 */
export function TeamLaps({ team }: { team: TeamBreakdown }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  if (team.members.length === 0) return null;
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: colors.border, paddingHorizontal: 14, paddingVertical: 10 }}>
      <Pressable onPress={() => setOpen(o => !o)} accessibilityRole="button" accessibilityLabel={open ? "Hide each rider's laps" : "Show each rider's laps"}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: colors.primaryText, fontFamily: "Roboto_700Bold" }}>
          {open ? "Hide" : "Show"} each rider's laps{team.name ? ` · Team ${team.name}` : ""}
        </Text>
      </Pressable>
      {open && team.members.map(m => (
        <View key={m.position} style={{
          marginTop: 8, padding: 10, borderRadius: 10,
          backgroundColor: m.isYou ? colors.primary + "12" : colors.muted + "40",
        }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ flex: 1, fontSize: 13, fontWeight: "700", color: colors.foreground, fontFamily: "Roboto_700Bold" }}>
              {m.name}{m.isYou ? " (you)" : ""}
            </Text>
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_500Medium" }}>
              {m.lapCount} lap{m.lapCount === 1 ? "" : "s"}
            </Text>
          </View>
          <View style={{ flexDirection: "row", gap: 14, marginTop: 4 }}>
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>Best {m.bestLap ?? "—"}</Text>
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>Riding time {m.totalTime ?? "—"}</Text>
          </View>
          {m.lapTimes.length > 0 && (
            <Text style={{ fontSize: 12, marginTop: 4, color: colors.foreground, fontFamily: "Roboto_400Regular" }}>
              {m.lapTimes.join("   ")}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}
