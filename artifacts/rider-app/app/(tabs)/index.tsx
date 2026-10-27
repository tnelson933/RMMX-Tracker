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
import { FollowingFeed } from "@/components/FollowingFeed";
import { useColors } from "@/hooks/useColors";
import { useRiderAuth } from "@/context/AuthContext";
import { NoProfileLinked } from "@/components/NoProfileLinked";
import { EmptyState } from "@/components/EmptyState";
import { PositionBadge } from "@/components/RaceStats";
import { displayDate, placeLabel } from "@/lib/format";
import { EventCard, ResultCard } from "@/components/RaceCards";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function greeting(firstName: string): string {
  const h = new Date().getHours();
  const time = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  return `Good ${time}, ${firstName}!`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return displayDate(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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

// ─── Upcoming event card ──────────────────────────────────────────────────────

function UpcomingEventCard({ event, colors, onPress }: { event: UpcomingEvent; colors: ReturnType<typeof useColors>; onPress: () => void }) {
  const isLive = event.status === "race_day";
  const classes = [...new Set((event.registrations ?? []).map(r => r.raceClass).filter((c): c is string => !!c))].slice(0, 2);
  return (
    <EventCard
      title={event.eventName}
      dateIso={event.eventDate}
      place={placeLabel(event.eventLocation, event.eventState) || null}
      classes={classes}
      status={isLive ? "live" : "open"}
      registered={event.isRegistered}
      onPress={onPress}
    />
  );
}

// ─── Recent result card ───────────────────────────────────────────────────────

function RecentResultCard({ result, colors, onPress }: { result: EventHistory; colors: ReturnType<typeof useColors>; onPress: () => void }) {
  return (
    <ResultCard
      position={result.bestPosition}
      kicker={result.riderName}
      title={result.eventName}
      dateIso={result.eventDate}
      raceClass={result.raceClass}
      points={result.totalPoints}
      motos={result.motos}
      onPress={onPress}
    />
  );
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ icon, title, colors }: { icon: string; title: string; colors: ReturnType<typeof useColors> }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginHorizontal: 16, marginBottom: 10, marginTop: 4 }}>
      <Feather name={icon as any} size={12} color={colors.primary} />
      <Text style={{ fontSize: 11, fontWeight: "700", color: colors.primary, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>{title}</Text>
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

  const [feedRefreshKey, setFeedRefreshKey] = useState(0);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setFeedRefreshKey(k => k + 1);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

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
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
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
            <Text style={{ fontSize: 24, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", letterSpacing: 0.8, textTransform: "uppercase" }} numberOfLines={1} adjustsFontSizeToFit>
              {primaryProfile ? greeting(primaryProfile.firstName) : "Welcome Back!"}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 }}>
              <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                {fmtToday()}{primaryProfile && hasStats ? " · Let's ride" : ""}
              </Text>
            </View>
          </View>

        </View>

        {/* ── No profile warning ── */}
        {!hasProfile && <NoProfileLinked variant="card" />}

        {/* ── Rocky: AI mechanic, up front ── */}
        <View style={{ marginTop: 18 }}>
          <RockyHomeWidget />
        </View>

        {/* ── Upcoming events ── */}
        {hasProfile && (
          <>
            <SectionHeader icon="calendar" title="My Upcoming Events" colors={colors} />
            {loading && upcoming.length === 0 ? (
              <View style={{ alignItems: "center", paddingVertical: 20 }}>
                <ActivityIndicator color={colors.primary} size="small" />
              </View>
            ) : upcoming.length > 0 ? (
              upcoming.map(e => <UpcomingEventCard key={e.eventId} event={e} colors={colors} onPress={() => router.push(`/event/${e.eventId}` as any)} />)
            ) : (
              <EmptyState
                variant="card"
                icon="flag"
                title="Your next race awaits"
                message="Nothing on your calendar yet. Find an open race near you and lock in your gate."
                primary={{ label: "Find a race", onPress: () => router.push("/(tabs)/my-races?filter=near_me" as any) }}
              />
            )}
          </>
        )}

        {/* ── Recent results ── */}
        {hasProfile && (
          <>
            <SectionHeader icon="award" title="Recent Results" colors={colors} />
            {loading && recentResults.length === 0 ? (
              <View style={{ alignItems: "center", paddingVertical: 20 }}>
                <ActivityIndicator color={colors.primary} size="small" />
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
              <EmptyState
                variant="card"
                icon="award"
                title="No results yet"
                message="Your finishes, points and lap times show up here after your first race."
                primary={{ label: "Find a race", onPress: () => router.push("/(tabs)/my-races?filter=near_me" as any) }}
              />
            )}
          </>
        )}

        {/* ── Riders you follow ── */}
        {hasProfile && <FollowingFeed refreshKey={feedRefreshKey} />}

        {/* Footer */}
        <View style={{ height: insets.bottom + 40 }} />
      </ScrollView>
    </View>
  );
}
