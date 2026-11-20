/**
 * What a signed-in rider's registration form starts with, for one of the rider
 * profiles their account owns or manages: the saved profile first, then the
 * rider's most recent entries for anything the profile has no value for (club
 * ID, stats opt-in, older entries' AMA number, bike, plate), and the classes
 * they usually race when this event offers them.
 *
 * Never: payment details (cards stay with Stripe), waiver acceptance (signed
 * per event), or a rental transponder's number (it went back to the club).
 *
 * Pure: the route loads the rows; tested in registrationPrefill.test.ts.
 */
import { ageOn } from "./riderResume";

export interface PrefillRider {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  emergencyContact: string | null;
  emergencyPhone: string | null;
  streetAddress: string | null;
  city: string | null;
  homeState: string | null;
  zip: string | null;
  bibNumber: string | null;
  amaNumber: string | null;
  bikeManufacturer: string | null;
  bikeModel: string | null;
  bikeYear: string | null;
  sponsors: string | null;
  mylapsTransponderId: string | null;
  rfidNumber: string | null;
  avatarUrl?: string | null;
  /** Every RM TrackR the rider owns (rider_transponders, oldest first), lower-case. */
  trackrNumbers?: string[];
}

export interface PrefillEntry {
  eventId: number;
  raceClass: string;
  status: string;
  paymentStatus: string;
  createdAt: Date | string;
  id: number;
  bibNumber: string | null;
  amaNumber: string | null;
  clubIdNumber: string | null;
  bikeBrand: string | null;
  bikeModel: string | null;
  bikeYear: string | null;
  sponsors: string | null;
  statsEmailOptIn: boolean;
  transponderRental: boolean;
  myLapsTransponderNumber: string | null;
  rmTrackrTransponder: string | null;
}

export interface PrefillTeamGear {
  rfidNumber: string | null;
  trackrNumber: string | null;
  trackrChoice: string | null;
}

export interface RegistrationPrefill {
  riderId: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  emergencyContact: string;
  emergencyPhone: string;
  streetAddress: string;
  city: string;
  homeState: string;
  zip: string;
  bibNumber: string;
  amaNumber: string;
  clubIdNumber: string;
  bikeBrand: string;
  bikeModel: string;
  bikeYear: string;
  sponsors: string;
  /** The rider's own RM TrackR (never a rental), as stored (lower-case). */
  transponderNumber: string;
  /** All the rider's own RM TrackRs to choose from (they may own one per bike), lower-case; includes transponderNumber. */
  transponderOptions: string[];
  rfidNumber: string;
  statsEmailOptIn: boolean;
  isMinor: boolean;
  avatarUrl: string | null;
  /** Classes this event offers that the rider raced last time (or most often), not already entered here. */
  usualClasses: string[];
  /** Classes already held at this event (paid or confirmed). */
  registeredClasses: string[];
  /** True when the rider has entered any race before (the form can start on Review). */
  hasRaced: boolean;
}

const s = (v: string | null | undefined) => (v ?? "").trim();
const first = (...vals: Array<string | null | undefined>) => vals.map(s).find(Boolean) ?? "";
const key = (c: string) => c.trim().toLowerCase();
const time = (d: Date | string) => new Date(d).getTime() || 0;

export function buildRegistrationPrefill(
  rider: PrefillRider,
  entries: PrefillEntry[],
  teamGear: PrefillTeamGear[],
  event: { id: number; raceClasses: string[] | null },
  todayYmd: string,
): RegistrationPrefill {
  const live = entries
    .filter(e => e.status !== "void")
    .sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id - a.id);
  const latest = <K extends keyof PrefillEntry>(k: K) => live.map(e => e[k]).find(v => typeof v === "string" && v.trim()) as string | undefined;

  // The rider's own RM TrackR: on the profile, a bought one, or one they entered
  // themselves (a rented one is assigned by the club and goes back).
  const ownTx = first(
    rider.mylapsTransponderId,
    live.map(e => e.rmTrackrTransponder).find(v => s(v)),
    live.filter(e => !e.transponderRental).map(e => e.myLapsTransponderNumber).find(v => s(v)),
    teamGear.filter(t => t.trackrChoice !== "rent").map(t => t.trackrNumber).find(v => s(v)),
  ).toLowerCase();

  const offered = event.raceClasses ?? [];
  const offeredByKey = new Map(offered.map(c => [key(c), c]));
  const registeredClasses = [...new Set(live
    .filter(e => e.eventId === event.id && (e.paymentStatus === "paid" || e.status === "confirmed"))
    .map(e => e.raceClass))];
  const held = new Set(registeredClasses.map(key));

  // Last event's classes that this event offers; failing that, the most-raced one it offers.
  const otherEvents = live.filter(e => e.eventId !== event.id);
  let usualClasses: string[] = [];
  if (otherEvents.length) {
    const lastEventId = otherEvents[0].eventId;
    usualClasses = [...new Set(otherEvents.filter(e => e.eventId === lastEventId)
      .map(e => offeredByKey.get(key(e.raceClass)))
      .filter((c): c is string => !!c && !held.has(key(c))))];
    if (!usualClasses.length) {
      const counts = new Map<string, number>();
      for (const e of otherEvents) {
        const c = offeredByKey.get(key(e.raceClass));
        if (c && !held.has(key(c))) counts.set(c, (counts.get(c) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top) usualClasses = [top[0]];
    }
  }

  const age = ageOn(rider.dateOfBirth, todayYmd);
  return {
    riderId: rider.id,
    firstName: s(rider.firstName),
    lastName: s(rider.lastName),
    email: s(rider.email),
    phone: s(rider.phone),
    dateOfBirth: s(rider.dateOfBirth),
    emergencyContact: s(rider.emergencyContact),
    emergencyPhone: s(rider.emergencyPhone),
    streetAddress: s(rider.streetAddress),
    city: s(rider.city),
    homeState: s(rider.homeState),
    zip: s(rider.zip),
    bibNumber: first(rider.bibNumber, latest("bibNumber")),
    amaNumber: first(rider.amaNumber, latest("amaNumber")),
    clubIdNumber: first(latest("clubIdNumber")),
    bikeBrand: first(rider.bikeManufacturer, latest("bikeBrand")),
    bikeModel: first(rider.bikeModel, latest("bikeModel")),
    bikeYear: first(rider.bikeYear, latest("bikeYear")),
    sponsors: first(rider.sponsors, latest("sponsors")),
    transponderNumber: ownTx,
    transponderOptions: [...new Set([ownTx, ...(rider.trackrNumbers ?? []).map(n => s(n).toLowerCase())].filter(Boolean))],
    rfidNumber: first(rider.rfidNumber, teamGear.map(t => t.rfidNumber).find(v => s(v))),
    statsEmailOptIn: live[0]?.statsEmailOptIn ?? false,
    isMinor: age != null && age < 18,
    avatarUrl: rider.avatarUrl ?? null,
    usualClasses,
    registeredClasses,
    hasRaced: live.length > 0,
  };
}
