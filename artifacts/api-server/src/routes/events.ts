import { Router } from "express";
import { db } from "@workspace/db";
import { eventsTable, clubsTable } from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";

const router = Router();

type EventRow = { id: number; status: string; registrationOpen: string | null; registrationClose: string | null };

function computeAutoStatus(event: EventRow): string | null {
  const now = new Date();
  const { status, registrationOpen, registrationClose } = event;

  if (status === "draft") {
    if (registrationOpen && now >= new Date(registrationOpen)) return "registration_open";
  }
  if (status === "registration_open") {
    if (registrationClose && now >= new Date(registrationClose)) return "registration_closed";
  }
  return null;
}

async function advanceStatuses(events: EventRow[]): Promise<Map<number, string>> {
  const updates = new Map<number, string>();
  for (const e of events) {
    const next = computeAutoStatus(e);
    if (next) updates.set(e.id, next);
  }
  if (updates.size > 0) {
    const ids = [...updates.keys()];
    await Promise.all(
      ids.map((id) =>
        db.update(eventsTable).set({ status: updates.get(id)! }).where(eq(eventsTable.id, id))
      )
    );
  }
  return updates;
}

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

  const advanced = await advanceStatuses(events);
  return res.json(events.map(e => ({
    ...e,
    status: advanced.get(e.id) ?? e.status,
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
  const advanced = await advanceStatuses(events);
  const e = events[0];
  return res.json({
    ...e,
    status: advanced.get(e.id) ?? e.status,
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
