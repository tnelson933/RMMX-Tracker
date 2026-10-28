import { Feather } from "@expo/vector-icons";
import * as Location from "expo-location";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ActivityIndicator, AppState, Linking, Pressable, Text, View } from "react-native";
import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";
import {
  QUICK_CHECKIN_RADIUS_MILES,
  arrivalAlertStatus,
  distanceMiles,
  enableArrivalAlerts,
  notifyArrival,
  requestAlwaysLocation,
  syncArrivalGeofences,
  syncArrivalWatch,
  type ArrivalAlertStatus,
  type GeofenceEvent,
} from "@/lib/quickCheckinGeofence";

// Race-day Quick Check-In on Home. Lists today's Quick Check-In registrations;
// within 1 mile of the track each eligible one gets a Check In button. Also
// keeps the phone's arrival geofences in sync and offers to turn them on.

type Row = {
  eventId: number;
  eventName: string;
  eventDate: string;
  trackName: string | null;
  trackLat: number | null;
  trackLng: number | null;
  riderName: string;
  registrationId: number;
  raceClass: string | null;
  eligible: boolean;
  checkedIn: boolean;
  ineligibleReason: string | null;
};

const REASONS: Record<string, string> = {
  missing_rfid: "RFID sticker not assigned. See the organizer at the gate.",
  missing_transponder: "No transponder number on file. See the organizer at the gate.",
  missing_waiver: "Waiver not signed. Sign it at the gate.",
  payment_required: "Payment not complete. Pay at the gate.",
};

const REFRESH_MS = 60_000;
const ALWAYS_DISMISSED_KEY = "quickCheckin.alwaysPromptDismissed";

// A fresh fix first: a cached one can be from miles back down the road. Fall
// back to a recent cached position if GPS doesn't answer in time.
async function currentPosition(): Promise<Location.LocationObject | null> {
  const fresh = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).catch(() => null),
    new Promise<null>(resolve => setTimeout(() => resolve(null), 10_000)),
  ]);
  return fresh ?? Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 }).catch(() => null);
}

export function QuickCheckinCard() {
  const colors = useColors();
  const { riderFetch, isAuthenticated } = useRiderAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [upcoming, setUpcoming] = useState<GeofenceEvent[]>([]);
  const [alertStatus, setAlertStatus] = useState<ArrivalAlertStatus>("unsupported");
  const [locationAllowed, setLocationAllowed] = useState<boolean | null>(null);
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [locationFailed, setLocationFailed] = useState(false);
  const [busy, setBusy] = useState<number | "all" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const announced = useRef(new Set<number>());
  const [alwaysDismissed, setAlwaysDismissed] = useState(true);
  useEffect(() => {
    AsyncStorage.getItem(ALWAYS_DISMISSED_KEY).then(v => setAlwaysDismissed(v === "1")).catch(() => setAlwaysDismissed(false));
  }, []);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const [todayRes, fenceRes] = await Promise.all([
        riderFetch("/api/rider/quick-checkin-events"),
        riderFetch("/api/rider/quick-checkin-geofences"),
      ]);
      const today: Row[] = todayRes.ok ? await todayRes.json() : [];
      const fences: { events: GeofenceEvent[] } = fenceRes.ok ? await fenceRes.json() : { events: [] };
      setRows(today);
      setUpcoming(fences.events);
      await syncArrivalGeofences(fences.events).catch(() => {});
      setAlertStatus(await arrivalAlertStatus());

      // Keep watching for arrival (works with "while using" while the app is
      // open or in the background) at tracks with a check-in still to do.
      const watch = new Map<number, GeofenceEvent>();
      for (const r of today) {
        if (r.trackLat == null || r.trackLng == null || !r.eligible || r.checkedIn) continue;
        watch.set(r.eventId, { eventId: r.eventId, eventName: r.eventName, eventDate: r.eventDate, trackName: r.trackName, trackLat: r.trackLat, trackLng: r.trackLng });
      }
      await syncArrivalWatch([...watch.values()]).catch(() => {});

      if (today.length > 0) {
        const perm = await Location.getForegroundPermissionsAsync();
        setLocationAllowed(perm.granted);
        if (perm.granted) {
          const loc = await currentPosition();
          if (loc) setPosition({ lat: loc.coords.latitude, lng: loc.coords.longitude });
          setLocationFailed(!loc);
        }
      }
    } catch { /* keep the last good state */ }
  }, [isAuthenticated, riderFetch]);

  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener("change", state => { if (state === "active") void refresh(); });
    return () => sub.remove();
  }, [refresh]);

  // Poll while there's something to check in for today.
  useEffect(() => {
    if (rows.length === 0) return;
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [rows.length, refresh]);

  const events = useMemo(() => {
    const byEvent = new Map<number, { info: Row; rows: Row[] }>();
    for (const r of rows) {
      const entry = byEvent.get(r.eventId) ?? { info: r, rows: [] };
      entry.rows.push(r);
      byEvent.set(r.eventId, entry);
    }
    return [...byEvent.values()].map(({ info, rows: eventRows }) => {
      const miles = position && info.trackLat != null && info.trackLng != null
        ? distanceMiles(position.lat, position.lng, info.trackLat, info.trackLng)
        : null;
      // No track location on file: the server doesn't check distance, so neither do we.
      const atTrack = info.trackLat == null || (miles != null && miles <= QUICK_CHECKIN_RADIUS_MILES);
      return { info, rows: eventRows, miles, atTrack };
    });
  }, [rows, position]);

  // Arriving while the app is open: phone notification too, once per event.
  useEffect(() => {
    for (const e of events) {
      if (e.atTrack && e.info.trackLat != null && !announced.current.has(e.info.eventId)
        && e.rows.some(r => r.eligible && !r.checkedIn)) {
        announced.current.add(e.info.eventId);
        void notifyArrival({ eventId: e.info.eventId, eventName: e.info.eventName, trackName: e.info.trackName }).catch(() => {});
      }
    }
  }, [events]);

  async function checkIn(targets: Row[], key: number | "all") {
    setBusy(key);
    setMessage(null);
    try {
      const loc = position ?? (await currentPosition().then(l => l && { lat: l.coords.latitude, lng: l.coords.longitude }));
      let failed: string | null = null;
      for (const r of targets) {
        const res = await riderFetch(`/api/events/${r.eventId}/quick-checkin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registrationId: r.registrationId, latitude: loc?.lat, longitude: loc?.lng }),
        });
        if (!res.ok) {
          failed = (await res.json().catch(() => ({}))).error ?? "Check-in failed. Please try again.";
          break;
        }
      }
      setMessage(failed ? { ok: false, text: failed } : { ok: true, text: targets.length > 1 ? "Everyone's checked in. See you on the gate!" : "You're checked in. See you on the gate!" });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function turnOnAlerts() {
    const status = await enableArrivalAlerts();
    setAlertStatus(status);
    const perm = await Location.getForegroundPermissionsAsync();
    setLocationAllowed(perm.granted);
    void refresh();
  }

  async function allowAlways() {
    let status = await requestAlwaysLocation();
    // Android 11+ and iOS often only offer "all the time" in Settings.
    if (status === "while-using") await Linking.openSettings();
    status = await arrivalAlertStatus();
    setAlertStatus(status);
    if (status === "always") await syncArrivalGeofences(upcoming).catch(() => {});
  }

  async function dismissAlways() {
    setAlwaysDismissed(true);
    await AsyncStorage.setItem(ALWAYS_DISMISSED_KEY, "1").catch(() => {});
  }

  const showAlertsPrompt = upcoming.length > 0 && (alertStatus === "off" || (alertStatus === "while-using" && !alwaysDismissed));
  if (events.length === 0 && !showAlertsPrompt) return null;

  const card = { marginHorizontal: 16, marginBottom: 16, borderRadius: 14, padding: 16, borderWidth: 1, gap: 10 } as const;
  const button = (primary: boolean) => ({
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, alignItems: "center" as const,
    backgroundColor: primary ? colors.primary : colors.secondary ?? colors.card,
  });

  return (
    <View>
      {events.map(({ info, rows: eventRows, miles, atTrack }) => {
        const pending = eventRows.filter(r => r.eligible && !r.checkedIn);
        const allDone = eventRows.every(r => r.checkedIn);
        return (
          <View key={info.eventId} style={[card, { backgroundColor: allDone ? colors.successTint : colors.card, borderColor: allDone ? colors.success : atTrack ? colors.primary : colors.border }]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Feather name={allDone ? "check-circle" : "map-pin"} size={18} color={allDone ? colors.success : colors.primary} />
              <Text style={{ flex: 1, fontSize: 15, fontWeight: "800", color: colors.foreground, fontFamily: "Inter_700Bold", textTransform: "uppercase", letterSpacing: 0.5 }}>
                {allDone ? "You're checked in" : atTrack ? "You're at the track" : "Quick Check-In today"}
              </Text>
            </View>
            <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
              {info.eventName}{info.trackName ? ` · ${info.trackName}` : ""}
            </Text>

            {!allDone && !atTrack && (
              locationAllowed === false ? (
                <Pressable onPress={turnOnAlerts} style={button(true)}>
                  <Text style={{ color: "#fff", fontWeight: "700", fontFamily: "Inter_700Bold" }}>Allow location to check in</Text>
                </Pressable>
              ) : (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 13, color: colors.foreground, fontFamily: "Inter_400Regular" }}>
                    {miles != null
                      ? `You're ${miles.toFixed(1)} miles away. Check In opens within ${QUICK_CHECKIN_RADIUS_MILES} mile of the track.`
                      : locationFailed
                        ? "We couldn't get your location. Make sure Location is on, then try again."
                        : "Finding your location…"}
                  </Text>
                  {miles == null && locationFailed && (
                    <Pressable onPress={() => void refresh()} style={button(false)}>
                      <Text style={{ color: "#fff", fontWeight: "700", fontFamily: "Inter_700Bold" }}>Try again</Text>
                    </Pressable>
                  )}
                </View>
              )
            )}

            {eventRows.map(r => (
              <View key={r.registrationId} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>{r.riderName}</Text>
                  <Text style={{ fontSize: 12, color: r.eligible ? colors.mutedForeground : colors.warning, fontFamily: "Inter_400Regular" }}>
                    {r.raceClass ?? ""}{!r.eligible && r.ineligibleReason ? ` · ${REASONS[r.ineligibleReason] ?? "See the organizer at the gate."}` : ""}
                  </Text>
                </View>
                {r.checkedIn ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                    <Feather name="check" size={16} color={colors.success} />
                    <Text style={{ color: colors.success, fontWeight: "700", fontFamily: "Inter_700Bold" }}>Checked in</Text>
                  </View>
                ) : r.eligible && atTrack ? (
                  <Pressable disabled={busy !== null} onPress={() => checkIn([r], r.registrationId)} style={button(true)}>
                    {busy === r.registrationId
                      ? <ActivityIndicator color="#fff" size="small" />
                      : <Text style={{ color: "#fff", fontWeight: "700", fontFamily: "Inter_700Bold" }}>Check In</Text>}
                  </Pressable>
                ) : null}
              </View>
            ))}

            {atTrack && pending.length > 1 && (
              <Pressable disabled={busy !== null} onPress={() => checkIn(pending, "all")} style={[button(true), { backgroundColor: colors.success }]}>
                {busy === "all"
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={{ color: "#fff", fontWeight: "700", fontFamily: "Inter_700Bold" }}>Check In for All ({pending.length})</Text>}
              </Pressable>
            )}

            {message && (
              <Text style={{ fontSize: 13, color: message.ok ? colors.success : colors.destructive, fontFamily: "Inter_600SemiBold" }}>{message.text}</Text>
            )}
          </View>
        );
      })}

      {showAlertsPrompt && (
        <View style={[card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Feather name="bell" size={18} color={colors.primary} />
            <Text style={{ flex: 1, fontSize: 14, fontWeight: "700", color: colors.foreground, fontFamily: "Inter_700Bold" }}>
              {alertStatus === "off" ? "Get a check-in alert when you arrive" : "Arrival alerts are on"}
            </Text>
          </View>
          {alertStatus === "off" ? (
            <>
              <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                {upcoming[0].eventName} has Quick Check-In. Allow notifications and location while using RM Roost and we'll alert you within {QUICK_CHECKIN_RADIUS_MILES} mile of {upcoming[0].trackName ?? "the track"} on race day, even with your phone locked, while the app is open in the background.
              </Text>
              <Pressable onPress={turnOnAlerts} style={button(true)}>
                <Text style={{ color: "#fff", fontWeight: "700", fontFamily: "Inter_700Bold" }}>Turn on arrival alerts</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={{ fontSize: 13, color: colors.mutedForeground, fontFamily: "Inter_400Regular" }}>
                Keep RM Roost open on race day (the background is fine, phone locked) and we'll alert you when you arrive. To get the alert even after closing the app, allow location all the time.
              </Text>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Pressable onPress={allowAlways} style={[button(true), { flex: 1 }]}>
                  <Text style={{ color: "#fff", fontWeight: "700", fontFamily: "Inter_700Bold" }}>Allow all the time</Text>
                </Pressable>
                <Pressable onPress={dismissAlways} style={[button(false), { flex: 1, backgroundColor: "transparent", borderWidth: 1, borderColor: colors.border }]}>
                  <Text style={{ color: colors.foreground, fontWeight: "700", fontFamily: "Inter_700Bold" }}>Not now</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      )}
    </View>
  );
}
