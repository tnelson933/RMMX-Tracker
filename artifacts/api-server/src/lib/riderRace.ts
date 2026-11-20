// A rider's races today, for live phone video:
//  - when they may go live (race day, within 2 races of racing), and when a
//    stream must stop (5 minutes after their race's results are finalized);
//  - the overlay: the class and race, their place, best and last laps.
//
// A race counts as the rider's when they are in it (its lineup, else the
// checked-in or registered riders of its classes: lib/raceStartAlerts.ts
// motoEntrantIds). "Today" is the event's own date at the track (its time zone),
// so a stream is only ever about today's racing. Practice sessions don't count.

import { db, eventsTable, motosTable, registrationsTable } from "@workspace/db";
import { eventToday } from "@workspace/api-zod";
import { and, eq, inArray, ne } from "drizzle-orm";
import { motoEntrantIds } from "./raceStartAlerts";

/** Go Live opens when no more than this many races run before the rider's. */
export const GO_LIVE_RACES_AHEAD = 2;
/** A stream stops this long after the rider's race results are finalized. */
export const LIVE_AFTER_FINALIZED_MS = 5 * 60_000;
/** If results are never finalized, it stops this long after the race finished. */
export const LIVE_AFTER_FINISH_MS = 30 * 60_000;
/** A finished race stays on screen this long, so viewers see the result. */
export const SHOW_FINISHED_MS = 15 * 60_000;

export interface RaceCandidate {
  id: number;
  eventId: number;
  status: string;
  motoNumber: number;
  completedAt: Date | null;
  resultsFinalizedAt?: Date | null;
}

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

export type GoLiveReason = "racing" | "up_soon" | "race_finished" | "too_early" | "race_ended" | "no_race_today";

export interface GoLiveWindow {
  allowed: boolean;
  reason: GoLiveReason;
  /** Races still to run before the rider's next one (when that's the deciding race). */
  racesAhead: number | null;
  /** While allowed only because a race just finished: when the stream must stop. */
  endsAt: Date | null;
}

const order = (a: RaceCandidate, b: RaceCandidate) => a.motoNumber - b.motoNumber || a.id - b.id;

/**
 * May the rider go live (or keep streaming) now? `allRaces` are today's races
 * at the rider's events (any rider), `mineIds` the ones the rider is in.
 *  - one of theirs is running → yes;
 *  - one of theirs is scheduled with at most 2 unfinished races before it → yes;
 *  - one of theirs finished → yes until 5 minutes after its results are
 *    finalized (or 30 minutes after it finished, if never finalized);
 *  - otherwise no.
 */
export function goLiveWindow(allRaces: RaceCandidate[], mineIds: Set<number>, now = Date.now()): GoLiveWindow {
  const mine = allRaces.filter(r => mineIds.has(r.id));
  if (!mine.length) return { allowed: false, reason: "no_race_today", racesAhead: null, endsAt: null };
  if (mine.some(r => r.status === "in_progress")) return { allowed: true, reason: "racing", racesAhead: 0, endsAt: null };

  let closestAhead: number | null = null;
  for (const r of mine.filter(m => m.status === "scheduled")) {
    const ahead = allRaces.filter(o => o.eventId === r.eventId && o.id !== r.id && order(o, r) < 0
      && (o.status === "scheduled" || o.status === "in_progress")).length;
    closestAhead = closestAhead == null ? ahead : Math.min(closestAhead, ahead);
  }
  if (closestAhead != null && closestAhead <= GO_LIVE_RACES_AHEAD) {
    return { allowed: true, reason: "up_soon", racesAhead: closestAhead, endsAt: null };
  }

  let endsAt: Date | null = null;
  for (const r of mine.filter(m => m.status === "completed")) {
    const end = r.resultsFinalizedAt
      ? new Date(r.resultsFinalizedAt.getTime() + LIVE_AFTER_FINALIZED_MS)
      : r.completedAt ? new Date(r.completedAt.getTime() + LIVE_AFTER_FINISH_MS) : null;
    if (end && end.getTime() > now && (!endsAt || end > endsAt)) endsAt = end;
  }
  if (endsAt) return { allowed: true, reason: "race_finished", racesAhead: closestAhead, endsAt };
  if (closestAhead != null) return { allowed: false, reason: "too_early", racesAhead: closestAhead, endsAt: null };
  return { allowed: false, reason: "race_ended", racesAhead: null, endsAt: null };
}

/** Plain words for why Go Live isn't open (shown in the app). */
export function goLiveMessage(w: GoLiveWindow): string {
  switch (w.reason) {
    case "too_early": return `Go Live opens when you're within ${GO_LIVE_RACES_AHEAD} races of racing. ${w.racesAhead} races to go before yours.`;
    case "race_ended": return "Your race has ended, so live video is closed. It opens again when you're within 2 races of your next race.";
    case "no_race_today": return "Go Live is open on race day, when you're within 2 races of racing.";
    default: return "";
  }
}

type MotoRow = typeof motosTable.$inferSelect;

/** Today's races at the events the rider is entered in, and which of them are theirs. */
async function racesToday(riderId: number, now: Date) {
  const events = await db.selectDistinct({
    id: eventsTable.id, name: eventsTable.name, date: eventsTable.date, endDate: eventsTable.endDate,
    state: eventsTable.state, trackLat: eventsTable.trackLat, trackLng: eventsTable.trackLng,
  }).from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .where(and(eq(registrationsTable.riderId, riderId), ne(registrationsTable.status, "void")));
  const today = events.filter(e => {
    const local = eventToday(e, now);
    return e.date <= local && local <= (e.endDate || e.date);
  });
  if (!today.length) return { events: today, races: [] as MotoRow[], mine: [] as MotoRow[] };
  const races = await db.select().from(motosTable)
    .where(and(inArray(motosTable.eventId, today.map(e => e.id)), ne(motosTable.type, "practice"), ne(motosTable.status, "cancelled")));
  const mine: MotoRow[] = [];
  for (const m of races) {
    if ((await motoEntrantIds(m)).includes(riderId)) mine.push(m);
  }
  return { events: today, races, mine };
}

export async function loadGoLiveWindow(riderId: number, now = new Date()): Promise<GoLiveWindow> {
  const { races, mine } = await racesToday(riderId, now);
  return goLiveWindow(races, new Set(mine.map(m => m.id)), now.getTime());
}

export interface RiderRaceInfo {
  eventName: string;
  className: string;
  raceName: string;
  status: "scheduled" | "in_progress" | "completed";
  /** Results for this race are final (the promoter finalized them). */
  finalized: boolean;
  /** Place in the race; null until timing has one. */
  position: number | null;
  riders: number;
  laps: number;
  gap: string | null;
  /** Lap times as shown on timing screens ("1:02.345"). */
  bestLap: string | null;
  /** The last two laps, newest first. */
  lastLaps: string[];
  /** When the live video stops because the race is over (ISO), else null. */
  liveEndsAt: string | null;
}

type Leaderboard = { leaderboard: Array<{ riderId: number | null; position: number | null; laps: number; gap?: string | null; dnf?: boolean; dns?: boolean; bestLap?: string | null; lapTimes?: string[] }> } | null;

export async function loadRiderRace(
  riderId: number,
  buildLeaderboard: (motoId: number) => Promise<Leaderboard>,
  now = new Date(),
): Promise<RiderRaceInfo | null> {
  const { events, races, mine } = await racesToday(riderId, now);
  const moto = pickRiderRace(mine, now.getTime());
  if (!moto) return null;
  const window = goLiveWindow(races, new Set(mine.map(m => m.id)), now.getTime());

  const classes = (moto.raceClasses?.length ? moto.raceClasses : [moto.raceClass]).filter(Boolean);
  const info: RiderRaceInfo = {
    eventName: events.find(e => e.id === moto.eventId)?.name ?? "",
    className: classes.join(" / "),
    raceName: moto.name,
    status: moto.status as RiderRaceInfo["status"],
    finalized: !!moto.resultsFinalizedAt,
    position: null,
    // The whole field (lineup, else entered riders of its classes), not just
    // riders timing has seen so far: early in a race only a few have crossed.
    riders: (await motoEntrantIds(moto)).length,
    laps: 0,
    gap: null,
    bestLap: null,
    lastLaps: [],
    liveEndsAt: window.reason === "race_finished" && window.endsAt ? window.endsAt.toISOString() : null,
  };
  if (moto.status === "scheduled") return info;

  const board = await buildLeaderboard(moto.id);
  const rows = board?.leaderboard ?? [];
  info.riders = Math.max(info.riders, rows.length);
  const me = rows.find(r => r.riderId === riderId);
  if (me && !me.dns) {
    info.position = me.dnf ? null : me.position ?? null;
    // Never "P5 of 3": the field is at least as big as the rider's place.
    if (info.position != null) info.riders = Math.max(info.riders, info.position);
    info.laps = me.laps ?? 0;
    // "Leader" only ever belongs to P1.
    info.gap = me.dnf ? "DNF" : me.gap === "Leader" && info.position !== 1 ? null : me.gap ?? null;
    info.bestLap = me.bestLap ?? null;
    info.lastLaps = (me.lapTimes ?? []).slice(-2).reverse();
  }
  return info;
}
