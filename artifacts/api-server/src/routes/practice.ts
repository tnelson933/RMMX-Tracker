import { Router } from "express";
import { db } from "@workspace/db";
import {
  practiceSessionsTable,
  practiceCrossingsTable,
  rfidAssignmentsTable,
  ridersTable,
  eventsTable,
  usersTable,
} from "@workspace/db";
import { eq, and, desc, asc } from "drizzle-orm";
import type { Response } from "express";

async function getClubId(req: any): Promise<number | null> {
  const userId = (req.session as any).userId;
  if (!userId) return null;
  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  return user?.clubId ?? null;
}

const router = Router();

const practiceSSEClients = new Map<number, Set<Response>>();

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
};

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
    const withLap = sorted.filter(c => c.lapTimeMs !== null);
    const bestLapMs = withLap.length > 0 ? Math.min(...withLap.map(c => c.lapTimeMs!)) : null;
    const last = sorted[sorted.length - 1];

    riders.push({
      rfidNumber,
      riderId: last.riderId,
      riderName: last.riderName,
      bibNumber: last.bibNumber,
      lapCount: sorted.length,
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
    if (b.lapCount !== a.lapCount) return b.lapCount - a.lapCount;
    return new Date(a.lastCrossingTime).getTime() - new Date(b.lastCrossingTime).getTime();
  });

  return riders;
}

function toJson(s: typeof practiceSessionsTable.$inferSelect) {
  return {
    ...s,
    startedAt: s.startedAt?.toISOString() ?? null,
    endedAt: s.endedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

function broadcast(sessionId: number, payload: object) {
  const clients = practiceSSEClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const data = JSON.stringify(payload);
  for (const res of clients) {
    try { res.write(`data: ${data}\n\n`); } catch { /* ignore */ }
  }
}

// ── Shared crossing processor ─────────────────────────────────────────────────
export async function processPracticeCrossing(
  session: typeof practiceSessionsTable.$inferSelect,
  rfidNumber: string,
  crossingTime: Date,
) {
  const sessionId = session.id;

  const [lastCrossing] = await db.select().from(practiceCrossingsTable)
    .where(and(
      eq(practiceCrossingsTable.sessionId, sessionId),
      eq(practiceCrossingsTable.rfidNumber, rfidNumber),
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
      eq(rfidAssignmentsTable.rfidNumber, rfidNumber),
      eq(eventsTable.clubId, session.clubId),
    ))
    .limit(1);

  if (assignment?.riderId) {
    riderId = assignment.riderId;
    riderName = `${assignment.firstName ?? ""} ${assignment.lastName ?? ""}`.trim() || null;
    bibNumber = assignment.bibNumber ?? null;
  }

  // Fallback: permanent rfidNumber on rider profile
  if (!riderId) {
    const [directRider] = await db.select().from(ridersTable)
      .where(eq(ridersTable.rfidNumber, rfidNumber))
      .limit(1);
    if (directRider) {
      riderId = directRider.id;
      riderName = `${directRider.firstName} ${directRider.lastName}`.trim();
      bibNumber = directRider.bibNumber ?? null;
    }
  }

  const lapNumber = (lastCrossing?.lapNumber ?? 0) + 1;
  const lapTimeMs = lastCrossing
    ? crossingTime.getTime() - new Date(lastCrossing.crossingTime).getTime()
    : null;

  const [crossing] = await db.insert(practiceCrossingsTable).values({
    sessionId,
    rfidNumber,
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
  broadcast(sessionId, { session: toJson(session), riders: buildLiveBoard(allCrossings) });

  return { crossing };
}

// POST /practice/active/crossing?clubId=N — stable endpoint for bridge / MyLaps
// No session ID needed — server finds the active session for the club automatically.
// Accepts both RFID bridge format ({ rfidNumber }) and MyLaps format ({ transponder, passingTime }).
router.post("/practice/active/crossing", async (req, res) => {
  const clubId = Number(req.query.clubId);
  if (!clubId || isNaN(clubId)) {
    return res.status(400).json({ error: "clubId query param is required" });
  }

  // Accept both RFID bridge format and MyLaps/AMBrc format
  const body = req.body as any;
  const rfidNumber: string | undefined =
    body?.rfidNumber ?? body?.transponder ?? body?.transponderId ?? body?.id;
  if (!rfidNumber) {
    return res.status(400).json({ error: "rfidNumber (or transponder) is required" });
  }

  // Accept hardware timestamp in any common field name
  const rawTime: string | undefined =
    body?.crossingTime ?? body?.passingTime ?? body?.timestamp ?? body?.passTime;
  const crossingTime = rawTime ? new Date(rawTime) : new Date();
  if (isNaN(crossingTime.getTime())) {
    return res.status(400).json({ error: "Invalid crossingTime — must be ISO 8601" });
  }

  // Find the active session for this club
  const [session] = await db.select().from(practiceSessionsTable)
    .where(and(
      eq(practiceSessionsTable.clubId, clubId),
      eq(practiceSessionsTable.status, "active"),
    ))
    .limit(1);

  if (!session) {
    return res.status(409).json({
      error: "No active practice session for this club",
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

// GET /practice — list sessions for organizer's club
router.get("/practice", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const clubId = await getClubId(req);
  if (!clubId) return res.status(403).json({ error: "No club" });

  const sessions = await db.select().from(practiceSessionsTable)
    .where(eq(practiceSessionsTable.clubId, clubId))
    .orderBy(desc(practiceSessionsTable.createdAt));
  return res.json(sessions.map(toJson));
});

// GET /practice/:id
router.get("/practice/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [session] = await db.select().from(practiceSessionsTable).where(eq(practiceSessionsTable.id, id));
  if (!session) return res.status(404).json({ error: "Not found" });
  return res.json(toJson(session));
});

// POST /practice — create session
router.post("/practice", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const clubId = await getClubId(req);
  if (!clubId) return res.status(403).json({ error: "No club" });

  const { name, debounceMs } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });

  const [session] = await db.insert(practiceSessionsTable).values({
    clubId,
    name,
    status: "idle",
    debounceMs: debounceMs ? Number(debounceMs) : 30000,
  }).returning();
  return res.status(201).json(toJson(session));
});

// PATCH /practice/:id — start / end / rename
router.patch("/practice/:id", async (req, res) => {
  const id = Number(req.params.id);
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const clubId = await getClubId(req);

  const [existing] = await db.select().from(practiceSessionsTable).where(eq(practiceSessionsTable.id, id));
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (existing.clubId !== clubId) return res.status(403).json({ error: "Forbidden" });

  const updates: Record<string, unknown> = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.debounceMs !== undefined) updates.debounceMs = Number(req.body.debounceMs);
  if (req.body.status !== undefined) {
    updates.status = req.body.status;
    if (req.body.status === "active" && !existing.startedAt) updates.startedAt = new Date();
    if (req.body.status === "ended") updates.endedAt = new Date();
  }

  const [session] = await db.update(practiceSessionsTable)
    .set(updates as any)
    .where(eq(practiceSessionsTable.id, id))
    .returning();

  const crossings = await db.select().from(practiceCrossingsTable)
    .where(eq(practiceCrossingsTable.sessionId, id))
    .orderBy(asc(practiceCrossingsTable.crossingTime));
  broadcast(id, { session: toJson(session), riders: buildLiveBoard(crossings) });

  return res.json(toJson(session));
});

// DELETE /practice/:id
router.delete("/practice/:id", async (req, res) => {
  const id = Number(req.params.id);
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const clubId = await getClubId(req);

  const [existing] = await db.select().from(practiceSessionsTable).where(eq(practiceSessionsTable.id, id));
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (existing.clubId !== clubId) return res.status(403).json({ error: "Forbidden" });

  await db.delete(practiceCrossingsTable).where(eq(practiceCrossingsTable.sessionId, id));
  await db.delete(practiceSessionsTable).where(eq(practiceSessionsTable.id, id));
  return res.status(204).send();
});

// GET /practice/:id/crossings
router.get("/practice/:id/crossings", async (req, res) => {
  const id = Number(req.params.id);
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
  if (!rfidNumber) return res.status(400).json({ error: "rfidNumber required" });

  const [session] = await db.select().from(practiceSessionsTable).where(eq(practiceSessionsTable.id, sessionId));
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "active") return res.status(409).json({ error: "Session not active" });

  const rawTime: string | undefined =
    body?.crossingTime ?? body?.passingTime ?? body?.timestamp;
  const crossingTime = rawTime ? new Date(rawTime) : new Date();

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

  const [session] = await db.select().from(practiceSessionsTable).where(eq(practiceSessionsTable.id, sessionId));
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  if (!practiceSSEClients.has(sessionId)) practiceSSEClients.set(sessionId, new Set());
  practiceSSEClients.get(sessionId)!.add(res);

  const crossings = await db.select().from(practiceCrossingsTable)
    .where(eq(practiceCrossingsTable.sessionId, sessionId))
    .orderBy(asc(practiceCrossingsTable.crossingTime));
  res.write(`data: ${JSON.stringify({ session: toJson(session), riders: buildLiveBoard(crossings) })}\n\n`);

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
