import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import {
  riderAccountsTable,
  ridersTable,
  raceResultsTable,
  motosTable,
  eventsTable,
  practiceCrossingsTable,
  practiceSessionsTable,
} from "@workspace/db";
import { eq, desc, asc, or } from "drizzle-orm";

const router = Router();

function requireRiderAuth(req: any, res: any, next: any) {
  if (!(req.session as any).riderAccountId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

// POST /rider/auth/register
router.post("/rider/auth/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const normalized = String(email).toLowerCase().trim();
  const existing = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.email, normalized));
  if (existing.length > 0) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }

  const hash = await bcrypt.hash(String(password), 12);
  const [account] = await db.insert(riderAccountsTable).values({ email: normalized, passwordHash: hash }).returning();

  (req.session as any).riderAccountId = account.id;
  req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;

  return res.json({ id: account.id, email: account.email, createdAt: account.createdAt.toISOString() });
});

// POST /rider/auth/login
router.post("/rider/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  const normalized = String(email).toLowerCase().trim();
  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.email, normalized));
  if (!account) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const valid = await bcrypt.compare(String(password), account.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  (req.session as any).riderAccountId = account.id;
  req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;

  return res.json({ id: account.id, email: account.email, createdAt: account.createdAt.toISOString() });
});

// POST /rider/auth/logout
router.post("/rider/auth/logout", (req, res) => {
  (req.session as any).riderAccountId = undefined;
  res.json({ ok: true });
});

// GET /rider/auth/me
router.get("/rider/auth/me", async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  if (!riderAccountId) return res.status(401).json({ error: "Not authenticated" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  return res.json({ id: account.id, email: account.email, createdAt: account.createdAt.toISOString() });
});

// GET /rider/profiles — all rider profiles linked to this account's email
router.get("/rider/profiles", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const riders = await db.select().from(ridersTable).where(eq(ridersTable.email, account.email));

  // For each rider, compute summary stats from race results
  const profilesWithStats = await Promise.all(
    riders.map(async (rider) => {
      const results = await db
        .select({
          eventId: raceResultsTable.eventId,
          position: raceResultsTable.position,
          points: raceResultsTable.points,
          dnf: raceResultsTable.dnf,
          dns: raceResultsTable.dns,
          eventDate: eventsTable.date,
        })
        .from(raceResultsTable)
        .leftJoin(eventsTable, eq(raceResultsTable.eventId, eventsTable.id))
        .where(eq(raceResultsTable.riderId, rider.id));

      const uniqueEvents = new Set(results.map((r) => r.eventId));
      const finishes = results.filter((r) => !r.dnf && !r.dns);
      const totalPoints = finishes.reduce((s, r) => s + (r.points ?? 0), 0);
      const bestPosition = finishes.length > 0 ? Math.min(...finishes.map((r) => r.position)) : null;
      const dates = results.map((r) => r.eventDate).filter(Boolean) as string[];
      const lastRaced = dates.length > 0 ? dates.sort().at(-1) : null;

      return {
        id: rider.id,
        firstName: rider.firstName,
        lastName: rider.lastName,
        email: rider.email,
        bibNumber: rider.bibNumber,
        rfidNumber: rider.rfidNumber,
        dateOfBirth: rider.dateOfBirth,
        eventsRaced: uniqueEvents.size,
        totalPoints,
        bestPosition,
        lastRaced,
      };
    })
  );

  return res.json(profilesWithStats);
});

// GET /rider/profiles/:riderId/history
router.get("/rider/profiles/:riderId/history", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const riderId = parseInt(req.params.riderId, 10);
  if (isNaN(riderId)) return res.status(400).json({ error: "Invalid rider ID" });

  // Verify this rider belongs to the account's email
  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider) return res.status(404).json({ error: "Rider not found" });
  if (!rider.email || rider.email.toLowerCase() !== account.email.toLowerCase()) {
    return res.status(403).json({ error: "Access denied" });
  }

  const rows = await db
    .select({
      resultId: raceResultsTable.id,
      eventId: raceResultsTable.eventId,
      eventName: eventsTable.name,
      eventDate: eventsTable.date,
      eventState: eventsTable.state,
      eventLocation: eventsTable.location,
      timingTechnology: eventsTable.timingTechnology,
      motoId: raceResultsTable.motoId,
      motoName: motosTable.name,
      motoNumber: motosTable.motoNumber,
      motoType: motosTable.type,
      raceClass: raceResultsTable.raceClass,
      position: raceResultsTable.position,
      points: raceResultsTable.points,
      totalTime: raceResultsTable.totalTime,
      lapTimes: raceResultsTable.lapTimes,
      dnf: raceResultsTable.dnf,
      dns: raceResultsTable.dns,
      bibNumber: raceResultsTable.bibNumber,
    })
    .from(raceResultsTable)
    .leftJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .leftJoin(eventsTable, eq(raceResultsTable.eventId, eventsTable.id))
    .where(eq(raceResultsTable.riderId, riderId))
    .orderBy(desc(eventsTable.date), asc(motosTable.motoNumber));

  // Group by event
  const eventMap = new Map<number, {
    eventId: number;
    eventName: string;
    eventDate: string;
    eventState: string;
    eventLocation: string | null;
    timingTechnology: string | null;
    raceClass: string;
    motos: Array<{
      motoId: number;
      motoName: string;
      motoNumber: number;
      motoType: string;
      position: number;
      points: number | null;
      totalTime: string | null;
      lapTimes: string[];
      dnf: boolean;
      dns: boolean;
      bibNumber: string | null;
    }>;
  }>();

  for (const row of rows) {
    if (!eventMap.has(row.eventId)) {
      eventMap.set(row.eventId, {
        eventId: row.eventId,
        eventName: row.eventName ?? `Event ${row.eventId}`,
        eventDate: row.eventDate ?? "",
        eventState: row.eventState ?? "",
        eventLocation: row.eventLocation ?? null,
        timingTechnology: row.timingTechnology ?? null,
        raceClass: row.raceClass,
        motos: [],
      });
    }
    eventMap.get(row.eventId)!.motos.push({
      motoId: row.motoId,
      motoName: row.motoName ?? `Moto ${row.motoNumber}`,
      motoNumber: row.motoNumber ?? 0,
      motoType: row.motoType ?? "heat",
      position: row.position,
      points: row.points,
      totalTime: row.totalTime,
      lapTimes: ((row.lapTimes as { lap: number; time: string }[]) ?? []).map((lt) => lt.time),
      dnf: row.dnf,
      dns: row.dns,
      bibNumber: row.bibNumber,
    });
  }

  const history = Array.from(eventMap.values()).map((ev) => {
    const finishes = ev.motos.filter((m) => !m.dnf && !m.dns);
    return {
      ...ev,
      totalPoints: finishes.reduce((s, m) => s + (m.points ?? 0), 0),
      bestPosition: finishes.length > 0 ? Math.min(...finishes.map((m) => m.position)) : null,
    };
  });

  return res.json({ rider: { ...rider, rfidNumber: rider.rfidNumber ?? null }, history });
});

// PATCH /rider/profiles/:riderId/rfid — rider self-service RFID update
router.patch("/rider/profiles/:riderId/rfid", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const riderId = parseInt(req.params.riderId, 10);
  if (isNaN(riderId)) return res.status(400).json({ error: "Invalid rider ID" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider) return res.status(404).json({ error: "Rider not found" });
  if (!rider.email || rider.email.toLowerCase() !== account.email.toLowerCase()) {
    return res.status(403).json({ error: "Access denied" });
  }

  const { rfidNumber } = req.body;
  const value = typeof rfidNumber === "string" ? rfidNumber.trim() : null;

  const [updated] = await db
    .update(ridersTable)
    .set({ rfidNumber: value || null })
    .where(eq(ridersTable.id, riderId))
    .returning();

  return res.json({ rfidNumber: updated.rfidNumber ?? null });
});

// GET /rider/profiles/:riderId/practice — practice session history for a rider
router.get("/rider/profiles/:riderId/practice", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const riderId = parseInt(req.params.riderId, 10);
  if (isNaN(riderId)) return res.status(400).json({ error: "Invalid rider ID" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider) return res.status(404).json({ error: "Rider not found" });
  if (!rider.email || rider.email.toLowerCase() !== account.email.toLowerCase()) {
    return res.status(403).json({ error: "Access denied" });
  }

  // Find crossings by riderId. Also check by rfidNumber on the rider profile as a fallback.
  const conditions = [eq(practiceCrossingsTable.riderId, riderId)];
  if (rider.rfidNumber) {
    conditions.push(eq(practiceCrossingsTable.rfidNumber, rider.rfidNumber));
  }

  const crossings = await db.select({
    id: practiceCrossingsTable.id,
    sessionId: practiceCrossingsTable.sessionId,
    rfidNumber: practiceCrossingsTable.rfidNumber,
    lapNumber: practiceCrossingsTable.lapNumber,
    lapTimeMs: practiceCrossingsTable.lapTimeMs,
    crossingTime: practiceCrossingsTable.crossingTime,
    sessionName: practiceSessionsTable.name,
    sessionStatus: practiceSessionsTable.status,
    sessionStartedAt: practiceSessionsTable.startedAt,
    sessionEndedAt: practiceSessionsTable.endedAt,
  })
    .from(practiceCrossingsTable)
    .leftJoin(practiceSessionsTable, eq(practiceCrossingsTable.sessionId, practiceSessionsTable.id))
    .where(or(...conditions))
    .orderBy(asc(practiceCrossingsTable.sessionId), asc(practiceCrossingsTable.crossingTime));

  // Group by session
  const sessionMap = new Map<number, {
    sessionId: number;
    sessionName: string;
    startedAt: string | null;
    endedAt: string | null;
    laps: { lapNumber: number; lapTimeMs: number | null; crossingTime: string }[];
  }>();

  for (const c of crossings) {
    if (!sessionMap.has(c.sessionId)) {
      sessionMap.set(c.sessionId, {
        sessionId: c.sessionId,
        sessionName: c.sessionName ?? `Session ${c.sessionId}`,
        startedAt: c.sessionStartedAt?.toISOString() ?? null,
        endedAt: c.sessionEndedAt?.toISOString() ?? null,
        laps: [],
      });
    }
    sessionMap.get(c.sessionId)!.laps.push({
      lapNumber: c.lapNumber,
      lapTimeMs: c.lapTimeMs,
      crossingTime: c.crossingTime.toISOString(),
    });
  }

  const sessions = Array.from(sessionMap.values())
    .sort((a, b) => {
      // Most recent session first
      const aTime = a.startedAt ?? "";
      const bTime = b.startedAt ?? "";
      return bTime.localeCompare(aTime);
    })
    .map(s => {
      const lapTimes = s.laps.filter(l => l.lapTimeMs !== null && l.lapTimeMs > 0);
      const bestLapMs = lapTimes.length > 0 ? Math.min(...lapTimes.map(l => l.lapTimeMs!)) : null;
      return {
        ...s,
        lapCount: s.laps.length,
        bestLapMs,
      };
    });

  return res.json({ rider: { id: rider.id, firstName: rider.firstName, lastName: rider.lastName }, sessions });
});

export default router;
