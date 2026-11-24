/**
 * Race-day mode on Home (components/RaceDayCard.tsx): from the rider's own
 * schedule (GET /api/rider/profiles/:id/schedule), what to show while their
 * event is racing. Pure, so it runs under node:test.
 */

/** A moto as the rider schedule lists it (only the fields used here). */
export interface RaceDayMoto {
  motoId: number;
  motoNumber: number;
  name: string;
  type?: string | null;
  raceClass: string | null;
  status: string;
  completedAt?: string | null;
  isAnyFamilyMemberInMoto: boolean;
  familyGates: Array<{ gate: number; riderId: number; riderName: string }>;
}

export interface RaceDayState {
  /** One of the account's riders is on the track now. */
  racing: RaceDayMoto | null;
  /** Their next race still to run. */
  next: RaceDayMoto | null;
  /** Races to run before `next` (the one running now counts). */
  racesAhead: number | null;
  /** The race running now, whoever is in it. */
  onTrack: RaceDayMoto | null;
  /** The account's races finished today / in total. */
  done: number;
  total: number;
  /** Their last finished race (for "results are in"). */
  lastDone: RaceDayMoto | null;
}

const isRace = (m: RaceDayMoto) => m.type !== "practice";

export function raceDayState(motos: RaceDayMoto[]): RaceDayState {
  const races = motos.filter(isRace).sort((a, b) => a.motoNumber - b.motoNumber);
  const mine = races.filter(m => m.isAnyFamilyMemberInMoto);
  const racing = mine.find(m => m.status === "in_progress") ?? null;
  const next = mine.find(m => m.status === "scheduled") ?? null;
  const onTrack = races.find(m => m.status === "in_progress") ?? null;
  const racesAhead = next
    ? races.filter(m => m.motoNumber < next.motoNumber && (m.status === "scheduled" || m.status === "in_progress")).length
    : null;
  const finished = mine.filter(m => m.status === "completed");
  const lastDone = finished.length
    ? finished.reduce((a, b) => ((b.completedAt ?? "") >= (a.completedAt ?? "") ? b : a))
    : null;
  return { racing, next, racesAhead, onTrack, done: finished.length, total: mine.length, lastDone };
}

/** "Gate 4", or "Gate 4 · Gate 7 (Sam)" when two of the account's riders are in it. */
export function gateLabel(moto: RaceDayMoto, multiRider: boolean): string | null {
  if (moto.familyGates.length === 0) return null;
  if (moto.familyGates.length === 1 && !multiRider) return `Gate ${moto.familyGates[0].gate}`;
  return moto.familyGates.map(g => `Gate ${g.gate} (${g.riderName.split(" ")[0]})`).join("  ·  ");
}

/** "You're up next", "1 race before yours", "3 races before yours". */
export function aheadLabel(racesAhead: number | null): string | null {
  if (racesAhead == null) return null;
  if (racesAhead === 0) return "You're up next";
  return `${racesAhead} race${racesAhead === 1 ? "" : "s"} before yours`;
}
