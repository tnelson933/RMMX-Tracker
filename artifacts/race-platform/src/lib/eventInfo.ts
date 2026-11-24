/**
 * Small pure helpers for the public event page before race day and the
 * registration page: map link, first race time, registration window.
 */

export interface EventPlace {
  trackName?: string | null;
  location?: string | null;
  state?: string | null;
  streetAddress?: string | null;
  zip?: string | null;
  trackLat?: number | null;
  trackLng?: number | null;
}

/** A Google Maps link to the track: its coordinates when known, else its address. Null with nothing to go on. */
export function mapLink(p: EventPlace): string | null {
  if (typeof p.trackLat === "number" && typeof p.trackLng === "number" && Number.isFinite(p.trackLat) && Number.isFinite(p.trackLng)) {
    return `https://www.google.com/maps/search/?api=1&query=${p.trackLat},${p.trackLng}`;
  }
  const parts = [p.trackName, p.streetAddress, p.location, [p.state, p.zip].filter(Boolean).join(" ")]
    .map(s => (s ?? "").trim())
    .filter(Boolean);
  if (parts.length === 0 || (parts.length === 1 && parts[0] === (p.state ?? "").trim())) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(", "))}`;
}

/** "Track Name · City, ST" style place line without repeating pieces. */
export function placeLine(p: EventPlace): string {
  const loc = (p.location ?? "").trim();
  const st = (p.state ?? "").trim();
  const town = loc && st && !loc.toLowerCase().endsWith(st.toLowerCase()) ? `${loc}, ${st}` : loc || st;
  return [p.trackName?.trim(), town].filter(Boolean).join(" · ");
}

/**
 * A moto's scheduled time for display: ISO timestamps become "8:30 AM" in the
 * viewer's time; anything else ("8:30 AM", "Gate drop 9") is shown as typed.
 */
export function displayTime(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  return v;
}

/** The earliest scheduled race (practice excluded) with a time set, as display text. */
export function firstRaceTime(motos: Array<{ type?: string | null; scheduledTime?: string | null; motoNumber?: number | null }>): string | null {
  const timed = motos
    .filter(m => m.type !== "practice" && (m.scheduledTime ?? "").trim())
    .sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));
  return timed.length ? displayTime(timed[0].scheduledTime) : null;
}

/** Registration is taking entries right now (same rule as the registration page). */
export function registrationIsOpen(
  e: { status: string; registrationOpen?: string | null; registrationClose?: string | null },
  now: Date = new Date(),
): boolean {
  if (e.status !== "registration_open") return false;
  if (e.registrationOpen && now < new Date(e.registrationOpen)) return false;
  if (e.registrationClose && now > new Date(e.registrationClose)) return false;
  return true;
}

/** "$45.00", "$45" for whole dollars. */
export function money(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}
