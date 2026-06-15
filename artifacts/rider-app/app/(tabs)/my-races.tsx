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

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtLap(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "—";
  const totalSec = ms / 1000;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0
    ? `${mins}:${secs.toFixed(3).padStart(6, "0")}`
    : `${secs.toFixed(3)}s`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface FamilyGate { gate: number; riderId: number; riderName: string }
interface LineupEntry { gate: number; riderId: number; riderName: string; bibNumber: string | null; isFamilyMember: boolean }
interface PracticeLap { riderId: number; lapNumber: number; lapTimeMs: number | null }
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
}

type FilterTab = "today" | "upcoming" | "near_me" | "history";

const FILTER_TABS: { key: FilterTab; label: string; icon: string }[] = [
  { key: "today",    label: "Today",        icon: "zap" },
  { key: "upcoming", label: "Upcoming",     icon: "calendar" },
  { key: "near_me",  label: "Near Me",      icon: "map-pin" },
  { key: "history",  label: "Race History", icon: "award" },
];

// ─── Sub-components ──────────────────────────────────────────────────────────

function SectionHeader({ title, icon, color }: { title: string; icon: string; color: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginHorizontal: 16, marginTop: 20, marginBottom: 8 }}>
      <Feather name={icon as any} size={13} color={color} />
      <Text style={{ fontSize: 11, fontWeight: "700", color, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>
        {title}
      </Text>
    </View>
  );
}

function MotoStatusBadge({ status, colors }: { status: string; colors: ReturnType<typeof useColors> }) {
  const config: Record<string, { label: string; bg: string; fg: string }> = {
    scheduled: { label: "Scheduled", bg: colors.muted, fg: colors.mutedForeground },
    in_progress: { label: "Live Now", bg: "#ef444422", fg: "#ef4444" },
    completed: { label: "Completed", bg: colors.primary + "22", fg: colors.primary },
  };
  const c = config[status] ?? { label: status, bg: colors.muted, fg: colors.mutedForeground };
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: c.bg }}>
      <Text style={{ fontSize: 10, fontWeight: "700", color: c.fg, fontFamily: "Inter_700Bold" }}>
        {status === "in_progress" ? "🔴 " : ""}{c.label}
      </Text>
    </View>
  );
}

function ScheduleMotoRow({ moto, colors }: { moto: ScheduleMoto; colors: ReturnType<typeof useColors> }) {
  const isPractice = moto.type === "practice";
  const myGates = moto.familyGates;
  const myBestLap = moto.practiceLaps && moto.practiceLaps.length > 0
    ? Math.min(...moto.practiceLaps.filter(l => (l.lapTimeMs ?? 0) > 0).map(l => l.lapTimeMs!))
    : null;
  const myRank = moto.practiceLeaderboard?.find(e => e.isMe)?.rank ?? null;
  const isHighlighted = moto.isAnyFamilyMemberInMoto;

  return (
    <View style={{
      paddingHorizontal: 14, paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
      backgroundColor: isHighlighted ? colors.primary + "08" : "transparent",
      flexDirection: "row", alignItems: "flex-start", gap: 10,
    }}>
      {isHighlighted && (
        <View style={{ width: 3, backgroundColor: colors.primary, borderRadius: 2, alignSelf: "stretch", marginRight: 2 }} />
      )}
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Text style={{ fontSize: 14, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
            {moto.name as string}
          </Text>
          {isPractice && (
            <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: "#f59e0b22" }}>
              <Text style={{ fontSize: 10, fontWeight: "700", color: "#f59e0b", fontFamily: "Inter_700Bold" }}>PRACTICE</Text>
            </View>
          )}
        </View>
        {moto.scheduledTime && moto.status === "scheduled" && (
          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
            🕐 {moto.scheduledTime}
          </Text>
        )}
        {!isPractice && myGates.length > 0 && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
            {myGates.map(g => (
              <View key={g.gate} style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.primary + "18", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                <Feather name="flag" size={10} color={colors.primary} />
                <Text style={{ fontSize: 12, fontWeight: "600", color: colors.primary, fontFamily: "Inter_600SemiBold" }}>
                  Gate {g.gate} · {g.riderName}
                </Text>
              </View>
            ))}
          </View>
        )}
        {!isPractice && myGates.length === 0 && isHighlighted && moto.status === "scheduled" && (
          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", fontStyle: "italic" }}>
            Gate draw pending
          </Text>
        )}
        {isPractice && isHighlighted && (myBestLap != null || moto.status === "in_progress") && (
          <View style={{ flexDirection: "row", gap: 12, marginTop: 2 }}>
            {myBestLap != null && (
              <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: colors.foreground }}>
                Best: <Text style={{ color: colors.primary, fontWeight: "700" }}>{fmtLap(myBestLap)}</Text>
              </Text>
            )}
            {myRank != null && (
              <Text style={{ fontSize: 12, fontFamily: "Inter_500Medium", color: colors.mutedForeground }}>
                Rank: <Text style={{ color: colors.foreground, fontWeight: "700" }}>P{myRank}</Text> of {moto.practiceLeaderboard?.length}
              </Text>
            )}
          </View>
        )}
      </View>
      <MotoStatusBadge status={moto.status} colors={colors} />
    </View>
  );
}

function RaceDayCard({ event, colors }: { event: ScheduleEvent; colors: ReturnType<typeof useColors> }) {
  const myClasses = [...new Set(event.registrations.map(r => r.raceClass).filter(Boolean))];
  const myRiders = [...new Set(event.registrations.map(r => r.riderName))];
  const nextMoto = event.motos.find(m => m.status === "scheduled" && m.isAnyFamilyMemberInMoto);

  return (
    <View style={{ marginHorizontal: 16, marginBottom: 12, borderRadius: 12, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.card }}>
      <View style={{ padding: 14, backgroundColor: "#ef444410", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: "#ef4444", flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#fff" }} />
            <Text style={{ fontSize: 10, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold", letterSpacing: 0.5 }}>RACE DAY</Text>
          </View>
        </View>
        <Text style={{ fontSize: 16, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
          {event.eventName}
        </Text>
        <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
          {[event.eventLocation, event.eventState].filter(Boolean).join(", ")}
          {event.eventDate ? `  ·  ${fmtDate(event.eventDate)}` : ""}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
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
        {nextMoto && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10, padding: 8, backgroundColor: "#ef444418", borderRadius: 8 }}>
            <Feather name="alert-circle" size={13} color="#ef4444" />
            <Text style={{ fontSize: 12, fontWeight: "600", color: "#ef4444", fontFamily: "Inter_600SemiBold", flex: 1 }}>
              Up next: {nextMoto.name as string}
              {nextMoto.scheduledTime ? ` at ${nextMoto.scheduledTime}` : ""}
            </Text>
          </View>
        )}
      </View>
      {event.motos.map(moto => (
        <ScheduleMotoRow key={moto.motoId} moto={moto} colors={colors} />
      ))}
    </View>
  );
}

function UpcomingCard({ event, colors }: { event: ScheduleEvent; colors: ReturnType<typeof useColors> }) {
  const myClasses = [...new Set(event.registrations.map(r => r.raceClass).filter(Boolean))];
  return (
    <View style={{ marginHorizontal: 16, marginBottom: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.card, padding: 14 }}>
      <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
        {event.eventName}
      </Text>
      <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
        {fmtDate(event.eventDate)} · {[event.eventLocation, event.eventState].filter(Boolean).join(", ")}
      </Text>
      {myClasses.length > 0 && (
        <View style={{ flexDirection: "row", gap: 6, marginTop: 8 }}>
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
    </View>
  );
}


function HistoryCard({ event, colors }: { event: EventHistory; colors: ReturnType<typeof useColors> }) {
  return (
    <View style={{ marginHorizontal: 16, marginBottom: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.card, overflow: "hidden" }}>
      <View style={{ padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" }}>
        <View style={{ flex: 1, gap: 2 }}>
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
        <View key={moto.motoId} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
          <Text style={{ flex: 1, fontSize: 13, color: colors.foreground, fontFamily: "Inter_500Medium" }}>{moto.motoName}</Text>
          {moto.totalTime && (
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginRight: 8 }}>
              {moto.totalTime}
            </Text>
          )}
          {moto.points != null && moto.points > 0 && (
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginRight: 8 }}>{moto.points}pts</Text>
          )}
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
    </View>
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

// ─── Main screen ─────────────────────────────────────────────────────────────

export default function MyRacesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading, profiles, riderFetch } = useRiderAuth();

  const [activeFilter, setActiveFilter] = useState<FilterTab>("today");
  const [schedule, setSchedule] = useState<{ familyRiderIds: number[]; events: ScheduleEvent[] } | null>(null);
  const [history, setHistory] = useState<EventHistory[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nearMeState, setNearMeState] = useState<string | null>(null);
  const [locationLoading, setLocationLoading] = useState(false);

  const primaryProfile = profiles[0] ?? null;

  const loadAll = useCallback(async () => {
    if (!primaryProfile) return;
    setError(null);
    setLoading(true);
    try {
      const [schedRes, histRes] = await Promise.all([
        riderFetch(`/api/rider/profiles/${primaryProfile.id}/schedule`),
        riderFetch(`/api/rider/profiles/${primaryProfile.id}/history`),
      ]);
      if (schedRes.ok) setSchedule(await schedRes.json());
      if (histRes.ok) {
        const h = await histRes.json();
        setHistory(h.history ?? []);
      }
    } catch {
      setError("Couldn't load your racing data. Pull to refresh.");
    } finally {
      setLoading(false);
    }
  }, [primaryProfile?.id, riderFetch]);

  useEffect(() => {
    if (isAuthenticated && primaryProfile) void loadAll();
  }, [isAuthenticated, primaryProfile?.id]);

  // Fetch user's state when Near Me tab is selected
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
      } catch {
        // silently fail — we'll show all events
      } finally {
        setLocationLoading(false);
      }
    })();
  }, [activeFilter]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }, [loadAll]);

  const raceDay   = schedule?.events.filter(e => e.status === "race_day") ?? [];
  const upcoming  = schedule?.events.filter(e => e.status === "registration_open") ?? [];

  // Near Me: all my events (race_day + upcoming) filtered by the user's state
  const nearMeEvents = nearMeState
    ? [...raceDay, ...upcoming].filter(e => e.eventState === nearMeState)
    : [...raceDay, ...upcoming];

  const styles = StyleSheet.create({
    container:     { flex: 1, backgroundColor: colors.background },
    header:        { paddingTop: insets.top + 16, paddingHorizontal: 20, paddingBottom: 16, backgroundColor: colors.background, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    headerTitle:   { fontSize: 26, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", letterSpacing: -0.5 },
    statsRow:      { flexDirection: "row", gap: 10, marginTop: 12 },
    statBox:       { flex: 1, backgroundColor: colors.muted, borderRadius: 10, padding: 12, alignItems: "center" },
    statValue:     { fontSize: 20, fontWeight: "700", color: colors.primary, fontFamily: "Inter_700Bold" },
    statLabel:     { fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_500Medium", marginTop: 2, textTransform: "uppercase", letterSpacing: 0.5 },
    filterBar:     { flexDirection: "row", paddingHorizontal: 10, paddingVertical: 8, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.background },
    filterChip:    { flex: 1, flexDirection: "column", alignItems: "center", justifyContent: "center", paddingVertical: 7, borderRadius: 8, borderWidth: 1 },
    footer:        { height: insets.bottom + 32 },
  });

  if (authLoading) {
    return <View style={[styles.container, { flex: 1, alignItems: "center", justifyContent: "center" }]}><ActivityIndicator color={colors.primary} /></View>;
  }

  if (!isAuthenticated) {
    return (
      <View style={[styles.container, { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }]}>
        <Feather name="award" size={48} color={colors.mutedForeground} />
        <Text style={{ fontSize: 18, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>Your racing lives here</Text>
        <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>Sign in to see your race schedule, practice laps, and results.</Text>
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
        <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 }}>Register for an event using this email address to link your rider profile.</Text>
      </View>
    );
  }

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
          <>
            <SectionHeader title="Race Day" icon="zap" color="#ef4444" />
            {raceDay.map(e => <RaceDayCard key={e.eventId} event={e} colors={colors} />)}
          </>
        ) : (
          <EmptyState icon="zap" title="No events today" text="You have no races scheduled for today. Check Upcoming for what's next." colors={colors} />
        );

      case "upcoming":
        return upcoming.length > 0 ? (
          <>
            <SectionHeader title="Upcoming Events" icon="calendar" color={colors.primary} />
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
            <SectionHeader
              title={nearMeState ? `Events in ${nearMeState}` : "Nearby Events"}
              icon="map-pin"
              color={colors.primary}
            />
            {nearMeEvents.map(e =>
              e.status === "race_day"
                ? <RaceDayCard key={e.eventId} event={e} colors={colors} />
                : <UpcomingCard key={e.eventId} event={e} colors={colors} />
            )}
          </>
        ) : (
          <EmptyState
            icon="map-pin"
            title={nearMeState ? `No events in ${nearMeState}` : "No nearby events"}
            text="None of your registered events are in your current area."
            colors={colors}
          />
        );

      case "history":
        return history.length > 0 ? (
          <>
            <SectionHeader title="Race History" icon="award" color={colors.primary} />
            {history.map(e => <HistoryCard key={e.eventId} event={e} colors={colors} />)}
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
        <Text style={styles.headerTitle}>My Racing</Text>
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{primaryProfile.eventsRaced}</Text>
            <Text style={styles.statLabel}>Events</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>{primaryProfile.totalPoints}</Text>
            <Text style={styles.statLabel}>Points</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statValue}>
              {primaryProfile.bestPosition != null ? `P${primaryProfile.bestPosition}` : "—"}
            </Text>
            <Text style={styles.statLabel}>Best Finish</Text>
          </View>
        </View>
      </View>

      {/* Filter tab bar */}
      <View style={styles.filterBar}>
        {FILTER_TABS.map(tab => {
          const active = activeFilter === tab.key;
          return (
            <Pressable
              key={tab.key}
              style={[styles.filterChip, {
                backgroundColor: active ? colors.primary : colors.muted,
                borderColor: active ? colors.primary : colors.border,
              }]}
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
