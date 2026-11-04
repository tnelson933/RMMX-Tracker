import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChartCard, LineChart } from "@/components/charts";
import { NumberPlate } from "@/components/NumberPlate";
import { ResultCard } from "@/components/RaceCards";
import { PositionBadge } from "@/components/RaceStats";
import { formatLap, type CareerStats } from "@/components/ShareCard";
import { PhotoFade, StockBackdrop } from "@/components/StockBackdrop";
import { fonts } from "@/constants/fonts";
import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";
import { displayDate } from "@/lib/format";
import { NETWORK_ERROR_MESSAGE } from "@/lib/friendlyErrors";
import { goBack } from "@/lib/navigation";
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
  profile?: { number: string | null; plateColor: string | null; state: string | null; bio: string | null };
  visibility?: "public" | "private";
  isManager?: boolean;
}


/**
 * Racer profile: a résumé the system builds from the rider's results (headline,
 * highlights, season trend, badges), their number plate, and a Follow button.
 * Bio and home state only show on public profiles; riders under 18 start private.
 */
export default function RacerScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { riderFetch } = useRiderAuth();
  const [data, setData] = useState<RacerProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await riderFetch(`/api/rider/riders/${id}/public`);
      if (!r.ok) { setError(r.status === 404 ? "This rider has no results yet." : `Couldn't load this rider (error ${r.status}).`); return; }
      setData(await r.json());
    } catch {
      setError(NETWORK_ERROR_MESSAGE);
    }
  }, [id, riderFetch]);
  useEffect(() => { void load(); }, [load]);

  const toggle = useCallback(async () => {
    if (!data) return;
    const follow = !data.following;
    setData({ ...data, following: follow, followerCount: Math.max(0, data.followerCount + (follow ? 1 : -1)) });
    const rollback = () => setData(d => (d ? { ...d, following: !follow, followerCount: Math.max(0, d.followerCount + (follow ? -1 : 1)) } : d));
    try {
      const r = await riderFetch(`/api/rider/follows/${id}`, { method: follow ? "POST" : "DELETE" });
      if (!r.ok) { rollback(); Alert.alert(follow ? "Couldn't follow" : "Couldn't unfollow", `Try again (error ${r.status}).`); }
    } catch {
      rollback();
      Alert.alert(follow ? "Couldn't follow" : "Couldn't unfollow", NETWORK_ERROR_MESSAGE);
    }
  }, [data, id, riderFetch]);

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
        <View style={[s.center, { paddingTop: insets.top }]}>
          {error ? (
            <>
              <Text style={[s.muted, { textAlign: "center" }]}>{error}</Text>
              <Pressable onPress={() => { void load(); }} style={({ pressed }) => ({ marginTop: 12, opacity: pressed ? 0.6 : 1 })}>
                <Text style={{ color: colors.primaryText, fontFamily: fonts.semibold, fontSize: 14 }}>Try again</Text>
              </Pressable>
            </>
          ) : <ActivityIndicator color={colors.primaryText} />}
        </View>
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
  const initials = data.name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  const sub = [resume?.classes[0], stateNameFromCode(profile?.state), resume?.firstYear ? `since ${resume.firstYear}` : null].filter(Boolean).join("  ·  ");
  const seasons = (resume?.seasons ?? []).filter(x => x.avgFinish != null);
  const worst = seasons.length ? Math.max(...seasons.map(x => x.avgFinish!)) : 3;

  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        {/* Photo header: a stock riding photo until riders can add their own. */}
        <View style={{ height: 250 + insets.top, justifyContent: "flex-end", backgroundColor: "#161616", overflow: "hidden" }}>
          <StockBackdrop />
          <PhotoFade from={0.2} strength={0.92} />
          <View style={{ padding: 16, flexDirection: "row", alignItems: "flex-end", gap: 12 }}>
            <View style={s.avatar}><Text style={s.avatarText}>{initials}</Text></View>
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
              <Pressable onPress={() => router.push(`/rider/${data.riderId}` as any)} accessibilityRole="button"
                style={({ pressed }) => [s.pill, s.pillOutline, { opacity: pressed ? 0.7 : 1 }]}>
                <Text style={[s.pillText, { color: colors.foreground }]}>Edit profile</Text>
              </Pressable>
            ) : (
              <Pressable onPress={toggle} accessibilityRole="button" accessibilityState={{ selected: data.following }}
                style={({ pressed }) => [s.pill, data.following ? s.pillOutline : null, { opacity: pressed ? 0.7 : 1 }]}>
                <Text style={[s.pillText, data.following ? { color: colors.foreground } : null]}>{data.following ? "Following" : "Follow"}</Text>
              </Pressable>
            )}
          </View>

          {data.isManager && data.visibility === "private" && (
            <View style={s.notice}>
              <Feather name="lock" size={14} color={colors.mutedForeground} />
              <Text style={[s.muted, { flex: 1 }]}>Private profile. Other riders see published results only, not the bio or home state.</Text>
            </View>
          )}

          {profile?.bio ? <Text style={s.bio}>{profile.bio}</Text> : null}

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

          {(resume?.highlights.bestFinish || st.bestLap || resume?.highlights.bestComeback) && (
            <>
              <Text style={s.section}>Highlights</Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {resume?.highlights.bestFinish && (
                  <Pressable style={[s.card, s.hl]} onPress={() => router.push(`/event/${resume.highlights.bestFinish!.eventId}` as any)} accessibilityRole="button">
                    <PositionBadge position={resume.highlights.bestFinish.position} size="sm" />
                    <Text style={s.hlLabel}>Best finish</Text>
                    <Text style={s.hlWhere} numberOfLines={2}>{resume.highlights.bestFinish.eventName}</Text>
                  </Pressable>
                )}
                {st.bestLap && (
                  <View style={[s.card, s.hl]}>
                    <Text style={s.hlValue}>{formatLap(st.bestLap.ms).replace(/(\.\d)\d\d$/, "$1")}</Text>
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

          {((resume?.classes.length ?? 0) > 0 || (resume?.tracks.length ?? 0) > 0) && (
            <View style={[s.card, { gap: 6 }]}>
              {(resume?.classes.length ?? 0) > 0 && <Text style={s.muted}><Text style={s.kv}>Classes  </Text>{resume!.classes.slice(0, 4).join(", ")}</Text>}
              {(resume?.tracks.length ?? 0) > 0 && <Text style={s.muted}><Text style={s.kv}>Tracks  </Text>{resume!.tracks.slice(0, 4).join(", ")}</Text>}
            </View>
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
          {resume?.highlights.bestFinish?.eventDate ? (
            <Text style={[s.muted, { fontSize: 11 }]}>
              Built from published results, most recently {displayDate(data.recent[0]?.eventDate ?? resume.highlights.bestFinish.eventDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.
            </Text>
          ) : null}
        </View>
      </ScrollView>
      {backButton}
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
  muted: { fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.regular, lineHeight: 17 },
});
