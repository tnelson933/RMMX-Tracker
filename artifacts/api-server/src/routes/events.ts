import { Router, type Response } from "express";
import { db } from "@workspace/db";
import { eventsTable, clubsTable, registrationsTable, ridersTable, raceResultsTable, motosTable, eventPublicationTable, discountCategoriesTable, checkinsTable, rfidAssignmentsTable, lapCrossingsTable, compCodesTable, enduroTimeChecksTable } from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { sendStatsEmail } from "../lib/email";

const router = Router();

/** Returns the staff user's club restriction, or null for organizer/admin. */
function getStaffClubId(res: Response): number | null {
  const id = res.locals.staffClubId;
  return typeof id === "number" ? id : null;
}

type EventRow = { id: number; date: string; status: string; registrationOpen: string | null; registrationClose: string | null };

function computeAutoStatus(event: EventRow): string | null {
  const now = new Date();
  const { status, registrationOpen, registrationClose } = event;

  if (status === "draft") {
    if (registrationOpen && now >= new Date(registrationOpen)) return "registration_open";
  }
  if (status === "registration_open") {
    if (registrationClose && now >= new Date(registrationClose)) return "registration_closed";
  }
  if (status === "registration_closed") {
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const eventDateStr = event.date ? String(event.date).substring(0, 10) : null;
    if (eventDateStr && eventDateStr <= todayStr) return "race_day";
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
  const { state, status } = req.query;
  // Staff users are always scoped to their own club; ignore any caller-supplied clubId.
  const staffCId = getStaffClubId(res);
  const clubId: string | undefined = staffCId !== null ? String(staffCId) : (req.query.clubId as string | undefined);

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
    raceClassSeriesMap: eventsTable.raceClassSeriesMap,
    registrationOpen: eventsTable.registrationOpen,
    registrationClose: eventsTable.registrationClose,
    status: eventsTable.status,
    paymentEnabled: eventsTable.paymentEnabled,
    requireAma: eventsTable.requireAma,
    noDuplicateBibs: eventsTable.noDuplicateBibs,
    requireClubId: eventsTable.requireClubId,
    requireWaiver: eventsTable.requireWaiver,
    requireTransponder: eventsTable.requireTransponder,
    entryFee: eventsTable.entryFee,
    earlyBirdFee: eventsTable.earlyBirdFee,
    earlyBirdEndsAt: eventsTable.earlyBirdEndsAt,
    maxRiders: eventsTable.maxRiders,
    imageUrl: eventsTable.imageUrl,
    timingTechnology: eventsTable.timingTechnology,
    transponderRentalEnabled: eventsTable.transponderRentalEnabled,
    transponderRentalFee: eventsTable.transponderRentalFee,
    rfidStickerFee: eventsTable.rfidStickerFee,
    purchaseOptions: eventsTable.purchaseOptions,
    scoringTableId: eventsTable.scoringTableId,
    entryFeeCategoryId: eventsTable.entryFeeCategoryId,
    minLapMs: eventsTable.minLapMs,
    amaEventId: eventsTable.amaEventId,
    endDate: eventsTable.endDate,
    raceStyle: eventsTable.raceStyle,
    enduroPenaltyConfig: eventsTable.enduroPenaltyConfig,
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
    earlyBirdFee: e.earlyBirdFee ? Number(e.earlyBirdFee) : null,
    transponderRentalFee: e.transponderRentalFee ? Number(e.transponderRentalFee) : null,
    rfidStickerFee: e.rfidStickerFee ? Number(e.rfidStickerFee) : null,
    createdAt: e.createdAt.toISOString(),
  })));
});

router.post("/events", async (req, res) => {
  const { name, date, state, location, trackName, raceClasses, raceClassLimits, raceClassSeriesMap, registrationOpen, registrationClose, paymentEnabled, requireAma, entryFee, earlyBirdFee, earlyBirdEndsAt, maxRiders, timingTechnology, transponderRentalEnabled, transponderRentalFee, rfidStickerFee, purchaseOptions, scoringTableId, endDate, requireWaiver, requireTransponder, raceStyle } = req.body;
  // Staff are always scoped to their own club; ignore any caller-supplied clubId.
  const staffCId = getStaffClubId(res);
  const clubId: number = staffCId ?? Number(req.body.clubId);
  const isDraftCreate = req.body.draft === true;
  if (!clubId || !name) return res.status(400).json({ error: "clubId and name are required" });
  if (!isDraftCreate && (!date || !state)) return res.status(400).json({ error: "date and state are required for a full save" });

  // For draft saves, default date to today and state to "TBD"
  const now0 = new Date();
  const todayFallback = `${now0.getFullYear()}-${String(now0.getMonth() + 1).padStart(2, "0")}-${String(now0.getDate()).padStart(2, "0")}`;
  // Strip any time component — always store as plain YYYY-MM-DD
  const cleanDate = isDraftCreate ? (date ? String(date).substring(0, 10) : todayFallback) : String(date).substring(0, 10);
  const cleanState = isDraftCreate ? (state || "TBD") : state;
  const cleanEndDate = endDate ? String(endDate).substring(0, 10) : undefined;
  if (cleanEndDate && cleanEndDate < cleanDate) return res.status(400).json({ error: "endDate must be on or after date" });

  // Determine the correct initial status based on the registration window
  const initialStatus = isDraftCreate ? "draft" : (() => {
    const now = new Date();
    if (registrationOpen && now >= new Date(registrationOpen)) {
      if (!registrationClose || now < new Date(registrationClose)) return "registration_open";
      return "registration_closed";
    }
    return "draft";
  })();

  // Auto-assign the club's "Entry Fees" category to the entry fee
  const [entryFeeCat] = await db.select({ id: discountCategoriesTable.id })
    .from(discountCategoriesTable)
    .where(and(eq(discountCategoriesTable.clubId, clubId), eq(discountCategoriesTable.name, "Entry Fees")));

  const { amaEventId } = req.body;
  const [event] = await db.insert(eventsTable).values({
    clubId, name, date: cleanDate, state: cleanState, location, trackName,
    raceClasses: raceClasses || [],
    raceClassLimits: raceClassLimits || {},
    raceClassSeriesMap: raceClassSeriesMap || {},
    registrationOpen, registrationClose,
    status: initialStatus,
    paymentEnabled: paymentEnabled || false,
    requireAma: requireAma || false,
    requireWaiver: requireWaiver || false,
    requireTransponder: requireTransponder || false,
    entryFee: entryFee ? String(entryFee) : null,
    earlyBirdFee: earlyBirdFee ? String(earlyBirdFee) : null,
    earlyBirdEndsAt: earlyBirdEndsAt ? String(earlyBirdEndsAt).substring(0, 10) : null,
    maxRiders,
    timingTechnology: timingTechnology || "rfid",
    raceStyle: raceStyle || "motocross",
    transponderRentalEnabled: transponderRentalEnabled || false,
    transponderRentalFee: transponderRentalFee ? String(transponderRentalFee) : null,
    rfidStickerFee: rfidStickerFee ? String(rfidStickerFee) : null,
    purchaseOptions: purchaseOptions || [],
    scoringTableId: scoringTableId ?? null,
    entryFeeCategoryId: entryFeeCat?.id ?? null,
    amaEventId: amaEventId ?? null,
    endDate: cleanEndDate ?? null,
  }).returning();

  return res.status(201).json({
    ...event,
    entryFee: event.entryFee ? Number(event.entryFee) : null,
    earlyBirdFee: event.earlyBirdFee ? Number(event.earlyBirdFee) : null,
    transponderRentalFee: event.transponderRentalFee ? Number(event.transponderRentalFee) : null,
    rfidStickerFee: event.rfidStickerFee ? Number(event.rfidStickerFee) : null,
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
    raceClassSeriesMap: eventsTable.raceClassSeriesMap,
    registrationOpen: eventsTable.registrationOpen,
    registrationClose: eventsTable.registrationClose,
    status: eventsTable.status,
    paymentEnabled: eventsTable.paymentEnabled,
    requireAma: eventsTable.requireAma,
    noDuplicateBibs: eventsTable.noDuplicateBibs,
    requireClubId: eventsTable.requireClubId,
    requireWaiver: eventsTable.requireWaiver,
    requireTransponder: eventsTable.requireTransponder,
    entryFee: eventsTable.entryFee,
    earlyBirdFee: eventsTable.earlyBirdFee,
    earlyBirdEndsAt: eventsTable.earlyBirdEndsAt,
    maxRiders: eventsTable.maxRiders,
    imageUrl: eventsTable.imageUrl,
    timingTechnology: eventsTable.timingTechnology,
    transponderRentalEnabled: eventsTable.transponderRentalEnabled,
    transponderRentalFee: eventsTable.transponderRentalFee,
    rfidStickerFee: eventsTable.rfidStickerFee,
    purchaseOptions: eventsTable.purchaseOptions,
    scoringTableId: eventsTable.scoringTableId,
    entryFeeCategoryId: eventsTable.entryFeeCategoryId,
    minLapMs: eventsTable.minLapMs,
    amaEventId: eventsTable.amaEventId,
    endDate: eventsTable.endDate,
    raceStyle: eventsTable.raceStyle,
    enduroPenaltyConfig: eventsTable.enduroPenaltyConfig,
    createdAt: eventsTable.createdAt,
    clubName: clubsTable.name,
    clubLogoUrl: clubsTable.logoUrl,
  }).from(eventsTable).leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id)).where(eq(eventsTable.id, id));

  if (!events[0]) return res.status(404).json({ error: "Not found" });
  const staffCId = getStaffClubId(res);
  if (staffCId !== null && events[0].clubId !== staffCId) return res.status(403).json({ error: "Forbidden" });
  const advanced = await advanceStatuses(events);
  const e = events[0];

  // For enduro events, expose per-class start times from time-check targets (public info).
  let classStartTimes: Record<string, string | null> = {};
  if (e.raceStyle === "enduro") {
    const timeChecks = await db
      .select({ targets: enduroTimeChecksTable.targets })
      .from(enduroTimeChecksTable)
      .where(eq(enduroTimeChecksTable.eventId, id));
    for (const tc of timeChecks) {
      for (const target of (tc.targets ?? [])) {
        if (target.startTimeOfDay != null) {
          classStartTimes[target.raceClass] = target.startTimeOfDay;
        }
      }
    }
  }

  return res.json({
    ...e,
    classStartTimes,
    status: advanced.get(e.id) ?? e.status,
    entryFee: e.entryFee ? Number(e.entryFee) : null,
    earlyBirdFee: e.earlyBirdFee ? Number(e.earlyBirdFee) : null,
    transponderRentalFee: e.transponderRentalFee ? Number(e.transponderRentalFee) : null,
    rfidStickerFee: e.rfidStickerFee ? Number(e.rfidStickerFee) : null,
    createdAt: e.createdAt.toISOString(),
  });
});

router.patch("/events/:eventId", async (req, res) => {
  const id = Number(req.params.eventId);

  // Capture previous status before update; also check club ownership for staff.
  const [before] = await db.select({ status: eventsTable.status, clubId: eventsTable.clubId, date: eventsTable.date }).from(eventsTable).where(eq(eventsTable.id, id));
  const previousStatus = before?.status;
  const staffCId = getStaffClubId(res);
  if (staffCId !== null) {
    if (!before || before.clubId !== staffCId) return res.status(403).json({ error: "Forbidden" });
  }

  const patchDate = req.body.date ?? before?.date;
  if (req.body.endDate && patchDate && req.body.endDate < patchDate) {
    return res.status(400).json({ error: "endDate must be on or after date" });
  }

  const updates: Record<string, unknown> = {};
  const fields = ["name", "date", "state", "location", "trackName", "raceClasses", "raceClassLimits", "raceClassSeriesMap", "raceClassDetails", "registrationOpen", "registrationClose", "status", "paymentEnabled", "requireAma", "noDuplicateBibs", "requireClubId", "requireWaiver", "requireTransponder", "earlyBirdEndsAt", "maxRiders", "imageUrl", "timingTechnology", "transponderRentalEnabled", "purchaseOptions", "scoringTableId", "entryFeeCategoryId", "minLapMs", "amaEventId", "defaultGateConfigId", "endDate", "raceStyle", "enduroPenaltyConfig", "classOrder", "contingencyBrands"];
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  // Always store date fields as plain YYYY-MM-DD — strip any time component that
  // may arrive from a datetime-local input or ISO timestamp (e.g. "2026-06-23T18:00:00.000Z").
  if (typeof updates.date === "string") updates.date = updates.date.substring(0, 10);
  if (typeof updates.endDate === "string") updates.endDate = updates.endDate.substring(0, 10);
  if (req.body.entryFee !== undefined) updates.entryFee = req.body.entryFee ? String(req.body.entryFee) : null;
  if (req.body.earlyBirdFee !== undefined) updates.earlyBirdFee = req.body.earlyBirdFee ? String(req.body.earlyBirdFee) : null;
  if (req.body.transponderRentalFee !== undefined) updates.transponderRentalFee = req.body.transponderRentalFee ? String(req.body.transponderRentalFee) : null;
  if (req.body.rfidStickerFee !== undefined) updates.rfidStickerFee = req.body.rfidStickerFee ? String(req.body.rfidStickerFee) : null;

  const [event] = await db.update(eventsTable).set(updates as any).where(eq(eventsTable.id, id)).returning();
  if (!event) return res.status(404).json({ error: "Not found" });

  // Recompute status from the updated registration window (bidirectional)
  const nextStatus = computeCorrectStatus({
    id: event.id,
    date: event.date,
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

  return res.json({ ...event, entryFee: event.entryFee ? Number(event.entryFee) : null, earlyBirdFee: event.earlyBirdFee ? Number(event.earlyBirdFee) : null, rfidStickerFee: event.rfidStickerFee ? Number(event.rfidStickerFee) : null, createdAt: event.createdAt.toISOString(), clubName: null });
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
  const staffCId = getStaffClubId(res);
  if (staffCId !== null) {
    const [ev] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, id));
    if (!ev || ev.clubId !== staffCId) return res.status(403).json({ error: "Forbidden" });
  }
  await db.transaction(async (tx) => {
    // Delete deepest dependents first to satisfy FK constraints
    await tx.delete(raceResultsTable).where(eq(raceResultsTable.eventId, id));
    await tx.delete(lapCrossingsTable).where(eq(lapCrossingsTable.eventId, id));
    await tx.delete(motosTable).where(eq(motosTable.eventId, id));
    await tx.delete(checkinsTable).where(eq(checkinsTable.eventId, id));
    await tx.delete(registrationsTable).where(eq(registrationsTable.eventId, id));
    await tx.delete(rfidAssignmentsTable).where(eq(rfidAssignmentsTable.eventId, id));
    await tx.delete(compCodesTable).where(eq(compCodesTable.eventId, id));
    await tx.delete(eventPublicationTable).where(eq(eventPublicationTable.eventId, id));
    await tx.delete(eventsTable).where(eq(eventsTable.id, id));
  });
  return res.status(204).send();
});

// ── Completed events with unpublished results (>24h after race day) ────────────
router.get("/clubs/:clubId/unpublished-completed-events", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = Number(req.params.clubId);

  // Staff can only query their own club's unpublished events
  const staffCId = getStaffClubId(res);
  if (staffCId !== null && clubId !== staffCId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const completedEvents = await db
    .select({
      id: eventsTable.id,
      name: eventsTable.name,
      date: eventsTable.date,
      location: eventsTable.location,
      trackName: eventsTable.trackName,
      state: eventsTable.state,
    })
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.clubId, clubId),
        eq(eventsTable.status, "completed"),
        sql`${eventsTable.date} < ${cutoff.toISOString()}`,
      )
    );

  if (completedEvents.length === 0) return res.json([]);

  const eventIds = completedEvents.map(e => e.id);
  const published = await db
    .select({ eventId: eventPublicationTable.eventId })
    .from(eventPublicationTable)
    .where(
      and(
        inArray(eventPublicationTable.eventId, eventIds),
        eq(eventPublicationTable.published, true),
      )
    );

  const publishedSet = new Set(published.map(p => p.eventId));
  const unpublished = completedEvents.filter(e => !publishedSet.has(e.id));

  return res.json(unpublished.map(e => ({
    ...e,
    date: typeof e.date === "string" ? e.date : (e.date as Date).toISOString(),
  })));
});

export default router;
