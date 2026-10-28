import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";

// Quick Check-In arrival alert. The phone watches a 1-mile circle around each
// track the rider is registered at (Quick Check-In events in the next week).
// On entering it on race day, the OS wakes this task, even with RM Roost
// closed, and it posts a "You're at the track, tap to check in" notification.

export const QUICK_CHECKIN_RADIUS_MILES = 1;
const RADIUS_METERS = 1609;
const TASK = "rm-quick-checkin-arrival";
const META_KEY = "quickCheckin.geofenceMeta";
const NOTIFIED_KEY = "quickCheckin.arrivalNotified";
const ANDROID_CHANNEL = "quick-checkin";

export type GeofenceEvent = {
  eventId: number;
  eventName: string;
  eventDate: string; // YYYY-MM-DD
  trackName: string | null;
  trackLat: number;
  trackLng: number;
};

const isNative = Platform.OS === "ios" || Platform.OS === "android";

export function todayInMountainTime(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
}

export function distanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Shows the arrival notification once per event. */
export async function notifyArrival(event: Pick<GeofenceEvent, "eventId" | "eventName" | "trackName">): Promise<void> {
  const notified: number[] = JSON.parse((await AsyncStorage.getItem(NOTIFIED_KEY)) ?? "[]");
  if (notified.includes(event.eventId)) return;
  // Only count it as sent when the phone can actually show it.
  if (!(await Notifications.getPermissionsAsync()).granted) return;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL, {
      name: "Quick Check-In",
      description: "Alerts when you arrive at the track on race day",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `🏁 You're at ${event.trackName ?? "the track"}`,
      body: `Tap to check in for ${event.eventName.trim()} and skip the line.`,
      data: { type: "quick_checkin_arrival", eventId: event.eventId },
    },
    // Immediate; on Android it goes to the high-importance Quick Check-In channel.
    trigger: Platform.OS === "android" ? { channelId: ANDROID_CHANNEL } : null,
  });
  await AsyncStorage.setItem(NOTIFIED_KEY, JSON.stringify([...notified, event.eventId].slice(-50)));
}

// Must be defined at module load (imported from the root layout) so the OS can
// run it while the app is in the background or closed.
if (isNative) {
  TaskManager.defineTask(TASK, async ({ data, error }) => {
    if (error || !data) return;
    const { eventType, region } = data as { eventType: Location.GeofencingEventType; region: Location.LocationRegion };
    if (eventType !== Location.GeofencingEventType.Enter || !region.identifier) return;
    const meta: Record<string, GeofenceEvent> = JSON.parse((await AsyncStorage.getItem(META_KEY)) ?? "{}");
    const event = meta[region.identifier];
    // Geofences are set up to a week ahead; only alert on race day.
    if (!event || event.eventDate !== todayInMountainTime()) return;
    await notifyArrival(event);
  });
}

/**
 * "always": alerts even when the app is closed (geofence).
 * "while-using": alerts while the app is open or in the background (race-day watch).
 * "off": notifications or location not allowed.
 */
export type ArrivalAlertStatus = "always" | "while-using" | "off" | "unsupported";

export async function arrivalAlertStatus(): Promise<ArrivalAlertStatus> {
  if (!isNative) return "unsupported";
  const [notif, fg] = await Promise.all([Notifications.getPermissionsAsync(), Location.getForegroundPermissionsAsync()]);
  if (!notif.granted || !fg.granted) return "off";
  const bg = await Location.getBackgroundPermissionsAsync();
  return bg.granted ? "always" : "while-using";
}

/** Asks for notifications and location while using the app. */
export async function enableArrivalAlerts(): Promise<ArrivalAlertStatus> {
  if (!isNative) return "unsupported";
  await Notifications.requestPermissionsAsync().catch(() => null);
  await Location.requestForegroundPermissionsAsync().catch(() => null);
  return arrivalAlertStatus();
}

/** Optional upgrade to "all the time" so the alert also works with the app closed. */
export async function requestAlwaysLocation(): Promise<ArrivalAlertStatus> {
  if (!isNative) return "unsupported";
  await Location.requestBackgroundPermissionsAsync().catch(() => null);
  return arrivalAlertStatus();
}

/** Registers (or clears) the phone's geofences for the given tracks. */
export async function syncArrivalGeofences(events: GeofenceEvent[]): Promise<void> {
  if (!isNative) return;
  const meta = Object.fromEntries(events.map(e => [`event-${e.eventId}`, e]));
  await AsyncStorage.setItem(META_KEY, JSON.stringify(meta));

  const running = await Location.hasStartedGeofencingAsync(TASK).catch(() => false);
  if ((await arrivalAlertStatus()) !== "always" || events.length === 0) {
    if (running) await Location.stopGeofencingAsync(TASK).catch(() => {});
    return;
  }
  await Location.startGeofencingAsync(
    TASK,
    events.map(e => ({
      identifier: `event-${e.eventId}`,
      latitude: e.trackLat,
      longitude: e.trackLng,
      radius: RADIUS_METERS,
      notifyOnEnter: true,
      notifyOnExit: false,
    })),
  );
}

// ── Race-day arrival watch ("while using" permission) ─────────────────────────
// Most riders allow location only while using the app. Started while the app is
// open on race day, location updates keep running with the phone locked and the
// app in the background (Android: a foreground-service notification; iOS: the
// blue location indicator), so the arrival alert still fires at 1 mile. It stops
// once the rider has arrived or checked in. A force-closed app can't be woken
// without "Always"; the geofence above covers that.

const WATCH_TASK = "rm-quick-checkin-arrival-watch";
const WATCH_KEY = "quickCheckin.watchEvents";
const RADIUS_MILES_TOLERANCE = QUICK_CHECKIN_RADIUS_MILES;

async function watchedEvents(): Promise<GeofenceEvent[]> {
  const list: GeofenceEvent[] = JSON.parse((await AsyncStorage.getItem(WATCH_KEY)) ?? "[]");
  const today = todayInMountainTime();
  return list.filter(e => e.eventDate === today);
}

if (isNative) {
  TaskManager.defineTask(WATCH_TASK, async ({ data, error }) => {
    if (error || !data) return;
    const { locations } = data as { locations: Location.LocationObject[] };
    const latest = locations?.[locations.length - 1];
    if (!latest) return;
    const events = await watchedEvents();
    const remaining: GeofenceEvent[] = [];
    for (const e of events) {
      const miles = distanceMiles(latest.coords.latitude, latest.coords.longitude, e.trackLat, e.trackLng);
      if (miles <= RADIUS_MILES_TOLERANCE) await notifyArrival(e);
      else remaining.push(e);
    }
    await AsyncStorage.setItem(WATCH_KEY, JSON.stringify(remaining));
    if (remaining.length === 0) await Location.stopLocationUpdatesAsync(WATCH_TASK).catch(() => {});
  });
}

/**
 * Watches for arrival at today's Quick Check-In tracks while the app is open or
 * in the background. Pass the tracks the rider still needs to check in at;
 * an empty list stops the watch. Must be called while the app is in the
 * foreground (both platforms only allow starting it then).
 */
export async function syncArrivalWatch(events: GeofenceEvent[]): Promise<void> {
  if (!isNative) return;
  const today = todayInMountainTime();
  const todays = events.filter(e => e.eventDate === today);
  await AsyncStorage.setItem(WATCH_KEY, JSON.stringify(todays));

  const running = await Location.hasStartedLocationUpdatesAsync(WATCH_TASK).catch(() => false);
  const fg = await Location.getForegroundPermissionsAsync();
  if (todays.length === 0 || !fg.granted) {
    if (running) await Location.stopLocationUpdatesAsync(WATCH_TASK).catch(() => {});
    return;
  }
  if (running) return;
  const track = todays[0].trackName ?? "the track";
  await Location.startLocationUpdatesAsync(WATCH_TASK, {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 200, // meters between updates: enough to catch a 1-mile circle, light on battery
    timeInterval: 30_000,
    activityType: Location.ActivityType.AutomotiveNavigation,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "Watching for your arrival",
      notificationBody: `We'll tell you when you reach ${track} so you can check in.`,
      notificationColor: "#B30000",
    },
  });
}
