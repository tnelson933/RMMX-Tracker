import { Feather } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
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
import { RmCashWidget } from "@/components/RmCashWidget";
import { NETWORK_ERROR_MESSAGE } from "@/lib/friendlyErrors";
import * as WebBrowser from "expo-web-browser";
import { EmptyState } from "@/components/EmptyState";
import { eventDay, placeLabel } from "@/lib/format";
import { goBack } from "@/lib/navigation";

const BASE_URL = `https://${process.env.EXPO_PUBLIC_DOMAIN ?? ""}`;

interface EventDetail {
  id: number;
  name: string;
  date: string;
  location: string | null;
  state: string | null;
  trackName: string | null;
  status: string;
  raceStyle: string;
  entryFee: number | null;
  raceClasses: string[];
  clubName: string | null;
  clubId: number;
  paymentEnabled: boolean;
  registrationClose: string | null;
  classStartTimes: Record<string, string | null>;
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

interface MyRegistration {
  id: number;
  raceClass: string;
  riderId: number;
  riderName: string;
  status: string;
}

function fmtDate(iso: string) {
  return eventDay(iso).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

function fmtStartTime(t: string | null | undefined): string {
  if (!t) return "TBD";
  const [hStr, mStr] = t.split(":");
  const h = parseInt(hStr ?? "0", 10);
  const m = parseInt(mStr ?? "0", 10);
  const ampm = h >= 12 ? "PM" : "AM";
  const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${displayH}:${String(m).padStart(2, "0")} ${ampm}`;
}

function openRegistration(eventId: number, email?: string | null) {
  const emailParam = email ? `?email=${encodeURIComponent(email)}` : "";
  const path = `/register/${eventId}${emailParam}`;
  if (Platform.OS === "web") {
    if (typeof window !== "undefined") window.open(window.location.origin + path, "_blank");
  } else {
    void Linking.openURL(`${BASE_URL}${path}`);
  }
}

export default function EventDetailScreen() {
  const { id, schedule } = useLocalSearchParams<{ id: string; schedule?: string }>();
  const router    = useRouter();
  const colors    = useColors();
  const insets    = useSafeAreaInsets();
  const { profiles, isAuthenticated, riderFetch, account } = useRiderAuth();

  const scrollViewRef = useRef<ScrollView>(null);
  const [scheduleY,  setScheduleY]  = useState<number | null>(null);

  const [event,   setEvent]   = useState<EventDetail | null>(null);
  const [motos,   setMotos]   = useState<Moto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [showRegisterModal, setShowRegisterModal] = useState(false);
  const [registeredClasses, setRegisteredClasses] = useState<Set<string>>(new Set());
  const [myRegistrations, setMyRegistrations] = useState<MyRegistration[]>([]);
  const [showChangeClassModal, setShowChangeClassModal] = useState(false);
  const [changingReg, setChangingReg] = useState<MyRegistration | null>(null);
  const [changeClassLoading, setChangeClassLoading] = useState(false);
  const [changeClassError, setChangeClassError] = useState<string | null>(null);

  const familyRiderIds = (profiles ?? []).map(p => p.id);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [evtRes, motoRes] = await Promise.all([
        fetch(`${BASE_URL}/api/events/${id}`),
        fetch(`${BASE_URL}/api/events/${id}/motos`),
      ]);
      if (!evtRes.ok) throw new Error(evtRes.status === 404 ? "Event not found" : `Couldn't load this event (error ${evtRes.status}).`);
      setEvent(await evtRes.json());
      setError(null);
      if (motoRes.ok) {
        const raw: any[] = await motoRes.json();
        setMotos(raw.map(m => ({ ...m, lineup: Array.isArray(m.lineup) ? m.lineup : [] })));
      }
    } catch (e: any) {
      // A failed background refresh keeps the loaded event; the screen shows a banner instead.
      setError(e instanceof TypeError ? NETWORK_ERROR_MESSAGE : (e?.message ?? "Failed to load event"));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Fetch which classes this rider is already registered for
  useEffect(() => {
    if (!isAuthenticated || !id) { setRegisteredClasses(new Set()); setMyRegistrations([]); return; }
    riderFetch(`/api/rider/events/${id}/my-registrations`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { registeredClasses: string[]; registrations?: MyRegistration[] } | null) => {
        if (data?.registeredClasses) setRegisteredClasses(new Set(data.registeredClasses));
        if (data?.registrations) setMyRegistrations(data.registrations);
      })
      .catch(() => {});
  }, [isAuthenticated, id, riderFetch]);

  async function handleChangeClass(reg: MyRegistration, newClass: string) {
    setChangeClassLoading(true);
    setChangeClassError(null);
    try {
      const res = await riderFetch(`/api/rider/events/${id}/my-registrations/${reg.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raceClass: newClass }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to change class");
      }
      setMyRegistrations(prev => prev.map(r => r.id === reg.id ? { ...r, raceClass: newClass } : r));
      setRegisteredClasses(prev => {
        const next = new Set(prev);
        next.delete(reg.raceClass);
        next.add(newClass);
        return next;
      });
      setShowChangeClassModal(false);
      setChangingReg(null);
    } catch (e: unknown) {
      setChangeClassError(e instanceof Error ? e.message : "Failed to change class");
    } finally {
      setChangeClassLoading(false);
    }
  }

  const loadFailed = error !== null;
  // Auto-poll every 15 s while the event is live so riders see race updates instantly
  useEffect(() => {
    // Also retry after a failed refresh so the "Offline, retrying" banner clears itself.
    if (!event || (event.status !== "race_day" && !loadFailed)) return;
    const timer = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(timer);
  }, [event?.status, loadFailed, load]);

  // Auto-scroll to Race Schedule when arriving from a live event tap
  useEffect(() => {
    if (!loading && schedule === "1" && scheduleY !== null) {
      const timer = setTimeout(() => {
        scrollViewRef.current?.scrollTo({ y: scheduleY - 12, animated: true });
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [loading, schedule, scheduleY]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // ── Schedule helpers ─────────────────────────────────────────────────────
  const raceMotos      = motos.filter(m => m.type !== "practice");
  const inProgressMoto = raceMotos.find(m => m.status === "in_progress") ?? null;
  const scheduledMotos = raceMotos.filter(m => m.status === "scheduled");

  // Motos where a family rider is in the lineup
  const myScheduledMotos = scheduledMotos.filter(m =>
    m.lineup.some(e => familyRiderIds.includes(e.riderId))
  );
  const nextMyMoto   = myScheduledMotos[0] ?? null;
  const racesUntilUp = nextMyMoto
    ? scheduledMotos.findIndex(m => m.id === nextMyMoto.id)
    : -1;

  function myGateIn(moto: Moto): number | null {
    return moto.lineup.find(e => familyRiderIds.includes(e.riderId))?.gate ?? null;
  }
  function isMyMoto(moto: Moto) {
    return isAuthenticated && moto.lineup.some(e => familyRiderIds.includes(e.riderId));
  }
  function raceLabel(moto: Moto) {
    return `Race #${moto.motoNumber}`;
  }

  // ── Styles ───────────────────────────────────────────────────────────────
  const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    topBar: {
      paddingTop: insets.top + 10,
      paddingHorizontal: 16,
      paddingBottom: 8,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: colors.background,
    },
    backBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
    backText: { fontSize: 15, color: colors.primary, fontFamily: "Inter_600SemiBold" },
    hero: {
      marginHorizontal: 16, marginTop: 4, marginBottom: 14, padding: 16, borderRadius: 20,
      backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, overflow: "hidden",
    },
    heroStripes: { position: "absolute", top: 18, left: -60, right: -60, transform: [{ rotate: "-12deg" }] },
    statusRow: { flexDirection: "row", gap: 8, minHeight: 4 },
    dateBlock: {
      width: 62, height: 66, borderRadius: 14, backgroundColor: colors.primary,
      alignItems: "center", justifyContent: "center",
    },
    dateMonth: { fontSize: 12, color: "#fff", fontFamily: "Inter_700Bold", letterSpacing: 1.5 },
    dateDay: { fontSize: 28, color: "#fff", fontFamily: "Inter_700Bold", lineHeight: 32 },
    metaChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 14 },
    metaChip: {
      flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: colors.muted,
      borderRadius: 999, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: colors.border,
    },
    metaChipText: { fontSize: 12, color: colors.foreground, fontFamily: "Inter_600SemiBold" },
    liveBadge: {
      flexDirection: "row", alignItems: "center", gap: 4,
      backgroundColor: "#ef444420", paddingHorizontal: 10, paddingVertical: 4,
      borderRadius: 20, alignSelf: "flex-start", marginBottom: 8,
    },
    liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#ef4444" },
    liveText: { fontSize: 11, fontWeight: "700", color: "#ef4444", fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
    openBadge: {
      alignSelf: "flex-start", backgroundColor: "#22c55e20",
      paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, marginBottom: 8,
    },
    openText: { fontSize: 11, fontWeight: "700", color: "#22c55e", fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
    eventName: {
      fontSize: 22, fontWeight: "800", color: colors.foreground,
      fontFamily: "Inter_700Bold", letterSpacing: 0.5, textTransform: "uppercase", fontStyle: "italic", marginBottom: 2,
    },
    metaText: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular" },

    // NOW RACING card
    nowCard: {
      marginHorizontal: 16, marginTop: 16,
      borderRadius: 14, overflow: "hidden",
      borderWidth: 1.5, borderColor: "#ef4444",
    },
    nowHeader: {
      flexDirection: "row", alignItems: "center", justifyContent: "space-between",
      backgroundColor: "#ef4444", paddingHorizontal: 14, paddingVertical: 10,
    },
    nowHeaderLeft: { flexDirection: "row", alignItems: "center", gap: 6 },
    nowHeaderText: { fontSize: 11, fontWeight: "800", color: "#fff", fontFamily: "Inter_700Bold", letterSpacing: 1 },
    nowRaceNum: { fontSize: 13, fontWeight: "800", color: "#fff", fontFamily: "Inter_700Bold", opacity: 0.9 },

    // YOU'RE UP card
    upCard: {
      marginHorizontal: 16, marginTop: 12,
      borderRadius: 14, overflow: "hidden",
      borderWidth: 1.5, borderColor: "#cf152d",
    },
    upHeader: {
      flexDirection: "row", alignItems: "center", justifyContent: "space-between",
      backgroundColor: "#cf152d", paddingHorizontal: 14, paddingVertical: 10,
    },
    upHeaderText: { fontSize: 11, fontWeight: "800", color: "#fff", fontFamily: "Inter_700Bold", letterSpacing: 1 },
    upRaceNum: { fontSize: 13, fontWeight: "800", color: "#fff", fontFamily: "Inter_700Bold", opacity: 0.9 },

    cardBody: { backgroundColor: colors.card, padding: 14 },
    cardName: { fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" },
    cardClass: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 },
    gateChip: {
      marginTop: 10, flexDirection: "row", alignItems: "center", gap: 6,
      backgroundColor: colors.background, borderRadius: 8,
      paddingHorizontal: 10, paddingVertical: 6, alignSelf: "flex-start",
    },
    countRow: {
      marginTop: 10, flexDirection: "row", alignItems: "center", gap: 6,
      paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border,
    },

    // Schedule
    sectionRow: {
      paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8,
      flexDirection: "row", alignItems: "center", gap: 6,
    },
    sectionTitle: {
      fontSize: 12, fontWeight: "700", color: colors.mutedForeground,
      fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.8,
    },
    motoRow: {
      marginHorizontal: 16, marginBottom: 6, borderRadius: 10,
      backgroundColor: colors.card, borderWidth: 1,
      borderColor: colors.border, padding: 12,
      flexDirection: "row", alignItems: "center", gap: 10,
    },
    motoRowMine: { borderColor: colors.primary, borderWidth: 1.5 },
    motoRowLive: { borderColor: "#ef4444", borderWidth: 1.5 },
    raceNumBadge: {
      width: 44, height: 44, borderRadius: 10,
      alignItems: "center", justifyContent: "center",
    },
    raceNumText: { fontSize: 10, fontWeight: "700", fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.3 },
    raceNumValue: { fontSize: 16, fontWeight: "800", fontFamily: "Inter_700Bold", lineHeight: 18 },
    statusChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
    statusChipText: { fontSize: 11, fontWeight: "700", fontFamily: "Inter_700Bold" },

    // Registration
    registerCard: {
      margin: 16, borderRadius: 18, backgroundColor: colors.card,
      borderWidth: 1, borderColor: colors.border, padding: 18,
    },
    primaryBtn: { marginTop: 14, backgroundColor: colors.primary, borderRadius: 999, paddingVertical: 15, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 },
    mutedBtn:   { marginTop: 14, backgroundColor: colors.muted,   borderRadius: 999, paddingVertical: 15, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 },
    btnText:    { color: "#fff", fontSize: 15, fontWeight: "700", fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 1 },

    // Modal
    modalOverlay: { flex: 1, backgroundColor: "#00000088", justifyContent: "flex-end" },
    modalBox: {
      backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20,
      padding: 20, paddingBottom: insets.bottom + 20,
    },
  });

  if (loading) {
    return (
      <View style={[s.container, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (!event) {
    return (
      <View style={[s.container, { alignItems: "center", justifyContent: "center", padding: 32, gap: 10 }]}>
        <Feather name="alert-circle" size={36} color={colors.mutedForeground} />
        <Text style={{ fontSize: 18, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
          {error === "Event not found" || !error ? "Event not found" : "Couldn't load event"}
        </Text>
        {error && error !== "Event not found" && (
          <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>{error}</Text>
        )}
        {error && error !== "Event not found" && (
          <Pressable onPress={() => { setLoading(true); void load(); }} style={{ marginTop: 8 }}>
            <Text style={{ color: colors.primary, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>Try again</Text>
          </Pressable>
        )}
        <Pressable onPress={() => goBack(router)} style={{ marginTop: 8 }}>
          <Text style={{ color: colors.primary, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const isRaceDay = event.status === "race_day";
  const isRegOpen = event.status === "registration_open";
  const isFinished = event.status === "completed";

  const chipFor = (status: string) => {
    const map: Record<string, { label: string; color: string }> = {
      in_progress: { label: "LIVE",      color: "#ef4444" },
      completed:   { label: "FINISHED",  color: "#22c55e" },
      scheduled:   { label: "UPCOMING",  color: "#6b7280" },
    };
    return map[status] ?? { label: status.toUpperCase(), color: "#6b7280" };
  };

  return (
    <>
      <ScrollView
        ref={scrollViewRef}
        style={s.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
        {/* Top bar */}
        <View style={s.topBar}>
          <Pressable style={s.backBtn} onPress={() => goBack(router)}>
            <Feather name="chevron-left" size={20} color={colors.primary} />
            <Text style={s.backText}>Events</Text>
          </Pressable>
          <RmCashWidget />
        </View>

        {/* Background refresh failed: keep showing the last data */}
        {error && (
          <View style={{
            flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "center",
            backgroundColor: colors.muted, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6,
            marginBottom: 8,
          }}>
            <Feather name="wifi-off" size={12} color={colors.mutedForeground} />
            <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_600SemiBold" }}>Offline, retrying</Text>
          </View>
        )}

        {/* Event hero: race-poster header with a date block and status */}
        <View style={s.hero}>
          <View pointerEvents="none" style={s.heroStripes}>
            <View style={{ height: 3, backgroundColor: colors.primary, opacity: 0.6, marginRight: 120 }} />
            <View style={{ height: 8, backgroundColor: colors.primary, opacity: 0.25, marginTop: 10, marginLeft: 80 }} />
            <View style={{ height: 2, backgroundColor: colors.foreground, opacity: 0.1, marginTop: 10, marginRight: 40 }} />
          </View>

          <View style={s.statusRow}>
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
            {isFinished && (
              <View style={[s.openBadge, { backgroundColor: colors.muted }]}>
                <Text style={[s.openText, { color: colors.mutedForeground }]}>🏁 FINISHED</Text>
              </View>
            )}
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            <View style={s.dateBlock}>
              <Text style={s.dateMonth}>{eventDay(event.date).toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</Text>
              <Text style={s.dateDay}>{eventDay(event.date).getDate()}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.eventName}>{event.name}</Text>
              <Text style={s.metaText}>{fmtDate(event.date)}</Text>
            </View>
          </View>

          <View style={s.metaChips}>
            {(event.location || event.state) && (
              <View style={s.metaChip}>
                <Feather name="map-pin" size={12} color={colors.primary} />
                <Text style={s.metaChipText}>{placeLabel(event.location, event.state)}</Text>
              </View>
            )}
            {event.trackName && (
              <View style={s.metaChip}>
                <Feather name="flag" size={12} color={colors.primary} />
                <Text style={s.metaChipText}>{event.trackName}</Text>
              </View>
            )}
            {event.clubName && (
              <View style={s.metaChip}>
                <Feather name="users" size={12} color={colors.primary} />
                <Text style={s.metaChipText}>{event.clubName}</Text>
              </View>
            )}
          </View>
        </View>

        {/* ── RACE DAY view ── */}
        {isRaceDay && (
          <>
            {/* NOW RACING */}
            {inProgressMoto && (
              <View style={s.nowCard}>
                <View style={s.nowHeader}>
                  <View style={s.nowHeaderLeft}>
                    <Feather name="radio" size={12} color="#fff" />
                    <Text style={s.nowHeaderText}>NOW RACING</Text>
                  </View>
                  <Text style={s.nowRaceNum}>{raceLabel(inProgressMoto)}</Text>
                </View>
                <View style={s.cardBody}>
                  <Text style={s.cardName}>{inProgressMoto.name}</Text>
                  {inProgressMoto.raceClass && <Text style={s.cardClass}>{inProgressMoto.raceClass}</Text>}
                  {isMyMoto(inProgressMoto) && (
                    <View style={s.gateChip}>
                      <Feather name="flag" size={14} color={colors.primary} />
                      <Text style={{ fontSize: 14, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
                        {myGateIn(inProgressMoto) != null ? `Your Gate: #${myGateIn(inProgressMoto)}` : "You're in this race!"}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            )}

            {/* ENDURO: test class start times (replaces YOU'RE UP NEXT for enduro events) */}
            {isAuthenticated && event?.raceStyle === "enduro" &&
              Object.keys(event.classStartTimes ?? {}).length > 0 && (
              <View style={s.upCard}>
                <View style={s.upHeader}>
                  <Text style={s.upHeaderText}>TEST CLASS SCHEDULE</Text>
                </View>
                <View style={s.cardBody}>
                  {Object.entries(event.classStartTimes ?? {}).map(([cls, time]) => (
                    <View key={cls} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                      <Text style={{ fontSize: 13, color: colors.foreground, fontFamily: "Inter_500Medium", flex: 1 }}>{cls}</Text>
                      <Text style={{ fontSize: 15, fontWeight: "700", color: "#cf152d", fontFamily: "Inter_700Bold" }}>
                        {fmtStartTime(time)}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* MX/Non-enduro: YOU'RE UP NEXT */}
            {isAuthenticated && event?.raceStyle !== "enduro" && nextMyMoto && (
              <View style={s.upCard}>
                <View style={s.upHeader}>
                  <Text style={s.upHeaderText}>YOU'RE UP NEXT</Text>
                  <Text style={s.upRaceNum}>{raceLabel(nextMyMoto)}</Text>
                </View>
                <View style={s.cardBody}>
                  <Text style={s.cardName}>{nextMyMoto.name}</Text>
                  {nextMyMoto.raceClass && <Text style={s.cardClass}>{nextMyMoto.raceClass}</Text>}
                  {myGateIn(nextMyMoto) != null && (
                    <View style={[s.gateChip, { borderWidth: 1, borderColor: "#cf152d33" }]}>
                      <Feather name="flag" size={14} color="#cf152d" />
                      <Text style={{ fontSize: 14, fontWeight: "700", color: "#cf152d", fontFamily: "Inter_700Bold" }}>
                        Gate #{myGateIn(nextMyMoto)}
                      </Text>
                    </View>
                  )}
                  <View style={s.countRow}>
                    <Feather name="clock" size={14} color={colors.mutedForeground} />
                    {racesUntilUp === 0 ? (
                      <Text style={{ fontSize: 13, color: colors.foreground, fontFamily: "Inter_600SemiBold" }}>
                        You're on deck — get ready!
                      </Text>
                    ) : (
                      <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                        <Text style={{ fontFamily: "Inter_700Bold", color: colors.foreground }}>{racesUntilUp} {racesUntilUp === 1 ? "race" : "races"}</Text>
                        {" "}until you're up ({raceLabel(nextMyMoto)})
                      </Text>
                    )}
                  </View>
                </View>
              </View>
            )}

            {/* Full schedule */}
            {raceMotos.length > 0 && (
              <>
                <View style={s.sectionRow} onLayout={e => setScheduleY(e.nativeEvent.layout.y)}>
                  <Feather name="list" size={14} color={colors.mutedForeground} />
                  <Text style={s.sectionTitle}>Race Schedule</Text>
                  {scheduledMotos.length > 0 && (
                    <Text style={{ marginLeft: "auto", fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                      {scheduledMotos.length} remaining
                    </Text>
                  )}
                </View>

                {raceMotos.map(moto => {
                  const mine = isMyMoto(moto);
                  const live = moto.status === "in_progress";
                  const chip = chipFor(moto.status);
                  const gate = mine ? myGateIn(moto) : null;
                  const badgeBg = live ? "#ef444420" : mine ? colors.primary + "18" : colors.muted;
                  const badgeFg = live ? "#ef4444" : mine ? colors.primary : colors.mutedForeground;

                  return (
                    <View key={moto.id} style={[s.motoRow, live && s.motoRowLive, !live && mine && s.motoRowMine]}>
                      {/* Race # badge */}
                      <View style={[s.raceNumBadge, { backgroundColor: badgeBg }]}>
                        <Text style={[s.raceNumText, { color: badgeFg }]}>RACE</Text>
                        <Text style={[s.raceNumValue, { color: badgeFg }]}>#{moto.motoNumber}</Text>
                      </View>

                      {/* Moto info */}
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: colors.foreground, fontFamily: "Inter_600SemiBold" }}>
                          {moto.name}
                        </Text>
                        {moto.raceClass && (
                          <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 1 }}>
                            {moto.raceClass}
                          </Text>
                        )}
                        {mine && event?.raceStyle !== "enduro" && gate != null && (
                          <Text style={{ fontSize: 12, color: mine && !live ? colors.primary : "#ef4444", fontFamily: "Inter_600SemiBold", marginTop: 3 }}>
                            Gate #{gate}
                          </Text>
                        )}
                        {mine && (event?.raceStyle !== "enduro" ? gate == null : true) && (
                          <Text style={{ fontSize: 12, color: colors.primary, fontFamily: "Inter_600SemiBold", marginTop: 3 }}>
                            ★ {event?.raceStyle === "enduro" ? "Your test" : "Your race"}
                          </Text>
                        )}
                      </View>

                      {/* Status chip */}
                      <View style={[s.statusChip, { backgroundColor: chip.color + "22" }]}>
                        <Text style={[s.statusChipText, { color: chip.color }]}>{chip.label}</Text>
                      </View>
                    </View>
                  );
                })}
              </>
            )}

            {raceMotos.length === 0 && (
              <View style={{ alignItems: "center", paddingTop: 48, paddingHorizontal: 32, gap: 8 }}>
                <Feather name="clock" size={36} color={colors.mutedForeground} />
                <Text style={{ fontSize: 16, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
                  Schedule not yet posted
                </Text>
                <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>
                  Pull to refresh — race order will appear once the organizer posts it.
                </Text>
              </View>
            )}
          </>
        )}

        {/* ── REGISTRATION view ── */}
        {isRegOpen && (
          <View style={s.registerCard}>
            {event.entryFee != null && (
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4, marginBottom: 14 }}>
                <Text style={{ fontSize: 40, color: colors.foreground, fontFamily: "Inter_700Bold", fontStyle: "italic", letterSpacing: -1 }}>
                  ${event.entryFee}
                </Text>
                <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 1 }}>
                  Entry fee
                </Text>
              </View>
            )}
            {(event.raceClasses ?? []).length > 0 && (
              <>
                <Text style={{ fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
                  Available Classes
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", marginBottom: 4 }}>
                  {(event.raceClasses ?? []).map(cls => {
                    const isRegistered = registeredClasses.has(cls);
                    return (
                      <View key={cls} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, backgroundColor: isRegistered ? "#ef444418" : colors.muted, borderWidth: isRegistered ? 1 : 0, borderColor: "#ef4444", marginRight: 6, marginBottom: 6 }}>
                        <Text style={{ fontSize: 12, color: isRegistered ? "#ef4444" : colors.mutedForeground, fontFamily: "Inter_500Medium" }}>{cls}</Text>
                        {isRegistered && (
                          <Text style={{ fontSize: 10, fontWeight: "700", color: "#ef4444", fontFamily: "Inter_700Bold", marginLeft: 5 }}>· Registered</Text>
                        )}
                      </View>
                    );
                  })}
                </View>
              </>
            )}
            {/* ── My registrations (view + change class) ── */}
            {isAuthenticated && myRegistrations.length > 0 && (
              <View style={{ marginTop: 12, marginBottom: 8, padding: 12, borderRadius: 10, backgroundColor: "#16a34a10", borderWidth: 1, borderColor: "#16a34a30" }}>
                <Text style={{ fontSize: 11, fontWeight: "700", color: "#16a34a", fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
                  {myRegistrations.length === 1 ? "My Registration" : "My Registrations"}
                </Text>
                {myRegistrations.map(reg => (
                  <View key={reg.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
                        {reg.raceClass}
                      </Text>
                      {myRegistrations.length > 1 && (
                        <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                          {reg.riderName}
                        </Text>
                      )}
                    </View>
                    <Pressable
                      onPress={() => { setChangingReg(reg); setChangeClassError(null); setShowChangeClassModal(true); }}
                      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: colors.muted })}
                    >
                      <Text style={{ fontSize: 12, color: colors.primary, fontFamily: "Inter_600SemiBold" }}>Change Class ›</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}

            {isAuthenticated ? (
              <Pressable style={s.primaryBtn} onPress={() => setShowRegisterModal(true)}>
                <Text style={s.btnText}>{myRegistrations.length > 0 ? "Add another class" : "Register now"}</Text>
                <Feather name="arrow-right" size={18} color="#fff" />
              </Pressable>
            ) : (
              <>
                <Pressable style={s.mutedBtn} onPress={() => router.push("/login" as any)}>
                  <Text style={[s.btnText, { color: colors.mutedForeground }]}>Sign in to Register</Text>
                </Pressable>
                <Text style={{ marginTop: 8, fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center" }}>
                  Create a free rider account to register for this event.
                </Text>
              </>
            )}
          </View>
        )}
        {/* ── FINISHED view ── */}
        {isFinished && (
          <EmptyState
            variant="card"
            icon="flag"
            title="Checkered flag"
            message={myRegistrations.length > 0 || registeredClasses.size > 0
              ? "This race is in the books. See how you did, moto by moto."
              : "This race is in the books. Check the full results, or find your next race."}
            primary={myRegistrations.length > 0 || registeredClasses.size > 0
              ? { label: "Your results", icon: "award", onPress: () => router.push(`/result/${event.id}` as any) }
              : { label: "Full results", icon: "list", onPress: () => void WebBrowser.openBrowserAsync(`${BASE_URL}/results/${event.id}`) }}
            secondary={myRegistrations.length > 0 || registeredClasses.size > 0
              ? { label: "Full results", onPress: () => void WebBrowser.openBrowserAsync(`${BASE_URL}/results/${event.id}`) }
              : { label: "Find your next race", onPress: () => router.push("/(tabs)/my-races?filter=near_me" as any) }}
          />
        )}

        {/* ── Not open yet / closed ── */}
        {!isRaceDay && !isRegOpen && !isFinished && (
          <EmptyState
            variant="card"
            icon="clock"
            title="Registration isn't open"
            message="Entries for this race aren't open right now. We'll show the Register button here as soon as they are."
            secondary={{ label: "Find another race", onPress: () => router.push("/(tabs)/my-races?filter=near_me" as any) }}
          />
        )}
      </ScrollView>

      {/* Register modal */}
      <Modal visible={showRegisterModal} transparent animationType="slide" onRequestClose={() => setShowRegisterModal(false)}>
        <Pressable style={s.modalOverlay} onPress={() => setShowRegisterModal(false)}>
          <Pressable style={s.modalBox} onPress={() => {}}>
            <Text style={{ fontSize: 18, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", marginBottom: 4 }}>
              Register for {event.name}
            </Text>
            <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginBottom: 16, lineHeight: 18 }}>
              {fmtDate(event.date)}
            </Text>
            {/* Already-registered class badges */}
            {registeredClasses.size > 0 && (
              <View style={{ marginBottom: 14, padding: 10, borderRadius: 8, backgroundColor: "#16a34a18", borderWidth: 1, borderColor: "#16a34a40" }}>
                <Text style={{ fontSize: 11, fontWeight: "700", color: "#16a34a", fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                  Already registered
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {Array.from(registeredClasses).map(cls => (
                    <View key={cls} style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12, backgroundColor: "#16a34a22" }}>
                      <Text style={{ fontSize: 12, color: "#16a34a", fontFamily: "Inter_500Medium" }}>{cls}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {(profiles ?? []).length === 0 ? (
              <>
                <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", lineHeight: 20, marginBottom: 16 }}>
                  No rider profiles linked. Register for an event through the club website first to link your profile.
                </Text>
                <Pressable
                  style={[s.primaryBtn, { marginTop: 4 }]}
                  onPress={() => { setShowRegisterModal(false); openRegistration(event.id, account?.email); }}
                >
                  <Text style={s.btnText}>Register Online</Text>
                </Pressable>
              </>
            ) : (event.raceClasses ?? []).length > 0 && (event.raceClasses ?? []).every(cls => registeredClasses.has(cls)) ? (
              <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", lineHeight: 20 }}>
                You're already registered for all available classes at this event.
              </Text>
            ) : (
              <>
                <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginBottom: 10 }}>
                  {registeredClasses.size > 0
                    ? "Tap a profile to register for additional classes."
                    : "Tap a profile to open the registration form with your details pre-filled."}
                </Text>
                {(profiles ?? []).map(p => (
                  <Pressable
                    key={p.id}
                    onPress={() => { setShowRegisterModal(false); openRegistration(event.id, p.email ?? account?.email); }}
                    style={({ pressed }) => ({
                      marginBottom: 10,
                      padding: 12,
                      borderRadius: 10,
                      backgroundColor: pressed ? colors.primary + "18" : colors.background,
                      borderWidth: 1,
                      borderColor: pressed ? colors.primary : colors.border,
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                    })}
                  >
                    <View>
                      <Text style={{ fontSize: 15, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
                        {p.firstName} {p.lastName}
                      </Text>
                      {p.bibNumber && (
                        <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                          #{p.bibNumber}
                        </Text>
                      )}
                    </View>
                    <Text style={{ fontSize: 18, color: colors.primary }}>›</Text>
                  </Pressable>
                ))}
              </>
            )}
            <Pressable style={[s.mutedBtn, { marginTop: 4 }]} onPress={() => setShowRegisterModal(false)}>
              <Text style={[s.btnText, { color: colors.mutedForeground }]}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Change Class modal ── */}
      <Modal visible={showChangeClassModal} transparent animationType="slide" onRequestClose={() => setShowChangeClassModal(false)}>
        <Pressable style={s.modalOverlay} onPress={() => { if (!changeClassLoading) setShowChangeClassModal(false); }}>
          <Pressable style={s.modalBox} onPress={() => {}}>
            <Text style={{ fontSize: 18, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold", marginBottom: 4 }}>
              Change Class
            </Text>
            {changingReg && (
              <View style={{ marginBottom: 14 }}>
                <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                  Currently: <Text style={{ fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>{changingReg.raceClass}</Text>
                </Text>
                {myRegistrations.length > 1 && (
                  <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Inter_400Regular", marginTop: 2 }}>
                    Rider: {changingReg.riderName}
                  </Text>
                )}
              </View>
            )}
            {changeClassError != null && (
              <View style={{ marginBottom: 12, padding: 10, borderRadius: 8, backgroundColor: "#ef444418", borderWidth: 1, borderColor: "#ef444440" }}>
                <Text style={{ fontSize: 13, color: "#ef4444", fontFamily: "Inter_400Regular" }}>{changeClassError}</Text>
              </View>
            )}
            <Text style={{ fontSize: 12, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
              Select New Class
            </Text>
            {(event?.raceClasses ?? [])
              .filter(cls => cls !== changingReg?.raceClass)
              .map(cls => {
                const alreadyInClass = myRegistrations.some(r => r.id !== changingReg?.id && r.raceClass === cls);
                return (
                  <Pressable
                    key={cls}
                    disabled={changeClassLoading || alreadyInClass}
                    onPress={() => { if (changingReg && !alreadyInClass) void handleChangeClass(changingReg, cls); }}
                    style={({ pressed }) => ({
                      marginBottom: 8,
                      padding: 14,
                      borderRadius: 10,
                      backgroundColor: pressed ? colors.primary + "18" : colors.background,
                      borderWidth: 1,
                      borderColor: alreadyInClass ? colors.border : pressed ? colors.primary : colors.border,
                      opacity: alreadyInClass ? 0.5 : 1,
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                    })}
                  >
                    <Text style={{ fontSize: 15, fontWeight: "700", color: alreadyInClass ? colors.mutedForeground : colors.foreground, fontFamily: "Inter_700Bold" }}>
                      {cls}
                    </Text>
                    {alreadyInClass ? (
                      <Text style={{ fontSize: 11, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>Already registered</Text>
                    ) : changeClassLoading ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                      <Text style={{ fontSize: 16, color: colors.primary }}>›</Text>
                    )}
                  </Pressable>
                );
              })
            }
            {(event?.raceClasses ?? []).filter(cls => cls !== changingReg?.raceClass).length === 0 && (
              <Text style={{ fontSize: 14, color: colors.mutedForeground, fontFamily: "Inter_400Regular", textAlign: "center", marginBottom: 12 }}>
                No other classes available at this event.
              </Text>
            )}
            <Pressable
              style={[s.mutedBtn, { marginTop: 4 }]}
              disabled={changeClassLoading}
              onPress={() => setShowChangeClassModal(false)}
            >
              <Text style={[s.btnText, { color: colors.mutedForeground }]}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
