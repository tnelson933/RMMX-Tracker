import { Router } from "express";
import { createHash } from "crypto";
import { db } from "@workspace/db";
import { eventsTable, clubSettingsTable, liabilityWaiverSignaturesTable, usersTable, ridersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { sendLiabilityWaiverConfirmation } from "../lib/email";
import { sql } from "drizzle-orm";

const router = Router();

// POST /api/public/events/:eventId/liability-waiver/sign
// Public — no auth required. Creates a tamper-evident e-signature record.
router.post("/public/events/:eventId/liability-waiver/sign", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { signerName, signerEmail, consentToEsign, waiverSnapshot, fieldLayout, signerType, minorRiderName } = req.body;

  if (!signerName?.trim()) return res.status(400).json({ error: "signerName is required" });
  if (!signerEmail?.trim()) return res.status(400).json({ error: "signerEmail is required" });
  if (!consentToEsign) return res.status(400).json({ error: "consentToEsign must be true" });
  if (!waiverSnapshot?.trim()) return res.status(400).json({ error: "waiverSnapshot is required" });

  const [event] = await db.select({
    id: eventsTable.id,
    clubId: eventsTable.clubId,
    name: eventsTable.name,
    requireLiabilityWaiver: eventsTable.requireLiabilityWaiver,
  }).from(eventsTable).where(eq(eventsTable.id, eventId));

  if (!event) return res.status(404).json({ error: "Event not found" });
  if (!event.requireLiabilityWaiver) return res.status(400).json({ error: "This event does not require a liability waiver" });

  const contentHash = createHash("sha256").update(waiverSnapshot, "utf8").digest("hex");

  const signerIp =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    null;
  const signerUserAgent = req.get("user-agent") ?? null;
  const signedAt = new Date();

  const [sig] = await db.insert(liabilityWaiverSignaturesTable).values({
    clubId: event.clubId,
    eventId,
    signerName: signerName.trim(),
    signerEmail: signerEmail.trim().toLowerCase(),
    signerIp,
    signerUserAgent,
    consentToEsign: true,
    waiverContentHash: contentHash,
    waiverSnapshot,
    fieldLayout: fieldLayout ?? null,
    signerType: signerType === "guardian" ? "guardian" : "self",
    minorRiderName: signerType === "guardian" ? (minorRiderName?.trim() || null) : null,
    signedAt,
  }).returning();

  sendLiabilityWaiverConfirmation({
    to: signerEmail.trim(),
    signerName: signerName.trim(),
    eventName: event.name,
    signedAt: signedAt.toISOString(),
    contentHash,
    waiverSnapshot,
  }).catch(() => {});

  return res.status(201).json({
    signatureId: sig.id,
    signedAt: sig.signedAt.toISOString(),
    contentHash,
  });
});

// GET /api/clubs/:clubId/riders/:riderId/liability-waiver-signatures
// Organizer-only — all PDF waiver signatures for a specific rider (matched by email).
router.get("/clubs/:clubId/riders/:riderId/liability-waiver-signatures", async (req, res) => {
  const clubId = Number(req.params.clubId);
  const riderId = Number(req.params.riderId);

  const sessionUserId = (req.session as any)?.userId;
  if (!sessionUserId) return res.status(401).json({ error: "Not authenticated" });
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, sessionUserId));
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const isSuperAdmin = user.role === "super_admin";
  if (!isSuperAdmin && (user.role !== "club_organizer" || user.clubId !== clubId)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  // Look up the rider's email to match against liability_waiver_signatures
  const [rider] = await db.select({ email: ridersTable.email }).from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider?.email) return res.json([]);

  const sigs = await db
    .select({
      id: liabilityWaiverSignaturesTable.id,
      eventId: liabilityWaiverSignaturesTable.eventId,
      eventName: eventsTable.name,
      eventDate: eventsTable.date,
      signerName: liabilityWaiverSignaturesTable.signerName,
      signerEmail: liabilityWaiverSignaturesTable.signerEmail,
      signedAt: liabilityWaiverSignaturesTable.signedAt,
      waiverSnapshot: liabilityWaiverSignaturesTable.waiverSnapshot,
      fieldLayout: liabilityWaiverSignaturesTable.fieldLayout,
      signerType: liabilityWaiverSignaturesTable.signerType,
      minorRiderName: liabilityWaiverSignaturesTable.minorRiderName,
      waiverContentHash: liabilityWaiverSignaturesTable.waiverContentHash,
    })
    .from(liabilityWaiverSignaturesTable)
    .innerJoin(eventsTable, eq(liabilityWaiverSignaturesTable.eventId, eventsTable.id))
    .where(
      and(
        eq(liabilityWaiverSignaturesTable.clubId, clubId),
        sql`LOWER(${liabilityWaiverSignaturesTable.signerEmail}) = LOWER(${rider.email})`,
      )
    )
    .orderBy(desc(liabilityWaiverSignaturesTable.signedAt));

  return res.json(sigs.map(s => ({
    id: s.id,
    eventId: s.eventId,
    eventName: s.eventName,
    eventDate: typeof s.eventDate === "string" ? s.eventDate : (s.eventDate as Date).toISOString().split("T")[0],
    signerName: s.signerName,
    signerEmail: s.signerEmail,
    signedAt: s.signedAt.toISOString(),
    waiverSnapshot: s.waiverSnapshot,
    fieldLayout: s.fieldLayout ?? null,
    signerType: s.signerType ?? "self",
    minorRiderName: s.minorRiderName ?? null,
    waiverContentHash: s.waiverContentHash,
  })));
});

// GET /api/clubs/:clubId/events/:eventId/liability-waiver/signatures
// Organizer-only — view all signatures for an event.
router.get("/clubs/:clubId/events/:eventId/liability-waiver/signatures", async (req, res) => {
  const clubId = Number(req.params.clubId);
  const eventId = Number(req.params.eventId);

  const sessionUserId = (req.session as any)?.userId;
  if (!sessionUserId) return res.status(401).json({ error: "Not authenticated" });
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, sessionUserId));
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const isSuperAdmin = user.role === "super_admin";
  if (!isSuperAdmin && (user.role !== "club_organizer" || user.clubId !== clubId)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const sigs = await db.select().from(liabilityWaiverSignaturesTable)
    .where(and(
      eq(liabilityWaiverSignaturesTable.clubId, clubId),
      eq(liabilityWaiverSignaturesTable.eventId, eventId),
    ))
    .orderBy(desc(liabilityWaiverSignaturesTable.signedAt));

  return res.json(sigs.map(s => ({
    id: s.id,
    registrationId: s.registrationId,
    signerName: s.signerName,
    signerEmail: s.signerEmail,
    signerIp: s.signerIp,
    consentToEsign: s.consentToEsign,
    waiverContentHash: s.waiverContentHash,
    signedAt: s.signedAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
  })));
});

export default router;
