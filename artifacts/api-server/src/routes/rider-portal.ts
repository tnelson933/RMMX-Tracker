import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { formatLapTime, buildLeaderboard } from "./timing";
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
  seriesTable,
  seriesPointsTable,
  riderMaintenanceTable,
  riderMaintenanceHistoryTable,
  riderNotificationPrefsTable,
  clubsTable,
  enduroTimeChecksTable,
  riderBikesTable,
} from "@workspace/db";
import { eq, desc, asc, or, and, ne, inArray, sql, ilike } from "drizzle-orm";

const router = Router();

function generateMobileToken(): string {
  return randomBytes(32).toString("hex");
}

export function requireRiderAuth(req: any, res: any, next: any) {
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
    return res.status(401).json({ error: "Incorrect email or password. Please try again." });
  }

  const valid = await bcrypt.compare(String(password), account.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Incorrect email or password. Please try again." });
  }

  (req.session as any).riderAccountId = account.id;
  req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;

  const mobileToken = generateMobileToken();
  await db.insert(riderMobileTokensTable).values({ riderAccountId: account.id, token: mobileToken });

  return res.json({ id: account.id, email: account.email, createdAt: account.createdAt.toISOString(), mobileToken });
});

// In-memory store for rider password reset tokens (expires in 1 hour)
const riderResetTokens = new Map<string, { riderAccountId: number; expiresAt: Date }>();

function getRiderAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:80";
}

// POST /rider/auth/forgot-password
router.post("/rider/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  const normalized = String(email).toLowerCase().trim();

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.email, normalized));

  if (account) {
    const token = randomBytes(32).toString("hex");
    riderResetTokens.set(token, { riderAccountId: account.id, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });

    const resetUrl = `${getRiderAppUrl()}/rider/reset-password?token=${token}`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;background:#f9f9f9">
        <div style="background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:40px">
          <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:#111">Reset Your Password</h1>
          <p style="margin:0 0 24px;font-size:15px;color:#555;line-height:1.6">
            We received a request to reset your RM Tracker password. Click the button below to choose a new one.
          </p>
          <a href="${resetUrl}" style="display:inline-block;padding:14px 28px;background:#dc2626;color:#fff;text-decoration:none;font-weight:700;font-size:14px;text-transform:uppercase;letter-spacing:1px;border-radius:4px">
            Reset Password
          </a>
          <p style="margin:28px 0 0;font-size:12px;color:#999;line-height:1.5">
            This link expires in 1 hour. If you didn't request this, you can safely ignore this email.
          </p>
        </div>
      </div>`;

    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: process.env.EMAIL_FROM || "RMMT Ops <onboarding@resend.dev>", to: normalized, subject: "Reset your RM Tracker password", html }),
      });
    }
  }

  // Always return success to prevent email enumeration
  return res.json({ ok: true });
});

// POST /rider/auth/reset-password
router.post("/rider/auth/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "Token and password are required" });
  if (String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  const record = riderResetTokens.get(String(token));
  if (!record || record.expiresAt < new Date()) {
    riderResetTokens.delete(String(token));
    return res.status(400).json({ error: "This link has expired or is invalid. Please request a new one." });
  }

  const hash = await bcrypt.hash(String(password), 12);
  await db.update(riderAccountsTable).set({ passwordHash: hash }).where(eq(riderAccountsTable.id, record.riderAccountId));
  riderResetTokens.delete(String(token));

  return res.json({ ok: true });
});

// POST /rider/auth/change-password
router.post("/rider/auth/change-password", requireRiderAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "Current and new password required" });
  if (String(newPassword).length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });

  const riderAccountId = (req.session as any).riderAccountId;
  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const valid = await bcrypt.compare(String(currentPassword), account.passwordHash);
  if (!valid) return res.status(401).json({ error: "Current password is incorrect" });

  const hash = await bcrypt.hash(String(newPassword), 12);
  await db.update(riderAccountsTable).set({ passwordHash: hash }).where(eq(riderAccountsTable.id, riderAccountId));

  return res.json({ ok: true });
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

  req.log.info({ riderAccountId }, "Push token registered");
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

// GET /rider/events/:eventId/my-registrations — classes this account's riders are registered for
router.get("/rider/events/:eventId/my-registrations", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const eventId = parseInt(req.params.eventId ?? "", 10);
  if (isNaN(eventId)) return res.status(400).json({ error: "Invalid event ID" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const familyRiders = await db
    .select({ id: ridersTable.id, firstName: ridersTable.firstName, lastName: ridersTable.lastName })
    .from(ridersTable)
    .where(sql`LOWER(${ridersTable.email}) = LOWER(${account.email})`);

  if (familyRiders.length === 0) return res.json({ registeredClasses: [], registrations: [] });

  const familyRiderIds = familyRiders.map(r => r.id);
  const riderNameMap = new Map(familyRiders.map(r => [r.id, `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim()]));

  const regs = await db
    .select({
      id: registrationsTable.id,
      raceClass: registrationsTable.raceClass,
      riderId: registrationsTable.riderId,
      status: registrationsTable.status,
    })
    .from(registrationsTable)
    .where(and(
      eq(registrationsTable.eventId, eventId),
      inArray(registrationsTable.riderId, familyRiderIds),
      ne(registrationsTable.status, "void"),
    ));

  return res.json({
    registeredClasses: regs.map(r => r.raceClass).filter(Boolean),
    registrations: regs.map(r => ({
      id: r.id,
      raceClass: r.raceClass,
      riderId: r.riderId,
      riderName: r.riderId != null ? (riderNameMap.get(r.riderId) ?? "") : "",
      status: r.status,
    })),
  });
});

// PATCH /rider/events/:eventId/my-registrations/:regId — rider changes their own registered class
router.patch("/rider/events/:eventId/my-registrations/:regId", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const eventId = parseInt(req.params.eventId ?? "", 10);
  const regId = parseInt(req.params.regId ?? "", 10);
  if (isNaN(eventId) || isNaN(regId)) return res.status(400).json({ error: "Invalid ID" });

  const { raceClass } = req.body;
  if (!raceClass || typeof raceClass !== "string") return res.status(400).json({ error: "raceClass required" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const familyRiders = await db
    .select({ id: ridersTable.id })
    .from(ridersTable)
    .where(sql`LOWER(${ridersTable.email}) = LOWER(${account.email})`);
  const familyRiderIds = familyRiders.map(r => r.id);

  const [reg] = await db.select().from(registrationsTable)
    .where(and(eq(registrationsTable.id, regId), eq(registrationsTable.eventId, eventId)));

  if (!reg) return res.status(404).json({ error: "Registration not found" });
  if (reg.riderId == null || !familyRiderIds.includes(reg.riderId)) {
    return res.status(403).json({ error: "Not your registration" });
  }
  if (reg.status === "void") return res.status(400).json({ error: "Registration is void" });

  const [event] = await db.select({ status: eventsTable.status, raceClasses: eventsTable.raceClasses })
    .from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event) return res.status(404).json({ error: "Event not found" });
  if (event.status !== "registration_open") {
    return res.status(409).json({ error: "Class changes are only allowed while registration is open" });
  }

  const availableClasses = (event.raceClasses as string[] | null) ?? [];
  if (availableClasses.length > 0 && !availableClasses.includes(raceClass)) {
    return res.status(400).json({ error: `${raceClass} is not available at this event` });
  }

  const oldRaceClass = reg.raceClass;
  if (oldRaceClass === raceClass) {
    return res.json({ id: reg.id, raceClass });
  }

  const [updated] = await db.update(registrationsTable)
    .set({ raceClass })
    .where(eq(registrationsTable.id, regId))
    .returning();

  if (oldRaceClass && updated && reg.riderId != null) {
    await db.update(checkinsTable)
      .set({ raceClass })
      .where(and(
        eq(checkinsTable.eventId, eventId),
        eq(checkinsTable.riderId, reg.riderId),
        eq(checkinsTable.raceClass, oldRaceClass),
      ));
    await db.update(raceResultsTable)
      .set({ raceClass })
      .where(and(
        eq(raceResultsTable.eventId, eventId),
        eq(raceResultsTable.riderId, reg.riderId),
        eq(raceResultsTable.raceClass, oldRaceClass),
      ));
  }

  return res.json({ id: updated.id, raceClass: updated.raceClass });
});

// POST /rider/events/:eventId/registrations/cancel — rider cancels their own registration(s)
router.post("/rider/events/:eventId/registrations/cancel", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const eventId = parseInt(req.params.eventId ?? "", 10);
  if (isNaN(eventId)) return res.status(400).json({ error: "Invalid event ID" });

  const { registrationIds } = req.body as { registrationIds?: unknown };
  if (!Array.isArray(registrationIds) || registrationIds.length === 0) {
    return res.status(400).json({ error: "registrationIds (non-empty array) is required" });
  }
  const ids = (registrationIds as unknown[]).map(Number).filter(n => !isNaN(n));
  if (ids.length === 0) return res.status(400).json({ error: "registrationIds must be integers" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const familyRiders = await db
    .select({ id: ridersTable.id })
    .from(ridersTable)
    .where(sql`LOWER(${ridersTable.email}) = LOWER(${account.email})`);
  const familyRiderIds = familyRiders.map(r => r.id);

  // Verify ownership — all IDs must belong to a family rider for this event
  const regs = await db
    .select({ id: registrationsTable.id, riderId: registrationsTable.riderId, status: registrationsTable.status })
    .from(registrationsTable)
    .where(and(
      inArray(registrationsTable.id, ids),
      eq(registrationsTable.eventId, eventId),
    ));

  for (const reg of regs) {
    if (reg.riderId == null || !familyRiderIds.includes(reg.riderId)) {
      return res.status(403).json({ error: "Not your registration" });
    }
    if (reg.status === "void") {
      return res.status(400).json({ error: "Registration is already cancelled" });
    }
  }
  if (regs.length !== ids.length) {
    return res.status(404).json({ error: "One or more registrations not found" });
  }

  const now = new Date();

  await db.update(registrationsTable)
    .set({ status: "void", cancelledAt: now, cancellationSource: "rider" })
    .where(inArray(registrationsTable.id, ids));

  // Remove check-in records for these registrations so riders don't appear on race-day lists
  const cancelledRiderIds = [...new Set(regs.map(r => r.riderId!))];
  for (const riderId of cancelledRiderIds) {
    const remaining = await db
      .select({ id: registrationsTable.id })
      .from(registrationsTable)
      .where(and(
        eq(registrationsTable.eventId, eventId),
        eq(registrationsTable.riderId, riderId),
        ne(registrationsTable.status, "void"),
      ));
    if (remaining.length === 0) {
      await db.delete(checkinsTable).where(and(
        eq(checkinsTable.eventId, eventId),
        eq(checkinsTable.riderId, riderId),
      ));
    }
  }

  return res.json({ cancelled: regs.length });
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
        skillLevel: rider.skillLevel ?? null,
        raceTypes: (rider.raceTypes as string[] | null) ?? [],
        aiMaintenanceSuggestions: rider.aiMaintenanceSuggestions ?? false,
        eventsRaced: uniqueEvents.size,
        totalPoints,
        bestPosition,
        lastRaced,
      };
    })
  );

  // Attach bikes for each rider
  const riderIds = profilesWithStats.map(p => p.id);
  const allBikes = riderIds.length > 0
    ? await db.select().from(riderBikesTable).where(inArray(riderBikesTable.riderId, riderIds)).orderBy(asc(riderBikesTable.createdAt))
    : [];
  const bikesMap = new Map<number, typeof allBikes>();
  for (const bike of allBikes) {
    const arr = bikesMap.get(bike.riderId) ?? [];
    arr.push(bike);
    bikesMap.set(bike.riderId, arr);
  }
  return res.json(profilesWithStats.map(p => ({ ...p, bikes: bikesMap.get(p.id) ?? [] })));
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
    raceTypes: (rider.raceTypes as string[] | null) ?? [],
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
    "skillLevel",
  ] as const;

  type AllowedKey = typeof allowed[number];
  const patch: Partial<Record<AllowedKey, string | null>> & { mylapsTransponderId?: string | null; raceTypes?: string[] | null } = {};

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

  // raceTypes: array of discipline strings
  if ("raceTypes" in req.body) {
    const val = req.body.raceTypes;
    if (Array.isArray(val)) {
      patch.raceTypes = val.filter((v: unknown) => typeof v === "string") as string[];
    } else {
      patch.raceTypes = null;
    }
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

  return res.json({
    ...updated,
    myLapsTransponderNumber: updated.mylapsTransponderId ?? null,
    raceTypes: (updated.raceTypes as string[] | null) ?? [],
  });
});

// ── Bike garage CRUD ───────────────────────────────────────────────────────

async function verifyRiderOwnership(riderAccountId: number, riderId: number): Promise<{ account: any; rider: any } | null> {
  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return null;
  const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider) return null;
  if (!rider.email || rider.email.toLowerCase() !== account.email.toLowerCase()) return null;
  return { account, rider };
}

// GET /rider/profiles/:riderId/bikes
router.get("/rider/profiles/:riderId/bikes", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const riderId = parseInt(req.params.riderId, 10);
  if (isNaN(riderId)) return res.status(400).json({ error: "Invalid rider ID" });
  const ownership = await verifyRiderOwnership(riderAccountId, riderId);
  if (!ownership) return res.status(403).json({ error: "Access denied" });
  const bikes = await db.select().from(riderBikesTable)
    .where(eq(riderBikesTable.riderId, riderId))
    .orderBy(asc(riderBikesTable.createdAt));
  return res.json(bikes);
});

// POST /rider/profiles/:riderId/bikes
router.post("/rider/profiles/:riderId/bikes", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const riderId = parseInt(req.params.riderId, 10);
  if (isNaN(riderId)) return res.status(400).json({ error: "Invalid rider ID" });
  const ownership = await verifyRiderOwnership(riderAccountId, riderId);
  if (!ownership) return res.status(403).json({ error: "Access denied" });
  const { bikeManufacturer, bikeModel, bikeYear } = req.body;
  const existing = await db.select({ id: riderBikesTable.id }).from(riderBikesTable).where(eq(riderBikesTable.riderId, riderId));
  const isFirst = existing.length === 0;
  const [newBike] = await db.insert(riderBikesTable).values({
    riderId,
    bikeManufacturer: typeof bikeManufacturer === "string" ? bikeManufacturer.trim() || null : null,
    bikeModel: typeof bikeModel === "string" ? bikeModel.trim() || null : null,
    bikeYear: typeof bikeYear === "string" ? bikeYear.trim() || null : null,
    isDefault: isFirst,
  }).returning();
  return res.status(201).json(newBike);
});

// PATCH /rider/profiles/:riderId/bikes/:bikeId
router.patch("/rider/profiles/:riderId/bikes/:bikeId", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const riderId = parseInt(req.params.riderId, 10);
  const bikeId = parseInt(req.params.bikeId, 10);
  if (isNaN(riderId) || isNaN(bikeId)) return res.status(400).json({ error: "Invalid ID" });
  const ownership = await verifyRiderOwnership(riderAccountId, riderId);
  if (!ownership) return res.status(403).json({ error: "Access denied" });
  const patch: Record<string, string | null> = {};
  if ("bikeManufacturer" in req.body) patch.bikeManufacturer = typeof req.body.bikeManufacturer === "string" ? req.body.bikeManufacturer.trim() || null : null;
  if ("bikeModel" in req.body) patch.bikeModel = typeof req.body.bikeModel === "string" ? req.body.bikeModel.trim() || null : null;
  if ("bikeYear" in req.body) patch.bikeYear = typeof req.body.bikeYear === "string" ? req.body.bikeYear.trim() || null : null;
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "No fields to update" });
  const [updated] = await db.update(riderBikesTable).set(patch)
    .where(and(eq(riderBikesTable.id, bikeId), eq(riderBikesTable.riderId, riderId)))
    .returning();
  if (!updated) return res.status(404).json({ error: "Bike not found" });
  return res.json(updated);
});

// DELETE /rider/profiles/:riderId/bikes/:bikeId
router.delete("/rider/profiles/:riderId/bikes/:bikeId", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const riderId = parseInt(req.params.riderId, 10);
  const bikeId = parseInt(req.params.bikeId, 10);
  if (isNaN(riderId) || isNaN(bikeId)) return res.status(400).json({ error: "Invalid ID" });
  const ownership = await verifyRiderOwnership(riderAccountId, riderId);
  if (!ownership) return res.status(403).json({ error: "Access denied" });
  const [deleted] = await db.delete(riderBikesTable)
    .where(and(eq(riderBikesTable.id, bikeId), eq(riderBikesTable.riderId, riderId)))
    .returning();
  if (!deleted) return res.status(404).json({ error: "Bike not found" });
  if (deleted.isDefault) {
    const [next] = await db.select().from(riderBikesTable)
      .where(eq(riderBikesTable.riderId, riderId))
      .orderBy(desc(riderBikesTable.createdAt))
      .limit(1);
    if (next) await db.update(riderBikesTable).set({ isDefault: true }).where(eq(riderBikesTable.id, next.id));
  }
  return res.json({ ok: true });
});

// PATCH /rider/profiles/:riderId/maintenance-suggestions — toggle Rocky AI suggestions on/off
router.patch("/rider/profiles/:riderId/maintenance-suggestions", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const riderId = Number(req.params.riderId);
  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) is required" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const [rider] = await db
    .select({ id: ridersTable.id, email: ridersTable.email })
    .from(ridersTable)
    .where(eq(ridersTable.id, riderId));

  if (!rider || rider.email?.toLowerCase() !== account.email.toLowerCase()) {
    return res.status(403).json({ error: "Forbidden" });
  }

  await db.update(ridersTable).set({ aiMaintenanceSuggestions: enabled }).where(eq(ridersTable.id, riderId));
  return res.json({ ok: true });
});

// POST /rider/profiles/:riderId/bikes/:bikeId/set-default
router.post("/rider/profiles/:riderId/bikes/:bikeId/set-default", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const riderId = parseInt(req.params.riderId, 10);
  const bikeId = parseInt(req.params.bikeId, 10);
  if (isNaN(riderId) || isNaN(bikeId)) return res.status(400).json({ error: "Invalid ID" });
  const ownership = await verifyRiderOwnership(riderAccountId, riderId);
  if (!ownership) return res.status(403).json({ error: "Access denied" });
  await db.update(riderBikesTable).set({ isDefault: false }).where(eq(riderBikesTable.riderId, riderId));
  const [updated] = await db.update(riderBikesTable).set({ isDefault: true })
    .where(and(eq(riderBikesTable.id, bikeId), eq(riderBikesTable.riderId, riderId)))
    .returning();
  if (!updated) return res.status(404).json({ error: "Bike not found" });
  return res.json(updated);
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
    sessionVenueName: practiceSessionsTable.venueName,
  })
    .from(practiceCrossingsTable)
    .leftJoin(practiceSessionsTable, eq(practiceCrossingsTable.sessionId, practiceSessionsTable.id))
    .where(or(...conditions))
    .orderBy(asc(practiceCrossingsTable.sessionId), asc(practiceCrossingsTable.crossingTime));

  // Group by session
  const sessionMap = new Map<number, {
    sessionId: number;
    sessionName: string;
    venueName: string | null;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
    laps: { lapNumber: number; lapTimeMs: number | null; crossingTime: string }[];
  }>();

  for (const c of crossings) {
    if (!sessionMap.has(c.sessionId)) {
      sessionMap.set(c.sessionId, {
        sessionId: c.sessionId,
        sessionName: c.sessionName ?? `Session ${c.sessionId}`,
        venueName: c.sessionVenueName ?? null,
        status: c.sessionStatus ?? "ended",
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
      id: registrationsTable.id,
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

  // Fetch events — exclude drafts and events whose race day has fully passed
  // (completed events are kept so registeredEventIds stays correct for history display)
  const events = await db
    .select()
    .from(eventsTable)
    .where(and(
      inArray(eventsTable.id, eventIds),
      ne(eventsTable.status, "draft"),
      sql`(
        ${eventsTable.status} = 'completed'
        OR SUBSTRING(COALESCE(${eventsTable.endDate}, ${eventsTable.date}), 1, 10) >= to_char(CURRENT_DATE, 'YYYY-MM-DD')
      )`,
    ))
    .orderBy(asc(eventsTable.date));

  if (events.length === 0) return res.json({ familyRiderIds, events: [] });

  // For enduro events, fetch per-class start times from time check targets
  const enduroEventIds = events.filter(e => e.raceStyle === "enduro").map(e => e.id);
  const enduroTimeChecks = enduroEventIds.length > 0
    ? await db
      .select({ eventId: enduroTimeChecksTable.eventId, targets: enduroTimeChecksTable.targets })
      .from(enduroTimeChecksTable)
      .where(inArray(enduroTimeChecksTable.eventId, enduroEventIds))
    : [];
  const classStartTimesByEvent = new Map<number, Record<string, string | null>>();
  for (const tc of enduroTimeChecks) {
    if (!classStartTimesByEvent.has(tc.eventId)) classStartTimesByEvent.set(tc.eventId, {});
    const map = classStartTimesByEvent.get(tc.eventId)!;
    for (const target of (tc.targets ?? [])) {
      if (target.startTimeOfDay != null) map[target.raceClass] = target.startTimeOfDay;
    }
  }

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
      id: r.id,
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
      eventEndDate: event.endDate ?? null,
      eventState: event.state ?? null,
      eventLocation: event.location ?? null,
      status: event.status,
      raceStyle: event.raceStyle ?? "motocross",
      classStartTimes: classStartTimesByEvent.get(event.id) ?? {},
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

// GET /rider/motos/:motoId/detail — leaderboard (live/completed) or lineup (scheduled)
router.get("/rider/motos/:motoId/detail", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const motoId = parseInt(req.params.motoId, 10);
  if (isNaN(motoId)) return res.status(400).json({ error: "Invalid moto ID" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, motoId));
  if (!moto) return res.status(404).json({ error: "Moto not found" });

  const familyRiders = await db
    .select({ id: ridersTable.id })
    .from(ridersTable)
    .where(sql`LOWER(${ridersTable.email}) = LOWER(${account.email})`);
  const familyRiderIds = familyRiders.map(r => r.id);

  const reg = await db
    .select({ id: registrationsTable.id })
    .from(registrationsTable)
    .where(and(
      inArray(registrationsTable.riderId, familyRiderIds),
      eq(registrationsTable.eventId, moto.eventId),
      eq(registrationsTable.status, "confirmed"),
    ))
    .limit(1);
  if (reg.length === 0) return res.status(403).json({ error: "Access denied" });

  const snapshot = await buildLeaderboard(motoId);
  if (!snapshot) return res.status(404).json({ error: "Moto not found" });

  const leaderboard = snapshot.leaderboard.map(e => ({
    ...e,
    isFamilyMember: e.riderId != null && familyRiderIds.includes(e.riderId),
  }));

  const rawLineup = (Array.isArray(moto.lineup) ? moto.lineup : []) as Array<{
    position: number; riderId: number; riderName: string; bibNumber?: string | null;
  }>;
  const lineup = rawLineup
    .sort((a, b) => a.position - b.position)
    .map(e => ({
      gate: e.position,
      riderId: e.riderId,
      riderName: e.riderName,
      bibNumber: e.bibNumber ?? null,
      isFamilyMember: familyRiderIds.includes(e.riderId),
    }));

  return res.json({ ...snapshot, leaderboard, lineup });
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

// GET /rider/rm-cash-balance — returns the rider's current RM Cash balance
router.get("/rider/rm-cash-balance", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const [account] = await db.select({ rmCashBalance: riderAccountsTable.rmCashBalance }).from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });
  return res.json({ balance: parseFloat(account.rmCashBalance ?? "0"), currency: "USD" });
});

// POST /rider/training-plan — AI-powered MX/SX workout plan generator
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
3. EVERY exercise must include a specific, practical mxBenefit explaining exactly why it helps SX/MX performance — MAX 15 words, extremely specific (e.g. "Builds forearm endurance to fight pump in the final moto minutes")
4. formTips must be exactly 2–3 cues, each ≤ 12 words — brief, actionable, no fluff
5. exerciseNote is ONE short sentence (≤ 20 words) combining the key setup detail AND the next-session progression tip
6. Time the workout realistically: warm-up 8–12 min, main work proportional to total duration, cool-down 5–8 min
7. For HIIT/cardio exercises use treadmill or bike with specific speed/resistance settings
8. mxRelevance must be an array of exactly 2–3 short bullet strings, each ≤ 15 words
9. proTip, nutritionTip, recoveryTip must each be ≤ 20 words — one punchy sentence

Respond with ONLY a valid JSON object — no markdown fences, no explanation, no prefix text. Schema:
{"planTitle":"string","totalMinutes":number,"focus":["3-4 specific focuses"],"mxRelevance":["bullet 1 ≤15 words","bullet 2 ≤15 words","optional bullet 3 ≤15 words"],"phases":[{"name":"string","duration":number,"phaseColor":"hex (#22c55e warm-up, #3b82f6 strength, #ef4444 HIIT, #f97316 finisher, #8b5cf6 cool-down)","exercises":[{"name":"string","equipment":"string","duration":"string or null","sets":number_or_null,"reps":"string or null","restSeconds":number,"intensity":"string","muscleGroups":["string"],"mxBenefit":"≤15 word specific MX benefit","formTips":["cue ≤12 words","cue ≤12 words","optional cue ≤12 words"],"exerciseNote":"one sentence setup+progression ≤20 words","equipmentSetup":"string","progressionTip":"string"}]}],"proTip":"≤20 word pro tip","nutritionTip":"≤20 word nutrition tip","recoveryTip":"≤20 word recovery tip"}`;

const BIKE_PRACTICE_SYSTEM_PROMPT = `You are an elite Supercross and Motocross riding coach with 20+ years of professional on-track coaching experience. You design structured track practice sessions for amateur and professional MX/SX racers.

Your practice plans are built around timed drill blocks on the track — not gym exercises. Every drill should be something a rider on their bike can do during a practice session at an MX track.

RULES:
1. ALL drills are performed ON A MOTOCROSS BIKE on a real MX/SX track — no gym equipment
2. Each drill block must specify: name, durationMinutes, reps (number of attempts/runs per set), technique cues (2-3 bullet cues for what to focus on), mxFocus (the specific skill being trained, ≤12 words), and a trackSection (where on the track to do this — e.g. "gate area", "rhythm section", "corner exit", "whoops", "full lap")
3. Structure the plan: warm-up lap(s), technique drill blocks, race-simulation blocks, cool-down
4. Time the session realistically — warm-up 5-10 min, main drills proportional to total time, cool-down 5 min
5. mxRelevance must be an array of exactly 2–3 short bullet strings, each ≤ 15 words
6. phaseColor: use #22c55e for warm-up, #f97316 for technique drills, #ef4444 for race simulation/intensity blocks, #8b5cf6 for cool-down
7. proTip, nutritionTip, recoveryTip must each be ≤ 20 words — one punchy sentence
8. Each phase uses "drillBlocks" (not "exercises")

Respond with ONLY a valid JSON object — no markdown fences, no explanation. Schema:
{"planTitle":"string","totalMinutes":number,"focus":["3-4 specific focuses"],"mxRelevance":["bullet 1","bullet 2","optional bullet 3"],"phases":[{"name":"string","duration":number,"phaseColor":"hex color","drillBlocks":[{"name":"string","durationMinutes":number,"reps":number,"trackSection":"string","mxFocus":"≤12 word skill focus","cues":["cue 1","cue 2","optional cue 3"]}]}],"proTip":"≤20 words","nutritionTip":"≤20 words","recoveryTip":"≤20 words"}`;

const MIX_SYSTEM_PROMPT = `You are an elite Supercross and Motocross coach who designs combined track + gym sessions. You split the rider's available time roughly 50/50: the FIRST half is an on-bike practice block at the track, and the SECOND half is a gym workout targeting the same goal.

RULES:
1. First half of phases are ON-BIKE DRILL BLOCKS (same rules as a pure bike session) — use "drillBlocks" array in those phases
2. Second half of phases are GYM EXERCISES (same rules as a pure gym session) — use "exercises" array in those phases
3. Do NOT mix drillBlocks and exercises within the same phase
4. Mark bike phases with phaseColor: #f97316 (drills) or #22c55e (warm-up ride) or #8b5cf6 (cool-down stretch)
5. Mark gym phases with phaseColor: #3b82f6 (strength), #ef4444 (HIIT/finisher), #8b5cf6 (cool-down)
6. Time the plan so total bike time ≈ total gym time (50/50 split); include a short transition note in the plan title
7. mxRelevance must be an array of exactly 2–3 short bullet strings, each ≤ 15 words
8. proTip, nutritionTip, recoveryTip must each be ≤ 20 words
9. For gym exercises: include name, equipment, duration, sets, reps, restSeconds, intensity, muscleGroups, mxBenefit, formTips, exerciseNote
10. For drill blocks: include name, durationMinutes, reps, trackSection, mxFocus, cues

Respond with ONLY a valid JSON object — no markdown fences, no explanation. Schema:
{"planTitle":"string","totalMinutes":number,"focus":["3-4 specific focuses"],"mxRelevance":["bullet 1","bullet 2","optional bullet 3"],"phases":[{"name":"string","duration":number,"phaseColor":"hex","drillBlocks":[...] or "exercises":[...]}],"proTip":"≤20 words","nutritionTip":"≤20 words","recoveryTip":"≤20 words"}`;

const EXERCISE_IMG_DIR = join(process.cwd(), ".uploads");
mkdir(EXERCISE_IMG_DIR, { recursive: true }).catch(() => {});

async function generateExerciseImageBuffer(exerciseName: string, equipment: string): Promise<Buffer | null> {
  try {
    const { generateImageBuffer } = await import("@workspace/integrations-openai-ai-server/image");
    const prompt = `Flat design illustration of a person performing ${exerciseName} using ${equipment}. Clean minimalist style, simple solid background, bold colors, no text, athletic figure showing correct form, equipment clearly visible. Vector art look.`;
    return await generateImageBuffer(prompt, "1024x1024");
  } catch {
    return null;
  }
}

router.post("/rider/training-plan", requireRiderAuth, async (req, res) => {
  const { goal, durationMinutes, workoutType } = req.body as {
    goal?: string;
    durationMinutes?: number;
    workoutType?: string;
  };

  if (!goal?.trim()) return res.status(400).json({ error: "goal is required" });
  if (!durationMinutes || durationMinutes < 15 || durationMinutes > 180) {
    return res.status(400).json({ error: "durationMinutes must be between 15 and 180" });
  }

  const type = workoutType === "bike" ? "bike" : workoutType === "mix" ? "mix" : "gym";

  const systemPrompt =
    type === "bike" ? BIKE_PRACTICE_SYSTEM_PROMPT :
    type === "mix"  ? MIX_SYSTEM_PROMPT :
    MX_TRAINING_SYSTEM_PROMPT;

  const userPrompt =
    type === "gym"
      ? `Generate a complete ${durationMinutes}-minute gym workout plan for a Supercross/Motocross racer who wants to improve: "${goal.trim()}"

Make this workout extremely targeted to what they asked about. If they mention arm pump, make the grip/forearm work the centerpiece. If they mention starts, make explosive power the focus. If they mention endurance, structure it as interval-based cardio with strength support.

Total workout time: ${durationMinutes} minutes. Distribute phases logically (warm-up ~10 min, main work proportional, finisher and cool-down at end).`

      : type === "bike"
      ? `Generate a complete ${durationMinutes}-minute on-bike practice session plan for a Supercross/Motocross racer who wants to improve: "${goal.trim()}"

Build a structured track session with timed drill blocks. Make it extremely targeted — if they mention gate starts, center the session on start drills. If they mention cornering, focus on corner entry/exit drills.

Total practice time: ${durationMinutes} minutes. Include a warm-up lap block, 3-5 focused drill blocks, and a cool-down.`

      : `Generate a complete ${durationMinutes}-minute combined track + gym session for a Supercross/Motocross racer who wants to improve: "${goal.trim()}"

Split the time roughly 50/50: approximately ${Math.round(durationMinutes / 2)} minutes of on-bike practice at the track first, then approximately ${Math.round(durationMinutes / 2)} minutes of gym work targeting the same goal.

For the bike half: structured drill blocks on the track. For the gym half: targeted exercises using standard gym equipment. Both halves should reinforce each other toward the stated goal.

Total session time: ${durationMinutes} minutes.`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const raw = message.content[0]?.type === "text" ? message.content[0].text : "";
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const plan = JSON.parse(cleaned);

    // Only generate exercise images for gym phases (phases with "exercises", not "drillBlocks")
    type ExerciseRef = { phaseIdx: number; exIdx: number; name: string; equipment: string };
    const exerciseRefs: ExerciseRef[] = [];
    for (let pi = 0; pi < (plan.phases ?? []).length; pi++) {
      const phase = plan.phases[pi];
      if (!Array.isArray(phase.exercises)) continue;
      for (let ei = 0; ei < phase.exercises.length; ei++) {
        const ex = phase.exercises[ei];
        exerciseRefs.push({ phaseIdx: pi, exIdx: ei, name: ex.name, equipment: ex.equipment });
      }
    }

    if (exerciseRefs.length > 0) {
      const imageBuffers = await Promise.allSettled(
        exerciseRefs.map(ref => generateExerciseImageBuffer(ref.name, ref.equipment))
      );

      const proto = (req.headers["x-forwarded-proto"] as string) || "https";
      const host = req.headers.host as string;
      const baseUrl = `${proto}://${host}`;

      await Promise.allSettled(
        exerciseRefs.map(async (ref, i) => {
          const result = imageBuffers[i];
          if (result.status !== "fulfilled" || !result.value) return;
          const filename = `exercise-${randomUUID()}.png`;
          const filepath = join(EXERCISE_IMG_DIR, filename);
          await writeFile(filepath, result.value);
          plan.phases[ref.phaseIdx].exercises[ref.exIdx].imageUrl =
            `${baseUrl}/api/storage/uploads/${filename}`;
        })
      );
    }

    return res.json(plan);
  } catch (err) {
    req.log.error({ err }, "Training plan generation failed");
    return res.status(500).json({ error: "Failed to generate training plan. Please try again." });
  }
});

// POST /rider/mechanic-chat — AI mechanic and riding coach conversational agent
router.post("/rider/mechanic-chat", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const { messages, riderContext, riderMemory } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }

  const bikeStr = [riderContext?.bikeYear, riderContext?.bikeMake, riderContext?.bikeModel]
    .filter(Boolean)
    .join(" ");

  // Load maintenance items for this rider so Rocky can reference and log them
  let maintenanceItems: typeof riderMaintenanceTable.$inferSelect[] = [];
  if (riderContext?.riderId && riderAccountId) {
    const riderId = Number(riderContext.riderId);
    if (!isNaN(riderId)) {
      const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
      const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
      if (account && rider && rider.email && rider.email.toLowerCase() === account.email.toLowerCase()) {
        maintenanceItems = await db
          .select()
          .from(riderMaintenanceTable)
          .where(eq(riderMaintenanceTable.riderId, riderId))
          .orderBy(asc(riderMaintenanceTable.sortOrder));
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  const maintenanceSection = maintenanceItems.length > 0
    ? `\nBIKE MAINTENANCE SCHEDULE (${maintenanceItems.length} items tracked — reference itemKey when logging):
${maintenanceItems.map(item => {
  const daysSince = item.lastServicedAt
    ? Math.floor((Date.now() - new Date(item.lastServicedAt).getTime()) / 86400000)
    : null;
  const status = daysSince === null ? "NEVER SERVICED"
    : item.intervalDays && daysSince >= item.intervalDays ? "OVERDUE"
    : item.intervalDays && daysSince >= item.intervalDays * 0.8 ? "DUE SOON"
    : "OK";
  return `  - ${item.itemKey}: ${item.itemName}${item.intervalDesc ? ` (${item.intervalDesc})` : ""}${daysSince !== null ? ` — ${daysSince}d ago` : " — never serviced"} [${status}]`;
}).join("\n")}

MAINTENANCE LOGGING: When the rider explicitly says they completed a maintenance task (e.g. "just changed my oil", "done the chain", "finished the air filter"), match it to the closest itemKey above and include it in maintenanceUpdates. Today: ${today}. Only log what they explicitly confirm as done — never assume.
`
    : "";

  const memorySection =
    riderMemory && typeof riderMemory === "string" && riderMemory.trim().length > 0
      ? `\nPAST CONVERSATION MEMORY (topics already covered — avoid repeating the same advice, follow up naturally):
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

RIDER CONTEXT (already known — never ask for this):
- Rider name: ${riderContext?.name ?? "Unknown"}
- Bike: ${bikeStr || "not set — if relevant, ask what they're riding"}
- Experience level: ${riderContext?.rideExperience ?? "not specified"}
- Events raced: ${riderContext?.eventsRaced ?? "unknown"}
- Best finish: ${riderContext?.bestPosition != null ? `P${riderContext.bestPosition}` : "N/A"}
- Race class: ${riderContext?.recentClass ?? "not specified"}
- Race disciplines: ${Array.isArray(riderContext?.raceTypes) && riderContext.raceTypes.length > 0 ? riderContext.raceTypes.join(", ") : "not specified"}

DISCIPLINE-TAILORED COACHING: Always tailor technique, suspension, fitness, and setup advice to the rider's specific disciplines above. For example: desert/cross-country riders need enduro-specific endurance tips and long-travel suspension advice; supercross riders need tight-rhythm-section technique and stadium-specific setup; flat track riders need slide technique and tire-compound advice; motocross riders get standard MX coaching. If the rider competes in multiple disciplines, connect how training or setup in one discipline transfers to others.
${maintenanceSection}${memorySection}STYLE GUIDELINES:
- Be direct, confident, and technical but accessible — like a trusted crew chief
- Reference the rider's specific bike make/model when giving bike-specific advice
- When troubleshooting, ask one focused clarifying question at a time — don't overwhelm
- Tailor all advice to their experience level
- Keep responses under 280 words unless a step-by-step technical breakdown is needed
- Use MX terminology naturally (moto, gate pick, pinned, roosting, bucking, head-shake, etc.)
- End with a follow-up question when appropriate to keep the diagnosis moving
- When past memory entries exist, naturally reference them rather than repeating the same advice
- When you log a maintenance item, briefly confirm it in your reply (e.g. "✓ Logged your oil change — clock reset.")
- When you recommend or mention any specific product (part, oil, filter, gear, tool, accessory, or consumable), include a direct Rocky Mountain ATV/MC link formatted as: https://www.rockymountainatvmc.com/search#q=<product name url-encoded> — always show the link inline so the rider can tap it. Example: "Grab some Maxima 10W-40 — https://www.rockymountainatvmc.com/search#q=Maxima+10W-40"

OUTPUT FORMAT:
You MUST respond with a valid JSON object and nothing else — no markdown fences, no preamble:
{"reply":"<your full response>","suggestedFollowUps":["<q1>","<q2>","<q3>"],"maintenanceUpdates":[{"itemKey":"<key>","action":"log_service"}]}
- reply: your complete answer (line breaks OK)
- suggestedFollowUps: exactly 3 concise follow-up questions ≤40 chars each
- maintenanceUpdates: items the rider explicitly confirmed as done. Use [] when no maintenance was performed.`;

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

    const raw =
      response.content[0]?.type === "text"
        ? response.content[0].text.trim()
        : "";

    let reply = raw;
    let suggestedFollowUps: string[] = [];
    let maintenanceUpdates: Array<{ itemKey: string; action: string }> = [];

    if (raw) {
      try {
        // Extract JSON from a code fence block anywhere in the response, or use the full string
        const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
        let stripped = fenceMatch ? fenceMatch[1].trim() : raw.trim();
        // Fallback: if stripped doesn't start with '{', try to slice from the first '{'
        if (!stripped.startsWith("{")) {
          const jsonStart = stripped.indexOf("{");
          if (jsonStart !== -1) stripped = stripped.slice(jsonStart);
        }
        const parsed = JSON.parse(stripped);
        if (parsed && typeof parsed.reply === "string") {
          reply = parsed.reply;
          if (Array.isArray(parsed.suggestedFollowUps)) {
            suggestedFollowUps = (parsed.suggestedFollowUps as unknown[])
              .filter((s): s is string => typeof s === "string" && s.trim().length > 0 && s.trim().length <= 40)
              .map((s) => s.trim())
              .slice(0, 3);
          }
          if (Array.isArray(parsed.maintenanceUpdates)) {
            maintenanceUpdates = (parsed.maintenanceUpdates as unknown[])
              .filter((u: any) => u && typeof u.itemKey === "string" && typeof u.action === "string")
              .map((u: any) => ({ itemKey: String(u.itemKey), action: String(u.action) }));
          }
        }
      } catch {
        reply = raw;
      }
    }

    if (!reply) reply = "Sorry, couldn't process that. Try again.";

    // Process maintenance updates server-side — log service date for each confirmed item
    const loggedItems: string[] = [];
    if (maintenanceUpdates.length > 0 && maintenanceItems.length > 0) {
      for (const update of maintenanceUpdates) {
        if (update.action !== "log_service") continue;
        const item = maintenanceItems.find(i => i.itemKey === update.itemKey);
        if (!item) continue;
        try {
          await db
            .insert(riderMaintenanceTable)
            .values({ ...item, id: undefined as any, lastServicedAt: today, createdAt: undefined as any })
            .onConflictDoUpdate({
              target: [riderMaintenanceTable.riderId, riderMaintenanceTable.itemKey],
              set: { lastServicedAt: sql`${today}` },
            });
          await db.insert(riderMaintenanceHistoryTable).values({
            riderId: item.riderId,
            itemKey: item.itemKey,
            itemName: item.itemName,
            servicedAt: today,
            notes: null,
          });
          loggedItems.push(item.itemName);
        } catch { /* non-fatal */ }
      }
    }

    return res.json({ reply, suggestedFollowUps, maintenanceUpdates, loggedItems });
  } catch (err) {
    req.log.error({ err }, "Mechanic chat failed");
    return res.status(500).json({ error: "Chat failed. Please try again." });
  }
});

// GET /rider/maintenance-check — proactive check: return Rocky message if items are due/overdue
router.get("/rider/maintenance-check", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  if (!riderAccountId) return res.status(401).json({ error: "Not authenticated" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const riders = await db
    .select({ id: ridersTable.id, firstName: ridersTable.firstName })
    .from(ridersTable)
    .where(and(
      sql`LOWER(${ridersTable.email}) = LOWER(${account.email})`,
      eq(ridersTable.aiMaintenanceSuggestions, true),
    ));

  if (riders.length === 0) return res.json({ hasItems: false, message: null, items: [] });

  type ItemWithRider = typeof riderMaintenanceTable.$inferSelect & { riderFirstName: string };
  const allItems: ItemWithRider[] = [];
  for (const rider of riders) {
    const items = await db
      .select()
      .from(riderMaintenanceTable)
      .where(eq(riderMaintenanceTable.riderId, rider.id));
    for (const item of items) allItems.push({ ...item, riderFirstName: rider.firstName });
  }

  const dueItems = allItems.filter(item => {
    if (!item.intervalDays) return false;
    const daysSince = item.lastServicedAt
      ? Math.floor((Date.now() - new Date(item.lastServicedAt).getTime()) / 86400000)
      : item.intervalDays; // treat never-logged items as at-interval
    return daysSince >= item.intervalDays * 0.8;
  });

  if (dueItems.length === 0) return res.json({ hasItems: false, message: null, items: [] });

  const overdue = dueItems.filter(item => {
    const days = item.lastServicedAt
      ? Math.floor((Date.now() - new Date(item.lastServicedAt).getTime()) / 86400000)
      : (item.intervalDays ?? 0);
    return days >= (item.intervalDays ?? 0);
  });
  const dueSoon = dueItems.filter(item => !overdue.includes(item));

  const parts: string[] = [];
  if (overdue.length > 0) parts.push(`🔴 Overdue: ${overdue.map(i => i.itemName).join(", ")}`);
  if (dueSoon.length > 0) parts.push(`🟡 Due soon: ${dueSoon.map(i => i.itemName).join(", ")}`);

  const firstName = riders[0]?.firstName ?? "Rider";
  const message = `Hey ${firstName} — quick heads-up before you ride:\n\n${parts.join("\n")}\n\nWant me to walk through any of these, or just tell me when you've done them and I'll log it for you.`;

  return res.json({
    hasItems: true,
    message,
    items: dueItems.map(i => ({ itemKey: i.itemKey, itemName: i.itemName, riderId: i.riderId })),
  });
});

// GET /rider/series — list all series the rider is enrolled in, with position
router.get("/rider/series", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  // Find all rider profiles linked to this account's email
  const riders = await db
    .select({ id: ridersTable.id })
    .from(ridersTable)
    .where(sql`LOWER(${ridersTable.email}) = ${account.email}`);

  if (riders.length === 0) return res.json([]);

  const riderIds = riders.map(r => r.id);

  // Find all series_points rows for these riders (only with actual points)
  const myPoints = await db
    .select()
    .from(seriesPointsTable)
    .where(and(
      inArray(seriesPointsTable.riderId, riderIds),
      sql`${seriesPointsTable.totalPoints} > 0`,
    ));

  if (myPoints.length === 0) return res.json([]);

  // Fetch series names
  const seriesIds = [...new Set(myPoints.map(p => p.seriesId))];
  const seriesList = await db
    .select({ id: seriesTable.id, name: seriesTable.name })
    .from(seriesTable)
    .where(inArray(seriesTable.id, seriesIds));
  const seriesNameMap = new Map(seriesList.map(s => [s.id, s.name]));

  // Deduplicate: if multiple riderIds appear in same seriesId+raceClass, pick the highest-points one
  const grouped = new Map<string, typeof myPoints[0]>();
  for (const row of myPoints) {
    const key = `${row.seriesId}:${row.raceClass}`;
    const existing = grouped.get(key);
    if (!existing || row.totalPoints > existing.totalPoints) {
      grouped.set(key, row);
    }
  }

  // For each unique series+class, compute the rider's position from all series_points
  const result: Array<{
    seriesId: number;
    seriesName: string;
    raceClass: string;
    totalPoints: number;
    position: number;
  }> = [];

  for (const [, myRow] of grouped) {
    const allInClass = await db
      .select({ riderId: seriesPointsTable.riderId, totalPoints: seriesPointsTable.totalPoints })
      .from(seriesPointsTable)
      .where(and(
        eq(seriesPointsTable.seriesId, myRow.seriesId),
        eq(seriesPointsTable.raceClass, myRow.raceClass),
      ));

    // Sort by totalPoints descending, compute positions with tie handling
    allInClass.sort((a, b) => b.totalPoints - a.totalPoints);

    let position = 1;
    let assignedPos = 1;
    for (let i = 0; i < allInClass.length; i++) {
      if (i > 0 && allInClass[i].totalPoints < allInClass[i - 1].totalPoints) {
        assignedPos = i + 1;
      }
      if (riderIds.includes(allInClass[i].riderId)) {
        position = assignedPos;
        break;
      }
    }

    result.push({
      seriesId: myRow.seriesId,
      seriesName: seriesNameMap.get(myRow.seriesId) ?? `Series ${myRow.seriesId}`,
      raceClass: myRow.raceClass,
      totalPoints: myRow.totalPoints,
      position,
    });
  }

  result.sort((a, b) => a.seriesName.localeCompare(b.seriesName) || a.raceClass.localeCompare(b.raceClass));

  return res.json(result);
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

// ─── Bike Maintenance ────────────────────────────────────────────────────────

// GET /rider/maintenance/:riderId — list all maintenance items for a rider
router.get("/rider/maintenance/:riderId", async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  if (!riderAccountId) return res.status(401).json({ error: "Not authenticated" });

  const riderId = parseInt(req.params.riderId, 10);
  if (isNaN(riderId)) return res.status(400).json({ error: "Invalid rider ID" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider || !rider.email || rider.email.toLowerCase() !== account.email.toLowerCase()) {
    return res.status(403).json({ error: "Access denied" });
  }

  const items = await db
    .select()
    .from(riderMaintenanceTable)
    .where(eq(riderMaintenanceTable.riderId, riderId))
    .orderBy(asc(riderMaintenanceTable.sortOrder), asc(riderMaintenanceTable.id));

  return res.json(items);
});

// PUT /rider/maintenance/:riderId/:itemKey — upsert a maintenance item
router.put("/rider/maintenance/:riderId/:itemKey", async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  if (!riderAccountId) return res.status(401).json({ error: "Not authenticated" });

  const riderId = parseInt(req.params.riderId, 10);
  if (isNaN(riderId)) return res.status(400).json({ error: "Invalid rider ID" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider || !rider.email || rider.email.toLowerCase() !== account.email.toLowerCase()) {
    return res.status(403).json({ error: "Access denied" });
  }

  const { itemName, intervalDesc, intervalDays, lastServicedAt, notes, serviceNotes, sortOrder } = req.body;
  const itemKey = req.params.itemKey;

  const [upserted] = await db
    .insert(riderMaintenanceTable)
    .values({
      riderId,
      itemKey,
      itemName: itemName ?? itemKey,
      intervalDesc: intervalDesc ?? null,
      intervalDays: typeof intervalDays === "number" ? intervalDays : null,
      lastServicedAt: lastServicedAt ?? null,
      notes: notes ?? null,
      sortOrder: typeof sortOrder === "number" ? sortOrder : 0,
    })
    .onConflictDoUpdate({
      target: [riderMaintenanceTable.riderId, riderMaintenanceTable.itemKey],
      set: {
        itemName: sql`EXCLUDED.item_name`,
        intervalDesc: sql`EXCLUDED.interval_desc`,
        intervalDays: sql`EXCLUDED.interval_days`,
        lastServicedAt: sql`EXCLUDED.last_serviced_at`,
        notes: sql`EXCLUDED.notes`,
        sortOrder: sql`EXCLUDED.sort_order`,
      },
    })
    .returning();

  // Write a history record whenever lastServicedAt is being set.
  // Use serviceNotes (the user's per-log input) if provided; fall back to notes only when
  // serviceNotes is not present in the payload (e.g. direct API calls).
  if (lastServicedAt) {
    const historyNotes = "serviceNotes" in req.body ? (serviceNotes ?? null) : (notes ?? null);
    await db.insert(riderMaintenanceHistoryTable).values({
      riderId,
      itemKey,
      itemName: itemName ?? itemKey,
      servicedAt: lastServicedAt,
      notes: historyNotes,
    });
  }

  return res.json(upserted);
});

// DELETE /rider/maintenance/:riderId/:itemKey — remove a maintenance item
router.delete("/rider/maintenance/:riderId/:itemKey", async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  if (!riderAccountId) return res.status(401).json({ error: "Not authenticated" });

  const riderId = parseInt(req.params.riderId, 10);
  if (isNaN(riderId)) return res.status(400).json({ error: "Invalid rider ID" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider || !rider.email || rider.email.toLowerCase() !== account.email.toLowerCase()) {
    return res.status(403).json({ error: "Access denied" });
  }

  await db
    .delete(riderMaintenanceTable)
    .where(
      and(
        eq(riderMaintenanceTable.riderId, riderId),
        eq(riderMaintenanceTable.itemKey, req.params.itemKey),
      ),
    );

  return res.json({ ok: true });
});

// GET /rider/maintenance/:riderId/history — list all history records for a rider
router.get("/rider/maintenance/:riderId/history", async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  if (!riderAccountId) return res.status(401).json({ error: "Not authenticated" });

  const riderId = parseInt(req.params.riderId, 10);
  if (isNaN(riderId)) return res.status(400).json({ error: "Invalid rider ID" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider || !rider.email || rider.email.toLowerCase() !== account.email.toLowerCase()) {
    return res.status(403).json({ error: "Access denied" });
  }

  const history = await db
    .select()
    .from(riderMaintenanceHistoryTable)
    .where(eq(riderMaintenanceHistoryTable.riderId, riderId))
    .orderBy(desc(riderMaintenanceHistoryTable.servicedAt), desc(riderMaintenanceHistoryTable.id));

  return res.json(history);
});

// PATCH /rider/maintenance/:riderId/history/:historyId — edit notes or serviced date of a history entry
router.patch("/rider/maintenance/:riderId/history/:historyId", async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  if (!riderAccountId) return res.status(401).json({ error: "Not authenticated" });

  const riderId = parseInt(req.params.riderId, 10);
  const historyId = parseInt(req.params.historyId, 10);
  if (isNaN(riderId) || isNaN(historyId)) return res.status(400).json({ error: "Invalid ID" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider || !rider.email || rider.email.toLowerCase() !== account.email.toLowerCase()) {
    return res.status(403).json({ error: "Access denied" });
  }

  const [entry] = await db.select().from(riderMaintenanceHistoryTable).where(
    and(eq(riderMaintenanceHistoryTable.id, historyId), eq(riderMaintenanceHistoryTable.riderId, riderId))
  );
  if (!entry) return res.status(404).json({ error: "Entry not found" });

  const updates: { notes?: string | null; servicedAt?: string } = {};
  if (typeof req.body.notes !== "undefined") updates.notes = req.body.notes ?? null;
  if (typeof req.body.servicedAt === "string" && req.body.servicedAt.trim()) {
    updates.servicedAt = req.body.servicedAt.trim();
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Nothing to update" });

  const [updated] = await db
    .update(riderMaintenanceHistoryTable)
    .set(updates)
    .where(eq(riderMaintenanceHistoryTable.id, historyId))
    .returning();

  return res.json(updated);
});

// DELETE /rider/maintenance/:riderId/history/:historyId — delete a history entry
router.delete("/rider/maintenance/:riderId/history/:historyId", async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  if (!riderAccountId) return res.status(401).json({ error: "Not authenticated" });

  const riderId = parseInt(req.params.riderId, 10);
  const historyId = parseInt(req.params.historyId, 10);
  if (isNaN(riderId) || isNaN(historyId)) return res.status(400).json({ error: "Invalid ID" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider || !rider.email || rider.email.toLowerCase() !== account.email.toLowerCase()) {
    return res.status(403).json({ error: "Access denied" });
  }

  const [entry] = await db.select().from(riderMaintenanceHistoryTable).where(
    and(eq(riderMaintenanceHistoryTable.id, historyId), eq(riderMaintenanceHistoryTable.riderId, riderId))
  );
  if (!entry) return res.status(404).json({ error: "Entry not found" });

  await db.delete(riderMaintenanceHistoryTable).where(eq(riderMaintenanceHistoryTable.id, historyId));

  return res.json({ ok: true });
});

// POST /rider/maintenance/:riderId/ai-generate — AI-generate a maintenance schedule for the rider's bike
router.post("/rider/maintenance/:riderId/ai-generate", async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId;
  if (!riderAccountId) return res.status(401).json({ error: "Not authenticated" });

  const riderId = parseInt(req.params.riderId, 10);
  if (isNaN(riderId)) return res.status(400).json({ error: "Invalid rider ID" });

  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider || !rider.email || rider.email.toLowerCase() !== account.email.toLowerCase()) {
    return res.status(403).json({ error: "Access denied" });
  }

  const bikeStr = [rider.bikeYear, rider.bikeManufacturer, rider.bikeModel].filter(Boolean).join(" ");
  if (!bikeStr) return res.status(400).json({ error: "No bike on file. Add your bike make/model first." });

  // Optional engine hours from client — improves interval accuracy
  const bikeHours = typeof req.body?.bikeHours === "number" ? req.body.bikeHours : null;
  const hoursContext = bikeHours !== null
    ? `\nThe bike currently has ${bikeHours} engine hours on it. Use this to set accurate lastServicedAt estimates where reasonable (e.g. if oil is every 15 hours and bike has 48 hours, it was likely last done around 3 hours ago — use today's date minus expected gap). Where the hours tell you nothing useful, leave lastServicedAt as null.`
    : "";

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: `You are a motorcycle and ATV maintenance expert. Generate a maintenance schedule for a ${bikeStr}.${hoursContext}

Return ONLY a valid JSON array — no markdown, no explanation, no code fences.

Each item must have these exact fields:
- "itemKey": unique snake_case identifier (e.g. "engine_oil")
- "itemName": human-readable name (e.g. "Engine Oil Change")
- "intervalDesc": concise interval description including hours AND calendar time where applicable (e.g. "Every 15 hours or 3 months")
- "intervalDays": approximate calendar days between services as an integer (e.g. 90)
- "notes": one short sentence of important notes, or null
- "sortOrder": integer 1–20 for display ordering

Include 10–15 items tailored to this specific make and model. Common categories: engine oil, oil filter, air filter, spark plug, chain/drive system, coolant, brake pads, brake fluid, fork oil, valve clearances, throttle/cable, fuel filter, tires, suspension linkage, coolant system (if liquid-cooled), clutch. Omit items not applicable (e.g. no chain for shaft-drive, no coolant for air-cooled). Output ONLY the JSON array.`,
        },
      ],
    });

    const raw = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
    const clean = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    const items: Array<{
      itemKey: string; itemName: string; intervalDesc?: string;
      intervalDays?: number; notes?: string; sortOrder?: number;
    }> = JSON.parse(clean);

    // Upsert all generated items into the DB (preserve lastServicedAt if already set)
    const saved = await Promise.all(
      items.map(async (item) => {
        const [existing] = await db
          .select({ lastServicedAt: riderMaintenanceTable.lastServicedAt })
          .from(riderMaintenanceTable)
          .where(and(
            eq(riderMaintenanceTable.riderId, riderId),
            eq(riderMaintenanceTable.itemKey, item.itemKey),
          ));

        const [row] = await db
          .insert(riderMaintenanceTable)
          .values({
            riderId,
            itemKey: item.itemKey,
            itemName: item.itemName,
            intervalDesc: item.intervalDesc ?? null,
            intervalDays: item.intervalDays ?? null,
            lastServicedAt: existing?.lastServicedAt ?? null,
            notes: item.notes ?? null,
            sortOrder: item.sortOrder ?? 0,
          })
          .onConflictDoUpdate({
            target: [riderMaintenanceTable.riderId, riderMaintenanceTable.itemKey],
            set: {
              itemName: sql`EXCLUDED.item_name`,
              intervalDesc: sql`EXCLUDED.interval_desc`,
              intervalDays: sql`EXCLUDED.interval_days`,
              notes: sql`EXCLUDED.notes`,
              sortOrder: sql`EXCLUDED.sort_order`,
            },
          })
          .returning();
        return row;
      }),
    );

    return res.json(saved.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
  } catch (err) {
    req.log.error({ err }, "Maintenance AI generate failed");
    return res.status(500).json({ error: "Failed to generate maintenance schedule" });
  }
});

// GET /rider/my-organizations
// Returns every club the rider's account has ever registered with, plus their notification pref for each.
router.get("/rider/my-organizations", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId as number;

  // Find all rider profiles linked to this account (by email)
  const [account] = await db
    .select({ email: riderAccountsTable.email })
    .from(riderAccountsTable)
    .where(eq(riderAccountsTable.id, riderAccountId));

  if (!account) return res.status(401).json({ error: "Not authenticated" });

  // Get all riders with this email (case-insensitive to handle mixed-case stored records)
  const linkedRiders = await db
    .select({ id: ridersTable.id })
    .from(ridersTable)
    .where(ilike(ridersTable.email, account.email));

  if (linkedRiders.length === 0) {
    return res.json([]);
  }

  const riderIds = linkedRiders.map((r) => r.id);

  // Find distinct clubs via registrations → events → clubs
  const regs = await db
    .selectDistinct({ clubId: eventsTable.clubId })
    .from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .where(inArray(registrationsTable.riderId, riderIds));

  if (regs.length === 0) return res.json([]);

  const clubIds = regs.map((r) => r.clubId).filter((id): id is number => id !== null);
  if (clubIds.length === 0) return res.json([]);

  // Fetch club details
  const clubs = await db
    .select({
      id: clubsTable.id,
      name: clubsTable.name,
      state: clubsTable.state,
      logoUrl: clubsTable.logoUrl,
    })
    .from(clubsTable)
    .where(inArray(clubsTable.id, clubIds));

  // Fetch notification prefs for this account
  const prefs = await db
    .select({ clubId: riderNotificationPrefsTable.clubId, enabled: riderNotificationPrefsTable.enabled })
    .from(riderNotificationPrefsTable)
    .where(eq(riderNotificationPrefsTable.riderAccountId, riderAccountId));

  const prefMap = new Map<number, boolean>(prefs.map((p) => [p.clubId, p.enabled]));

  const result = clubs.map((club) => ({
    clubId: club.id,
    clubName: club.name,
    state: club.state,
    logoUrl: club.logoUrl ?? null,
    notificationsEnabled: prefMap.has(club.id) ? prefMap.get(club.id)! : true,
  }));

  return res.json(result);
});

// PATCH /rider/my-organizations/:clubId/notifications
// Upsert the notification preference for a specific club.
router.patch("/rider/my-organizations/:clubId/notifications", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId as number;
  const clubId = parseInt(req.params.clubId, 10);
  if (isNaN(clubId)) return res.status(400).json({ error: "Invalid clubId" });

  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled (boolean) is required" });
  }

  const [row] = await db
    .insert(riderNotificationPrefsTable)
    .values({ riderAccountId, clubId, enabled, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [riderNotificationPrefsTable.riderAccountId, riderNotificationPrefsTable.clubId],
      set: { enabled, updatedAt: new Date() },
    })
    .returning();

  return res.json({ clubId: row.clubId, notificationsEnabled: row.enabled });
});

export default router;
