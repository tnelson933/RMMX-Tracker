/** "City, ST" without repeating the state when the location already includes it ("Denver, CO" + "CO"). */
export function placeLabel(place: string | null | undefined, state: string | null | undefined): string {
  const p = (place ?? "").trim();
  const st = (state ?? "").trim();
  if (!st) return p;
  if (!p) return st;
  const before = p.charAt(p.length - st.length - 1);
  const endsWithState = p.toLowerCase().endsWith(st.toLowerCase()) && (p.length === st.length || before === "," || before === " ");
  return endsWithState ? p : `${p}, ${st}`;
}

/**
 * Parse an event date ("2026-09-04" or "2026-09-04T00:00:00.000Z") as that calendar
 * day at local noon. Event dates are calendar days, so reading the ISO value as UTC
 * midnight would show the previous day in US time zones.
 */
export function eventDay(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T12:00:00`);
}

/**
 * Date for display: a date-only value or a midnight-UTC value (how event dates are
 * stored) is a calendar day; anything else is a real moment in time.
 */
export function displayDate(iso: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) || /T00:00:00(\.0+)?Z$/.test(iso) ? eventDay(iso) : new Date(iso);
}

/** Today's date (YYYY-MM-DD) on this phone's clock, not UTC (which rolls over in the US evening). */
export function localDateString(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
