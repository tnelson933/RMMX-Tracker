/**
 * Which riders a club may act on.
 *
 * A rider is tied to a club when the club added them (riders.club_id) or they
 * are entered in one of the club's events: a registration, a group-race team
 * spot, or a check-in row. This is the same set as the organizer's Riders list
 * (getClubRiderIds in routes/riders.ts) plus team members and check-ins.
 *
 * Organizer routes that take a riderId (link a registration, check in, assign a
 * tag, record a manual lap, look a rider up) must refuse a rider who isn't tied
 * to the caller's club, so one club can't read or change another club's riders.
 * Riders registering themselves for a new club's event is normal and goes
 * through the public registration routes, which don't use this check.
 */
import type { Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/** Club scope of the signed-in caller: unrestricted (super admin), one club, or none. */
export type ClubRiderScope = { kind: "all" } | { kind: "club"; clubId: number } | { kind: "none" };

/**
 * Scope from res.locals. On organizer routes staffClubId is set for staff and
 * club organizers; on public routes only callerClubId/callerIsSuperAdmin are
 * (middleware/accessControl.ts). Super admins are unrestricted.
 */
export function callerRiderScope(locals: Record<string, unknown> | undefined): ClubRiderScope {
  if (locals?.callerIsSuperAdmin === true) return { kind: "all" };
  const staffClubId = locals?.staffClubId;
  if (typeof staffClubId === "number") return { kind: "club", clubId: staffClubId };
  const callerClubId = locals?.callerClubId;
  if (typeof callerClubId === "number") return { kind: "club", clubId: callerClubId };
  return { kind: "none" };
}

export function scopeFromResponse(res: Response): ClubRiderScope {
  return callerRiderScope(res.locals as Record<string, unknown>);
}

function toIds(riderIds: Iterable<unknown>): number[] {
  const out = new Set<number>();
  for (const v of riderIds) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return [...out];
}

/** The subset of riderIds tied to clubId (see the file comment). */
export async function ridersTiedToClub(riderIds: Iterable<unknown>, clubId: number): Promise<Set<number>> {
  const ids = toIds(riderIds);
  if (ids.length === 0 || !Number.isInteger(clubId)) return new Set();
  const idList = sql.join(ids.map(id => sql`${id}`), sql`, `);
  const result = await db.execute(sql`
    SELECT r.id FROM riders r
    WHERE r.id IN (${idList})
      AND (
        r.club_id = ${clubId}
        OR EXISTS (SELECT 1 FROM registrations g JOIN events e ON e.id = g.event_id
                   WHERE g.rider_id = r.id AND e.club_id = ${clubId})
        OR EXISTS (SELECT 1 FROM team_members t JOIN events e ON e.id = t.event_id
                   WHERE t.rider_id = r.id AND e.club_id = ${clubId})
        OR EXISTS (SELECT 1 FROM checkins c JOIN events e ON e.id = c.event_id
                   WHERE c.rider_id = r.id AND e.club_id = ${clubId})
      )
  `);
  const rows = (result as unknown as { rows: Array<{ id: number | string }> }).rows ?? [];
  return new Set(rows.map(r => Number(r.id)));
}

export async function riderTiedToClub(riderId: unknown, clubId: number): Promise<boolean> {
  const n = Number(riderId);
  if (!Number.isInteger(n) || n <= 0) return false;
  return (await ridersTiedToClub([n], clubId)).has(n);
}

/** True when the scope may act on this rider. */
export async function scopeCanAccessRider(scope: ClubRiderScope, riderId: unknown): Promise<boolean> {
  if (scope.kind === "all") return true;
  if (scope.kind === "none") return false;
  return riderTiedToClub(riderId, scope.clubId);
}

export const RIDER_NOT_IN_CLUB_ERROR =
  "This rider isn't registered with your club. Register them for one of your events first.";
