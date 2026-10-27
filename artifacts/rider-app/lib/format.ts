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
