import { Router } from "express";
import { db } from "@workspace/db";
import { compCodesTable, eventsTable } from "@workspace/db";
import { eq, and, isNull, sql } from "drizzle-orm";
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

// ── Organizer: generate discount codes for an event ──────────────────────────
router.post("/events/:eventId/comp-codes", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const eventId = Number(req.params.eventId);
  const { amount, count, discountType = "fixed", maxUses, expiresAt } = req.body;

  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "amount required and must be > 0" });
  }
  if (discountType === "percentage" && Number(amount) > 100) {
    return res.status(400).json({ error: "Percentage discount cannot exceed 100%" });
  }

  const numCodes = Math.min(Math.max(Number(count) || 1, 1), 100);
  const maxUsesNum = maxUses === -1 ? 999999 : Math.max(1, Number(maxUses) || 1);
  const expiresAtDate = expiresAt ? new Date(expiresAt) : null;

  const [event] = await db
    .select({ id: eventsTable.id, clubId: eventsTable.clubId })
    .from(eventsTable)
    .where(eq(eventsTable.id, eventId));
  if (!event) return res.status(404).json({ error: "Event not found" });

  const generated: string[] = [];
  let attempts = 0;
  while (generated.length < numCodes && attempts < numCodes * 10) {
    attempts++;
    const code = generateCode();
    try {
      const [row] = await db.insert(compCodesTable).values({
        eventId,
        clubId: event.clubId,
        code,
        discountType: discountType === "percentage" ? "percentage" : "fixed",
        amount: String(amount),
        maxUses: maxUsesNum,
        usesCount: 0,
        expiresAt: expiresAtDate,
      }).returning({ code: compCodesTable.code });
      if (row) generated.push(row.code);
    } catch {
      // collision — retry
    }
  }

  return res.status(201).json({ codes: generated, amount: Number(amount), discountType });
});

// ── Organizer: list discount codes for event ─────────────────────────────────
router.get("/events/:eventId/comp-codes", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const eventId = Number(req.params.eventId);
  const codes = await db.select().from(compCodesTable)
    .where(eq(compCodesTable.eventId, eventId))
    .orderBy(compCodesTable.createdAt);

  return res.json(codes.map(c => ({
    ...c,
    discountType: c.discountType,
    amount: Number(c.amount),
    createdAt: c.createdAt.toISOString(),
    expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
  })));
});

// ── Shared helper: validate a resolved discount code row ──────────────────────
function validateCodeRow(
  row: typeof compCodesTable.$inferSelect,
  categoryId: number | null | undefined,
): { valid: false; error: string; status: number } | { valid: true; amount: number; discountType: string } {
  if (row.isActive === false) {
    return { valid: false, error: "This discount code is no longer active", status: 409 };
  }
  if (row.expiresAt && new Date() > row.expiresAt) {
    return { valid: false, error: "This discount code has expired", status: 409 };
  }
  if (row.usesCount >= row.maxUses) {
    return { valid: false, error: "This discount code has already been used", status: 409 };
  }

  const catIds = (row.categoryIds as number[]) ?? [];
  if (catIds.length > 0) {
    if (categoryId == null || !catIds.includes(Number(categoryId))) {
      return { valid: false, error: "This discount code is not valid for the selected category", status: 409 };
    }
  }

  return { valid: true, amount: Number(row.amount), discountType: row.discountType };
}

// ── Public: validate discount code ───────────────────────────────────────────
router.post("/public/events/:eventId/validate-comp-code", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { code, categoryId } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });

  const codeStr = String(code).trim().toUpperCase();

  let [row] = await db.select().from(compCodesTable).where(
    and(eq(compCodesTable.eventId, eventId), eq(compCodesTable.code, codeStr))
  );

  if (!row) {
    const [event] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
    if (event?.clubId) {
      [row] = await db.select().from(compCodesTable).where(
        and(
          eq(compCodesTable.clubId, event.clubId),
          isNull(compCodesTable.eventId),
          eq(compCodesTable.code, codeStr),
        )
      );
    }
  }

  if (!row) return res.status(404).json({ valid: false, error: "Invalid discount code" });

  const result = validateCodeRow(row, categoryId);
  if (!result.valid) {
    return res.status(result.status).json({ valid: false, error: result.error });
  }
  return res.json({ valid: true, amount: result.amount, discountType: result.discountType });
});

export default router;
