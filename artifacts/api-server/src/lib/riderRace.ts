// Which race a rider is in right now, for the overlay on their live phone video:
// the class and race, and their place once live timing has one.
//
// A race counts as the rider's when they are in it (its lineup, else the
// checked-in or registered riders of its classes: lib/raceStartAlerts.ts
// motoEntrantIds). Only events dated yesterday to tomorrow are looked at, so a
// stream always shows today's racing. Practice sessions have no places and
// are skipped.

import { db, eventsTable, motosTable, registrationsTable } from "@workspace/db";
import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { motoEntrantIds } from "./raceStartAlerts";

export interface RaceCandidate {
  id: number;
  status: string;
  motoNumber: number;
  completedAt: Date | null;
}

/** A finished race stays on screen this long, so viewers see the result. */
export const SHOW_FINISHED_MS = 15 * 60_000;

/**
 * The race to show: one running now; else one that finished in the last 15
 * minutes; else the next one scheduled; else the last one finished.
 */
export function pickRiderRace<T extends RaceCandidate>(motos: T[], now = Date.now()): T | null {
  const running = motos.filter(m => m.status === "in_progress").sort((a, b) => a.motoNumber - b.motoNumber);
  if (running.length) return running[0];
  const done = motos.filter(m => m.status === "completed" && m.completedAt)
    .sort((a, b) => b.completedAt!.getTime() - a.completedAt!.getTime());
  if (done[0] && now - done[0].completedAt!.getTime() <= SHOW_FINISHED_MS) return done[0];
  const next = motos.filter(m => m.status === "scheduled").sort((a, b) => a.motoNumber - b.motoNumber || a.id - b.id);
  return next[0] ?? done[0] ?? null;
}

export interface RiderRaceInfo {
  eventName: string;
  className: string;
  raceName: string;
  status: "scheduled" | "in_progress" | "completed";
  /** Place in the race; null until timing has one. */
  position: number | null;
  riders: number;
  laps: number;
  gap: string | null;
  /** Lap times as shown on timing screens ("1:02.345"). */
  bestLap: string | null;
  /** The last two laps, newest first. */
  lastLaps: string[];
}

type Leaderboard = { leaderboard: Array<{ riderId: number | null; position: number | null; laps: number; gap?: string | null; dnf?: boolean; dns?: boolean; bestLap?: string | null; lapTimes?: string[] }> } | null;

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function loadRiderRace(
  riderId: number,
  buildLeaderboard: (motoId: number) => Promise<Leaderboard>,
  now = new Date(),
): Promise<RiderRaceInfo | null> {
  const from = ymd(new Date(now.getTime() - 36 * 3600_000));
  const to = ymd(new Date(now.getTime() + 36 * 3600_000));
  const events = await db.selectDistinct({ id: eventsTable.id, name: eventsTable.name })
    .from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .where(and(eq(registrationsTable.riderId, riderId), ne(registrationsTable.status, "void"),
      gte(eventsTable.date, from), lte(eventsTable.date, to)));
  if (!events.length) return null;

  const motos = await db.select().from(motosTable)
    .where(and(inArray(motosTable.eventId, events.map(e => e.id)), ne(motosTable.type, "practice"), ne(motosTable.status, "cancelled")));
  const mine: typeof motos = [];
  for (const m of motos) {
    if ((await motoEntrantIds(m)).includes(riderId)) mine.push(m);
  }
  const moto = pickRiderRace(mine, now.getTime());
  if (!moto) return null;

  const classes = (moto.raceClasses?.length ? moto.raceClasses : [moto.raceClass]).filter(Boolean);
  const info: RiderRaceInfo = {
    eventName: events.find(e => e.id === moto.eventId)?.name ?? "",
    className: classes.join(" / "),
    raceName: moto.name,
    status: moto.status as RiderRaceInfo["status"],
    position: null,
    riders: Array.isArray(moto.lineup) && moto.lineup.length ? moto.lineup.length : 0,
    laps: 0,
    gap: null,
    bestLap: null,
    lastLaps: [],
  };
  if (moto.status === "scheduled") return info;

  const board = await buildLeaderboard(moto.id);
  const rows = board?.leaderboard ?? [];
  if (rows.length) info.riders = rows.length;
  const me = rows.find(r => r.riderId === riderId);
  if (me && !me.dns) {
    info.position = me.dnf ? null : me.position ?? null;
    info.laps = me.laps ?? 0;
    info.gap = me.dnf ? "DNF" : me.gap ?? null;
    info.bestLap = me.bestLap ?? null;
    info.lastLaps = (me.lapTimes ?? []).slice(-2).reverse();
  }
  return info;
}
