import { Router } from "express";
import { db } from "@workspace/db";
import { ridersTable, raceResultsTable, motosTable, eventsTable, registrationsTable } from "@workspace/db";
import { eq, ilike, or, desc, and, inArray, sql } from "drizzle-orm";
import { normalizeActiveTransponderIdentifier } from "@workspace/api-zod";

const router = Router();

/** Slice a lapTimes array to at most lapCount entries. Handles null/undefined gracefully. */
function capLapTimes(lapTimes: unknown, lapCount: number | null | undefined): unknown[] {
  const arr = Array.isArray(lapTimes) ? lapTimes : [];
  if (lapCount != null && lapCount > 0) return arr.slice(0, lapCount);
  return arr;
}

/** The club this caller is limited to (staff and club organizers alike), or null for super admins. */
function getStaffClubId(res: any): number | null {
  const v = res.locals?.staffClubId;
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

  // Effective club scope: staff and club organizers both get res.locals.staffClubId
  const scopedClubId = staffCId;

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
  const normalizedTransponderId =
    normalizeActiveTransponderIdentifier(mylapsTransponderId);
  const hasNonblankTransponder =
    mylapsTransponderId != null &&
    (typeof mylapsTransponderId !== "string" || mylapsTransponderId.trim() !== "");
  if (hasNonblankTransponder && !normalizedTransponderId) {
    return res.status(400).json({
      error: "Active transponder ID must be 1–9 hexadecimal characters",
    });
  }

  // Tag the rider with the organizer's club so they remain visible in that club's rider list
  const orgCId = getStaffClubId(res); // set for club organizers and staff

  const [rider] = await db.insert(ridersTable).values({
    firstName, lastName, email, phone, bibNumber, dateOfBirth, emergencyContact,
    emergencyPhone, rfidNumber, bikeManufacturer, bikeModel, bikeYear, sponsors,
    amaNumber, mylapsTransponderId: normalizedTransponderId, streetAddress, city, homeState, zip,
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
  const scopedClubId = staffCId;

  if (scopedClubId !== null) {
    const riderIds = await getClubRiderIds(scopedClubId);
    if (!riderIds.includes(id)) return res.status(403).json({ error: "Forbidden" });
  }

  // Results and club data are limited to the caller's club events (super admins: all clubs).
  // Only completed motos count; newest event first.
  const resultConds = [eq(raceResultsTable.riderId, id), eq(motosTable.status, "completed")];
  if (scopedClubId !== null) resultConds.push(eq(eventsTable.clubId, scopedClubId));

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
    motoType: motosTable.type,
    resultsFinalizedAt: motosTable.resultsFinalizedAt,
    lapCount: motosTable.lapCount,
    timeLimitMs: motosTable.timeLimitMs,
    eventName: eventsTable.name,
    eventDate: eventsTable.date,
  }).from(raceResultsTable)
    .innerJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .innerJoin(eventsTable, eq(raceResultsTable.eventId, eventsTable.id))
    .where(and(...resultConds))
    .orderBy(desc(eventsTable.date), desc(raceResultsTable.id))
    .limit(10);

  const regConds = [eq(registrationsTable.riderId, id)];
  if (scopedClubId !== null) regConds.push(eq(eventsTable.clubId, scopedClubId));

  const [latestClubId] = await db
    .select({ clubIdNumber: registrationsTable.clubIdNumber })
    .from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .where(and(...regConds))
    .orderBy(desc(registrationsTable.createdAt))
    .limit(1);

  // Registrations are class entries: count distinct events, not rows.
  const [eventCount] = await db
    .select({ count: sql<number>`count(distinct ${registrationsTable.eventId})::int` })
    .from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .where(and(...regConds));

  return res.json({
    ...rider,
    createdAt: rider.createdAt.toISOString(),
    clubIdNumber: latestClubId?.clubIdNumber ?? null,
    recentResults: recentResults.map(({ motoType, resultsFinalizedAt, lapCount, timeLimitMs, ...r }) => ({
      ...r,
      lapTimes: capLapTimes(r.lapTimes, timeLimitMs ? null : lapCount),
      motoName: r.motoName || "",
      eventName: r.eventName || "",
      official: resultsFinalizedAt != null || motoType === "practice",
    })),
    totalEvents: Number(eventCount?.count ?? 0),
  });
});

router.patch("/riders/:riderId", async (req, res) => {
  const id = Number(req.params.riderId);

  const staffCId = getStaffClubId(res);
  const scopedClubId = staffCId;

  if (scopedClubId !== null) {
    const riderIds = await getClubRiderIds(scopedClubId);
    if (!riderIds.includes(id)) return res.status(403).json({ error: "Forbidden" });
  }

  // Email is the rider profile ownership key (riderAccess.ts). Only the club that
  // created the rider (or a super admin) may change it.
  if (scopedClubId !== null && req.body.email !== undefined) {
    const [existing] = await db.select({ email: ridersTable.email, clubId: ridersTable.clubId })
      .from(ridersTable).where(eq(ridersTable.id, id));
    if (!existing) return res.status(404).json({ error: "Not found" });
    const current = (existing.email ?? "").trim().toLowerCase();
    const next = (req.body.email == null ? "" : String(req.body.email)).trim().toLowerCase();
    if (existing.clubId !== scopedClubId && next !== current) {
      return res.status(400).json({
        error: "This rider's email can't be changed here because the rider was not added by your club. The rider can update it from their own account.",
      });
    }
  }

  const fields = ["firstName", "lastName", "email", "phone", "bibNumber", "dateOfBirth", "emergencyContact", "emergencyPhone", "rfidNumber", "bikeManufacturer", "bikeModel", "bikeYear", "sponsors", "amaNumber", "mylapsTransponderId", "streetAddress", "city", "homeState", "zip"];
  const updates: Record<string, unknown> = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  if (req.body.mylapsTransponderId !== undefined) {
    const rawTransponderId = req.body.mylapsTransponderId;
    const normalizedTransponderId =
      normalizeActiveTransponderIdentifier(rawTransponderId);
    const hasNonblankTransponder =
      rawTransponderId != null &&
      (typeof rawTransponderId !== "string" || rawTransponderId.trim() !== "");
    if (hasNonblankTransponder && !normalizedTransponderId) {
      return res.status(400).json({
        error: "Active transponder ID must be 1–9 hexadecimal characters",
      });
    }
    updates.mylapsTransponderId = normalizedTransponderId;
  }
  const [rider] = await db.update(ridersTable).set(updates as any).where(eq(ridersTable.id, id)).returning();
  if (!rider) return res.status(404).json({ error: "Not found" });
  return res.json({ ...rider, createdAt: rider.createdAt.toISOString() });
});

export default router;
