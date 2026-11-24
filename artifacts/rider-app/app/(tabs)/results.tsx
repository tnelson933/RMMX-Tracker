import { useBottomSpace } from "@/hooks/useBottomSpace";
import { localDateString } from "@/lib/format";
import { API_BASE_URL } from "@/lib/apiBase";
import { Feather } from "@expo/vector-icons";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing, LinearTransition, ReduceMotion, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withSequence, withTiming,
} from "react-native-reanimated";
import { useRiderAuth } from "@/context/AuthContext";
import { haptics } from "@/lib/haptics";
import { CardListSkeleton, LeaderboardSkeleton } from "@/components/Skeleton";
import { PressableScale } from "@/components/PressableScale";

import { BrandBar } from "@/components/BrandBar";
import { fmtDateShared as fmtDate, fmtLap } from "@/components/RaceSubScreens";
import { useColors } from "@/hooks/useColors";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { onTabReset } from "@/utils/tabEvents";
import { EmptyState } from "@/components/EmptyState";
import { RiderLookupCard } from "@/components/RiderLookupCard";
import { placeLabel } from "@/lib/format";
import { EventCard as RaceEventCard } from "@/components/RaceCards";
import { defaultSide, nextScheduled, splitLivePast } from "@/lib/liveRaces";
import { router, useLocalSearchParams } from "expo-router";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BrowseEvent {
  eventId: number;
  name: string;
  state: string;
  date: string;
  endDate: string | null;
  location: string;
  trackName: string;
  status: string;
  clubName: string;
}

interface PublicLineupEntry {
  gate: number;
  riderName: string;
  bibNumber: string | null;
}

interface PublicMoto {
  motoId: number;
  motoNumber: number;
  name: string;
  raceClass: string | null;
  status: string;
  type: string;
  scheduledTime: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lineup: PublicLineupEntry[];
}

interface PublicEventDetail {
  eventId: number;
  name: string;
  state: string;
  date: string;
  endDate: string | null;
  location: string;
  trackName: string;
  status: string;
  raceStyle: string;
  motos: PublicMoto[];
}

interface PublicLeaderEntry {
  position: number | null;
  riderId: number | null;
  riderName: string;
  bibNumber: string | null;
  laps: number;
  lastLap: string | null;
  totalTime: string | null;
  gap: string;
  dnf: boolean | null;
  dns: boolean | null;
  /** Present when the course map has split readers. */
  sectors?: { bestMs: Array<number | null> | null; lastLapMs: Array<number | null> | null } | null;
}

interface AnalyticsRider {
  riderId: number;
  riderName: string;
  bibNumber: string | null;
  bestLapMs: number | null;
  bestLap: string | null;
}

interface PositionMover {
  riderId: number;
  riderName: string;
  bibNumber: string | null;
  positionsGained?: number;
  positionsLost?: number;
  startPosition?: number;
  currentPosition?: number;
  fromPosition?: number;
  toPosition?: number;
  lapNumber?: number;
}

interface RaceAnalytics {
  lastCompletedLap: number | null;
  movingUp: PositionMover | null;
  mostPasses: PositionMover | null;
  fallingBack: PositionMover | null;
  fastestLap: (AnalyticsRider & {
    marginMs: number | null;
    margin: string | null;
    nextRiderName: string | null;
  }) | null;
  fastestLaps: AnalyticsRider[];
}

const MOTO_STATUS_ORDER: Record<string, number> = { scheduled: 0, in_progress: 1, completed: 2 };

interface PublicMotoDetail {
  motoId: number;
  motoName: string;
  raceClass: string | null;
  status: string;
  leaderboard: PublicLeaderEntry[];
  lineup: PublicLineupEntry[];
  analytics?: RaceAnalytics;
  sectorNames?: string[] | null;
}

// ─── Series Types ─────────────────────────────────────────────────────────────

interface PublicSeries {
  id: number;
  name: string;
  /** The season year: a number from the server. */
  season: number | string | null;
  clubName: string | null;
  state: string | null;
  classes: string[] | null;
}

interface LapRow {
  lapNumber: number;
  lapTimeMs: number;
}

interface SeriesStandingRow {
  position: number;
  riderId: number;
  riderName: string;
  raceClass: string;
  totalScore: number;
  eventsEntered: number;
  amaNumber: string | null;
  bikeBrand: string | null;
  events: Array<{ eventId: number; eventName: string; eventScore: number; attended: boolean; motos: number[]; finishPositions: (number | null)[] }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

function chipFor(status: string): { label: string; color: string } {
  const map: Record<string, { label: string; color: string }> = {
    in_progress: { label: "LIVE",     color: "#B30000" }, // drawn as a solid brand-red pill
    completed:   { label: "DONE",     color: "#22c55e" },
    scheduled:   { label: "UPCOMING", color: "#6b7280" },
  };
  return map[status] ?? { label: status.toUpperCase(), color: "#6b7280" };
}

function fmtEventRange(date: string, endDate?: string | null): string {
  if (!date) return "";
  const start = new Date(date.substring(0, 10) + "T12:00:00");
  if (!endDate || endDate.substring(0, 10) === date.substring(0, 10)) {
    return start.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  const end = new Date(endDate.substring(0, 10) + "T12:00:00");
  const startStr = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return `${startStr}–${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${startStr} – ${end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

const BASE_URL = API_BASE_URL;

async function publicFetch(path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`);
}

// ─── Public Moto Detail Sheet ─────────────────────────────────────────────────

function PublicRiderLapSheet({
  motoId,
  riderId,
  riderName,
  leaderRiderId,
  onClose,
  colors,
  bottomInset,
  raceStyle,
}: {
  motoId: number;
  riderId: number;
  riderName: string;
  leaderRiderId: number | null;
  onClose: () => void;
  colors: ReturnType<typeof useColors>;
  bottomInset: number;
  raceStyle?: string | null;
}) {
  const [laps, setLaps] = useState<LapRow[]>([]);
  const [leaderLapMap, setLeaderLapMap] = useState<Map<number, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const isLeader = leaderRiderId === riderId;

  useEffect(() => {
    async function load() {
      try {
        const fetches: Promise<Response>[] = [
          publicFetch(`/api/public/motos/${motoId}/laps/${riderId}`),
        ];
        if (leaderRiderId != null && leaderRiderId !== riderId) {
          fetches.push(publicFetch(`/api/public/motos/${motoId}/laps/${leaderRiderId}`));
        }
        const [riderRes, leaderRes] = await Promise.all(fetches);
        if (riderRes.ok) setLaps(await riderRes.json());
        if (leaderRes?.ok) {
          const leaderLaps: LapRow[] = await leaderRes.json();
          setLeaderLapMap(new Map(leaderLaps.map(l => [l.lapNumber, l.lapTimeMs])));
        }
      } catch { /* ignore */ }
      finally { setLoading(false); }
    }
    void load();
  }, [motoId, riderId, leaderRiderId]);

  const eligibleTimes = laps
    .filter(lap => (raceStyle !== "motocross" || lap.lapNumber > 1) && lap.lapTimeMs > 0)
    .map(lap => lap.lapTimeMs);
  const bestMs = eligibleTimes.length > 0 ? Math.min(...eligibleTimes) : null;
  const hasLeaderData = isLeader || leaderLapMap.size > 0;

  return (
    <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.58)" }}>
      <Pressable style={{ flex: 1 }} onPress={onClose} />
      <View style={{
        backgroundColor: colors.card,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
        maxHeight: "82%",
        paddingBottom: bottomInset + 8,
      }}>
        <View style={{ alignItems: "center", paddingTop: 12, paddingBottom: 6 }}>
          <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: colors.border }} />
        </View>
        <View style={{
          paddingHorizontal: 20, paddingBottom: 14,
          borderBottomWidth: 1, borderBottomColor: colors.border,
          flexDirection: "row", alignItems: "flex-start", gap: 10,
        }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontVariant: ["tabular-nums"], fontSize: 17, fontWeight: "800", color: colors.foreground, fontFamily: "Roboto_700Bold" }}>
              {riderName}
            </Text>
            <Text style={{ fontVariant: ["tabular-nums"], fontSize: 13, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 2 }}>
              Lap Times
            </Text>
            {/* Full sheet width: reaches under the close button's column. */}
            <View style={{ marginRight: -38 }}>
              <RiderLookupCard riderId={riderId} name={riderName} onBeforeOpen={onClose} />
            </View>
          </View>
          <Pressable onPress={onClose} hitSlop={8} style={{ padding: 4 }} accessibilityRole="button" accessibilityLabel="Close">
            <Feather name="x" size={20} color={colors.mutedForeground} />
          </Pressable>
        </View>

        <ScrollView showsVerticalScrollIndicator={false}>
          {loading ? (
            <View style={{ paddingVertical: 44, alignItems: "center" }}>
              <ActivityIndicator color={colors.primaryText} />
            </View>
          ) : laps.length === 0 ? (
            <View style={{ paddingVertical: 44, alignItems: "center", gap: 8 }}>
              <Feather name="clock" size={28} color={colors.mutedForeground} />
              <Text style={{ fontVariant: ["tabular-nums"], fontSize: 14, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>No lap data recorded</Text>
            </View>
          ) : (
            <>
              <View style={{ flexDirection: "row", paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6 }}>
                <Text style={{ fontVariant: ["tabular-nums"], width: 44, fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase" }}>Lap</Text>
                <Text style={{ fontVariant: ["tabular-nums"], flex: 1, fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase" }}>Time</Text>
                <Text style={{ fontVariant: ["tabular-nums"], width: 80, fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase", textAlign: "right" }}>
                  {hasLeaderData ? "+Gap to Leader" : "+Gap to Best"}
                </Text>
              </View>
              {laps.map((lap, i) => {
                const isBest = (raceStyle !== "motocross" || lap.lapNumber > 1) &&
                  bestMs !== null && lap.lapTimeMs === bestMs;
                let gapDisplay: string;
                if (isLeader) {
                  gapDisplay = "P1";
                } else if (hasLeaderData) {
                  const leaderMs = leaderLapMap.get(lap.lapNumber);
                  if (leaderMs == null || leaderMs <= 0) {
                    gapDisplay = "—";
                  } else {
                    const diff = lap.lapTimeMs - leaderMs;
                    gapDisplay = diff <= 0 ? "P1" : `+${fmtLap(diff)}`;
                  }
                } else {
                  const diff = bestMs !== null ? lap.lapTimeMs - bestMs : 0;
                  gapDisplay = diff === 0 ? "—" : `+${fmtLap(diff)}`;
                }
                const isP1 = gapDisplay === "P1";
                return (
                  <View
                    key={i}
                    style={{
                      flexDirection: "row", alignItems: "center",
                      paddingHorizontal: 20, paddingVertical: 11,
                      borderBottomWidth: 1, borderBottomColor: colors.border + "55",
                      backgroundColor: isBest ? "#f59e0b0a" : "transparent",
                    }}
                  >
                    <Text style={{ fontVariant: ["tabular-nums"], width: 44, fontSize: 14, fontWeight: "700", color: isBest ? "#f59e0b" : colors.mutedForeground, fontFamily: "Roboto_700Bold" }}>
                      {lap.lapNumber}
                    </Text>
                    <Text style={{ fontVariant: ["tabular-nums"], flex: 1, fontSize: 15, fontWeight: isBest ? "800" : "500", color: isBest ? "#f59e0b" : colors.foreground, fontFamily: isBest ? "Roboto_700Bold" : "Roboto_500Medium" }}>
                      {fmtLap(lap.lapTimeMs)}
                      {isBest ? "  ★ Best" : ""}
                    </Text>
                    <Text style={{ fontVariant: ["tabular-nums"], width: 80, fontSize: 12, color: isP1 ? colors.primaryText : colors.mutedForeground, fontFamily: isP1 ? "Roboto_700Bold" : "Roboto_400Regular", textAlign: "right" }}>
                      {gapDisplay}
                    </Text>
                  </View>
                );
              })}
              <View style={{ height: 24 }} />
            </>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

type LiveMotoView = "timing" | "analytics" | "fastest";

function fmtSector(ms: number | null | undefined): string {
  if (ms == null) return "—";
  // Round to hundredths first so 119.996 s shows 2:00.00, never 1:60.00.
  const cs = Math.round(ms / 10);
  const minutes = Math.floor(cs / 6000);
  const seconds = ((cs % 6000) / 100).toFixed(2);
  return minutes > 0 ? `${minutes}:${seconds.padStart(5, "0")}` : seconds;
}

// Best sector times per rider, for motos run with split readers on the course map.
function SectorsCard({ detail, colors }: { detail: PublicMotoDetail; colors: ReturnType<typeof useColors> }) {
  const names = detail.sectorNames ?? [];
  const rows = detail.leaderboard.filter(e => e.sectors?.bestMs);
  if (!names.length || !rows.length) return null;
  const fastest = names.map((_, i) => {
    const values = rows.map(e => e.sectors?.bestMs?.[i]).filter((v): v is number => v != null);
    return values.length ? Math.min(...values) : null;
  });
  return (
    <View style={{ marginHorizontal: 16, marginTop: 18, borderWidth: 1, borderColor: colors.border, borderRadius: 14, overflow: "hidden" }}>
      <View style={{ paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 2 }}>
        <Text style={{ fontVariant: ["tabular-nums"], fontSize: 13, fontWeight: "700", color: colors.primaryText, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>Best segments</Text>
        {names.map((name, i) => (
          <Text key={i} style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>Seg {i + 1} · {name}</Text>
        ))}
      </View>
      {rows.map((e, r) => (
        <View key={e.riderId ?? r} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 8, borderTopWidth: r ? 1 : 0, borderTopColor: colors.border + "55", gap: 8 }}>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: colors.foreground, fontFamily: "Roboto_500Medium" }}>{e.riderName}</Text>
          {names.map((_, i) => {
            const v = e.sectors?.bestMs?.[i] ?? null;
            const best = v != null && v === fastest[i];
            return (
              <Text key={i} style={{ width: 54, textAlign: "right", fontSize: 12, color: best ? "#22c55e" : colors.foreground, fontFamily: best ? "Roboto_700Bold" : "Roboto_400Regular", fontVariant: ["tabular-nums"] }}>
                {fmtSector(v)}
              </Text>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function LiveMotoTabs({
  activeView,
  onChange,
  colors,
}: {
  activeView: LiveMotoView;
  onChange: (view: LiveMotoView) => void;
  colors: ReturnType<typeof useColors>;
}) {
  const tabs: Array<{ key: LiveMotoView; label: string; icon: React.ComponentProps<typeof Feather>["name"] }> = [
    { key: "timing", label: "Live Timing", icon: "radio" },
    { key: "analytics", label: "Quick Analytics", icon: "bar-chart-2" },
    { key: "fastest", label: "Fastest Lap", icon: "clock" },
  ];

  return (
    <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.muted + "55" }}>
      {tabs.map(tab => {
        const active = activeView === tab.key;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={({ pressed }) => ({
              flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center",
              gap: 4, borderBottomWidth: 2,
              borderBottomColor: active ? colors.primary : "transparent",
              backgroundColor: active ? colors.primary + "12" : "transparent",
              opacity: pressed ? 0.65 : 1,
            })}
          >
            <Feather name={tab.icon} size={15} color={active ? colors.primaryText : colors.mutedForeground} />
            <Text style={{
              fontSize: 10, fontWeight: "700", color: active ? colors.primaryText : colors.mutedForeground,
              fontFamily: "Roboto_700Bold", textTransform: "uppercase", letterSpacing: 0.2,
            }}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function LiveAnalyticsView({
  analytics,
  colors,
}: {
  analytics?: RaceAnalytics;
  colors: ReturnType<typeof useColors>;
}) {
  const cards: Array<{
    label: string;
    icon: React.ComponentProps<typeof Feather>["name"];
    color: string;
    rider: PositionMover | null | undefined;
    detail: (rider: PositionMover) => string;
  }> = [
    {
      label: "Moving Up",
      icon: "trending-up",
      color: colors.secondary,
      rider: analytics?.movingUp,
      detail: rider => `+${rider.positionsGained ?? 0} positions`,
    },
    {
      label: "Most Passes",
      icon: "bar-chart-2",
      color: colors.primaryText,
      rider: analytics?.mostPasses,
      detail: rider => `${rider.positionsGained ?? 0} positions gained`,
    },
    {
      label: "Falling Back",
      icon: "trending-down",
      color: colors.destructive,
      rider: analytics?.fallingBack,
      detail: rider => `-${rider.positionsLost ?? 0} positions`,
    },
    {
      label: "Fastest Lap",
      icon: "zap",
      color: colors.primaryText,
      rider: analytics?.fastestLap,
      detail: rider => analytics?.fastestLap?.bestLap ?? "No lap yet",
    },
  ];

  return (
    <View style={{ padding: 16, gap: 10 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {cards.map(card => (
          <View key={card.label} style={{
            width: "47%", minHeight: 112, borderRadius: 12, borderWidth: 1,
            borderColor: colors.border, backgroundColor: colors.card, padding: 12,
          }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 10 }}>
              <Feather name={card.icon} size={14} color={card.color} />
              <Text style={{ fontVariant: ["tabular-nums"], fontSize: 12, fontWeight: "700", color: card.color, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.4 }}>
                {card.label}
              </Text>
            </View>
            {card.rider ? (
              <>
                <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: "700", color: colors.foreground, fontFamily: "Roboto_700Bold" }}>
                  {card.rider.riderName}
                </Text>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 4, marginTop: 6 }}>
                  <Text style={{ fontVariant: ["tabular-nums"], fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>#{card.rider.bibNumber ?? "—"}</Text>
                  <Text style={{ fontVariant: ["tabular-nums"], fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_500Medium" }}>{card.detail(card.rider)}</Text>
                </View>
              </>
            ) : (
              <Text style={{ fontVariant: ["tabular-nums"], fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", lineHeight: 17 }}>
                Waiting for a complete lap
              </Text>
            )}
          </View>
        ))}
      </View>
      <Text style={{ fontVariant: ["tabular-nums"], fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>
        {analytics?.lastCompletedLap
          ? `Based on completed lap ${analytics.lastCompletedLap}`
          : "Analytics will appear after the first complete lap"}
      </Text>
    </View>
  );
}

function LiveFastestLapsView({
  analytics,
  colors,
}: {
  analytics?: RaceAnalytics;
  colors: ReturnType<typeof useColors>;
}) {
  const fastestLaps = analytics?.fastestLaps ?? [];
  return fastestLaps.length > 0 ? (
    <View>
      <View style={{ flexDirection: "row", paddingHorizontal: 20, paddingVertical: 9, backgroundColor: colors.muted + "55", borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text style={{ fontVariant: ["tabular-nums"], width: 34, fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase" }}>Pos</Text>
        <Text style={{ fontVariant: ["tabular-nums"], flex: 1, fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase" }}>Rider</Text>
        <Text style={{ fontVariant: ["tabular-nums"], width: 80, fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase", textAlign: "right" }}>Best Lap</Text>
      </View>
      {fastestLaps.map((entry, index) => (
        <View key={entry.riderId} style={{
          flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 13,
          borderBottomWidth: 1, borderBottomColor: colors.border + "55",
          backgroundColor: index === 0 ? colors.primary + "0e" : "transparent",
        }}>
          <Text style={{ fontVariant: ["tabular-nums"], width: 34, fontSize: 15, fontWeight: "800", color: index === 0 ? colors.primaryText : colors.mutedForeground, fontFamily: "Roboto_700Bold" }}>
            {index + 1}
          </Text>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: "600", color: colors.foreground, fontFamily: "Roboto_600SemiBold" }}>{entry.riderName}</Text>
            <Text style={{ fontVariant: ["tabular-nums"], fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 2 }}>#{entry.bibNumber ?? "—"}</Text>
          </View>
          <Text style={{ fontVariant: ["tabular-nums"], width: 80, fontSize: 14, fontWeight: "700", color: index === 0 ? colors.primaryText : colors.foreground, fontFamily: "Roboto_700Bold", textAlign: "right" }}>
            {entry.bestLap ?? "—"}
          </Text>
        </View>
      ))}
    </View>
  ) : (
    <View style={{ paddingVertical: 48, paddingHorizontal: 24, alignItems: "center" }}>
      <Feather name="clock" size={28} color={colors.mutedForeground} />
      <Text style={{ fontVariant: ["tabular-nums"], marginTop: 10, fontSize: 14, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", textAlign: "center" }}>
        Fastest laps will appear as timing data arrives.
      </Text>
    </View>
  );
}

// ─── Leaderboard row ──────────────────────────────────────────────────────────

const POS_FLASH_IN = { duration: 120 };
const POS_FLASH_OUT = { duration: 220 };
/** Rows slide to their new place between refreshes; instant with reduce motion. */
const ROW_REORDER = LinearTransition.duration(280).easing(Easing.bezier(0.77, 0, 0.175, 1)).reduceMotion(ReduceMotion.System);

/**
 * One leaderboard row. When the rider's position changes between refreshes the
 * row slides to its new place (layout transition on the UI thread) and the
 * position flashes green (gained) or red (lost) for ~600 ms. The flash is a
 * colour change, so it stays on with reduce motion; the slide does not.
 */
const LeaderRow = React.memo(function LeaderRow({
  entry, index, isLive, colors, onOpen, isOwnRider,
}: {
  entry: PublicLeaderEntry;
  index: number;
  isLive: boolean;
  colors: ReturnType<typeof useColors>;
  onOpen?: (entry: PublicLeaderEntry) => void;
  isOwnRider: boolean;
}) {
  const isDNF = !!entry.dnf;
  const isDNS = !!entry.dns;
  const pos   = isDNS ? "DNS" : isDNF ? "DNF" : entry.position != null ? `P${entry.position}` : `${index + 1}`;
  const isP1  = entry.position === 1 && !isDNF && !isDNS;
  const posColor = isP1 ? "#f59e0b" : colors.mutedForeground;
  const canTapLaps = !!entry.riderId && !isDNS && !!onOpen;

  // Flash: 0 = none, 1 = full. `gained` picks the colour.
  const flash = useSharedValue(0);
  const gained = useSharedValue(1);
  const prevPos = useRef(entry.position);
  useEffect(() => {
    const before = prevPos.current;
    prevPos.current = entry.position;
    if (!isLive || before == null || entry.position == null || before === entry.position) return;
    const up = entry.position < before;
    gained.set(up ? 1 : 0);
    flash.set(withSequence(withTiming(1, POS_FLASH_IN), withDelay(260, withTiming(0, POS_FLASH_OUT))));
    if (isOwnRider) haptics.light();
  }, [entry.position, isLive, isOwnRider]);
  const flashStyle = useAnimatedStyle(() => ({
    backgroundColor: gained.get() === 1
      ? `rgba(34,197,94,${0.32 * flash.get()})`
      : `rgba(239,68,68,${0.32 * flash.get()})`,
  }));

  return (
    <Animated.View layout={ROW_REORDER}>
      <Pressable
        onPress={canTapLaps ? () => onOpen!(entry) : undefined}
        accessibilityRole={canTapLaps ? "button" : undefined}
        accessibilityLabel={`${pos}, ${entry.riderName}${entry.gap && entry.gap !== "Leader" ? `, ${entry.gap}` : ""}`}
        style={({ pressed }) => ({
          flexDirection: "row", alignItems: "center", gap: 14,
          paddingHorizontal: 20, paddingVertical: 11,
          borderBottomWidth: 1, borderBottomColor: colors.border + "55",
          backgroundColor: pressed && canTapLaps ? colors.muted : "transparent",
        })}
      >
        <Animated.View style={[{ width: 44, alignItems: "center", borderRadius: 8, paddingVertical: 2 }, flashStyle]}>
          <Text style={{ fontVariant: ["tabular-nums"], fontSize: 16, fontWeight: "800", color: posColor, fontFamily: "Roboto_700Bold" }}>{pos}</Text>
          {isLive && !isDNS && !isDNF && entry.laps > 0 && (
            <Text style={{ fontVariant: ["tabular-nums"], fontSize: 10, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>
              {entry.laps}L
            </Text>
          )}
        </Animated.View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontVariant: ["tabular-nums"], fontSize: 14, fontWeight: "500", color: canTapLaps ? colors.primaryText : colors.foreground, fontFamily: "Roboto_500Medium" }}>
            {entry.riderName}
          </Text>
          {entry.bibNumber && (
            <Text style={{ fontVariant: ["tabular-nums"], fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 1 }}>
              #{entry.bibNumber}
            </Text>
          )}
        </View>
        <View style={{ alignItems: "flex-end", gap: 2 }}>
          {entry.totalTime && !isDNS && (
            <Text style={{ fontVariant: ["tabular-nums"], fontSize: 13, fontWeight: "600", color: colors.foreground, fontFamily: "Roboto_600SemiBold" }}>
              {entry.totalTime}
            </Text>
          )}
          {entry.gap === "Leader" && !isDNS && !isDNF && (
            <Text style={{ fontVariant: ["tabular-nums"], fontSize: 11, color: "#f59e0b", fontFamily: "Roboto_600SemiBold" }}>Leader</Text>
          )}
          {entry.gap && entry.gap !== "Leader" && !isDNS && !isDNF && (
            <Text style={{ fontVariant: ["tabular-nums"], fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>{entry.gap}</Text>
          )}
          {canTapLaps && (
            <Feather name="chevron-right" size={11} color={colors.mutedForeground + "80"} />
          )}
        </View>
      </Pressable>
    </Animated.View>
  );
});

/** Stable key for a leaderboard row across refreshes (rows move; index keys would not). */
function leaderKey(entry: PublicLeaderEntry, i: number): string {
  if (entry.riderId != null) return `r${entry.riderId}`;
  if (entry.bibNumber) return `b${entry.bibNumber}`;
  return `n${entry.riderName}-${i}`;
}

function PublicMotoSheet({
  moto,
  onClose,
  colors,
  bottomInset,
  raceStyle,
}: {
  moto: PublicMoto;
  onClose: () => void;
  colors: ReturnType<typeof useColors>;
  bottomInset: number;
  raceStyle?: string | null;
}) {
  const [detail, setDetail] = useState<PublicMotoDetail | null>(null);
  const [fetching, setFetching] = useState(true);
  const [selectedLeader, setSelectedLeader] = useState<PublicLeaderEntry | null>(null);
  const [liveView, setLiveView] = useState<LiveMotoView>("timing");
  const { top: topInset } = useSafeAreaInsets();
  const { profiles } = useRiderAuth();
  const ownRiderIds = React.useMemo(() => new Set(profiles.map(p => p.id)), [profiles]);
  const openLeader = useCallback((entry: PublicLeaderEntry) => setSelectedLeader(entry), []);
  const changeLiveView = useCallback((v: LiveMotoView) => { haptics.light(); setLiveView(v); }, []);
  // Whichever is further along: the schedule's status (refreshed by the screen
  // behind this sheet) or the one in this sheet's own latest results.
  const status = (MOTO_STATUS_ORDER[detail?.status ?? ""] ?? -1) > (MOTO_STATUS_ORDER[moto.status] ?? -1) ? detail!.status : moto.status;
  const isLive      = status === "in_progress";
  const isScheduled = status === "scheduled";
  const chip        = chipFor(status);

  const fetchDetail = useCallback(async () => {
    try {
      const res = await publicFetch(`/api/public/motos/${moto.motoId}/detail`);
      if (res.ok) setDetail(await res.json());
    } catch { /* silently ignore */ }
    finally { setFetching(false); }
  }, [moto.motoId]);

  // Reload when the moto goes live; then every 5 s while live and on screen.
  useEffect(() => { void fetchDetail(); }, [fetchDetail, isLive]);
  useVisibleInterval(fetchDetail, 5000, isLive);

  // Finished but not yet official: check now and then, so the sheet turns
  // official (with a success haptic) while the rider is looking at it.
  const official = (detail as { resultsOfficial?: boolean } | null)?.resultsOfficial;
  useVisibleInterval(fetchDetail, 20_000, status === "completed" && official === false);
  const prevOfficial = useRef(official);
  useEffect(() => {
    if (prevOfficial.current === false && official === true) haptics.success();
    prevOfficial.current = official;
  }, [official]);

  const lineupRows: PublicLineupEntry[] = detail?.lineup?.length
    ? detail.lineup
    : moto.lineup;

  const leaderRiderId = detail?.leaderboard.find(e => e.position === 1)?.riderId ?? null;

  if (selectedLeader && selectedLeader.riderId) {
    return (
      <PublicRiderLapSheet
        motoId={moto.motoId}
        riderId={selectedLeader.riderId}
        riderName={selectedLeader.riderName}
        leaderRiderId={leaderRiderId}
        onClose={() => setSelectedLeader(null)}
        colors={colors}
        bottomInset={bottomInset}
        raceStyle={raceStyle}
      />
    );
  }

  return (
    <View style={{
      flex: 1,
      justifyContent: isLive ? "flex-start" : "flex-end",
      backgroundColor: isLive ? colors.background : "rgba(0,0,0,0.58)",
    }}>
      {!isLive && <Pressable style={{ flex: 1 }} onPress={onClose} />}
      <View style={{
        backgroundColor: colors.card,
        ...(isLive
          ? { flex: 1, width: "100%", paddingTop: topInset }
          : { borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: "82%", paddingBottom: bottomInset + 8 }),
      }}>
        {/* Drag handle */}
        {!isLive && (
          <View style={{ alignItems: "center", paddingTop: 12, paddingBottom: 6 }}>
            <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: colors.border }} />
          </View>
        )}

        {/* Header */}
        <View style={{
          paddingHorizontal: 20, paddingBottom: 14,
          borderBottomWidth: 1, borderBottomColor: colors.border,
          flexDirection: "row", alignItems: "flex-start", gap: 10,
        }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontVariant: ["tabular-nums"], fontSize: 17, fontWeight: "800", color: colors.foreground, fontFamily: "Roboto_700Bold" }}>
              {moto.name}
            </Text>
            {moto.raceClass && (
              <Text style={{ fontVariant: ["tabular-nums"], fontSize: 13, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 2 }}>
                {moto.raceClass}
              </Text>
            )}
            {status === "completed" && detail && (
              <Text style={{ fontVariant: ["tabular-nums"], fontSize: 12, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.6, marginTop: 4, color: (detail as any).resultsOfficial ? colors.success : colors.warning }}>
                {(detail as any).resultsOfficial ? "✓ Official results" : "Unofficial results"}
              </Text>
            )}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 2 }}>
            <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: isLive ? colors.primary : chip.color + "22" }}>
              <Text style={{ fontVariant: ["tabular-nums"], fontSize: 11, fontWeight: "700", color: isLive ? colors.primaryForeground : chip.color, fontFamily: "Roboto_700Bold" }}>
                {chip.label}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} style={{ padding: 4 }} accessibilityRole="button" accessibilityLabel="Close">
              <Feather name="x" size={20} color={colors.mutedForeground} />
            </Pressable>
          </View>
        </View>

        {isLive && (
          <LiveMotoTabs activeView={liveView} onChange={changeLiveView} colors={colors} />
        )}

        <ScrollView
          style={isLive ? { flex: 1 } : undefined}
          contentContainerStyle={isLive ? { paddingBottom: bottomInset + 28 } : undefined}
          showsVerticalScrollIndicator={false}
        >
          {fetching && <LeaderboardSkeleton rows={8} />}

          {/* SCHEDULED → Rider Lineup */}
          {!fetching && isScheduled && (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 10 }}>
                <Feather name="users" size={12} color={colors.primaryText} />
                <Text style={{ fontVariant: ["tabular-nums"], fontSize: 13, fontWeight: "700", color: colors.primaryText, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>
                  Race Lineup
                </Text>
                {lineupRows.length > 0 && (
                  <Text style={{ fontVariant: ["tabular-nums"], marginLeft: "auto", fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>
                    {lineupRows.length} riders
                  </Text>
                )}
              </View>
              {lineupRows.length === 0 ? (
                <View style={{ paddingVertical: 36, alignItems: "center", gap: 8 }}>
                  <Feather name="clock" size={28} color={colors.mutedForeground} />
                  <Text style={{ fontVariant: ["tabular-nums"], fontSize: 14, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>Gate draw not posted yet</Text>
                </View>
              ) : (
                lineupRows.map((entry, i) => (
                  <View
                    key={i}
                    style={{
                      flexDirection: "row", alignItems: "center", gap: 14,
                      paddingHorizontal: 20, paddingVertical: 11,
                      borderBottomWidth: 1, borderBottomColor: colors.border + "55",
                    }}
                  >
                    <View style={{
                      width: 44, height: 44, borderRadius: 10,
                      backgroundColor: colors.muted,
                      alignItems: "center", justifyContent: "center",
                    }}>
                      <Text style={{ fontVariant: ["tabular-nums"], fontSize: 11, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase" }}>Gate</Text>
                      <Text style={{ fontVariant: ["tabular-nums"], fontSize: 15, fontWeight: "800", color: colors.foreground, fontFamily: "Roboto_700Bold", lineHeight: 17 }}>
                        #{entry.gate}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontVariant: ["tabular-nums"], fontSize: 14, fontWeight: "500", color: colors.foreground, fontFamily: "Roboto_500Medium" }}>
                        {entry.riderName}
                      </Text>
                      {entry.bibNumber && (
                        <Text style={{ fontVariant: ["tabular-nums"], fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 1 }}>
                          #{entry.bibNumber}
                        </Text>
                      )}
                    </View>
                  </View>
                ))
              )}
            </>
          )}

          {/* IN_PROGRESS → Live Leaderboard  |  COMPLETED → Final Results */}
          {!fetching && !isScheduled && (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 10 }}>
                {isLive
                  ? <Feather name="radio" size={12} color={colors.primaryText} />
                  : <Feather name="award" size={12} color={colors.primaryText} />}
                <Text style={{ fontVariant: ["tabular-nums"], fontSize: 13, fontWeight: "700", color: isLive ? colors.primaryText : colors.primaryText, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>
                  {/* Official or unofficial is stated under the title; this just names the list. */}
                  {isLive ? "Live Leaderboard" : "Finishing order"}
                </Text>
                {isLive && (
                  <Text style={{ fontVariant: ["tabular-nums"], marginLeft: "auto", fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>
                    Updates every 5s
                  </Text>
                )}
              </View>

              {(!detail || detail.leaderboard.length === 0) ? (
                <View style={{ paddingVertical: 36, alignItems: "center", gap: 8 }}>
                  <Feather name="clock" size={28} color={colors.mutedForeground} />
                  <Text style={{ fontVariant: ["tabular-nums"], fontSize: 14, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>
                    {isLive ? "Waiting for riders to start…" : "Results not yet posted"}
                  </Text>
                </View>
              ) : isLive && liveView === "analytics" ? (
                <LiveAnalyticsView analytics={detail.analytics} colors={colors} />
              ) : isLive && liveView === "fastest" ? (
                <LiveFastestLapsView analytics={detail.analytics} colors={colors} />
              ) : (
                detail.leaderboard.map((entry, i) => (
                  <LeaderRow
                    key={leaderKey(entry, i)}
                    entry={entry}
                    index={i}
                    isLive={isLive}
                    colors={colors}
                    onOpen={openLeader}
                    isOwnRider={entry.riderId != null && ownRiderIds.has(entry.riderId)}
                  />
                ))
              )}
              {detail && (!isLive || liveView === "timing") ? <SectorsCard detail={detail} colors={colors} /> : null}
            </>
          )}

          <View style={{ height: 28 }} />
        </ScrollView>
      </View>
    </View>
  );
}

// ─── Event Schedule Screen ────────────────────────────────────────────────────

function EventScheduleScreen({
  event,
  onBack,
  colors,
  bottomInset,
  openMotoId,
  onOpenedMoto,
}: {
  event: BrowseEvent;
  onBack: () => void;
  colors: ReturnType<typeof useColors>;
  bottomInset: number;
  /** Open this race's live timing once the schedule loads (a follower's race start push). */
  openMotoId?: number | null;
  onOpenedMoto?: () => void;
}) {
  const bottomSpace = useBottomSpace();
  const { top: topInset } = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const [detail, setDetail]         = useState<PublicEventDetail | null>(null);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedMoto, setSelectedMoto] = useState<PublicMoto | null>(null);
  const isLive = event.status === "race_day";

  const load = useCallback(async () => {
    try {
      const res = await publicFetch(`/api/public/events/${event.eventId}/schedule`);
      if (res.ok) setDetail(await res.json());
    } catch { /* silently ignore */ }
    finally { setLoading(false); setRefreshing(false); }
  }, [event.eventId]);

  useEffect(() => { void load(); }, [load]);

  const openedMoto = useRef<number | null>(null);
  useEffect(() => {
    if (!openMotoId || !detail || openedMoto.current === openMotoId) return;
    openedMoto.current = openMotoId;
    const moto = detail.motos.find(m => m.motoId === openMotoId);
    if (moto) setSelectedMoto(moto);
    onOpenedMoto?.();
  }, [detail, openMotoId, onOpenedMoto]);

  // Poll every 15s during live events (only while on screen)
  useVisibleInterval(load, 15_000, isLive);

  const onRefresh = useCallback(async () => {
    haptics.selection();
    setRefreshing(true);
    await load();
  }, [load]);

  const motos = detail?.motos ?? [];
  const liveCount = motos.filter(m => m.status === "in_progress").length;
  const doneCount = motos.filter(m => m.status === "completed").length;
  const upcomingCount = motos.filter(m => m.status === "scheduled").length;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Header */}
      <View style={{
        paddingHorizontal: 16, paddingTop: topInset + 14, paddingBottom: 14,
        borderBottomWidth: 1, borderBottomColor: colors.border,
        backgroundColor: colors.background,
        flexDirection: "row", alignItems: "flex-start", gap: 10,
      }}>
        <Pressable
          onPress={onBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.6 : 1, marginTop: 2 })}
        >
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {isLive && (
              <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: colors.primary, flexDirection: "row", alignItems: "center", gap: 4 }}>
                <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: "#fff" }} />
                <Text style={{ fontSize: 10, fontWeight: "700", color: "#fff", fontFamily: "Roboto_700Bold", letterSpacing: 0.5 }}>RACE DAY</Text>
              </View>
            )}
            {!isLive && (
              <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: "#22c55e22" }}>
                <Text style={{ fontSize: 10, fontWeight: "700", color: "#22c55e", fontFamily: "Roboto_700Bold" }}>COMPLETED</Text>
              </View>
            )}
          </View>
          <Text style={{ fontSize: 17, fontWeight: "800", color: colors.foreground, fontFamily: "Roboto_700Bold", marginTop: 4 }} numberOfLines={2}>
            {event.name}
          </Text>
          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 2 }}>
            {placeLabel(event.location || event.trackName, event.state)}
            {event.date ? `  ·  ${fmtEventRange(event.date, event.endDate)}` : ""}
          </Text>
          {event.clubName ? (
            <Text style={{ fontSize: 11, color: colors.mutedForeground + "88", fontFamily: "Roboto_400Regular", marginTop: 1 }}>{event.clubName}</Text>
          ) : null}
        </View>
      </View>

      {/* Stats row */}
      {!loading && motos.length > 0 && (
        <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          {liveCount > 0 && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.primaryTint, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary }} />
              <Text style={{ fontSize: 11, fontWeight: "700", color: colors.primaryText, fontFamily: "Roboto_700Bold" }}>{liveCount} Live</Text>
            </View>
          )}
          {doneCount > 0 && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#22c55e18", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 }}>
              <Feather name="check" size={11} color="#22c55e" />
              <Text style={{ fontSize: 11, fontWeight: "700", color: "#22c55e", fontFamily: "Roboto_700Bold" }}>{doneCount} Done</Text>
            </View>
          )}
          {upcomingCount > 0 && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.muted, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 }}>
              <Feather name="clock" size={11} color={colors.mutedForeground} />
              <Text style={{ fontSize: 11, fontWeight: "600", color: colors.mutedForeground, fontFamily: "Roboto_600SemiBold" }}>{upcomingCount} Upcoming</Text>
            </View>
          )}
        </View>
      )}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {loading ? (
          <CardListSkeleton count={6} style={{ paddingTop: 16 }} />
        ) : motos.length === 0 ? (
          <View style={{ paddingVertical: 60, alignItems: "center", gap: 8, paddingHorizontal: 32 }}>
            <Feather name="clock" size={32} color={colors.mutedForeground} />
            <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", textAlign: "center" }}>
              Schedule not yet posted
            </Text>
          </View>
        ) : (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
              <Feather name="list" size={12} color={colors.mutedForeground} />
              <Text style={{ fontSize: 13, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.8 }}>
                Race Schedule
              </Text>
              <Text style={{ marginLeft: "auto", fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>
                {motos.length} motos
              </Text>
            </View>
            {motos.map(moto => {
              const live = moto.status === "in_progress";
              const done = moto.status === "completed";
              const chip = chipFor(moto.status);
              const hasLineup = moto.lineup.length > 0;
              return (
                <PressableScale
                  key={moto.motoId}
                  onPress={() => setSelectedMoto(moto)}
                  accessibilityRole="button"
                  scaleTo={0.98}
                  style={{
                    marginHorizontal: 16, marginBottom: 6, borderRadius: 10,
                    backgroundColor: colors.card,
                    borderWidth: live ? 1.5 : 1,
                    borderColor: live ? colors.primary : colors.border,
                    padding: 12,
                    flexDirection: "row", alignItems: "center", gap: 10,
                  }}
                >
                  {/* Badge */}
                  <View style={{
                    width: 44, height: 44, borderRadius: 10,
                    backgroundColor: live ? colors.primaryTint : done ? "#22c55e18" : colors.muted,
                    alignItems: "center", justifyContent: "center",
                  }}>
                    <Text style={{ fontSize: 11, fontWeight: "700", color: live ? colors.primaryText : done ? "#22c55e" : colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.3 }}>
                      RACE
                    </Text>
                    <Text style={{ fontSize: 16, fontWeight: "800", color: live ? colors.primaryText : done ? "#22c55e" : colors.foreground, fontFamily: "Roboto_700Bold", lineHeight: 18 }}>
                      #{moto.motoNumber}
                    </Text>
                  </View>

                  {/* Info */}
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: colors.foreground, fontFamily: "Roboto_600SemiBold" }}>{moto.name}</Text>
                    {moto.raceClass && (
                      <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 1 }}>{moto.raceClass}</Text>
                    )}
                    {hasLineup && (
                      <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 2 }}>
                        {moto.lineup.length} riders
                      </Text>
                    )}
                    {moto.scheduledTime && moto.status === "scheduled" && (
                      <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 2 }}>{moto.scheduledTime}</Text>
                    )}
                  </View>

                  {/* Chip + chevron */}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: live ? colors.primary : chip.color + "22" }}>
                      <Text style={{ fontSize: 10, fontWeight: "700", fontFamily: "Roboto_700Bold", color: live ? colors.primaryForeground : chip.color }}>
                        {chip.label}
                      </Text>
                    </View>
                    <Feather name="chevron-right" size={14} color={colors.mutedForeground} />
                  </View>
                </PressableScale>
              );
            })}
            <View style={{ height: bottomSpace }} />
          </>
        )}
      </ScrollView>

      {/* Moto detail sheet */}
      <Modal
        visible={selectedMoto != null}
        transparent
        animationType={reduceMotion ? "fade" : "slide"}
        onRequestClose={() => setSelectedMoto(null)}
      >
        {selectedMoto && (
          <PublicMotoSheet
            moto={motos.find(m => m.motoId === selectedMoto.motoId) ?? selectedMoto}
            onClose={() => setSelectedMoto(null)}
            colors={colors}
            bottomInset={bottomInset}
            raceStyle={detail?.raceStyle}
          />
        )}
      </Modal>
    </View>
  );
}

// ─── Event Browse Card ────────────────────────────────────────────────────────

function EventCard({
  event,
  colors,
  onPress,
  live = false,
}: {
  event: BrowseEvent;
  colors: ReturnType<typeof useColors>;
  onPress: () => void;
  live?: boolean;
}) {
  const isLive = live;
  const multiDay = !!event.endDate && event.endDate.slice(0, 10) !== event.date.slice(0, 10);
  return (
    <RaceEventCard
      title={event.name}
      dateIso={event.date}
      dateLabel={multiDay ? fmtEventRange(event.date, event.endDate) : null}
      place={placeLabel(event.location || event.trackName, event.state) || null}
      club={event.clubName}
      status={isLive ? "live" : null}
      onPress={onPress}
    />
  );
}

// ─── Series Card ──────────────────────────────────────────────────────────────

function SeriesCard({
  series,
  colors,
  onPress,
}: {
  series: PublicSeries;
  colors: ReturnType<typeof useColors>;
  onPress: () => void;
}) {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      style={{
        marginHorizontal: 16, marginBottom: 10, borderRadius: 12,
        backgroundColor: colors.card,
        borderWidth: 1, borderColor: colors.border,
        overflow: "hidden",
      }}
    >
      <View style={{ padding: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <View style={{
            width: 44, height: 44, borderRadius: 10,
            backgroundColor: colors.primary + "18",
            alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            <Feather name="award" size={18} color={colors.primaryText} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Roboto_700Bold" }} numberOfLines={2}>
              {series.name}
            </Text>
            {series.season && (
              <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 2 }}>
                {series.season}
              </Text>
            )}
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 1 }}>
              {series.clubName}{series.state ? ` · ${series.state}` : ""}
            </Text>
            {series.classes && series.classes.length > 0 && (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                {series.classes.slice(0, 5).map(cls => (
                  <View key={cls} style={{ backgroundColor: colors.muted, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 }}>
                    <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Roboto_500Medium" }}>{cls}</Text>
                  </View>
                ))}
                {series.classes.length > 5 && (
                  <View style={{ backgroundColor: colors.muted, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 }}>
                    <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Roboto_500Medium" }}>+{series.classes.length - 5} more</Text>
                  </View>
                )}
              </View>
            )}
          </View>
          <Feather name="chevron-right" size={18} color={colors.mutedForeground} style={{ marginTop: 2 }} />
        </View>
      </View>
    </PressableScale>
  );
}

// ─── Series Standings Screen ───────────────────────────────────────────────────

function SeriesStandingsScreen({
  series,
  onBack,
  colors,
  bottomInset,
}: {
  series: PublicSeries;
  onBack: () => void;
  colors: ReturnType<typeof useColors>;
  bottomInset: number;
}) {
  const { top: topInset } = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const bottomSpace = useBottomSpace();
  const [rows, setRows] = useState<SeriesStandingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedClasses, setExpandedClasses] = useState<Set<string>>(new Set());
  const [selectedRider, setSelectedRider] = useState<SeriesStandingRow | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await publicFetch(`/api/public/series/${series.id}/standings`);
      if (res.ok) {
        const data: SeriesStandingRow[] = await res.json();
        setRows(data);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); setRefreshing(false); }
  }, [series.id]);

  useEffect(() => { void load(); }, [load]);

  const onRefresh = useCallback(async () => { haptics.selection(); setRefreshing(true); await load(); }, [load]);

  const toggleClass = (cls: string) => setExpandedClasses(prev => {
    const next = new Set(prev);
    next.has(cls) ? next.delete(cls) : next.add(cls);
    return next;
  });

  // Group rows by raceClass, preserving sort order (already sorted by position from server)
  const byClass = React.useMemo(() => {
    const map = new Map<string, SeriesStandingRow[]>();
    for (const row of rows) {
      if (!map.has(row.raceClass)) map.set(row.raceClass, []);
      map.get(row.raceClass)!.push(row);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);

  const posColor = (pos: number) =>
    pos === 1 ? "#f59e0b" : pos === 2 ? "#94a3b8" : pos === 3 ? "#b45309" : colors.mutedForeground;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Header */}
      <View style={{
        paddingTop: topInset + 14,
        paddingHorizontal: 16, paddingBottom: 14,
        borderBottomWidth: 1, borderBottomColor: colors.border,
        backgroundColor: colors.background,
        flexDirection: "row", alignItems: "flex-start", gap: 10,
      }}>
        <Pressable
          onPress={onBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.6 : 1, marginTop: 2 })}
        >
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={{ fontVariant: ["tabular-nums"], fontSize: 17, fontWeight: "800", color: colors.foreground, fontFamily: "Roboto_700Bold" }} numberOfLines={2}>
            {series.name}
          </Text>
          <Text style={{ fontVariant: ["tabular-nums"], fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 2 }}>
            {[series.season, series.clubName, series.state].filter(Boolean).join(" · ")}
          </Text>
        </View>
      </View>

      {/* Class count strip */}
      {!loading && byClass.length > 0 && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Feather name="layers" size={12} color={colors.primaryText} />
          <Text style={{ fontVariant: ["tabular-nums"], fontSize: 13, fontWeight: "700", color: colors.primaryText, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.8 }}>
            {byClass.length} class{byClass.length !== 1 ? "es" : ""}
          </Text>
          <Pressable
            onPress={() => {
              const allOpen = byClass.every(([cls]) => expandedClasses.has(cls));
              setExpandedClasses(allOpen ? new Set() : new Set(byClass.map(([cls]) => cls)));
            }}
            style={({ pressed }) => ({ marginLeft: "auto", opacity: pressed ? 0.6 : 1 })}
          >
            <Text style={{ fontVariant: ["tabular-nums"], fontSize: 12, color: colors.primaryText, fontFamily: "Roboto_500Medium" }}>
              {byClass.every(([cls]) => expandedClasses.has(cls)) ? "Collapse all" : "Expand all"}
            </Text>
          </Pressable>
        </View>
      )}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {loading ? (
          <CardListSkeleton count={5} style={{ paddingTop: 16 }} />
        ) : byClass.length === 0 ? (
          <View style={{ paddingVertical: 80, alignItems: "center", paddingHorizontal: 32, gap: 10 }}>
            <Feather name="inbox" size={36} color={colors.mutedForeground + "60"} />
            <Text style={{ fontVariant: ["tabular-nums"], fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Roboto_700Bold", textAlign: "center" }}>No standings yet</Text>
            <Text style={{ fontVariant: ["tabular-nums"], fontSize: 14, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", textAlign: "center", lineHeight: 20 }}>
              Results will appear here once motos are scored and events are published.
            </Text>
          </View>
        ) : (
          <>
            {byClass.map(([cls, riders]) => {
              const open = expandedClasses.has(cls);
              return (
                <View key={cls} style={{ marginHorizontal: 16, marginTop: 10, borderRadius: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, overflow: "hidden" }}>
                  {/* Class header */}
                  <Pressable
                    onPress={() => toggleClass(cls)}
                    style={({ pressed }) => ({
                      flexDirection: "row", alignItems: "center",
                      paddingHorizontal: 14, paddingVertical: 13,
                      backgroundColor: open ? colors.primary + "0f" : "transparent",
                      opacity: pressed ? 0.7 : 1,
                    })}
                  >
                    <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: colors.primary + "18", alignItems: "center", justifyContent: "center", marginRight: 10 }}>
                      <Feather name="layers" size={13} color={colors.primaryText} />
                    </View>
                    <Text style={{ fontVariant: ["tabular-nums"], flex: 1, fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Roboto_700Bold" }}>{cls}</Text>
                    <Text style={{ fontVariant: ["tabular-nums"], fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginRight: 8 }}>
                      {riders.length} rider{riders.length !== 1 ? "s" : ""}
                    </Text>
                    <Feather name={open ? "chevron-up" : "chevron-down"} size={16} color={colors.mutedForeground} />
                  </Pressable>

                  {/* Leaderboard rows */}
                  {open && riders.map((rider, idx) => (
                    <Pressable
                      key={rider.riderId}
                      onPress={() => setSelectedRider(rider)}
                      style={({ pressed }) => ({
                        flexDirection: "row", alignItems: "center",
                        paddingHorizontal: 14, paddingVertical: 11,
                        borderTopWidth: 1, borderTopColor: colors.border + "88",
                        backgroundColor: pressed ? colors.muted + "60" : (idx % 2 === 0 ? "transparent" : colors.muted + "30"),
                      })}
                    >
                      {/* Position */}
                      <View style={{
                        width: 32, height: 32, borderRadius: 10,
                        backgroundColor: posColor(rider.position) + "20",
                        alignItems: "center", justifyContent: "center", marginRight: 10,
                      }}>
                        <Text style={{ fontVariant: ["tabular-nums"], fontSize: 14, fontWeight: "800", color: posColor(rider.position), fontFamily: "Roboto_700Bold" }}>
                          {rider.position}
                        </Text>
                      </View>

                      {/* Name + info */}
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontVariant: ["tabular-nums"], fontSize: 14, fontWeight: "600", color: colors.foreground, fontFamily: "Roboto_600SemiBold" }} numberOfLines={1}>
                          {rider.riderName}
                        </Text>
                        <View style={{ flexDirection: "row", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
                          <Text style={{ fontVariant: ["tabular-nums"], fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>
                            {rider.eventsEntered} event{rider.eventsEntered !== 1 ? "s" : ""}
                          </Text>
                          {rider.bikeBrand && (
                            <Text style={{ fontVariant: ["tabular-nums"], fontSize: 11, color: colors.mutedForeground + "90", fontFamily: "Roboto_400Regular" }}>· {rider.bikeBrand}</Text>
                          )}
                        </View>
                      </View>

                      {/* Points + chevron */}
                      <View style={{ alignItems: "flex-end", gap: 2 }}>
                        <Text style={{ fontVariant: ["tabular-nums"], fontSize: 16, fontWeight: "800", color: colors.primaryText, fontFamily: "Roboto_700Bold" }}>
                          {rider.totalScore}
                        </Text>
                        <Text style={{ fontVariant: ["tabular-nums"], fontSize: 10, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", textTransform: "uppercase", letterSpacing: 0.5 }}>
                          pts
                        </Text>
                      </View>
                      <Feather name="chevron-right" size={14} color={colors.mutedForeground + "80"} style={{ marginLeft: 6 }} />
                    </Pressable>
                  ))}
                </View>
              );
            })}
            <View style={{ height: bottomSpace }} />
          </>
        )}
      </ScrollView>

      {/* ── Rider breakdown sheet ── */}
      <Modal
        visible={!!selectedRider}
        transparent
        animationType={reduceMotion ? "fade" : "slide"}
        onRequestClose={() => setSelectedRider(null)}
      >
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.52)" }}>
          <Pressable style={{ flex: 1 }} onPress={() => setSelectedRider(null)} />
          {selectedRider && (
            <View style={{
              backgroundColor: colors.card,
              borderTopLeftRadius: 22, borderTopRightRadius: 22,
              maxHeight: "80%",
              paddingBottom: bottomInset + 8,
            }}>
              {/* Drag handle */}
              <View style={{ alignItems: "center", paddingTop: 12, paddingBottom: 4 }}>
                <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: colors.border }} />
              </View>

              {/* Header */}
              <View style={{
                flexDirection: "row", alignItems: "flex-start",
                paddingHorizontal: 20, paddingTop: 10, paddingBottom: 14,
                borderBottomWidth: 1, borderBottomColor: colors.border,
              }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontVariant: ["tabular-nums"], fontSize: 17, fontWeight: "800", color: colors.foreground, fontFamily: "Roboto_700Bold" }}>
                    {selectedRider.riderName}
                  </Text>
                  <Text style={{ fontVariant: ["tabular-nums"], fontSize: 13, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 2 }}>
                    {selectedRider.raceClass} · {ordinalSuffix(selectedRider.position)} place · {selectedRider.totalScore} pts total
                  </Text>
                  <View style={{ marginRight: -28 }}>
                    <RiderLookupCard riderId={selectedRider.riderId} name={selectedRider.riderName} onBeforeOpen={() => setSelectedRider(null)} />
                  </View>
                </View>
                <Pressable onPress={() => setSelectedRider(null)} hitSlop={8} style={{ padding: 4 }} accessibilityRole="button" accessibilityLabel="Close">
                  <Feather name="x" size={20} color={colors.mutedForeground} />
                </Pressable>
              </View>

              {/* Column headers */}
              <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 8, backgroundColor: colors.muted + "50" }}>
                <Text style={{ fontVariant: ["tabular-nums"], flex: 1, fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.5 }}>Race</Text>
                <Text style={{ fontVariant: ["tabular-nums"], width: 70, fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>Finish</Text>
                <Text style={{ fontVariant: ["tabular-nums"], width: 52, fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.5, textAlign: "right" }}>Pts</Text>
              </View>

              <ScrollView showsVerticalScrollIndicator={false}>
                {selectedRider.events.filter(ev => ev.attended).map((ev, i) => {
                  const finishes = ev.finishPositions.filter((p): p is number => p !== null);
                  const finishLabel = finishes.length > 0
                    ? finishes.map(p => `P${p}`).join(" / ")
                    : "—";
                  return (
                    <View
                      key={ev.eventId}
                      style={{
                        flexDirection: "row", alignItems: "center",
                        paddingHorizontal: 20, paddingVertical: 13,
                        borderBottomWidth: 1, borderBottomColor: colors.border + "55",
                        backgroundColor: i % 2 === 0 ? "transparent" : colors.muted + "20",
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontVariant: ["tabular-nums"], fontSize: 14, fontWeight: "600", color: colors.foreground, fontFamily: "Roboto_600SemiBold" }} numberOfLines={1}>
                          {ev.eventName}
                        </Text>
                      </View>
                      <View style={{ width: 70, alignItems: "center" }}>
                        <Text style={{ fontVariant: ["tabular-nums"], fontSize: 13, fontWeight: "700", color: finishes.length > 0 ? posColor(Math.min(...finishes)) : colors.mutedForeground, fontFamily: "Roboto_700Bold" }}>
                          {finishLabel}
                        </Text>
                      </View>
                      <Text style={{ fontVariant: ["tabular-nums"], width: 52, fontSize: 15, fontWeight: "700", color: colors.primaryText, fontFamily: "Roboto_700Bold", textAlign: "right" }}>
                        {ev.eventScore}
                      </Text>
                    </View>
                  );
                })}
                <View style={{ height: 16 }} />
              </ScrollView>
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

type MainTab = "races" | "series";


export default function ResultsScreen() {
  const colors  = useColors();
  const insets  = useSafeAreaInsets();
  const bottomSpace = useBottomSpace();
  const [tab, setTab] = useState<MainTab>("races");

  // ── Races state ──────────────────────────────────────────────────────────────
  const [events, setEvents]         = useState<BrowseEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsRefreshing, setEventsRefreshing] = useState(false);
  const [racesQuery, setRacesQuery] = useState("");
  const [selectedEvent, setSelectedEvent] = useState<BrowseEvent | null>(null);
  const racesDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [racesDebouncedQ, setRacesDebouncedQ] = useState("");

  // ── Series state ─────────────────────────────────────────────────────────────
  const [seriesList, setSeriesList]   = useState<PublicSeries[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesRefreshing, setSeriesRefreshing] = useState(false);
  const [seriesQuery, setSeriesQuery] = useState("");
  const [selectedSeries, setSelectedSeries] = useState<PublicSeries | null>(null);
  const seriesDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [seriesDebouncedQ, setSeriesDebouncedQ] = useState("");

  // Live / Past toggle: null until the rider picks a side, then theirs.
  const [pickedSide, setPickedSide] = useState<"live" | "past" | null>(null);
  const [upcoming, setUpcoming] = useState<BrowseEvent[]>([]);

  // Opened on one race from elsewhere in the app (an event's "Full results").
  // A follower's race start push also names the race (motoId) to open on live timing.
  const { eventId: openEventId, motoId: openMotoParam } = useLocalSearchParams<{ eventId?: string; motoId?: string }>();
  const [openMotoId, setOpenMotoId] = useState<number | null>(null);
  useEffect(() => {
    const id = Number(openEventId);
    if (!Number.isInteger(id) || id <= 0) return;
    const motoId = Number(openMotoParam);
    setOpenMotoId(Number.isInteger(motoId) && motoId > 0 ? motoId : null);
    let cancelled = false;
    (async () => {
      try {
        const res = await publicFetch(`/api/events/${id}`);
        if (!res.ok || cancelled) return;
        const r = await res.json() as Record<string, unknown>;
        setTab("races");
        setSelectedSeries(null);
        setSelectedEvent({
          eventId: id, name: String(r.name ?? ""), state: (r.state as string) ?? "",
          date: String(r.date ?? ""), endDate: (r.endDate as string | null) ?? null,
          location: (r.location as string) ?? "", trackName: (r.trackName as string) ?? "",
          status: String(r.status ?? ""), clubName: (r.clubName as string) ?? "",
        });
      } catch { /* stay on the list */ }
      finally { router.setParams({ eventId: undefined, motoId: undefined } as never); }
    })();
    return () => { cancelled = true; };
  }, [openEventId]);

  // Reset to root when tab icon is pressed
  useEffect(() => {
    return onTabReset("results", () => {
      setSelectedEvent(null);
      setSelectedSeries(null);
    });
  }, []);

  // ── Races data loading ───────────────────────────────────────────────────────
  const eventsRequest = useRef(0);
  const loadEvents = useCallback(async (q: string) => {
    const request = ++eventsRequest.current;
    try {
      const res = await publicFetch(`/api/public/events/browse?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const rows = await res.json();
        if (request === eventsRequest.current) setEvents(rows);
      }
    } catch { /* silently ignore */ }
    finally { if (request === eventsRequest.current) { setEventsLoading(false); setEventsRefreshing(false); } }
  }, []);

  useEffect(() => { void loadEvents(racesDebouncedQ); }, [racesDebouncedQ, loadEvents]);

  // Scheduled races, for the "No races live right now" state.
  const loadUpcoming = useCallback(async () => {
    try {
      const res = await publicFetch("/api/public/upcoming");
      if (res.ok) {
        const rows = await res.json() as Array<Record<string, unknown>>;
        setUpcoming(rows.map(r => ({
          eventId: Number(r.id ?? r.eventId), name: String(r.name ?? ""), state: (r.state as string) ?? "",
          date: String(r.date ?? ""), endDate: (r.endDate as string | null) ?? null,
          location: (r.location as string | null) ?? null, trackName: (r.trackName as string | null) ?? null,
          status: String(r.status ?? ""), clubName: (r.clubName as string | null) ?? null,
        }) as BrowseEvent));
      }
    } catch { /* silently ignore */ }
  }, []);
  useEffect(() => { void loadUpcoming(); }, [loadUpcoming]);

  // Keep the race list fresh while it's on screen.
  const refreshEvents = useCallback(() => loadEvents(racesDebouncedQ), [loadEvents, racesDebouncedQ]);
  useVisibleInterval(refreshEvents, 30_000);

  // ── Series data loading ──────────────────────────────────────────────────────
  const loadSeries = useCallback(async (q: string) => {
    try {
      setSeriesLoading(true);
      const url = q ? `/api/public/series?q=${encodeURIComponent(q)}` : "/api/public/series";
      const res = await publicFetch(url);
      if (res.ok) setSeriesList(await res.json());
    } catch { /* silently ignore */ }
    finally { setSeriesLoading(false); setSeriesRefreshing(false); }
  }, []);

  // Load series when tab is first switched to
  useEffect(() => {
    if (tab === "series") void loadSeries(seriesDebouncedQ);
  }, [tab, seriesDebouncedQ, loadSeries]);

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const handleRacesQueryChange = (text: string) => {
    setRacesQuery(text);
    if (racesDebounceRef.current) clearTimeout(racesDebounceRef.current);
    racesDebounceRef.current = setTimeout(() => setRacesDebouncedQ(text.trim()), 350);
  };

  const handleSeriesQueryChange = (text: string) => {
    setSeriesQuery(text);
    if (seriesDebounceRef.current) clearTimeout(seriesDebounceRef.current);
    seriesDebounceRef.current = setTimeout(() => setSeriesDebouncedQ(text.trim()), 350);
  };

  // ── Sub-screen guards ────────────────────────────────────────────────────────
  if (selectedEvent) {
    return (
      <EventScheduleScreen
        key={selectedEvent.eventId}
        event={selectedEvent}
        onBack={() => { setSelectedEvent(null); setOpenMotoId(null); }}
        colors={colors}
        bottomInset={insets.bottom}
        openMotoId={openMotoId}
        onOpenedMoto={() => setOpenMotoId(null)}
      />
    );
  }

  if (selectedSeries) {
    return (
      <SeriesStandingsScreen
        series={selectedSeries}
        onBack={() => setSelectedSeries(null)}
        colors={colors}
        bottomInset={insets.bottom}
      />
    );
  }

  const todayYmd = localDateString();
  const { live: liveEvents, past: pastEvents } = splitLivePast(events, todayYmd);
  const side = pickedSide ?? defaultSide(liveEvents.length);
  const shown = side === "live" ? liveEvents : pastEvents;
  const comingUp = nextScheduled(upcoming, todayYmd, 4);

  // Filter series client-side by name/club/state when query exists
  const filteredSeries = seriesDebouncedQ
    ? seriesList.filter(s => {
        const q = seriesDebouncedQ.toLowerCase();
        const has = (v: unknown) => String(v ?? "").toLowerCase().includes(q);
        return has(s.name) || has(s.clubName) || has(s.state) || has(s.season);
      })
    : seriesList;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Header */}
      <View style={{
        paddingTop: insets.top + 16, paddingHorizontal: 20, paddingBottom: 12,
        backgroundColor: colors.card,
        borderBottomWidth: 1, borderBottomColor: colors.border,
      }}>
        <BrandBar />
        <Text style={{ fontSize: 26, fontWeight: "800", color: colors.foreground, fontFamily: "Barlow_800ExtraBold", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>
          Race Results
        </Text>

        {/* Tab toggle */}
        <View style={{
          flexDirection: "row", backgroundColor: colors.muted,
          borderRadius: 999, padding: 4,
          borderWidth: 1, borderColor: colors.border, marginBottom: 12,
        }}>
          {(["races", "series"] as MainTab[]).map(t => {
            const active = tab === t;
            return (
              <Pressable
                key={t}
                onPress={() => { if (t !== tab) haptics.light(); setTab(t); }}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                style={{
                  flex: 1, paddingVertical: 9, borderRadius: 999, alignItems: "center",
                  backgroundColor: active ? colors.primary : "transparent",
                  shadowColor: active ? "#000" : "transparent",
                  shadowOpacity: active ? 0.08 : 0,
                  shadowOffset: { width: 0, height: 1 },
                  shadowRadius: 2,
                  elevation: active ? 2 : 0,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Feather
                    name={t === "races" ? "flag" : "award"}
                    size={13}
                    color={active ? "#fff" : colors.mutedForeground}
                  />
                  <Text style={{
                    fontSize: 13, fontWeight: "700",
                    fontFamily: "Roboto_700Bold",
                    color: active ? "#fff" : colors.mutedForeground,
                  }}>
                    {t === "races" ? "Race Events" : "Series"}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>

        {/* Search bar */}
        <View style={{
          flexDirection: "row", alignItems: "center", gap: 8,
          backgroundColor: colors.muted, borderRadius: 12,
          paddingHorizontal: 12, paddingVertical: 10,
          borderWidth: 1, borderColor: colors.border,
        }}>
          <Feather name="search" size={16} color={colors.mutedForeground} />
          {tab === "races" ? (
            <TextInput
              value={racesQuery}
              onChangeText={handleRacesQueryChange}
              placeholder="Search by state, city, race or track name…"
              placeholderTextColor={colors.mutedForeground}
              style={{ flex: 1, fontSize: 14, color: colors.foreground, fontFamily: "Roboto_400Regular", padding: 0 }}
              returnKeyType="search"
              autoCorrect={false}
              autoCapitalize="none"
            />
          ) : (
            <TextInput
              value={seriesQuery}
              onChangeText={handleSeriesQueryChange}
              placeholder="Search by series name, club, state…"
              placeholderTextColor={colors.mutedForeground}
              style={{ flex: 1, fontSize: 14, color: colors.foreground, fontFamily: "Roboto_400Regular", padding: 0 }}
              returnKeyType="search"
              autoCorrect={false}
              autoCapitalize="none"
            />
          )}
          {(tab === "races" ? racesQuery : seriesQuery).length > 0 && (
            <Pressable
              onPress={() => {
                // Also drop a search still waiting on its typing delay.
                if (tab === "races") { if (racesDebounceRef.current) clearTimeout(racesDebounceRef.current); setRacesQuery(""); setRacesDebouncedQ(""); }
                else { if (seriesDebounceRef.current) clearTimeout(seriesDebounceRef.current); setSeriesQuery(""); setSeriesDebouncedQ(""); }
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
            >
              <Feather name="x-circle" size={16} color={colors.mutedForeground} />
            </Pressable>
          )}
        </View>

        {/* Live / Past toggle */}
        {tab === "races" && (
          <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
            {(["live", "past"] as const).map(k => {
              const active = side === k;
              return (
                <Pressable
                  key={k}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={k === "live" ? `Live, ${liveEvents.length} running` : `Past, ${pastEvents.length} events`}
                  onPress={() => { if (k !== side) haptics.light(); setPickedSide(k); }}
                  style={{
                    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
                    paddingVertical: 8, borderRadius: 999, borderWidth: 1.5,
                    borderColor: active ? colors.foreground : colors.border,
                    backgroundColor: active ? colors.foreground : "transparent",
                  }}
                >
                  {k === "live" && <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: liveEvents.length > 0 ? colors.primary : colors.mutedForeground }} />}
                  <Text style={{ fontSize: 13, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 1, color: active ? colors.background : colors.foreground }}>
                    {k === "live" ? "Live" : "Past"}
                  </Text>
                  {k === "live" && liveEvents.length > 0 && (
                    <View style={{ minWidth: 18, paddingHorizontal: 5, height: 18, borderRadius: 9, backgroundColor: "#D32F2F", alignItems: "center", justifyContent: "center" }}>
                      <Text style={{ fontSize: 11, color: "#fff", fontFamily: "Roboto_700Bold" }}>{liveEvents.length}</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}
      </View>

      {/* ── RACES TAB ─────────────────────────────────────────────────────────── */}
      {tab === "races" && (
        <ScrollView
          refreshControl={<RefreshControl refreshing={eventsRefreshing} onRefresh={async () => { haptics.selection(); setEventsRefreshing(true); await loadEvents(racesDebouncedQ); }} tintColor={colors.primary} />}
        >
          {eventsLoading ? (
            <CardListSkeleton kind="event" count={5} style={{ paddingTop: 20 }} />
          ) : (
            <>
              {shown.length > 0 ? (
                <>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 10 }}>
                    {side === "live"
                      ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.primary }} />
                      : <Feather name="flag" size={12} color={colors.primaryText} />}
                    <Text style={{ fontSize: 13, fontWeight: "700", color: side === "live" ? "#D32F2F" : colors.primaryText, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>
                      {side === "live" ? "Live Now" : "Past Races"}
                    </Text>
                    <Text style={{ marginLeft: "auto", fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>
                      {shown.length} {shown.length === 1 ? "event" : "events"}
                    </Text>
                  </View>
                  {shown.map(e => (
                    <EventCard key={e.eventId} event={e} colors={colors} live={side === "live"} onPress={() => setSelectedEvent(e)} />
                  ))}
                </>
              ) : side === "live" ? (
                <>
                  <EmptyState
                    icon="radio"
                    title={racesDebouncedQ ? "No matching races live" : "No races live right now"}
                    message={racesDebouncedQ ? "Nothing running today matches your search." : "Races show up here on race day while they're running."}
                  />
                  {!racesDebouncedQ && comingUp.length > 0 && (
                    <>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 10 }}>
                        <Feather name="calendar" size={12} color={colors.primaryText} />
                        <Text style={{ fontSize: 13, fontWeight: "700", color: colors.primaryText, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>
                          Coming up
                        </Text>
                      </View>
                      {comingUp.map(e => (
                        <EventCard key={e.eventId} event={e} colors={colors} onPress={() => router.push(`/event/${e.eventId}`)} />
                      ))}
                    </>
                  )}
                </>
              ) : (
                <EmptyState
                  icon={racesDebouncedQ ? "search" : "flag"}
                  title={racesDebouncedQ ? "No matching past races" : "No past races yet"}
                  message={racesDebouncedQ ? "Try a state (UT), a city, a track or an event name." : "Finished races show up here."}
                />
              )}

              <View style={{ height: bottomSpace }} />
            </>
          )}
        </ScrollView>
      )}

      {/* ── SERIES TAB ────────────────────────────────────────────────────────── */}
      {tab === "series" && (
        <ScrollView
          refreshControl={<RefreshControl refreshing={seriesRefreshing} onRefresh={async () => { haptics.selection(); setSeriesRefreshing(true); await loadSeries(seriesDebouncedQ); }} tintColor={colors.primary} />}
        >
          {seriesLoading && seriesList.length === 0 ? (
            <CardListSkeleton kind="event" count={4} style={{ paddingTop: 20 }} />
          ) : filteredSeries.length === 0 ? (
            <View style={{ paddingVertical: 80, alignItems: "center", paddingHorizontal: 32, gap: 8 }}>
              <Feather name="award" size={36} color={colors.mutedForeground + "60"} />
              <Text style={{ fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Roboto_700Bold", textAlign: "center" }}>
                {seriesDebouncedQ ? "No matching series" : "No series yet"}
              </Text>
              <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", textAlign: "center", lineHeight: 20 }}>
                {seriesDebouncedQ
                  ? "Try a different search — series name, club name, or state."
                  : "Championship series will appear here once clubs create them."}
              </Text>
            </View>
          ) : (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 10 }}>
                <Feather name="award" size={12} color={colors.primaryText} />
                <Text style={{ fontSize: 13, fontWeight: "700", color: colors.primaryText, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>
                  Championship Series
                </Text>
                <Text style={{ marginLeft: "auto", fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>
                  {filteredSeries.length} series
                </Text>
              </View>
              {filteredSeries.map(s => (
                <SeriesCard key={s.id} series={s} colors={colors} onPress={() => setSelectedSeries(s)} />
              ))}
              <View style={{ height: bottomSpace }} />
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}
