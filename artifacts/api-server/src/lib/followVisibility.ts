/**
 * Follows of private profiles (owner rule 2026-11-04: riders under 18 start
 * private; a parent/manager can make the profile public).
 *
 * A private profile can't be followed by accounts that don't manage it. Follows
 * made before the profile went private stay in rider_follows but give nothing
 * while it is private: no live video, no race-start, live or results pushes and
 * no feed items. Making the profile public again brings them back.
 *
 * The rider's own managers keep everything (lib/riderAccess.ts).
 */
import { db, ridersTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { effectiveVisibility } from "./riderResume";
import { accountIdsByRider } from "./riderAccess";

export const PRIVATE_PROFILE_FOLLOW_ERROR =
  "This rider's profile is private. Ask their parent or guardian to make it public.";

const todayYmd = () => new Date().toISOString().slice(0, 10);

/** Which of these riders have a private profile today. */
export async function privateRiderIds(riderIds: number[]): Promise<Set<number>> {
  const ids = [...new Set(riderIds)];
  if (ids.length === 0) return new Set();
  const rows = await db.select({ id: ridersTable.id, dateOfBirth: ridersTable.dateOfBirth, profileVisibility: ridersTable.profileVisibility })
    .from(ridersTable).where(inArray(ridersTable.id, ids));
  const today = todayYmd();
  return new Set(rows.filter(r => effectiveVisibility(r, today) === "private").map(r => r.id));
}

/**
 * The follows that count right now: follows of public profiles, plus follows
 * by one of a private rider's own accounts (owner or invited manager).
 */
export async function followsThatCount<T extends { accountId: number; riderId: number }>(follows: T[]): Promise<T[]> {
  if (follows.length === 0) return follows;
  const hidden = await privateRiderIds(follows.map(f => f.riderId));
  if (hidden.size === 0) return follows;
  const managers = await accountIdsByRider([...hidden]);
  return follows.filter(f => !hidden.has(f.riderId) || (managers.get(f.riderId) ?? []).includes(f.accountId));
}
