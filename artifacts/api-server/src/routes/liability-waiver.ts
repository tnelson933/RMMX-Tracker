import { Router } from "express";
import { createHash } from "crypto";
import { db } from "@workspace/db";
import { eventsTable, clubSettingsTable, liabilityWaiverSignaturesTable, usersTable, ridersTable, registrationsTable } from "@workspace/db";
import { callerOwnsClub } from "../middleware/accessControl";
import { eq, and, desc } from "drizzle-orm";
import { sendLiabilityWaiverConfirmation } from "../lib/email";
import { clubWaiverSettings, liabilityWaiverSnapshot, waiverPdfOf } from "../lib/waiverSettings";
import { sql } from "drizzle-orm";

const router = Router();

// POST /api/public/events/:eventId/liability-waiver/sign
// Public — no auth required. Creates a tamper-evident e-signature record.
router.post("/public/events/:eventId/liability-waiver/sign", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { signerName, signerEmail, consentToEsign, signerType, minorRiderName, registrationId } = req.body;

  if (!signerName?.trim()) return res.status(400).json({ error: "Type your full name to sign." });
  if (!signerEmail?.trim()) return res.status(400).json({ error: "Enter your email address to sign." });
  if (!consentToEsign) return res.status(400).json({ error: "Check the box to agree to sign electronically." });

  const [event] = await db.select({
    id: eventsTable.id,
    clubId: eventsTable.clubId,
    name: eventsTable.name,
    requireLiabilityWaiver: eventsTable.requireLiabilityWaiver,
  }).from(eventsTable).where(eq(eventsTable.id, eventId));

  if (!event) return res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." });
  if (!event.requireLiabilityWaiver) return res.status(400).json({ error: "This event does not require a liability waiver" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(signerEmail).trim())) return res.status(400).json({ error: "Enter a valid email address to sign." });
  const waiverSettings = await clubWaiverSettings(event.clubId);
  const waiverSnapshot = liabilityWaiverSnapshot(waiverSettings);
  // Where the name, date and signature sit on the PDF: the club's layout when signed.
  const fieldLayout = waiverPdfOf(waiverSnapshot ?? "") ? (waiverSettings?.liabilityWaiverFields ?? null) : null;
  if (!waiverSnapshot) return res.status(409).json({ error: "This event's liability waiver isn't set up yet. Contact the organizer." });

  // Only the event's own staff (check-in) may attach the signature to an entry here;
  // online registration links it when the registration is created.
  let linkRegistrationId: number | null = null;
  if (registrationId != null && callerOwnsClub(res, event.clubId)) {
    const [reg] = await db.select({ id: registrationsTable.id }).from(registrationsTable)
      .where(and(eq(registrationsTable.id, Number(registrationId)), eq(registrationsTable.eventId, eventId)));
    linkRegistrationId = reg?.id ?? null;
  }

  const contentHash = createHash("sha256").update(waiverSnapshot, "utf8").digest("hex");

  // req.ip honours app.set("trust proxy", 1): the address our own proxy saw, not a
  // client-supplied X-Forwarded-For entry.
  const signerIp = req.ip ?? req.socket.remoteAddress ?? null;
  const signerUserAgent = req.get("user-agent") ?? null;
  const signedAt = new Date();

  const [sig] = await db.insert(liabilityWaiverSignaturesTable).values({
    clubId: event.clubId,
    eventId,
    registrationId: linkRegistrationId,
    signerName: signerName.trim(),
    signerEmail: signerEmail.trim().toLowerCase(),
    signerIp,
    signerUserAgent,
    consentToEsign: true,
    waiverContentHash: contentHash,
    waiverSnapshot,
    fieldLayout,
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
  if (!sessionUserId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, sessionUserId));
  if (!user) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const isSuperAdmin = user.role === "super_admin";
  // Club organizers, and club staff with the riders permission (they see the rider page).
  const canReadRiders =
    user.role === "club_organizer" ||
    (user.role === "staff" && (user.permissions ?? []).includes("riders"));
  if (!isSuperAdmin && (!canReadRiders || user.clubId !== clubId)) {
    return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
  }

  const [rider] = await db.select({ email: ridersTable.email, firstName: ridersTable.firstName, lastName: ridersTable.lastName })
    .from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider) return res.json([]);
  const fullName = `${rider.firstName ?? ""} ${rider.lastName ?? ""}`.trim().toLowerCase().replace(/\s+/g, " ");

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
      signerIp: liabilityWaiverSignaturesTable.signerIp,
      signerUserAgent: liabilityWaiverSignaturesTable.signerUserAgent,
    })
    .from(liabilityWaiverSignaturesTable)
    .innerJoin(eventsTable, eq(liabilityWaiverSignaturesTable.eventId, eventsTable.id))
    .where(
      and(
        eq(liabilityWaiverSignaturesTable.clubId, clubId),
        sql`(
          ${liabilityWaiverSignaturesTable.registrationId} in (select id from registrations where rider_id = ${riderId})
          or (${liabilityWaiverSignaturesTable.registrationId} is null and (
            (coalesce(${liabilityWaiverSignaturesTable.signerType}, 'self') <> 'guardian'
              and ${rider.email ?? ""} <> '' and lower(${liabilityWaiverSignaturesTable.signerEmail}) = lower(${rider.email ?? ""}))
            or (${liabilityWaiverSignaturesTable.signerType} = 'guardian'
              and regexp_replace(lower(trim(${liabilityWaiverSignaturesTable.minorRiderName})), '[[:space:]]+', ' ', 'g') = ${fullName})
          ))
        )`,
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
    // The signed PDF's address, or null when the waiver was typed text (in waiverSnapshot).
    pdfUrl: waiverPdfOf(s.waiverSnapshot),
    fieldLayout: s.fieldLayout ?? null,
    signerType: s.signerType ?? "self",
    minorRiderName: s.minorRiderName ?? null,
    waiverContentHash: s.waiverContentHash,
    signerIp: s.signerIp ?? null,
    signerUserAgent: s.signerUserAgent ?? null,
  })));
});

// GET /api/clubs/:clubId/events/:eventId/liability-waiver/signatures
// Organizer-only — view all signatures for an event.
router.get("/clubs/:clubId/events/:eventId/liability-waiver/signatures", async (req, res) => {
  const clubId = Number(req.params.clubId);
  const eventId = Number(req.params.eventId);

  const sessionUserId = (req.session as any)?.userId;
  if (!sessionUserId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, sessionUserId));
  if (!user) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const isSuperAdmin = user.role === "super_admin";
  if (!isSuperAdmin && (user.role !== "club_organizer" || user.clubId !== clubId)) {
    return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
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
