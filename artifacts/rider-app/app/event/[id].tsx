import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";
import { RaceGasWidget } from "@/components/RaceGasWidget";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN ?? ""}`;

interface EventDetail {
  id: number;
  name: string;
  date: string;
  location: string | null;
  state: string | null;
  trackName: string | null;
  status: string;
  entryFee: number | null;
  raceClasses: string[];
  clubName: string | null;
  clubId: number;
  paymentEnabled: boolean;
  registrationClose: string | null;
}

interface LineupEntry {
  gate: number;
  riderId: number;
  riderName: string;
  bibNumber: string | null;
}

interface Moto {
  id: number;
  motoNumber: number;
  name: string;
  type: string;
  raceClass: string | null;
  status: string;
  lineup: LineupEntry[];
  scheduledTime: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { profiles, isAuthenticated } = useRiderAuth();

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [motos, setMotos] = useState<Moto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRegisterModal, setShowRegisterModal] = useState(false);

  const familyRiderIds = (profiles ?? []).map(p => p.id);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const [evtRes, motoRes] = await Promise.all([
        fetch(`${BASE_URL}/api/events/${id}`),
        fetch(`${BASE_URL}/api/events/${id}/motos`),
      ]);
      if (!evtRes.ok) throw new Error("Event not found");
      const evtData = await evtRes.json();
      setEvent(evtData);
      if (motoRes.ok) {
        const raw: any[] = await motoRes.json();
        setMotos(raw.map(m => ({ ...m, lineup: Array.isArray(m.lineup) ? m.lineup : [] })));
      }
    } catch (e: any) {
      setError(e.message ?? "Failed to load event");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const raceMotos = motos.filter(m => m.type !== "practice");
  const inProgressMoto = raceMotos.find(m => m.status === "in_progress") ?? null;
  const scheduledMotos = raceMotos.filter(m => m.status === "scheduled");

  const myScheduledMotos = scheduledMotos.filter(m =>
    m.lineup.some(e => familyRiderIds.includes(e.riderId))
  );
  const nextMyMoto = myScheduledMotos[0] ?? null;
  const racesUntilUp = nextMyMoto
    ? scheduledMotos.findIndex(m => m.id === nextMyMoto.id)
    : -1;

  function myGateIn(moto: Moto): number | null {
    return moto.lineup.find(e => familyRiderIds.includes(e.riderId))?.gate ?? null;
  }

  function isMyMoto(moto: Moto) {
    return isAuthenticated && moto.lineup.some(e => familyRiderIds.includes(e.riderId));
  }

  const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    topBar: {
      paddingTop: insets.top + 10,
      paddingHorizontal: 16,
      paddingBottom: 8,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    backBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
    backText: { fontSize: 15, color: colors.primary, fontFamily: "Inter_600SemiBold" },
    header: {
      paddingHorizontal: 16,
      paddingTop: 4,
      paddingBottom: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    liveBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: "#ef444420",
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 20,
      alignSelf: "flex-start",
      marginBottom: 8,
    },
    liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#ef4444" },
    liveText: { fontSize: 11, fontWeight: "700", color: "#ef4444", fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
    openBadge: {
      alignSelf: "flex-start",
      backgroundColor: "#22c55e20",
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 20,
      marginBottom: 8,
    },
    openText: { fontSize: 11, fontWeight: "700", color: "#22c55e", fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
    eventName: {
      fontSize: 22,
      fontWeight: "800",
      color: colors.foreground,
      fontFamily: "Inter_700Bold",
      letterSpacing: -0.5,
      marginBottom: 6,
    },
    metaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 5 },
    metaText: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular" },
    nowUpCard: {
      marginHorizontal: 16,
      marginTop: 16,
      borderRadius: 14,
      overflow: "hidden",
      borderWidth: 1.5,
      borderColor: "#ef4444",
    },
    nowUpHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: "#ef4444",
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    upNextCard: {
      marginHorizontal: 16,
      marginTop: 12,
      borderRadius: 14,
      overflow: "hidden",
      borderWidth: 1.5,
      borderColor: "#f59e0b",
    },
    upNextHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: "#f59e0b",
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    cardHeaderText: {
      fontSize: 11,
      fontWeight: "800",
      color: "#fff",
      fontFamily: "Inter_700Bold",
      letterSpacing: 1,
    },
    cardBody: { backgroundColor: colors.card, padding: 14 },
    cardMotoName: { fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" },
    cardClass: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 },
    gateChip: {
      marginTop: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.background,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      alignSelf: "flex-start",
    },
    gateText: { fontSize: 14, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" },
    countText: {
      marginTop: 8,
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: "Inter_400Regular",
      fontStyle: "italic",
    },
    sectionHeader: {
      paddingHorizontal: 16,
      paddingTop: 20,
      paddingBottom: 8,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    sectionTitle: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.mutedForeground,
      fontFamily: "Inter_700Bold",
      textTransform: "uppercase",
      letterSpacing: 0.8,
    },
    motoRow: {
      marginHorizontal: 16,
      marginBottom: 6,
      borderRadius: 10,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      padding: 12,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    motoRowMine: { borderColor: colors.primary, borderWidth: 1.5 },
    motoNum: { width: 28, fontSize: 13, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold" },
    chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
    chipText: { fontSize: 11, fontWeight: "700", fontFamily: "Inter_700Bold" },
    registerCard: {
      margin: 16,
      borderRadius: 14,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      padding: 16,
    },
    primaryBtn: {
      marginTop: 14,
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: "center",
    },
    mutedBtn: {
      marginTop: 14,
      backgroundColor: colors.muted,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: "center",
    },
    btnText: { color: "#fff", fontSize: 16, fontWeight: "700", fontFamily: "Inter_700Bold" },
    classChip: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 20,
      backgroundColor: colors.muted,
      marginRight: 6,
      marginBottom: 6,
    },
    modalOverlay: { flex: 1, backgroundColor: "#00000088", justifyContent: "flex-end" },
    modalBox: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      padding: 20,
      paddingBottom: insets.bottom + 20,
    },
    modalTitle: { fontSize: 18, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", marginBottom: 4 },
    modalSub: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginBottom: 16, lineHeight: 18 },
  });

  if (loading) {
    return (
      <View style={[s.container, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (error || !event) {
    return (
      <View style={[s.container, { alignItems: "center", justifyContent: "center", padding: 32, gap: 10 }]}>
        <Feather name="alert-circle" size={36} color={colors.mutedForeground} />
        <Text style={{ fontSize: 18, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
          Event not found
        </Text>
        <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>
          {error}
        </Text>
        <Pressable onPress={() => router.back()} style={{ marginTop: 8 }}>
          <Text style={{ color: colors.primary, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const isRaceDay = event.status === "race_day";
  const isRegOpen = event.status === "registration_open";

  const statusChip = (status: string) => {
    const map: Record<string, { label: string; color: string }> = {
      in_progress: { label: "LIVE", color: "#ef4444" },
      completed:   { label: "DONE", color: "#22c55e" },
      scheduled:   { label: "UP",   color: "#6b7280" },
    };
    return map[status] ?? { label: status, color: "#6b7280" };
  };

  return (
    <>
      <ScrollView
        style={s.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
        {/* Top bar: back + race gas */}
        <View style={s.topBar}>
          <Pressable style={s.backBtn} onPress={() => router.back()}>
            <Feather name="chevron-left" size={20} color={colors.primary} />
            <Text style={s.backText}>Events</Text>
          </Pressable>
          <RaceGasWidget />
        </View>

        {/* Event header */}
        <View style={s.header}>
          {isRaceDay && (
            <View style={s.liveBadge}>
              <View style={s.liveDot} />
              <Text style={s.liveText}>LIVE NOW</Text>
            </View>
          )}
          {isRegOpen && (
            <View style={s.openBadge}>
              <Text style={s.openText}>REGISTRATION OPEN</Text>
            </View>
          )}
          <Text style={s.eventName}>{event.name}</Text>
          <View style={s.metaRow}>
            <Feather name="calendar" size={13} color={colors.mutedForeground} />
            <Text style={s.metaText}>{fmtDate(event.date)}</Text>
          </View>
          {(event.location || event.state) && (
            <View style={s.metaRow}>
              <Feather name="map-pin" size={13} color={colors.mutedForeground} />
              <Text style={s.metaText}>{[event.location, event.state].filter(Boolean).join(", ")}</Text>
            </View>
          )}
          {event.trackName && (
            <View style={s.metaRow}>
              <Feather name="flag" size={13} color={colors.mutedForeground} />
              <Text style={s.metaText}>{event.trackName}</Text>
            </View>
          )}
          {event.clubName && (
            <View style={s.metaRow}>
              <Feather name="users" size={13} color={colors.mutedForeground} />
              <Text style={s.metaText}>{event.clubName}</Text>
            </View>
          )}
        </View>

        {/* ─── RACE DAY view ─── */}
        {isRaceDay && (
          <>
            {/* Now Up */}
            {inProgressMoto && (
              <View style={s.nowUpCard}>
                <View style={s.nowUpHeader}>
                  <Feather name="radio" size={12} color="#fff" />
                  <Text style={s.cardHeaderText}>NOW UP</Text>
                </View>
                <View style={s.cardBody}>
                  <Text style={s.cardMotoName}>{inProgressMoto.name}</Text>
                  {inProgressMoto.raceClass && <Text style={s.cardClass}>{inProgressMoto.raceClass}</Text>}
                  {isMyMoto(inProgressMoto) && myGateIn(inProgressMoto) != null && (
                    <View style={s.gateChip}>
                      <Feather name="flag" size={14} color={colors.primary} />
                      <Text style={s.gateText}>Your Gate: #{myGateIn(inProgressMoto)}</Text>
                    </View>
                  )}
                </View>
              </View>
            )}

            {/* Up Next for rider */}
            {isAuthenticated && nextMyMoto && (
              <View style={s.upNextCard}>
                <View style={s.upNextHeader}>
                  <Feather name="clock" size={12} color="#fff" />
                  <Text style={s.cardHeaderText}>YOU'RE UP NEXT</Text>
                </View>
                <View style={s.cardBody}>
                  <Text style={s.cardMotoName}>{nextMyMoto.name}</Text>
                  {nextMyMoto.raceClass && <Text style={s.cardClass}>{nextMyMoto.raceClass}</Text>}
                  {myGateIn(nextMyMoto) != null && (
                    <View style={[s.gateChip, { borderWidth: 1, borderColor: "#f59e0b22" }]}>
                      <Feather name="flag" size={14} color="#f59e0b" />
                      <Text style={[s.gateText, { color: "#f59e0b" }]}>Gate #{myGateIn(nextMyMoto)}</Text>
                    </View>
                  )}
                  {racesUntilUp === 0 ? (
                    <Text style={s.countText}>You're on deck — get ready!</Text>
                  ) : racesUntilUp > 0 ? (
                    <Text style={s.countText}>
                      {racesUntilUp} {racesUntilUp === 1 ? "race" : "races"} until you're up
                    </Text>
                  ) : null}
                </View>
              </View>
            )}

            {/* Full schedule */}
            {raceMotos.length > 0 && (
              <>
                <View style={s.sectionHeader}>
                  <Feather name="list" size={14} color={colors.mutedForeground} />
                  <Text style={s.sectionTitle}>Full Schedule</Text>
                  <Text style={{ marginLeft: "auto", fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                    {scheduledMotos.length} remaining
                  </Text>
                </View>
                {raceMotos.map(moto => {
                  const mine = isMyMoto(moto);
                  const chip = statusChip(moto.status);
                  const gate = mine ? myGateIn(moto) : null;
                  return (
                    <View key={moto.id} style={[s.motoRow, mine && s.motoRowMine]}>
                      <Text style={s.motoNum}>#{moto.motoNumber}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: colors.foreground, fontFamily: "Inter_600SemiBold" }}>
                          {moto.name}
                        </Text>
                        {moto.raceClass && (
                          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>
                            {moto.raceClass}
                          </Text>
                        )}
                        {mine && gate != null && (
                          <Text style={{ fontSize: 12, color: colors.primary, fontFamily: "Inter_600SemiBold", marginTop: 2 }}>
                            Gate #{gate}
                          </Text>
                        )}
                      </View>
                      <View style={[s.chip, { backgroundColor: chip.color + "22" }]}>
                        <Text style={[s.chipText, { color: chip.color }]}>{chip.label}</Text>
                      </View>
                    </View>
                  );
                })}
              </>
            )}

            {raceMotos.length === 0 && !inProgressMoto && (
              <View style={{ alignItems: "center", paddingTop: 48, paddingHorizontal: 32, gap: 8 }}>
                <Feather name="clock" size={36} color={colors.mutedForeground} />
                <Text style={{ fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
                  Schedule not yet posted
                </Text>
                <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>
                  Pull to refresh — motos will appear once the organizer posts them.
                </Text>
              </View>
            )}
          </>
        )}

        {/* ─── REGISTRATION view ─── */}
        {isRegOpen && (
          <View style={s.registerCard}>
            {event.entryFee != null && (
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4, marginBottom: 14 }}>
                <Text style={{ fontSize: 28, fontWeight: "800", color: colors.primary, fontFamily: "Inter_700Bold" }}>
                  ${event.entryFee}
                </Text>
                <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                  entry fee
                </Text>
              </View>
            )}
            {(event.raceClasses ?? []).length > 0 && (
              <>
                <Text style={{ fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
                  Available Classes
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", marginBottom: 4 }}>
                  {(event.raceClasses ?? []).map(cls => (
                    <View key={cls} style={s.classChip}>
                      <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_500Medium" }}>
                        {cls}
                      </Text>
                    </View>
                  ))}
                </View>
              </>
            )}
            {isAuthenticated ? (
              <Pressable style={s.primaryBtn} onPress={() => setShowRegisterModal(true)}>
                <Text style={s.btnText}>Register Now</Text>
              </Pressable>
            ) : (
              <>
                <Pressable style={s.mutedBtn} onPress={() => router.push("/rider" as any)}>
                  <Text style={[s.btnText, { color: colors.mutedForeground }]}>Sign in to Register</Text>
                </Pressable>
                <Text style={{ marginTop: 8, fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>
                  Create a free rider account to register for this event.
                </Text>
              </>
            )}
          </View>
        )}
      </ScrollView>

      {/* Register modal */}
      <Modal
        visible={showRegisterModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowRegisterModal(false)}
      >
        <Pressable style={s.modalOverlay} onPress={() => setShowRegisterModal(false)}>
          <Pressable style={s.modalBox} onPress={() => {}}>
            <Text style={s.modalTitle}>Register for {event.name}</Text>
            <Text style={s.modalSub}>{fmtDate(event.date)}</Text>
            {(profiles ?? []).length === 0 ? (
              <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", lineHeight: 20 }}>
                No rider profiles linked. Register for an event through the club website first to link your profile.
              </Text>
            ) : (
              <>
                {(profiles ?? []).map(p => (
                  <View
                    key={p.id}
                    style={{ marginBottom: 10, padding: 12, borderRadius: 10, backgroundColor: colors.background, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}
                  >
                    <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
                      {p.firstName} {p.lastName}
                    </Text>
                    {p.bibNumber && (
                      <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                        #{p.bibNumber}
                      </Text>
                    )}
                  </View>
                ))}
              </>
            )}
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 12, lineHeight: 18 }}>
              Online in-app registration coming soon.{"\n"}Contact the club directly to register.
            </Text>
            <Pressable style={s.mutedBtn} onPress={() => setShowRegisterModal(false)}>
              <Text style={[s.btnText, { color: colors.mutedForeground }]}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
