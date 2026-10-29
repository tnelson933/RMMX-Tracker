import { Router } from "express";
import { db } from "@workspace/db";
import { compCodesTable, eventsTable, usersTable, registrationsTable, ridersTable, discountCategoriesTable } from "@workspace/db";
import { eq, and, inArray, ne } from "drizzle-orm";
import crypto from "crypto";

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

async function getClubId(userId: number): Promise<number | null> {
  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  return user?.clubId ?? null;
}

/**
 * True when the rider is visible to this club: added by the club (riders.club_id)
 * or registered for any of the club's events. Same rule as comp-codes.ts.
 */
async function riderBelongsToClub(riderId: number, clubId: number): Promise<boolean> {
  const [direct] = await db.select({ id: ridersTable.id }).from(ridersTable)
    .where(and(eq(ridersTable.id, riderId), eq(ridersTable.clubId, clubId)))
    .limit(1);
  if (direct) return true;
  const [reg] = await db.select({ id: registrationsTable.id }).from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .where(and(eq(registrationsTable.riderId, riderId), eq(eventsTable.clubId, clubId)))
    .limit(1);
  return !!reg;
}

const MAX_USES_UNLIMITED = 999999;

/** maxUses from the request: -1 = unlimited, otherwise a whole number >= 1. Undefined = invalid. */
function parseMaxUses(raw: unknown): number | undefined {
  const n = Number(raw);
  if (raw === null || raw === "" || typeof raw === "boolean" || !Number.isInteger(n)) return undefined;
  if (n === -1) return MAX_USES_UNLIMITED;
  if (n < 1 || n > MAX_USES_UNLIMITED) return undefined;
  return n;
}

/** Validated category ids, all owned by the club; a string error otherwise. */
async function parseCategoryIds(raw: unknown, clubId: number): Promise<number[] | string> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return "categoryIds must be a list";
  const ids = [...new Set(raw.map(Number))];
  if (ids.some(id => !Number.isInteger(id) || id <= 0)) return "categoryIds must be category ids";
  if (ids.length === 0) return [];
  const owned = await db.select({ id: discountCategoriesTable.id }).from(discountCategoriesTable)
    .where(and(inArray(discountCategoriesTable.id, ids), eq(discountCategoriesTable.clubId, clubId)));
  if (owned.length !== ids.length) return "One or more categories were not found";
  return ids;
}

/** A rider id the club may attach a code to (null clears it); a string error otherwise. */
async function parseRiderId(raw: unknown, clubId: number): Promise<number | null | string> {
  if (raw == null || raw === "") return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return "Invalid rider";
  if (!(await riderBelongsToClub(id, clubId))) return "Rider not found";
  return id;
}

/** An expiry from the request: null clears it; undefined = invalid date. */
function parseExpiresAt(raw: unknown): Date | null | undefined {
  if (raw == null || raw === "") return null;
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? undefined : d;
}

router.get("/discount-codes", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = await getClubId(userId);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const filterRiderId = req.query.riderId ? Number(req.query.riderId) : null;

  const whereCondition = filterRiderId
    ? and(eq(compCodesTable.clubId, clubId), eq(compCodesTable.riderId, filterRiderId))
    : eq(compCodesTable.clubId, clubId);

  const rows = await db
    .select({
      id: compCodesTable.id,
      clubId: compCodesTable.clubId,
      eventId: compCodesTable.eventId,
      riderId: compCodesTable.riderId,
      code: compCodesTable.code,
      discountType: compCodesTable.discountType,
      amount: compCodesTable.amount,
      maxUses: compCodesTable.maxUses,
      usesCount: compCodesTable.usesCount,
      isActive: compCodesTable.isActive,
      expiresAt: compCodesTable.expiresAt,
      categoryIds: compCodesTable.categoryIds,
      createdAt: compCodesTable.createdAt,
      eventName: eventsTable.name,
      riderFirstName: ridersTable.firstName,
      riderLastName: ridersTable.lastName,
    })
    .from(compCodesTable)
    .leftJoin(eventsTable, eq(compCodesTable.eventId, eventsTable.id))
    .leftJoin(ridersTable, eq(compCodesTable.riderId, ridersTable.id))
    .where(whereCondition)
    .orderBy(compCodesTable.createdAt);

  return res.json(rows.map(r => ({
    id: r.id,
    clubId: r.clubId,
    eventId: r.eventId,
    eventName: r.eventName ?? null,
    riderId: r.riderId ?? null,
    riderName: r.riderFirstName && r.riderLastName ? `${r.riderFirstName} ${r.riderLastName}` : null,
    code: r.code,
    discountType: r.discountType,
    amount: Number(r.amount),
    maxUses: r.maxUses,
    usesCount: r.usesCount,
    isActive: r.isActive,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    categoryIds: (r.categoryIds as number[]) ?? [],
    createdAt: r.createdAt.toISOString(),
  })));
});

router.post("/discount-codes", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = await getClubId(userId);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const { code: customCode, discountType = "fixed", amount, maxUses, expiresAt, categoryIds, riderId } = req.body;

  if (discountType !== "fixed" && discountType !== "percentage") {
    return res.status(400).json({ error: "discountType must be fixed or percentage" });
  }
  const amountNum = Number(amount);
  if (amount == null || amount === "" || !Number.isFinite(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: "Amount required and must be greater than 0" });
  }
  if (discountType === "percentage" && amountNum > 100) {
    return res.status(400).json({ error: "Percentage discount cannot exceed 100%" });
  }

  const riderIdParsed = await parseRiderId(riderId, clubId);
  if (typeof riderIdParsed === "string") return res.status(400).json({ error: riderIdParsed });
  const riderIdNum = riderIdParsed;

  const maxUsesNum = maxUses === undefined ? 1 : parseMaxUses(maxUses);
  if (maxUsesNum === undefined) return res.status(400).json({ error: "maxUses must be a whole number of 1 or more (or -1 for unlimited)" });

  const categoryIdsParsed = await parseCategoryIds(categoryIds, clubId);
  if (typeof categoryIdsParsed === "string") return res.status(400).json({ error: categoryIdsParsed });

  const expiresAtDate = parseExpiresAt(expiresAt);
  if (expiresAtDate === undefined) return res.status(400).json({ error: "Invalid expiry date" });

  let codeStr: string;
  if (customCode) {
    codeStr = String(customCode).trim().toUpperCase();
    if (!codeStr) return res.status(400).json({ error: "Code string cannot be empty" });
  } else {
    let generated = false;
    let attempts = 0;
    codeStr = generateCode();
    while (!generated && attempts < 20) {
      attempts++;
      const [existing] = await db.select({ id: compCodesTable.id })
        .from(compCodesTable).where(eq(compCodesTable.code, codeStr));
      if (!existing) { generated = true; } else { codeStr = generateCode(); }
    }
  }

  let riderName: string | null = null;
  if (riderIdNum) {
    const [riderRow] = await db.select({ firstName: ridersTable.firstName, lastName: ridersTable.lastName })
      .from(ridersTable).where(eq(ridersTable.id, riderIdNum));
    if (riderRow) riderName = `${riderRow.firstName} ${riderRow.lastName}`;
  }

  try {
    const [row] = await db.insert(compCodesTable).values({
      clubId,
      code: codeStr,
      discountType,
      amount: amountNum.toFixed(2),
      maxUses: maxUsesNum,
      usesCount: 0,
      isActive: true,
      expiresAt: expiresAtDate,
      categoryIds: categoryIdsParsed,
      riderId: riderIdNum,
    }).returning();

    return res.status(201).json({
      id: row.id,
      clubId: row.clubId,
      eventId: row.eventId,
      eventName: null,
      riderId: row.riderId ?? null,
      riderName,
      code: row.code,
      discountType: row.discountType,
      amount: Number(row.amount),
      maxUses: row.maxUses,
      usesCount: row.usesCount,
      isActive: row.isActive,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      categoryIds: (row.categoryIds as number[]) ?? [],
      createdAt: row.createdAt.toISOString(),
    });
  } catch (err: any) {
    if (err?.code === "23505") {
      return res.status(409).json({ error: "A code with that string already exists" });
    }
    throw err;
  }
});

router.patch("/discount-codes/:codeId", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = await getClubId(userId);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const codeId = Number(req.params.codeId);
  if (!Number.isInteger(codeId) || codeId <= 0) return res.status(404).json({ error: "Discount code not found" });
  const [current] = await db.select().from(compCodesTable)
    .where(and(eq(compCodesTable.id, codeId), eq(compCodesTable.clubId, clubId)));
  if (!current) return res.status(404).json({ error: "Discount code not found" });

  const updates: Record<string, unknown> = {};
  if (req.body.isActive !== undefined) {
    if (typeof req.body.isActive !== "boolean") return res.status(400).json({ error: "isActive must be true or false" });
    updates.isActive = req.body.isActive;
  }
  if (req.body.discountType !== undefined) {
    if (req.body.discountType !== "fixed" && req.body.discountType !== "percentage") {
      return res.status(400).json({ error: "discountType must be fixed or percentage" });
    }
    updates.discountType = req.body.discountType;
  }
  let amt = Number(current.amount);
  if (req.body.amount !== undefined) {
    amt = Number(req.body.amount);
    if (req.body.amount === null || req.body.amount === "" || !Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "Amount must be greater than 0" });
    }
    updates.amount = amt.toFixed(2);
  }
  // Check the percentage cap against the type the code will have after this change,
  // whether the request changes the type, the amount, or both.
  const effectiveType = (updates.discountType as string | undefined) ?? current.discountType;
  if (effectiveType === "percentage" && amt > 100) return res.status(400).json({ error: "Percentage cannot exceed 100%" });
  if (req.body.maxUses !== undefined) {
    const parsed = parseMaxUses(req.body.maxUses);
    if (parsed === undefined) return res.status(400).json({ error: "maxUses must be a whole number of 1 or more (or -1 for unlimited)" });
    updates.maxUses = parsed;
  }
  if ("riderId" in req.body) {
    const parsed = await parseRiderId(req.body.riderId, clubId);
    if (typeof parsed === "string") return res.status(400).json({ error: parsed });
    updates.riderId = parsed;
  }
  if (req.body.expiresAt !== undefined) {
    const parsed = parseExpiresAt(req.body.expiresAt);
    if (parsed === undefined) return res.status(400).json({ error: "Invalid expiry date" });
    updates.expiresAt = parsed;
  }
  if (req.body.categoryIds !== undefined) {
    const parsed = await parseCategoryIds(req.body.categoryIds, clubId);
    if (typeof parsed === "string") return res.status(400).json({ error: parsed });
    updates.categoryIds = parsed;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Nothing to update" });

  const [row] = await db.update(compCodesTable)
    .set(updates as any)
    .where(and(eq(compCodesTable.id, codeId), eq(compCodesTable.clubId, clubId)))
    .returning();

  if (!row) return res.status(404).json({ error: "Discount code not found" });

  let riderName: string | null = null;
  if (row.riderId) {
    const [riderRow] = await db.select({ firstName: ridersTable.firstName, lastName: ridersTable.lastName })
      .from(ridersTable).where(eq(ridersTable.id, row.riderId));
    if (riderRow) riderName = `${riderRow.firstName} ${riderRow.lastName}`;
  }

  return res.json({
    id: row.id,
    clubId: row.clubId,
    eventId: row.eventId,
    eventName: null,
    riderId: row.riderId ?? null,
    riderName,
    code: row.code,
    discountType: row.discountType,
    amount: Number(row.amount),
    maxUses: row.maxUses,
    usesCount: row.usesCount,
    isActive: row.isActive,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    categoryIds: (row.categoryIds as number[]) ?? [],
    createdAt: row.createdAt.toISOString(),
  });
});

router.get("/discount-codes/:codeId/usage", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = await getClubId(userId);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const codeId = Number(req.params.codeId);

  const [codeRow] = await db.select({ code: compCodesTable.code })
    .from(compCodesTable)
    .where(and(eq(compCodesTable.id, codeId), eq(compCodesTable.clubId, clubId)));

  if (!codeRow) return res.status(404).json({ error: "Discount code not found" });

  const rows = await db
    .select({
      registrationId: registrationsTable.id,
      riderId: registrationsTable.riderId,
      riderFirstName: ridersTable.firstName,
      riderLastName: ridersTable.lastName,
      eventId: registrationsTable.eventId,
      eventName: eventsTable.name,
      raceClass: registrationsTable.raceClass,
      discountAmount: registrationsTable.compDiscount,
      usedAt: registrationsTable.createdAt,
    })
    .from(registrationsTable)
    .innerJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    // Voided entries gave their code use back, so they aren't uses any more.
    // Each entry stores its own share of the discount, so the amounts add up.
    .where(and(eq(registrationsTable.compCode, codeRow.code), ne(registrationsTable.status, "void")))
    .orderBy(registrationsTable.createdAt);

  return res.json(rows.map(r => ({
    registrationId: r.registrationId,
    riderId: r.riderId,
    riderName: `${r.riderFirstName} ${r.riderLastName}`,
    eventId: r.eventId,
    eventName: r.eventName,
    raceClass: r.raceClass,
    discountAmount: Number(r.discountAmount ?? 0),
    usedAt: r.usedAt.toISOString(),
  })));
});

router.delete("/discount-codes/:codeId", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = await getClubId(userId);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const codeId = Number(req.params.codeId);
  const [deleted] = await db.delete(compCodesTable)
    .where(and(eq(compCodesTable.id, codeId), eq(compCodesTable.clubId, clubId)))
    .returning();

  if (!deleted) return res.status(404).json({ error: "Discount code not found" });
  return res.json({ ok: true });
});

export default router;
