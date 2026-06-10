import { Router } from "express";
import { db } from "@workspace/db";
import { compCodesTable, usersTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
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

function formatCode(c: typeof compCodesTable.$inferSelect) {
  return {
    id: c.id,
    clubId: c.clubId,
    eventId: c.eventId,
    code: c.code,
    amount: Number(c.amount),
    maxUses: c.maxUses,
    usesCount: c.usesCount,
    isActive: c.isActive,
    expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
    categoryIds: (c.categoryIds as number[]) ?? [],
    createdAt: c.createdAt.toISOString(),
  };
}

router.get("/discount-codes", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = await getClubId(userId);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const codes = await db.select().from(compCodesTable)
    .where(and(eq(compCodesTable.clubId, clubId), isNull(compCodesTable.eventId)))
    .orderBy(compCodesTable.createdAt);

  return res.json(codes.map(formatCode));
});

router.post("/discount-codes", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = await getClubId(userId);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const { code: customCode, amount, maxUses, expiresAt, categoryIds } = req.body;

  if (amount == null || Number(amount) <= 0) {
    return res.status(400).json({ error: "amount required and must be > 0" });
  }

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

  try {
    const [row] = await db.insert(compCodesTable).values({
      clubId,
      code: codeStr,
      amount: String(amount),
      maxUses: maxUsesNum,
      usesCount: 0,
      isActive: true,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      categoryIds: Array.isArray(categoryIds) ? categoryIds : [],
    }).returning();

    return res.status(201).json(formatCode(row));
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
  if (req.body.expiresAt !== undefined) updates.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  if (req.body.categoryIds !== undefined) updates.categoryIds = Array.isArray(req.body.categoryIds) ? req.body.categoryIds : [];

  const [row] = await db.update(compCodesTable)
    .set(updates as any)
    .where(and(eq(compCodesTable.id, codeId), eq(compCodesTable.clubId, clubId)))
    .returning();

  if (!row) return res.status(404).json({ error: "Discount code not found" });
  return res.json(formatCode(row));
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
