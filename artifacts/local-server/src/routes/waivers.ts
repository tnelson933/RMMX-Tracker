import { Router } from "express";
import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { getDb, parseJson } from "../db";
import { isoTime } from "../lib/cloud-shape";

/**
 * Liability waivers at check-in, offline.
 *
 * Mirrors the cloud's routes/liability-waiver.ts and the waiver-acknowledgment
 * history in routes/registrations.ts. Signatures are stored in
 * liability_waiver_signatures and pushed to the cloud by the desktop sync
 * engine (insert trigger → _write_queue). They are legal records: they are
 * never deleted locally (a trigger refuses it) and the queue retries them until
 * the cloud accepts them.
 */

const router = Router();

/** Lower-cased emails that have signed this event's liability waiver. */
export function signedWaiverEmails(db: Database.Database, eventId: number): Set<string> {
  const rows = db
    .prepare("SELECT signer_email FROM liability_waiver_signatures WHERE event_id = ?")
    .all(eventId) as Array<{ signer_email: string }>;
  return new Set(rows.map((r) => String(r.signer_email).toLowerCase()));
}

// POST /api/public/events/:eventId/liability-waiver/sign
// Public — no auth required, like the cloud. Creates a tamper-evident record.
router.post("/public/events/:eventId/liability-waiver/sign", (req, res) => {
  const eventId = Number(req.params.eventId);
  const { signerName, signerEmail, consentToEsign, signerType, minorRiderName, registrationId } =
    (req.body ?? {}) as Record<string, any>;

  if (typeof signerName !== "string" || !signerName.trim()) return res.status(400).json({ error: "Type your full name to sign." });
  if (typeof signerEmail !== "string" || !signerEmail.trim()) return res.status(400).json({ error: "Enter your email address to sign." });
  if (!consentToEsign) return res.status(400).json({ error: "Check the box to agree to sign electronically." });

  const db = getDb();
  const event = db
    .prepare("SELECT id, club_id, require_liability_waiver FROM events WHERE id = ?")
    .get(eventId) as { id: number; club_id: number; require_liability_waiver: number } | undefined;
  if (!event) return res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." });
  if (event.require_liability_waiver !== 1) {
    return res.status(400).json({ error: "This event does not require a liability waiver" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signerEmail.trim())) return res.status(400).json({ error: "Enter a valid email address to sign." });

  // What the rider signs is built here from the club's settings, never taken from
  // the request (the check-in page doesn't send it), exactly like the cloud:
  // the typed text, or else the uploaded PDF with the club's field layout.
  const settings = db
    .prepare("SELECT liability_waiver_text, liability_waiver_pdf_url, liability_waiver_fields FROM club_settings WHERE club_id = ?")
    .get(event.club_id) as { liability_waiver_text: string | null; liability_waiver_pdf_url: string | null; liability_waiver_fields: string | null } | undefined;
  const pdfUrl = settings?.liability_waiver_pdf_url?.trim() || null;
  const usesText = !!settings?.liability_waiver_text?.trim();
  const waiverSnapshot = usesText ? settings!.liability_waiver_text! : pdfUrl ? `[PDF waiver] ${pdfUrl}` : null;
  if (!waiverSnapshot) return res.status(409).json({ error: "This event's liability waiver isn't set up yet. Contact the organizer." });
  const fieldLayout = !usesText ? parseJson(settings?.liability_waiver_fields ?? null, null) : null;

  // Only the signed-in organizer (check-in) may attach the signature to an entry.
  let linkRegistrationId: number | null = null;
  if (registrationId != null && (req.session as any)?.userId) {
    const reg = db.prepare("SELECT id FROM registrations WHERE id = ? AND event_id = ?").get(Number(registrationId), eventId) as { id: number } | undefined;
    linkRegistrationId = reg?.id ?? null;
  }

  const contentHash = createHash("sha256").update(waiverSnapshot, "utf8").digest("hex");
  const signerIp = req.ip ?? req.socket.remoteAddress ?? null;
  const signerUserAgent = req.get("user-agent") ?? null;
  const signedAt = new Date().toISOString();
  const isGuardian = signerType === "guardian";

  const result = db.prepare(
    `INSERT INTO liability_waiver_signatures
       (club_id, event_id, registration_id, signer_name, signer_email, signer_ip, signer_user_agent, consent_to_esign,
        waiver_content_hash, waiver_snapshot, field_layout, signer_type, minor_rider_name, signed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.club_id,
    eventId,
    linkRegistrationId,
    signerName.trim(),
    signerEmail.trim().toLowerCase(),
    signerIp,
    signerUserAgent,
    contentHash,
    waiverSnapshot,
    fieldLayout != null ? JSON.stringify(fieldLayout) : null,
    isGuardian ? "guardian" : "self",
    isGuardian && typeof minorRiderName === "string" ? (minorRiderName.trim() || null) : null,
    signedAt,
  );

  // The cloud emails the signer a confirmation; it does so for this record
  // when the sync engine pushes it (desktop-push), since that needs internet.
  return res.status(201).json({
    signatureId: Number(result.lastInsertRowid),
    signedAt,
    contentHash,
  });
});

function organizerForClub(req: any, res: any, clubId: number): boolean {
  const userId = (req.session as any)?.userId;
  if (!userId) {
    res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
    return false;
  }
  const user = getDb()
    .prepare("SELECT role, club_id FROM users WHERE id = ?")
    .get(userId) as { role: string; club_id: number } | undefined;
  if (!user) {
    res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
    return false;
  }
  if (user.role !== "super_admin" && (user.role !== "club_organizer" || user.club_id !== clubId)) {
    res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
    return false;
  }
  return true;
}

// GET /api/clubs/:clubId/riders/:riderId/liability-waiver-signatures
// Organizer-only — all waiver signatures for a rider (matched by email).
router.get("/clubs/:clubId/riders/:riderId/liability-waiver-signatures", (req, res) => {
  const clubId = Number(req.params.clubId);
  const riderId = Number(req.params.riderId);
  if (!organizerForClub(req, res, clubId)) return;

  const db = getDb();
  const rider = db.prepare("SELECT email, first_name, last_name FROM riders WHERE id = ?").get(riderId) as
    | { email: string | null; first_name: string | null; last_name: string | null }
    | undefined;
  if (!rider) return res.json([]);
  const fullName = `${rider.first_name ?? ""} ${rider.last_name ?? ""}`.trim().toLowerCase().replace(/\s+/g, " ");
  const email = (rider.email ?? "").toLowerCase();

  // The rider's waivers, by the same rule as the website: signed on one of
  // their entries, or (no entry on the record) signed with their email, or by
  // a guardian naming them.
  const regIds = new Set((db.prepare("SELECT id FROM registrations WHERE rider_id = ?").all(riderId) as Array<{ id: number }>).map(r => r.id));
  const rows = (db
    .prepare(
      `SELECT s.*, e.name AS event_name, e.date AS event_date
       FROM liability_waiver_signatures s
       JOIN events e ON e.id = s.event_id
       WHERE s.club_id = ?
       ORDER BY s.signed_at DESC`,
    )
    .all(clubId) as any[]).filter((s) => {
      if (s.registration_id != null) return regIds.has(s.registration_id);
      if ((s.signer_type ?? "self") !== "guardian") return email !== "" && String(s.signer_email ?? "").toLowerCase() === email;
      return String(s.minor_rider_name ?? "").trim().toLowerCase().replace(/\s+/g, " ") === fullName;
    });

  return res.json(rows.map((s) => ({
    id: s.id,
    eventId: s.event_id,
    eventName: s.event_name,
    eventDate: String(s.event_date ?? "").split("T")[0],
    signerName: s.signer_name,
    signerEmail: s.signer_email,
    signedAt: s.signed_at,
    waiverSnapshot: s.waiver_snapshot,
    // The signed PDF's address, or null when the waiver was typed text (in waiverSnapshot).
    pdfUrl: waiverPdfOf(String(s.waiver_snapshot ?? "")),
    fieldLayout: parseJson(s.field_layout, null),
    signerType: s.signer_type ?? "self",
    minorRiderName: s.minor_rider_name ?? null,
    waiverContentHash: s.waiver_content_hash,
    signerIp: s.signer_ip ?? null,
    signerUserAgent: s.signer_user_agent ?? null,
  })));
});

/** api-server lib/waiverSettings.ts waiverPdfOf. */
function waiverPdfOf(snapshot: string): string | null {
  const s = snapshot.trim();
  if (s.startsWith("[PDF waiver] ")) return s.slice("[PDF waiver] ".length).trim();
  if (/^(https?:\/\/|\/api\/storage\/)\S+$/.test(s)) return s;
  return null;
}

// GET /api/clubs/:clubId/events/:eventId/liability-waiver/signatures
// Organizer: everyone who signed this event's liability waiver, newest first.
router.get("/clubs/:clubId/events/:eventId/liability-waiver/signatures", (req, res) => {
  const clubId = Number(req.params.clubId);
  if (!organizerForClub(req, res, clubId)) return;
  const rows = getDb()
    .prepare("SELECT * FROM liability_waiver_signatures WHERE club_id = ? AND event_id = ? ORDER BY signed_at DESC")
    .all(clubId, Number(req.params.eventId)) as any[];
  return res.json(rows.map((s) => ({
    id: s.id,
    registrationId: s.registration_id ?? null,
    signerName: s.signer_name,
    signerEmail: s.signer_email,
    signerIp: s.signer_ip ?? null,
    consentToEsign: s.consent_to_esign === 1,
    waiverContentHash: s.waiver_content_hash,
    signedAt: s.signed_at,
    createdAt: isoTime(s.created_at),
  })));
});

// GET /api/clubs/:clubId/riders/:riderId/waiver-acknowledgments
// Organizer: rider acknowledgment history (checkbox waiver at registration).
router.get("/clubs/:clubId/riders/:riderId/waiver-acknowledgments", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const clubId = Number(req.params.clubId);
  const riderId = Number(req.params.riderId);

  const db = getDb();
  const user = db.prepare("SELECT role, club_id FROM users WHERE id = ?").get(userId) as
    | { role: string; club_id: number }
    | undefined;
  if (user && user.role !== "super_admin" && user.club_id !== clubId) {
    return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
  }

  const rows = db
    .prepare(
      `SELECT r.id, r.waiver_acknowledged_at, r.waiver_snapshot, e.id AS event_id, e.name AS event_name, e.date AS event_date
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       WHERE r.rider_id = ? AND e.club_id = ? AND r.waiver_acknowledged_at IS NOT NULL
       ORDER BY r.waiver_acknowledged_at DESC`,
    )
    .all(riderId, clubId) as any[];

  return res.json(rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    eventName: r.event_name,
    eventDate: r.event_date,
    waiverAcknowledgedAt: r.waiver_acknowledged_at ?? null,
    waiverSnapshot: r.waiver_snapshot ?? null,
  })));
});

export default router;
