/**
 * Pure helpers for the native live screen (app/live/[eventId].tsx) and the
 * shared leaderboard (components/LiveLeaderboard.tsx). No React, so they run
 * under node:test.
 */

/** A moto as GET /api/public/events/:id/schedule lists it (only the fields used here). */
export interface ScheduleMoto {
  motoId: number;
  motoNumber: number;
  name: string;
  raceClass: string | null;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** A leaderboard row's timing fields (GET /api/public/motos/:id/detail). */
export interface TimingRow {
  position: number | null;
  riderId: number | null;
  bibNumber: string | null;
  laps: number;
  totalMs?: number | null;
  bestLapMs?: number | null;
  dnf: boolean | null;
  dns: boolean | null;
}

const STATUS_ORDER: Record<string, number> = { scheduled: 0, in_progress: 1, completed: 2 };

/** Whichever status is further along (the schedule and the moto detail refresh at different rates). */
export function furthestStatus(a: string | null | undefined, b: string | null | undefined): string {
  const ra = STATUS_ORDER[a ?? ""] ?? -1;
  const rb = STATUS_ORDER[b ?? ""] ?? -1;
  return (rb > ra ? b : a) ?? b ?? "scheduled";
}

function sameLocalDay(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

/**
 * Today's motos, for a multi-day event: drops races finished on an earlier
 * day. When that would leave nothing (looking at a finished event later), all
 * of them.
 */
export function todaysMotos<T extends ScheduleMoto>(motos: T[], now = new Date()): T[] {
  const today = motos.filter(m => !m.completedAt || sameLocalDay(m.completedAt, now));
  return today.length > 0 ? today : motos;
}

/**
 * The moto the screen follows on its own: the one running, else the last one
 * finished (results just came in), else the next one up.
 */
export function followMoto<T extends ScheduleMoto>(motos: T[]): T | null {
  const running = motos.find(m => m.status === "in_progress");
  if (running) return running;
  const done = motos.filter(m => m.status === "completed");
  const lastDone = done.length
    ? done.reduce((a, b) => ((b.completedAt ?? "") >= (a.completedAt ?? "") ? b : a))
    : null;
  const next = motos.find(m => m.status === "scheduled") ?? null;
  // Before the first race, the first race; once racing has started, the latest result.
  return lastDone ?? next ?? motos[0] ?? null;
}

export type EventChip = { kind: "live" | "raceDay" | "finished" | "upcoming"; label: string };

/** LIVE only while a race is actually running; otherwise what the day is. */
export function eventChip(eventStatus: string | null | undefined, motos: ScheduleMoto[]): EventChip {
  if (motos.some(m => m.status === "in_progress")) return { kind: "live", label: "LIVE" };
  if (eventStatus === "completed") return { kind: "finished", label: "Finished" };
  if (eventStatus === "race_day") {
    return motos.length > 0 && motos.every(m => m.status === "completed")
      ? { kind: "finished", label: "Finished" }
      : { kind: "raceDay", label: "Race day" };
  }
  return { kind: "upcoming", label: "Upcoming" };
}

/** "0.512", "12.040", "1:02.345": a time difference, without the "s". */
export function fmtDelta(ms: number): string {
  const cs = Math.round(Math.max(0, ms));
  const mins = Math.floor(cs / 60_000);
  const secs = (cs % 60_000) / 1000;
  return mins > 0 ? `${mins}:${secs.toFixed(3).padStart(6, "0")}` : secs.toFixed(3);
}

const running = (r: TimingRow) => !r.dnf && !r.dns;

/**
 * Interval to the rider directly ahead: "+0.512", "+1 lap". Null for the
 * leader, DNF/DNS riders, and when there's nothing to compare yet.
 */
export function intervalAhead(rows: TimingRow[], index: number): string | null {
  const me = rows[index];
  if (!me || !running(me)) return null;
  let ahead: TimingRow | undefined;
  for (let i = index - 1; i >= 0; i--) if (running(rows[i])) { ahead = rows[i]; break; }
  if (!ahead) return null;
  if (me.laps > 0 && ahead.laps > me.laps) {
    const n = ahead.laps - me.laps;
    return `+${n} lap${n > 1 ? "s" : ""}`;
  }
  if (me.totalMs && ahead.totalMs && me.totalMs >= ahead.totalMs) return `+${fmtDelta(me.totalMs - ahead.totalMs)}`;
  return null;
}

/** The rider holding the race's fastest lap (null until someone has one). */
export function fastestLapRiderId(rows: TimingRow[]): number | null {
  let best: TimingRow | null = null;
  for (const r of rows) {
    if (r.riderId == null || !r.bestLapMs || r.bestLapMs <= 0 || r.dns) continue;
    if (!best || r.bestLapMs < (best.bestLapMs ?? Infinity)) best = r;
  }
  return best?.riderId ?? null;
}

/** Show the number-plate column only when at least one rider has a number. */
export function hasBikeNumbers(rows: Array<{ bibNumber: string | null }>): boolean {
  return rows.some(r => !!r.bibNumber && r.bibNumber.trim() !== "");
}
