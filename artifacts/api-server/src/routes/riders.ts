import { Router } from "express";
import { db } from "@workspace/db";
import { ridersTable, raceResultsTable, motosTable, eventsTable, registrationsTable } from "@workspace/db";
import { eq, ilike, or, desc, and, inArray, sql } from "drizzle-orm";

const router = Router();

function getStaffClubId(res: any): number | null {
  const v = res.locals?.staffClubId;
  return typeof v === "number" ? v : null;
}

function getOrganizerClubId(res: any): number | null {
  const v = res.locals?.organizerClubId;
  return typeof v === "number" ? v : null;
}

/**
 * Returns all rider IDs visible to a club:
 *  1. Riders who registered for any of the club's events.
 *  2. Riders directly added through the club's rider tab (club_id on the rider).
 */
async function getClubRiderIds(clubId: number): Promise<number[]> {
  const events = await db.select({ id: eventsTable.id }).from(eventsTable).where(eq(eventsTable.clubId, clubId));

  const registeredIds: number[] = [];
  if (events.length > 0) {
    const regs = await db.selectDistinct({ riderId: registrationsTable.riderId }).from(registrationsTable)
      .where(inArray(registrationsTable.eventId, events.map(e => e.id)));
    registeredIds.push(...regs.map(r => r.riderId).filter((id): id is number => id !== null));
  }

  // Riders directly added by this club (club_id column on riders table)
  const directRows = await db.select({ id: ridersTable.id }).from(ridersTable)
    .where(eq(ridersTable.clubId, clubId));
  const directIds = directRows.map(r => r.id);

  // Union and deduplicate
  return Array.from(new Set([...registeredIds, ...directIds]));
}

/**
 * Builds a search condition matching firstName, lastName, full name, bibNumber, email, and phone.
 * Input is trimmed so trailing/leading whitespace does not break matches.
 */
function searchCond(s: string) {
  const term = s.trim();
  const p = `%${term}%`;
  return or(
    ilike(ridersTable.firstName, p),
    ilike(ridersTable.lastName, p),
    // Match "First Last" as a combined string — handles "trent nelson" style queries
    ilike(sql<string>`${ridersTable.firstName} || ' ' || ${ridersTable.lastName}`, p),
    ilike(ridersTable.bibNumber, p),
    ilike(ridersTable.email, p),
    ilike(ridersTable.phone, p),
  );
}

router.get("/riders", async (req, res) => {
  const { search } = req.query;
  const staffCId = getStaffClubId(res);
  const orgCId = getOrganizerClubId(res);

  // Determine the effective club scope (staff OR club_organizer — whichever applies)
  const scopedClubId = staffCId ?? orgCId;

  let riders;
  if (scopedClubId !== null) {
    const riderIds = await getClubRiderIds(scopedClubId);
    if (riderIds.length === 0) return res.json([]);

    const cond = search
      ? and(inArray(ridersTable.id, riderIds), searchCond(String(search)))
      : inArray(ridersTable.id, riderIds);
    riders = await db.select().from(ridersTable).where(cond).orderBy(ridersTable.lastName);
  } else if (search) {
    // Super-admin with search — apply search across all riders
    riders = await db.select().from(ridersTable)
      .where(searchCond(String(search)))
      .orderBy(ridersTable.lastName);
  } else {
    // Super-admin, no search — return all riders
    riders = await db.select().from(ridersTable).orderBy(ridersTable.lastName);
  }

  return res.json(riders.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })));
});

router.post("/riders", async (req, res) => {
  const { firstName, lastName, email, phone, bibNumber, dateOfBirth, emergencyContact, emergencyPhone, rfidNumber, bikeManufacturer, bikeModel, bikeYear, sponsors, amaNumber, mylapsTransponderId, streetAddress, city, homeState, zip } = req.body;
  if (!firstName || !lastName) return res.status(400).json({ error: "firstName and lastName required" });

  // Tag the rider with the organizer's club so they remain visible in that club's rider list
  const orgCId = getOrganizerClubId(res);

  const [rider] = await db.insert(ridersTable).values({
    firstName, lastName, email, phone, bibNumber, dateOfBirth, emergencyContact,
    emergencyPhone, rfidNumber, bikeManufacturer, bikeModel, bikeYear, sponsors,
    amaNumber, mylapsTransponderId, streetAddress, city, homeState, zip,
    ...(orgCId != null ? { clubId: orgCId } : {}),
  }).returning();
  return res.status(201).json({ ...rider, createdAt: rider.createdAt.toISOString() });
});

router.get("/riders/:riderId", async (req, res) => {
  const id = Number(req.params.riderId);
  const riders = await db.select().from(ridersTable).where(eq(ridersTable.id, id));
  if (!riders[0]) return res.status(404).json({ error: "Not found" });
  const rider = riders[0];

  const staffCId = getStaffClubId(res);
  const orgCId = getOrganizerClubId(res);
  const scopedClubId = staffCId ?? orgCId;

  if (scopedClubId !== null) {
    const riderIds = await getClubRiderIds(scopedClubId);
    if (!riderIds.includes(id)) return res.status(403).json({ error: "Forbidden" });
  }

  const recentResults = await db.select({
    id: raceResultsTable.id,
    eventId: raceResultsTable.eventId,
    motoId: raceResultsTable.motoId,
    riderId: raceResultsTable.riderId,
    raceClass: raceResultsTable.raceClass,
    position: raceResultsTable.position,
    totalTime: raceResultsTable.totalTime,
    lapTimes: raceResultsTable.lapTimes,
    points: raceResultsTable.points,
    dnf: raceResultsTable.dnf,
    dns: raceResultsTable.dns,
    bibNumber: raceResultsTable.bibNumber,
    motoName: motosTable.name,
  }).from(raceResultsTable)
    .leftJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .where(eq(raceResultsTable.riderId, id))
    .limit(10);

  const [latestClubId] = await db
    .select({ clubIdNumber: registrationsTable.clubIdNumber })
    .from(registrationsTable)
    .where(eq(registrationsTable.riderId, id) as any)
    .orderBy(desc(registrationsTable.createdAt))
    .limit(1);

  return res.json({
    ...rider,
    createdAt: rider.createdAt.toISOString(),
    clubIdNumber: latestClubId?.clubIdNumber ?? null,
    recentResults: recentResults.map(r => ({
      ...r,
      lapTimes: Array.isArray(r.lapTimes) ? r.lapTimes : [],
      motoName: r.motoName || "",
    })),
    totalEvents: recentResults.length,
  });
});

router.patch("/riders/:riderId", async (req, res) => {
  const id = Number(req.params.riderId);

  const staffCId = getStaffClubId(res);
  const orgCId = getOrganizerClubId(res);
  const scopedClubId = staffCId ?? orgCId;

  if (scopedClubId !== null) {
    const riderIds = await getClubRiderIds(scopedClubId);
    if (!riderIds.includes(id)) return res.status(403).json({ error: "Forbidden" });
  }

  const fields = ["firstName", "lastName", "email", "phone", "bibNumber", "dateOfBirth", "emergencyContact", "emergencyPhone", "rfidNumber", "bikeManufacturer", "bikeModel", "bikeYear", "sponsors", "amaNumber", "mylapsTransponderId", "streetAddress", "city", "homeState", "zip"];
  const updates: Record<string, unknown> = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  const [rider] = await db.update(ridersTable).set(updates as any).where(eq(ridersTable.id, id)).returning();
  if (!rider) return res.status(404).json({ error: "Not found" });
  return res.json({ ...rider, createdAt: rider.createdAt.toISOString() });
});

export default router;
