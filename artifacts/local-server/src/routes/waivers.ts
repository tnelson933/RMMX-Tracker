import { Router } from "express";
import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { getDb, parseJson } from "../db";

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
  const { signerName, signerEmail, consentToEsign, waiverSnapshot, fieldLayout, signerType, minorRiderName } =
    (req.body ?? {}) as Record<string, any>;

  if (typeof signerName !== "string" || !signerName.trim()) return res.status(400).json({ error: "signerName is required" });
  if (typeof signerEmail !== "string" || !signerEmail.trim()) return res.status(400).json({ error: "signerEmail is required" });
  if (!consentToEsign) return res.status(400).json({ error: "consentToEsign must be true" });
  if (typeof waiverSnapshot !== "string" || !waiverSnapshot.trim()) return res.status(400).json({ error: "waiverSnapshot is required" });

  const db = getDb();
  const event = db
    .prepare("SELECT id, club_id, require_liability_waiver FROM events WHERE id = ?")
    .get(eventId) as { id: number; club_id: number; require_liability_waiver: number } | undefined;
  if (!event) return res.status(404).json({ error: "Event not found" });
  if (event.require_liability_waiver !== 1) {
    return res.status(400).json({ error: "This event does not require a liability waiver" });
  }

  const contentHash = createHash("sha256").update(waiverSnapshot, "utf8").digest("hex");
  const signerIp = req.ip ?? req.socket.remoteAddress ?? null;
  const signerUserAgent = req.get("user-agent") ?? null;
  const signedAt = new Date().toISOString();
  const isGuardian = signerType === "guardian";

  const result = db.prepare(
    `INSERT INTO liability_waiver_signatures
       (club_id, event_id, signer_name, signer_email, signer_ip, signer_user_agent, consent_to_esign,
        waiver_content_hash, waiver_snapshot, field_layout, signer_type, minor_rider_name, signed_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.club_id,
    eventId,
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
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  const user = getDb()
    .prepare("SELECT role, club_id FROM users WHERE id = ?")
    .get(userId) as { role: string; club_id: number } | undefined;
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  if (user.role !== "super_admin" && (user.role !== "club_organizer" || user.club_id !== clubId)) {
    res.status(403).json({ error: "Forbidden" });
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
  const rider = db.prepare("SELECT email FROM riders WHERE id = ?").get(riderId) as { email: string | null } | undefined;
  if (!rider?.email) return res.json([]);

  const rows = db
    .prepare(
      `SELECT s.*, e.name AS event_name, e.date AS event_date
       FROM liability_waiver_signatures s
       JOIN events e ON e.id = s.event_id
       WHERE s.club_id = ? AND lower(s.signer_email) = lower(?)
       ORDER BY s.signed_at DESC`,
    )
    .all(clubId, rider.email) as any[];

  return res.json(rows.map((s) => ({
    id: s.id,
    eventId: s.event_id,
    eventName: s.event_name,
    eventDate: String(s.event_date ?? "").split("T")[0],
    signerName: s.signer_name,
    signerEmail: s.signer_email,
    signedAt: s.signed_at,
    waiverSnapshot: s.waiver_snapshot,
    fieldLayout: parseJson(s.field_layout, null),
    signerType: s.signer_type ?? "self",
    minorRiderName: s.minor_rider_name ?? null,
    waiverContentHash: s.waiver_content_hash,
  })));
});

// GET /api/clubs/:clubId/riders/:riderId/waiver-acknowledgments
// Organizer: rider acknowledgment history (checkbox waiver at registration).
router.get("/clubs/:clubId/riders/:riderId/waiver-acknowledgments", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const clubId = Number(req.params.clubId);
  const riderId = Number(req.params.riderId);

  const db = getDb();
  const user = db.prepare("SELECT role, club_id FROM users WHERE id = ?").get(userId) as
    | { role: string; club_id: number }
    | undefined;
  if (user && user.role !== "super_admin" && user.club_id !== clubId) {
    return res.status(403).json({ error: "Forbidden" });
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
