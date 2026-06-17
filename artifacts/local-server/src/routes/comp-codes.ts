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

export default router;
