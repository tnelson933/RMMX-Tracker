import { Router } from "express";
import crypto from "crypto";
import { getDb } from "../db";

const router = Router();

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) {
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

function formatRow(r: any): object {
  return {
    id: r.id,
    clubId: r.club_id,
    eventId: r.event_id ?? null,
    eventName: r.event_name ?? null,
    riderId: r.rider_id ?? null,
    riderName: r.rider_name ?? null,
    code: r.code,
    discountType: r.discount_type,
    amount: Number(r.amount),
    maxUses: r.max_uses,
    usesCount: r.uses_count,
    isActive: r.is_active === 1 || r.is_active === true,
    expiresAt: r.expires_at ?? null,
    categoryIds: r.category_ids
      ? (() => { try { return JSON.parse(r.category_ids); } catch { return []; } })()
      : [],
    createdAt: r.created_at,
  };
}

// GET /discount-codes
router.get("/discount-codes", (req, res) => {
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const filterRiderId = req.query.riderId ? Number(req.query.riderId) : null;

  const rows = db
    .prepare(
      `SELECT
         cc.id, cc.club_id, cc.event_id, cc.rider_id,
         cc.code, cc.discount_type, cc.amount, cc.max_uses,
         cc.uses_count, cc.is_active, cc.expires_at, cc.category_ids, cc.created_at,
         e.name AS event_name,
         (r.first_name || ' ' || r.last_name) AS rider_name
       FROM comp_codes cc
       LEFT JOIN events e ON cc.event_id = e.id
       LEFT JOIN riders r ON cc.rider_id = r.id
       WHERE cc.club_id = ?
         ${filterRiderId ? "AND cc.rider_id = ?" : ""}
       ORDER BY cc.created_at ASC`,
    )
    .all(...([clubId, ...(filterRiderId ? [filterRiderId] : [])] as any[])) as any[];

  return res.json(rows.map(formatRow));
});

// POST /discount-codes
router.post("/discount-codes", (req, res) => {
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const { code: customCode, discountType = "fixed", amount, maxUses, expiresAt, categoryIds, riderId } = req.body;

  if (amount == null || Number(amount) <= 0) {
    return res.status(400).json({ error: "Amount required and must be greater than 0" });
  }
  if (discountType === "percentage" && Number(amount) > 100) {
    return res.status(400).json({ error: "Percentage discount cannot exceed 100%" });
  }

  const db = getDb();
  const riderIdNum = riderId ? Number(riderId) : null;
  const maxUsesNum = maxUses === -1 ? 999999 : Math.max(1, Number(maxUses) || 1);

  let codeStr: string;
  if (customCode) {
    codeStr = String(customCode).trim().toUpperCase();
  } else {
    codeStr = generateCode();
    let attempts = 0;
    while (attempts < 20) {
      const existing = db
        .prepare("SELECT id FROM comp_codes WHERE code = ?")
        .get(codeStr);
      if (!existing) break;
      codeStr = generateCode();
      attempts++;
    }
  }

  let riderName: string | null = null;
  if (riderIdNum) {
    const riderRow = db
      .prepare("SELECT first_name, last_name FROM riders WHERE id = ?")
      .get(riderIdNum) as any;
    if (riderRow) riderName = `${riderRow.first_name} ${riderRow.last_name}`;
  }

  try {
    const result = db
      .prepare(
        `INSERT INTO comp_codes (club_id, code, discount_type, amount, max_uses, uses_count,
           is_active, expires_at, category_ids, rider_id, created_at)
         VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, datetime('now'))`,
      )
      .run(
        clubId,
        codeStr,
        discountType === "percentage" ? "percentage" : "fixed",
        String(amount),
        maxUsesNum,
        expiresAt ? String(expiresAt) : null,
        Array.isArray(categoryIds) ? JSON.stringify(categoryIds) : "[]",
        riderIdNum,
      );

    const row = db
      .prepare(
        `SELECT cc.*, e.name AS event_name FROM comp_codes cc
         LEFT JOIN events e ON cc.event_id = e.id WHERE cc.id = ?`,
      )
      .get(Number(result.lastInsertRowid)) as any;

    if (row) row.rider_name = riderName;

    return res.status(201).json(formatRow(row));
  } catch (err: any) {
    if (err?.code === "SQLITE_CONSTRAINT_UNIQUE" || String(err?.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "A code with that string already exists" });
    }
    throw err;
  }
});

// PATCH /discount-codes/:codeId
router.patch("/discount-codes/:codeId", (req, res) => {
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const codeId = Number(req.params.codeId);
  const db = getDb();

  const fields: string[] = [];
  const values: unknown[] = [];

  if (req.body.isActive !== undefined) {
    fields.push("is_active = ?");
    values.push(req.body.isActive ? 1 : 0);
  }
  if (req.body.discountType !== undefined) {
    fields.push("discount_type = ?");
    values.push(req.body.discountType);
  }
  if (req.body.amount !== undefined) {
    const amt = Number(req.body.amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: "Amount must be greater than 0" });
    if (req.body.discountType === "percentage" && amt > 100) {
      return res.status(400).json({ error: "Percentage cannot exceed 100%" });
    }
    fields.push("amount = ?");
    values.push(String(amt));
  }
  if (req.body.maxUses !== undefined) {
    const raw = Number(req.body.maxUses);
    fields.push("max_uses = ?");
    values.push(raw === -1 ? 999999 : Math.max(1, raw));
  }
  if ("riderId" in req.body) {
    fields.push("rider_id = ?");
    values.push(req.body.riderId ? Number(req.body.riderId) : null);
  }
  if (req.body.expiresAt !== undefined) {
    fields.push("expires_at = ?");
    values.push(req.body.expiresAt ? String(req.body.expiresAt) : null);
  }
  if (req.body.categoryIds !== undefined) {
    fields.push("category_ids = ?");
    values.push(JSON.stringify(Array.isArray(req.body.categoryIds) ? req.body.categoryIds : []));
  }

  if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });

  values.push(codeId, clubId);
  db.prepare(
    `UPDATE comp_codes SET ${fields.join(", ")} WHERE id = ? AND club_id = ?`,
  ).run(...(values as any[]));

  const row = db
    .prepare(
      `SELECT cc.*, e.name AS event_name,
              (r.first_name || ' ' || r.last_name) AS rider_name
       FROM comp_codes cc
       LEFT JOIN events e ON cc.event_id = e.id
       LEFT JOIN riders r ON cc.rider_id = r.id
       WHERE cc.id = ? AND cc.club_id = ?`,
    )
    .get(codeId, clubId) as any;

  if (!row) return res.status(404).json({ error: "Discount code not found" });
  return res.json(formatRow(row));
});

// GET /discount-codes/:codeId/usage
router.get("/discount-codes/:codeId/usage", (req, res) => {
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const codeId = Number(req.params.codeId);
  const db = getDb();

  const codeRow = db
    .prepare("SELECT code FROM comp_codes WHERE id = ? AND club_id = ?")
    .get(codeId, clubId) as any;
  if (!codeRow) return res.status(404).json({ error: "Discount code not found" });

  const rows = db
    .prepare(
      `SELECT
         r.id AS registration_id,
         r.rider_id,
         ri.first_name || ' ' || ri.last_name AS rider_name,
         r.event_id,
         e.name AS event_name,
         r.race_class,
         r.comp_discount AS discount_amount,
         r.created_at AS used_at
       FROM registrations r
       INNER JOIN riders ri ON r.rider_id = ri.id
       INNER JOIN events e ON r.event_id = e.id
       WHERE r.comp_code = ?
       ORDER BY r.created_at ASC`,
    )
    .all(codeRow.code) as any[];

  return res.json(
    rows.map((r: any) => ({
      registrationId: r.registration_id,
      riderId: r.rider_id,
      riderName: r.rider_name,
      eventId: r.event_id,
      eventName: r.event_name,
      raceClass: r.race_class,
      discountAmount: Number(r.discount_amount ?? 0),
      usedAt: r.used_at,
    })),
  );
});

// DELETE /discount-codes/:codeId
router.delete("/discount-codes/:codeId", (req, res) => {
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const codeId = Number(req.params.codeId);
  const db = getDb();

  const existing = db
    .prepare("SELECT id FROM comp_codes WHERE id = ? AND club_id = ?")
    .get(codeId, clubId);
  if (!existing) return res.status(404).json({ error: "Discount code not found" });

  db.prepare("DELETE FROM comp_codes WHERE id = ? AND club_id = ?").run(codeId, clubId);
  return res.json({ ok: true });
});

export default router;
