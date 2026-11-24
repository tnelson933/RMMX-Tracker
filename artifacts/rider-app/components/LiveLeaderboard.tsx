/**
 * The live / finished race leaderboard, shared by the Results tab's race sheet
 * (app/(tabs)/results.tsx) and the event live screen (app/live/[eventId].tsx).
 * Rows keep stable keys, slide to their new place between refreshes and flash
 * green/red when a rider gains or loses a position. Tapping a rider opens
 * RiderLapSheet: their lap times plus the RiderLookupCard (racer profile).
 */
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import Animated, {
  Easing, LinearTransition, ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming,
} from "react-native-reanimated";

import { NumberPlate } from "@/components/NumberPlate";
import { fmtLap } from "@/components/RaceSubScreens";
import { RiderLookupCard } from "@/components/RiderLookupCard";
import { fonts } from "@/constants/fonts";
import { useColors } from "@/hooks/useColors";
import { API_BASE_URL } from "@/lib/apiBase";
import { haptics } from "@/lib/haptics";
import { fastestLapRiderId, hasBikeNumbers, intervalAhead } from "@/lib/liveEvent";

type Colors = ReturnType<typeof useColors>;

// ─── Types (GET /api/public/motos/:motoId/detail) ────────────────────────────

export interface PublicLeaderEntry {
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
  /** Newer servers: raw times for intervals and the fastest-lap mark. */
  totalMs?: number | null;
  lastLapMs?: number | null;
  bestLapMs?: number | null;
  bestLap?: string | null;
  /** Present when the course map has split readers. */
  sectors?: { bestMs: Array<number | null> | null; lastLapMs: Array<number | null> | null } | null;
}

export interface PublicLineupEntry {
  gate: number;
  riderName: string;
  bibNumber: string | null;
}

interface LapRow {
  lapNumber: number;
  lapTimeMs: number;
}

// ─── Official / unofficial ───────────────────────────────────────────────────

/** Under a finished race's title: whether the club has made the results official. */
export function ResultsStatusLabel({ official }: { official: boolean | undefined }) {
  const colors = useColors();
  return (
    <Text style={{ fontVariant: ["tabular-nums"], fontSize: 12, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 0.6, marginTop: 4, color: official ? colors.success : colors.warning }}>
      {official ? "✓ Official results" : "Unofficial results"}
    </Text>
  );
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

const POS_FLASH_IN = { duration: 120 };
const POS_FLASH_OUT = { duration: 220 };
/** Rows slide to their new place between refreshes; instant with reduce motion. */
const ROW_REORDER = LinearTransition.duration(280).easing(Easing.bezier(0.77, 0, 0.175, 1)).reduceMotion(ReduceMotion.System);

/** Stable key for a leaderboard row across refreshes (rows move; index keys would not). */
export function leaderKey(entry: PublicLeaderEntry, i: number): string {
  if (entry.riderId != null) return `r${entry.riderId}`;
  if (entry.bibNumber) return `b${entry.bibNumber}`;
  return `n${entry.riderName}-${i}`;
}

/**
 * One leaderboard row. When the rider's position changes between refreshes the
 * row slides to its new place (layout transition on the UI thread) and the
 * position flashes green (gained) or red (lost) for ~600 ms. The flash is a
 * colour change, so it stays on with reduce motion; the slide does not.
 */
const LeaderRow = React.memo(function LeaderRow({
  entry, index, isLive, colors, onOpen, isOwnRider, showPlate, interval, fastest,
}: {
  entry: PublicLeaderEntry;
  index: number;
  isLive: boolean;
  colors: Colors;
  onOpen?: (entry: PublicLeaderEntry) => void;
  isOwnRider: boolean;
  showPlate: boolean;
  interval: string | null;
  fastest: boolean;
}) {
  const isDNF = !!entry.dnf;
  const isDNS = !!entry.dns;
  const out = isDNF || isDNS;
  const pos = isDNS ? "DNS" : isDNF ? "DNF" : String(entry.position ?? index + 1);
  const isP1 = entry.position === 1 && !out;
  const canOpen = !!entry.riderId && !isDNS && !!onOpen;

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

  const leader = entry.gap === "Leader" && !out;
  // Live: gap to the leader on top, interval to the rider ahead below.
  // Finished: total time on top, gap below.
  const top = out ? null : isLive ? (leader ? "Leader" : entry.gap || null) : entry.totalTime;
  const bottom = out ? null : isLive ? (interval && interval !== entry.gap ? `Int ${interval}` : null) : (leader ? "Leader" : entry.gap || null);
  const lapsLabel = entry.laps > 0 ? `${entry.laps} ${entry.laps === 1 ? "lap" : "laps"}` : null;
  const lastLabel = entry.lastLap && !out ? `Last ${entry.lastLap}` : null;
  const sub = [lapsLabel, lastLabel].filter(Boolean).join("  ·  ");

  const a11y = [
    out ? pos : `Position ${pos}`,
    entry.riderName,
    entry.bibNumber ? `number ${entry.bibNumber}` : null,
    lapsLabel,
    top && top !== "Leader" ? `${top} behind` : leader ? "leading" : null,
    fastest && entry.bestLap ? `fastest lap ${entry.bestLap}` : null,
  ].filter(Boolean).join(", ");

  return (
    <Animated.View layout={ROW_REORDER}>
      <Pressable
        onPress={canOpen ? () => onOpen!(entry) : undefined}
        accessibilityRole={canOpen ? "button" : undefined}
        accessibilityLabel={a11y}
        accessibilityHint={canOpen ? "Shows lap times and the racer profile" : undefined}
        style={({ pressed }) => ({
          flexDirection: "row", alignItems: "center", gap: 12,
          paddingLeft: 16, paddingRight: 16, paddingVertical: 10, minHeight: 60,
          borderBottomWidth: 1, borderBottomColor: colors.border + "55",
          borderLeftWidth: 3, borderLeftColor: isOwnRider ? colors.primary : "transparent",
          backgroundColor: pressed && canOpen ? colors.muted : isOwnRider ? colors.primaryTint : "transparent",
        })}
      >
        <Animated.View style={[{ width: 40, alignItems: "center", borderRadius: 8, paddingVertical: 2 }, flashStyle]}>
          <Text style={out
            ? { fontSize: 13, color: colors.mutedForeground, fontFamily: fonts.display, letterSpacing: 0.8 }
            : { fontVariant: ["tabular-nums"], fontSize: 24, lineHeight: 28, color: isP1 ? colors.chartBest : colors.foreground, fontFamily: fonts.displayHeavy }}>
            {pos}
          </Text>
        </Animated.View>
        {showPlate && (
          <View style={{ width: 46, alignItems: "center", opacity: out ? 0.5 : 1 }}>
            {entry.bibNumber ? <NumberPlate number={entry.bibNumber} size={24} /> : null}
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={{ fontSize: 15, color: out ? colors.mutedForeground : colors.foreground, fontFamily: isOwnRider ? fonts.bold : fonts.medium }}>
            {entry.riderName}
          </Text>
          {(sub || fastest) ? (
            <Text numberOfLines={1} style={{ fontVariant: ["tabular-nums"], fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.regular }}>
              {sub}
              {fastest && entry.bestLap ? (
                <Text style={{ color: colors.chartBest, fontFamily: fonts.bold }}>{sub ? "  ·  " : ""}★ Best {entry.bestLap}</Text>
              ) : null}
            </Text>
          ) : null}
        </View>
        <View style={{ alignItems: "flex-end", gap: 2, maxWidth: 104 }}>
          {top ? (
            <Text numberOfLines={1} style={{ fontVariant: ["tabular-nums"], fontSize: 14, color: top === "Leader" ? colors.chartBest : colors.foreground, fontFamily: fonts.semibold }}>
              {top}
            </Text>
          ) : out ? (
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.regular }}>{isDNS ? "Did not start" : "Did not finish"}</Text>
          ) : null}
          {bottom ? (
            <Text numberOfLines={1} style={{ fontVariant: ["tabular-nums"], fontSize: 11, color: bottom === "Leader" ? colors.chartBest : colors.mutedForeground, fontFamily: fonts.regular }}>
              {bottom}
            </Text>
          ) : null}
        </View>
        {canOpen && <Feather name="chevron-right" size={14} color={colors.mutedForeground} />}
      </Pressable>
    </Animated.View>
  );
});

/**
 * The leaderboard: a column header and one row per rider. The number-plate
 * column only appears when riders have numbers.
 */
export function LiveLeaderboard({
  entries, isLive, onOpen, ownRiderIds,
}: {
  entries: PublicLeaderEntry[];
  isLive: boolean;
  onOpen?: (entry: PublicLeaderEntry) => void;
  ownRiderIds?: ReadonlySet<number>;
}) {
  const colors = useColors();
  const showPlate = useMemo(() => hasBikeNumbers(entries), [entries]);
  const fastestId = useMemo(() => fastestLapRiderId(entries), [entries]);
  const head = { fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 0.8 } as const;

  return (
    <View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 19, paddingRight: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text style={[head, { width: 40, textAlign: "center" }]}>Pos</Text>
        {showPlate && <Text style={[head, { width: 46, textAlign: "center" }]}>No.</Text>}
        <Text style={[head, { flex: 1 }]}>Rider</Text>
        <Text style={[head, { textAlign: "right", marginRight: onOpen ? 26 : 0 }]}>{isLive ? "Gap" : "Time"}</Text>
      </View>
      {entries.map((entry, i) => (
        <LeaderRow
          key={leaderKey(entry, i)}
          entry={entry}
          index={i}
          isLive={isLive}
          colors={colors}
          onOpen={onOpen}
          isOwnRider={entry.riderId != null && !!ownRiderIds?.has(entry.riderId)}
          showPlate={showPlate}
          interval={isLive ? intervalAhead(entries, i) : null}
          fastest={fastestId != null && entry.riderId === fastestId}
        />
      ))}
    </View>
  );
}

// ─── Gate draw (a race that hasn't started) ──────────────────────────────────

export function LineupList({ rows, colors }: { rows: PublicLineupEntry[]; colors: Colors }) {
  if (rows.length === 0) {
    return (
      <View style={{ paddingVertical: 36, alignItems: "center", gap: 8 }}>
        <Feather name="clock" size={28} color={colors.mutedForeground} />
        <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: fonts.regular }}>Gate draw not posted yet</Text>
      </View>
    );
  }
  return (
    <>
      {rows.map((entry, i) => (
        <View
          key={`${entry.gate}-${i}`}
          style={{
            flexDirection: "row", alignItems: "center", gap: 14,
            paddingHorizontal: 20, paddingVertical: 11,
            borderBottomWidth: 1, borderBottomColor: colors.border + "55",
          }}
        >
          <View style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.display, textTransform: "uppercase" }}>Gate</Text>
            <Text style={{ fontVariant: ["tabular-nums"], fontSize: 15, color: colors.foreground, fontFamily: fonts.bold, lineHeight: 17 }}>
              #{entry.gate}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, color: colors.foreground, fontFamily: fonts.medium }}>{entry.riderName}</Text>
            {entry.bibNumber && (
              <Text style={{ fontVariant: ["tabular-nums"], fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.regular, marginTop: 1 }}>
                #{entry.bibNumber}
              </Text>
            )}
          </View>
        </View>
      ))}
    </>
  );
}

// ─── Rider lap sheet ─────────────────────────────────────────────────────────

/** A rider's lap times in one race, with gap to the leader's laps, and their racer card. */
export function RiderLapSheet({
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
  colors: Colors;
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
          fetch(`${API_BASE_URL}/api/public/motos/${motoId}/laps/${riderId}`),
        ];
        if (leaderRiderId != null && leaderRiderId !== riderId) {
          fetches.push(fetch(`${API_BASE_URL}/api/public/motos/${motoId}/laps/${leaderRiderId}`));
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
      <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close" />
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
            <Text style={{ fontSize: 17, color: colors.foreground, fontFamily: fonts.bold }}>
              {riderName}
            </Text>
            <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: fonts.regular, marginTop: 2 }}>
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
              <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: fonts.regular }}>No lap data recorded</Text>
            </View>
          ) : (
            <>
              <View style={{ flexDirection: "row", paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6 }}>
                <Text style={{ width: 44, fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.display, textTransform: "uppercase" }}>Lap</Text>
                <Text style={{ flex: 1, fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.display, textTransform: "uppercase" }}>Time</Text>
                <Text style={{ width: 80, fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.display, textTransform: "uppercase", textAlign: "right" }}>
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
                    <Text style={{ fontVariant: ["tabular-nums"], width: 44, fontSize: 14, color: isBest ? colors.chartBest : colors.mutedForeground, fontFamily: fonts.bold }}>
                      {lap.lapNumber}
                    </Text>
                    <Text style={{ fontVariant: ["tabular-nums"], flex: 1, fontSize: 15, color: isBest ? colors.chartBest : colors.foreground, fontFamily: isBest ? fonts.bold : fonts.medium }}>
                      {fmtLap(lap.lapTimeMs)}
                      {isBest ? "  ★ Best" : ""}
                    </Text>
                    <Text style={{ fontVariant: ["tabular-nums"], width: 80, fontSize: 12, color: isP1 ? colors.primaryText : colors.mutedForeground, fontFamily: isP1 ? fonts.bold : fonts.regular, textAlign: "right" }}>
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
