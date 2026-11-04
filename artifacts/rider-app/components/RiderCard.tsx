/**
 * A rider on the Profile tab. Checked riders get an always-open card with three
 * tiles (Racer Profile, Career Stats, Maintenance); unchecked riders get a slim
 * row. Tapping the checkbox shows or hides the rider across the app.
 */
import { Feather } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle, Polyline } from "react-native-svg";

import { NumberPlate } from "@/components/NumberPlate";
import { useRiderAuth, type RiderProfile } from "@/context/AuthContext";
import { fonts } from "@/constants/fonts";
import { useColors } from "@/hooks/useColors";
import { cardSummary, nextMaintenance, recentFinishes, type MaintenanceLike } from "@/lib/profileCard";

interface CardData {
  plateColor: string | null;
  className: string | null;
  followerCount: number;
  avgFinish: number | null;
  recent: Array<{ motos: Array<{ position: number | null }> }>;
  maintenance: MaintenanceLike[];
}

type Colors = ReturnType<typeof useColors>;

/** Finishing positions as a tiny line, P1 at the top. */
function Sparkline({ values, color, width = 84, height = 28 }: { values: number[]; color: string; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values), min = Math.min(...values);
  const span = Math.max(1, max - min);
  const pad = 3;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = pad + ((v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const last = pts[pts.length - 1];
  return (
    <Svg width={width} height={height}>
      <Polyline points={pts.map(p => p.join(",")).join(" ")} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={last[0]} cy={last[1]} r={3} fill={color} />
    </Svg>
  );
}

function Check({ on, colors }: { on: boolean; colors: Colors }) {
  return (
    <View style={{ width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: "center", justifyContent: "center", borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.primary : "transparent" }}>
      {on && <Feather name="check" size={13} color="#fff" />}
    </View>
  );
}

function Tile({ icon, title, onPress, children, colors, a11y }: {
  icon: React.ComponentProps<typeof Feather>["name"]; title: string; onPress: () => void; children: React.ReactNode; colors: Colors; a11y: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={({ pressed }) => ({
        flex: 1, minHeight: 112, borderRadius: 12, padding: 9, gap: 6,
        backgroundColor: colors.muted, borderWidth: 1, borderColor: colors.border, opacity: pressed ? 0.75 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 4 }}>
        <Feather name={icon} size={11} color={colors.primaryText} style={{ marginTop: 1 }} />
        <Text numberOfLines={2} style={{ flex: 1, fontSize: 11, lineHeight: 13, fontFamily: fonts.display, letterSpacing: 0.3, textTransform: "uppercase", color: colors.mutedForeground }}>{title}</Text>
      </View>
      <View style={{ flex: 1, justifyContent: "space-between", gap: 4 }}>{children}</View>
    </Pressable>
  );
}

export function RiderCard({ profile, selected, isOnlyOne, onToggle }: {
  profile: RiderProfile; selected: boolean; isOnlyOne: boolean; onToggle: () => void;
}) {
  const colors = useColors();
  const router = useRouter();
  const { riderFetch } = useRiderAuth();
  const [data, setData] = useState<CardData | null>(null);

  useFocusEffect(useCallback(() => {
    if (!selected) return;
    let live = true;
    void (async () => {
      try {
        const r = await riderFetch(`/api/rider/profiles/${profile.id}/card`);
        if (r.ok && live) setData(await r.json());
      } catch { /* the tiles fall back to what the profile already has */ }
    })();
    return () => { live = false; };
  }, [selected, profile.id, riderFetch]));

  const name = `${profile.firstName} ${profile.lastName}`.trim();
  const initials = `${profile.firstName?.[0] ?? ""}${profile.lastName?.[0] ?? ""}`.toUpperCase() || "?";
  const summary = cardSummary(profile);
  const checkLabel = selected
    ? (isOnlyOne ? `${name} is shown. At least one rider stays checked.` : `Hide ${name}`)
    : `Show ${name}`;

  const ident = profile.bibNumber
    ? <NumberPlate number={profile.bibNumber} color={data?.plateColor} size={selected ? 34 : 28} />
    : (
      <View style={{ width: selected ? 44 : 38, height: selected ? 44 : 38, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: selected ? colors.primary : colors.muted }}>
        <Text style={{ fontSize: 14, color: selected ? "#fff" : colors.mutedForeground, fontFamily: fonts.bold }}>{initials}</Text>
      </View>
    );

  if (!selected) {
    return (
      <Pressable
        onPress={onToggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: false }}
        accessibilityLabel={checkLabel}
        style={({ pressed }) => ({
          flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 10,
          borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, opacity: pressed ? 0.8 : 1,
        })}
      >
        {ident}
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 15, color: colors.foreground, fontFamily: fonts.bold }}>{name}</Text>
          <Text numberOfLines={1} style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.regular, marginTop: 1 }}>{summary}</Text>
        </View>
        <Check on={false} colors={colors} />
      </Pressable>
    );
  }

  const finishes = data ? recentFinishes(data.recent) : [];
  const next = data ? nextMaintenance(data.maintenance, Date.now()) : null;
  const hasBike = (profile.bikes?.length ?? 0) > 0;
  const statusColor = next?.status === "overdue" ? colors.destructive : next?.status === "due_soon" ? colors.warning : next?.status === "ok" ? colors.success : colors.mutedForeground;
  const followers = data?.followerCount ?? 0;

  return (
    <View style={{ borderRadius: 16, borderWidth: 1.5, borderColor: colors.primary, backgroundColor: colors.card, padding: 14, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        {ident}
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 18, color: colors.foreground, fontFamily: fonts.displayHeavy, textTransform: "uppercase", letterSpacing: 0.5 }}>{name}</Text>
          {data?.className ? <Text numberOfLines={1} style={{ fontSize: 12, color: colors.primaryText, fontFamily: fonts.semibold }}>{data.className}</Text> : null}
          <Text numberOfLines={1} style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.regular, marginTop: 1 }}>{summary}</Text>
        </View>
        <Pressable onPress={onToggle} hitSlop={10} accessibilityRole="checkbox" accessibilityState={{ checked: true, disabled: isOnlyOne }} accessibilityLabel={checkLabel}>
          <Check on colors={colors} />
        </Pressable>
      </View>

      <View style={{ flexDirection: "row", gap: 8 }}>
        <Tile icon="user" title="Racer Profile" colors={colors} onPress={() => router.push(`/racer/${profile.id}` as never)}
          a11y={`Racer profile, ${followers} ${followers === 1 ? "follower" : "followers"}`}>
          {profile.bibNumber
            ? <NumberPlate number={profile.bibNumber} color={data?.plateColor} size={26} />
            : <Feather name="user" size={22} color={colors.foreground} />}
          <Text numberOfLines={1} style={{ fontSize: 12, color: colors.foreground, fontFamily: fonts.semibold }}>
            {followers} {followers === 1 ? "follower" : "followers"}
          </Text>
        </Tile>

        <Tile icon="bar-chart-2" title="Career Stats" colors={colors} onPress={() => router.push(`/stats/${profile.id}` as never)}
          a11y={`Career stats${data?.avgFinish != null ? `, average finish P${data.avgFinish.toFixed(1)}` : ""}`}>
          {finishes.length >= 2
            ? <Sparkline values={finishes} color={colors.primaryText} />
            : <Feather name="trending-up" size={22} color={colors.mutedForeground} />}
          <Text numberOfLines={1} style={{ fontSize: 12, color: colors.foreground, fontFamily: fonts.semibold }}>
            {data?.avgFinish != null ? `Avg P${data.avgFinish.toFixed(1)}` : "No races yet"}
          </Text>
        </Tile>

        <Tile icon="tool" title="Maintenance" colors={colors} onPress={() => router.push(`/maintenance/${profile.id}` as never)}
          a11y={`Maintenance, ${next ? next.label : hasBike ? "set up maintenance" : "add your bike"}`}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: next ? statusColor : colors.border }} />
          <Text numberOfLines={2} style={{ fontSize: 12, color: next?.status === "overdue" ? colors.destructive : colors.foreground, fontFamily: fonts.semibold }}>
            {next ? next.label : hasBike ? "Set up reminders" : "Add your bike"}
          </Text>
        </Tile>
      </View>
    </View>
  );
}
