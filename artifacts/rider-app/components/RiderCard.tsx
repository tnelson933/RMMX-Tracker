/**
 * A rider on the Profile tab. Checked riders get an always-open card with three
 * tiles (Racer Profile, Career Stats, Maintenance) and their transponders (with
 * Edit); unchecked riders get a slim row that lists the numbers. Tapping the
 * checkbox shows or hides the rider across the app.
 *
 * Transponder numbers come from the owner/manager-only list
 * (/api/rider/profiles/:id/transponders): never on public profiles.
 */
import { Feather } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { PressableScale } from "@/components/PressableScale";
import Svg, { Circle, Polyline } from "react-native-svg";

import { NumberPlate } from "@/components/NumberPlate";
import { RiderTransponders, type RiderTransponder } from "@/components/RiderTransponders";
import { RiderAvatar } from "@/components/RiderPhoto";
import { useRiderAuth, type RiderProfile } from "@/context/AuthContext";
import { fonts } from "@/constants/fonts";
import { useColors } from "@/hooks/useColors";
import { riderBike } from "@/lib/bike";
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

function Tile({ title, onPress, children, colors, a11y }: {
  title: string; onPress: () => void; children: React.ReactNode; colors: Colors; a11y: string;
}) {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      scaleTo={0.95}
      style={{
        flex: 1, minHeight: 112, borderRadius: 12, padding: 9, gap: 6,
        backgroundColor: colors.muted, borderWidth: 1, borderColor: colors.border,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={{ flex: 1, fontSize: 10, lineHeight: 12, fontFamily: fonts.display, letterSpacing: 0, textTransform: "uppercase", color: colors.mutedForeground }}>{title}</Text>
      </View>
      <View style={{ flex: 1, justifyContent: "space-between", gap: 4 }}>{children}</View>
    </PressableScale>
  );
}

export function RiderCard({ profile, selected, isOnlyOne, onToggle }: {
  profile: RiderProfile; selected: boolean; isOnlyOne: boolean; onToggle: () => void;
}) {
  const colors = useColors();
  const router = useRouter();
  const { riderFetch } = useRiderAuth();
  const [data, setData] = useState<CardData | null>(null);
  const [transponders, setTransponders] = useState<RiderTransponder[] | null>(null);
  const [editingTransponders, setEditingTransponders] = useState(false);

  const loadTransponders = useCallback(async () => {
    try {
      const r = await riderFetch(`/api/rider/profiles/${profile.id}/transponders`);
      if (r.ok) setTransponders(await r.json());
    } catch { /* keep what's shown */ }
  }, [profile.id, riderFetch]);
  useFocusEffect(useCallback(() => { void loadTransponders(); }, [loadTransponders]));
  const transponderLine = (transponders ?? []).map(t => `${t.kind === "rfid" ? "RFID" : "RM TrackR"} ${t.number}`).join("  ·  ");

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
  const summary = cardSummary(profile);
  const checkLabel = selected
    ? (isOnlyOne ? `${name} is shown. At least one rider stays checked.` : `Hide ${name}`)
    : `Show ${name}`;

  const avatarSize = selected ? 44 : 38;
  const ident = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {(profile.avatarUrl || !profile.bibNumber) && (
        <RiderAvatar url={profile.avatarUrl} name={name} size={avatarSize}
          background={selected ? colors.primary : colors.muted} color={selected ? "#fff" : colors.mutedForeground} />
      )}
      {profile.bibNumber ? <NumberPlate number={profile.bibNumber} color={data?.plateColor} size={selected ? 34 : 28} /> : null}
    </View>
  );

  if (!selected) {
    return (
      <PressableScale
        onPress={onToggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: false }}
        accessibilityLabel={checkLabel}
        style={{
          flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 10,
          borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
        }}
      >
        {ident}
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 15, color: colors.foreground, fontFamily: fonts.bold }}>{name}</Text>
          <Text numberOfLines={1} style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.regular, marginTop: 1 }}>{summary}</Text>
          {transponderLine ? (
            <Text numberOfLines={1} style={{ fontSize: 12, color: colors.foreground, fontFamily: fonts.semibold, marginTop: 1, fontVariant: ["tabular-nums"] }}>{transponderLine}</Text>
          ) : null}
        </View>
        <Check on={false} colors={colors} />
      </PressableScale>
    );
  }

  const finishes = data ? recentFinishes(data.recent) : [];
  const next = data ? nextMaintenance(data.maintenance, Date.now()) : null;
  const hasBike = riderBike(profile) != null;
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
        <Tile title="Racer Profile" colors={colors} onPress={() => router.push(`/racer/${profile.id}` as never)}
          a11y={`Racer profile, ${followers} ${followers === 1 ? "follower" : "followers"}`}>
          {profile.bibNumber
            ? <NumberPlate number={profile.bibNumber} color={data?.plateColor} size={26} />
            : <Feather name="user" size={22} color={colors.foreground} />}
          <Text numberOfLines={1} style={{ fontSize: 12, color: colors.foreground, fontFamily: fonts.semibold }}>
            {followers} {followers === 1 ? "follower" : "followers"}
          </Text>
        </Tile>

        <Tile title="Career Stats" colors={colors} onPress={() => router.push(`/stats/${profile.id}` as never)}
          a11y={`Career stats${data?.avgFinish != null ? `, average finish P${data.avgFinish.toFixed(1)}` : ""}`}>
          {finishes.length >= 2
            ? <Sparkline values={finishes} color={colors.primaryText} />
            : <Feather name="trending-up" size={22} color={colors.mutedForeground} />}
          <Text numberOfLines={1} style={{ fontSize: 12, color: colors.foreground, fontFamily: fonts.semibold }}>
            {data?.avgFinish != null ? `Avg P${data.avgFinish.toFixed(1)}` : "No races yet"}
          </Text>
        </Tile>

        <Tile title="Maintenance" colors={colors} onPress={() => router.push(`/maintenance/${profile.id}` as never)}
          a11y={`Maintenance, ${next ? next.label : hasBike ? "set up maintenance" : "add your bike"}`}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: next ? statusColor : colors.border }} />
          <Text numberOfLines={2} style={{ fontSize: 12, color: next?.status === "overdue" ? colors.destructive : colors.foreground, fontFamily: fonts.semibold }}>
            {next ? next.label : hasBike ? "Set up reminders" : "Add your bike"}
          </Text>
        </Tile>
      </View>

      {/* Transponders: only this account sees them (owner or manager). */}
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10, gap: 6 }} testID="card-transponders">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Feather name="radio" size={13} color={colors.mutedForeground} />
          <Text style={{ flex: 1, fontSize: 11, fontFamily: fonts.display, letterSpacing: 1, textTransform: "uppercase", color: colors.mutedForeground }}>Transponders</Text>
          <Pressable
            onPress={() => { if (editingTransponders) void loadTransponders(); setEditingTransponders(v => !v); }}
            hitSlop={10} accessibilityRole="button"
            accessibilityLabel={editingTransponders ? `Done editing ${name}'s transponders` : `Edit ${name}'s transponders`}>
            <Text style={{ fontSize: 13, color: colors.primaryText, fontFamily: fonts.semibold }}>{editingTransponders ? "Done" : "Edit"}</Text>
          </Pressable>
        </View>
        {editingTransponders ? (
          <RiderTransponders riderId={profile.id} riderFetch={riderFetch} fallback={{ trackr: null, rfid: profile.rfidNumber }} />
        ) : transponders == null ? null : transponders.length === 0 ? (
          <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: fonts.regular }}>None yet. Tap Edit to add your RM TrackR or RFID sticker.</Text>
        ) : (
          transponders.map(t => (
            <View key={t.id} style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
              <Text style={{ fontSize: 16, color: colors.foreground, fontFamily: fonts.bold, fontVariant: ["tabular-nums"] }} selectable>{t.number}</Text>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.regular }}>
                {t.kindName}{t.label ? ` · ${t.label}` : ""}
              </Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
}
