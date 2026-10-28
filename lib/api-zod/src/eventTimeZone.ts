// Each event runs on its track's local time: "race day", registration
// closing and race-morning pushes all follow the clock where the race is,
// wherever the server, organizer or rider happens to be.

const STATE_ZONES: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago",
  KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago",
  UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver", PR: "America/Puerto_Rico",
};

/** States split between two zones: the other zone applies on one side of a longitude (approximate county lines). */
const SPLIT_STATES: Record<string, { zone: string; when: (lat: number, lng: number) => boolean }> = {
  TX: { zone: "America/Denver", when: (_lat, lng) => lng < -104.9 },             // El Paso / Hudspeth
  FL: { zone: "America/Chicago", when: (_lat, lng) => lng < -85.0 },             // Panhandle west of the Apalachicola
  TN: { zone: "America/New_York", when: (_lat, lng) => lng > -85.3 },            // East Tennessee
  KY: { zone: "America/Chicago", when: (_lat, lng) => lng < -86.0 },             // Western Kentucky
  IN: { zone: "America/Chicago", when: (lat, lng) => lng < -87.0 && (lat > 41.0 || lat < 38.6) }, // NW and SW corners
  MI: { zone: "America/Menominee", when: (lat, lng) => lat > 45.0 && lng < -87.4 }, // western Upper Peninsula
  ND: { zone: "America/Denver", when: (lat, lng) => lng < -101.0 && lat < 47.5 },  // southwest
  SD: { zone: "America/Denver", when: (_lat, lng) => lng < -100.5 },             // West River
  NE: { zone: "America/Denver", when: (_lat, lng) => lng < -101.0 },             // Panhandle
  KS: { zone: "America/Denver", when: (_lat, lng) => lng < -101.5 },             // four western counties
  OR: { zone: "America/Boise", when: (lat, lng) => lng > -117.9 && lat < 44.5 },  // Malheur County
  ID: { zone: "America/Los_Angeles", when: (lat) => lat > 45.4 },                // Panhandle
};

/** Used when an event has no recognizable state (e.g. an unsaved draft). */
export const DEFAULT_EVENT_TIME_ZONE = "America/Denver";

export function eventTimeZone(event: { state?: string | null; trackLat?: number | null; trackLng?: number | null }): string {
  const state = (event.state ?? "").trim().toUpperCase();
  const zone = STATE_ZONES[state];
  if (!zone) return DEFAULT_EVENT_TIME_ZONE;
  const split = SPLIT_STATES[state];
  if (split && event.trackLat != null && event.trackLng != null && split.when(event.trackLat, event.trackLng)) {
    return split.zone;
  }
  return zone;
}

/** Today's date (YYYY-MM-DD) in the given time zone. */
export function todayInZone(timeZone: string, now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone });
}

/** Hour of day (0–23) in the given time zone. */
export function hourInZone(timeZone: string, now = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
}

/** Today's date at the event's track. */
export function eventToday(event: Parameters<typeof eventTimeZone>[0], now = new Date()): string {
  return todayInZone(eventTimeZone(event), now);
}
