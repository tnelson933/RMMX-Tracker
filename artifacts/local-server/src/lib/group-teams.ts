import { normalizeActiveTransponderIdentifier } from "@workspace/api-zod";
import { getDb } from "../db";

/**
 * Group races on the desktop server (mirrors api-server/src/lib/teams.ts):
 * a registration is a team, its rider the captain (member 1), and a read of
 * any member's RFID tag or RM TrackR counts as a lap for the team.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v: unknown, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export interface TeamMemberInput { firstName: string; lastName: string; email: string }

/** The team sent with a group race registration, or an error. */
export function parseTeamInput(body: Record<string, any>, ridersPerGroup: number | null): { teamName: string; members: TeamMemberInput[] } | { error: string } {
  const size = Math.max(2, ridersPerGroup ?? 2);
  const teamName = clean(body.teamName, 80);
  if (!teamName) return { error: "Enter a team name." };
  const raw = Array.isArray(body.teamMembers) ? body.teamMembers : [];
  const members = raw.map((m: any) => ({ firstName: clean(m?.firstName), lastName: clean(m?.lastName), email: clean(m?.email, 254).toLowerCase() }));
  if (members.length !== size - 1) return { error: `This is a group race with ${size} riders per team. Enter the other ${size - 1} team members.` };
  for (let i = 0; i < members.length; i++) {
    if (!members[i].firstName || !members[i].lastName) return { error: `Team member ${i + 2} needs a first and last name.` };
    if (!EMAIL_RE.test(members[i].email)) return { error: `Team member ${i + 2} needs a valid email address.` };
  }
  return { teamName, members };
}

export function saveTeamRoster(eventId: number, registrationId: number, captain: { riderId: number; firstName: string; lastName: string; email: string | null }, members: TeamMemberInput[]): void {
  const db = getDb();
  const insert = db.prepare(`INSERT OR IGNORE INTO team_members (event_id, registration_id, position, rider_id, first_name, last_name, email)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insert.run(eventId, registrationId, 1, captain.riderId, captain.firstName, captain.lastName, captain.email);
  members.forEach((m, i) => insert.run(eventId, registrationId, i + 2, null, m.firstName, m.lastName, m.email));
}

/** The registration holding a captain's team roster at this event. */
export function teamRegistrationId(eventId: number, riderId: number): number | null {
  const db = getDb();
  const withRoster = db.prepare(`SELECT tm.registration_id AS id FROM team_members tm
      JOIN registrations r ON r.id = tm.registration_id
     WHERE r.event_id = ? AND r.rider_id = ? LIMIT 1`).get(eventId, riderId) as { id: number } | undefined;
  if (withRoster) return withRoster.id;
  const first = db.prepare("SELECT MIN(id) AS id FROM registrations WHERE event_id = ? AND rider_id = ?").get(eventId, riderId) as { id: number | null } | undefined;
  return first?.id ?? null;
}

export function listTeamMembers(registrationId: number) {
  return getDb().prepare(`SELECT id, position, first_name AS firstName, last_name AS lastName, email,
      rfid_number AS rfidNumber, trackr_number AS trackrNumber
    FROM team_members WHERE registration_id = ? ORDER BY position`).all(registrationId) as Array<{
      id: number; position: number; firstName: string; lastName: string; email: string | null; rfidNumber: string | null; trackrNumber: string | null;
    }>;
}

/** The team (captain's rider id) a tag belongs to at this event. */
export function teamTagRider(tag: string, eventId: number): number | null {
  const t = tag.trim();
  if (!t) return null;
  const row = getDb().prepare(`SELECT r.rider_id FROM team_members tm
      JOIN registrations r ON r.id = tm.registration_id
     WHERE tm.event_id = ? AND r.status != 'void'
       AND (tm.rfid_number = ? COLLATE NOCASE OR tm.trackr_number = ? COLLATE NOCASE)
     LIMIT 1`).get(eventId, t, t) as { rider_id: number } | undefined;
  return row?.rider_id ?? null;
}

/** Save the team's numbers from check-in; a number belongs to one rider at the event. */
export function saveTeamTags(eventId: number, registrationId: number, captainRiderId: number, updates: any[]): { error: string } | null {
  const db = getDb();
  const members = listTeamMembers(registrationId);
  const byId = new Map(members.map(m => [m.id, m]));
  const norm = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 64) : "") || null;
  const planned = new Map<number, { rfidNumber: string | null; trackrNumber: string | null }>();
  for (const u of updates) {
    const m = byId.get(Number(u?.id));
    if (!m) return { error: "A team member on this screen is no longer on the team. Close it and open Team transponder numbers again." };
    let trackrNumber = m.trackrNumber;
    if (u.trackrNumber !== undefined) {
      const typed = norm(u.trackrNumber);
      trackrNumber = typed ? normalizeActiveTransponderIdentifier(typed) : null;
      if (typed && !trackrNumber) return { error: `${m.firstName} ${m.lastName}'s RM TrackR number isn't valid. Enter the ID printed on it (up to 9 numbers or letters A–F).` };
    }
    planned.set(m.id, { rfidNumber: u.rfidNumber !== undefined ? norm(u.rfidNumber) : m.rfidNumber, trackrNumber });
  }
  const owner = new Map<string, string>();
  for (const m of members) {
    const p = planned.get(m.id) ?? m;
    const name = `${m.firstName} ${m.lastName}`;
    for (const tag of [p.rfidNumber, p.trackrNumber]) {
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (owner.has(key) && owner.get(key) !== name) return { error: `Number ${tag} is entered for both ${owner.get(key)} and ${name}. Each rider needs their own.` };
      owner.set(key, name);
    }
  }
  for (const tag of owner.keys()) {
    const otherTeam = db.prepare(`SELECT r.team_name FROM team_members tm JOIN registrations r ON r.id = tm.registration_id
       WHERE tm.event_id = ? AND tm.registration_id != ? AND r.status != 'void'
         AND (tm.rfid_number = ? COLLATE NOCASE OR tm.trackr_number = ? COLLATE NOCASE) LIMIT 1`)
      .get(eventId, registrationId, tag, tag) as { team_name: string | null } | undefined;
    if (otherTeam) return { error: `Number ${tag} is already used by team ${otherTeam.team_name ?? "another team"} at this event.` };
    const other = db.prepare(`SELECT 1 FROM registrations WHERE event_id = ? AND rider_id != ? AND status != 'void' AND mylaps_transponder_number = ? COLLATE NOCASE
       UNION ALL SELECT 1 FROM rfid_assignments WHERE event_id = ? AND rider_id != ? AND rfid_number = ? COLLATE NOCASE LIMIT 1`)
      .get(eventId, captainRiderId, tag, eventId, captainRiderId, tag);
    if (other) return { error: `Number ${tag} is already assigned to another rider at this event.` };
  }
  const update = db.prepare("UPDATE team_members SET rfid_number = ?, trackr_number = ?, updated_at = datetime('now') WHERE id = ?");
  for (const [id, p] of planned) update.run(p.rfidNumber, p.trackrNumber, id);
  return null;
}
