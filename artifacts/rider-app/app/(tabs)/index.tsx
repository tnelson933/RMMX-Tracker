import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BrandBar } from "@/components/BrandBar";
import {
  EventDetailScreen,
  EventHistory,
  EventsListScreen,
  PointsScreen,
  SeriesStandingsScreen,
  ViewState,
} from "@/components/RaceSubScreens";
import { RockyHomeWidget } from "@/components/RockyHomeWidget";
import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";

const ACCENT = "#cf152d";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function greeting(firstName: string): string {
  const h = new Date().getHours();
  const time = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  return `Good ${time}, ${firstName}!`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const normalized = iso.includes("T") ? iso : iso + "T12:00:00";
  return new Date(normalized).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtToday(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface UpcomingEvent {
  eventId: number;
  eventName: string;
  eventDate: string | null;
  eventState: string | null;
  eventLocation: string | null;
  status: string;
  registrations: { raceClass: string | null }[];
  isRegistered?: boolean;
}

// ─── Stat box ─────────────────────────────────────────────────────────────────

function StatBox({ label, value, onPress, colors }: {
  label: string;
  value: string;
  onPress?: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1, backgroundColor: colors.card, borderRadius: 12, padding: 14,
        alignItems: "center", borderWidth: 1, borderColor: colors.border,
        opacity: pressed ? 0.7 : 1,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 }}>{label}</Text>
      <Text style={{ fontSize: 22, fontWeight: "800", color: ACCENT, fontFamily: "Inter_700Bold", letterSpacing: -0.5 }}>{value}</Text>
      {onPress && (
        <Feather name="chevron-right" size={10} color={colors.mutedForeground + "80"} style={{ position: "absolute", right: 8, top: "50%", marginTop: -5 }} />
      )}
    </Pressable>
  );
}

// ─── Upcoming event card ──────────────────────────────────────────────────────

function UpcomingEventCard({ event, colors, onPress }: { event: UpcomingEvent; colors: ReturnType<typeof useColors>; onPress: () => void }) {
  const isLive = event.status === "race_day";
  const classes = [...new Set((event.registrations ?? []).map(r => r.raceClass).filter(Boolean))].slice(0, 2);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        marginHorizontal: 16, marginBottom: 10, borderRadius: 12,
        backgroundColor: colors.card,
        borderWidth: isLive ? 1.5 : 1,
        borderColor: isLive ? "#ef4444" : colors.border,
        padding: 14,
        opacity: pressed ? 0.82 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 14, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }} numberOfLines={1}>
          {event.eventName}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {event.isRegistered && (
            <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: ACCENT + "20" }}>
              <Text style={{ fontSize: 10, fontWeight: "700", color: ACCENT, fontFamily: "Inter_700Bold" }}>REG'D</Text>
            </View>
          )}
          {isLive ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: "#ef444420" }}>
              <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: "#ef4444" }} />
              <Text style={{ fontSize: 10, fontWeight: "700", color: "#ef4444", fontFamily: "Inter_700Bold" }}>LIVE</Text>
            </View>
          ) : (
            <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, backgroundColor: "#22c55e20" }}>
              <Text style={{ fontSize: 10, fontWeight: "700", color: "#22c55e", fontFamily: "Inter_700Bold" }}>OPEN</Text>
            </View>
          )}
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
        <Feather name="calendar" size={11} color={colors.mutedForeground} />
        <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
          {fmtDate(event.eventDate)}
          {event.eventLocation ? ` · ${event.eventLocation}` : event.eventState ? ` · ${event.eventState}` : ""}
        </Text>
      </View>
      {classes.length > 0 && (
        <View style={{ flexDirection: "row", gap: 6, marginTop: 8 }}>
          {classes.map(cls => (
            <View key={cls} style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: ACCENT + "18" }}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: ACCENT, fontFamily: "Inter_600SemiBold" }}>{cls}</Text>
            </View>
          ))}
        </View>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 3, marginTop: 8 }}>
        <Text style={{ fontSize: 11, color: colors.mutedForeground + "90", fontFamily: "Inter_400Regular" }}>View details</Text>
        <Feather name="chevron-right" size={11} color={colors.mutedForeground + "90"} />
      </View>
    </Pressable>
  );
}

// ─── Recent result card ───────────────────────────────────────────────────────

function RecentResultCard({ result, colors, onPress }: { result: EventHistory; colors: ReturnType<typeof useColors>; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        marginHorizontal: 16, marginBottom: 10, borderRadius: 12,
        backgroundColor: colors.card,
        borderWidth: 1, borderColor: colors.border,
        padding: 14, flexDirection: "row", alignItems: "center", gap: 12,
        opacity: pressed ? 0.82 : 1,
      })}
    >
      {/* Position badge */}
      <View style={{
        width: 44, height: 44, borderRadius: 10,
        backgroundColor: result.bestPosition != null && result.bestPosition <= 3
          ? ACCENT + "20"
          : colors.muted,
        alignItems: "center", justifyContent: "center",
        borderWidth: result.bestPosition != null && result.bestPosition <= 3 ? 1 : 0,
        borderColor: ACCENT + "44",
      }}>
        {result.bestPosition != null ? (
          <Text style={{ fontSize: 14, fontWeight: "800", color: result.bestPosition <= 3 ? ACCENT : colors.foreground, fontFamily: "Inter_700Bold" }}>
            P{result.bestPosition}
          </Text>
        ) : (
          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>—</Text>
        )}
      </View>

      {/* Event info */}
      <View style={{ flex: 1 }}>
        {result.riderName && (
          <Text style={{ fontSize: 10, fontWeight: "600", color: ACCENT, fontFamily: "Inter_600SemiBold", marginBottom: 1 }}>{result.riderName}</Text>
        )}
        <Text style={{ fontSize: 13, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }} numberOfLines={1}>{result.eventName}</Text>
        <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>
          {fmtDate(result.eventDate)} · {result.raceClass}
        </Text>
      </View>

      {/* Points */}
      {result.totalPoints > 0 && (
        <View style={{ alignItems: "flex-end" }}>
          <Text style={{ fontSize: 16, fontWeight: "800", color: colors.primary, fontFamily: "Inter_700Bold" }}>{result.totalPoints}</Text>
          <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>pts</Text>
        </View>
      )}
    </Pressable>
  );
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ icon, title, colors }: { icon: string; title: string; colors: ReturnType<typeof useColors> }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginHorizontal: 16, marginBottom: 10, marginTop: 4 }}>
      <Feather name={icon as any} size={12} color={ACCENT} />
      <Text style={{ fontSize: 11, fontWeight: "700", color: ACCENT, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>{title}</Text>
    </View>
  );
}

// ─── No profile empty state ───────────────────────────────────────────────────

function NoProfileCard({ colors }: { colors: ReturnType<typeof useColors> }) {
  const router = useRouter();
  return (
    <View style={{ marginHorizontal: 16, marginBottom: 24, borderRadius: 14, backgroundColor: colors.card, padding: 20, alignItems: "center", gap: 8, borderWidth: 1, borderColor: colors.border }}>
      <Feather name="user-x" size={32} color={colors.mutedForeground + "70"} />
      <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>No Rider Profile</Text>
      <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 18 }}>
        Register for an event with your email address to link a rider profile.
      </Text>
      <Pressable
        onPress={() => router.push("/(tabs)/profile" as any)}
        style={{ marginTop: 4, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 10, backgroundColor: colors.primary }}
      >
        <Text style={{ color: "#fff", fontSize: 13, fontWeight: "700", fontFamily: "Inter_700Bold" }}>Go to Profile</Text>
      </Pressable>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { activeProfiles, profiles, riderFetch } = useRiderAuth();

  const primaryProfile = activeProfiles[0] ?? null;

  const [upcoming, setUpcoming] = useState<UpcomingEvent[]>([]);
  const [recentResults, setRecentResults] = useState<EventHistory[]>([]);
  const [allHistory, setAllHistory] = useState<EventHistory[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // View stack for stat-box drill-down
  const [viewStack, setViewStack] = useState<ViewState[]>([]);
  const currentView = viewStack.length > 0 ? viewStack[viewStack.length - 1] : null;
  const pushView = useCallback((v: ViewState) => setViewStack(prev => [...prev, v]), []);
  const popView  = useCallback(() => setViewStack(prev => prev.slice(0, -1)), []);

  // Aggregated stats
  const combinedEventsRaced = activeProfiles.reduce((n, p) => n + p.eventsRaced, 0);
  const combinedTotalPoints = activeProfiles.reduce((n, p) => n + p.totalPoints, 0);
  const combinedBestPosition = activeProfiles.reduce<number | null>((best, p) => {
    if (p.bestPosition == null) return best;
    if (best == null) return p.bestPosition;
    return Math.min(best, p.bestPosition);
  }, null);

  const activeProfileKey = activeProfiles.map(p => p.id).join(",");

  const loadData = useCallback(async () => {
    if (!primaryProfile) return;
    setLoading(true);
    try {
      const [schedRes, ...histResponses] = await Promise.all([
        riderFetch(`/api/rider/profiles/${primaryProfile.id}/schedule`),
        ...activeProfiles.map(p => riderFetch(`/api/rider/profiles/${p.id}/history`)),
      ]);
      if (schedRes.ok) {
        const sched = await schedRes.json();
        const evts: UpcomingEvent[] = (sched.events ?? [])
          .filter((e: any) => e.status === "registration_open" || e.status === "race_day")
          .map((e: any) => ({
            eventId: e.eventId,
            eventName: e.eventName,
            eventDate: e.eventDate ?? null,
            eventState: e.eventState ?? null,
            eventLocation: e.eventLocation ?? null,
            status: e.status,
            registrations: (e.registrations ?? []).map((r: any) => ({ raceClass: r.raceClass })),
            isRegistered: true,
          }));
        setUpcoming(evts);
      }
      const isMulti = activeProfiles.length > 1;
      const allResults: EventHistory[] = [];
      for (let i = 0; i < histResponses.length; i++) {
        if (!histResponses[i].ok) continue;
        const h = await histResponses[i].json();
        const prof = activeProfiles[i];
        const riderName = isMulti && prof ? `${prof.firstName} ${prof.lastName}` : undefined;
        for (const ev of (h.history ?? [])) {
          allResults.push(riderName ? { ...ev, riderName } : ev);
        }
      }
      allResults.sort((a, b) => new Date(b.eventDate).getTime() - new Date(a.eventDate).getTime());
      setAllHistory(allResults);
      setRecentResults(allResults.slice(0, 3));
    } catch { /* silently fail */ }
    finally { setLoading(false); }
  }, [activeProfileKey, riderFetch]);

  useEffect(() => { if (primaryProfile) void loadData(); }, [activeProfileKey]);

  // Poll every 15 s when there's a live race-day event
  const hasLiveEvent = upcoming.some(e => e.status === "race_day");
  useEffect(() => {
    if (!hasLiveEvent || !primaryProfile) return;
    const timer = setInterval(() => { void loadData(); }, 15_000);
    return () => clearInterval(timer);
  }, [hasLiveEvent, loadData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  // ── Stat box tap handlers ────────────────────────────────────────────────────

  function handleTapEvents() {
    pushView({ type: "events" });
  }

  function handleTapPoints() {
    pushView({ type: "points" });
  }

  function handleTapBestFinish() {
    const bestPos = combinedBestPosition;
    if (bestPos == null || allHistory.length === 0) {
      pushView({ type: "events" });
      return;
    }
    const sorted = [...allHistory].sort((a, b) =>
      new Date(b.eventDate ?? 0).getTime() - new Date(a.eventDate ?? 0).getTime()
    );
    const best = sorted.find(e => e.bestPosition === bestPos);
    if (best) pushView({ type: "event_detail", event: best });
    else      pushView({ type: "events" });
  }

  // ── Sub-screen rendering ─────────────────────────────────────────────────────

  if (currentView) {
    if (currentView.type === "events") {
      return (
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <EventsListScreen
            events={allHistory}
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
        <View style={{ flex: 1, backgroundColor: colors.background }}>
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
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <PointsScreen
            events={allHistory}
            totalPoints={combinedTotalPoints}
            onBack={popView}
            pushView={pushView}
            riderFetch={riderFetch}
            riderIds={activeProfiles.map(p => p.id)}
            colors={colors}
            insets={insets}
          />
        </View>
      );
    }
    if (currentView.type === "series_standings") {
      return (
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <SeriesStandingsScreen
            seriesId={currentView.seriesId}
            seriesName={currentView.seriesName}
            riderClass={currentView.riderClass}
            riderPosition={currentView.riderPosition}
            riderPoints={currentView.riderPoints}
            riderIds={currentView.riderIds}
            onBack={popView}
            colors={colors}
            insets={insets}
            riderFetch={riderFetch}
          />
        </View>
      );
    }
  }

  const hasProfile = profiles.length > 0;
  const hasStats = combinedEventsRaced > 0 || combinedTotalPoints > 0 || combinedBestPosition != null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
      >
        {/* ── Hero header ── */}
        <View style={{
          paddingTop: insets.top + 16,
          paddingHorizontal: 20,
          paddingBottom: 24,
          backgroundColor: colors.card,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          marginBottom: 20,
        }}>
          <BrandBar />

          {/* Greeting */}
          <View style={{ marginTop: 14 }}>
            <Text style={{ fontSize: 28, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", letterSpacing: -0.5 }}>
              {primaryProfile ? greeting(primaryProfile.firstName) : "Welcome Back!"}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 }}>
              <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                {fmtToday()}{primaryProfile && hasStats ? " · Let's ride" : ""}
              </Text>
            </View>
          </View>

          {/* Stats row — only show if logged in with a profile */}
          {primaryProfile && (
            <View style={{ flexDirection: "row", gap: 10, marginTop: 18 }}>
              <StatBox
                label="Events"
                value={String(combinedEventsRaced)}
                onPress={handleTapEvents}
                colors={colors}
              />
              <StatBox
                label="Points"
                value={String(combinedTotalPoints)}
                onPress={handleTapPoints}
                colors={colors}
              />
              <StatBox
                label="Best Finish"
                value={combinedBestPosition != null ? `P${combinedBestPosition}` : "—"}
                onPress={handleTapBestFinish}
                colors={colors}
              />
            </View>
          )}
        </View>

        {/* ── No profile warning ── */}
        {!hasProfile && <NoProfileCard colors={colors} />}

        {/* ── Rocky inline chat ── */}
        <RockyHomeWidget />

        {/* ── Upcoming events ── */}
        {hasProfile && (
          <>
            <SectionHeader icon="calendar" title="My Upcoming Events" colors={colors} />
            {loading && upcoming.length === 0 ? (
              <View style={{ alignItems: "center", paddingVertical: 20 }}>
                <ActivityIndicator color={ACCENT} size="small" />
              </View>
            ) : upcoming.length > 0 ? (
              upcoming.map(e => <UpcomingEventCard key={e.eventId} event={e} colors={colors} onPress={() => router.push(`/event/${e.eventId}` as any)} />)
            ) : (
              <View style={{ marginHorizontal: 16, marginBottom: 24, padding: 20, borderRadius: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, alignItems: "center", gap: 6 }}>
                <Feather name="calendar" size={24} color={colors.mutedForeground + "60"} />
                <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>You're not registered for any upcoming events.</Text>
              </View>
            )}
          </>
        )}

        {/* ── Recent results ── */}
        {hasProfile && (
          <>
            <SectionHeader icon="award" title="Recent Results" colors={colors} />
            {loading && recentResults.length === 0 ? (
              <View style={{ alignItems: "center", paddingVertical: 20 }}>
                <ActivityIndicator color={ACCENT} size="small" />
              </View>
            ) : recentResults.length > 0 ? (
              recentResults.map((r, i) => (
                <RecentResultCard
                  key={`${r.eventId}-${i}`}
                  result={r}
                  colors={colors}
                  onPress={() => pushView({ type: "event_detail", event: r })}
                />
              ))
            ) : (
              <View style={{ marginHorizontal: 16, marginBottom: 24, padding: 20, borderRadius: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, alignItems: "center", gap: 6 }}>
                <Feather name="award" size={24} color={colors.mutedForeground + "60"} />
                <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>Race results will appear here once events complete.</Text>
              </View>
            )}
          </>
        )}

        {/* Footer */}
        <View style={{ height: insets.bottom + 40 }} />
      </ScrollView>
    </View>
  );
}
