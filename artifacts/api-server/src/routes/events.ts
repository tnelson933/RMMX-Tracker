import { Router } from "express";
import { db } from "@workspace/db";
import { eventsTable, clubsTable, registrationsTable, ridersTable, raceResultsTable, motosTable } from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { sendStatsEmail } from "../lib/email";

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

// Recompute the correct status from scratch based on the registration window.
// Only applies to auto-managed statuses; race_day and completed are left alone.
function computeCorrectStatus(event: EventRow): string | null {
  const { status, registrationOpen, registrationClose } = event;
  if (!["draft", "registration_open", "registration_closed"].includes(status)) return null;

  const now = new Date();
  let correct: string;
  if (registrationOpen && now >= new Date(registrationOpen)) {
    if (!registrationClose || now < new Date(registrationClose)) {
      correct = "registration_open";
    } else {
      correct = "registration_closed";
    }
  } else {
    correct = "draft";
  }

  return correct !== status ? correct : null;
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
    imageUrl: eventsTable.imageUrl,
    timingTechnology: eventsTable.timingTechnology,
    transponderRentalEnabled: eventsTable.transponderRentalEnabled,
    transponderRentalFee: eventsTable.transponderRentalFee,
    purchaseOptions: eventsTable.purchaseOptions,
    createdAt: eventsTable.createdAt,
    clubName: clubsTable.name,
    clubLogoUrl: clubsTable.logoUrl,
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
    transponderRentalFee: e.transponderRentalFee ? Number(e.transponderRentalFee) : null,
    createdAt: e.createdAt.toISOString(),
  })));
});

router.post("/events", async (req, res) => {
  const { clubId, name, date, state, location, trackName, raceClasses, raceClassLimits, registrationOpen, registrationClose, paymentEnabled, requireAma, entryFee, maxRiders, timingTechnology, transponderRentalEnabled, transponderRentalFee, purchaseOptions } = req.body;
  if (!clubId || !name || !date || !state) return res.status(400).json({ error: "clubId, name, date, state required" });

  // Determine the correct initial status based on the registration window
  const initialStatus = (() => {
    const now = new Date();
    if (registrationOpen && now >= new Date(registrationOpen)) {
      if (!registrationClose || now < new Date(registrationClose)) return "registration_open";
      return "registration_closed";
    }
    return "draft";
  })();

  const [event] = await db.insert(eventsTable).values({
    clubId, name, date, state, location, trackName,
    raceClasses: raceClasses || [],
    raceClassLimits: raceClassLimits || {},
    registrationOpen, registrationClose,
    status: initialStatus,
    paymentEnabled: paymentEnabled || false,
    requireAma: requireAma || false,
    entryFee: entryFee ? String(entryFee) : null,
    maxRiders,
    timingTechnology: timingTechnology || "rfid",
    transponderRentalEnabled: transponderRentalEnabled || false,
    transponderRentalFee: transponderRentalFee ? String(transponderRentalFee) : null,
    purchaseOptions: purchaseOptions || [],
  }).returning();

  return res.status(201).json({
    ...event,
    entryFee: event.entryFee ? Number(event.entryFee) : null,
    transponderRentalFee: event.transponderRentalFee ? Number(event.transponderRentalFee) : null,
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
    imageUrl: eventsTable.imageUrl,
    timingTechnology: eventsTable.timingTechnology,
    transponderRentalEnabled: eventsTable.transponderRentalEnabled,
    transponderRentalFee: eventsTable.transponderRentalFee,
    purchaseOptions: eventsTable.purchaseOptions,
    createdAt: eventsTable.createdAt,
    clubName: clubsTable.name,
    clubLogoUrl: clubsTable.logoUrl,
  }).from(eventsTable).leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id)).where(eq(eventsTable.id, id));

  if (!events[0]) return res.status(404).json({ error: "Not found" });
  const advanced = await advanceStatuses(events);
  const e = events[0];
  return res.json({
    ...e,
    status: advanced.get(e.id) ?? e.status,
    entryFee: e.entryFee ? Number(e.entryFee) : null,
    transponderRentalFee: e.transponderRentalFee ? Number(e.transponderRentalFee) : null,
    createdAt: e.createdAt.toISOString(),
  });
});

router.patch("/events/:eventId", async (req, res) => {
  const id = Number(req.params.eventId);

  // Capture previous status before update
  const [before] = await db.select({ status: eventsTable.status }).from(eventsTable).where(eq(eventsTable.id, id));
  const previousStatus = before?.status;

  const updates: Record<string, unknown> = {};
  const fields = ["name", "date", "state", "location", "trackName", "raceClasses", "raceClassLimits", "registrationOpen", "registrationClose", "status", "paymentEnabled", "requireAma", "noDuplicateBibs", "maxRiders", "imageUrl", "timingTechnology", "transponderRentalEnabled", "purchaseOptions"];
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  if (req.body.entryFee !== undefined) updates.entryFee = req.body.entryFee ? String(req.body.entryFee) : null;
  if (req.body.transponderRentalFee !== undefined) updates.transponderRentalFee = req.body.transponderRentalFee ? String(req.body.transponderRentalFee) : null;

  const [event] = await db.update(eventsTable).set(updates as any).where(eq(eventsTable.id, id)).returning();
  if (!event) return res.status(404).json({ error: "Not found" });

  // Recompute status from the updated registration window (bidirectional)
  const nextStatus = computeCorrectStatus({
    id: event.id,
    status: event.status,
    registrationOpen: event.registrationOpen,
    registrationClose: event.registrationClose,
  });
  if (nextStatus) {
    await db.update(eventsTable).set({ status: nextStatus }).where(eq(eventsTable.id, id));
    event.status = nextStatus;
  }

  // Fire stats emails when an event transitions to completed for the first time
  if (event.status === "completed" && previousStatus !== "completed") {
    fireStatsEmails(event.id, event.name, event.date).catch(err =>
      req.log?.error({ err: err?.message }, "[stats-email] Failed to send stats emails")
    );
  }

  return res.json({ ...event, entryFee: event.entryFee ? Number(event.entryFee) : null, createdAt: event.createdAt.toISOString(), clubName: null });
});

async function fireStatsEmails(eventId: number, eventName: string, eventDate: string): Promise<void> {
  const domains = process.env.REPLIT_DOMAINS;
  const appUrl = process.env.APP_URL ?? (domains ? `https://${domains.split(",")[0]}` : "http://localhost:80");
  const resultsUrl = `${appUrl}/results/${eventId}`;

  // Find all opted-in confirmed registrations for this event
  const optedIn = await db.select({
    riderId: registrationsTable.riderId,
    email: ridersTable.email,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(registrationsTable)
    .leftJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(and(
      eq(registrationsTable.eventId, eventId),
      eq(registrationsTable.statsEmailOptIn, true),
      eq(registrationsTable.status, "confirmed"),
    ));

  // Deduplicate by riderId (rider may have multiple class registrations)
  const unique = new Map<number, { email: string; firstName: string; lastName: string }>();
  for (const row of optedIn) {
    if (row.riderId && row.email && !unique.has(row.riderId)) {
      unique.set(row.riderId, { email: row.email, firstName: row.firstName ?? "", lastName: row.lastName ?? "" });
    }
  }

  if (unique.size === 0) return;

  // Fetch all results for this event (joined with moto names)
  const allResults = await db.select({
    riderId: raceResultsTable.riderId,
    motoName: motosTable.name,
    raceClass: raceResultsTable.raceClass,
    position: raceResultsTable.position,
    totalTime: raceResultsTable.totalTime,
    lapTimes: raceResultsTable.lapTimes,
    points: raceResultsTable.points,
    dnf: raceResultsTable.dnf,
    dns: raceResultsTable.dns,
  }).from(raceResultsTable)
    .leftJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .where(eq(raceResultsTable.eventId, eventId));

  const formattedDate = new Date(eventDate).toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  for (const [riderId, rider] of unique) {
    const riderResults = allResults
      .filter(r => r.riderId === riderId)
      .map(r => ({
        motoName: r.motoName ?? "",
        raceClass: r.raceClass,
        position: r.position,
        totalTime: r.totalTime,
        lapTimes: Array.isArray(r.lapTimes) ? (r.lapTimes as string[]) : [],
        points: r.points,
        dnf: r.dnf,
        dns: r.dns,
      }));

    await sendStatsEmail({
      to: rider.email,
      riderName: `${rider.firstName} ${rider.lastName}`,
      eventName,
      eventDate: formattedDate,
      results: riderResults,
      resultsUrl,
    });
  }
}

router.delete("/events/:eventId", async (req, res) => {
  const id = Number(req.params.eventId);
  await db.delete(eventsTable).where(eq(eventsTable.id, id));
  return res.status(204).send();
});

export default router;
