import { Router } from "express";
import crypto from "crypto";
import { getDb } from "../db";
import { newDesktopId } from "../lib/desktop-ids";
import { isoTime } from "../lib/cloud-shape";
import { riderUsableByClub } from "./comp-codes";

const MAX_USES_UNLIMITED = 999999;

/** maxUses from the request: -1 = unlimited, otherwise a whole number >= 1. Undefined = invalid. */
function parseMaxUses(raw: unknown): number | undefined {
  const n = Number(raw);
  if (raw === null || raw === "" || typeof raw === "boolean" || !Number.isInteger(n)) return undefined;
  if (n === -1) return MAX_USES_UNLIMITED;
  if (n < 1 || n > MAX_USES_UNLIMITED) return undefined;
  return n;
}

/** Validated category ids, all this club's; a string error otherwise. */
function parseCategoryIds(raw: unknown, clubId: number): number[] | string {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return "categoryIds must be a list";
  const ids = [...new Set(raw.map(Number))];
  if (ids.some(id => !Number.isInteger(id) || id <= 0)) return "categoryIds must be category ids";
  if (ids.length === 0) return [];
  const owned = getDb()
    .prepare(`SELECT id FROM discount_categories WHERE club_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
    .all(clubId, ...ids);
  if (owned.length !== ids.length) return "One or more categories were not found";
  return ids;
}

/** A rider id the club may attach a code to (null clears it); a string error otherwise. */
function parseRiderId(raw: unknown, clubId: number): number | null | string {
  if (raw == null || raw === "") return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return "Invalid rider";
  if (!riderUsableByClub(id, clubId)) return "Rider not found";
  return id;
}

/** An expiry from the request: null clears it; undefined = invalid date. */
function parseExpiresAt(raw: unknown): string | null | undefined {
  if (raw == null || raw === "") return null;
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

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
    expiresAt: isoTime(r.expires_at),
    categoryIds: r.category_ids
      ? (() => { try { return JSON.parse(r.category_ids); } catch { return []; } })()
      : [],
    createdAt: isoTime(r.created_at),
  };
}

// GET /discount-codes
router.get("/discount-codes", (req, res) => {
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

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
       ORDER BY julianday(cc.created_at) ASC, cc.id ASC`,
    )
    .all(...([clubId, ...(filterRiderId ? [filterRiderId] : [])] as any[])) as any[];

  return res.json(rows.map(formatRow));
});

// POST /discount-codes
router.post("/discount-codes", (req, res) => {
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const { code: customCode, discountType = "fixed", amount, maxUses, expiresAt, categoryIds, riderId } = req.body;

  if (discountType !== "fixed" && discountType !== "percentage") {
    return res.status(400).json({ error: "Choose a dollar amount or a percentage discount." });
  }
  const amountNum = Number(amount);
  if (amount == null || amount === "" || !Number.isFinite(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: "Enter an amount greater than $0." });
  }
  if (discountType === "percentage" && amountNum > 100) {
    return res.status(400).json({ error: "A percentage discount can't be more than 100%." });
  }

  const db = getDb();
  const riderIdParsed = parseRiderId(riderId, clubId);
  if (typeof riderIdParsed === "string") return res.status(400).json({ error: riderIdParsed });
  const riderIdNum = riderIdParsed;

  const maxUsesNum = maxUses === undefined ? 1 : parseMaxUses(maxUses);
  if (maxUsesNum === undefined) return res.status(400).json({ error: "Enter how many times the code can be used (1 or more), or choose Unlimited." });

  const categoryIdsParsed = parseCategoryIds(categoryIds, clubId);
  if (typeof categoryIdsParsed === "string") return res.status(400).json({ error: categoryIdsParsed });

  const expiresAtValue = parseExpiresAt(expiresAt);
  if (expiresAtValue === undefined) return res.status(400).json({ error: "Enter a valid expiry date." });

  const codeTaken = db.prepare("SELECT id FROM comp_codes WHERE code = ?");
  let codeStr: string;
  if (customCode) {
    codeStr = String(customCode).trim().toUpperCase();
    if (!codeStr) return res.status(400).json({ error: "Enter a code." });
  } else {
    codeStr = generateCode();
    let attempts = 0;
    while (attempts < 20) {
      if (!codeTaken.get(codeStr)) break;
      codeStr = generateCode();
      attempts++;
    }
  }
  // Codes are unique (the website's database enforces it across RM Roost).
  if (codeTaken.get(codeStr)) return res.status(409).json({ error: "That code is already in use. Pick a different code." });

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
        `INSERT INTO comp_codes (id, club_id, code, discount_type, amount, max_uses, uses_count,
           is_active, expires_at, category_ids, rider_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?)`,
      )
      .run(
        newDesktopId(db, "comp_codes"),
        clubId,
        codeStr,
        discountType,
        amountNum.toFixed(2),
        maxUsesNum,
        expiresAtValue,
        JSON.stringify(categoryIdsParsed),
        riderIdNum,
        new Date().toISOString(),
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
      return res.status(409).json({ error: "That code is already in use. Pick a different code." });
    }
    throw err;
  }
});

// PATCH /discount-codes/:codeId
router.patch("/discount-codes/:codeId", (req, res) => {
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const codeId = Number(req.params.codeId);
  const db = getDb();
  const notFound = { error: "This discount code couldn't be found. It may have been deleted. Refresh the page and try again." };
  if (!Number.isInteger(codeId) || codeId <= 0) return res.status(404).json(notFound);
  const current = db.prepare("SELECT * FROM comp_codes WHERE id = ? AND club_id = ?").get(codeId, clubId) as any;
  if (!current) return res.status(404).json(notFound);

  // The website's checks and messages, in its order.
  const fields: string[] = [];
  const values: unknown[] = [];

  if (req.body.isActive !== undefined) {
    if (typeof req.body.isActive !== "boolean") return res.status(400).json({ error: "Something was missing from that request. Refresh the page and try again." });
    fields.push("is_active = ?");
    values.push(req.body.isActive ? 1 : 0);
  }
  let effectiveType: string = current.discount_type;
  if (req.body.discountType !== undefined) {
    if (req.body.discountType !== "fixed" && req.body.discountType !== "percentage") {
      return res.status(400).json({ error: "Choose a dollar amount or a percentage discount." });
    }
    effectiveType = req.body.discountType;
    fields.push("discount_type = ?");
    values.push(req.body.discountType);
  }
  let amt = Number(current.amount);
  if (req.body.amount !== undefined) {
    amt = Number(req.body.amount);
    if (req.body.amount === null || req.body.amount === "" || !Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "Enter an amount greater than $0." });
    }
    fields.push("amount = ?");
    values.push(amt.toFixed(2));
  }
  // The percentage cap applies to the type the code will have after this change.
  if (effectiveType === "percentage" && amt > 100) return res.status(400).json({ error: "A percentage discount can't be more than 100%." });
  if (req.body.maxUses !== undefined) {
    const parsed = parseMaxUses(req.body.maxUses);
    if (parsed === undefined) return res.status(400).json({ error: "Enter how many times the code can be used (1 or more), or choose Unlimited." });
    fields.push("max_uses = ?");
    values.push(parsed);
  }
  if ("riderId" in req.body) {
    const parsed = parseRiderId(req.body.riderId, clubId);
    if (typeof parsed === "string") return res.status(400).json({ error: parsed });
    fields.push("rider_id = ?");
    values.push(parsed);
  }
  if (req.body.expiresAt !== undefined) {
    const parsed = parseExpiresAt(req.body.expiresAt);
    if (parsed === undefined) return res.status(400).json({ error: "Enter a valid expiry date." });
    fields.push("expires_at = ?");
    values.push(parsed);
  }
  if (req.body.categoryIds !== undefined) {
    const parsed = parseCategoryIds(req.body.categoryIds, clubId);
    if (typeof parsed === "string") return res.status(400).json({ error: parsed });
    fields.push("category_ids = ?");
    values.push(JSON.stringify(parsed));
  }

  if (fields.length === 0) return res.status(400).json({ error: "Nothing was changed. Edit a field, then save." });

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

  if (!row) return res.status(404).json({ error: "This discount code couldn't be found. It may have been deleted. Refresh the page and try again." });
  return res.json(formatRow(row));
});

// GET /discount-codes/:codeId/usage
router.get("/discount-codes/:codeId/usage", (req, res) => {
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const codeId = Number(req.params.codeId);
  const db = getDb();

  const codeRow = db
    .prepare("SELECT code FROM comp_codes WHERE id = ? AND club_id = ?")
    .get(codeId, clubId) as any;
  if (!codeRow) return res.status(404).json({ error: "This discount code couldn't be found. It may have been deleted. Refresh the page and try again." });

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
       WHERE r.comp_code = ? AND r.status != 'void'
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
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const codeId = Number(req.params.codeId);
  const db = getDb();

  const existing = db
    .prepare("SELECT id FROM comp_codes WHERE id = ? AND club_id = ?")
    .get(codeId, clubId);
  if (!existing) return res.status(404).json({ error: "This discount code couldn't be found. It may have been deleted. Refresh the page and try again." });

  db.prepare("DELETE FROM comp_codes WHERE id = ? AND club_id = ?").run(codeId, clubId);
  return res.json({ ok: true });
});

export default router;
