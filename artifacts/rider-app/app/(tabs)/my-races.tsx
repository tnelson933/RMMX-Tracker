import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as Location from "expo-location";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";
import { BrandBar } from "@/components/BrandBar";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtLap(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "—";
  const totalSec = ms / 1000;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0
    ? `${mins}:${secs.toFixed(3).padStart(6, "0")}`
    : `${secs.toFixed(3)}s`;
}

function parseLapMs(s: string): number {
  if (!s) return Infinity;
  const c = s.indexOf(":");
  if (c >= 0) {
    const mins = parseInt(s.slice(0, c), 10);
    const secs = parseFloat(s.slice(c + 1).replace("s", ""));
    return (mins * 60 + secs) * 1000;
  }
  return parseFloat(s.replace("s", "")) * 1000;
}

function lapDeltaStr(ms: number, bestMs: number): string {
  if (ms <= bestMs) return "";
  const diff = (ms - bestMs) / 1000;
  return `+${diff.toFixed(3)}s`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface FamilyGate      { gate: number; riderId: number; riderName: string }
interface LineupEntry     { gate: number; riderId: number; riderName: string; bibNumber: string | null; isFamilyMember: boolean }
interface PracticeLap     { riderId: number; lapNumber: number; lapTimeMs: number | null }
interface PracticeLeaderEntry { rank: number; riderId: number | null; riderName: string; bestLapMs: number; isMe: boolean }

interface ScheduleMoto {
  motoId: number;
  motoNumber: number;
  name: string;
  type: string;
  raceClass: string | null;
  status: string;
  lapCount: number | null;
  scheduledTime: string | null;
  startedAt: string | null;
  completedAt: string | null;
  isAnyFamilyMemberInMoto: boolean;
  familyGates: FamilyGate[];
  lineup: LineupEntry[];
  practiceLaps?: PracticeLap[];
  practiceLeaderboard?: PracticeLeaderEntry[];
}

interface ScheduleEvent {
  eventId: number;
  eventName: string;
  eventDate: string | null;
  eventState: string | null;
  eventLocation: string | null;
  status: string;
  registrations: { riderId: number; riderName: string; raceClass: string | null }[];
  motos: ScheduleMoto[];
}

interface MotoResult {
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
  bibNumber: string | null;
}

interface EventHistory {
  eventId: number;
  eventName: string;
  eventDate: string;
  eventState: string;
  eventLocation: string | null;
  raceClass: string;
  motos: MotoResult[];
  bestPosition: number | null;
  totalPoints: number;
  riderName?: string; // set in multi-profile mode
}

type FilterTab = "today" | "upcoming" | "near_me" | "history";

const FILTER_TABS: { key: FilterTab; label: string; icon: string }[] = [
  { key: "today",    label: "Today",    icon: "zap"      },
  { key: "upcoming", label: "Upcoming", icon: "calendar" },
  { key: "near_me",  label: "Near Me",  icon: "map-pin"  },
  { key: "history",  label: "History",  icon: "award"    },
];

// ─── View stack ───────────────────────────────────────────────────────────────

type ViewState =
  | { type: "events" }
  | { type: "event_detail"; event: EventHistory }
  | { type: "points" };

// ─── Sub-screen: Sub-header ───────────────────────────────────────────────────

function SubHeader({
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

function EventDetailScreen({
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

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <SubHeader
        title={event.eventName}
        subtitle={[fmtDate(event.eventDate), event.eventLocation ?? event.eventState].filter(Boolean).join("  ·  ")}
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

        {/* Motos */}
        {event.motos.map(moto => {
          const hasTimes = moto.lapTimes.length > 0;
          const lapMsArr = hasTimes ? moto.lapTimes.map(parseLapMs) : [];
          const bestMs   = hasTimes ? Math.min(...lapMsArr) : Infinity;
          const fastestIdx = hasTimes ? lapMsArr.indexOf(bestMs) : -1;

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
                    <Text style={{ width: 68, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5, textAlign: "right" }}>Gap</Text>
                  </View>
                  {moto.lapTimes.map((t, i) => {
                    const isFastest = i === fastestIdx;
                    const delta = isFastest ? "" : lapDeltaStr(lapMsArr[i], bestMs);
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
                          {isFastest ? (
                            <>
                              <Feather name="zap" size={11} color={primary} />
                              <Text style={{ fontSize: 10, fontWeight: "700", color: primary, fontFamily: "Inter_700Bold" }}>BEST</Text>
                            </>
                          ) : delta ? (
                            <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>{delta}</Text>
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

function EventsListScreen({
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
                    {[fmtDate(ev.eventDate), ev.eventLocation ?? ev.eventState].filter(Boolean).join("  ·  ")}
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

// ─── Sub-screen: Points ───────────────────────────────────────────────────────

function PointsScreen({
  events,
  totalPoints,
  onBack,
  colors,
  insets,
}: {
  events: EventHistory[];
  totalPoints: number;
  onBack: () => void;
  colors: ReturnType<typeof useColors>;
  insets: ReturnType<typeof useSafeAreaInsets>;
}) {
  const primary = colors.primary;
  const eventsWithPoints = events.filter(e => e.totalPoints > 0 || e.motos.some(m => (m.points ?? 0) > 0));

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

        {eventsWithPoints.length === 0 ? (
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
                    {[fmtDate(ev.eventDate), ev.raceClass].filter(Boolean).join("  ·  ")}
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

// ─── Shared chip helpers ──────────────────────────────────────────────────────

function chipFor(status: string): { label: string; color: string } {
  const map: Record<string, { label: string; color: string }> = {
    in_progress: { label: "LIVE",     color: "#ef4444" },
    completed:   { label: "DONE",     color: "#22c55e" },
    scheduled:   { label: "UPCOMING", color: "#6b7280" },
  };
  return map[status] ?? { label: status.toUpperCase(), color: "#6b7280" };
}

// ─── Schedule moto card ───────────────────────────────────────────────────────

function ScheduleMotoCard({ moto, colors }: { moto: ScheduleMoto; colors: ReturnType<typeof useColors> }) {
  const mine   = moto.isAnyFamilyMemberInMoto;
  const live   = moto.status === "in_progress";
  const isPrac = moto.type === "practice";
  const chip   = chipFor(moto.status);

  const badgeBg = live ? "#ef444420" : mine ? colors.primary + "18" : colors.muted;
  const badgeFg = live ? "#ef4444"   : mine ? colors.primary        : colors.mutedForeground;

  const myBestLap = isPrac && moto.practiceLaps
    ? Math.min(...moto.practiceLaps.filter(l => (l.lapTimeMs ?? 0) > 0).map(l => l.lapTimeMs!)) || null
    : null;
  const myRank = moto.practiceLeaderboard?.find(e => e.isMe)?.rank ?? null;

  return (
    <View style={{
      marginHorizontal: 16, marginBottom: 6, borderRadius: 10,
      backgroundColor: colors.card,
      borderWidth: live ? 1.5 : (mine ? 1.5 : 1),
      borderColor: live ? "#ef4444" : (mine ? colors.primary : colors.border),
      padding: 12,
      flexDirection: "row", alignItems: "center", gap: 10,
    }}>
      <View style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: badgeBg, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: 9, fontWeight: "700", color: badgeFg, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.3 }}>
          {isPrac ? "PRAC" : "RACE"}
        </Text>
        <Text style={{ fontSize: 16, fontWeight: "800", color: badgeFg, fontFamily: "Inter_700Bold", lineHeight: 18 }}>
          #{moto.motoNumber}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: colors.foreground, fontFamily: "Inter_600SemiBold" }}>{moto.name}</Text>
        {moto.raceClass && (
          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>{moto.raceClass}</Text>
        )}
        {!isPrac && moto.familyGates.length > 0 && (
          <View style={{ marginTop: 3, gap: 1 }}>
            {moto.familyGates.map(g => (
              <Text key={g.gate} style={{ fontSize: 12, fontFamily: "Inter_600SemiBold", color: live ? "#ef4444" : colors.primary }}>
                Gate #{g.gate}{moto.familyGates.length > 1 ? ` · ${g.riderName}` : ""}
              </Text>
            ))}
          </View>
        )}
        {!isPrac && mine && moto.familyGates.length === 0 && moto.status === "scheduled" && (
          <Text style={{ fontSize: 12, color: colors.primary, fontFamily: "Inter_500Medium", marginTop: 2 }}>Gate draw pending</Text>
        )}
        {isPrac && mine && (myBestLap != null || myRank != null) && (
          <View style={{ flexDirection: "row", gap: 10, marginTop: 3 }}>
            {myBestLap != null && (
              <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: colors.mutedForeground }}>
                Best: <Text style={{ color: colors.primary, fontFamily: "Inter_700Bold" }}>{fmtLap(myBestLap)}</Text>
              </Text>
            )}
            {myRank != null && (
              <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: colors.mutedForeground }}>
                Rank: <Text style={{ color: colors.foreground, fontFamily: "Inter_700Bold" }}>P{myRank}</Text>/{moto.practiceLeaderboard?.length}
              </Text>
            )}
          </View>
        )}
        {moto.scheduledTime && moto.status === "scheduled" && (
          <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>{moto.scheduledTime}</Text>
        )}
      </View>
      <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: chip.color + "22" }}>
        <Text style={{ fontSize: 10, fontWeight: "700", fontFamily: "Inter_700Bold", color: chip.color }}>
          {live ? "🔴 " : ""}{chip.label}
        </Text>
      </View>
    </View>
  );
}

// ─── Race day section ─────────────────────────────────────────────────────────

function RaceDaySection({ event, colors }: { event: ScheduleEvent; colors: ReturnType<typeof useColors> }) {
  const myClasses  = [...new Set(event.registrations.map(r => r.raceClass).filter(Boolean))];
  const myRiders   = [...new Set(event.registrations.map(r => r.riderName))];
  const raceMotos  = event.motos.filter(m => m.type !== "practice");
  const scheduled  = raceMotos.filter(m => m.status === "scheduled");
  const nextMyMoto = scheduled.find(m => m.isAnyFamilyMemberInMoto) ?? null;
  const racesAway  = nextMyMoto ? scheduled.findIndex(m => m.motoId === nextMyMoto.motoId) : -1;
  const inProgress = raceMotos.find(m => m.status === "in_progress") ?? null;

  return (
    <>
      <View style={{ marginHorizontal: 16, marginBottom: 8, borderRadius: 12, overflow: "hidden", borderWidth: 1.5, borderColor: "#ef444455", backgroundColor: colors.card }}>
        <View style={{ padding: 14, backgroundColor: "#ef444412" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", marginBottom: 8 }}>
            <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: "#ef4444", flexDirection: "row", alignItems: "center", gap: 4 }}>
              <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: "#fff" }} />
              <Text style={{ fontSize: 10, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold", letterSpacing: 0.5 }}>RACE DAY</Text>
            </View>
          </View>
          <Text style={{ fontSize: 16, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold" }}>{event.eventName}</Text>
          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
            {[event.eventLocation, event.eventState].filter(Boolean).join(", ")}
            {event.eventDate ? `  ·  ${fmtDate(event.eventDate)}` : ""}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            {myRiders.map(name => (
              <View key={name} style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.primary + "18", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                <Feather name="user" size={10} color={colors.primary} />
                <Text style={{ fontSize: 12, fontWeight: "600", color: colors.primary, fontFamily: "Inter_600SemiBold" }}>{name}</Text>
              </View>
            ))}
            {myClasses.map(cls => (
              <View key={cls} style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: colors.muted }}>
                <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>{cls}</Text>
              </View>
            ))}
          </View>
        </View>
        {inProgress && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: "#ef444418", borderTopWidth: 1, borderTopColor: "#ef444433" }}>
            <Feather name="radio" size={13} color="#ef4444" />
            <Text style={{ fontSize: 12, fontWeight: "700", color: "#ef4444", fontFamily: "Inter_700Bold", flex: 1 }}>
              NOW: Race #{inProgress.motoNumber} · {inProgress.name}
            </Text>
          </View>
        )}
        {nextMyMoto && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: "#cf152d14", borderTopWidth: 1, borderTopColor: "#cf152d33" }}>
            <Feather name="alert-circle" size={13} color="#cf152d" />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 12, fontWeight: "700", color: "#cf152d", fontFamily: "Inter_700Bold" }}>
                {racesAway === 0 ? `YOU'RE ON DECK — Race #${nextMyMoto.motoNumber}` : `UP NEXT — Race #${nextMyMoto.motoNumber}`}
                {nextMyMoto.familyGates.length > 0 ? `  ·  Gate #${nextMyMoto.familyGates.map(g => g.gate).join(", #")}` : ""}
              </Text>
              {racesAway > 0 && (
                <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>
                  {racesAway} {racesAway === 1 ? "race" : "races"} until you're up
                </Text>
              )}
            </View>
          </View>
        )}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 }}>
        <Feather name="list" size={13} color={colors.mutedForeground} />
        <Text style={{ fontSize: 11, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.8 }}>Race Schedule</Text>
        {scheduled.length > 0 && (
          <Text style={{ marginLeft: "auto", fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
            {scheduled.length} remaining
          </Text>
        )}
      </View>
      {event.motos.length === 0 ? (
        <View style={{ alignItems: "center", paddingTop: 24, paddingHorizontal: 32, gap: 6 }}>
          <Feather name="clock" size={28} color={colors.mutedForeground} />
          <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>
            Schedule not yet posted — pull to refresh.
          </Text>
        </View>
      ) : (
        event.motos.map(moto => <ScheduleMotoCard key={moto.motoId} moto={moto} colors={colors} />)
      )}
    </>
  );
}

// ─── Upcoming card ────────────────────────────────────────────────────────────

function UpcomingCard({ event, colors }: { event: ScheduleEvent; colors: ReturnType<typeof useColors> }) {
  const myClasses = [...new Set(event.registrations.map(r => r.raceClass).filter(Boolean))];
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push(`/event/${event.eventId}` as any)}
      style={({ pressed }) => ({
        marginHorizontal: 16, marginBottom: 10, borderRadius: 12,
        borderWidth: 1, borderColor: colors.border,
        backgroundColor: colors.card, padding: 14, opacity: pressed ? 0.78 : 1,
      })}
    >
      <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>{event.eventName}</Text>
      <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
        {fmtDate(event.eventDate)} · {[event.eventLocation, event.eventState].filter(Boolean).join(", ")}
      </Text>
      {myClasses.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {myClasses.map(cls => (
            <View key={cls} style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: colors.primary + "18" }}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: colors.primary, fontFamily: "Inter_600SemiBold" }}>{cls}</Text>
            </View>
          ))}
        </View>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 8 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: "#22c55e" }} />
        <Text style={{ fontSize: 12, color: "#22c55e", fontFamily: "Inter_600SemiBold" }}>Registration Open</Text>
      </View>
    </Pressable>
  );
}

function EmptyState({ icon, title, text, colors }: { icon: string; title: string; text: string; colors: ReturnType<typeof useColors> }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 40, gap: 10, marginTop: 32 }}>
      <Feather name={icon as any} size={40} color={colors.mutedForeground + "60"} />
      <Text style={{ fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>{title}</Text>
      <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>{text}</Text>
    </View>
  );
}

// ─── History card (in History tab) ───────────────────────────────────────────

function HistoryCard({ event, colors, onPress }: { event: EventHistory; colors: ReturnType<typeof useColors>; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        marginHorizontal: 16, marginBottom: 10, borderRadius: 12,
        borderWidth: 1, borderColor: colors.border,
        backgroundColor: colors.card, overflow: "hidden", opacity: pressed ? 0.75 : 1,
      })}
    >
      <View style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" }}>
        <View style={{ flex: 1, gap: 2 }}>
          {event.riderName ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 2 }}>
              <Feather name="user" size={10} color="#cf152d" />
              <Text style={{ fontSize: 11, fontWeight: "600", color: "#cf152d", fontFamily: "Inter_600SemiBold" }}>{event.riderName}</Text>
            </View>
          ) : null}
          <Text style={{ fontSize: 14, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>{event.eventName}</Text>
          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
            {fmtDate(event.eventDate)} · {event.eventLocation ?? event.eventState} · {event.raceClass}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          {event.bestPosition != null && (
            <View style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20, backgroundColor: colors.primary }}>
              <Text style={{ fontSize: 12, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" }}>P{event.bestPosition}</Text>
            </View>
          )}
          {event.totalPoints > 0 && (
            <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>{event.totalPoints} pts</Text>
          )}
        </View>
      </View>
      {event.motos.map(moto => (
        <View key={moto.motoId} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Text style={{ flex: 1, fontSize: 13, color: colors.foreground, fontFamily: "Inter_500Medium" }}>{moto.motoName}</Text>
          {moto.totalTime && <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginRight: 8 }}>{moto.totalTime}</Text>}
          {moto.points != null && moto.points > 0 && <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginRight: 8 }}>{moto.points}pts</Text>}
          {moto.dnf || moto.dns ? (
            <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 20, backgroundColor: colors.muted }}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: colors.mutedForeground, fontFamily: "Inter_600SemiBold" }}>{moto.dnf ? "DNF" : "DNS"}</Text>
            </View>
          ) : moto.position != null ? (
            <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 20, backgroundColor: colors.primary }}>
              <Text style={{ fontSize: 11, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" }}>P{moto.position}</Text>
            </View>
          ) : null}
        </View>
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.muted + "40" }}>
        <Feather name="clock" size={11} color={colors.mutedForeground} />
        <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>Tap for lap times</Text>
        <Feather name="chevron-right" size={11} color={colors.mutedForeground} />
      </View>
    </Pressable>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function MyRacesScreen() {
  const colors  = useColors();
  const insets  = useSafeAreaInsets();
  const router  = useRouter();
  const { isAuthenticated, isLoading: authLoading, activeProfiles, riderFetch } = useRiderAuth();

  const [activeFilter, setActiveFilter]     = useState<FilterTab>("today");
  const [schedule, setSchedule]             = useState<{ familyRiderIds: number[]; events: ScheduleEvent[] } | null>(null);
  const [history, setHistory]               = useState<EventHistory[]>([]);
  const [loading, setLoading]               = useState(false);
  const [refreshing, setRefreshing]         = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [nearMeState, setNearMeState]       = useState<string | null>(null);
  const [locationLoading, setLocationLoading] = useState(false);

  // View stack for stat-box drill-down
  const [viewStack, setViewStack] = useState<ViewState[]>([]);
  const currentView = viewStack.length > 0 ? viewStack[viewStack.length - 1] : null;

  const pushView = useCallback((v: ViewState) => setViewStack(prev => [...prev, v]), []);
  const popView  = useCallback(() => setViewStack(prev => prev.slice(0, -1)), []);

  const primaryProfile = activeProfiles[0] ?? null;
  const isMultiProfile = activeProfiles.length > 1;

  // Aggregated stats across all active profiles
  const combinedEventsRaced = activeProfiles.reduce((n, p) => n + p.eventsRaced, 0);
  const combinedTotalPoints = activeProfiles.reduce((n, p) => n + p.totalPoints, 0);
  const combinedBestPosition = activeProfiles.reduce<number | null>((best, p) => {
    if (p.bestPosition == null) return best;
    if (best == null) return p.bestPosition;
    return Math.min(best, p.bestPosition);
  }, null);

  // Stable key for the set of active profiles — drives data reload
  const activeProfileKey = activeProfiles.map(p => p.id).join(",");

  // Lightweight schedule-only refresh — used for background polling during race day
  const loadScheduleOnly = useCallback(async () => {
    if (!primaryProfile) return;
    try {
      const res = await riderFetch(`/api/rider/profiles/${primaryProfile.id}/schedule`);
      if (res.ok) setSchedule(await res.json());
    } catch { /* silently ignore polling errors */ }
  }, [activeProfileKey, riderFetch]);

  const loadAll = useCallback(async () => {
    if (!primaryProfile) return;
    setError(null);
    setLoading(true);
    try {
      // Schedule uses first active profile (server returns all family riders already)
      // History fetched per active profile so multi-rider results are shown separately
      const requests: Promise<Response>[] = [
        riderFetch(`/api/rider/profiles/${primaryProfile.id}/schedule`),
        ...activeProfiles.map(p => riderFetch(`/api/rider/profiles/${p.id}/history`)),
      ];
      const [schedRes, ...histResponses] = await Promise.all(requests);

      if (schedRes.ok) setSchedule(await schedRes.json());

      const allHistory: EventHistory[] = [];
      for (let i = 0; i < histResponses.length; i++) {
        if (!histResponses[i].ok) continue;
        const h = await histResponses[i].json();
        const prof = activeProfiles[i];
        const riderName = prof ? `${prof.firstName} ${prof.lastName}` : "";
        for (const event of (h.history ?? [])) {
          allHistory.push(isMultiProfile ? { ...event, riderName } : event);
        }
      }
      // Sort newest first
      allHistory.sort((a, b) => new Date(b.eventDate).getTime() - new Date(a.eventDate).getTime());
      setHistory(allHistory);
    } catch {
      setError("Couldn't load your racing data. Pull to refresh.");
    } finally {
      setLoading(false);
    }
  }, [activeProfileKey, riderFetch]);

  useEffect(() => {
    if (isAuthenticated && primaryProfile) void loadAll();
  }, [isAuthenticated, activeProfileKey]);

  // Poll schedule every 15 s while there are live race-day events
  const hasLiveRaceDay = (schedule?.events ?? []).some(e => e.status === "race_day");
  useEffect(() => {
    if (!hasLiveRaceDay || !primaryProfile) return;
    const timer = setInterval(() => { void loadScheduleOnly(); }, 15_000);
    return () => clearInterval(timer);
  }, [hasLiveRaceDay, loadScheduleOnly]);

  useEffect(() => {
    if (activeFilter !== "near_me" || nearMeState) return;
    (async () => {
      setLocationLoading(true);
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") { setLocationLoading(false); return; }
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const [geo] = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
        if (geo?.region) setNearMeState(geo.region);
      } catch { /* silently fail */ }
      finally { setLocationLoading(false); }
    })();
  }, [activeFilter]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }, [loadAll]);

  const raceDay  = schedule?.events.filter(e => e.status === "race_day") ?? [];
  const upcoming = schedule?.events.filter(e => e.status === "registration_open") ?? [];
  const nearMeEvents = nearMeState ? upcoming.filter(e => e.eventState === nearMeState) : upcoming;

  const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header:    { paddingTop: insets.top + 16, paddingHorizontal: 20, paddingBottom: 16, backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.border },
    statsRow:  { flexDirection: "row", gap: 10, marginTop: 12 },
    filterBar: { flexDirection: "row", paddingHorizontal: 10, paddingVertical: 8, gap: 6, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.background },
    footer:    { height: insets.bottom + 32 },
  });

  if (authLoading) {
    return <View style={[styles.container, { flex: 1, alignItems: "center", justifyContent: "center" }]}><ActivityIndicator color={colors.primary} /></View>;
  }

  if (!isAuthenticated) {
    return (
      <View style={[styles.container, { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }]}>
        <Feather name="award" size={48} color={colors.mutedForeground} />
        <Text style={{ fontSize: 18, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>Your racing lives here</Text>
        <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>
          Sign in to see your race schedule, practice laps, and results.
        </Text>
        <Pressable style={{ marginTop: 12, backgroundColor: colors.primary, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 10 }} onPress={() => router.push("/(tabs)/profile")}>
          <Text style={{ color: "#fff", fontSize: 15, fontWeight: "700", fontFamily: "Inter_700Bold" }}>Sign In</Text>
        </Pressable>
      </View>
    );
  }

  if (!primaryProfile) {
    return (
      <View style={[styles.container, { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }]}>
        <Feather name="user-x" size={40} color={colors.mutedForeground} />
        <Text style={{ fontSize: 18, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>No rider profile linked</Text>
        <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>
          Register for an event using this email address to link your rider profile.
        </Text>
      </View>
    );
  }

  // ── Stat box tap handlers ──────────────────────────────────────────────────

  function handleTapEvents() {
    pushView({ type: "events" });
  }

  function handleTapPoints() {
    pushView({ type: "points" });
  }

  function handleTapBestFinish() {
    // Find the event where any active rider achieved their combined best position
    const bestPos = combinedBestPosition;
    if (bestPos == null || history.length === 0) {
      pushView({ type: "events" }); // fallback to list
      return;
    }
    const sorted = [...history].sort((a, b) => {
      const aDate = new Date(a.eventDate ?? 0).getTime();
      const bDate = new Date(b.eventDate ?? 0).getTime();
      return bDate - aDate; // most recent first
    });
    const best = sorted.find(e => e.bestPosition === bestPos);
    if (best) pushView({ type: "event_detail", event: best });
    else      pushView({ type: "events" });
  }

  // ── Sub-screen rendering ───────────────────────────────────────────────────

  if (currentView) {
    if (currentView.type === "events") {
      return (
        <View style={styles.container}>
          <EventsListScreen
            events={history}
            onSelectEvent={ev => pushView({ type: "event_detail", event: ev })}
            onBack={popView}
            colors={colors}
            insets={insets}
          />
        </View>
      );
    }

    if (currentView.type === "event_detail") {
      return (
        <View style={styles.container}>
          <EventDetailScreen
            event={currentView.event}
            onBack={popView}
            colors={colors}
            insets={insets}
          />
        </View>
      );
    }

    if (currentView.type === "points") {
      return (
        <View style={styles.container}>
          <PointsScreen
            events={history}
            totalPoints={combinedTotalPoints}
            onBack={popView}
            colors={colors}
            insets={insets}
          />
        </View>
      );
    }
  }

  // ── Main screen ─────────────────────────────────────────────────────────────

  function renderContent() {
    if (loading && !refreshing) {
      return <View style={{ marginTop: 60, alignItems: "center" }}><ActivityIndicator color={colors.primary} /></View>;
    }
    if (error) {
      return <EmptyState icon="alert-circle" title="Couldn't load data" text={error} colors={colors} />;
    }
    switch (activeFilter) {
      case "today":
        return raceDay.length > 0 ? (
          <><View style={{ height: 12 }} />{raceDay.map(e => <RaceDaySection key={e.eventId} event={e} colors={colors} />)}</>
        ) : (
          <EmptyState icon="zap" title="No events today" text="You have no races scheduled for today. Check Upcoming for what's next." colors={colors} />
        );

      case "upcoming":
        return upcoming.length > 0 ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginHorizontal: 16, marginTop: 20, marginBottom: 8 }}>
              <Feather name="calendar" size={13} color={colors.primary} />
              <Text style={{ fontSize: 11, fontWeight: "700", color: colors.primary, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>Upcoming Events</Text>
            </View>
            {upcoming.map(e => <UpcomingCard key={e.eventId} event={e} colors={colors} />)}
          </>
        ) : (
          <EmptyState icon="calendar" title="Nothing upcoming" text="You're not registered for any upcoming events yet." colors={colors} />
        );

      case "near_me":
        if (locationLoading) {
          return <View style={{ marginTop: 60, alignItems: "center", gap: 12 }}>
            <ActivityIndicator color={colors.primary} />
            <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>Finding your location…</Text>
          </View>;
        }
        return nearMeEvents.length > 0 ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginHorizontal: 16, marginTop: 20, marginBottom: 8 }}>
              <Feather name="map-pin" size={13} color={colors.primary} />
              <Text style={{ fontSize: 11, fontWeight: "700", color: colors.primary, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>
                {nearMeState ? `Open in ${nearMeState}` : "Open Near You"}
              </Text>
            </View>
            {nearMeEvents.map(e => <UpcomingCard key={e.eventId} event={e} colors={colors} />)}
          </>
        ) : (
          <EmptyState
            icon="map-pin"
            title={nearMeState ? `No open events in ${nearMeState}` : "No events near you"}
            text="There are no events open for registration in your area right now."
            colors={colors}
          />
        );

      case "history":
        return history.length > 0 ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginHorizontal: 16, marginTop: 20, marginBottom: 8 }}>
              <Feather name="award" size={13} color={colors.primary} />
              <Text style={{ fontSize: 11, fontWeight: "700", color: colors.primary, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>Race History</Text>
            </View>
            {history.map(e => (
              <HistoryCard
                key={e.eventId}
                event={e}
                colors={colors}
                onPress={() => pushView({ type: "event_detail", event: e })}
              />
            ))}
          </>
        ) : (
          <EmptyState icon="award" title="No race history" text="Your past race results will appear here once events are completed." colors={colors} />
        );
    }
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <BrandBar />
        <Text style={{ fontSize: 26, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", letterSpacing: -0.5 }}>
          My Racing
        </Text>

        {/* Tappable stat boxes */}
        <View style={styles.statsRow}>
          {/* Events */}
          <Pressable
            onPress={handleTapEvents}
            style={({ pressed }) => ({
              flex: 1, backgroundColor: colors.muted, borderRadius: 10, padding: 12,
              alignItems: "center", opacity: pressed ? 0.7 : 1,
              borderWidth: 1, borderColor: colors.border,
            })}
          >
            <Text style={{ fontSize: 20, fontWeight: "700", color: colors.primary, fontFamily: "Inter_700Bold" }}>
              {combinedEventsRaced}
            </Text>
            <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_500Medium", marginTop: 2, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Events
            </Text>
            <Feather name="chevron-right" size={11} color={colors.mutedForeground} style={{ position: "absolute", right: 8, top: "50%", marginTop: -6 }} />
          </Pressable>

          {/* Points */}
          <Pressable
            onPress={handleTapPoints}
            style={({ pressed }) => ({
              flex: 1, backgroundColor: colors.muted, borderRadius: 10, padding: 12,
              alignItems: "center", opacity: pressed ? 0.7 : 1,
              borderWidth: 1, borderColor: colors.border,
            })}
          >
            <Text style={{ fontSize: 20, fontWeight: "700", color: colors.primary, fontFamily: "Inter_700Bold" }}>
              {combinedTotalPoints}
            </Text>
            <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_500Medium", marginTop: 2, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Points
            </Text>
            <Feather name="chevron-right" size={11} color={colors.mutedForeground} style={{ position: "absolute", right: 8, top: "50%", marginTop: -6 }} />
          </Pressable>

          {/* Best Finish */}
          <Pressable
            onPress={handleTapBestFinish}
            style={({ pressed }) => ({
              flex: 1, backgroundColor: colors.muted, borderRadius: 10, padding: 12,
              alignItems: "center", opacity: pressed ? 0.7 : 1,
              borderWidth: 1, borderColor: colors.border,
            })}
          >
            <Text style={{ fontSize: 20, fontWeight: "700", color: colors.primary, fontFamily: "Inter_700Bold" }}>
              {combinedBestPosition != null ? `P${combinedBestPosition}` : "—"}
            </Text>
            <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_500Medium", marginTop: 2, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Best Finish
            </Text>
            <Feather name="chevron-right" size={11} color={colors.mutedForeground} style={{ position: "absolute", right: 8, top: "50%", marginTop: -6 }} />
          </Pressable>
        </View>
      </View>

      {/* Filter tab bar */}
      <View style={styles.filterBar}>
        {FILTER_TABS.map(tab => {
          const active = activeFilter === tab.key;
          return (
            <Pressable
              key={tab.key}
              style={{ flex: 1, flexDirection: "column", alignItems: "center", justifyContent: "center", paddingVertical: 7, borderRadius: 8, borderWidth: 1, backgroundColor: active ? colors.primary : colors.muted, borderColor: active ? colors.primary : colors.border }}
              onPress={() => setActiveFilter(tab.key)}
            >
              <Feather name={tab.icon as any} size={11} color={active ? "#fff" : colors.mutedForeground} />
              <Text style={{ fontSize: 10, fontWeight: "700", fontFamily: "Inter_700Bold", color: active ? "#fff" : colors.mutedForeground, lineHeight: 14, marginTop: 2, textAlign: "center" }}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Content */}
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <View style={{ paddingTop: 4 }}>
          {renderContent()}
        </View>
        <View style={styles.footer} />
      </ScrollView>
    </View>
  );
}
