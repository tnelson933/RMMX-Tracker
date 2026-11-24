import { Feather } from "@expo/vector-icons";
import { StatusBarBackdrop } from "@/components/StatusBarBackdrop";
import { useBottomSpace } from "@/hooks/useBottomSpace";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { PressableScale } from "@/components/PressableScale";
import { ProfileHeaderSkeleton } from "@/components/Skeleton";
import { haptics } from "@/lib/haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChartCard, LineChart } from "@/components/charts";
import { NumberPlate } from "@/components/NumberPlate";
import { ResultCard } from "@/components/RaceCards";
import { PositionBadge } from "@/components/RaceStats";
import { formatLap, type CareerStats } from "@/components/ShareCard";
import { PhotoFade } from "@/components/StockBackdrop";
import { CoverBackdrop, RiderAvatar } from "@/components/RiderPhoto";
import { fonts } from "@/constants/fonts";
import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";
import { webUrl } from "@/lib/apiBase";
import { displayDate } from "@/lib/format";
import { NETWORK_ERROR_MESSAGE } from "@/lib/friendlyErrors";
import { goBack } from "@/lib/navigation";
import { RiderLiveBanner } from "@/components/GoLiveButton";
import { useRiderLive } from "@/lib/riderLive";
import { fmtLapShort } from "@/lib/raceReport";
import { stateNameFromCode } from "@/lib/usStates";

interface Recent { eventId: number; eventName: string; eventDate: string; raceClass: string; bestPosition: number | null; official?: boolean; motos: Array<{ motoName: string; position: number | null; dnf: boolean; dns: boolean }> }

interface Resume {
  headline: string | null;
  highlights: {
    bestFinish: { position: number; eventId: number; eventName: string; eventDate: string } | null;
    bestComeback: { gained: number; eventId: number; eventName: string } | null;
  };
  seasons: Array<{ year: string; avgFinish: number | null; motos: number }>;
  badges: Array<{ key: string; label: string }>;
  classes: string[];
  tracks: string[];
  firstYear: string | null;
}

interface RacerProfile {
  riderId: number;
  name: string;
  following: boolean;
  followerCount: number;
  stats: CareerStats;
  recent: Recent[];
  resume?: Resume;
  profile?: {
    number: string | null; plateColor: string | null; state: string | null; bio: string | null; avatarUrl?: string | null; coverUrl?: string | null;
    /** "2024 KTM 250 SX-F". Newer servers only. */
    bike?: string | null;
    sponsors?: string[];
  };
  visibility?: "public" | "private";
  isManager?: boolean;
  /** Newer servers only: extra career numbers, big wins, and where they've raced. */
  extras?: {
    events?: number;
    top10s?: number;
    bigWins?: Array<{ eventId: number; eventName: string; eventDate: string; raceClass: string; motoName: string; fieldSize: number }>;
    tracks?: Array<{ name: string; events: number }>;
    states?: Array<{ code: string; events: number }>;
  };
  series?: Array<{ seriesId: number; seriesName: string; raceClass: string; position: number; points: number; riders: number }>;
  /** The profile's page on the website; null or missing when the profile is private. */
  sharePath?: string | null;
}

const TRACKS_SHOWN = 6;
const shortDate = (iso: string) => displayDate(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * Racer profile: a résumé the system builds from the rider's results (headline,
 * highlights, season trend, badges), their number plate, and a Follow button.
 * Bio and home state only show on public profiles; riders under 18 start private.
 */
export default function RacerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const bottomSpace = useBottomSpace();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { riderFetch } = useRiderAuth();
  const live = useRiderLive(Number(id), riderFetch);
  const [data, setData] = useState<RacerProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allTracks, setAllTracks] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (!refresh) setError(null);
    try {
      const r = await riderFetch(`/api/rider/riders/${id}/public`);
      if (!r.ok) {
        // A failed background refresh keeps what's already on screen.
        if (!refresh) setError(r.status === 404 ? "This rider has no results yet." : `Couldn't load this rider (error ${r.status}).`);
        return;
      }
      setData(await r.json());
      setError(null);
    } catch {
      if (!refresh) setError(NETWORK_ERROR_MESSAGE);
    }
  }, [id, riderFetch]);
  // Reload whenever the screen comes back into view, so edits made in the
  // profile editor (photos, bio, plate colour) show straight away.
  const loadedId = React.useRef<string | null>(null);
  useFocusEffect(useCallback(() => {
    void load(loadedId.current === id);
    loadedId.current = id ?? null;
  }, [load, id]));

  const toggling = React.useRef(false);
  const toggle = useCallback(async () => {
    // One follow/unfollow at a time, so a double tap can't leave the button out of step.
    if (!data || toggling.current) return;
    toggling.current = true;
    const follow = !data.following;
    setData({ ...data, following: follow, followerCount: Math.max(0, data.followerCount + (follow ? 1 : -1)) });
    const rollback = () => setData(d => (d ? { ...d, following: !follow, followerCount: Math.max(0, d.followerCount + (follow ? -1 : 1)) } : d));
    try {
      const r = await riderFetch(`/api/rider/follows/${id}`, { method: follow ? "POST" : "DELETE" });
      if (!r.ok) {
        rollback();
        // A private profile answers 403 with a message to show as is.
        const message = r.status === 403 ? ((await r.json().catch(() => null))?.error as string | undefined) : undefined;
        Alert.alert(follow ? "Couldn't follow" : "Couldn't unfollow", message ?? `Try again (error ${r.status}).`);
      } else if (follow) {
        haptics.success();
      }
    } catch {
      rollback();
      Alert.alert(follow ? "Couldn't follow" : "Couldn't unfollow", NETWORK_ERROR_MESSAGE);
    } finally {
      toggling.current = false;
    }
  }, [data, id, riderFetch]);

  const share = useCallback(async () => {
    if (!data?.sharePath) return;
    const url = webUrl(data.sharePath);
    try {
      await Share.share({ message: `${data.name}'s racer profile on RM Roost: ${url}`, title: `${data.name} on RM Roost` });
    } catch {
      Alert.alert("Couldn't open sharing", "Try again.");
    }
  }, [data]);

  const s = styles(colors, insets);

  const backButton = (
    <Pressable onPress={() => goBack(router)} accessibilityRole="button" accessibilityLabel="Back"
      style={({ pressed }) => [s.backBtn, { opacity: pressed ? 0.6 : 1, top: insets.top + 8 }]}>
      <Feather name="arrow-left" size={18} color="#FFFFFF" />
    </Pressable>
  );

  if (!data || error) {
    return (
      <View style={s.root}>
        {error ? (
          <View style={[s.center, { paddingTop: insets.top }]}>
            <Text style={[s.muted, { textAlign: "center" }]}>{error}</Text>
            <Pressable onPress={() => { void load(); }} style={({ pressed }) => ({ marginTop: 12, opacity: pressed ? 0.6 : 1 })}>
              <Text style={{ color: colors.primaryText, fontFamily: fonts.semibold, fontSize: 14 }}>Try again</Text>
            </Pressable>
          </View>
        ) : <ProfileHeaderSkeleton topInset={insets.top} />}
        <Pressable onPress={() => goBack(router)} accessibilityRole="button" accessibilityLabel="Back"
          style={({ pressed }) => [s.backBtn, { backgroundColor: colors.muted, opacity: pressed ? 0.6 : 1, top: insets.top + 8 }]}>
          <Feather name="arrow-left" size={18} color={colors.foreground} />
        </Pressable>
      </View>
    );
  }

  const st = data.stats;
  const resume = data.resume;
  const profile = data.profile;
  const sub = [resume?.classes[0], stateNameFromCode(profile?.state), resume?.firstYear ? `since ${resume.firstYear}` : null].filter(Boolean).join("  ·  ");
  const seasons = (resume?.seasons ?? []).filter(x => x.avgFinish != null);
  const worst = seasons.length ? Math.max(...seasons.map(x => x.avgFinish!)) : 3;

  const extras = data.extras;
  const sponsors = profile?.sponsors ?? [];
  const bigWins = extras?.bigWins ?? [];
  const series = data.series ?? [];
  // Older servers send track names only (no counts) in the résumé.
  const tracks: Array<{ name: string; events: number | null }> = extras?.tracks ?? (resume?.tracks ?? []).map(name => ({ name, events: null }));
  const states = extras?.states ?? [];
  const shownTracks = allTracks ? tracks : tracks.slice(0, TRACKS_SHOWN);
  const hasLaps = (st.totalLaps ?? 0) > 0;
  const career = [
    extras?.events != null ? { l: "Events", v: String(extras.events) } : null,
    extras?.top10s != null ? { l: "Top 10s", v: String(extras.top10s) } : null,
    st.top5s != null ? { l: "Top 5s", v: String(st.top5s) } : null,
    st.avgFinish != null ? { l: "Avg finish", v: `P${st.avgFinish.toFixed(1)}` } : null,
    hasLaps && st.lapsLed != null ? { l: "Laps led", v: st.pctLapsLed != null ? `${st.lapsLed} (${Math.round(st.pctLapsLed)}%)` : String(st.lapsLed) } : null,
    hasLaps && st.avgLap1Position != null ? { l: "Avg lap-1 position", v: `P${st.avgLap1Position.toFixed(1)}` } : null,
  ].filter((x): x is { l: string; v: string } => !!x);

  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={{ paddingBottom: bottomSpace }}>
        {/* Photo header: the rider's background photo, or a stock riding photo. */}
        <View style={{ height: 250 + insets.top, justifyContent: "flex-end", backgroundColor: "#161616", overflow: "hidden" }}>
          <CoverBackdrop url={profile?.coverUrl} />
          <PhotoFade from={0.2} strength={0.92} />
          {/* Back button scrolls with the photo, so it never sits over content. */}
          {backButton}
          <View style={{ padding: 16, flexDirection: "row", alignItems: "flex-end", gap: 12 }}>
            <RiderAvatar url={profile?.avatarUrl} name={data.name} size={64} style={{ borderWidth: 3, borderColor: "#FFFFFF" }} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.name} numberOfLines={2}>{data.name}</Text>
              {sub ? <Text style={s.sub} numberOfLines={1}>{sub}</Text> : null}
            </View>
          </View>
        </View>

        <View style={s.content}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            {profile?.number ? <NumberPlate number={profile.number} color={profile.plateColor} /> : null}
            <Text style={[s.muted, { flex: 1, fontSize: 14 }]}>
              {data.followerCount} {data.followerCount === 1 ? "follower" : "followers"}
            </Text>
            {data.isManager ? (
              <PressableScale onPress={() => router.push(`/rider/${data.riderId}` as any)} accessibilityRole="button"
                style={[s.pill, s.pillOutline]}>
                <Text style={[s.pillText, { color: colors.foreground }]}>Edit profile</Text>
              </PressableScale>
            ) : data.visibility === "private" && !data.following ? null : (
              // Private profiles can't be followed; an older follow can still be removed.
              <PressableScale onPress={toggle} accessibilityRole="button" accessibilityState={{ selected: data.following }}
                style={[s.pill, data.following ? s.pillOutline : null]}>
                <Text style={[s.pillText, data.following ? { color: colors.foreground } : null]}>{data.following ? "Following" : "Follow"}</Text>
              </PressableScale>
            )}
            {data.sharePath ? (
              <Pressable onPress={() => { void share(); }} accessibilityRole="button" accessibilityLabel="Share this profile" hitSlop={6}
                style={({ pressed }) => [s.iconBtn, { opacity: pressed ? 0.6 : 1 }]}>
                <Feather name="share-2" size={16} color={colors.foreground} />
              </Pressable>
            ) : null}
          </View>

          {live ? <RiderLiveBanner riderId={data.riderId} live={live.live} canWatch={live.canWatch} viewers={live.viewers} /> : null}

          {!data.isManager && data.visibility === "private" && (
            <View style={s.notice}>
              <Feather name="lock" size={14} color={colors.mutedForeground} />
              <Text style={[s.muted, { flex: 1 }]}>This rider's profile is private. Ask their parent or guardian to make it public.</Text>
            </View>
          )}

          {data.isManager && data.visibility === "private" && (
            <View style={s.notice}>
              <Feather name="lock" size={14} color={colors.mutedForeground} />
              <Text style={[s.muted, { flex: 1 }]}>Private profile. Other riders see published results only, not the bio or home state.</Text>
            </View>
          )}

          {profile?.bio ? <Text style={s.bio}>{profile.bio}</Text> : null}

          {(profile?.bike || sponsors.length > 0) && (
            <View style={[s.card, { gap: 8 }]}>
              {profile?.bike ? <Text style={s.muted}><Text style={s.kv}>Bike  </Text>{profile.bike}</Text> : null}
              {sponsors.length > 0 && (
                <View style={{ gap: 6 }}>
                  <Text style={[s.muted, s.kv]}>Sponsors</Text>
                  <View style={s.chips}>
                    {sponsors.map(name => (
                      <View key={name} style={s.badge}><Text style={s.badgeText}>{name}</Text></View>
                    ))}
                  </View>
                </View>
              )}
            </View>
          )}

          {resume?.headline ? (
            <View style={s.card}>
              <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
                <View style={s.stripe} />
                <Text style={s.headline}>{resume.headline}</Text>
              </View>
            </View>
          ) : null}

          <View style={{ flexDirection: "row", gap: 8 }}>
            {[
              { v: st.starts, l: st.starts === 1 ? "Moto" : "Motos" },
              { v: st.wins, l: st.wins === 1 ? "Win" : "Wins" },
              { v: st.podiums, l: st.podiums === 1 ? "Podium" : "Podiums" },
            ].map(t => (
              <View key={t.l} style={[s.card, { flex: 1, alignItems: "center", paddingVertical: 10 }]}>
                <Text style={s.big}>{t.v}</Text>
                <Text style={s.label}>{t.l}</Text>
              </View>
            ))}
          </View>

          {career.length > 0 && (
            <View style={[s.card, { paddingVertical: 4 }]}>
              {career.map((row, i) => (
                <View key={row.l} style={[s.statRow, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border } : null]}>
                  <Text style={s.statLabel}>{row.l}</Text>
                  <Text style={s.statValue}>{row.v}</Text>
                </View>
              ))}
            </View>
          )}

          {(resume?.highlights.bestFinish || st.bestLap || resume?.highlights.bestComeback) && (
            <>
              <Text style={s.section}>Highlights</Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {resume?.highlights.bestFinish && (
                  <PressableScale style={[s.card, s.hl]} onPress={() => router.push(`/event/${resume.highlights.bestFinish!.eventId}` as any)} accessibilityRole="button">
                    <PositionBadge position={resume.highlights.bestFinish.position} size="sm" />
                    <Text style={s.hlLabel}>Best finish</Text>
                    <Text style={s.hlWhere} numberOfLines={2}>{resume.highlights.bestFinish.eventName}</Text>
                  </PressableScale>
                )}
                {st.bestLap && (
                  <View style={[s.card, s.hl]}>
                    <Text style={s.hlValue}>{fmtLapShort(st.bestLap.ms)}</Text>
                    <Text style={s.hlLabel}>Fastest lap</Text>
                    <Text style={s.hlWhere} numberOfLines={2}>{st.bestLap.eventName}</Text>
                  </View>
                )}
                {resume?.highlights.bestComeback && (
                  <View style={[s.card, s.hl]}>
                    <Text style={s.hlValue}>+{resume.highlights.bestComeback.gained}</Text>
                    <Text style={s.hlLabel}>Best comeback</Text>
                    <Text style={s.hlWhere} numberOfLines={2}>{resume.highlights.bestComeback.eventName}</Text>
                  </View>
                )}
              </View>
            </>
          )}

          {seasons.length >= 2 && (
            <ChartCard
              title="Average finish by season"
              takeaway={(() => {
                const f = Math.round(seasons[0].avgFinish!), l = Math.round(seasons[seasons.length - 1].avgFinish!);
                return f - l >= 1 ? `Up from P${f} to P${l} since ${seasons[0].year}.` : l - f >= 1 ? `P${f} in ${seasons[0].year}, P${l} in ${seasons[seasons.length - 1].year}.` : `About P${l} every season.`;
              })()}
            >
              <LineChart
                xLabels={seasons.map(x => x.year)}
                series={[{ data: seasons.map(x => x.avgFinish), color: colors.chartYou, dots: true }]}
                yMin={0.5} yMax={Math.max(worst + 0.5, 3.5)} invert band={[0.5, 3.5]}
                yTicks={worst >= 5 ? [1, Math.round((1 + worst) / 2), Math.ceil(worst)] : [1, Math.ceil(worst)]}
                yFormat={v => `P${v}`}
                accessibilityLabel={`Average finish by season: ${seasons.map(x => `${x.year} P${Math.round(x.avgFinish!)}`).join(", ")}.`}
              />
            </ChartCard>
          )}

          {(resume?.badges.length ?? 0) > 0 && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {resume!.badges.map(b => (
                <View key={b.key} style={s.badge}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.chartBest }} />
                  <Text style={s.badgeText}>{b.label}</Text>
                </View>
              ))}
            </View>
          )}

          {(resume?.classes.length ?? 0) > 0 && (
            <View style={[s.card, { gap: 6 }]}>
              <Text style={s.muted}><Text style={s.kv}>Classes  </Text>{resume!.classes.slice(0, 4).join(", ")}</Text>
            </View>
          )}

          {bigWins.length > 0 && (
            <>
              <Text style={s.section}>Big wins</Text>
              <View style={[s.card, { paddingVertical: 4 }]}>
                {bigWins.map((w, i) => (
                  <Pressable key={`${w.eventId}-${w.raceClass}-${w.motoName}`} onPress={() => router.push(`/event/${w.eventId}` as any)} accessibilityRole="button"
                    style={({ pressed }) => [s.winRow, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border } : null, { opacity: pressed ? 0.6 : 1 }]}>
                    <PositionBadge position={1} size="sm" />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={s.winTitle} numberOfLines={1}>{w.eventName}</Text>
                      <Text style={s.muted} numberOfLines={1}>{[w.raceClass, w.eventDate ? shortDate(w.eventDate) : null].filter(Boolean).join("  ·  ")}</Text>
                      <Text style={s.muted}>Won against {w.fieldSize - 1} riders</Text>
                    </View>
                    <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
                  </Pressable>
                ))}
              </View>
            </>
          )}

          {series.length > 0 && (
            <>
              <Text style={s.section}>Series</Text>
              <View style={[s.card, { paddingVertical: 4 }]}>
                {series.map((x, i) => (
                  <View key={`${x.seriesId}-${x.raceClass}`} style={[s.winRow, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border } : null]}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={s.winTitle} numberOfLines={1}>{x.seriesName}</Text>
                      <Text style={s.muted} numberOfLines={1}>{x.raceClass}</Text>
                    </View>
                    <Text style={s.statValue}>P{x.position} of {x.riders}  ·  {x.points} pts</Text>
                  </View>
                ))}
              </View>
            </>
          )}

          {(tracks.length > 0 || states.length > 0) && (
            <>
              <Text style={s.section}>Where they've raced</Text>
              <View style={[s.card, { gap: 10 }]}>
                {states.length > 0 && (
                  <View style={s.chips}>
                    {states.map(x => (
                      <View key={x.code} style={s.badge}>
                        <Text style={s.badgeText}>{stateNameFromCode(x.code) ?? x.code}</Text>
                        <Text style={[s.badgeText, { color: colors.mutedForeground }]}>{x.events}</Text>
                      </View>
                    ))}
                  </View>
                )}
                {tracks.length > 0 && (
                  <View>
                    {shownTracks.map(t => (
                      <View key={t.name} style={s.trackRow}>
                        <Text style={s.trackName} numberOfLines={1}>{t.name}</Text>
                        {t.events != null ? <Text style={s.muted}>{t.events} {t.events === 1 ? "event" : "events"}</Text> : null}
                      </View>
                    ))}
                  </View>
                )}
                {tracks.length > TRACKS_SHOWN && (
                  <Pressable onPress={() => setAllTracks(v => !v)} accessibilityRole="button" hitSlop={6} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
                    <Text style={s.link}>{allTracks ? "Show fewer" : `Show all ${tracks.length} tracks`}</Text>
                  </Pressable>
                )}
              </View>
            </>
          )}

          <Text style={s.section}>Recent results</Text>
          {data.recent.length === 0 ? <Text style={s.muted}>No published results yet.</Text> : data.recent.map(r => (
            <View key={`${r.eventId}-${r.raceClass}`} style={{ marginHorizontal: -16 }}>
              <ResultCard
                position={r.bestPosition}
                title={r.eventName}
                dateIso={r.eventDate}
                raceClass={r.raceClass}
                motos={r.motos}
                official={r.official}
                onPress={() => router.push(`/event/${r.eventId}` as any)}
              />
            </View>
          ))}
          {data.recent.length > 0 && (
            <Pressable onPress={() => router.push(`/racer/history/${data.riderId}?name=${encodeURIComponent(data.name)}` as any)} accessibilityRole="link"
              style={({ pressed }) => [s.historyLink, { opacity: pressed ? 0.6 : 1 }]}>
              <Text style={s.link}>Full history</Text>
              <Feather name="chevron-right" size={16} color={colors.primaryText} />
            </Pressable>
          )}
          {resume?.highlights.bestFinish?.eventDate ? (
            <Text style={[s.muted, { fontSize: 11 }]}>
              Built from published results, most recently {displayDate(data.recent[0]?.eventDate ?? resume.highlights.bestFinish.eventDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.
            </Text>
          ) : null}
        </View>
      </ScrollView>
      <StatusBarBackdrop color={colors.background} />
    </View>
  );
}

const styles = (colors: ReturnType<typeof useColors>, insets: { bottom: number }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  backBtn: { position: "absolute", left: 16, width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" },
  avatar: { width: 64, height: 64, borderRadius: 32, borderWidth: 3, borderColor: "#FFFFFF", backgroundColor: "#3A3A3A", alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#FFFFFF", fontFamily: fonts.displayHeavy, fontSize: 22 },
  name: { color: "#FFFFFF", fontFamily: fonts.displayItalic, fontSize: 30, lineHeight: 32, textTransform: "uppercase" },
  sub: { color: "#E6E6E6", fontFamily: fonts.medium, fontSize: 13, marginTop: 2 },
  content: { padding: 16, gap: 12 },
  pill: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 999, backgroundColor: colors.primary, borderWidth: 1, borderColor: colors.primary },
  pillOutline: { backgroundColor: "transparent", borderColor: colors.border },
  pillText: { color: "#FFFFFF", fontFamily: fonts.display, fontSize: 15, textTransform: "uppercase", letterSpacing: 1 },
  notice: { flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderRadius: 10, backgroundColor: colors.muted },
  bio: { color: colors.foreground, fontFamily: fonts.regular, fontSize: 15, lineHeight: 21 },
  card: { backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 12 },
  stripe: { width: 4, height: 18, marginTop: 1, backgroundColor: colors.primary, transform: [{ skewX: "-18deg" }] },
  headline: { flex: 1, color: colors.foreground, fontFamily: fonts.medium, fontSize: 15, lineHeight: 20 },
  big: { color: colors.foreground, fontFamily: fonts.displayItalic, fontSize: 26 },
  label: { color: colors.mutedForeground, fontFamily: fonts.display, fontSize: 11, textTransform: "uppercase", letterSpacing: 1 },
  section: { fontSize: 14, letterSpacing: 1.4, textTransform: "uppercase", color: colors.mutedForeground, fontFamily: fonts.display, marginTop: 4 },
  hl: { flex: 1, gap: 4, padding: 10 },
  hlValue: { color: colors.foreground, fontFamily: fonts.displayItalic, fontSize: 20, lineHeight: 24 },
  hlLabel: { color: colors.mutedForeground, fontFamily: fonts.display, fontSize: 11, textTransform: "uppercase", letterSpacing: 1 },
  hlWhere: { color: colors.foreground, fontFamily: fonts.regular, fontSize: 11 },
  badge: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  badgeText: { color: colors.foreground, fontFamily: fonts.medium, fontSize: 12 },
  kv: { color: colors.foreground, fontFamily: fonts.bold },
  iconBtn: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingVertical: 9 },
  statLabel: { color: colors.mutedForeground, fontFamily: fonts.regular, fontSize: 14 },
  statValue: { color: colors.foreground, fontFamily: fonts.bold, fontSize: 14 },
  winRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  winTitle: { color: colors.foreground, fontFamily: fonts.semibold, fontSize: 14 },
  trackRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingVertical: 5 },
  trackName: { flex: 1, color: colors.foreground, fontFamily: fonts.medium, fontSize: 14 },
  link: { color: colors.primaryText, fontFamily: fonts.semibold, fontSize: 14 },
  historyLink: { flexDirection: "row", alignItems: "center", gap: 2, alignSelf: "flex-start", paddingVertical: 4 },
  muted: { fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.regular, lineHeight: 17 },
});
