import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { NumberPlate } from "@/components/NumberPlate";
import { RacerLink } from "@/components/RacerLink";
import { RiderAvatar } from "@/components/RiderPhoto";
import { fonts } from "@/constants/fonts";
import { useColors } from "@/hooks/useColors";
import { API_BASE_URL } from "@/lib/apiBase";
import { stateNameFromCode } from "@/lib/usStates";

/** GET /api/public/riders/:id/card. Every field is optional, so an older server can't break the card. */
interface RiderCardData {
  riderId?: number;
  name?: string;
  number?: string | null;
  plateColor?: string | null;
  avatarUrl?: string | null;
  state?: string | null;
  bike?: string | null;
  mainClass?: string | null;
  firstYear?: string | null;
  starts?: number;
  wins?: number;
  podiums?: number;
  avgFinish?: number | null;
  series?: Array<{ seriesId: number; seriesName: string; raceClass: string; position: number; points: number; riders: number }>;
}

const cache = new Map<number, RiderCardData>();

/**
 * "Who is this rider?" for live timing and results sheets: photo, number
 * plate, main class, home state, bike, career numbers, series standing and a
 * View profile button. Public data, no sign-in. Until it loads (or when the
 * server has no card), it shows the plain "Racer profile" link instead.
 */
export function RiderLookupCard({ riderId, name, onBeforeOpen }: { riderId: number; name: string; onBeforeOpen?: () => void }) {
  const colors = useColors();
  const router = useRouter();
  const [card, setCard] = useState<RiderCardData | null>(cache.get(riderId) ?? null);

  useEffect(() => {
    let alive = true;
    setCard(cache.get(riderId) ?? null);
    (async () => {
      try {
        const r = await fetch(`${API_BASE_URL}/api/public/riders/${riderId}/card`);
        if (!r.ok) return;
        const body = await r.json() as RiderCardData;
        if (!body || typeof body !== "object") return;
        cache.set(riderId, body);
        if (alive) setCard(body);
      } catch { /* the plain profile link stays */ }
    })();
    return () => { alive = false; };
  }, [riderId]);

  if (!card) return <RacerLink riderId={riderId} onBeforeOpen={onBeforeOpen} />;

  const sub = [card.mainClass, stateNameFromCode(card.state), card.firstYear ? `since ${card.firstYear}` : null].filter(Boolean).join("  ·  ");
  const tiles = [
    card.starts != null ? { v: card.starts, l: card.starts === 1 ? "Moto" : "Motos" } : null,
    card.wins != null ? { v: card.wins, l: card.wins === 1 ? "Win" : "Wins" } : null,
    card.podiums != null ? { v: card.podiums, l: card.podiums === 1 ? "Podium" : "Podiums" } : null,
  ].filter((t): t is { v: number; l: string } => !!t);
  const series = Array.isArray(card.series) ? card.series : [];
  const muted = { fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.regular, lineHeight: 17 } as const;

  return (
    <View style={{ marginTop: 10, gap: 10, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <RiderAvatar url={card.avatarUrl} name={card.name ?? name} size={44} background={colors.muted} color={colors.mutedForeground} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 15, color: colors.foreground, fontFamily: fonts.semibold }} numberOfLines={1}>{card.name ?? name}</Text>
          {sub ? <Text style={muted} numberOfLines={1}>{sub}</Text> : null}
        </View>
        {card.number ? <NumberPlate number={card.number} color={card.plateColor} size={26} /> : null}
      </View>

      {card.bike ? (
        <Text style={muted} numberOfLines={1}><Text style={{ color: colors.foreground, fontFamily: fonts.bold }}>Bike  </Text>{card.bike}</Text>
      ) : null}

      {tiles.length > 0 && (
        <View style={{ flexDirection: "row", gap: 8 }}>
          {tiles.map(t => (
            <View key={t.l} style={{ flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: 10, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border }}>
              <Text style={{ fontSize: 20, color: colors.foreground, fontFamily: fonts.displayItalic }}>{t.v}</Text>
              <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1 }}>{t.l}</Text>
            </View>
          ))}
        </View>
      )}

      {series.map(x => (
        <Text key={`${x.seriesId}-${x.raceClass}`} style={muted} numberOfLines={1}>
          <Text style={{ color: colors.foreground, fontFamily: fonts.bold }}>P{x.position} of {x.riders}  ·  {x.points} pts  </Text>
          {x.seriesName} ({x.raceClass})
        </Text>
      ))}

      <Pressable
        onPress={() => { onBeforeOpen?.(); router.push(`/racer/${riderId}` as any); }}
        accessibilityRole="button"
        style={({ pressed }) => ({
          flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 9, borderRadius: 999,
          backgroundColor: colors.primary, opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text style={{ fontSize: 14, color: "#FFFFFF", fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 1 }}>View profile</Text>
        <Feather name="chevron-right" size={15} color="#FFFFFF" />
      </Pressable>
    </View>
  );
}
