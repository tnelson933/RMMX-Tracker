import { Feather } from "@expo/vector-icons";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { PositionBadge, podiumColor } from "@/components/RaceStats";
import { useColors } from "@/hooks/useColors";
import { displayDate } from "@/lib/format";

type FeatherName = React.ComponentProps<typeof Feather>["name"];

/** Red calendar block: month over day, like a race poster. */
export function DateBlock({ iso, size = 52 }: { iso: string | null | undefined; size?: number }) {
  const colors = useColors();
  const d = iso ? displayDate(iso) : null;
  return (
    <View style={{ width: size, height: size + 4, borderRadius: 12, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontSize: size * 0.2, color: "#fff", fontFamily: "Inter_700Bold", letterSpacing: 1.2 }}>
        {d ? d.toLocaleDateString("en-US", { month: "short" }).toUpperCase() : "TBD"}
      </Text>
      <Text style={{ fontSize: size * 0.44, color: "#fff", fontFamily: "Inter_700Bold", lineHeight: size * 0.52 }}>
        {d ? d.getDate() : "–"}
      </Text>
    </View>
  );
}

/** Small icon + text chip used for date, class and place on race cards. */
export function MetaChip({ icon, label, accent }: { icon: FeatherName; label: string; accent?: boolean }) {
  const colors = useColors();
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 8,
      backgroundColor: accent ? colors.primaryTint : colors.muted, borderWidth: 1, borderColor: accent ? colors.primary + "55" : colors.border,
    }}>
      <Feather name={icon} size={10} color={accent ? colors.primary : colors.mutedForeground} />
      <Text style={{ fontSize: 11, color: colors.foreground, fontFamily: "Inter_600SemiBold" }} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function shortDate(iso: string | null | undefined): string {
  return iso ? displayDate(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
}

/**
 * A finished race: podium-coloured edge stripe, position badge, event name,
 * date/class/place chips, per-moto finishes and points.
 */
export function ResultCard({
  position, dnf, kicker, title, dateIso, raceClass, place, points, motos, onPress, footer, official,
}: {
  position: number | null | undefined;
  dnf?: boolean;
  kicker?: string | null;
  title: string;
  dateIso?: string | null;
  raceClass?: string | null;
  place?: string | null;
  points?: number | null;
  motos?: { position: number | null | undefined; dnf?: boolean; dns?: boolean }[];
  onPress?: () => void;
  footer?: React.ReactNode;
  /** Results finalized by the organizer; undefined hides the label. */
  official?: boolean;
}) {
  const colors = useColors();
  const edge = podiumColor(position) ?? (position != null ? colors.primary : colors.border);
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => ({
        marginHorizontal: 16, marginBottom: 10, borderRadius: 16, backgroundColor: colors.card,
        borderWidth: 1, borderColor: colors.border, overflow: "hidden", opacity: pressed ? 0.8 : 1,
      })}
    >
      <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, backgroundColor: edge }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, paddingLeft: 16 }}>
        <View style={{ minWidth: 56, alignItems: "center" }}>
          {position != null || dnf
            ? <PositionBadge position={position} dnf={dnf} size="md" />
            : <Text style={{ fontSize: 16, color: colors.mutedForeground, fontFamily: "Inter_700Bold" }}>—</Text>}
        </View>
        <View style={{ flex: 1, gap: 6 }}>
          <View>
            {kicker ? (
              <Text style={{ fontSize: 10, color: colors.primary, fontFamily: "Inter_700Bold", letterSpacing: 1, textTransform: "uppercase" }} numberOfLines={1}>{kicker}</Text>
            ) : null}
            <Text style={{ fontSize: 15, color: colors.foreground, fontFamily: "Inter_700Bold", fontStyle: "italic", letterSpacing: 0.3, textTransform: "uppercase" }} numberOfLines={1}>
              {title}
            </Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
            {dateIso ? <MetaChip icon="calendar" label={shortDate(dateIso)} /> : null}
            {raceClass ? <MetaChip icon="flag" label={raceClass} accent /> : null}
            {place ? <MetaChip icon="map-pin" label={place} /> : null}
          </View>
          {official != null ? (
            <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 0.6, textTransform: "uppercase", color: official ? "#15803d" : "#b45309" }}>
              {official ? "✓ Official results" : "Unofficial results"}
            </Text>
          ) : null}
          {motos && motos.length > 1 && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              {motos.map((m, i) => (
                <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                  <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_700Bold" }}>M{i + 1}</Text>
                  <PositionBadge position={m.position} dnf={m.dnf} dns={m.dns} size="sm" />
                </View>
              ))}
            </View>
          )}
        </View>
        {points != null && points > 0 ? (
          <View style={{ alignItems: "center", minWidth: 40 }}>
            <Text style={{ fontSize: 22, color: colors.foreground, fontFamily: "Inter_700Bold", fontStyle: "italic" }}>{points}</Text>
            <Text style={{ fontSize: 9, color: colors.mutedForeground, fontFamily: "Inter_700Bold", letterSpacing: 1 }}>PTS</Text>
          </View>
        ) : onPress ? (
          <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
        ) : null}
      </View>
      {footer}
    </Pressable>
  );
}

export type EventCardStatus = "live" | "open" | null;

/**
 * An upcoming or browsable race: date block, name, place/club chips, class chips
 * and a LIVE / OPEN / REGISTERED status.
 */
export function EventCard({
  title, dateIso, dateLabel, place, club, classes, status, registered, onPress,
}: {
  title: string;
  dateIso?: string | null;
  dateLabel?: string | null;
  place?: string | null;
  club?: string | null;
  classes?: string[];
  status?: EventCardStatus;
  registered?: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const live = status === "live";
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        marginHorizontal: 16, marginBottom: 10, borderRadius: 16, backgroundColor: colors.card,
        borderWidth: live || registered ? 1.5 : 1,
        borderColor: live ? "#ef4444" : registered ? colors.primary : colors.border,
        padding: 12, flexDirection: "row", gap: 12, alignItems: "center", opacity: pressed ? 0.8 : 1,
      })}
    >
      <DateBlock iso={dateIso} />
      <View style={{ flex: 1, gap: 5 }}>
        <View style={{ flexDirection: "row", gap: 5, flexWrap: "wrap" }}>
          {live && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: "#ef4444" }}>
              <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: "#fff" }} />
              <Text style={{ fontSize: 9, color: "#fff", fontFamily: "Inter_700Bold", letterSpacing: 0.8 }}>LIVE NOW</Text>
            </View>
          )}
          {status === "open" && (
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: colors.successTint }}>
              <Text style={{ fontSize: 9, color: colors.success, fontFamily: "Inter_700Bold", letterSpacing: 0.8 }}>REGISTRATION OPEN</Text>
            </View>
          )}
          {registered && (
            <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: colors.primary }}>
              <Text style={{ fontSize: 9, color: "#fff", fontFamily: "Inter_700Bold", letterSpacing: 0.8 }}>✓ REGISTERED</Text>
            </View>
          )}
        </View>
        <Text style={{ fontSize: 15, color: colors.foreground, fontFamily: "Inter_700Bold", fontStyle: "italic", letterSpacing: 0.3, textTransform: "uppercase" }} numberOfLines={2}>
          {title}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
          {dateLabel ? <MetaChip icon="calendar" label={dateLabel} /> : null}
          {place ? <MetaChip icon="map-pin" label={place} /> : null}
          {club ? <MetaChip icon="users" label={club} /> : null}
          {(classes ?? []).map(c => <MetaChip key={c} icon="flag" label={c} accent />)}
        </View>
      </View>
      <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}

/**
 * Header for one rider's result at an event: date block, event name, chips, and
 * a stat strip with the best finish as a big podium badge.
 */
export function ResultHero({
  eventName, dateIso, place, raceClass, riderName, bestPosition, motoCount, points,
}: {
  eventName: string;
  dateIso?: string | null;
  place?: string | null;
  raceClass?: string | null;
  riderName?: string | null;
  bestPosition: number | null | undefined;
  motoCount: number;
  points?: number | null;
}) {
  const colors = useColors();
  const glow = podiumColor(bestPosition) ?? colors.primary;
  return (
    <View style={{
      borderRadius: 20, backgroundColor: colors.card, borderWidth: 1.5, borderColor: glow + "88", overflow: "hidden",
      shadowColor: glow, shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 4 }, elevation: 5,
    }}>
      <View pointerEvents="none" style={{ position: "absolute", top: 16, left: -60, right: -60, transform: [{ rotate: "-12deg" }] }}>
        <View style={{ height: 3, backgroundColor: glow, opacity: 0.35, marginRight: 140 }} />
        <View style={{ height: 8, backgroundColor: glow, opacity: 0.14, marginTop: 9, marginLeft: 100 }} />
      </View>
      <View style={{ padding: 16, flexDirection: "row", gap: 14, alignItems: "center" }}>
        <DateBlock iso={dateIso} size={56} />
        <View style={{ flex: 1, gap: 6 }}>
          {riderName ? (
            <Text style={{ fontSize: 10, color: colors.primary, fontFamily: "Inter_700Bold", letterSpacing: 1, textTransform: "uppercase" }} numberOfLines={1}>{riderName}</Text>
          ) : null}
          <Text style={{ fontSize: 20, color: colors.foreground, fontFamily: "Inter_700Bold", fontStyle: "italic", letterSpacing: 0.3, textTransform: "uppercase" }} numberOfLines={2}>
            {eventName}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
            {raceClass ? <MetaChip icon="flag" label={raceClass} accent /> : null}
            {place ? <MetaChip icon="map-pin" label={place} /> : null}
          </View>
        </View>
      </View>
      <View style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.border }}>
        <View style={{ flex: 1.3, alignItems: "center", paddingVertical: 14, gap: 6 }}>
          {bestPosition != null
            ? <PositionBadge position={bestPosition} size="lg" />
            : <Text style={{ fontSize: 26, color: colors.mutedForeground, fontFamily: "Inter_700Bold" }}>—</Text>}
          <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_700Bold", letterSpacing: 1 }}>BEST FINISH</Text>
        </View>
        <View style={{ width: 1, backgroundColor: colors.border }} />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 2 }}>
          <Text style={{ fontSize: 28, color: colors.foreground, fontFamily: "Inter_700Bold", fontStyle: "italic" }}>{motoCount}</Text>
          <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_700Bold", letterSpacing: 1 }}>{motoCount === 1 ? "MOTO" : "MOTOS"}</Text>
        </View>
        <View style={{ width: 1, backgroundColor: colors.border }} />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 2 }}>
          <Text style={{ fontSize: 28, color: points ? colors.primary : colors.foreground, fontFamily: "Inter_700Bold", fontStyle: "italic" }}>{points ?? 0}</Text>
          <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_700Bold", letterSpacing: 1 }}>POINTS</Text>
        </View>
      </View>
    </View>
  );
}
