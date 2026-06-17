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

// GET /events/:eventId/comp-codes
router.get("/events/:eventId/comp-codes", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const eventId = Number(req.params.eventId);
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

  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "amount required and must be > 0" });
  }
  if (discountType === "percentage" && Number(amount) > 100) {
    return res.status(400).json({ error: "Percentage discount cannot exceed 100%" });
  }

  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const maxUsesNum = maxUses === -1 ? 999999 : Math.max(1, Number(maxUses) || 1);
  const expiresAtVal = expiresAt ? String(expiresAt) : null;

  const db = getDb();

  const event = db
    .prepare("SELECT id FROM events WHERE id = ?")
    .get(eventId) as { id: number } | undefined;
  if (!event) return res.status(404).json({ error: "Event not found" });

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

  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM comp_codes
       WHERE code = ? AND (event_id = ? OR event_id IS NULL) AND is_active = 1 LIMIT 1`,
    )
    .get(String(code).trim().toUpperCase(), eventId) as any;

  if (!row) return res.json({ valid: false, message: "Code not found or inactive" });
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return res.json({ valid: false, message: "Code has expired" });
  }
  if (row.uses_count >= row.max_uses) {
    return res.json({ valid: false, message: "Code has reached its usage limit" });
  }

  return res.json({
    valid: true,
    discountType: row.discount_type,
    amount: Number(row.amount),
    categoryIds: row.category_ids ? JSON.parse(row.category_ids) : [],
  });
});

// GET /clubs/:clubId/riders/:riderId/discount-code — rider-specific comp codes
router.get("/clubs/:clubId/riders/:riderId/discount-code", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const riderId = Number(req.params.riderId);
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT cc.*, (r.first_name || ' ' || r.last_name) AS rider_name
       FROM comp_codes cc
       LEFT JOIN riders r ON cc.rider_id = r.id
       WHERE cc.rider_id = ? AND cc.is_active = 1`,
    )
    .all(riderId) as any[];

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

// POST /clubs/:clubId/riders/:riderId/discount-code — assign a comp code to a specific rider
router.post("/clubs/:clubId/riders/:riderId/discount-code", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const riderId = Number(req.params.riderId);
  const { amount, discountType = "fixed", expiresAt, code: customCode } = req.body;

  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "amount required and must be > 0" });
  }

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

  const riderId = Number(req.params.riderId);
  const db = getDb();

  db.prepare("UPDATE comp_codes SET is_active = 0 WHERE rider_id = ? AND club_id = ?")
    .run(riderId, clubId);

  return res.json({ ok: true });
});

export default router;
