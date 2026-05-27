import { Router } from "express";
import { db } from "@workspace/db";
import { eventsTable, clubsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

const router = Router();

router.get("/events", async (req, res) => {
  const { state, clubId, status } = req.query;

  let query = db.select({
    id: eventsTable.id,
    clubId: eventsTable.clubId,
    name: eventsTable.name,
    date: eventsTable.date,
    state: eventsTable.state,
    location: eventsTable.location,
    trackName: eventsTable.trackName,
    raceClasses: eventsTable.raceClasses,
    raceClassLimits: eventsTable.raceClassLimits,
    registrationOpen: eventsTable.registrationOpen,
    registrationClose: eventsTable.registrationClose,
    status: eventsTable.status,
    paymentEnabled: eventsTable.paymentEnabled,
    entryFee: eventsTable.entryFee,
    maxRiders: eventsTable.maxRiders,
    createdAt: eventsTable.createdAt,
    clubName: clubsTable.name,
  }).from(eventsTable).leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id));

  const conditions = [];
  if (state) conditions.push(eq(eventsTable.state, String(state)));
  if (clubId) conditions.push(eq(eventsTable.clubId, Number(clubId)));
  if (status) conditions.push(eq(eventsTable.status, String(status)));

  const events = conditions.length
    ? await query.where(and(...conditions)).orderBy(eventsTable.date)
    : await query.orderBy(eventsTable.date);

  return res.json(events.map(e => ({
    ...e,
    entryFee: e.entryFee ? Number(e.entryFee) : null,
    createdAt: e.createdAt.toISOString(),
  })));
});

router.post("/events", async (req, res) => {
  const { clubId, name, date, state, location, trackName, raceClasses, raceClassLimits, registrationOpen, registrationClose, paymentEnabled, entryFee, maxRiders } = req.body;
  if (!clubId || !name || !date || !state) return res.status(400).json({ error: "clubId, name, date, state required" });

  const [event] = await db.insert(eventsTable).values({
    clubId, name, date, state, location, trackName,
    raceClasses: raceClasses || [],
    raceClassLimits: raceClassLimits || {},
    registrationOpen, registrationClose,
    paymentEnabled: paymentEnabled || false,
    entryFee: entryFee ? String(entryFee) : null,
    maxRiders,
  }).returning();

  return res.status(201).json({
    ...event,
    entryFee: event.entryFee ? Number(event.entryFee) : null,
    createdAt: event.createdAt.toISOString(),
    clubName: null,
  });
});

router.get("/events/:eventId", async (req, res) => {
  const id = Number(req.params.eventId);
  const events = await db.select({
    id: eventsTable.id,
    clubId: eventsTable.clubId,
    name: eventsTable.name,
    date: eventsTable.date,
    state: eventsTable.state,
    location: eventsTable.location,
    trackName: eventsTable.trackName,
    raceClasses: eventsTable.raceClasses,
    raceClassLimits: eventsTable.raceClassLimits,
    registrationOpen: eventsTable.registrationOpen,
    registrationClose: eventsTable.registrationClose,
    status: eventsTable.status,
    paymentEnabled: eventsTable.paymentEnabled,
    entryFee: eventsTable.entryFee,
    maxRiders: eventsTable.maxRiders,
    createdAt: eventsTable.createdAt,
    clubName: clubsTable.name,
  }).from(eventsTable).leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id)).where(eq(eventsTable.id, id));

  if (!events[0]) return res.status(404).json({ error: "Not found" });
  const e = events[0];
  return res.json({
    ...e,
    entryFee: e.entryFee ? Number(e.entryFee) : null,
    createdAt: e.createdAt.toISOString(),
  });
});

router.patch("/events/:eventId", async (req, res) => {
  const id = Number(req.params.eventId);
  const updates: Record<string, unknown> = {};
  const fields = ["name", "date", "state", "location", "trackName", "raceClasses", "raceClassLimits", "registrationOpen", "registrationClose", "status", "paymentEnabled", "maxRiders"];
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  if (req.body.entryFee !== undefined) updates.entryFee = req.body.entryFee ? String(req.body.entryFee) : null;

  const [event] = await db.update(eventsTable).set(updates as any).where(eq(eventsTable.id, id)).returning();
  if (!event) return res.status(404).json({ error: "Not found" });
  return res.json({ ...event, entryFee: event.entryFee ? Number(event.entryFee) : null, createdAt: event.createdAt.toISOString(), clubName: null });
});

router.delete("/events/:eventId", async (req, res) => {
  const id = Number(req.params.eventId);
  await db.delete(eventsTable).where(eq(eventsTable.id, id));
  return res.status(204).send();
});

export default router;
