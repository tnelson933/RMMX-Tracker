// Date and place helpers for the rider Home, copied from rider-app/lib/format.ts.

/** "City, ST" without repeating the state when the location already includes it. */
export function placeLabel(place: string | null | undefined, state: string | null | undefined): string {
  const p = (place ?? "").trim();
  const st = (state ?? "").trim();
  if (!st) return p;
  if (!p) return st;
  const before = p.charAt(p.length - st.length - 1);
  const endsWithState = p.toLowerCase().endsWith(st.toLowerCase()) && (p.length === st.length || before === "," || before === " ");
  return endsWithState ? p : `${p}, ${st}`;
}

/** An event date ("2026-09-04" or "...T00:00:00.000Z") is a calendar day: read it at local noon. */
export function displayDate(iso: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) || /T00:00:00(\.0+)?Z$/.test(iso)
    ? new Date(`${iso.slice(0, 10)}T12:00:00`)
    : new Date(iso);
}

/** Today's date (YYYY-MM-DD) on this computer's clock, not UTC. */
export function localDateString(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const shortDate = (iso: string) => displayDate(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
export const longDate = (iso: string) => displayDate(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function greeting(firstName: string): string {
  const h = new Date().getHours();
  const time = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  return `Good ${time}, ${firstName}!`;
}

export function fmtToday(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}
