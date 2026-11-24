import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "@/components/EmptyState";
import {
  LineupList, LiveLeaderboard, ResultsStatusLabel, RiderLapSheet,
  type PublicLeaderEntry, type PublicLineupEntry,
} from "@/components/LiveLeaderboard";
import { PressableScale } from "@/components/PressableScale";
import { LeaderboardSkeleton, Skeleton, SkeletonGroup } from "@/components/Skeleton";
import { fonts } from "@/constants/fonts";
import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { API_BASE_URL } from "@/lib/apiBase";
import { haptics } from "@/lib/haptics";
import { eventChip, followMoto, furthestStatus, todaysMotos, type EventChip, type ScheduleMoto } from "@/lib/liveEvent";
import { useLiveStreams } from "@/lib/liveStreams";
import { goBack } from "@/lib/navigation";

/**
 * An event's live screen, native: header with a real status, a switcher for
 * today's races that follows the one running, and the shared live leaderboard
 * (components/LiveLeaderboard.tsx). While the event streams, "Watch the
 * stream" opens the website's Watch page (app/live/watch/[eventId].tsx), which
 * has the video, the cameras and the announcer: the website has no video-only
 * page to embed, and the app has no audio player for the announcer.
 *
 * Opened from Home's "Live now" banner, the Live now list, event pages and the
 * race-start push (`?motoId=` picks that race).
 */

// ─── Data ────────────────────────────────────────────────────────────────────

type Moto = ScheduleMoto & { type: string; lineup: PublicLineupEntry[] };

/** GET /api/public/events/:id/schedule */
interface EventSchedule {
  eventId: number;
  name: string;
  state: string;
  location: string;
  trackName: string;
  status: string;
  raceStyle: string | null;
  motos: Moto[];
}

/** GET /api/public/motos/:id/detail (the fields used here). */
interface MotoDetail {
  motoId: number;
  status: string;
  lapCount: number | null;
  resultsOfficial?: boolean;
  leaderboard: PublicLeaderEntry[];
  lineup: PublicLineupEntry[];
}

class NotFound extends Error {}

const OFFLINE = "Couldn't reach RM Roost. Check your connection and pull down to try again.";

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`);
  } catch {
    throw new Error(OFFLINE);
  }
  if (res.status === 404) throw new NotFound("This event couldn't be found. It may have been removed.");
  if (!res.ok) throw new Error(`Live timing didn't load (error ${res.status}). Pull down to try again.`);
  return res.json() as Promise<T>;
}

/** Track, state: "Thunder Valley, CO". */
function where(e: EventSchedule): string {
  return [e.trackName || e.location, e.state].filter(Boolean).join(", ");
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function LiveEventScreen() {
  const params = useLocalSearchParams<{ eventId: string; motoId?: string }>();
  const eventId = Number(params.eventId);
  const valid = Number.isInteger(eventId) && eventId > 0;
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const reduced = useReducedMotion();
  const { profiles } = useRiderAuth();
  const ownRiderIds = useMemo(() => new Set(profiles.map(p => p.id)), [profiles]);
  const { events: streaming, refresh: refreshStreams } = useLiveStreams();
  const stream = streaming.find(e => e.eventId === eventId) ?? null;

  const scheduleQ = useQuery({
    queryKey: ["live-event-schedule", eventId],
    queryFn: () => getJson<EventSchedule>(`/api/public/events/${eventId}/schedule`),
    enabled: valid,
    retry: (n, err) => !(err instanceof NotFound) && n < 1,
    refetchOnWindowFocus: false,
  });
  // The club's name isn't in the schedule; it doesn't change, so once.
  const clubQ = useQuery({
    queryKey: ["live-event-club", eventId],
    queryFn: async () => (await getJson<{ clubName?: string | null }>(`/api/events/${eventId}`)).clubName ?? null,
    enabled: valid,
    staleTime: Infinity,
    retry: false,
  });
  const event = scheduleQ.data;
  const clubName = clubQ.data ?? stream?.clubName ?? null;

  // ── Which race ──
  const motos = useMemo(() => todaysMotos(event?.motos ?? []), [event]);
  const follow = followMoto(motos);
  const running = motos.find(m => m.status === "in_progress") ?? null;
  const [picked, setPicked] = useState<number | null>(() => {
    const n = Number(params.motoId);
    return Number.isInteger(n) && n > 0 ? n : null;
  });
  const pickedMoto = picked != null ? motos.find(m => m.motoId === picked) ?? null : null;
  const selected = pickedMoto ?? follow;
  // A picked race that starts running is the one followed anyway: follow again from there.
  useEffect(() => {
    if (picked != null && running && picked === running.motoId) setPicked(null);
  }, [picked, running?.motoId]);

  const pickMoto = useCallback((m: Moto) => {
    haptics.selection();
    setPicked(m.motoId === follow?.motoId ? null : m.motoId);
  }, [follow?.motoId]);

  const detailQ = useQuery({
    queryKey: ["live-moto-detail", selected?.motoId],
    queryFn: () => getJson<MotoDetail>(`/api/public/motos/${selected!.motoId}/detail`),
    enabled: selected != null,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const detail = detailQ.data?.motoId === selected?.motoId ? detailQ.data : undefined;
  const status = furthestStatus(selected?.status, detail?.status);
  const isLive = status === "in_progress";
  const official = detail?.resultsOfficial;

  // The race's own results are ahead of the schedule (it started or finished): refresh the schedule.
  useEffect(() => {
    if (selected && detail && furthestStatus(selected.status, detail.status) !== selected.status) void scheduleQ.refetch();
  }, [selected?.status, detail?.status]);

  // ── Refresh while someone is looking ──
  const chip = eventChip(event?.status, motos);
  useVisibleInterval(() => scheduleQ.refetch(), 10_000, chip.kind === "live" || chip.kind === "raceDay");
  useVisibleInterval(() => detailQ.refetch(), 5_000, isLive);
  // Finished but not yet official: check now and then, so it turns official while they watch.
  useVisibleInterval(() => detailQ.refetch(), 20_000, status === "completed" && official === false);
  const prevOfficial = useRef(official);
  useEffect(() => {
    if (prevOfficial.current === false && official === true) haptics.success();
    prevOfficial.current = official;
  }, [official]);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    haptics.selection();
    setRefreshing(true);
    await Promise.all([scheduleQ.refetch(), selected ? detailQ.refetch() : null, refreshStreams()]);
    setRefreshing(false);
  }, [scheduleQ, detailQ, selected, refreshStreams]);

  // ── Rider sheet ──
  const [openRider, setOpenRider] = useState<PublicLeaderEntry | null>(null);
  const onOpenRider = useCallback((entry: PublicLeaderEntry) => setOpenRider(entry), []);
  const leaderRiderId = detail?.leaderboard.find(e => e.position === 1)?.riderId ?? null;

  // ── Moto chips: keep the selected one in view ──
  const chipsRef = useRef<ScrollView>(null);
  const chipLayout = useRef(new Map<number, { x: number; w: number }>());
  const [chipsWidth, setChipsWidth] = useState(0);
  const scrollToChip = useCallback((motoId: number | undefined, animated: boolean) => {
    const l = motoId != null ? chipLayout.current.get(motoId) : undefined;
    if (!l || !chipsWidth) return;
    chipsRef.current?.scrollTo({ x: Math.max(0, l.x - (chipsWidth - l.w) / 2), animated });
  }, [chipsWidth]);
  useEffect(() => { scrollToChip(selected?.motoId, !reduced); }, [selected?.motoId, scrollToChip]);

  // ── Render ──
  const topBar = (
    <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: colors.background }}>
      <Pressable onPress={() => goBack(router)} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}
        style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.muted, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.6 : 1 })}>
        <Feather name="arrow-left" size={19} color={colors.foreground} />
      </Pressable>
      {event ? <StatusChip chip={chip} colors={colors} /> : null}
    </View>
  );

  if (!valid || (!event && scheduleQ.error)) {
    const notFound = !valid || scheduleQ.error instanceof NotFound;
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {topBar}
        <EmptyState
          icon={notFound ? "map-pin" : "wifi-off"}
          title={notFound ? "Event not found" : "Live timing didn't load"}
          message={!valid ? "This link looks broken. Go back and open the event again." : scheduleQ.error?.message ?? OFFLINE}
          primary={notFound
            ? { label: "Go back", icon: "arrow-left", onPress: () => goBack(router) }
            : { label: "Try again", icon: "refresh-cw", onPress: () => { haptics.light(); void scheduleQ.refetch(); } }}
        />
      </View>
    );
  }

  if (!event) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {topBar}
        <LiveScreenSkeleton />
      </View>
    );
  }

  const refreshFailed = scheduleQ.isRefetchError || detailQ.isRefetchError;
  const leaderLaps = detail?.leaderboard.find(e => e.position === 1)?.laps ?? 0;
  const lineupRows = detail?.lineup?.length ? detail.lineup : selected?.lineup ?? [];
  const nextUp = motos.find(m => m.status === "scheduled");

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {topBar}
      <ScrollView
        stickyHeaderIndices={[1]}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primaryText} colors={[colors.primary]} />}
      >
        {/* 0: event header and the stream */}
        <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 14, gap: 4 }}>
          <Text selectable style={{ fontSize: 28, lineHeight: 31, color: colors.foreground, fontFamily: fonts.displayHeavy, textTransform: "uppercase" }} numberOfLines={2}>
            {event.name}
          </Text>
          <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: fonts.regular }} numberOfLines={2}>
            {[clubName, where(event)].filter(Boolean).join("  ·  ")}
          </Text>
          {refreshFailed && (
            <Pressable onPress={onRefresh} accessibilityRole="button" accessibilityLabel="Couldn't refresh. Try again."
              style={{ marginTop: 10, flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderRadius: 10, backgroundColor: colors.warningTint }}>
              <Feather name="alert-circle" size={15} color={colors.foreground} />
              <Text style={{ flex: 1, fontSize: 13, color: colors.foreground, fontFamily: fonts.regular }}>Couldn't refresh. Showing the last update.</Text>
              <Text style={{ fontSize: 13, color: colors.foreground, fontFamily: fonts.bold }}>Try again</Text>
            </Pressable>
          )}
          {stream && (
            <PressableScale
              onPress={() => router.push(`/live/watch/${eventId}` as any)}
              accessibilityRole="button"
              accessibilityLabel={`Watch the stream. ${stream.cameras.length} ${stream.cameras.length === 1 ? "camera" : "cameras"}, ${stream.viewers} watching.`}
              style={{ marginTop: 12, flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 14, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderCurve: "continuous" }}
            >
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" }}>
                <Feather name="play" size={20} color="#fff" style={{ marginLeft: 2 }} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, color: colors.foreground, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 0.4 }}>Watch the stream</Text>
                <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.regular }} numberOfLines={1}>
                  {[
                    `${stream.cameras.length} ${stream.cameras.length === 1 ? "camera" : "cameras"}`,
                    stream.viewers > 0 ? `${stream.viewers} watching` : null,
                  ].filter(Boolean).join("  ·  ")}
                </Text>
              </View>
              <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
            </PressableScale>
          )}
        </View>

        {/* 1 (sticky): today's races */}
        <View style={{ backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          {motos.length > 0 && (
            <ScrollView
              ref={chipsRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              onLayout={e => setChipsWidth(e.nativeEvent.layout.width)}
              contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10, gap: 8 }}
            >
              {motos.map(m => (
                <MotoChip
                  key={m.motoId}
                  moto={m}
                  selected={m.motoId === selected?.motoId}
                  colors={colors}
                  onPress={pickMoto}
                  onLayout={(x, w) => {
                    chipLayout.current.set(m.motoId, { x, w });
                    if (m.motoId === selected?.motoId) scrollToChip(m.motoId, false);
                  }}
                />
              ))}
            </ScrollView>
          )}
        </View>

        {/* 2: the selected race */}
        <View>
          {motos.length === 0 || !selected ? (
            <EmptyState
              variant="card"
              icon="flag"
              title="No races posted yet"
              message="Race order and live timing show up here once the club posts today's races."
              primary={{ label: "Event details", onPress: () => router.push(`/event/${eventId}` as any) }}
            />
          ) : (
            <>
              <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 10, gap: 2 }}>
                <Text selectable style={{ fontSize: 22, lineHeight: 26, color: colors.foreground, fontFamily: fonts.display }}>
                  {selected.name}
                </Text>
                {selected.raceClass && selected.raceClass !== selected.name ? (
                  <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: fonts.medium }}>{selected.raceClass}</Text>
                ) : null}
                {isLive ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary }} />
                    <Text style={{ fontVariant: ["tabular-nums"], fontSize: 12, color: colors.foreground, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 0.6 }}>
                      {leaderLaps > 0 ? `Racing  ·  Lap ${leaderLaps}${detail?.lapCount ? ` of ${detail.lapCount}` : ""}` : "Racing  ·  Waiting for the first lap"}
                    </Text>
                  </View>
                ) : status === "completed" ? (
                  detail ? <ResultsStatusLabel official={official} /> : null
                ) : (
                  <Text style={{ marginTop: 4, fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 0.6 }}>
                    {selected.motoId === nextUp?.motoId ? "Up next  ·  Gate draw" : "Gate draw"}
                  </Text>
                )}
                {running && running.motoId !== selected.motoId && (
                  <PressableScale
                    onPress={() => { haptics.selection(); setPicked(null); }}
                    accessibilityRole="button"
                    accessibilityLabel={`Back to the race running now, ${running.name}`}
                    style={{ alignSelf: "flex-start", marginTop: 10, flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: colors.primary }}
                  >
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: "#fff" }} />
                    <Text style={{ color: "#fff", fontSize: 13, fontFamily: fonts.display, textTransform: "uppercase", letterSpacing: 0.6 }} numberOfLines={1}>
                      Back to live  ·  {running.name}
                    </Text>
                  </PressableScale>
                )}
              </View>

              {detail == null && detailQ.isError ? (
                <EmptyState
                  variant="compact"
                  icon="wifi-off"
                  title="Race didn't load"
                  message={detailQ.error?.message ?? OFFLINE}
                  primary={{ label: "Retry", onPress: () => { haptics.light(); void detailQ.refetch(); } }}
                />
              ) : detail == null ? (
                <LeaderboardSkeleton rows={8} />
              ) : status === "scheduled" ? (
                <LineupList rows={lineupRows} colors={colors} />
              ) : detail.leaderboard.length === 0 ? (
                <View style={{ paddingVertical: 40, paddingHorizontal: 24, alignItems: "center", gap: 8 }}>
                  <Feather name="clock" size={28} color={colors.mutedForeground} />
                  <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: fonts.regular, textAlign: "center" }}>
                    {isLive ? "Riders show up here as they cross the line." : "Results aren't posted yet."}
                  </Text>
                </View>
              ) : (
                <LiveLeaderboard entries={detail.leaderboard} isLive={isLive} onOpen={onOpenRider} ownRiderIds={ownRiderIds} />
              )}
            </>
          )}
        </View>
      </ScrollView>

      <Modal
        visible={openRider?.riderId != null}
        transparent
        animationType={reduced ? "fade" : "slide"}
        onRequestClose={() => setOpenRider(null)}
      >
        {openRider?.riderId != null && selected && (
          <RiderLapSheet
            motoId={selected.motoId}
            riderId={openRider.riderId}
            riderName={openRider.riderName}
            leaderRiderId={leaderRiderId}
            onClose={() => setOpenRider(null)}
            colors={colors}
            bottomInset={insets.bottom}
            raceStyle={event.raceStyle}
          />
        )}
      </Modal>
    </View>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

type Colors = ReturnType<typeof useColors>;

function StatusChip({ chip, colors }: { chip: EventChip; colors: Colors }) {
  const live = chip.kind === "live";
  const icon = chip.kind === "finished" ? "check" : chip.kind === "raceDay" ? "flag" : "calendar";
  return (
    <View
      accessibilityLabel={live ? "Live: a race is running" : chip.label}
      style={{
        flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
        backgroundColor: live ? colors.primary : colors.muted,
      }}
    >
      {live
        ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: "#fff" }} />
        : <Feather name={icon} size={12} color={colors.foreground} />}
      <Text style={{ color: live ? "#fff" : colors.foreground, fontFamily: fonts.display, fontSize: 13, letterSpacing: live ? 1.2 : 0.4, textTransform: live ? "none" : "uppercase" }}>
        {chip.label}
      </Text>
    </View>
  );
}

const MotoChip = React.memo(function MotoChip({
  moto, selected, colors, onPress, onLayout,
}: {
  moto: Moto;
  selected: boolean;
  colors: Colors;
  onPress: (m: Moto) => void;
  onLayout: (x: number, w: number) => void;
}) {
  const live = moto.status === "in_progress";
  const done = moto.status === "completed";
  const fg = selected ? "#fff" : done ? colors.mutedForeground : colors.foreground;
  return (
    <Pressable
      onPress={() => onPress(moto)}
      onLayout={e => onLayout(e.nativeEvent.layout.x, e.nativeEvent.layout.width)}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={`${moto.name}${moto.raceClass ? `, ${moto.raceClass}` : ""}, ${live ? "racing now" : done ? "finished" : "not started"}`}
      style={({ pressed }) => ({
        flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, maxWidth: 220,
        paddingHorizontal: 14, borderRadius: 999,
        backgroundColor: selected ? colors.primary : colors.card,
        borderWidth: 1, borderColor: selected ? colors.primary : colors.border,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {live ? (
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: selected ? "#fff" : colors.primary }} />
      ) : done ? (
        <Feather name="check" size={13} color={fg} />
      ) : null}
      <Text numberOfLines={1} style={{ color: fg, fontFamily: fonts.display, fontSize: 14, letterSpacing: 0.2 }}>{moto.name}</Text>
    </Pressable>
  );
});

/** First load: shaped like the header, the race chips and the leaderboard. */
function LiveScreenSkeleton() {
  return (
    <View>
      <SkeletonGroup style={{ paddingHorizontal: 16, paddingTop: 4, gap: 10 }} label="Loading live timing">
        <Skeleton width="78%" height={28} />
        <Skeleton width="52%" height={14} />
        <View style={{ flexDirection: "row", gap: 8, paddingTop: 14 }}>
          <Skeleton width={96} height={36} radius={999} />
          <Skeleton width={84} height={36} radius={999} />
          <Skeleton width={104} height={36} radius={999} />
        </View>
        <Skeleton width="44%" height={22} style={{ marginTop: 14 }} />
      </SkeletonGroup>
      <LeaderboardSkeleton rows={8} />
    </View>
  );
}
