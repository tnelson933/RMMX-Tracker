import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { formatLapTime } from "./timing";
import { anthropic } from "@workspace/integrations-anthropic-ai";
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
  riderMobileTokensTable,
  riderPushTokensTable,
} from "@workspace/db";
import { eq, desc, asc, or, and, ne, inArray, sql } from "drizzle-orm";

const router = Router();

function generateMobileToken(): string {
  return randomBytes(32).toString("hex");
}

function requireRiderAuth(req: any, res: any, next: any) {
  // Session auth (web portal)
  if ((req.session as any).riderAccountId) return next();

  // Bearer token auth (mobile app)
  const auth = req.headers.authorization as string | undefined;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    db.select()
      .from(riderMobileTokensTable)
      .where(eq(riderMobileTokensTable.token, token))
      .then(([row]) => {
        if (!row) return res.status(401).json({ error: "Not authenticated" });
        (req.session as any).riderAccountId = row.riderAccountId;
        next();
      })
      .catch(() => res.status(500).json({ error: "Server error" }));
    return;
  }

  return res.status(401).json({ error: "Not authenticated" });
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

  const mobileToken = generateMobileToken();
  await db.insert(riderMobileTokensTable).values({ riderAccountId: account.id, token: mobileToken });

  return res.json({ id: account.id, email: account.email, createdAt: account.createdAt.toISOString(), mobileToken });
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

  const mobileToken = generateMobileToken();
  await db.insert(riderMobileTokensTable).values({ riderAccountId: account.id, token: mobileToken });

  return res.json({ id: account.id, email: account.email, createdAt: account.createdAt.toISOString(), mobileToken });
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

// GET /rider/auth/mobile-me — Bearer token auth check for mobile app startup
router.get("/rider/auth/mobile-me", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });
  return res.json({ id: account.id, email: account.email, createdAt: account.createdAt.toISOString() });
});

// POST /rider/push-token — register Expo push token for the authenticated rider account
router.post("/rider/push-token", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const { expoPushToken } = req.body as { expoPushToken?: string };
  if (!expoPushToken || typeof expoPushToken !== "string") {
    return res.status(400).json({ error: "expoPushToken required" });
  }

  await db
    .insert(riderPushTokensTable)
    .values({ riderAccountId, expoPushToken })
    .onConflictDoUpdate({
      target: riderPushTokensTable.expoPushToken,
      set: { riderAccountId },
    });

  return res.json({ ok: true });
});

// GET /rider/my-event-ids — lightweight list of event IDs any family rider is registered for
router.get("/rider/my-event-ids", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const familyRiders = await db
    .select({ id: ridersTable.id })
    .from(ridersTable)
    .where(sql`LOWER(${ridersTable.email}) = LOWER(${account.email})`);

  if (familyRiders.length === 0) return res.json({ eventIds: [] });

  const familyRiderIds = familyRiders.map(r => r.id);

  const regs = await db
    .selectDistinct({ eventId: registrationsTable.eventId })
    .from(registrationsTable)
    .where(and(
      inArray(registrationsTable.riderId, familyRiderIds),
      ne(registrationsTable.status, "void"),
    ));

  return res.json({ eventIds: regs.map(r => r.eventId) });
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
        bikeManufacturer: rider.bikeManufacturer ?? null,
        bikeModel: rider.bikeModel ?? null,
        bikeYear: rider.bikeYear ?? null,
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

  const eventIdFilter = req.query.eventId ? parseInt(req.query.eventId as string, 10) : null;
  const historyWhere = eventIdFilter && !isNaN(eventIdFilter)
    ? and(eq(raceResultsTable.riderId, riderId), eq(raceResultsTable.eventId, eventIdFilter))
    : eq(raceResultsTable.riderId, riderId);

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
    .where(historyWhere)
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
      lapTimes: ((row.lapTimes as unknown[]) ?? []).map((lt) => {
        if (typeof lt === "number") return formatLapTime(lt);
        if (lt && typeof lt === "object" && "time" in lt) return (lt as { time: string }).time;
        return String(lt ?? "");
      }).filter(Boolean),
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

// GET /rider/profiles/:riderId — full profile detail
router.get("/rider/profiles/:riderId", requireRiderAuth, async (req, res) => {
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

  return res.json({
    id: rider.id,
    firstName: rider.firstName,
    lastName: rider.lastName,
    email: rider.email,
    phone: rider.phone ?? null,
    dateOfBirth: rider.dateOfBirth ?? null,
    emergencyContact: rider.emergencyContact ?? null,
    emergencyPhone: rider.emergencyPhone ?? null,
    rfidNumber: rider.rfidNumber ?? null,
    bibNumber: rider.bibNumber ?? null,
    amaNumber: rider.amaNumber ?? null,
    bikeManufacturer: rider.bikeManufacturer ?? null,
    bikeModel: rider.bikeModel ?? null,
    bikeYear: rider.bikeYear ?? null,
    sponsors: rider.sponsors ?? null,
    myLapsTransponderNumber: rider.mylapsTransponderId ?? null,
    streetAddress: rider.streetAddress ?? null,
    city: rider.city ?? null,
    homeState: rider.homeState ?? null,
    zip: rider.zip ?? null,
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
    "bibNumber", "amaNumber", "bikeManufacturer", "bikeModel", "bikeYear", "sponsors",
    "streetAddress", "city", "homeState", "zip",
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
    bikeManufacturer, sponsors, streetAddress, city, homeState, zip, myLapsTransponderNumber } = req.body;

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
    streetAddress: streetAddress?.trim() || null,
    city: city?.trim() || null,
    homeState: homeState?.trim() || null,
    zip: zip?.trim() || null,
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

  // Track which practice motos this specific rider has crossings in (by riderId or RFID)
  const riderCrossingMotoIds = new Set<number>(
    crossings
      .filter(c => c.riderId === riderId || (rider.rfidNumber != null && c.rfidNumber === rider.rfidNumber))
      .map(c => c.motoId)
  );

  const result = [];

  for (const event of events) {
    const reg = registrations.find(r => r.eventId === event.id);
    const riderClass = reg?.raceClass ?? null;

    const eventMotos = practiceMotos.filter(m => {
      if (m.eventId !== event.id) return false;
      // Always include motos where this rider has crossings, regardless of class tag
      if (riderCrossingMotoIds.has(m.id)) return true;
      // For motos without rider crossings (e.g. live sessions not yet started), apply class filter
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

  // Only confirmed registrations for ALL family riders
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
      eq(registrationsTable.status, "confirmed"),
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

  // Fetch lap crossings for practice motos (for lap time / rank display in schedule)
  const practiceMotoIds = practiceMotos.map(m => m.id);
  type PracticeCrossing = { motoId: number; riderId: number | null; rfidNumber: string; lapNumber: number | null; lapTimeMs: number | null };
  const practiceAllCrossings: PracticeCrossing[] = practiceMotoIds.length > 0
    ? await db
      .select({
        motoId: lapCrossingsTable.motoId,
        riderId: lapCrossingsTable.riderId,
        rfidNumber: lapCrossingsTable.rfidNumber,
        lapNumber: lapCrossingsTable.lapNumber,
        lapTimeMs: lapCrossingsTable.lapTimeMs,
      })
      .from(lapCrossingsTable)
      .where(inArray(lapCrossingsTable.motoId, practiceMotoIds))
      .orderBy(asc(lapCrossingsTable.motoId), asc(lapCrossingsTable.crossingTime))
    : [];

  const crossingsByMoto = new Map<number, PracticeCrossing[]>();
  for (const c of practiceAllCrossings) {
    if (!crossingsByMoto.has(c.motoId)) crossingsByMoto.set(c.motoId, []);
    crossingsByMoto.get(c.motoId)!.push(c);
  }

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
      .map(moto => {
        const motoLineup = (Array.isArray(moto.lineup) ? moto.lineup : []) as Array<{
          position: number; riderId: number; riderName: string; bibNumber?: string | null;
        }>;
        const familyInLineup = motoLineup.filter(e => familyRiderIds.includes(e.riderId));
        // If the moto has an assigned lineup, only family riders IN the lineup see it as "their" moto
        const hasAssignedLineup = motoLineup.length > 0;
        const isAnyFamilyMemberInMoto = hasAssignedLineup ? familyInLineup.length > 0 : isCheckedIn;

        // Build leaderboard from lap crossings
        const motoCrossings = crossingsByMoto.get(moto.id) ?? [];
        const validCrossings = motoCrossings.filter(c => (c.lapTimeMs ?? 0) > 0);
        const riderBestMap = new Map<string, { riderId: number | null; riderName: string; bestLapMs: number }>();
        for (const c of validCrossings) {
          const key = c.riderId != null ? `rider:${c.riderId}` : `rfid:${c.rfidNumber}`;
          const lineupEntry = motoLineup.find(e => e.riderId === c.riderId);
          const riderName = lineupEntry?.riderName ?? (c.riderId != null ? `Rider #${c.riderId}` : `Transponder ${c.rfidNumber}`);
          const existing = riderBestMap.get(key);
          if (!existing || c.lapTimeMs! < existing.bestLapMs) {
            riderBestMap.set(key, { riderId: c.riderId, riderName, bestLapMs: c.lapTimeMs! });
          }
        }
        const practiceLeaderboard = [...riderBestMap.values()]
          .sort((a, b) => a.bestLapMs - b.bestLapMs)
          .map((e, i) => ({
            rank: i + 1,
            riderId: e.riderId,
            riderName: e.riderName,
            bestLapMs: e.bestLapMs,
            isMe: e.riderId != null && familyRiderIds.includes(e.riderId),
          }));

        // My lap times
        const practiceLaps = validCrossings
          .filter(c => c.riderId != null && familyRiderIds.includes(c.riderId))
          .map(c => ({ riderId: c.riderId!, lapNumber: c.lapNumber ?? 0, lapTimeMs: c.lapTimeMs }))
          .sort((a, b) => a.lapNumber - b.lapNumber);

        return {
          motoId: moto.id,
          motoNumber: moto.motoNumber,
          name: moto.name,
          type: moto.type,
          raceClass: moto.raceClass,
          status: moto.status,
          lapCount: moto.lapCount,
          timeLimitMs: (moto as any).timeLimitMs ?? null,
          scheduledTime: moto.scheduledTime ?? null,
          startedAt: moto.startedAt?.toISOString() ?? null,
          completedAt: moto.completedAt?.toISOString() ?? null,
          isAnyFamilyMemberInMoto,
          familyGates: familyInLineup
            .sort((a, b) => a.position - b.position)
            .map(e => ({ gate: e.position, riderId: e.riderId, riderName: e.riderName })),
          lineup: motoLineup
            .sort((a, b) => a.position - b.position)
            .map(e => ({
              gate: e.position,
              riderId: e.riderId,
              riderName: e.riderName,
              bibNumber: e.bibNumber ?? null,
              isFamilyMember: familyRiderIds.includes(e.riderId),
            })),
          practiceLaps,
          practiceLeaderboard,
        };
      });

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

// GET /rider/memory — return the server-side Rocky memory blob for this account
router.get("/rider/memory", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const [account] = await db
    .select({ rockyMemory: riderAccountsTable.rockyMemory })
    .from(riderAccountsTable)
    .where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });
  return res.json({ memory: account.rockyMemory ?? "" });
});

// PATCH /rider/memory — overwrite the server-side Rocky memory blob
router.patch("/rider/memory", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const { memory } = req.body;
  if (typeof memory !== "string") {
    return res.status(400).json({ error: "memory must be a string" });
  }
  await db
    .update(riderAccountsTable)
    .set({ rockyMemory: memory || null })
    .where(eq(riderAccountsTable.id, riderAccountId));
  return res.json({ ok: true });
});

// GET /rider/race-gas-balance — stub; returns 0 until race gas system is wired up
router.get("/rider/race-gas-balance", requireRiderAuth, async (_req, res) => {
  return res.json({ balance: 0, currency: "USD" });
});

// POST /rider/training-plan — AI-powered MX/SX gym workout plan generator
const MX_TRAINING_SYSTEM_PROMPT = `You are an elite Supercross and Motocross physical conditioning coach with 20+ years of experience training professional and amateur racers at all levels from local amateur to AMA Pro.

Your knowledge is deeply specialized in the unique physical demands of SX/MX racing:
- Arm pump (forearm compartment syndrome) — the #1 complaint of MX racers — prevention, treatment, and long-term conditioning
- Explosive power for holeshots, ruts, and whoops sections
- Cardiovascular endurance for 30–35 minute outdoor motos and 20-minute Supercross races
- Core stability and anti-rotation strength for absorbing G-forces through rough terrain
- Grip strength, wrist conditioning, and forearm endurance for technical sections
- Knee and ankle stability for the standing riding position over rough terrain
- Neck and shoulder strength for helmet loads and crash recovery
- Hip flexor and posterior chain power for pumping the bike
- Balance and proprioception for sand, ruts, and off-cambers

Professional MX/SX athletes (Eli Tomac, Cooper Webb, Ken Roczen, Chase Sexton) follow periodized training programs combining:
- HIIT intervals mimicking the variable intensity of a moto (sprint → recovery → sprint)
- Strength training emphasizing push/pull balance, hip hinge, and posterior chain
- Grip-specific forearm work: reverse curls, farmer carries, wrist rollers, dead hangs
- Aerobic base building: cycling, running, swimming at conversational pace
- Plyometric explosive power for starts (box jumps, broad jumps, med ball slams)
- Core anti-rotation: Pallof press, single-arm carries, plank variations

RULES:
1. ONLY use standard commercial gym equipment: treadmills, free weights (barbells, dumbbells, EZ-curl bars), cable machines, pull-up bars, bench, squat rack, battle ropes, plyo boxes, resistance bands, foam rollers, exercise bikes, rowing machines
2. NEVER reference motocross bikes, moto simulators, tracks, or specialized MX equipment
3. EVERY exercise must include a specific, practical mxBenefit explaining exactly why it helps SX/MX performance — be specific (e.g. "Builds the forearm pump endurance needed for the last 10 minutes of a moto" not just "builds arm strength")
4. Form tips must be extremely specific and practical — include common mistakes to avoid
5. Time the workout realistically: warm-up 8–12 min, main work proportional to total duration, cool-down 5–8 min
6. For HIIT/cardio exercises use treadmill or bike with specific speed/resistance settings
7. progressionTip should give a concrete next step for the next session

Respond with ONLY a valid JSON object — no markdown fences, no explanation, no prefix text. Schema:
{"planTitle":"string","totalMinutes":number,"focus":["3-4 specific focuses"],"mxRelevance":"2 sentences on why this helps SX/MX","phases":[{"name":"string","duration":number,"phaseColor":"hex (#22c55e warm-up, #3b82f6 strength, #ef4444 HIIT, #f97316 finisher, #8b5cf6 cool-down)","exercises":[{"name":"string","equipment":"string","duration":"string or null","sets":number_or_null,"reps":"string or null","restSeconds":number,"intensity":"string","muscleGroups":["string"],"mxBenefit":"specific MX performance benefit","formTips":["3-4 specific cues"],"equipmentSetup":"string","progressionTip":"string"}]}],"proTip":"pro SX/MX training insight","nutritionTip":"specific nutrition advice","recoveryTip":"specific recovery protocol"}`;

router.post("/rider/training-plan", requireRiderAuth, async (req, res) => {
  const { goal, durationMinutes } = req.body as { goal?: string; durationMinutes?: number };

  if (!goal?.trim()) return res.status(400).json({ error: "goal is required" });
  if (!durationMinutes || durationMinutes < 15 || durationMinutes > 180) {
    return res.status(400).json({ error: "durationMinutes must be between 15 and 180" });
  }

  const userPrompt = `Generate a complete ${durationMinutes}-minute gym workout plan for a Supercross/Motocross racer who wants to improve: "${goal.trim()}"

Make this workout extremely targeted to what they asked about. If they mention arm pump, make the grip/forearm work the centerpiece. If they mention starts, make explosive power the focus. If they mention endurance, structure it as interval-based cardio with strength support.

Total workout time: ${durationMinutes} minutes. Distribute phases logically (warm-up ~10 min, main work proportional, finisher and cool-down at end).`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 8192,
      system: MX_TRAINING_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const raw = message.content[0]?.type === "text" ? message.content[0].text : "";
    // Strip markdown fences if model adds them
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const plan = JSON.parse(cleaned);
    return res.json(plan);
  } catch (err) {
    req.log.error({ err }, "Training plan generation failed");
    return res.status(500).json({ error: "Failed to generate training plan. Please try again." });
  }
});

// POST /rider/mechanic-chat — AI mechanic and riding coach conversational agent
router.post("/rider/mechanic-chat", requireRiderAuth, async (req, res) => {
  const { messages, riderContext, riderMemory } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }

  const bikeStr = [riderContext?.bikeYear, riderContext?.bikeMake, riderContext?.bikeModel]
    .filter(Boolean)
    .join(" ");

  const memorySection =
    riderMemory && typeof riderMemory === "string" && riderMemory.trim().length > 0
      ? `\nPAST CONVERSATION MEMORY (topics already covered with this rider — use this to avoid repeating the same advice and to follow up naturally on earlier issues):
${riderMemory.trim()}

`
      : "";

  const systemPrompt = `You are Rocky — an elite motocross and ATV mechanic and expert-level competitive rider with 25+ years of professional MX/SX/ATV racing experience at the highest levels.

MECHANIC EXPERTISE:
- Deep knowledge of all major MX/SX/ATV engine platforms: 2-stroke and 4-stroke, mini to open class
- Suspension setup, tuning, and re-valving for all track conditions, rider weights, and riding styles
- Carburetion, jetting, fuel injection, and EFI mapping
- Chassis geometry, linkage ratios, triple-clamp offset, steering head bearings
- Transmission, clutch pack setup, clutch diagnosis, and drivetrain issues
- Electrical systems: ignition timing, stator/CDI/flywheel, wiring diagnosis
- Brake systems: bleeding, pad compound selection, rotor warpage, master cylinder issues
- Premix ratios, coolant systems, radiator flush, air filter maintenance
- Preventive maintenance schedules by hour/race count

RIDING COACH EXPERTISE:
- Corner technique: late-apex vs. early-apex, braking points, entry speed, rut riding, off-camber sections
- Body positioning: attack position, weight distribution fore-aft, foot placement on pegs
- Jump technique: doubles, triples, rhythm section timing, scrubs, whips
- Track reading: line selection, rut avoidance, switching lines during a moto
- Gate starts: clutch engagement points, body position, throttle timing
- Race strategy: managing pace, passing opportunities, conserving energy
- Mental game: race-day nerves, managing pressure, crash recovery
- Common beginner/intermediate mistakes and how to fix them

RIDER CONTEXT (already known — never ask for this information):
- Rider name: ${riderContext?.name ?? "Unknown"}
- Bike: ${bikeStr || "not set — if relevant, ask what they're riding"}
- Experience level: ${riderContext?.rideExperience ?? "not specified"}
- Events raced: ${riderContext?.eventsRaced ?? "unknown"}
- Best finish: ${riderContext?.bestPosition != null ? `P${riderContext.bestPosition}` : "N/A"}
- Race class: ${riderContext?.recentClass ?? "not specified"}
${memorySection}
STYLE GUIDELINES:
- Be direct, confident, and technical but accessible — like a trusted crew chief
- Reference the rider's specific bike make/model when giving bike-specific advice
- When troubleshooting, ask one focused clarifying question at a time — don't overwhelm
- Tailor all advice to their experience level
- Keep responses under 280 words unless a step-by-step technical breakdown is needed
- Use MX terminology naturally (moto, gate pick, pinned, roosting, bucking, head-shake, etc.)
- End with a follow-up question when appropriate to keep the diagnosis moving
- When past memory entries exist, naturally reference them (e.g. "Last time we talked about your jetting — did that fix the bog?") rather than repeating the same advice from scratch`;

  try {
    const filtered = messages
      .filter((m: any) => m.role === "user" || m.role === "assistant")
      .map((m: any) => ({ role: m.role as "user" | "assistant", content: String(m.content) }));

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: systemPrompt,
      messages: filtered,
    });

    const reply =
      response.content[0]?.type === "text"
        ? response.content[0].text
        : "Sorry, couldn't process that. Try again.";

    return res.json({ reply });
  } catch (err) {
    req.log.error({ err }, "Mechanic chat failed");
    return res.status(500).json({ error: "Chat failed. Please try again." });
  }
});

// POST /rider/mechanic-memory-update — summarize the last exchange into a memory entry
router.post("/rider/mechanic-memory-update", requireRiderAuth, async (req, res) => {
  const { lastUserMessage, lastAssistantReply, riderContext } = req.body;

  if (!lastUserMessage || !lastAssistantReply) {
    return res.status(400).json({ error: "lastUserMessage and lastAssistantReply are required" });
  }

  const bikeStr = [riderContext?.bikeYear, riderContext?.bikeMake, riderContext?.bikeModel]
    .filter(Boolean)
    .join(" ");

  const today = new Date().toISOString().slice(0, 10);

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 120,
      system: `You are a concise memory-writer for a motorcycle mechanic AI. Summarise a single Q&A exchange into ONE short bullet line (max 25 words) that captures: the topic/problem, the advice given, and the outcome if mentioned. Format: [${today}] <summary>. Output only the bullet line — no preamble, no markdown.`,
      messages: [
        {
          role: "user",
          content: `Rider${bikeStr ? ` (${bikeStr})` : ""} asked: "${lastUserMessage}"\n\nRocky replied: "${lastAssistantReply}"`,
        },
      ],
    });

    const memoryEntry =
      response.content[0]?.type === "text" ? response.content[0].text.trim() : null;

    return res.json({ memoryEntry });
  } catch (err) {
    req.log.error({ err }, "Memory update failed");
    return res.status(500).json({ error: "Memory update failed" });
  }
});

export default router;
