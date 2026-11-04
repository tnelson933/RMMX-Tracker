import { TeamLaps, type TeamBreakdown } from "@/components/TeamLaps";
import { Feather } from "@expo/vector-icons";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BrandBar } from "@/components/BrandBar";
import { useColors } from "@/hooks/useColors";
import { displayDate } from "@/lib/format";
import { ResultCard, ResultHero } from "@/components/RaceCards";
import { PositionBadge } from "@/components/RaceStats";
import { MotoChips, MotoReport, RaceReportHero } from "@/components/RaceReport";

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function fmtDateShared(iso: string | null | undefined): string {
  if (!iso) return "";
  return displayDate(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

export function fmtLap(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "—";
  const totalSec = ms / 1000;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0
    ? `${mins}:${secs.toFixed(3).padStart(6, "0")}`
    : `${secs.toFixed(3)}s`;
}

export function parseLapMs(s: string): number {
  if (!s) return Infinity;
  const c = s.indexOf(":");
  if (c >= 0) {
    const mins = parseInt(s.slice(0, c), 10);
    const secs = parseFloat(s.slice(c + 1).replace("s", ""));
    return (mins * 60 + secs) * 1000;
  }
  return parseFloat(s.replace("s", "")) * 1000;
}

export function lapDeltaStr(ms: number, bestMs: number): string {
  if (ms <= bestMs) return "";
  const diff = (ms - bestMs) / 1000;
  return `+${diff.toFixed(3)}s`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MotoResult {
  motoId: number;
  motoName: string;
  motoNumber: number;
  motoType: string;
  position: number | null;
  points: number | null;
  dnf: boolean;
  dns: boolean;
  totalTime: string | null;
  lapTimes: string[];
  lapGaps?: Array<{ leader: number | null; ahead: number | null }>;
  /** Running position at the end of each lap (1 = leading). */
  positionByLap?: Array<number | null>;
  /** Riders who started this moto. */
  fieldSize?: number;
  bibNumber: string | null;
  /** Group races: each team rider's own laps. */
  team?: TeamBreakdown | null;
  /** Split (sector) times per lap, when the course had split readers. */
  sectors?: {
    names: string[];
    laps: Array<{ lapNumber: number; sectorsMs: Array<number | null> }>;
    bestMs: Array<number | null>;
    fieldBestMs: Array<number | null>;
  } | null;
}

/** Split time: "28.41" or "1:02.37". */
function fmtSplit(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const cs = Math.round(ms / 10);
  const minutes = Math.floor(cs / 6000);
  const seconds = ((cs % 6000) / 100).toFixed(2);
  return minutes > 0 ? `${minutes}:${seconds.padStart(5, "0")}` : seconds;
}

/** Purple: fastest in the race. Green: the rider's own best. */
const SPLIT_FASTEST = "#c026d3";
const SPLIT_PERSONAL_BEST = "#16a34a";

export interface EventHistory {
  eventId: number;
  eventName: string;
  eventDate: string;
  eventEndDate?: string | null;
  eventState: string;
  eventLocation: string | null;
  /** Organizer's event image ("/api/storage/..." path). */
  eventImageUrl?: string | null;
  raceClass: string;
  raceStyle?: string | null;
  motos: MotoResult[];
  bestPosition: number | null;
  totalPoints: number;
  riderName?: string;
}

export interface RiderSeriesEntry {
  seriesId: number;
  seriesName: string;
  raceClass: string;
  totalPoints: number;
  position: number;
}

export interface PublicSeriesStandingRow {
  position: number;
  riderId: number;
  riderName: string;
  raceClass: string;
  totalScore: number;
  eventsEntered: number;
}

export type ViewState =
  | { type: "events" }
  | { type: "event_detail"; event: EventHistory }
  | { type: "points" }
  | { type: "series_standings"; seriesId: number; seriesName: string; riderClass: string; riderPosition: number; riderPoints: number; riderIds: number[] };

// ─── Sub-screen: Sub-header ───────────────────────────────────────────────────

export function SubHeader({
  title,
  subtitle,
  onBack,
  colors,
  insets,
  rightEl,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  colors: ReturnType<typeof useColors>;
  insets: ReturnType<typeof useSafeAreaInsets>;
  rightEl?: React.ReactNode;
}) {
  return (
    <View style={{
      paddingTop: insets.top + 4,
      paddingHorizontal: 16, paddingBottom: 12,
      backgroundColor: colors.card,
      borderBottomWidth: 1, borderBottomColor: colors.border,
    }}>
      <BrandBar />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
        <Pressable
          onPress={onBack}
          hitSlop={12}
          style={({ pressed }) => ({
            width: 36, height: 36, borderRadius: 18,
            backgroundColor: colors.muted,
            alignItems: "center", justifyContent: "center",
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 20, fontWeight: "800", color: colors.foreground, fontFamily: "Roboto_700Bold", letterSpacing: -0.3 }}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 1 }}>{subtitle}</Text>
          ) : null}
        </View>
        {rightEl}
      </View>
    </View>
  );
}

// ─── Sub-screen: Event Detail ─────────────────────────────────────────────────

export function EventDetailScreen({
  event,
  onBack,
  colors,
  insets,
}: {
  event: EventHistory;
  onBack: () => void;
  colors: ReturnType<typeof useColors>;
  insets: ReturnType<typeof useSafeAreaInsets>;
}) {
  const primary = colors.primary;
  const [gapMode, setGapMode] = useState<"best" | "leader" | "ahead">("best");
  const [motoIdx, setMotoIdx] = useState(0);
  const bestMoto = event.motos.find(m => !m.dnf && !m.dns && m.position === event.bestPosition);
  const hasAnyGaps = event.motos.some((m) => (m.lapGaps ?? []).some((g) => g.leader != null));

  const gapMsStr = (ms: number) => `+${(ms / 1000).toFixed(3)}s`;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <SubHeader
        title="Race Report"
        onBack={onBack}
        colors={colors}
        insets={insets}
      />

      <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: insets.bottom + 32 }}>
        {/* Result hero */}
        <RaceReportHero
          imageUrl={event.eventImageUrl}
          eventName={event.eventName}
          dateIso={event.eventDate}
          place={event.eventLocation ?? event.eventState}
          raceClass={event.raceClass}
          riderName={event.riderName}
          position={event.bestPosition}
          fieldSize={bestMoto?.fieldSize}
          motoCount={event.motos.length}
          points={event.totalPoints}
        />

        <MotoChips motos={event.motos} selected={Math.min(motoIdx, event.motos.length - 1)} onSelect={setMotoIdx} />

        {/* Motos: charts first, the lap table behind "All laps and splits" */}
        {event.motos.filter((_, mi) => mi === Math.min(motoIdx, event.motos.length - 1)).map(moto => {
          const hasTimes = moto.lapTimes.length > 0;
          const lapMsArr = hasTimes ? moto.lapTimes.map(parseLapMs) : [];
          const trueLaps = event.raceStyle === "motocross" ? lapMsArr.slice(1) : lapMsArr;
          const bestMs   = trueLaps.length > 0 ? Math.min(...trueLaps) : Infinity;
          const fastestIdx = bestMs < Infinity
            ? lapMsArr.findIndex((ms, i) => (event.raceStyle !== "motocross" || i > 0) && ms === bestMs)
            : -1;

          return (
            <MotoReport key={moto.motoId} moto={moto} raceStyle={event.raceStyle}>
        {/* Gap mode toggle */}
        {hasAnyGaps && hasTimes && (
          <View style={{
            flexDirection: "row", borderRadius: 999, overflow: "hidden", padding: 4, margin: 12,
            borderWidth: 1, borderColor: colors.border, backgroundColor: colors.muted,
          }}>
            {([
              { key: "best", label: "vs Best Lap" },
              { key: "leader", label: "vs Leader" },
              { key: "ahead", label: "vs Ahead" },
            ] as const).map((opt) => {
              const active = gapMode === opt.key;
              return (
                <Pressable
                  key={opt.key}
                  onPress={() => setGapMode(opt.key)}
                  style={{
                    flex: 1, paddingVertical: 9, alignItems: "center", borderRadius: 999,
                    backgroundColor: active ? primary : "transparent",
                  }}
                >
                  <Text style={{
                    fontSize: 12, fontWeight: "700",
                    fontFamily: "Roboto_700Bold",
                    color: active ? "#fff" : colors.mutedForeground,
                  }}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}

            <View style={{ overflow: "hidden" }}>
              {/* Moto header */}
              <View style={{
                flexDirection: "row", alignItems: "center", gap: 10,
                padding: 12,
                borderBottomWidth: 1, borderBottomColor: colors.border,
                backgroundColor: colors.muted + "50",
              }}>
                <View style={{
                  width: 46, height: 46, borderRadius: 12,
                  backgroundColor: colors.foreground,
                  alignItems: "center", justifyContent: "center",
                }}>
                  <Text style={{ fontSize: 10, fontWeight: "700", color: colors.background, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.8 }}>
                    {moto.motoType === "practice" ? "PRAC" : "RACE"}
                  </Text>
                  <Text style={{ fontSize: 17, fontWeight: "800", color: colors.background, fontFamily: "Barlow_800ExtraBold_Italic", lineHeight: 19 }}>
                    #{moto.motoNumber}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "700", color: colors.foreground, fontFamily: "Roboto_700Bold" }}>
                    {moto.motoName}
                  </Text>
                  <View style={{ flexDirection: "row", gap: 10, marginTop: 2 }}>
                    {moto.totalTime ? (
                      <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>
                        {moto.totalTime}
                      </Text>
                    ) : null}
                    {moto.points != null && moto.points > 0 ? (
                      <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_500Medium" }}>
                        {moto.points} pts
                      </Text>
                    ) : null}
                  </View>
                </View>
                <PositionBadge position={moto.position} dnf={moto.dnf} dns={moto.dns} />
              </View>

              {moto.team ? <TeamLaps team={moto.team} /> : null}
              {/* Lap table */}
              {hasTimes ? (
                <View>
                  {/* Column headers */}
                  <View style={{ flexDirection: "row", paddingHorizontal: 14, paddingVertical: 7, backgroundColor: colors.muted + "40", borderBottomWidth: 1, borderBottomColor: colors.border }}>
                    <Text style={{ width: 36, fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.5 }}>Lap</Text>
                    <Text style={{ flex: 1, fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.5 }}>Time</Text>
                    <Text style={{ width: 68, fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.5, textAlign: "right" }}>Gap to Leader</Text>
                  </View>
                  {moto.lapTimes.map((t, i) => {
                    const isFastest = i === fastestIdx;
                    const gap = moto.lapGaps?.[i];
                    // What to show in the Gap column for this lap, per mode
                    let gapEl: { kind: "best" } | { kind: "leader" } | { kind: "text"; text: string } | null = null;
                    if (gapMode === "best") {
                      if (isFastest) {
                        gapEl = { kind: "best" };
                      } else if (gap?.leader != null) {
                        gapEl = { kind: "text", text: gapMsStr(gap.leader) };
                      } else {
                        gapEl = null;
                      }
                    } else if (gap == null || gap.leader == null) {
                      gapEl = { kind: "text", text: "—" };
                    } else if (gap.leader === 0) {
                      gapEl = { kind: "leader" };
                    } else if (gapMode === "leader") {
                      gapEl = { kind: "text", text: gapMsStr(gap.leader) };
                    } else {
                      gapEl = gap.ahead != null ? { kind: "text", text: gapMsStr(gap.ahead) } : { kind: "text", text: "—" };
                    }
                    return (
                      <View
                        key={i}
                        style={{
                          paddingHorizontal: 14, paddingVertical: 10,
                          borderBottomWidth: i < moto.lapTimes.length - 1 ? 1 : 0,
                          borderBottomColor: colors.border,
                          backgroundColor: isFastest ? primary + "0e" : "transparent",
                        }}
                      >
                        <View style={{ flexDirection: "row", alignItems: "center" }}>
                        <Text style={{ width: 36, fontSize: 13, color: colors.mutedForeground, fontFamily: "Roboto_500Medium" }}>
                          {i + 1}
                        </Text>
                        <Text style={{ flex: 1, fontSize: 15, fontWeight: isFastest ? "800" : "400", color: isFastest ? colors.primaryText : colors.foreground, fontFamily: isFastest ? "Roboto_700Bold" : "Roboto_400Regular" }}>
                          {t}
                        </Text>
                        <View style={{ width: 68, alignItems: "flex-end", flexDirection: "row", justifyContent: "flex-end", gap: 3 }}>
                          {gapEl?.kind === "best" ? (
                            <>
                              <Feather name="zap" size={11} color={colors.primaryText} />
                              <Text style={{ fontSize: 10, fontWeight: "700", color: colors.primaryText, fontFamily: "Roboto_700Bold" }}>BEST</Text>
                            </>
                          ) : gapEl?.kind === "leader" ? (
                            <Text style={{ fontSize: 10, fontWeight: "700", color: colors.primaryText, fontFamily: "Roboto_700Bold" }}>LEADER</Text>
                          ) : gapEl?.kind === "text" ? (
                            <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>{gapEl.text}</Text>
                          ) : null}
                        </View>
                        </View>
                        {(() => {
                          // This lap's split times, under the lap (purple = fastest in the race, green = rider's best).
                          const lap = moto.sectors?.laps.find((l) => l.lapNumber === i + 1);
                          if (!moto.sectors || !lap) return null;
                          return (
                            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 4, marginLeft: 36 }}>
                              {lap.sectorsMs.map((ms, s) => {
                                const fastest = ms != null && moto.sectors!.fieldBestMs[s] != null && ms <= moto.sectors!.fieldBestMs[s]!;
                                const personal = ms != null && moto.sectors!.bestMs[s] != null && ms <= moto.sectors!.bestMs[s]!;
                                return (
                                  <Text key={s} style={{ fontSize: 11, fontFamily: fastest || personal ? "Roboto_700Bold" : "Roboto_400Regular", color: fastest ? SPLIT_FASTEST : personal ? SPLIT_PERSONAL_BEST : colors.mutedForeground }}>
                                    S{s + 1} {fmtSplit(ms)}
                                  </Text>
                                );
                              })}
                            </View>
                          );
                        })()}
                      </View>
                    );
                  })}
                  {moto.sectors && (
                    <View style={{ paddingHorizontal: 14, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
                      {moto.sectors.names.map((name, s) => (
                        <Text key={s} style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>S{s + 1}: {name}</Text>
                      ))}
                      <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 2 }}>
                        <Text style={{ color: SPLIT_FASTEST, fontFamily: "Roboto_700Bold" }}>Purple</Text> fastest in the race · <Text style={{ color: SPLIT_PERSONAL_BEST, fontFamily: "Roboto_700Bold" }}>Green</Text> your best
                      </Text>
                    </View>
                  )}
                </View>
              ) : (
                <View style={{ padding: 14 }}>
                  <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", fontStyle: "italic" }}>
                    No lap times recorded
                  </Text>
                </View>
              )}
            </View>
            </MotoReport>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ─── Sub-screen: Events List ──────────────────────────────────────────────────

export function EventsListScreen({
  events,
  onSelectEvent,
  onBack,
  colors,
  insets,
}: {
  events: EventHistory[];
  onSelectEvent: (e: EventHistory) => void;
  onBack: () => void;
  colors: ReturnType<typeof useColors>;
  insets: ReturnType<typeof useSafeAreaInsets>;
}) {
  const primary = colors.primary;
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <SubHeader
        title="Events"
        subtitle={`${events.length} event${events.length !== 1 ? "s" : ""} raced`}
        onBack={onBack}
        colors={colors}
        insets={insets}
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: insets.bottom + 32 }}>
        {events.length === 0 ? (
          <View style={{ paddingTop: 48, alignItems: "center", gap: 10 }}>
            <Feather name="award" size={40} color={colors.mutedForeground + "60"} />
            <Text style={{ fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Roboto_700Bold", textAlign: "center" }}>
              No race history yet
            </Text>
            <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", textAlign: "center", lineHeight: 20 }}>
              Your past race results will appear here once events are completed.
            </Text>
          </View>
        ) : (
          events.map(ev => (
            <View key={`${ev.eventId}-${ev.raceClass}`} style={{ marginHorizontal: -16 }}>
              <ResultCard
                position={ev.bestPosition}
                title={ev.eventName}
                dateIso={ev.eventDate}
                raceClass={ev.raceClass}
                place={ev.eventLocation ?? ev.eventState}
                points={ev.totalPoints}
                onPress={() => onSelectEvent(ev)}
                footer={
                  <>
                    {ev.motos.map(m => (
                      <View key={m.motoId} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
                        <View style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: colors.foreground, alignItems: "center", justifyContent: "center", marginRight: 10 }}>
                          <Text style={{ fontSize: 11, color: colors.background, fontFamily: "Barlow_800ExtraBold_Italic" }}>#{m.motoNumber}</Text>
                        </View>
                        <Text style={{ flex: 1, fontSize: 13, color: colors.foreground, fontFamily: "Roboto_500Medium" }}>{m.motoName}</Text>
                        {m.totalTime ? (
                          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginRight: 8 }}>{m.totalTime}</Text>
                        ) : null}
                        <PositionBadge position={m.position} dnf={m.dnf} dns={m.dns} size="sm" />
                      </View>
                    ))}
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, paddingHorizontal: 16, paddingVertical: 9, borderTopWidth: 1, borderTopColor: colors.border }}>
                      <Feather name="clock" size={11} color={colors.primaryText} />
                      <Text style={{ fontSize: 11, color: colors.foreground, fontFamily: "Roboto_600SemiBold" }}>Lap times</Text>
                      <Feather name="chevron-right" size={12} color={colors.mutedForeground} />
                    </View>
                  </>
                }
              />
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ─── Sub-screen: Series Standings ─────────────────────────────────────────────

export function SeriesStandingsScreen({
  seriesId,
  seriesName,
  riderClass,
  riderPosition,
  riderPoints,
  riderIds,
  onBack,
  colors,
  insets,
  riderFetch,
}: {
  seriesId: number;
  seriesName: string;
  riderClass: string;
  riderPosition: number;
  riderPoints: number;
  riderIds: number[];
  onBack: () => void;
  colors: ReturnType<typeof useColors>;
  insets: ReturnType<typeof useSafeAreaInsets>;
  riderFetch: (path: string, options?: RequestInit) => Promise<Response>;
}) {
  const primary = colors.primary;
  const [rows, setRows] = useState<PublicSeriesStandingRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    riderFetch(`/api/public/series/${seriesId}/standings`)
      .then(r => r.json())
      .then((data: PublicSeriesStandingRow[]) => {
        if (cancelled) return;
        const forClass = (data ?? []).filter(r => r.raceClass === riderClass);
        forClass.sort((a, b) => a.position - b.position);
        setRows(forClass);
      })
      .catch(() => { if (!cancelled) setRows([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [seriesId, riderClass]);

  const top10 = rows.slice(0, 10);
  const myRowInTop10 = top10.find(r => riderIds.includes(r.riderId));
  const myRowBelow = !myRowInTop10 && rows.find(r => riderIds.includes(r.riderId));

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <SubHeader
        title={seriesName}
        subtitle={`You are ${ordinal(riderPosition)} in ${riderClass}`}
        onBack={onBack}
        colors={colors}
        insets={insets}
        rightEl={
          <View style={{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, backgroundColor: colors.primary }}>
            <Text style={{ fontSize: 14, fontWeight: "700", color: "#fff", fontFamily: "Roboto_700Bold" }}>
              {ordinal(riderPosition)}
            </Text>
          </View>
        }
      />

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.primaryText} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 0, paddingBottom: insets.bottom + 32 }}>
          {/* Section header */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10 }}>
            <Feather name="award" size={13} color={colors.primaryText} />
            <Text style={{ fontSize: 13, fontWeight: "700", color: colors.primaryText, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.8 }}>
              {riderClass} — Top 10
            </Text>
          </View>

          {/* Leaderboard card */}
          <View style={{ borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, overflow: "hidden" }}>
            {/* Column headers */}
            <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.muted + "50", borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <Text style={{ width: 34, fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.5 }}>#</Text>
              <Text style={{ flex: 1, fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.5 }}>Rider</Text>
              <Text style={{ width: 52, fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.5, textAlign: "right" }}>Pts</Text>
            </View>

            {top10.length === 0 ? (
              <View style={{ padding: 20, alignItems: "center" }}>
                <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", fontStyle: "italic" }}>No standings yet</Text>
              </View>
            ) : (
              top10.map((row, idx) => {
                const isMe = riderIds.includes(row.riderId);
                return (
                  <View
                    key={row.riderId}
                    style={{
                      flexDirection: "row", alignItems: "center",
                      paddingHorizontal: 14, paddingVertical: 13,
                      borderBottomWidth: idx < top10.length - 1 ? 1 : 0,
                      borderBottomColor: isMe ? colors.primary + "33" : colors.border,
                      backgroundColor: isMe ? colors.primary + "12" : "transparent",
                    }}
                  >
                    <View style={{
                      width: 26, height: 26, borderRadius: 13,
                      backgroundColor: isMe ? colors.primary : (row.position <= 3 ? primary + "18" : colors.muted),
                      alignItems: "center", justifyContent: "center", marginRight: 8,
                    }}>
                      <Text style={{ fontSize: 12, fontWeight: "700", color: isMe ? "#fff" : (row.position <= 3 ? colors.primaryText : colors.mutedForeground), fontFamily: "Roboto_700Bold" }}>
                        {row.position}
                      </Text>
                    </View>
                    <Text style={{ flex: 1, fontSize: 14, fontWeight: isMe ? "700" : "400", color: isMe ? colors.primaryText : colors.foreground, fontFamily: isMe ? "Roboto_700Bold" : "Roboto_400Regular" }}>
                      {row.riderName}
                    </Text>
                    <Text style={{ width: 52, fontSize: 14, fontWeight: isMe ? "700" : "500", color: isMe ? colors.primaryText : colors.foreground, fontFamily: isMe ? "Roboto_700Bold" : "Roboto_500Medium", textAlign: "right" }}>
                      {row.totalScore}
                    </Text>
                  </View>
                );
              })
            )}
          </View>

          {/* Rider's row outside top 10 */}
          {myRowBelow && (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10 }}>
                <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
                <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>· · ·</Text>
                <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
              </View>
              <View style={{ borderRadius: 12, borderWidth: 1.5, borderColor: colors.primary + "44", backgroundColor: colors.primary + "0c", overflow: "hidden" }}>
                <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 13 }}>
                  <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", marginRight: 8 }}>
                    <Text style={{ fontSize: 12, fontWeight: "700", color: "#fff", fontFamily: "Roboto_700Bold" }}>{myRowBelow.position}</Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: 14, fontWeight: "700", color: colors.primaryText, fontFamily: "Roboto_700Bold" }}>
                    {myRowBelow.riderName}
                  </Text>
                  <Text style={{ width: 52, fontSize: 14, fontWeight: "700", color: colors.primaryText, fontFamily: "Roboto_700Bold", textAlign: "right" }}>
                    {myRowBelow.totalScore}
                  </Text>
                </View>
                <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
                  <Text style={{ fontSize: 11, color: colors.primaryText, fontFamily: "Roboto_500Medium" }}>
                    Your position · {ordinal(riderPosition)} place
                  </Text>
                </View>
              </View>
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

// ─── Sub-screen: Points ───────────────────────────────────────────────────────

export function PointsScreen({
  events,
  totalPoints,
  onBack,
  pushView,
  riderFetch,
  riderIds,
  colors,
  insets,
}: {
  events: EventHistory[];
  totalPoints: number;
  onBack: () => void;
  pushView: (v: ViewState) => void;
  riderFetch: (path: string, options?: RequestInit) => Promise<Response>;
  riderIds: number[];
  colors: ReturnType<typeof useColors>;
  insets: ReturnType<typeof useSafeAreaInsets>;
}) {
  const primary = colors.primary;
  const eventsWithPoints = events.filter(e => e.totalPoints > 0 || e.motos.some(m => (m.points ?? 0) > 0));

  const [seriesList, setSeriesList] = useState<RiderSeriesEntry[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setSeriesLoading(true);
    riderFetch("/api/rider/series")
      .then(r => r.json())
      .then((data: RiderSeriesEntry[]) => { if (!cancelled) setSeriesList(data ?? []); })
      .catch(() => { if (!cancelled) setSeriesList([]); })
      .finally(() => { if (!cancelled) setSeriesLoading(false); });
    return () => { cancelled = true; };
  }, [riderIds.join(",")]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <SubHeader
        title="Points"
        subtitle="Career points breakdown"
        onBack={onBack}
        colors={colors}
        insets={insets}
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: insets.bottom + 32 }}>
        {/* Career total card */}
        <View style={{
          borderRadius: 14, borderWidth: 1.5, borderColor: primary + "44",
          backgroundColor: colors.card, padding: 20,
          flexDirection: "row", alignItems: "center", gap: 16,
        }}>
          <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: primary + "18", alignItems: "center", justifyContent: "center" }}>
            <Feather name="star" size={24} color={colors.primaryText} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", textTransform: "uppercase", letterSpacing: 0.5 }}>
              Career Total
            </Text>
            <Text style={{ fontSize: 40, fontWeight: "800", color: colors.primaryText, fontFamily: "Roboto_700Bold", letterSpacing: -1, lineHeight: 46 }}>
              {totalPoints}
            </Text>
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>
              pts across {events.length} event{events.length !== 1 ? "s" : ""}
            </Text>
          </View>
        </View>

        {/* Series section */}
        {seriesLoading ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 }}>
            <ActivityIndicator size="small" color={colors.primaryText} />
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>Loading series…</Text>
          </View>
        ) : seriesList.length > 0 ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <Feather name="trending-up" size={13} color={colors.primaryText} />
              <Text style={{ fontSize: 13, fontWeight: "700", color: colors.primaryText, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.8 }}>
                Series Standings
              </Text>
            </View>
            {seriesList.map(s => (
              <Pressable
                key={`${s.seriesId}:${s.raceClass}`}
                onPress={() => pushView({
                  type: "series_standings",
                  seriesId: s.seriesId,
                  seriesName: s.seriesName,
                  riderClass: s.raceClass,
                  riderPosition: s.position,
                  riderPoints: s.totalPoints,
                  riderIds,
                })}
                style={({ pressed }) => ({
                  borderRadius: 12, borderWidth: 1.5, borderColor: colors.primary + "33",
                  backgroundColor: colors.card, overflow: "hidden",
                  opacity: pressed ? 0.75 : 1,
                })}
              >
                <View style={{ flexDirection: "row", alignItems: "center", padding: 14, gap: 12 }}>
                  {/* Position badge */}
                  <View style={{
                    width: 52, height: 52, borderRadius: 26,
                    backgroundColor: colors.primary, alignItems: "center", justifyContent: "center",
                  }}>
                    <Text style={{ fontSize: 22, fontWeight: "800", color: "#fff", fontFamily: "Roboto_700Bold", lineHeight: 24 }}>
                      {s.position}
                    </Text>
                    <Text style={{ fontSize: 12, fontWeight: "700", color: "rgba(255,255,255,0.8)", fontFamily: "Barlow_700Bold", lineHeight: 12, textTransform: "uppercase", letterSpacing: 0.3 }}>
                      {s.position === 1 ? "1st" : s.position === 2 ? "2nd" : s.position === 3 ? "3rd" : `${s.position}th`}
                    </Text>
                  </View>
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Roboto_700Bold" }}>
                      {s.seriesName}
                    </Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.primary + "18" }}>
                        <Text style={{ fontSize: 11, fontWeight: "700", color: colors.primaryText, fontFamily: "Roboto_700Bold" }}>{s.raceClass}</Text>
                      </View>
                      <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>
                        {s.totalPoints} pts
                      </Text>
                    </View>
                  </View>
                  <Feather name="chevron-right" size={16} color={colors.primaryText} />
                </View>
              </Pressable>
            ))}
          </>
        ) : null}

        {eventsWithPoints.length > 0 && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 }}>
            <Feather name="flag" size={13} color={colors.primaryText} />
            <Text style={{ fontSize: 13, fontWeight: "700", color: colors.primaryText, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 0.8 }}>
              Event Breakdown
            </Text>
          </View>
        )}

        {eventsWithPoints.length === 0 && !seriesLoading && seriesList.length === 0 ? (
          <View style={{ paddingTop: 24, alignItems: "center", gap: 8 }}>
            <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", textAlign: "center" }}>
              No points recorded yet.
            </Text>
          </View>
        ) : (
          eventsWithPoints.map(ev => (
            <View key={`${ev.eventId}-${ev.raceClass}`} style={{
              borderRadius: 12, borderWidth: 1, borderColor: colors.border,
              backgroundColor: colors.card, overflow: "hidden",
            }}>
              {/* Event header */}
              <View style={{
                flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                padding: 12,
                borderBottomWidth: 1, borderBottomColor: colors.border,
                backgroundColor: colors.muted + "50",
              }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "700", color: colors.foreground, fontFamily: "Roboto_700Bold" }}>
                    {ev.eventName}
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 1 }}>
                    {[fmtDateShared(ev.eventDate), ev.raceClass].filter(Boolean).join("  ·  ")}
                  </Text>
                </View>
                <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: primary + "18" }}>
                  <Text style={{ fontSize: 13, fontWeight: "700", color: colors.primaryText, fontFamily: "Roboto_700Bold" }}>
                    {ev.totalPoints} pts
                  </Text>
                </View>
              </View>

              {/* Per-moto points */}
              {ev.motos
                .filter(m => (m.points ?? 0) > 0)
                .map((m, i, arr) => (
                  <View key={m.motoId} style={{
                    flexDirection: "row", alignItems: "center",
                    paddingHorizontal: 14, paddingVertical: 10,
                    borderBottomWidth: i < arr.length - 1 ? 1 : 0,
                    borderBottomColor: colors.border,
                  }}>
                    <View style={{ width: 28, height: 28, borderRadius: 6, backgroundColor: primary + "18", alignItems: "center", justifyContent: "center", marginRight: 10 }}>
                      <Text style={{ fontSize: 11, fontWeight: "700", color: colors.primaryText, fontFamily: "Roboto_700Bold" }}>#{m.motoNumber}</Text>
                    </View>
                    <Text style={{ flex: 1, fontSize: 13, color: colors.foreground, fontFamily: "Roboto_500Medium" }}>{m.motoName}</Text>
                    {m.position != null && (
                      <View style={{ marginRight: 10 }}><PositionBadge position={m.position} size="sm" /></View>
                    )}
                    <Text style={{ fontSize: 14, fontWeight: "700", color: colors.primaryText, fontFamily: "Roboto_700Bold" }}>
                      +{m.points} pts
                    </Text>
                  </View>
                ))
              }
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
