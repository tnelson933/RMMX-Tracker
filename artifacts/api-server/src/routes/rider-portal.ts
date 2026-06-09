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
  registrationsTable,
  lapCrossingsTable,
  checkinsTable,
} from "@workspace/db";
import { eq, desc, asc, or, and, ne, inArray, sql } from "drizzle-orm";

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
  delete (req.session as any).riderAccountId;
  req.session.save(() => res.json({ ok: true }));
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

  const riders = await db.select().from(ridersTable)
    .where(sql`LOWER(${ridersTable.email}) = ${account.email}`);

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

  return res.json({
    rider: {
      ...rider,
      rfidNumber: rider.rfidNumber ?? null,
      myLapsTransponderNumber: rider.mylapsTransponderId ?? null,
    },
    history,
  });
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

// PATCH /rider/profiles/:riderId — rider self-service profile update
router.patch("/rider/profiles/:riderId", requireRiderAuth, async (req, res) => {
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

  const allowed = [
    "firstName", "lastName", "phone", "dateOfBirth",
    "emergencyContact", "emergencyPhone",
    "bibNumber", "amaNumber", "bikeManufacturer", "sponsors",
    "hometown", "homeState",
  ] as const;

  type AllowedKey = typeof allowed[number];
  const patch: Partial<Record<AllowedKey, string | null>> & { mylapsTransponderId?: string | null } = {};

  for (const key of allowed) {
    if (key in req.body) {
      const val = req.body[key];
      patch[key] = typeof val === "string" ? val.trim() || null : null;
    }
  }

  // myLapsTransponderNumber in the API maps to mylapsTransponderId in the DB
  if ("myLapsTransponderNumber" in req.body) {
    const val = req.body.myLapsTransponderNumber;
    patch.mylapsTransponderId = typeof val === "string" ? val.trim() || null : null;
  }

  if (("firstName" in patch && !patch.firstName) || ("lastName" in patch && !patch.lastName)) {
    return res.status(400).json({ error: "First and last name are required" });
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: "No valid fields provided" });
  }

  const [updated] = await db
    .update(ridersTable)
    .set(patch as any)
    .where(eq(ridersTable.id, riderId))
    .returning();

  return res.json({ ...updated, myLapsTransponderNumber: updated.mylapsTransponderId ?? null });
});

// POST /rider/profiles — create a new rider profile linked to this account's email
router.post("/rider/profiles", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const { firstName, lastName, phone, dateOfBirth, bibNumber, amaNumber,
    bikeManufacturer, sponsors, hometown, homeState, myLapsTransponderNumber } = req.body;

  if (!firstName?.trim() || !lastName?.trim()) {
    return res.status(400).json({ error: "First and last name are required" });
  }

  const [rider] = await db.insert(ridersTable).values({
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    email: account.email,
    phone: phone?.trim() || null,
    dateOfBirth: dateOfBirth?.trim() || null,
    bibNumber: bibNumber?.trim() || null,
    amaNumber: amaNumber?.trim() || null,
    bikeManufacturer: bikeManufacturer?.trim() || null,
    sponsors: sponsors?.trim() || null,
    hometown: hometown?.trim() || null,
    homeState: homeState?.trim() || null,
    mylapsTransponderId: myLapsTransponderNumber?.trim() || null,
  }).returning();

  return res.status(201).json({ id: rider.id });
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

// GET /rider/profiles/:riderId/event-practice — class gate-pick leaderboard from event practice motos
router.get("/rider/profiles/:riderId/event-practice", requireRiderAuth, async (req, res) => {
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

  const registrations = await db
    .select({ eventId: registrationsTable.eventId, raceClass: registrationsTable.raceClass })
    .from(registrationsTable)
    .where(and(eq(registrationsTable.riderId, riderId), eq(registrationsTable.status, "confirmed")));

  if (registrations.length === 0) return res.json({ events: [] });

  const eventIds = [...new Set(registrations.map(r => r.eventId))];
  const events = await db.select().from(eventsTable).where(inArray(eventsTable.id, eventIds));

  const practiceMotos = await db.select().from(motosTable)
    .where(and(inArray(motosTable.eventId, eventIds), eq(motosTable.type, "practice")))
    .orderBy(asc(motosTable.id));

  if (practiceMotos.length === 0) return res.json({ events: [] });

  const motoIds = practiceMotos.map(m => m.id);

  const crossings = await db.select({
    motoId: lapCrossingsTable.motoId,
    riderId: lapCrossingsTable.riderId,
    rfidNumber: lapCrossingsTable.rfidNumber,
    lapNumber: lapCrossingsTable.lapNumber,
    lapTimeMs: lapCrossingsTable.lapTimeMs,
    crossingTime: lapCrossingsTable.crossingTime,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
    bibNumber: ridersTable.bibNumber,
  })
    .from(lapCrossingsTable)
    .leftJoin(ridersTable, eq(lapCrossingsTable.riderId, ridersTable.id))
    .where(inArray(lapCrossingsTable.motoId, motoIds))
    .orderBy(asc(lapCrossingsTable.motoId), asc(lapCrossingsTable.crossingTime));

  const crossingsByMoto = new Map<number, typeof crossings>();
  for (const c of crossings) {
    if (!crossingsByMoto.has(c.motoId)) crossingsByMoto.set(c.motoId, []);
    crossingsByMoto.get(c.motoId)!.push(c);
  }

  const result = [];

  for (const event of events) {
    const reg = registrations.find(r => r.eventId === event.id);
    const riderClass = reg?.raceClass ?? null;

    const eventMotos = practiceMotos.filter(m => {
      if (m.eventId !== event.id) return false;
      if (!riderClass) return true;
      const mc = (m.raceClass as string | null) ?? "";
      return mc === riderClass || mc === "" || mc === "All Classes";
    });

    if (eventMotos.length === 0) continue;

    const sessions = [];

    for (const moto of eventMotos) {
      const motoCrossings = crossingsByMoto.get(moto.id) ?? [];
      if (motoCrossings.length === 0 && moto.status !== "in_progress") continue;

      const riderMap = new Map<string, {
        riderId: number | null;
        rfidNumber: string;
        riderName: string;
        bibNumber: string | null;
        laps: { lapNumber: number; lapTimeMs: number | null; crossingTime: string }[];
        bestLapMs: number | null;
      }>();

      for (const c of motoCrossings) {
        const key = c.rfidNumber;
        if (!riderMap.has(key)) {
          riderMap.set(key, {
            riderId: c.riderId,
            rfidNumber: c.rfidNumber,
            riderName: c.firstName ? `${c.firstName} ${c.lastName ?? ""}`.trim() : c.rfidNumber,
            bibNumber: c.bibNumber ?? null,
            laps: [],
            bestLapMs: null,
          });
        }
        const entry = riderMap.get(key)!;
        if (c.riderId && !entry.riderId) entry.riderId = c.riderId;
        if (c.firstName && entry.riderName === c.rfidNumber) {
          entry.riderName = `${c.firstName} ${c.lastName ?? ""}`.trim();
        }
        entry.laps.push({
          lapNumber: c.lapNumber ?? 0,
          lapTimeMs: c.lapTimeMs,
          crossingTime: c.crossingTime.toISOString(),
        });
        if (c.lapTimeMs !== null && c.lapTimeMs > 0) {
          entry.bestLapMs = entry.bestLapMs === null ? c.lapTimeMs : Math.min(entry.bestLapMs, c.lapTimeMs);
        }
      }

      // Rank by fastest single lap ascending — this is the gate pick order
      const sorted = [...riderMap.values()].sort((a, b) => {
        if (a.bestLapMs === null && b.bestLapMs === null) return 0;
        if (a.bestLapMs === null) return 1;
        if (b.bestLapMs === null) return -1;
        return a.bestLapMs - b.bestLapMs;
      });

      const leaderboard = sorted.map((r, i) => ({
        rank: i + 1,
        riderId: r.riderId,
        riderName: r.riderName,
        bibNumber: r.bibNumber,
        bestLapMs: r.bestLapMs,
        lapCount: r.laps.length,
        isMe: r.riderId === riderId || (!!rider.rfidNumber && r.rfidNumber === rider.rfidNumber),
      }));

      const myEntry = [...riderMap.values()].find(
        r => r.riderId === riderId || (!!rider.rfidNumber && r.rfidNumber === rider.rfidNumber)
      );
      const myLaps = (myEntry?.laps ?? []).sort((a, b) => a.lapNumber - b.lapNumber);

      sessions.push({
        motoId: moto.id,
        sessionName: moto.name as string,
        status: moto.status as string,
        leaderboard,
        myLaps,
      });
    }

    if (sessions.length === 0) continue;

    result.push({
      eventId: event.id,
      eventName: event.name,
      eventDate: (event.date as string | null) ?? null,
      eventState: (event.state as string | null) ?? null,
      raceClass: riderClass,
      sessions,
    });
  }

  return res.json({ events: result });
});

// GET /rider/profiles/:riderId/schedule — events for all riders sharing this account's email
router.get("/rider/profiles/:riderId/schedule", requireRiderAuth, async (req, res) => {
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

  // Find ALL riders whose email matches this account (family members included)
  const familyRiders = await db
    .select({ id: ridersTable.id, firstName: ridersTable.firstName, lastName: ridersTable.lastName })
    .from(ridersTable)
    .where(sql`LOWER(${ridersTable.email}) = LOWER(${account.email})`);

  const familyRiderIds = familyRiders.map(r => r.id);
  const familyRiderMap = new Map(familyRiders.map(r => [r.id, `${r.firstName} ${r.lastName}`]));

  // All confirmed registrations for ALL family riders
  const regs = await db
    .select({
      riderId: registrationsTable.riderId,
      eventId: registrationsTable.eventId,
      raceClass: registrationsTable.raceClass,
      status: registrationsTable.status,
    })
    .from(registrationsTable)
    .where(and(
      inArray(registrationsTable.riderId, familyRiderIds),
      ne(registrationsTable.status, "void"),
    ));

  if (regs.length === 0) return res.json({ familyRiderIds, events: [] });

  const eventIds = [...new Set(regs.map(r => r.eventId))];

  // Fetch events (exclude drafts)
  const events = await db
    .select()
    .from(eventsTable)
    .where(and(
      inArray(eventsTable.id, eventIds),
      ne(eventsTable.status, "draft"),
    ));

  if (events.length === 0) return res.json({ familyRiderIds, events: [] });

  // Fetch all race motos (non-practice) for these events
  const motos = await db
    .select()
    .from(motosTable)
    .where(and(
      inArray(motosTable.eventId, eventIds),
      ne(motosTable.type, "practice"),
    ))
    .orderBy(asc(motosTable.motoNumber));

  // Fetch practice motos for these events (shown for checked-in riders)
  const practiceMotos = await db
    .select()
    .from(motosTable)
    .where(and(
      inArray(motosTable.eventId, eventIds),
      eq(motosTable.type, "practice"),
    ))
    .orderBy(asc(motosTable.motoNumber));

  // Fetch checkins to know which family riders are checked into each event
  const familyCheckins = await db
    .select({ riderId: checkinsTable.riderId, eventId: checkinsTable.eventId })
    .from(checkinsTable)
    .where(and(
      inArray(checkinsTable.riderId, familyRiderIds),
      inArray(checkinsTable.eventId, eventIds),
      eq(checkinsTable.checkedIn, true),
    ));

  const checkedInEventIds = new Set(familyCheckins.map(c => c.eventId));

  // Build response grouped by event (one section per event regardless of how many family members)
  const results = events.map(event => {
    const eventRegs = regs.filter(r => r.eventId === event.id);
    const registrations = eventRegs.map(r => ({
      riderId: r.riderId,
      riderName: familyRiderMap.get(r.riderId) ?? "Unknown",
      raceClass: r.raceClass ?? null,
    }));

    const eventMotos = motos.filter(m => m.eventId === event.id);
    const isCheckedIn = checkedInEventIds.has(event.id);

    // Practice motos — shown to any family member checked into this event
    const eventPracticeMotos = practiceMotos
      .filter(m => m.eventId === event.id)
      .map(moto => ({
        motoId: moto.id,
        motoNumber: moto.motoNumber,
        name: moto.name,
        type: moto.type,
        raceClass: moto.raceClass,
        status: moto.status,
        lapCount: moto.lapCount,
        scheduledTime: moto.scheduledTime ?? null,
        startedAt: moto.startedAt?.toISOString() ?? null,
        completedAt: moto.completedAt?.toISOString() ?? null,
        isAnyFamilyMemberInMoto: isCheckedIn,
        familyGates: [] as { gate: number; riderId: number; riderName: string }[],
        lineup: [] as { gate: number; riderId: number; riderName: string; bibNumber: string | null; isFamilyMember: boolean }[],
      }));

    const motosWithFamily = eventMotos.map(moto => {
      const lineup = (Array.isArray(moto.lineup) ? moto.lineup : []) as Array<{
        position: number; riderId: number; riderName: string; bibNumber?: string | null;
      }>;
      const familyInLineup = lineup.filter(e => familyRiderIds.includes(e.riderId));

      return {
        motoId: moto.id,
        motoNumber: moto.motoNumber,
        name: moto.name,
        type: moto.type,
        raceClass: moto.raceClass,
        status: moto.status,
        lapCount: moto.lapCount,
        scheduledTime: moto.scheduledTime ?? null,
        startedAt: moto.startedAt?.toISOString() ?? null,
        completedAt: moto.completedAt?.toISOString() ?? null,
        isAnyFamilyMemberInMoto: familyInLineup.length > 0,
        familyGates: familyInLineup
          .sort((a, b) => a.position - b.position)
          .map(e => ({ gate: e.position, riderId: e.riderId, riderName: e.riderName })),
        lineup: lineup
          .sort((a, b) => a.position - b.position)
          .map(e => ({
            gate: e.position,
            riderId: e.riderId,
            riderName: e.riderName,
            bibNumber: e.bibNumber ?? null,
            isFamilyMember: familyRiderIds.includes(e.riderId),
          })),
      };
    });

    // Combine race motos and practice motos, sorted by motoNumber
    const allMotos = [...motosWithFamily, ...eventPracticeMotos]
      .sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));

    return {
      eventId: event.id,
      eventName: event.name,
      eventDate: event.date ?? null,
      eventState: event.state ?? null,
      eventLocation: event.location ?? null,
      status: event.status,
      registrations,
      motos: allMotos,
    };
  });

  // Sort: race_day first, then registration_open, then by date desc
  const statusOrder: Record<string, number> = { race_day: 0, registration_open: 1, completed: 2 };
  results.sort((a, b) => {
    const oa = statusOrder[a.status] ?? 3;
    const ob = statusOrder[b.status] ?? 3;
    if (oa !== ob) return oa - ob;
    return (b.eventDate ?? "").localeCompare(a.eventDate ?? "");
  });

  return res.json({ familyRiderIds, events: results });
});

export default router;
