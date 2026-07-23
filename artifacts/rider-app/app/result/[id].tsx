import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";

const ACCENT = "#cf152d";

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
  const normalized = iso.includes("T") ? iso : iso + "T12:00:00";
  return new Date(normalized).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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

interface EventResult {
  eventId: number;
  eventName: string;
  eventDate: string;
  eventState: string;
  eventLocation: string | null;
  raceClass: string;
  motos: MotoResult[];
  bestPosition: number | null;
  totalPoints: number;
  riderName?: string;
}

export default function ResultDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { activeProfiles, riderFetch } = useRiderAuth();

  const [results, setResults] = useState<EventResult[]>([]);
  const [eventName, setEventName] = useState<string>("");
  const [eventDate, setEventDate] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isMulti = activeProfiles.length > 1;
  const profileKey = activeProfiles.map(p => p.id).join(",");

  const load = useCallback(async () => {
    if (!id || activeProfiles.length === 0) return;
    setError(null);
    try {
      const responses = await Promise.all(
        activeProfiles.map(p => riderFetch(`/api/rider/profiles/${p.id}/history?eventId=${id}`))
      );
      const all: EventResult[] = [];
      for (let i = 0; i < responses.length; i++) {
        if (!responses[i].ok) continue;
        const data = await responses[i].json();
        const hist: EventResult[] = data.history ?? [];
        const prof = activeProfiles[i];
        for (const ev of hist) {
          all.push(isMulti ? { ...ev, riderName: `${prof.firstName} ${prof.lastName}` } : ev);
        }
      }
      if (all.length > 0) {
        setEventName(all[0].eventName);
        setEventDate(all[0].eventDate);
      }
      setResults(all);
    } catch (e: any) {
      setError(e.message ?? "Failed to load results");
    } finally {
      setLoading(false);
    }
  }, [id, profileKey, riderFetch]);

  useEffect(() => { void load(); }, [load]);

  const primary = colors.primary;

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={ACCENT} size="large" />
      </View>
    );
  }

  if (error || results.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center", padding: 32, gap: 10 }}>
        <Feather name="alert-circle" size={36} color={colors.mutedForeground} />
        <Text style={{ fontSize: 18, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", textAlign: "center" }}>
          No results found
        </Text>
        <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>
          {error ?? "Results for this event haven't been posted yet."}
        </Text>
        <Pressable
          onPress={() => router.back()}
          style={{ marginTop: 8, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.primary }}
        >
          <Text style={{ color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 14 }}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Header */}
      <View style={{
        paddingTop: insets.top + 8,
        paddingHorizontal: 16, paddingBottom: 14,
        backgroundColor: colors.background,
        borderBottomWidth: 1, borderBottomColor: colors.border,
      }}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={({ pressed }) => ({
            flexDirection: "row", alignItems: "center", gap: 6,
            alignSelf: "flex-start", marginBottom: 10, opacity: pressed ? 0.6 : 1,
          })}
        >
          <Feather name="arrow-left" size={18} color={primary} />
          <Text style={{ fontSize: 15, color: primary, fontFamily: "Inter_600SemiBold" }}>Back</Text>
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", letterSpacing: -0.5 }} numberOfLines={2}>
          {eventName}
        </Text>
        {eventDate ? (
          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 3 }}>
            {fmtDate(eventDate)}
          </Text>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 20, paddingBottom: insets.bottom + 40 }}>
        {results.map((ev, ri) => (
          <View key={`${ev.eventId}-${ri}`} style={{ gap: 12 }}>
            {/* Rider + class summary */}
            <View style={{
              borderRadius: 12, borderWidth: 1, borderColor: colors.border,
              backgroundColor: colors.card, padding: 14,
              flexDirection: "row", alignItems: "center", gap: 12,
            }}>
              <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: primary + "18", alignItems: "center", justifyContent: "center" }}>
                <Feather name="flag" size={22} color={primary} />
              </View>
              <View style={{ flex: 1 }}>
                {ev.riderName ? (
                  <Text style={{ fontSize: 11, fontWeight: "700", color: ACCENT, fontFamily: "Inter_700Bold", marginBottom: 2 }}>
                    {ev.riderName}
                  </Text>
                ) : null}
                <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
                  {ev.raceClass}
                </Text>
                <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
                  {ev.motos.length} moto{ev.motos.length !== 1 ? "s" : ""}
                  {ev.totalPoints > 0 ? `  ·  ${ev.totalPoints} pts` : ""}
                  {ev.eventLocation ? `  ·  ${ev.eventLocation}` : ev.eventState ? `  ·  ${ev.eventState}` : ""}
                </Text>
              </View>
              {ev.bestPosition != null && (
                <View style={{ alignItems: "center" }}>
                  <Text style={{ fontSize: 28, fontWeight: "800", color: primary, fontFamily: "Inter_700Bold" }}>
                    P{ev.bestPosition}
                  </Text>
                  <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: "Inter_500Medium", textTransform: "uppercase", letterSpacing: 0.5 }}>
                    Best
                  </Text>
                </View>
              )}
            </View>

            {/* Motos */}
            {ev.motos.map(moto => {
              const hasTimes = moto.lapTimes.length > 0;
              const lapMsArr = hasTimes ? moto.lapTimes.map(parseLapMs) : [];
              const trueLaps = lapMsArr.slice(1); // lap 1 is partial (gate to line), exclude from best
              const bestMs = trueLaps.length > 0 ? Math.min(...trueLaps) : Infinity;
              const fastestIdx = bestMs < Infinity ? lapMsArr.findIndex((ms, i) => i > 0 && ms === bestMs) : -1;

              return (
                <View key={moto.motoId} style={{
                  borderRadius: 12, borderWidth: 1, borderColor: colors.border,
                  backgroundColor: colors.card, overflow: "hidden",
                }}>
                  {/* Moto header */}
                  <View style={{
                    flexDirection: "row", alignItems: "center", gap: 10, padding: 12,
                    borderBottomWidth: 1, borderBottomColor: colors.border,
                    backgroundColor: colors.muted + "50",
                  }}>
                    <View style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: primary + "18", alignItems: "center", justifyContent: "center" }}>
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
                          <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>{moto.totalTime}</Text>
                        ) : null}
                        {moto.points != null && moto.points > 0 ? (
                          <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>{moto.points} pts</Text>
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
                        <Text style={{ fontSize: 14, fontWeight: "700", color: "#fff", fontFamily: "Inter_700Bold" }}>P{moto.position}</Text>
                      </View>
                    ) : null}
                  </View>

                  {/* Lap table */}
                  {hasTimes ? (
                    <View>
                      <View style={{
                        flexDirection: "row", paddingHorizontal: 14, paddingVertical: 7,
                        backgroundColor: colors.muted + "40",
                        borderBottomWidth: 1, borderBottomColor: colors.border,
                      }}>
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
                            <Text style={{ width: 36, fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>{i + 1}</Text>
                            <Text style={{
                              flex: 1, fontSize: 15,
                              fontWeight: isFastest ? "800" : "400",
                              color: isFastest ? primary : colors.foreground,
                              fontFamily: isFastest ? "Inter_700Bold" : "Inter_400Regular",
                            }}>
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
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
