import { db, teamMembersTable, registrationsTable, rfidAssignmentsTable, ridersTable, lapCrossingsTable } from "@workspace/db";
import { and, asc, eq, ilike, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { MIN_RIDERS_PER_GROUP } from "./groupRaceSettings";
import { normalizeActiveTransponderIdentifier } from "./riderTimingIdentity";

export { normalizeRidersPerGroup, groupRaceSettingsError, MIN_RIDERS_PER_GROUP, MAX_RIDERS_PER_GROUP } from "./groupRaceSettings";

/**
 * Group races: each registration is a team. Its rider is the captain (member 1);
 * the other members are in team_members with their names and emails. Every
 * member can carry an RFID tag and/or an RM TrackR, and a read of any of them
 * counts as a lap for the team (the captain's rider id, which timing keys on).
 */

export interface TeamMemberInput { firstName: string; lastName: string; email: string }
export interface TeamInput { teamName: string; members: TeamMemberInput[] }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v: unknown, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * The team sent with a group race registration: a team name and every member
 * other than the captain (ridersPerGroup - 1 of them), each with a name and email.
 */
export function parseTeamInput(body: Record<string, unknown>, ridersPerGroup: number | null): TeamInput | { error: string } {
  const size = ridersPerGroup ?? MIN_RIDERS_PER_GROUP;
  const teamName = clean(body.teamName, 80);
  if (!teamName) return { error: "Enter a team name." };
  const raw = Array.isArray(body.teamMembers) ? body.teamMembers : [];
  const members: TeamMemberInput[] = raw.map((m: any) => ({
    firstName: clean(m?.firstName), lastName: clean(m?.lastName), email: clean(m?.email, 254).toLowerCase(),
  }));
  if (members.length !== size - 1) {
    return { error: `This is a group race with ${size} riders per team. Enter the other ${size - 1} team member${size - 1 === 1 ? "" : "s"}.` };
  }
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const label = `Team member ${i + 2}`;
    if (!m.firstName || !m.lastName) return { error: `${label} needs a first and last name.` };
    if (!EMAIL_RE.test(m.email)) return { error: `${label} needs a valid email address.` };
  }
  return { teamName, members };
}

/** What one rider brings or gets for timing, chosen at registration. */
export interface TeamGear {
  rfidNumber: string | null;
  trackrNumber: string | null;
  /** "own" (number entered), "rent", "buy", or null (nothing yet). */
  trackrChoice: "own" | "rent" | "buy" | null;
  buyRfid: boolean;
}
const NO_GEAR: TeamGear = { rfidNumber: null, trackrNumber: null, trackrChoice: null, buyRfid: false };

/**
 * Each rider's timing choices sent with a group race registration (index 0 is
 * the captain). Missing entries mean nothing chosen. Rentals and purchases only
 * count when the event offers them; RM TrackR numbers must be valid IDs.
 */
export function parseTeamGear(
  raw: unknown,
  size: number,
  names: string[],
  offers: { rental: boolean; trackr: boolean; rfidTag: boolean },
): TeamGear[] | { error: string } {
  const list = Array.isArray(raw) ? raw : [];
  const out: TeamGear[] = [];
  for (let i = 0; i < size; i++) {
    const g: any = list[i] ?? {};
    const name = names[i] ?? `Rider ${i + 1}`;
    const rfidNumber = clean(g.rfidNumber, 64) || null;
    const typed = clean(g.trackrNumber, 64);
    const trackrNumber = typed ? normalizeActiveTransponderIdentifier(typed) : null;
    if (typed && !trackrNumber) return { error: `${name}'s RM TrackR number isn't valid. Enter the ID printed on it (up to 9 numbers or letters A–F).` };
    let trackrChoice: TeamGear["trackrChoice"] = trackrNumber ? "own" : null;
    if (!trackrNumber && g.trackrChoice === "rent") {
      if (!offers.rental) return { error: "This event doesn't rent transponders. Enter a number or choose another option." };
      trackrChoice = "rent";
    }
    if (!trackrNumber && g.trackrChoice === "buy") {
      if (!offers.trackr) return { error: "This event doesn't sell the RM TrackR. Enter a number or choose another option." };
      trackrChoice = "buy";
    }
    const buyRfid = !rfidNumber && g.buyRfid === true;
    if (buyRfid && !offers.rfidTag) return { error: "This event doesn't sell RFID tags." };
    out.push({ rfidNumber, trackrNumber, trackrChoice, buyRfid });
  }
  // Within the team, every number belongs to one rider.
  const seen = new Map<string, string>();
  for (let i = 0; i < out.length; i++) {
    for (const tag of [out[i].rfidNumber, out[i].trackrNumber]) {
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key) && seen.get(key) !== names[i]) return { error: `Number ${tag} is entered for both ${seen.get(key)} and ${names[i]}. Each rider needs their own.` };
      seen.set(key, names[i]);
    }
  }
  return out;
}

/** How many rentals, RM TrackR purchases and RFID tags a team's choices add up to. */
export function teamGearCounts(gear: TeamGear[]): { rentals: number; trackrs: number; rfidTags: number } {
  return {
    rentals: gear.filter(g => g.trackrChoice === "rent").length,
    trackrs: gear.filter(g => g.trackrChoice === "buy").length,
    rfidTags: gear.filter(g => g.buyRfid).length,
  };
}

/**
 * The rider profile for a team member: one already on that email with the same
 * name, otherwise a new profile on that email (families share an email), so the
 * member's rider app and history show the team's races.
 */
export async function teamMemberRiderId(m: TeamMemberInput): Promise<number> {
  const [match] = await db.select({ id: ridersTable.id }).from(ridersTable).where(and(
    sql`lower(${ridersTable.email}) = ${m.email.toLowerCase()}`,
    sql`lower(trim(${ridersTable.firstName})) = ${m.firstName.toLowerCase()}`,
    sql`lower(trim(${ridersTable.lastName})) = ${m.lastName.toLowerCase()}`,
  )).orderBy(asc(ridersTable.id)).limit(1);
  if (match) return match.id;
  const [created] = await db.insert(ridersTable).values({ firstName: m.firstName, lastName: m.lastName, email: m.email }).returning({ id: ridersTable.id });
  return created.id;
}

/** Save a new team's roster: the captain as member 1, then the others in order, each linked to a rider profile. */
export async function saveTeamRoster(
  eventId: number,
  registrationId: number,
  captain: { riderId: number; firstName: string; lastName: string; email: string | null },
  members: TeamMemberInput[],
  gear: TeamGear[] = [],
): Promise<void> {
  const g = (i: number) => gear[i] ?? NO_GEAR;
  const gearFields = (i: number) => ({ rfidNumber: g(i).rfidNumber, trackrNumber: g(i).trackrNumber, trackrChoice: g(i).trackrChoice, rfidPurchased: g(i).buyRfid });
  const memberRiderIds: number[] = [];
  for (const m of members) memberRiderIds.push(await teamMemberRiderId(m));
  await db.insert(teamMembersTable).values([
    { eventId, registrationId, position: 1, riderId: captain.riderId, firstName: captain.firstName, lastName: captain.lastName, email: captain.email, ...gearFields(0) },
    ...members.map((m, i) => ({ eventId, registrationId, position: i + 2, riderId: memberRiderIds[i], firstName: m.firstName, lastName: m.lastName, email: m.email, ...gearFields(i + 1) })),
  ]).onConflictDoNothing();
}

/**
 * A number already used at this event by another team, or by another rider's
 * entry or tag assignment. Leave out this team's own registration and captain.
 */
export async function teamTagConflict(eventId: number, ownRegistrationId: number | null, captainRiderId: number | null, tags: Iterable<string>): Promise<string | null> {
  for (const tag of tags) {
    const [otherTeam] = await db.select({ teamName: registrationsTable.teamName })
      .from(teamMembersTable)
      .innerJoin(registrationsTable, eq(registrationsTable.id, teamMembersTable.registrationId))
      .where(and(
        eq(teamMembersTable.eventId, eventId),
        ne(teamMembersTable.registrationId, ownRegistrationId ?? -1),
        ne(registrationsTable.status, "void"),
        or(ilike(teamMembersTable.rfidNumber, tag), ilike(teamMembersTable.trackrNumber, tag)),
      )).limit(1);
    if (otherTeam) return `Number ${tag} is already used by team ${otherTeam.teamName ?? "another team"} at this event.`;
    const [otherEntry] = await db.select({ id: registrationsTable.id }).from(registrationsTable)
      .where(and(
        eq(registrationsTable.eventId, eventId),
        ne(registrationsTable.riderId, captainRiderId ?? -1),
        ne(registrationsTable.status, "void"),
        ilike(registrationsTable.myLapsTransponderNumber, tag),
      )).limit(1);
    const [otherAssignment] = await db.select({ id: rfidAssignmentsTable.id }).from(rfidAssignmentsTable)
      .where(and(
        eq(rfidAssignmentsTable.eventId, eventId),
        ne(rfidAssignmentsTable.riderId, captainRiderId ?? -1),
        ilike(rfidAssignmentsTable.rfidNumber, tag),
      )).limit(1);
    if (otherEntry || otherAssignment) return `Number ${tag} is already assigned to another rider at this event.`;
  }
  return null;
}

/**
 * The registration that holds a team's roster: the team may have entered more
 * than one class (one row each, same captain); the roster sits on one of them.
 */
export async function teamRegistrationId(eventId: number, riderId: number): Promise<number | null> {
  const entries = await db.select({ id: registrationsTable.id }).from(registrationsTable)
    .where(and(eq(registrationsTable.eventId, eventId), eq(registrationsTable.riderId, riderId)));
  if (entries.length === 0) return null;
  const [withRoster] = await db.select({ registrationId: teamMembersTable.registrationId }).from(teamMembersTable)
    .where(inArray(teamMembersTable.registrationId, entries.map(e => e.id)))
    .limit(1);
  return withRoster?.registrationId ?? Math.min(...entries.map(e => e.id));
}

/** Does this captain already have a team roster at the event (another of the team's class entries)? */
export async function teamRegistrationHasRoster(eventId: number, riderId: number): Promise<boolean> {
  const [row] = await db.select({ id: teamMembersTable.id }).from(teamMembersTable)
    .innerJoin(registrationsTable, eq(registrationsTable.id, teamMembersTable.registrationId))
    .where(and(eq(teamMembersTable.eventId, eventId), eq(registrationsTable.riderId, riderId), ne(registrationsTable.status, "void")))
    .limit(1);
  return !!row;
}

export async function listTeamMembers(registrationId: number) {
  return db.select().from(teamMembersTable)
    .where(eq(teamMembersTable.registrationId, registrationId))
    .orderBy(asc(teamMembersTable.position));
}

/**
 * The team a tag belongs to at this event, as the captain's rider id. Checked
 * before any other lookup, so a member's own profile tag counts for the team.
 */
export async function teamTagRider(tag: string, eventId: number): Promise<number | null> {
  const t = tag.trim();
  if (!t) return null;
  const [row] = await db.select({ riderId: registrationsTable.riderId })
    .from(teamMembersTable)
    .innerJoin(registrationsTable, eq(registrationsTable.id, teamMembersTable.registrationId))
    .where(and(
      eq(teamMembersTable.eventId, eventId),
      ne(registrationsTable.status, "void"),
      or(ilike(teamMembersTable.rfidNumber, t), ilike(teamMembersTable.trackrNumber, t)),
    ))
    .limit(1);
  return row?.riderId ?? null;
}

/** Team names at a group race event, by captain rider id (results show the team). */
export async function teamNamesByRider(eventId: number): Promise<Map<number, string>> {
  const rows = await db.select({ riderId: registrationsTable.riderId, teamName: registrationsTable.teamName })
    .from(registrationsTable)
    .where(and(eq(registrationsTable.eventId, eventId), isNotNull(registrationsTable.teamName), ne(registrationsTable.status, "void")));
  const map = new Map<number, string>();
  for (const r of rows) if (r.teamName && !map.has(r.riderId)) map.set(r.riderId, r.teamName);
  return map;
}

export interface TeamTagUpdate {
  id: number;
  rfidNumber?: string | null;
  trackrNumber?: string | null;
  firstName?: string;
  lastName?: string;
  email?: string | null;
}

/**
 * Save the team's transponder numbers (and any name or email corrections) from
 * check-in. A tag can only belong to one team member at the event, and not to
 * another rider's entry or tag assignment there.
 */
export async function saveTeamTags(eventId: number, registrationId: number, captainRiderId: number, updates: TeamTagUpdate[]): Promise<{ error: string } | null> {
  const members = await listTeamMembers(registrationId);
  const byId = new Map(members.map(m => [m.id, m]));
  const norm = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 64) : "") || null;

  const planned = new Map<number, { rfidNumber: string | null; trackrNumber: string | null; firstName: string; lastName: string; email: string | null }>();
  for (const u of updates) {
    const m = byId.get(Number(u.id));
    if (!m) return { error: "A team member on this screen is no longer on the team. Close it and open Team transponder numbers again." };
    const firstName = u.firstName !== undefined ? clean(u.firstName) : m.firstName;
    const lastName = u.lastName !== undefined ? clean(u.lastName) : m.lastName;
    if (!firstName || !lastName) return { error: `Team member ${m.position} needs a first and last name.` };
    const email = u.email !== undefined ? (clean(u.email, 254).toLowerCase() || null) : m.email;
    if (email && !EMAIL_RE.test(email)) return { error: `Team member ${m.position}'s email address isn't valid.` };
    let trackrNumber = m.trackrNumber;
    if (u.trackrNumber !== undefined) {
      const typed = norm(u.trackrNumber);
      trackrNumber = typed ? normalizeActiveTransponderIdentifier(typed) : null;
      if (typed && !trackrNumber) return { error: `${firstName} ${lastName}'s RM TrackR number isn't valid. Enter the ID printed on it (up to 9 numbers or letters A–F).` };
    }
    planned.set(m.id, {
      rfidNumber: u.rfidNumber !== undefined ? norm(u.rfidNumber) : m.rfidNumber,
      trackrNumber,
      firstName, lastName, email,
    });
  }

  // Every tag on this team after the save, and who carries it.
  const owner = new Map<string, string>();
  for (const m of members) {
    const p = planned.get(m.id) ?? m;
    const name = `${p.firstName} ${p.lastName}`;
    for (const tag of [p.rfidNumber, p.trackrNumber]) {
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (owner.has(key) && owner.get(key) !== name) return { error: `Number ${tag} is entered for both ${owner.get(key)} and ${name}. Each rider needs their own.` };
      owner.set(key, name);
    }
  }

  const conflict = await teamTagConflict(eventId, registrationId, captainRiderId, owner.keys());
  if (conflict) return { error: conflict };

  for (const [id, p] of planned) {
    await db.update(teamMembersTable).set({ ...p, updatedAt: new Date() }).where(eq(teamMembersTable.id, id));
  }
  return null;
}

export interface TeamLink { eventId: number; captainRiderId: number; registrationId: number; teamName: string | null; memberRiderId: number }

/**
 * Teams these riders rode on as members (not captain): their results are filed
 * under the captain, so rider views add the captain's results at that event.
 */
export async function teamsForRiders(riderIds: number[]): Promise<TeamLink[]> {
  if (riderIds.length === 0) return [];
  const rows = await db.select({
    eventId: teamMembersTable.eventId,
    captainRiderId: registrationsTable.riderId,
    registrationId: teamMembersTable.registrationId,
    teamName: registrationsTable.teamName,
    memberRiderId: teamMembersTable.riderId,
  }).from(teamMembersTable)
    .innerJoin(registrationsTable, eq(registrationsTable.id, teamMembersTable.registrationId))
    .where(and(inArray(teamMembersTable.riderId, riderIds), ne(registrationsTable.status, "void")));
  return rows
    .filter(r => r.memberRiderId != null && !riderIds.includes(r.captainRiderId))
    .map(r => ({ ...r, memberRiderId: r.memberRiderId! }));
}

export interface TeamMemberLaps {
  position: number;
  name: string;
  riderId: number | null;
  /** Each lap this rider finished, in race order (ms). */
  lapsMs: number[];
}

/**
 * One team's race split by rider: each lap is credited to the rider whose tag
 * was read at the end of it. Laps from an unknown tag aren't credited to anyone.
 */
export async function teamMotoBreakdown(motoId: number, registrationId: number, captainRiderId: number): Promise<TeamMemberLaps[]> {
  const members = await listTeamMembers(registrationId);
  if (members.length === 0) return [];
  const crossings = await db.select({ rfidNumber: lapCrossingsTable.rfidNumber, lapTimeMs: lapCrossingsTable.lapTimeMs })
    .from(lapCrossingsTable)
    .where(and(eq(lapCrossingsTable.motoId, motoId), eq(lapCrossingsTable.riderId, captainRiderId), sql`${lapCrossingsTable.lapTimeMs} > 0`))
    .orderBy(asc(lapCrossingsTable.crossingTime), asc(lapCrossingsTable.id));
  const byTag = new Map<string, number>();
  for (const m of members) for (const t of [m.rfidNumber, m.trackrNumber]) if (t) byTag.set(t.toLowerCase(), m.id);
  const laps = new Map<number, number[]>(members.map(m => [m.id, []]));
  for (const c of crossings) {
    const memberId = byTag.get(c.rfidNumber.trim().toLowerCase());
    if (memberId != null && c.lapTimeMs) laps.get(memberId)!.push(c.lapTimeMs);
  }
  return members.map(m => ({ position: m.position, name: `${m.firstName} ${m.lastName}`, riderId: m.riderId, lapsMs: laps.get(m.id) ?? [] }));
}
