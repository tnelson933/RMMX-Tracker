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

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function fmtDateShared(iso: string | null | undefined): string {
  if (!iso) return "";
  const normalized = iso.includes("T") ? iso : iso + "T12:00:00";
  return new Date(normalized).toLocaleDateString("en-US", {
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
  bibNumber: string | null;
}

export interface EventHistory {
  eventId: number;
  eventName: string;
  eventDate: string;
  eventEndDate?: string | null;
  eventState: string;
  eventLocation: string | null;
  raceClass: string;
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
      backgroundColor: colors.background,
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
          <Text style={{ fontSize: 20, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", letterSpacing: -0.3 }}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>{subtitle}</Text>
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
  const hasAnyGaps = event.motos.some((m) => (m.lapGaps ?? []).some((g) => g.leader != null));

  const gapMsStr = (ms: number) => `+${(ms / 1000).toFixed(3)}s`;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <SubHeader
        title={event.eventName}
        subtitle={[fmtDateShared(event.eventDate), event.eventLocation ?? event.eventState].filter(Boolean).join("  ·  ")}
        onBack={onBack}
        colors={colors}
        insets={insets}
        rightEl={
          event.bestPosition != null ? (
            <View style={{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, backgroundColor: primary }}>
              <Text style={{ fontSize: 14, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" }}>
                P{event.bestPosition}
              </Text>
            </View>
          ) : undefined
        }
      />

      <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: insets.bottom + 32 }}>
        {/* Class + points summary */}
        <View style={{
          borderRadius: 12, borderWidth: 1, borderColor: colors.border,
          backgroundColor: colors.card, padding: 14,
          flexDirection: "row", alignItems: "center", gap: 12,
        }}>
          <View style={{
            width: 48, height: 48, borderRadius: 24,
            backgroundColor: primary + "18", alignItems: "center", justifyContent: "center",
          }}>
            <Feather name="flag" size={22} color={primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
              {event.raceClass}
            </Text>
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
              {event.motos.length} moto{event.motos.length !== 1 ? "s" : ""}
              {event.totalPoints > 0 ? `  ·  ${event.totalPoints} pts earned` : ""}
            </Text>
          </View>
          {event.bestPosition != null && (
            <View style={{ alignItems: "center" }}>
              <Text style={{ fontSize: 28, fontWeight: "800", color: primary, fontFamily: "Inter_700Bold" }}>
                P{event.bestPosition}
              </Text>
              <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.5 }}>
                Best
              </Text>
            </View>
          )}
        </View>

        {/* Gap mode toggle */}
        {hasAnyGaps && (
          <View style={{
            flexDirection: "row", borderRadius: 10, overflow: "hidden",
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
                    flex: 1, paddingVertical: 9, alignItems: "center",
                    backgroundColor: active ? primary : "transparent",
                  }}
                >
                  <Text style={{
                    fontSize: 12, fontWeight: "700",
                    fontFamily: "Inter_700Bold",
                    color: active ? "#fff" : colors.mutedForeground,
                  }}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}

        {/* Motos */}
        {event.motos.map(moto => {
          const hasTimes = moto.lapTimes.length > 0;
          const lapMsArr = hasTimes ? moto.lapTimes.map(parseLapMs) : [];
          const trueLaps = lapMsArr.slice(1); // lap 1 is a partial lap (gate to line), exclude from best
          const bestMs   = trueLaps.length > 0 ? Math.min(...trueLaps) : Infinity;
          const fastestIdx = bestMs < Infinity ? lapMsArr.findIndex((ms, i) => i > 0 && ms === bestMs) : -1;

          return (
            <View key={moto.motoId} style={{
              borderRadius: 12,
              borderWidth: 1, borderColor: colors.border,
              backgroundColor: colors.card, overflow: "hidden",
            }}>
              {/* Moto header */}
              <View style={{
                flexDirection: "row", alignItems: "center", gap: 10,
                padding: 12,
                borderBottomWidth: 1, borderBottomColor: colors.border,
                backgroundColor: colors.muted + "50",
              }}>
                <View style={{
                  width: 44, height: 44, borderRadius: 10,
                  backgroundColor: primary + "18",
                  alignItems: "center", justifyContent: "center",
                }}>
                  <Text style={{ fontSize: 8, fontWeight: "700", color: primary, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.3 }}>
                    {moto.motoType === "practice" ? "PRAC" : "RACE"}
                  </Text>
                  <Text style={{ fontSize: 15, fontWeight: "800", color: primary, fontFamily: "Inter_700Bold", lineHeight: 17 }}>
                    #{moto.motoNumber}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
                    {moto.motoName}
                  </Text>
                  <View style={{ flexDirection: "row", gap: 10, marginTop: 2 }}>
                    {moto.totalTime ? (
                      <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                        {moto.totalTime}
                      </Text>
                    ) : null}
                    {moto.points != null && moto.points > 0 ? (
                      <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>
                        {moto.points} pts
                      </Text>
                    ) : null}
                  </View>
                </View>
                {moto.dnf || moto.dns ? (
                  <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: colors.muted }}>
                    <Text style={{ fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold" }}>
                      {moto.dnf ? "DNF" : "DNS"}
                    </Text>
                  </View>
                ) : moto.position != null ? (
                  <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: primary }}>
                    <Text style={{ fontSize: 14, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" }}>
                      P{moto.position}
                    </Text>
                  </View>
                ) : null}
              </View>

              {/* Lap table */}
              {hasTimes ? (
                <View>
                  {/* Column headers */}
                  <View style={{ flexDirection: "row", paddingHorizontal: 14, paddingVertical: 7, backgroundColor: colors.muted + "40", borderBottomWidth: 1, borderBottomColor: colors.border }}>
                    <Text style={{ width: 36, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5 }}>Lap</Text>
                    <Text style={{ flex: 1, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5 }}>Time</Text>
                    <Text style={{ width: 68, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5, textAlign: "right" }}>Gap to Leader</Text>
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
                          flexDirection: "row", alignItems: "center",
                          paddingHorizontal: 14, paddingVertical: 10,
                          borderBottomWidth: i < moto.lapTimes.length - 1 ? 1 : 0,
                          borderBottomColor: colors.border,
                          backgroundColor: isFastest ? primary + "0e" : "transparent",
                        }}
                      >
                        <Text style={{ width: 36, fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>
                          {i + 1}
                        </Text>
                        <Text style={{ flex: 1, fontSize: 15, fontWeight: isFastest ? "800" : "400", color: isFastest ? primary : colors.foreground, fontFamily: isFastest ? "Inter_700Bold" : "Inter_400Regular" }}>
                          {t}
                        </Text>
                        <View style={{ width: 68, alignItems: "flex-end", flexDirection: "row", justifyContent: "flex-end", gap: 3 }}>
                          {gapEl?.kind === "best" ? (
                            <>
                              <Feather name="zap" size={11} color={primary} />
                              <Text style={{ fontSize: 10, fontWeight: "700", color: primary, fontFamily: "Inter_700Bold" }}>BEST</Text>
                            </>
                          ) : gapEl?.kind === "leader" ? (
                            <Text style={{ fontSize: 10, fontWeight: "700", color: primary, fontFamily: "Inter_700Bold" }}>LEADER</Text>
                          ) : gapEl?.kind === "text" ? (
                            <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>{gapEl.text}</Text>
                          ) : null}
                        </View>
                      </View>
                    );
                  })}
                </View>
              ) : (
                <View style={{ padding: 14 }}>
                  <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", fontStyle: "italic" }}>
                    No lap times recorded
                  </Text>
                </View>
              )}
            </View>
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
            <Text style={{ fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>
              No race history yet
            </Text>
            <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>
              Your past race results will appear here once events are completed.
            </Text>
          </View>
        ) : (
          events.map(ev => (
            <Pressable
              key={`${ev.eventId}-${ev.raceClass}`}
              onPress={() => onSelectEvent(ev)}
              style={({ pressed }) => ({
                borderRadius: 12, borderWidth: 1, borderColor: colors.border,
                backgroundColor: colors.card, overflow: "hidden",
                opacity: pressed ? 0.75 : 1,
              })}
            >
              {/* Header row */}
              <View style={{ padding: 14, flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: colors.border }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
                    {ev.eventName}
                  </Text>
                  <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                    {[fmtDateShared(ev.eventDate), ev.eventLocation ?? ev.eventState].filter(Boolean).join("  ·  ")}
                  </Text>
                  <View style={{ alignSelf: "flex-start", marginTop: 4, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: primary + "18" }}>
                    <Text style={{ fontSize: 11, fontWeight: "700", color: primary, fontFamily: "Inter_700Bold" }}>{ev.raceClass}</Text>
                  </View>
                </View>
                <View style={{ alignItems: "flex-end", gap: 4 }}>
                  {ev.bestPosition != null && (
                    <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: primary }}>
                      <Text style={{ fontSize: 13, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" }}>P{ev.bestPosition}</Text>
                    </View>
                  )}
                  {ev.totalPoints > 0 && (
                    <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>{ev.totalPoints} pts</Text>
                  )}
                </View>
              </View>
              {/* Moto summary rows */}
              {ev.motos.map(m => (
                <View key={m.motoId} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                  <View style={{ width: 28, height: 28, borderRadius: 6, backgroundColor: primary + "18", alignItems: "center", justifyContent: "center", marginRight: 10 }}>
                    <Text style={{ fontSize: 11, fontWeight: "700", color: primary, fontFamily: "Inter_700Bold" }}>#{m.motoNumber}</Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: 13, color: colors.foreground, fontFamily: "Inter_500Medium" }}>{m.motoName}</Text>
                  {m.totalTime ? (
                    <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginRight: 8 }}>{m.totalTime}</Text>
                  ) : null}
                  {m.dnf || m.dns ? (
                    <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 20, backgroundColor: colors.muted }}>
                      <Text style={{ fontSize: 10, fontWeight: "600", color: colors.mutedForeground, fontFamily: "Inter_600SemiBold" }}>{m.dnf ? "DNF" : "DNS"}</Text>
                    </View>
                  ) : m.position != null ? (
                    <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 20, backgroundColor: primary }}>
                      <Text style={{ fontSize: 11, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" }}>P{m.position}</Text>
                    </View>
                  ) : null}
                </View>
              ))}
              {/* Tap hint */}
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.muted + "30" }}>
                <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>Tap for lap times</Text>
                <Feather name="chevron-right" size={11} color={colors.mutedForeground} />
              </View>
            </Pressable>
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
  const ACCENT = "#cf152d";
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
          <View style={{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, backgroundColor: ACCENT }}>
            <Text style={{ fontSize: 14, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" }}>
              {ordinal(riderPosition)}
            </Text>
          </View>
        }
      />

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={primary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 0, paddingBottom: insets.bottom + 32 }}>
          {/* Section header */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10 }}>
            <Feather name="award" size={13} color={primary} />
            <Text style={{ fontSize: 11, fontWeight: "700", color: primary, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.8 }}>
              {riderClass} — Top 10
            </Text>
          </View>

          {/* Leaderboard card */}
          <View style={{ borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, overflow: "hidden" }}>
            {/* Column headers */}
            <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.muted + "50", borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <Text style={{ width: 34, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5 }}>#</Text>
              <Text style={{ flex: 1, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5 }}>Rider</Text>
              <Text style={{ width: 52, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5, textAlign: "right" }}>Pts</Text>
            </View>

            {top10.length === 0 ? (
              <View style={{ padding: 20, alignItems: "center" }}>
                <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", fontStyle: "italic" }}>No standings yet</Text>
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
                      borderBottomColor: isMe ? ACCENT + "33" : colors.border,
                      backgroundColor: isMe ? ACCENT + "12" : "transparent",
                    }}
                  >
                    <View style={{
                      width: 26, height: 26, borderRadius: 13,
                      backgroundColor: isMe ? ACCENT : (row.position <= 3 ? primary + "18" : colors.muted),
                      alignItems: "center", justifyContent: "center", marginRight: 8,
                    }}>
                      <Text style={{ fontSize: 12, fontWeight: "700", color: isMe ? "#fff" : (row.position <= 3 ? primary : colors.mutedForeground), fontFamily: "Inter_700Bold" }}>
                        {row.position}
                      </Text>
                    </View>
                    <Text style={{ flex: 1, fontSize: 14, fontWeight: isMe ? "700" : "400", color: isMe ? ACCENT : colors.foreground, fontFamily: isMe ? "Inter_700Bold" : "Inter_400Regular" }}>
                      {row.riderName}
                    </Text>
                    <Text style={{ width: 52, fontSize: 14, fontWeight: isMe ? "700" : "500", color: isMe ? ACCENT : colors.foreground, fontFamily: isMe ? "Inter_700Bold" : "Inter_500Medium", textAlign: "right" }}>
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
                <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>· · ·</Text>
                <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
              </View>
              <View style={{ borderRadius: 12, borderWidth: 1.5, borderColor: ACCENT + "44", backgroundColor: ACCENT + "0c", overflow: "hidden" }}>
                <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 13 }}>
                  <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: ACCENT, alignItems: "center", justifyContent: "center", marginRight: 8 }}>
                    <Text style={{ fontSize: 12, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" }}>{myRowBelow.position}</Text>
                  </View>
                  <Text style={{ flex: 1, fontSize: 14, fontWeight: "700", color: ACCENT, fontFamily: "Inter_700Bold" }}>
                    {myRowBelow.riderName}
                  </Text>
                  <Text style={{ width: 52, fontSize: 14, fontWeight: "700", color: ACCENT, fontFamily: "Inter_700Bold", textAlign: "right" }}>
                    {myRowBelow.totalScore}
                  </Text>
                </View>
                <View style={{ paddingHorizontal: 14, paddingBottom: 10 }}>
                  <Text style={{ fontSize: 11, color: ACCENT, fontFamily: "Inter_500Medium" }}>
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
  const ACCENT = "#cf152d";
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
            <Feather name="star" size={24} color={primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textTransform: "uppercase", letterSpacing: 0.5 }}>
              Career Total
            </Text>
            <Text style={{ fontSize: 40, fontWeight: "800", color: primary, fontFamily: "Inter_700Bold", letterSpacing: -1, lineHeight: 46 }}>
              {totalPoints}
            </Text>
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
              pts across {events.length} event{events.length !== 1 ? "s" : ""}
            </Text>
          </View>
        </View>

        {/* Series section */}
        {seriesLoading ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 }}>
            <ActivityIndicator size="small" color={primary} />
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>Loading series…</Text>
          </View>
        ) : seriesList.length > 0 ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <Feather name="trending-up" size={13} color={ACCENT} />
              <Text style={{ fontSize: 11, fontWeight: "700", color: ACCENT, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.8 }}>
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
                  borderRadius: 12, borderWidth: 1.5, borderColor: ACCENT + "33",
                  backgroundColor: colors.card, overflow: "hidden",
                  opacity: pressed ? 0.75 : 1,
                })}
              >
                <View style={{ flexDirection: "row", alignItems: "center", padding: 14, gap: 12 }}>
                  {/* Position badge */}
                  <View style={{
                    width: 52, height: 52, borderRadius: 26,
                    backgroundColor: ACCENT, alignItems: "center", justifyContent: "center",
                  }}>
                    <Text style={{ fontSize: 22, fontWeight: "800", color: "#fff", fontFamily: "Inter_700Bold", lineHeight: 24 }}>
                      {s.position}
                    </Text>
                    <Text style={{ fontSize: 10, fontWeight: "700", color: "rgba(255,255,255,0.8)", fontFamily: "Inter_700Bold", lineHeight: 12, textTransform: "uppercase", letterSpacing: 0.3 }}>
                      {s.position === 1 ? "1st" : s.position === 2 ? "2nd" : s.position === 3 ? "3rd" : `${s.position}th`}
                    </Text>
                  </View>
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
                      {s.seriesName}
                    </Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: ACCENT + "18" }}>
                        <Text style={{ fontSize: 11, fontWeight: "700", color: ACCENT, fontFamily: "Inter_700Bold" }}>{s.raceClass}</Text>
                      </View>
                      <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                        {s.totalPoints} pts
                      </Text>
                    </View>
                  </View>
                  <Feather name="chevron-right" size={16} color={ACCENT} />
                </View>
              </Pressable>
            ))}
          </>
        ) : null}

        {eventsWithPoints.length > 0 && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 }}>
            <Feather name="flag" size={13} color={primary} />
            <Text style={{ fontSize: 11, fontWeight: "700", color: primary, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.8 }}>
              Event Breakdown
            </Text>
          </View>
        )}

        {eventsWithPoints.length === 0 && !seriesLoading && seriesList.length === 0 ? (
          <View style={{ paddingTop: 24, alignItems: "center", gap: 8 }}>
            <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>
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
                  <Text style={{ fontSize: 14, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
                    {ev.eventName}
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>
                    {[fmtDateShared(ev.eventDate), ev.raceClass].filter(Boolean).join("  ·  ")}
                  </Text>
                </View>
                <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: primary + "18" }}>
                  <Text style={{ fontSize: 13, fontWeight: "700", color: primary, fontFamily: "Inter_700Bold" }}>
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
                      <Text style={{ fontSize: 11, fontWeight: "700", color: primary, fontFamily: "Inter_700Bold" }}>#{m.motoNumber}</Text>
                    </View>
                    <Text style={{ flex: 1, fontSize: 13, color: colors.foreground, fontFamily: "Inter_500Medium" }}>{m.motoName}</Text>
                    {m.position != null && (
                      <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginRight: 10 }}>
                        P{m.position}
                      </Text>
                    )}
                    <Text style={{ fontSize: 14, fontWeight: "700", color: primary, fontFamily: "Inter_700Bold" }}>
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
