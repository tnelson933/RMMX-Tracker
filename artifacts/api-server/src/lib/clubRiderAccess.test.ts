import assert from "node:assert/strict";
import test from "node:test";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { callerRiderScope, ridersTiedToClub, riderTiedToClub, scopeCanAccessRider } from "./clubRiderAccess";

test("scope: super admin is unrestricted, staff/organizer scoped, signed out none", () => {
  assert.deepEqual(callerRiderScope({ callerIsSuperAdmin: true, callerClubId: 5 }), { kind: "all" });
  assert.deepEqual(callerRiderScope({ staffClubId: 7, callerClubId: 7 }), { kind: "club", clubId: 7 });
  // Public routes: only callerClubId is set.
  assert.deepEqual(callerRiderScope({ callerClubId: 9 }), { kind: "club", clubId: 9 });
  assert.deepEqual(callerRiderScope({}), { kind: "none" });
  assert.deepEqual(callerRiderScope(undefined), { kind: "none" });
});

test("scope none never reaches a rider; bad ids are never tied", async () => {
  assert.equal(await scopeCanAccessRider({ kind: "none" }, 1), false);
  assert.equal(await scopeCanAccessRider({ kind: "all" }, 1), true);
  assert.equal(await riderTiedToClub("abc", 1), false);
  assert.equal(await riderTiedToClub(-3, 1), false);
  assert.equal((await ridersTiedToClub([], 1)).size, 0);
});

// Against the local database: every rider registered for some club's event is
// tied to that club and not to a club id that doesn't exist.
test("registered riders are tied to the event's club only", async (t) => {
  if (!process.env.DATABASE_URL) return t.skip("DATABASE_URL not set");
  const result = await db.execute(sql`
    SELECT g.rider_id AS "riderId", e.club_id AS "clubId"
    FROM registrations g JOIN events e ON e.id = g.event_id
    WHERE e.club_id IS NOT NULL LIMIT 1`);
  const row = (result as unknown as { rows: Array<{ riderId: number; clubId: number }> }).rows[0];
  if (!row) return t.skip("no registrations in this database");
  assert.equal(await riderTiedToClub(row.riderId, Number(row.clubId)), true);
  assert.equal(await scopeCanAccessRider({ kind: "club", clubId: Number(row.clubId) }, row.riderId), true);
  const missingClub = 2_000_000_000;
  assert.equal(await riderTiedToClub(row.riderId, missingClub), false);
  const many = await ridersTiedToClub([row.riderId, row.riderId, 0, "x"], Number(row.clubId));
  assert.deepEqual([...many], [Number(row.riderId)]);
});
