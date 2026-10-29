import { checkOneOf } from "../lib/validateInput";
import { Router } from "express";
import { db } from "@workspace/db";
import {
  practiceSessionsTable,
  practiceCrossingsTable,
  rfidAssignmentsTable,
  ridersTable,
  eventsTable,
  usersTable,
  clubSettingsTable,
  registrationsTable,
  riderAccountsTable,
  riderMobileTokensTable,
} from "@workspace/db";
import { eq, and, desc, asc, ilike, or, inArray, ne, isNull, gt } from "drizzle-orm";
import { managedRiderIds } from "../lib/riderAccess";
import type { Response } from "express";
import { sendConnectorCommand } from "../lib/connectorRelay";
import { authorizeIngest } from "../lib/ingestAuth";
import { listPracticeSplits, practiceSectors } from "../lib/practiceSplits";
import { practiceCourseFor, resolveTrackId } from "../lib/trackCourse";
import {
  canonicalizeCrossingTimestamp,
  isTrustedDirectActiveTimingSource,
  parseTrustworthyReceivedAt,
} from "../lib/crossingTimestamp";

type CallerInfo = { clubId: number | null; isSuperAdmin: boolean };

async function getCallerInfo(req: any): Promise<CallerInfo> {
  const userId = (req.session as any).userId;
  if (!userId) return { clubId: null, isSuperAdmin: false };
  const [user] = await db
    .select({ clubId: usersTable.clubId, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return {
    clubId: user?.clubId ?? null,
    isSuperAdmin: user?.role === "super_admin",
  };
}

// Legacy shim used by routes that only need clubId
async function getClubId(req: any): Promise<number | null> {
  return (await getCallerInfo(req)).clubId;
}

const router = Router();

const practiceSSEClients = new Map<number, Set<Response>>();
// Rider-account viewers only receive the rows of riders they own or manage.
const practiceClientRiderFilter = new WeakMap<Response, Set<number>>();

function boardForClient(res: Response, riders: PracticeRiderRow[]): PracticeRiderRow[] {
  const allowed = practiceClientRiderFilter.get(res);
  return allowed ? riders.filter(r => r.riderId != null && allowed.has(r.riderId)) : riders;
}

/** Rider account behind this request (web session or mobile Bearer token), without touching the session. */
async function requestRiderAccount(req: any): Promise<{ id: number; email: string } | null> {
  let accountId = (req.session as any)?.riderAccountId as number | undefined;
  const auth = (req.headers.authorization ?? "") as string;
  if (auth.startsWith("Bearer ")) {
    const [tok] = await db.select({ riderAccountId: riderMobileTokensTable.riderAccountId })
      .from(riderMobileTokensTable).where(eq(riderMobileTokensTable.token, auth.slice(7).trim()));
    accountId = tok?.riderAccountId;
  }
  if (!accountId) return null;
  const [account] = await db.select({ id: riderAccountsTable.id, email: riderAccountsTable.email })
    .from(riderAccountsTable).where(eq(riderAccountsTable.id, accountId));
  return account ?? null;
}

type PracticeRiderRow = {
  rfidNumber: string;
  riderId: number | null;
  riderName: string | null;
  bibNumber: string | null;
  lapCount: number;
  bestLapMs: number | null;
  lastLapMs: number | null;
  lastCrossingTime: string;
  laps: { lapNumber: number; lapTimeMs: number | null; crossingTime: string }[];
  /** Sector times per timed lap, when the practice's track has split readers. */
  sectorLaps?: Array<{ lapNumber: number; sectorsMs: Array<number | null>; complete: boolean }>;
  bestSectors?: Array<number | null>;
};

type BoardPayload = { session: object; riders: PracticeRiderRow[]; sectorNames: string[] };

/** The live board with sector times (when the track's course has splits). */
async function boardFor(
  session: typeof practiceSessionsTable.$inferSelect,
  crossings: (typeof practiceCrossingsTable.$inferSelect)[],
): Promise<BoardPayload> {
  const riders = buildLiveBoard(crossings);
  const splits = session.course?.splits.length ? await listPracticeSplits(session.id) : [];
  const sectors = practiceSectors(session.course, crossings, splits);
  if (sectors) {
    for (const row of riders) {
      const mine = sectors.byTag.get(row.rfidNumber.toLowerCase());
      if (mine) { row.sectorLaps = mine.laps; row.bestSectors = mine.best; }
    }
  }
  return { session: toJson(session), riders, sectorNames: sectors?.names ?? [] };
}

/** Push the current board to everyone watching the session. */
export async function broadcastPracticeBoard(sessionId: number): Promise<void> {
  if (!practiceSSEClients.get(sessionId)?.size) return;
  const [session] = await db.select().from(practiceSessionsTable).where(eq(practiceSessionsTable.id, sessionId));
  if (!session) return;
  const crossings = await db.select().from(practiceCrossingsTable)
    .where(eq(practiceCrossingsTable.sessionId, sessionId))
    .orderBy(asc(practiceCrossingsTable.crossingTime));
  broadcast(sessionId, await boardFor(session, crossings));
}

function buildLiveBoard(crossings: (typeof practiceCrossingsTable.$inferSelect)[]): PracticeRiderRow[] {
  const byRfid = new Map<string, typeof crossings>();
  for (const c of crossings) {
    if (!byRfid.has(c.rfidNumber)) byRfid.set(c.rfidNumber, []);
    byRfid.get(c.rfidNumber)!.push(c);
  }

  const riders: PracticeRiderRow[] = [];
  for (const [rfidNumber, riderCrossings] of byRfid) {
    const sorted = [...riderCrossings].sort(
      (a, b) => new Date(a.crossingTime).getTime() - new Date(b.crossingTime).getTime()
    );
    const withLap = sorted.filter(
      c => c.lapNumber >= 1 && c.lapTimeMs !== null && c.lapTimeMs > 0,
    );
    const bestLapMs = withLap.length > 0 ? Math.min(...withLap.map(c => c.lapTimeMs!)) : null;
    const last = sorted[sorted.length - 1];

    riders.push({
      rfidNumber,
      riderId: last.riderId,
      riderName: last.riderName,
      bibNumber: last.bibNumber,
      // The first pass only starts the clock: count timed laps.
      lapCount: withLap.length,
      bestLapMs,
      lastLapMs: last.lapTimeMs,
      lastCrossingTime: last.crossingTime.toISOString(),
      laps: sorted.map(c => ({
        lapNumber: c.lapNumber,
        lapTimeMs: c.lapTimeMs,
        crossingTime: c.crossingTime.toISOString(),
      })),
    });
  }

  riders.sort((a, b) => {
    if (a.bestLapMs == null && b.bestLapMs == null) return 0;
    if (a.bestLapMs == null) return 1;
    if (b.bestLapMs == null) return -1;
    return a.bestLapMs - b.bestLapMs;
  });

  return riders;
}

function toJson(s: typeof practiceSessionsTable.$inferSelect) {
  return {
    ...s,
    venueName: s.venueName ?? null,
    startedAt: s.startedAt?.toISOString() ?? null,
    endedAt: s.endedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

function broadcast(sessionId: number, payload: BoardPayload) {
  const clients = practiceSSEClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const data = JSON.stringify(payload);
  for (const res of clients) {
    const body = practiceClientRiderFilter.has(res)
      ? JSON.stringify({ ...payload, riders: boardForClient(res, payload.riders) })
      : data;
    try { res.write(`data: ${body}\n\n`); } catch { /* ignore */ }
  }
}

// ── Shared crossing processor ─────────────────────────────────────────────────
export async function processPracticeCrossing(
  session: typeof practiceSessionsTable.$inferSelect,
  rfidNumber: string,
  crossingTime: Date,
) {
  crossingTime = canonicalizeCrossingTimestamp(crossingTime, new Date(), {
    source: "processPracticeCrossing",
    practiceSessionId: session.id,
  });
  const sessionId = session.id;
  const tagNumber = rfidNumber.trim();

  const [lastCrossing] = await db.select().from(practiceCrossingsTable)
    .where(and(
      eq(practiceCrossingsTable.sessionId, sessionId),
      eq(practiceCrossingsTable.rfidNumber, tagNumber),
    ))
    .orderBy(desc(practiceCrossingsTable.crossingTime))
    .limit(1);

  if (lastCrossing) {
    const elapsed = crossingTime.getTime() - new Date(lastCrossing.crossingTime).getTime();
    if (elapsed < session.debounceMs) {
      return { skipped: true, reason: "debounce" as const };
    }
  }

  // Rider lookup: rfidAssignments for events belonging to this club
  let riderId: number | null = null;
  let riderName: string | null = null;
  let bibNumber: string | null = null;

  const [assignment] = await db.select({
    riderId: rfidAssignmentsTable.riderId,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
    bibNumber: ridersTable.bibNumber,
  }).from(rfidAssignmentsTable)
    .leftJoin(ridersTable, eq(rfidAssignmentsTable.riderId, ridersTable.id))
    .leftJoin(eventsTable, eq(rfidAssignmentsTable.eventId, eventsTable.id))
    .where(and(
      ilike(rfidAssignmentsTable.rfidNumber, tagNumber),
      eq(eventsTable.clubId, session.clubId),
      // A rental counts only until its event is over.
      or(isNull(rfidAssignmentsTable.expiresAt), gt(rfidAssignmentsTable.expiresAt, new Date())),
    ))
    // A tag reused across events belongs to whoever has it now.
    .orderBy(desc(rfidAssignmentsTable.id))
    .limit(1);

  if (assignment?.riderId) {
    riderId = assignment.riderId;
    riderName = `${assignment.firstName ?? ""} ${assignment.lastName ?? ""}`.trim() || null;
    bibNumber = assignment.bibNumber ?? null;
  }

  // Active transponders may be event-specific registration values. Resolve a
  // registration from this practice club before consulting global rider profile
  // identifiers. Ordering makes duplicate class registrations (or conflicting
  // legacy values) deterministic while still deduping them to one rider.
  if (!riderId) {
    const [clubRegistration] = await db.select({
      riderId: registrationsTable.riderId,
      firstName: ridersTable.firstName,
      lastName: ridersTable.lastName,
      bibNumber: registrationsTable.bibNumber,
      riderBibNumber: ridersTable.bibNumber,
    }).from(registrationsTable)
      .leftJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
      .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
      .where(and(
        eq(eventsTable.clubId, session.clubId),
        ilike(registrationsTable.myLapsTransponderNumber, tagNumber),
        // A rental unit's number on an old registration isn't that rider's.
        eq(registrationsTable.transponderRental, false),
      ))
      .orderBy(asc(registrationsTable.id), asc(registrationsTable.riderId))
      .limit(1);

    if (clubRegistration?.riderId) {
      riderId = clubRegistration.riderId;
      riderName = `${clubRegistration.firstName ?? ""} ${clubRegistration.lastName ?? ""}`.trim() || null;
      bibNumber = clubRegistration.bibNumber ?? clubRegistration.riderBibNumber ?? null;
    }
  }

  // Fallback: permanent RFID sticker or active-transponder identifier on the
  // rider profile. F2000 values are hexadecimal and may arrive in a different
  // case than organizers entered them, so both identifiers are case-insensitive.
  if (!riderId) {
    const [directRider] = await db.select().from(ridersTable)
      .where(or(
        ilike(ridersTable.rfidNumber, tagNumber),
        ilike(ridersTable.mylapsTransponderId, tagNumber),
      ))
      .limit(1);
    if (directRider) {
      riderId = directRider.id;
      riderName = `${directRider.firstName} ${directRider.lastName}`.trim();
      bibNumber = directRider.bibNumber ?? null;
    }
  }

  // Drop unrecognized tags — don't record ambient/unknown RFID reads
  if (!riderId) {
    return { skipped: true, reason: "unknown_tag" as const };
  }

  const lapNumber = (lastCrossing?.lapNumber ?? 0) + 1;
  const lapTimeMs = lastCrossing
    ? crossingTime.getTime() - new Date(lastCrossing.crossingTime).getTime()
    : null;

  const [crossing] = await db.insert(practiceCrossingsTable).values({
    sessionId,
    rfidNumber: tagNumber,
    riderId,
    riderName,
    bibNumber,
    crossingTime,
    lapNumber,
    lapTimeMs,
  }).returning();

  const allCrossings = await db.select().from(practiceCrossingsTable)
    .where(eq(practiceCrossingsTable.sessionId, sessionId))
    .orderBy(asc(practiceCrossingsTable.crossingTime));
  broadcast(sessionId, await boardFor(session, allCrossings));

  return { crossing };
}

// POST /practice/active/crossing?clubId=N — stable endpoint for RFID and active transponder bridges.
// No session ID needed — server finds the active session for the club automatically.
// Accepts both RFID bridge format ({ rfidNumber }) and active transponder format ({ transponder, passingTime }).
router.post("/practice/active/crossing", async (req, res) => {
  const clubId = Number(req.query.clubId);
  if (!clubId || isNaN(clubId)) {
    return res.status(400).json({ error: "Something was missing from that request. Refresh the page and try again." });
  }

  // Accept both RFID bridge and active transponder payload formats.
  const body = req.body as any;
  const rfidNumber: string | undefined =
    body?.rfidNumber ?? body?.transponder ?? body?.transponderId ?? body?.id;
  if (!rfidNumber) {
    return res.status(400).json({ error: "Enter a transponder or tag number." });
  }

  // Accept hardware timestamp in any common field name
  const rawTime: string | undefined =
    body?.crossingTime ?? body?.passingTime ?? body?.timestamp ?? body?.passTime;
  const serverReceivedAt = new Date();
  const originalReceipt = parseTrustworthyReceivedAt(
    body?.receivedAtUtc ?? body?.receivedAt,
    serverReceivedAt,
  );
  const receivedAt = originalReceipt ?? serverReceivedAt;
  const crossingTime = canonicalizeCrossingTimestamp(rawTime ?? receivedAt, receivedAt, {
    source: "active_practice_ingest",
    clubId,
    deviceTimezone: body?.deviceTimezone,
    timeSource: body?.timeSource ?? body?.source,
  }, originalReceipt !== null && isTrustedDirectActiveTimingSource(body?.source, body?.timeSource));

  // Checked after the receipt time is captured so authorization never shifts it.
  if (!(await authorizeIngest(req, res, clubId, "practice_active_crossing"))) return;

  // Find the active session for this club (most recently started)
  const [session] = await db.select().from(practiceSessionsTable)
    .where(and(
      eq(practiceSessionsTable.clubId, clubId),
      eq(practiceSessionsTable.status, "active"),
    ))
    .orderBy(desc(practiceSessionsTable.id))
    .limit(1);

  if (!session) {
    return res.status(409).json({
      error: "No practice session is running. Start one on the Practice page.",
      hint: "Start a practice session in the Race Platform organizer portal first.",
    });
  }

  const result = await processPracticeCrossing(session, String(rfidNumber), crossingTime);
  if ("skipped" in result) {
    return res.status(200).json({ skipped: true, reason: result.reason });
  }

  return res.status(201).json({
    ...result.crossing,
    crossingTime: result.crossing!.crossingTime.toISOString(),
    createdAt: result.crossing!.createdAt.toISOString(),
  });
});

// GET /practice — list sessions for organizer's club (super admins see all)
router.get("/practice", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const { clubId, isSuperAdmin } = await getCallerInfo(req);
  if (!isSuperAdmin && !clubId) return res.status(403).json({ error: "Your account isn't linked to a club yet. Ask your club's owner to add you on the Team page." });

  const sessions = await db.select().from(practiceSessionsTable)
    .where(isSuperAdmin ? undefined : eq(practiceSessionsTable.clubId, clubId!))
    .orderBy(desc(practiceSessionsTable.createdAt));
  return res.json(sessions.map(toJson));
});

// GET /practice/:id
router.get("/practice/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [session] = await db.select().from(practiceSessionsTable).where(eq(practiceSessionsTable.id, id));
  if (!session) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  const callerClubId = await getClubId(req);
  if (callerClubId !== null && session.clubId !== callerClubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
  return res.json(toJson(session));
});

// POST /practice — create session
router.post("/practice", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const { clubId: callerClubId, isSuperAdmin } = await getCallerInfo(req);
  const clubId = isSuperAdmin && req.body.clubId ? Number(req.body.clubId) : callerClubId;
  if (!clubId) return res.status(403).json({ error: "Your account isn't linked to a club yet. Ask your club's owner to add you on the Team page." });

  const { name, debounceMs, venueName: venueNameOverride } = req.body;
  if (!name) return res.status(400).json({ error: "Enter a name." });
  if (!venueNameOverride?.trim()) return res.status(400).json({ error: "Enter a track name." });

  const venueName: string = venueNameOverride.trim();

  // Auto-end any previously active sessions for this club before starting a new one
  const previouslyActive = await db.select({ id: practiceSessionsTable.id })
    .from(practiceSessionsTable)
    .where(and(eq(practiceSessionsTable.clubId, clubId), eq(practiceSessionsTable.status, "active")));
  await db.update(practiceSessionsTable)
    .set({ status: "ended", endedAt: new Date() })
    .where(and(eq(practiceSessionsTable.clubId, clubId), eq(practiceSessionsTable.status, "active")));
  for (const prev of previouslyActive) {
    sendConnectorCommand(clubId, { type: "stop_moto", motoId: prev.id, eventId: null });
  }

  // The library track (picked, or matched by name) and its course right now:
  // its split readers give sector times for this session.
  const trackId = await resolveTrackId(clubId, req.body.trackId, venueName);
  const course = await practiceCourseFor(trackId);

  const [session] = await db.insert(practiceSessionsTable).values({
    clubId,
    name,
    trackId,
    course,
    status: "active",
    startedAt: new Date(),
    debounceMs: Number.isInteger(Number(debounceMs)) && Number(debounceMs) >= 0 && Number(debounceMs) <= 600_000 && debounceMs !== undefined && debounceMs !== null && debounceMs !== ""
      ? Number(debounceMs) : 10000,
    venueName,
  }).returning();

  // Tell any connected RM Connect apps to start the reader
  sendConnectorCommand(clubId, {
    type: "start_moto",
    motoId: session.id,
    motoName: name,
    motoType: "practice",
    eventId: null,
  });

  return res.status(201).json(toJson(session));
});

// PATCH /practice/:id — start / end / rename
router.patch("/practice/:id", async (req, res) => {
  const id = Number(req.params.id);
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const { clubId, isSuperAdmin } = await getCallerInfo(req);

  const [existing] = await db.select().from(practiceSessionsTable).where(eq(practiceSessionsTable.id, id));
  if (!existing) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  if (!isSuperAdmin && existing.clubId !== clubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });

  const updates: Record<string, unknown> = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.venueName !== undefined) {
    const venueName = String(req.body.venueName).trim();
    if (!venueName) return res.status(400).json({ error: "Enter a track name." });
    updates.venueName = venueName;
  }
  if (req.body.debounceMs !== undefined) {
    const debounceMs = Number(req.body.debounceMs);
    if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > 600_000) {
      return res.status(400).json({ error: "Enter a minimum lap time between 0 and 600 seconds." });
    }
    updates.debounceMs = debounceMs;
  }
  if (req.body.status !== undefined) {
    const invalidStatus = checkOneOf(req.body, "status", ["idle", "active", "ended"]);
    if (invalidStatus) return res.status(400).json({ error: invalidStatus });
    updates.status = req.body.status;
    // Resuming an ended session starts it fresh so it outranks older motos.
    if (req.body.status === "active" && existing.status !== "active") updates.startedAt = new Date();
    if (req.body.status === "ended") updates.endedAt = new Date();
  }

  // Nothing to change: answer with the session as it is instead of an empty UPDATE.
  if (Object.keys(updates).length === 0) return res.json(toJson(existing));

  // One live practice per club: reads go to the newest, so end the others.
  if (req.body.status === "active" && existing.status !== "active") {
    const others = await db.update(practiceSessionsTable)
      .set({ status: "ended", endedAt: new Date() })
      .where(and(
        eq(practiceSessionsTable.clubId, existing.clubId),
        eq(practiceSessionsTable.status, "active"),
        ne(practiceSessionsTable.id, id),
      ))
      .returning({ id: practiceSessionsTable.id });
    for (const prev of others) {
      sendConnectorCommand(existing.clubId, { type: "stop_moto", motoId: prev.id, eventId: null });
    }
  }

  const [session] = await db.update(practiceSessionsTable)
    .set(updates as any)
    .where(eq(practiceSessionsTable.id, id))
    .returning();

  const crossings = await db.select().from(practiceCrossingsTable)
    .where(eq(practiceCrossingsTable.sessionId, id))
    .orderBy(asc(practiceCrossingsTable.crossingTime));
  broadcast(id, await boardFor(session, crossings));

  // Keep RM Connect in sync with practice session lifecycle
  const effectiveClubId = session.clubId ?? existing.clubId;
  if (req.body.status === "active") {
    sendConnectorCommand(effectiveClubId, {
      type: "start_moto",
      motoId: session.id,
      motoName: session.name,
      motoType: "practice",
      eventId: null,
    });
  } else if (req.body.status === "ended") {
    sendConnectorCommand(effectiveClubId, {
      type: "stop_moto",
      motoId: session.id,
      eventId: null,
    });
  }

  return res.json(toJson(session));
});

// DELETE /practice/:id
router.delete("/practice/:id", async (req, res) => {
  const id = Number(req.params.id);
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const { clubId, isSuperAdmin } = await getCallerInfo(req);

  const [existing] = await db.select().from(practiceSessionsTable).where(eq(practiceSessionsTable.id, id));
  if (!existing) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  if (!isSuperAdmin && existing.clubId !== clubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });

  await db.delete(practiceCrossingsTable).where(eq(practiceCrossingsTable.sessionId, id));
  await db.delete(practiceSessionsTable).where(eq(practiceSessionsTable.id, id));
  return res.status(204).send();
});

// GET /practice/:id/crossings
router.get("/practice/:id/crossings", async (req, res) => {
  const id = Number(req.params.id);
  const [session] = await db.select().from(practiceSessionsTable).where(eq(practiceSessionsTable.id, id));
  if (!session) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  const callerClubId = await getClubId(req);
  if (callerClubId !== null && session.clubId !== callerClubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
  const crossings = await db.select().from(practiceCrossingsTable)
    .where(eq(practiceCrossingsTable.sessionId, id))
    .orderBy(asc(practiceCrossingsTable.crossingTime));
  return res.json(crossings.map(c => ({
    ...c,
    crossingTime: c.crossingTime.toISOString(),
    createdAt: c.createdAt.toISOString(),
  })));
});

// POST /practice/:id/crossing — record a crossing by explicit session ID
router.post("/practice/:id/crossing", async (req, res) => {
  const sessionId = Number(req.params.id);
  const body = req.body as any;
  const rfidNumber: string | undefined =
    body?.rfidNumber ?? body?.transponder ?? body?.transponderId;
  if (!rfidNumber) return res.status(400).json({ error: "Enter a transponder or tag number." });

  const [session] = await db.select().from(practiceSessionsTable).where(eq(practiceSessionsTable.id, sessionId));
  if (!session) return res.status(404).json({ error: "This session couldn't be found. It may have been deleted. Refresh the page and try again." });
  const callerClubId = await getClubId(req);
  if (callerClubId !== null && session.clubId !== callerClubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
  // Same reader check as the club's other ingest routes: no anonymous laps.
  if (callerClubId === null && !(await authorizeIngest(req, res, session.clubId, "practice_session_crossing"))) return;
  if (session.status !== "active") return res.status(409).json({ error: "This payment session has ended. Start the payment again." });

  const rawTime: string | undefined =
    body?.crossingTime ?? body?.passingTime ?? body?.timestamp;
  const receivedAt = new Date();
  const crossingTime = canonicalizeCrossingTimestamp(rawTime ?? receivedAt, receivedAt, {
    source: "practice_session_ingest",
    practiceSessionId: sessionId,
  });

  const result = await processPracticeCrossing(session, String(rfidNumber), crossingTime);
  if ("skipped" in result) {
    return res.status(200).json({ skipped: true, reason: result.reason });
  }

  return res.status(201).json({
    ...result.crossing,
    crossingTime: result.crossing!.crossingTime.toISOString(),
    createdAt: result.crossing!.createdAt.toISOString(),
  });
});

// GET /practice/:id/live — SSE
router.get("/practice/:id/live", async (req, res) => {
  const sessionId = Number(req.params.id);
  // Anonymous callers get 401 before the lookup, so session ids can't be probed.
  const hasCredentials = !!(req.session as any)?.userId || !!(req.session as any)?.riderAccountId
    || String(req.headers.authorization ?? "").startsWith("Bearer ");
  if (!hasCredentials) { res.status(401).json({ error: "You're signed out. Sign in again, then try once more." }); return; }

  const [session] = await db.select().from(practiceSessionsTable).where(eq(practiceSessionsTable.id, sessionId));
  if (!session) { res.status(404).json({ error: "This session couldn't be found. It may have been deleted. Refresh the page and try again." }); return; }

  // This route is public in accessControl so riders can watch; authorize here.
  // Organizers/super admins see the whole board for their club's sessions; staff
  // need the practice permission (as the staff rules required before).
  let organizerAllowed = false;
  let deniedStatus = 401;
  const userId = (req.session as any)?.userId as number | undefined;
  if (userId) {
    const [user] = await db
      .select({ role: usersTable.role, clubId: usersTable.clubId, permissions: usersTable.permissions })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    if (user) {
      const sameClub = user.role === "super_admin" || (user.clubId != null && user.clubId === session.clubId);
      const staffOk = user.role !== "staff" || (user.permissions ?? []).includes("practice");
      organizerAllowed = sameClub && staffOk;
      if (!organizerAllowed) deniedStatus = 403;
    }
  }

  // Rider accounts may watch a session one of their own/managed riders rode in,
  // and only receive those riders' rows.
  let riderFilter: Set<number> | null = null;
  if (!organizerAllowed) {
    const account = await requestRiderAccount(req);
    if (account) {
      const ids = await managedRiderIds(account);
      const [rode] = ids.length
        ? await db.select({ id: practiceCrossingsTable.id }).from(practiceCrossingsTable)
          .where(and(eq(practiceCrossingsTable.sessionId, sessionId), inArray(practiceCrossingsTable.riderId, ids)))
          .limit(1)
        : [];
      if (rode) riderFilter = new Set(ids);
      else deniedStatus = 403;
    }
    if (!riderFilter) {
      res.status(deniedStatus).json({ error: deniedStatus === 401 ? "You're signed out. Sign in again, then try once more." : "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
      return;
    }
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  if (!practiceSSEClients.has(sessionId)) practiceSSEClients.set(sessionId, new Set());
  practiceSSEClients.get(sessionId)!.add(res);
  if (riderFilter) practiceClientRiderFilter.set(res, riderFilter);

  const crossings = await db.select().from(practiceCrossingsTable)
    .where(eq(practiceCrossingsTable.sessionId, sessionId))
    .orderBy(asc(practiceCrossingsTable.crossingTime));
  const board = await boardFor(session, crossings);
  res.write(`data: ${JSON.stringify({ ...board, riders: boardForClient(res, board.riders) })}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { /* ignore */ }
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    practiceSSEClients.get(sessionId)?.delete(res);
    if (practiceSSEClients.get(sessionId)?.size === 0) practiceSSEClients.delete(sessionId);
  });
});

export default router;
