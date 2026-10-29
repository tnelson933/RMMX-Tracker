import { Router } from "express";
import { getDb } from "../db";
import crypto from "crypto";

const router = Router();

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

function getClubId(req: any): number | null {
  const userId = (req.session as any)?.userId;
  if (!userId) return null;
  const db = getDb();
  const user = db
    .prepare("SELECT club_id FROM users WHERE id = ?")
    .get(userId) as { club_id: number } | undefined;
  return user?.club_id ?? null;
}

/** The event's club, or undefined when the event doesn't exist locally. */
function eventClub(eventId: number): { club_id: number | null; entry_fee_category_id: number | null } | undefined {
  return getDb()
    .prepare("SELECT club_id, entry_fee_category_id FROM events WHERE id = ?")
    .get(eventId) as { club_id: number | null; entry_fee_category_id: number | null } | undefined;
}

/**
 * Local riders have no club column. A rider may get a club's code unless they are
 * evidently another club's: registered only at other clubs' events.
 */
function riderUsableByClub(riderId: number, clubId: number): boolean {
  const db = getDb();
  if (!db.prepare("SELECT id FROM riders WHERE id = ?").get(riderId)) return false;
  const own = db.prepare(
    "SELECT r.id FROM registrations r JOIN events e ON e.id = r.event_id WHERE r.rider_id = ? AND e.club_id = ? LIMIT 1",
  ).get(riderId, clubId);
  if (own) return true;
  const other = db.prepare(
    "SELECT r.id FROM registrations r JOIN events e ON e.id = r.event_id WHERE r.rider_id = ? AND e.club_id IS NOT NULL AND e.club_id != ? LIMIT 1",
  ).get(riderId, clubId);
  return !other;
}

/** maxUses: -1 = unlimited, otherwise a whole number >= 1; undefined = invalid. */
function parseMaxUses(raw: unknown): number | undefined {
  if (raw === undefined) return 1;
  const n = Number(raw);
  if (raw === null || raw === "" || typeof raw === "boolean" || !Number.isInteger(n)) return undefined;
  if (n === -1) return 999999;
  if (n < 1 || n > 999999) return undefined;
  return n;
}

// GET /events/:eventId/comp-codes
router.get("/events/:eventId/comp-codes", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const eventId = Number(req.params.eventId);
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });
  const ev = eventClub(eventId);
  if (!ev) return res.status(404).json({ error: "Event not found" });
  if (ev.club_id != null && ev.club_id !== clubId) return res.status(403).json({ error: "Forbidden" });
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT
         cc.id, cc.event_id, cc.club_id, cc.rider_id,
         cc.code, cc.discount_type, cc.amount, cc.max_uses,
         cc.uses_count, cc.is_active, cc.expires_at, cc.category_ids, cc.created_at,
         (r.first_name || ' ' || r.last_name) AS rider_name
       FROM comp_codes cc
       LEFT JOIN riders r ON cc.rider_id = r.id
       WHERE cc.event_id = ?
       ORDER BY cc.created_at ASC`,
    )
    .all(eventId) as any[];

  return res.json(
    rows.map((r: any) => ({
      id: r.id,
      eventId: r.event_id ?? null,
      clubId: r.club_id ?? null,
      riderId: r.rider_id ?? null,
      riderName: r.rider_name ?? null,
      code: r.code,
      discountType: r.discount_type,
      amount: Number(r.amount),
      maxUses: r.max_uses,
      usesCount: r.uses_count,
      isActive: r.is_active === 1,
      expiresAt: r.expires_at ?? null,
      categoryIds: r.category_ids ? JSON.parse(r.category_ids) : [],
      createdAt: r.created_at,
    })),
  );
});

// POST /events/:eventId/comp-codes
router.post("/events/:eventId/comp-codes", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const eventId = Number(req.params.eventId);
  const { amount, count, discountType = "fixed", maxUses, expiresAt, code: customCode } = req.body;

  if (discountType !== "fixed" && discountType !== "percentage") {
    return res.status(400).json({ error: "discountType must be fixed or percentage" });
  }
  if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: "amount required and must be > 0" });
  }
  if (discountType === "percentage" && Number(amount) > 100) {
    return res.status(400).json({ error: "Percentage discount cannot exceed 100%" });
  }

  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const maxUsesNum = parseMaxUses(maxUses);
  if (maxUsesNum === undefined) {
    return res.status(400).json({ error: "maxUses must be a whole number of 1 or more (or -1 for unlimited)" });
  }
  if (expiresAt && isNaN(new Date(String(expiresAt)).getTime())) {
    return res.status(400).json({ error: "Invalid expiry date" });
  }
  const expiresAtVal = expiresAt ? String(expiresAt) : null;

  const db = getDb();

  const ev = eventClub(eventId);
  if (!ev) return res.status(404).json({ error: "Event not found" });
  if (ev.club_id != null && ev.club_id !== clubId) return res.status(403).json({ error: "Forbidden" });

  const insert = db.prepare(
    `INSERT INTO comp_codes
       (event_id, club_id, code, discount_type, amount, max_uses, uses_count, is_active, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)`,
  );

  if (customCode) {
    const codeStr = String(customCode).trim().toUpperCase();
    if (!codeStr) return res.status(400).json({ error: "Code string cannot be empty" });
    try {
      insert.run(eventId, clubId, codeStr, discountType, String(amount), maxUsesNum, expiresAtVal);
      return res.status(201).json({ codes: [codeStr], amount: Number(amount), discountType });
    } catch (err: any) {
      if (err?.message?.includes("UNIQUE")) {
        return res.status(409).json({ error: "A code with that string already exists" });
      }
      throw err;
    }
  }

  const numCodes = Math.min(Math.max(Number(count) || 1, 1), 100);
  const generated: string[] = [];
  let attempts = 0;

  while (generated.length < numCodes && attempts < numCodes * 10) {
    attempts++;
    const code = generateCode();
    try {
      insert.run(eventId, clubId, code, discountType, String(amount), maxUsesNum, expiresAtVal);
      generated.push(code);
    } catch {
      // collision — retry
    }
  }

  return res.status(201).json({ codes: generated, amount: Number(amount), discountType });
});

// POST /public/events/:eventId/validate-comp-code — check code validity without consuming it
router.post("/public/events/:eventId/validate-comp-code", (req, res) => {
  const eventId = Number(req.params.eventId);
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });

  // Same lookup, rules and response shape as the cloud: the event's own code first,
  // then a club-wide code of this event's club; failures are 4xx with `error`.
  const db = getDb();
  const codeStr = String(code).trim().toUpperCase();
  const ev = eventClub(eventId);
  if (!ev) return res.status(404).json({ valid: false, error: "Invalid discount code" });
  let row = db
    .prepare("SELECT * FROM comp_codes WHERE code = ? AND event_id = ? LIMIT 1")
    .get(codeStr, eventId) as any;
  if (!row && ev.club_id != null) {
    row = db
      .prepare("SELECT * FROM comp_codes WHERE code = ? AND event_id IS NULL AND club_id = ? LIMIT 1")
      .get(codeStr, ev.club_id) as any;
  }

  if (!row) return res.status(404).json({ valid: false, error: "Invalid discount code" });
  if (!row.is_active) {
    return res.status(409).json({ valid: false, error: "This discount code is no longer active" });
  }
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return res.status(409).json({ valid: false, error: "This discount code has expired" });
  }
  if (row.uses_count >= row.max_uses) {
    return res.status(409).json({ valid: false, error: "This discount code has already been used" });
  }
  let catIds: number[] = [];
  try { catIds = (JSON.parse(row.category_ids || "[]") as unknown[]).map(Number); } catch { catIds = []; }
  if (catIds.length > 0 && (ev.entry_fee_category_id == null || !catIds.includes(Number(ev.entry_fee_category_id)))) {
    return res.status(409).json({ valid: false, error: "This discount code is not valid for this event's entry fee" });
  }

  return res.json({
    valid: true,
    amount: Number(row.amount),
    discountType: row.discount_type,
    riderSpecific: !!row.rider_id,
  });
});

// GET /clubs/:clubId/riders/:riderId/discount-code — the rider's club-wide
// discount code, or null. Same shape as the cloud: one object, not a list.
router.get("/clubs/:clubId/riders/:riderId/discount-code", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = Number(req.params.clubId);
  if (clubId !== getClubId(req)) return res.status(403).json({ error: "Forbidden" });
  const riderId = Number(req.params.riderId);
  const db = getDb();

  const rider = db
    .prepare("SELECT first_name, last_name FROM riders WHERE id = ?")
    .get(riderId) as { first_name: string; last_name: string } | undefined;
  if (!rider) return res.status(404).json({ error: "Rider not found" });

  const row = db
    .prepare(
      `SELECT * FROM comp_codes
       WHERE event_id IS NULL AND club_id = ? AND rider_id = ?
       ORDER BY created_at ASC, id ASC LIMIT 1`,
    )
    .get(clubId, riderId) as any;
  if (!row) return res.json(null);

  return res.json({
    id: row.id,
    code: row.code,
    amount: Number(row.amount),
    maxUses: row.max_uses,
    usesCount: row.uses_count,
    createdAt: row.created_at,
    riderId: row.rider_id,
    riderName: `${rider.first_name} ${rider.last_name}`,
  });
});

// POST /clubs/:clubId/riders/:riderId/discount-code — assign a comp code to a specific rider
router.post("/clubs/:clubId/riders/:riderId/discount-code", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  if (Number(req.params.clubId) !== clubId) return res.status(403).json({ error: "Forbidden" });

  const riderId = Number(req.params.riderId);
  const { amount, discountType = "fixed", expiresAt, code: customCode } = req.body;

  if (discountType !== "fixed" && discountType !== "percentage") {
    return res.status(400).json({ error: "discountType must be fixed or percentage" });
  }
  if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: "amount required and must be > 0" });
  }
  if (discountType === "percentage" && Number(amount) > 100) {
    return res.status(400).json({ error: "Percentage discount cannot exceed 100%" });
  }
  if (!riderUsableByClub(riderId, clubId)) return res.status(404).json({ error: "Rider not found" });

  const db = getDb();
  const code = customCode ? String(customCode).trim().toUpperCase() : generateCode();

  try {
    const result = db
      .prepare(
        `INSERT INTO comp_codes
           (club_id, rider_id, code, discount_type, amount, max_uses, uses_count, is_active, expires_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, 1, ?)`,
      )
      .run(clubId, riderId, code, discountType, String(amount), expiresAt ?? null);

    const row = db
      .prepare("SELECT * FROM comp_codes WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as any;
    return res.status(201).json({
      id: row.id,
      eventId: row.event_id ?? null,
      clubId: row.club_id ?? null,
      riderId: row.rider_id ?? null,
      code: row.code,
      discountType: row.discount_type,
      amount: Number(row.amount),
      maxUses: row.max_uses,
      usesCount: row.uses_count,
      isActive: row.is_active === 1,
      expiresAt: row.expires_at ?? null,
      createdAt: row.created_at,
    });
  } catch (err: any) {
    if (err?.message?.includes("UNIQUE")) {
      return res.status(409).json({ error: "A code with that string already exists" });
    }
    throw err;
  }
});

// DELETE /clubs/:clubId/riders/:riderId/discount-code — deactivate rider-specific comp codes
router.delete("/clubs/:clubId/riders/:riderId/discount-code", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  if (Number(req.params.clubId) !== clubId) return res.status(403).json({ error: "Forbidden" });

  const riderId = Number(req.params.riderId);
  const db = getDb();

  db.prepare("UPDATE comp_codes SET is_active = 0 WHERE rider_id = ? AND club_id = ?")
    .run(riderId, clubId);

  return res.json({ ok: true });
});

export default router;
