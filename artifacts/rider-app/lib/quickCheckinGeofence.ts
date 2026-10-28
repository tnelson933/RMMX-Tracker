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

export type ArrivalAlertStatus = "on" | "needs-always" | "off" | "unsupported";

export async function arrivalAlertStatus(): Promise<ArrivalAlertStatus> {
  if (!isNative) return "unsupported";
  const fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted) return "off";
  const bg = await Location.getBackgroundPermissionsAsync();
  return bg.granted ? "on" : "needs-always";
}

/** Asks for notifications, then location "while using" and "all the time". Returns the resulting status. */
export async function enableArrivalAlerts(): Promise<ArrivalAlertStatus> {
  if (!isNative) return "unsupported";
  await Notifications.requestPermissionsAsync().catch(() => null);
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return "off";
  const bg = await Location.requestBackgroundPermissionsAsync();
  return bg.granted ? "on" : "needs-always";
}

/** Registers (or clears) the phone's geofences for the given tracks. */
export async function syncArrivalGeofences(events: GeofenceEvent[]): Promise<void> {
  if (!isNative) return;
  const meta = Object.fromEntries(events.map(e => [`event-${e.eventId}`, e]));
  await AsyncStorage.setItem(META_KEY, JSON.stringify(meta));

  const running = await Location.hasStartedGeofencingAsync(TASK).catch(() => false);
  if ((await arrivalAlertStatus()) !== "on" || events.length === 0) {
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
