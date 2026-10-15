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

import { BrandBar } from "@/components/BrandBar";
import { fmtDateShared as fmtDate, fmtLap } from "@/components/RaceSubScreens";
import { useColors } from "@/hooks/useColors";
import { onTabReset } from "@/utils/tabEvents";

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
}

interface PublicMotoDetail {
  motoId: number;
  motoName: string;
  raceClass: string | null;
  status: string;
  leaderboard: PublicLeaderEntry[];
  lineup: PublicLineupEntry[];
}

// ─── Series Types ─────────────────────────────────────────────────────────────

interface PublicSeries {
  id: number;
  name: string;
  season: string | null;
  clubName: string;
  state: string;
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

function isEventToday(e: BrowseEvent): boolean {
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  const start = e.date ? e.date.substring(0, 10) : "";
  const end = e.endDate ? e.endDate.substring(0, 10) : start;
  return !!start && start <= todayStr && todayStr <= end;
}

function chipFor(status: string): { label: string; color: string } {
  const map: Record<string, { label: string; color: string }> = {
    in_progress: { label: "LIVE",     color: "#ef4444" },
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

const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

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
}: {
  motoId: number;
  riderId: number;
  riderName: string;
  leaderRiderId: number | null;
  onClose: () => void;
  colors: ReturnType<typeof useColors>;
  bottomInset: number;
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

  const times = laps.map(l => l.lapTimeMs).filter(t => t > 0);
  const trueTimes = times.slice(1); // exclude lap 1 (gate-to-line partial lap)
  const bestMs = trueTimes.length > 0 ? Math.min(...trueTimes) : null;
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
            <Text style={{ fontSize: 17, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
              {riderName}
            </Text>
            <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
              Lap Times
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={8} style={{ padding: 4 }}>
            <Feather name="x" size={20} color={colors.mutedForeground} />
          </Pressable>
        </View>

        <ScrollView showsVerticalScrollIndicator={false}>
          {loading ? (
            <View style={{ paddingVertical: 44, alignItems: "center" }}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : laps.length === 0 ? (
            <View style={{ paddingVertical: 44, alignItems: "center", gap: 8 }}>
              <Feather name="clock" size={28} color={colors.mutedForeground} />
              <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>No lap data recorded</Text>
            </View>
          ) : (
            <>
              <View style={{ flexDirection: "row", paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6 }}>
                <Text style={{ width: 44, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase" }}>Lap</Text>
                <Text style={{ flex: 1, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase" }}>Time</Text>
                <Text style={{ width: 80, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", textAlign: "right" }}>
                  {hasLeaderData ? "+Gap to Leader" : "+Gap to Best"}
                </Text>
              </View>
              {laps.map((lap, i) => {
                const isBest = i > 0 && bestMs !== null && lap.lapTimeMs === bestMs;
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
                    <Text style={{ width: 44, fontSize: 14, fontWeight: "700", color: isBest ? "#f59e0b" : colors.mutedForeground, fontFamily: "Inter_700Bold" }}>
                      {lap.lapNumber}
                    </Text>
                    <Text style={{ flex: 1, fontSize: 15, fontWeight: isBest ? "800" : "500", color: isBest ? "#f59e0b" : colors.foreground, fontFamily: isBest ? "Inter_700Bold" : "Inter_500Medium" }}>
                      {fmtLap(lap.lapTimeMs)}
                      {isBest ? "  ★ Best" : ""}
                    </Text>
                    <Text style={{ width: 80, fontSize: 12, color: isP1 ? colors.primary : colors.mutedForeground, fontFamily: isP1 ? "Inter_700Bold" : "Inter_400Regular", textAlign: "right" }}>
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

function PublicMotoSheet({
  moto,
  onClose,
  colors,
  bottomInset,
}: {
  moto: PublicMoto;
  onClose: () => void;
  colors: ReturnType<typeof useColors>;
  bottomInset: number;
}) {
  const [detail, setDetail] = useState<PublicMotoDetail | null>(null);
  const [fetching, setFetching] = useState(true);
  const [selectedLeader, setSelectedLeader] = useState<PublicLeaderEntry | null>(null);
  const isLive      = moto.status === "in_progress";
  const isScheduled = moto.status === "scheduled";
  const chip        = chipFor(moto.status);

  const fetchDetail = useCallback(async () => {
    try {
      const res = await publicFetch(`/api/public/motos/${moto.motoId}/detail`);
      if (res.ok) setDetail(await res.json());
    } catch { /* silently ignore */ }
    finally { setFetching(false); }
  }, [moto.motoId]);

  useEffect(() => {
    void fetchDetail();
    if (!isLive) return;
    const timer = setInterval(() => { void fetchDetail(); }, 5000);
    return () => clearInterval(timer);
  }, [fetchDetail, isLive]);

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
      />
    );
  }

  return (
    <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.58)" }}>
      <Pressable style={{ flex: 1 }} onPress={onClose} />
      <View style={{
        backgroundColor: colors.card,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
        maxHeight: "82%",
        paddingBottom: bottomInset + 8,
      }}>
        {/* Drag handle */}
        <View style={{ alignItems: "center", paddingTop: 12, paddingBottom: 6 }}>
          <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: colors.border }} />
        </View>

        {/* Header */}
        <View style={{
          paddingHorizontal: 20, paddingBottom: 14,
          borderBottomWidth: 1, borderBottomColor: colors.border,
          flexDirection: "row", alignItems: "flex-start", gap: 10,
        }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 17, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
              {moto.name}
            </Text>
            {moto.raceClass && (
              <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
                {moto.raceClass}
              </Text>
            )}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 2 }}>
            <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: chip.color + "22" }}>
              <Text style={{ fontSize: 11, fontWeight: "700", color: chip.color, fontFamily: "Inter_700Bold" }}>
                {isLive ? "🔴 LIVE" : chip.label}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} style={{ padding: 4 }}>
              <Feather name="x" size={20} color={colors.mutedForeground} />
            </Pressable>
          </View>
        </View>

        <ScrollView showsVerticalScrollIndicator={false}>
          {fetching && (
            <View style={{ paddingVertical: 44, alignItems: "center" }}>
              <ActivityIndicator color={colors.primary} />
            </View>
          )}

          {/* SCHEDULED → Rider Lineup */}
          {!fetching && isScheduled && (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 10 }}>
                <Feather name="users" size={12} color={colors.primary} />
                <Text style={{ fontSize: 11, fontWeight: "700", color: colors.primary, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>
                  Race Lineup
                </Text>
                {lineupRows.length > 0 && (
                  <Text style={{ marginLeft: "auto", fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                    {lineupRows.length} riders
                  </Text>
                )}
              </View>
              {lineupRows.length === 0 ? (
                <View style={{ paddingVertical: 36, alignItems: "center", gap: 8 }}>
                  <Feather name="clock" size={28} color={colors.mutedForeground} />
                  <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>Gate draw not posted yet</Text>
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
                      <Text style={{ fontSize: 9, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase" }}>Gate</Text>
                      <Text style={{ fontSize: 15, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", lineHeight: 17 }}>
                        #{entry.gate}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: "500", color: colors.foreground, fontFamily: "Inter_500Medium" }}>
                        {entry.riderName}
                      </Text>
                      {entry.bibNumber && (
                        <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>
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
                  ? <Feather name="radio" size={12} color="#ef4444" />
                  : <Feather name="award" size={12} color={colors.primary} />}
                <Text style={{ fontSize: 11, fontWeight: "700", color: isLive ? "#ef4444" : colors.primary, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>
                  {isLive ? "Live Leaderboard" : "Final Results"}
                </Text>
                {isLive && (
                  <Text style={{ marginLeft: "auto", fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                    Updates every 5s
                  </Text>
                )}
              </View>

              {(!detail || detail.leaderboard.length === 0) ? (
                <View style={{ paddingVertical: 36, alignItems: "center", gap: 8 }}>
                  <Feather name="clock" size={28} color={colors.mutedForeground} />
                  <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                    {isLive ? "Waiting for riders to start…" : "Results not yet posted"}
                  </Text>
                </View>
              ) : (
                detail.leaderboard.map((entry, i) => {
                  const isDNF = !!entry.dnf;
                  const isDNS = !!entry.dns;
                  const pos   = isDNS ? "DNS" : isDNF ? "DNF" : entry.position != null ? `P${entry.position}` : `${i + 1}`;
                  const isP1  = entry.position === 1 && !isDNF && !isDNS;
                  const posColor = isP1 ? "#f59e0b" : colors.mutedForeground;
                  const canTapLaps = !!entry.riderId && !isDNS;

                  return (
                    <Pressable
                      key={i}
                      onPress={canTapLaps ? () => setSelectedLeader(entry) : undefined}
                      style={({ pressed }) => ({
                        flexDirection: "row", alignItems: "center", gap: 14,
                        paddingHorizontal: 20, paddingVertical: 11,
                        borderBottomWidth: 1, borderBottomColor: colors.border + "55",
                        opacity: pressed && canTapLaps ? 0.7 : 1,
                      })}
                    >
                      <View style={{ width: 40, alignItems: "center" }}>
                        <Text style={{ fontSize: 16, fontWeight: "800", color: posColor, fontFamily: "Inter_700Bold" }}>{pos}</Text>
                        {isLive && !isDNS && !isDNF && entry.laps > 0 && (
                          <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                            {entry.laps}L
                          </Text>
                        )}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: "500", color: canTapLaps ? colors.primary : colors.foreground, fontFamily: "Inter_500Medium" }}>
                          {entry.riderName}
                        </Text>
                        {entry.bibNumber && (
                          <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>
                            #{entry.bibNumber}
                          </Text>
                        )}
                      </View>
                      <View style={{ alignItems: "flex-end", gap: 2 }}>
                        {entry.totalTime && !isDNS && (
                          <Text style={{ fontSize: 13, fontWeight: "600", color: colors.foreground, fontFamily: "Inter_600SemiBold" }}>
                            {entry.totalTime}
                          </Text>
                        )}
                        {entry.gap === "Leader" && !isDNS && !isDNF && (
                          <Text style={{ fontSize: 11, color: "#f59e0b", fontFamily: "Inter_600SemiBold" }}>Leader</Text>
                        )}
                        {entry.gap && entry.gap !== "Leader" && !isDNS && !isDNF && (
                          <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>{entry.gap}</Text>
                        )}
                        {canTapLaps && (
                          <Feather name="chevron-right" size={11} color={colors.mutedForeground + "80"} />
                        )}
                      </View>
                    </Pressable>
                  );
                })
              )}
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
}: {
  event: BrowseEvent;
  onBack: () => void;
  colors: ReturnType<typeof useColors>;
  bottomInset: number;
}) {
  const { top: topInset } = useSafeAreaInsets();
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

  // Poll every 15s during live events
  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(t);
  }, [isLive, load]);

  const onRefresh = useCallback(async () => {
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
          style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.6 : 1, marginTop: 2 })}
        >
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {isLive && (
              <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: "#ef4444", flexDirection: "row", alignItems: "center", gap: 4 }}>
                <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: "#fff" }} />
                <Text style={{ fontSize: 10, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold", letterSpacing: 0.5 }}>RACE DAY</Text>
              </View>
            )}
            {!isLive && (
              <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: "#22c55e22" }}>
                <Text style={{ fontSize: 10, fontWeight: "700", color: "#22c55e", fontFamily: "Inter_700Bold" }}>COMPLETED</Text>
              </View>
            )}
          </View>
          <Text style={{ fontSize: 17, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", marginTop: 4 }} numberOfLines={2}>
            {event.name}
          </Text>
          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
            {[event.location || event.trackName, event.state].filter(Boolean).join(", ")}
            {event.date ? `  ·  ${fmtEventRange(event.date, event.endDate)}` : ""}
          </Text>
          {event.clubName ? (
            <Text style={{ fontSize: 11, color: colors.mutedForeground + "88", fontFamily: "Inter_400Regular", marginTop: 1 }}>{event.clubName}</Text>
          ) : null}
        </View>
      </View>

      {/* Stats row */}
      {!loading && motos.length > 0 && (
        <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          {liveCount > 0 && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#ef444418", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#ef4444" }} />
              <Text style={{ fontSize: 11, fontWeight: "700", color: "#ef4444", fontFamily: "Inter_700Bold" }}>{liveCount} Live</Text>
            </View>
          )}
          {doneCount > 0 && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#22c55e18", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 }}>
              <Feather name="check" size={11} color="#22c55e" />
              <Text style={{ fontSize: 11, fontWeight: "700", color: "#22c55e", fontFamily: "Inter_700Bold" }}>{doneCount} Done</Text>
            </View>
          )}
          {upcomingCount > 0 && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.muted, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 }}>
              <Feather name="clock" size={11} color={colors.mutedForeground} />
              <Text style={{ fontSize: 11, fontWeight: "600", color: colors.mutedForeground, fontFamily: "Inter_600SemiBold" }}>{upcomingCount} Upcoming</Text>
            </View>
          )}
        </View>
      )}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {loading ? (
          <View style={{ paddingVertical: 60, alignItems: "center" }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : motos.length === 0 ? (
          <View style={{ paddingVertical: 60, alignItems: "center", gap: 8, paddingHorizontal: 32 }}>
            <Feather name="clock" size={32} color={colors.mutedForeground} />
            <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>
              Schedule not yet posted
            </Text>
          </View>
        ) : (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
              <Feather name="list" size={12} color={colors.mutedForeground} />
              <Text style={{ fontSize: 11, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.8 }}>
                Race Schedule
              </Text>
              <Text style={{ marginLeft: "auto", fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                {motos.length} motos
              </Text>
            </View>
            {motos.map(moto => {
              const live = moto.status === "in_progress";
              const done = moto.status === "completed";
              const chip = chipFor(moto.status);
              const hasLineup = moto.lineup.length > 0;
              return (
                <Pressable
                  key={moto.motoId}
                  onPress={() => setSelectedMoto(moto)}
                  style={({ pressed }) => ({
                    marginHorizontal: 16, marginBottom: 6, borderRadius: 10,
                    backgroundColor: colors.card,
                    borderWidth: live ? 1.5 : 1,
                    borderColor: live ? "#ef4444" : colors.border,
                    padding: 12,
                    flexDirection: "row", alignItems: "center", gap: 10,
                    opacity: pressed ? 0.78 : 1,
                  })}
                >
                  {/* Badge */}
                  <View style={{
                    width: 44, height: 44, borderRadius: 10,
                    backgroundColor: live ? "#ef444420" : done ? "#22c55e18" : colors.muted,
                    alignItems: "center", justifyContent: "center",
                  }}>
                    <Text style={{ fontSize: 9, fontWeight: "700", color: live ? "#ef4444" : done ? "#22c55e" : colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.3 }}>
                      RACE
                    </Text>
                    <Text style={{ fontSize: 16, fontWeight: "800", color: live ? "#ef4444" : done ? "#22c55e" : colors.foreground, fontFamily: "Inter_700Bold", lineHeight: 18 }}>
                      #{moto.motoNumber}
                    </Text>
                  </View>

                  {/* Info */}
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: colors.foreground, fontFamily: "Inter_600SemiBold" }}>{moto.name}</Text>
                    {moto.raceClass && (
                      <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>{moto.raceClass}</Text>
                    )}
                    {hasLineup && (
                      <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
                        {moto.lineup.length} riders
                      </Text>
                    )}
                    {moto.scheduledTime && moto.status === "scheduled" && (
                      <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>{moto.scheduledTime}</Text>
                    )}
                  </View>

                  {/* Chip + chevron */}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: chip.color + "22" }}>
                      <Text style={{ fontSize: 10, fontWeight: "700", fontFamily: "Inter_700Bold", color: chip.color }}>
                        {live ? "🔴 " : ""}{chip.label}
                      </Text>
                    </View>
                    <Feather name="chevron-right" size={14} color={colors.mutedForeground} />
                  </View>
                </Pressable>
              );
            })}
            <View style={{ height: bottomInset + 32 }} />
          </>
        )}
      </ScrollView>

      {/* Moto detail sheet */}
      <Modal
        visible={selectedMoto != null}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedMoto(null)}
      >
        {selectedMoto && (
          <PublicMotoSheet
            moto={selectedMoto}
            onClose={() => setSelectedMoto(null)}
            colors={colors}
            bottomInset={bottomInset}
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
}: {
  event: BrowseEvent;
  colors: ReturnType<typeof useColors>;
  onPress: () => void;
}) {
  const isLive = event.status === "race_day";
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        marginHorizontal: 16, marginBottom: 10, borderRadius: 12,
        backgroundColor: colors.card,
        borderWidth: isLive ? 1.5 : 1,
        borderColor: isLive ? "#ef4444" : colors.border,
        overflow: "hidden", opacity: pressed ? 0.78 : 1,
      })}
    >
      {isLive && (
        <View style={{ backgroundColor: "#ef444412", paddingHorizontal: 14, paddingVertical: 7, flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#ef4444" }} />
          <Text style={{ fontSize: 11, fontWeight: "700", color: "#ef4444", fontFamily: "Inter_700Bold", letterSpacing: 0.5 }}>LIVE NOW</Text>
        </View>
      )}
      <View style={{ padding: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }} numberOfLines={2}>
              {event.name}
            </Text>
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 3 }}>
              {fmtEventRange(event.date, event.endDate)}
            </Text>
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>
              {[event.location || event.trackName, event.state].filter(Boolean).join(", ")}
            </Text>
            {event.clubName ? (
              <Text style={{ fontSize: 11, color: colors.mutedForeground + "88", fontFamily: "Inter_400Regular", marginTop: 1 }}>{event.clubName}</Text>
            ) : null}
          </View>
          <Feather name="chevron-right" size={18} color={colors.mutedForeground} style={{ marginTop: 2 }} />
        </View>
      </View>
    </Pressable>
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
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        marginHorizontal: 16, marginBottom: 10, borderRadius: 12,
        backgroundColor: colors.card,
        borderWidth: 1, borderColor: colors.border,
        overflow: "hidden", opacity: pressed ? 0.78 : 1,
      })}
    >
      <View style={{ padding: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <View style={{
            width: 44, height: 44, borderRadius: 10,
            backgroundColor: colors.primary + "18",
            alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            <Feather name="award" size={18} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }} numberOfLines={2}>
              {series.name}
            </Text>
            {series.season && (
              <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
                {series.season}
              </Text>
            )}
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>
              {series.clubName}{series.state ? ` · ${series.state}` : ""}
            </Text>
            {series.classes && series.classes.length > 0 && (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                {series.classes.slice(0, 5).map(cls => (
                  <View key={cls} style={{ backgroundColor: colors.muted, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 }}>
                    <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>{cls}</Text>
                  </View>
                ))}
                {series.classes.length > 5 && (
                  <View style={{ backgroundColor: colors.muted, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 }}>
                    <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>+{series.classes.length - 5} more</Text>
                  </View>
                )}
              </View>
            )}
          </View>
          <Feather name="chevron-right" size={18} color={colors.mutedForeground} style={{ marginTop: 2 }} />
        </View>
      </View>
    </Pressable>
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

  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); }, [load]);

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
          style={({ pressed }) => ({ padding: 4, opacity: pressed ? 0.6 : 1, marginTop: 2 })}
        >
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 17, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold" }} numberOfLines={2}>
            {series.name}
          </Text>
          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
            {[series.season, series.clubName, series.state].filter(Boolean).join(" · ")}
          </Text>
        </View>
      </View>

      {/* Class count strip */}
      {!loading && byClass.length > 0 && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Feather name="layers" size={12} color={colors.primary} />
          <Text style={{ fontSize: 11, fontWeight: "700", color: colors.primary, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.8 }}>
            {byClass.length} class{byClass.length !== 1 ? "es" : ""}
          </Text>
          <Pressable
            onPress={() => {
              const allOpen = byClass.every(([cls]) => expandedClasses.has(cls));
              setExpandedClasses(allOpen ? new Set() : new Set(byClass.map(([cls]) => cls)));
            }}
            style={({ pressed }) => ({ marginLeft: "auto", opacity: pressed ? 0.6 : 1 })}
          >
            <Text style={{ fontSize: 12, color: colors.primary, fontFamily: "Inter_500Medium" }}>
              {byClass.every(([cls]) => expandedClasses.has(cls)) ? "Collapse all" : "Expand all"}
            </Text>
          </Pressable>
        </View>
      )}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {loading ? (
          <View style={{ paddingVertical: 80, alignItems: "center" }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : byClass.length === 0 ? (
          <View style={{ paddingVertical: 80, alignItems: "center", paddingHorizontal: 32, gap: 10 }}>
            <Feather name="inbox" size={36} color={colors.mutedForeground + "60"} />
            <Text style={{ fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>No standings yet</Text>
            <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>
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
                      <Feather name="layers" size={13} color={colors.primary} />
                    </View>
                    <Text style={{ flex: 1, fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>{cls}</Text>
                    <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginRight: 8 }}>
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
                        <Text style={{ fontSize: 14, fontWeight: "800", color: posColor(rider.position), fontFamily: "Inter_700Bold" }}>
                          {rider.position}
                        </Text>
                      </View>

                      {/* Name + info */}
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: colors.foreground, fontFamily: "Inter_600SemiBold" }} numberOfLines={1}>
                          {rider.riderName}
                        </Text>
                        <View style={{ flexDirection: "row", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
                          <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                            {rider.eventsEntered} event{rider.eventsEntered !== 1 ? "s" : ""}
                          </Text>
                          {rider.bikeBrand && (
                            <Text style={{ fontSize: 11, color: colors.mutedForeground + "90", fontFamily: "Inter_400Regular" }}>· {rider.bikeBrand}</Text>
                          )}
                        </View>
                      </View>

                      {/* Points + chevron */}
                      <View style={{ alignItems: "flex-end", gap: 2 }}>
                        <Text style={{ fontSize: 16, fontWeight: "800", color: colors.primary, fontFamily: "Inter_700Bold" }}>
                          {rider.totalScore}
                        </Text>
                        <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textTransform: "uppercase", letterSpacing: 0.5 }}>
                          pts
                        </Text>
                      </View>
                      <Feather name="chevron-right" size={14} color={colors.mutedForeground + "80"} style={{ marginLeft: 6 }} />
                    </Pressable>
                  ))}
                </View>
              );
            })}
            <View style={{ height: bottomInset + 40 }} />
          </>
        )}
      </ScrollView>

      {/* ── Rider breakdown sheet ── */}
      <Modal
        visible={!!selectedRider}
        transparent
        animationType="slide"
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
                  <Text style={{ fontSize: 17, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
                    {selectedRider.riderName}
                  </Text>
                  <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
                    {selectedRider.raceClass} · {ordinalSuffix(selectedRider.position)} place · {selectedRider.totalScore} pts total
                  </Text>
                </View>
                <Pressable onPress={() => setSelectedRider(null)} hitSlop={8} style={{ padding: 4 }}>
                  <Feather name="x" size={20} color={colors.mutedForeground} />
                </Pressable>
              </View>

              {/* Column headers */}
              <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingVertical: 8, backgroundColor: colors.muted + "50" }}>
                <Text style={{ flex: 1, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5 }}>Race</Text>
                <Text style={{ width: 70, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>Finish</Text>
                <Text style={{ width: 52, fontSize: 10, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5, textAlign: "right" }}>Pts</Text>
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
                        <Text style={{ fontSize: 14, fontWeight: "600", color: colors.foreground, fontFamily: "Inter_600SemiBold" }} numberOfLines={1}>
                          {ev.eventName}
                        </Text>
                      </View>
                      <View style={{ width: 70, alignItems: "center" }}>
                        <Text style={{ fontSize: 13, fontWeight: "700", color: finishes.length > 0 ? posColor(Math.min(...finishes)) : colors.mutedForeground, fontFamily: "Inter_700Bold" }}>
                          {finishLabel}
                        </Text>
                      </View>
                      <Text style={{ width: 52, fontSize: 15, fontWeight: "700", color: colors.primary, fontFamily: "Inter_700Bold", textAlign: "right" }}>
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

  // Reset to root when tab icon is pressed
  useEffect(() => {
    return onTabReset("results", () => {
      setSelectedEvent(null);
      setSelectedSeries(null);
    });
  }, []);

  // ── Races data loading ───────────────────────────────────────────────────────
  const loadEvents = useCallback(async (q: string) => {
    try {
      const res = await publicFetch(`/api/public/events/browse?q=${encodeURIComponent(q)}`);
      if (res.ok) setEvents(await res.json());
    } catch { /* silently ignore */ }
    finally { setEventsLoading(false); setEventsRefreshing(false); }
  }, []);

  useEffect(() => { void loadEvents(racesDebouncedQ); }, [racesDebouncedQ, loadEvents]);

  useEffect(() => {
    const t = setInterval(() => { void loadEvents(racesDebouncedQ); }, 30_000);
    return () => clearInterval(t);
  }, [racesDebouncedQ, loadEvents]);

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
        event={selectedEvent}
        onBack={() => setSelectedEvent(null)}
        colors={colors}
        bottomInset={insets.bottom}
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

  const liveEvents = events.filter(e => e.status === "race_day" && isEventToday(e));
  const pastEvents = events
    .filter(e => e.status === "completed" || (e.status === "race_day" && !isEventToday(e)))
    .sort((a, b) => {
      const aDate = (a.endDate || a.date || "").substring(0, 10);
      const bDate = (b.endDate || b.date || "").substring(0, 10);
      return bDate.localeCompare(aDate);
    });

  // Filter series client-side by name/club/state when query exists
  const filteredSeries = seriesDebouncedQ
    ? seriesList.filter(s => {
        const q = seriesDebouncedQ.toLowerCase();
        return s.name.toLowerCase().includes(q)
          || s.clubName.toLowerCase().includes(q)
          || s.state.toLowerCase().includes(q)
          || (s.season ?? "").toLowerCase().includes(q);
      })
    : seriesList;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Header */}
      <View style={{
        paddingTop: insets.top + 16, paddingHorizontal: 20, paddingBottom: 12,
        backgroundColor: colors.background,
        borderBottomWidth: 1, borderBottomColor: colors.border,
      }}>
        <BrandBar />
        <Text style={{ fontSize: 26, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", letterSpacing: -0.5, marginBottom: 12 }}>
          Race Results
        </Text>

        {/* Tab toggle */}
        <View style={{
          flexDirection: "row", backgroundColor: colors.muted,
          borderRadius: 10, padding: 3,
          borderWidth: 1, borderColor: colors.border, marginBottom: 12,
        }}>
          {(["races", "series"] as MainTab[]).map(t => {
            const active = tab === t;
            return (
              <Pressable
                key={t}
                onPress={() => setTab(t)}
                style={{
                  flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center",
                  backgroundColor: active ? colors.background : "transparent",
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
                    color={active ? colors.primary : colors.mutedForeground}
                  />
                  <Text style={{
                    fontSize: 13, fontWeight: "700",
                    fontFamily: "Inter_700Bold",
                    color: active ? colors.primary : colors.mutedForeground,
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
              style={{ flex: 1, fontSize: 14, color: colors.foreground, fontFamily: "Inter_400Regular", padding: 0 }}
              returnKeyType="search"
              clearButtonMode="while-editing"
              autoCorrect={false}
              autoCapitalize="none"
            />
          ) : (
            <TextInput
              value={seriesQuery}
              onChangeText={handleSeriesQueryChange}
              placeholder="Search by series name, club, state…"
              placeholderTextColor={colors.mutedForeground}
              style={{ flex: 1, fontSize: 14, color: colors.foreground, fontFamily: "Inter_400Regular", padding: 0 }}
              returnKeyType="search"
              clearButtonMode="while-editing"
              autoCorrect={false}
              autoCapitalize="none"
            />
          )}
          {(tab === "races" ? racesQuery : seriesQuery).length > 0 && (
            <Pressable
              onPress={() => {
                if (tab === "races") { setRacesQuery(""); setRacesDebouncedQ(""); }
                else { setSeriesQuery(""); setSeriesDebouncedQ(""); }
              }}
              hitSlop={8}
            >
              <Feather name="x-circle" size={16} color={colors.mutedForeground} />
            </Pressable>
          )}
        </View>
      </View>

      {/* ── RACES TAB ─────────────────────────────────────────────────────────── */}
      {tab === "races" && (
        <ScrollView
          refreshControl={<RefreshControl refreshing={eventsRefreshing} onRefresh={async () => { setEventsRefreshing(true); await loadEvents(racesDebouncedQ); }} tintColor={colors.primary} />}
        >
          {eventsLoading ? (
            <View style={{ paddingVertical: 80, alignItems: "center" }}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : events.length === 0 ? (
            <View style={{ paddingVertical: 80, alignItems: "center", paddingHorizontal: 32, gap: 8 }}>
              <Feather name="flag" size={36} color={colors.mutedForeground + "60"} />
              <Text style={{ fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>
                {racesDebouncedQ ? "No matching races" : "No races yet"}
              </Text>
              <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>
                {racesDebouncedQ
                  ? "Try a different search — state abbreviation, city, track name, or event name."
                  : "Live and completed races will appear here."}
              </Text>
            </View>
          ) : (
            <>
              {liveEvents.length > 0 && (
                <>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 10 }}>
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: "#ef4444" }} />
                    <Text style={{ fontSize: 11, fontWeight: "700", color: "#ef4444", fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>
                      Live Now
                    </Text>
                    <View style={{ marginLeft: 4, backgroundColor: "#ef444420", paddingHorizontal: 6, paddingVertical: 1, borderRadius: 10 }}>
                      <Text style={{ fontSize: 10, fontWeight: "700", color: "#ef4444", fontFamily: "Inter_700Bold" }}>{liveEvents.length}</Text>
                    </View>
                  </View>
                  {liveEvents.map(e => (
                    <EventCard key={e.eventId} event={e} colors={colors} onPress={() => setSelectedEvent(e)} />
                  ))}
                </>
              )}

              {pastEvents.length > 0 && (
                <>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: liveEvents.length > 0 ? 8 : 20, paddingBottom: 10 }}>
                    <Feather name="flag" size={12} color={colors.primary} />
                    <Text style={{ fontSize: 11, fontWeight: "700", color: colors.primary, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>
                      Past Races
                    </Text>
                    <Text style={{ marginLeft: "auto", fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                      {pastEvents.length} events
                    </Text>
                  </View>
                  {pastEvents.map(e => (
                    <EventCard key={e.eventId} event={e} colors={colors} onPress={() => setSelectedEvent(e)} />
                  ))}
                </>
              )}

              <View style={{ height: insets.bottom + 40 }} />
            </>
          )}
        </ScrollView>
      )}

      {/* ── SERIES TAB ────────────────────────────────────────────────────────── */}
      {tab === "series" && (
        <ScrollView
          refreshControl={<RefreshControl refreshing={seriesRefreshing} onRefresh={async () => { setSeriesRefreshing(true); await loadSeries(seriesDebouncedQ); }} tintColor={colors.primary} />}
        >
          {seriesLoading ? (
            <View style={{ paddingVertical: 80, alignItems: "center" }}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : filteredSeries.length === 0 ? (
            <View style={{ paddingVertical: 80, alignItems: "center", paddingHorizontal: 32, gap: 8 }}>
              <Feather name="award" size={36} color={colors.mutedForeground + "60"} />
              <Text style={{ fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>
                {seriesDebouncedQ ? "No matching series" : "No series yet"}
              </Text>
              <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>
                {seriesDebouncedQ
                  ? "Try a different search — series name, club name, or state."
                  : "Championship series will appear here once clubs create them."}
              </Text>
            </View>
          ) : (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 10 }}>
                <Feather name="award" size={12} color={colors.primary} />
                <Text style={{ fontSize: 11, fontWeight: "700", color: colors.primary, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>
                  Championship Series
                </Text>
                <Text style={{ marginLeft: "auto", fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                  {filteredSeries.length} series
                </Text>
              </View>
              {filteredSeries.map(s => (
                <SeriesCard key={s.id} series={s} colors={colors} onPress={() => setSelectedSeries(s)} />
              ))}
              <View style={{ height: insets.bottom + 40 }} />
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}
