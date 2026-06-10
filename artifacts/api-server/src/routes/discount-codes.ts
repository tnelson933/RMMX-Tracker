import { Router } from "express";
import { db } from "@workspace/db";
import { compCodesTable, eventsTable, usersTable, registrationsTable, ridersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
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

  if (amount == null || Number(amount) <= 0) {
    return res.status(400).json({ error: "Amount required and must be greater than 0" });
  }
  if (discountType === "percentage" && Number(amount) > 100) {
    return res.status(400).json({ error: "Percentage discount cannot exceed 100%" });
  }

  const riderIdNum = riderId ? Number(riderId) : null;

  const maxUsesNum = maxUses === -1 ? 999999 : Math.max(1, Number(maxUses) || 1);

  let codeStr: string;
  if (customCode) {
    codeStr = String(customCode).trim().toUpperCase();
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
      discountType: discountType === "percentage" ? "percentage" : "fixed",
      amount: String(amount),
      maxUses: maxUsesNum,
      usesCount: 0,
      isActive: true,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      categoryIds: Array.isArray(categoryIds) ? categoryIds : [],
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
  const updates: Record<string, unknown> = {};
  if (req.body.isActive !== undefined) updates.isActive = req.body.isActive;
  if (req.body.discountType !== undefined) updates.discountType = req.body.discountType;
  if (req.body.amount !== undefined) {
    const amt = Number(req.body.amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: "Amount must be greater than 0" });
    if (req.body.discountType === "percentage" && amt > 100) return res.status(400).json({ error: "Percentage cannot exceed 100%" });
    updates.amount = String(amt);
  }
  if (req.body.maxUses !== undefined) {
    const raw = Number(req.body.maxUses);
    updates.maxUses = raw === -1 ? 999999 : Math.max(1, raw);
  }
  if ("riderId" in req.body) updates.riderId = req.body.riderId ? Number(req.body.riderId) : null;
  if (req.body.expiresAt !== undefined) updates.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  if (req.body.categoryIds !== undefined) updates.categoryIds = Array.isArray(req.body.categoryIds) ? req.body.categoryIds : [];

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
    .where(eq(registrationsTable.compCode, codeRow.code))
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
