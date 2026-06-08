import { Router } from "express";
import { db } from "@workspace/db";
import {
  clubsTable,
  usersTable,
  eventsTable,
  ridersTable,
  registrationsTable,
  checkinsTable,
  rfidAssignmentsTable,
  motosTable,
  raceResultsTable,
  eventPublicationTable,
  seriesTable,
  seriesPointsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const router = Router();

router.get("/clubs/:clubId/export", async (req, res) => {
  const clubId = Number(req.params.clubId);
  const userId = (req.session as any).userId;

  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const [requestingUser] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!requestingUser || requestingUser.clubId !== clubId) {
    return res.status(403).json({ error: "Access denied" });
  }

  const [club] = await db
    .select()
    .from(clubsTable)
    .where(eq(clubsTable.id, clubId));
  if (!club) {
    return res.status(404).json({ error: "Club not found" });
  }

  const users = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clubId, clubId));

  const events = await db
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.clubId, clubId));

  const eventIds = events.map((e) => e.id);

  let registrations: (typeof registrationsTable.$inferSelect)[] = [];
  let riders: (typeof ridersTable.$inferSelect)[] = [];
  let checkins: (typeof checkinsTable.$inferSelect)[] = [];
  let rfidAssignments: (typeof rfidAssignmentsTable.$inferSelect)[] = [];
  let motos: (typeof motosTable.$inferSelect)[] = [];
  let raceResults: (typeof raceResultsTable.$inferSelect)[] = [];
  let eventPublications: (typeof eventPublicationTable.$inferSelect)[] = [];

  if (eventIds.length > 0) {
    registrations = await db
      .select()
      .from(registrationsTable)
      .where(inArray(registrationsTable.eventId, eventIds));

    const riderIds = [...new Set(registrations.map((r) => r.riderId))];
    if (riderIds.length > 0) {
      riders = await db
        .select()
        .from(ridersTable)
        .where(inArray(ridersTable.id, riderIds));
    }

    checkins = await db
      .select()
      .from(checkinsTable)
      .where(inArray(checkinsTable.eventId, eventIds));

    rfidAssignments = await db
      .select()
      .from(rfidAssignmentsTable)
      .where(inArray(rfidAssignmentsTable.eventId, eventIds));

    motos = await db
      .select()
      .from(motosTable)
      .where(inArray(motosTable.eventId, eventIds));

    const motoIds = motos.map((m) => m.id);
    if (motoIds.length > 0) {
      raceResults = await db
        .select()
        .from(raceResultsTable)
        .where(inArray(raceResultsTable.motoId, motoIds));
    }

    eventPublications = await db
      .select()
      .from(eventPublicationTable)
      .where(inArray(eventPublicationTable.eventId, eventIds));
  }

  const series = await db
    .select()
    .from(seriesTable)
    .where(eq(seriesTable.clubId, clubId));

  const seriesIds = series.map((s) => s.id);
  let seriesPoints: (typeof seriesPointsTable.$inferSelect)[] = [];
  if (seriesIds.length > 0) {
    seriesPoints = await db
      .select()
      .from(seriesPointsTable)
      .where(inArray(seriesPointsTable.seriesId, seriesIds));
  }

  const today = new Date().toISOString().slice(0, 10);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="race-data-${today}.json"`,
  );
  res.setHeader("Content-Type", "application/json");

  return res.json({
    exportedAt: new Date().toISOString(),
    version: 1,
    club,
    users,
    events,
    riders,
    registrations,
    checkins,
    rfidAssignments,
    motos,
    raceResults,
    eventPublications,
    series,
    seriesPoints,
  });
});

export default router;
