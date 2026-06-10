import { Router } from "express";
import { db } from "@workspace/db";
import { compCodesTable, eventsTable, ridersTable, clubsTable } from "@workspace/db";
import { eq, and, isNull, sql } from "drizzle-orm";
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
  const codes = await db
    .select({
      id: compCodesTable.id,
      code: compCodesTable.code,
      amount: compCodesTable.amount,
      discountType: compCodesTable.discountType,
      maxUses: compCodesTable.maxUses,
      usesCount: compCodesTable.usesCount,
      isActive: compCodesTable.isActive,
      expiresAt: compCodesTable.expiresAt,
      categoryIds: compCodesTable.categoryIds,
      createdAt: compCodesTable.createdAt,
      riderId: compCodesTable.riderId,
      riderFirstName: ridersTable.firstName,
      riderLastName: ridersTable.lastName,
    })
    .from(compCodesTable)
    .leftJoin(ridersTable, eq(compCodesTable.riderId, ridersTable.id))
    .where(eq(compCodesTable.eventId, eventId))
    .orderBy(compCodesTable.createdAt);

  return res.json(codes.map(c => ({
    id: c.id,
    code: c.code,
    amount: Number(c.amount),
    discountType: c.discountType,
    maxUses: c.maxUses,
    usesCount: c.usesCount,
    isActive: c.isActive,
    expiresAt: c.expiresAt?.toISOString() ?? null,
    categoryIds: c.categoryIds ?? [],
    createdAt: c.createdAt.toISOString(),
    riderId: c.riderId ?? null,
    riderName: c.riderFirstName ? `${c.riderFirstName} ${c.riderLastName}` : null,
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
  return res.json({ valid: true, amount: result.amount, discountType: result.discountType, riderSpecific: !!row.riderId });
});

// ── Organizer: get rider's current discount code ──────────────────────────────
router.get("/clubs/:clubId/riders/:riderId/discount-code", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = Number(req.params.clubId);
  const riderId = Number(req.params.riderId);

  const [rider] = await db.select({ firstName: ridersTable.firstName, lastName: ridersTable.lastName })
    .from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider) return res.status(404).json({ error: "Rider not found" });

  const [codeRow] = await db.select().from(compCodesTable).where(
    and(
      isNull(compCodesTable.eventId),
      eq(compCodesTable.clubId, clubId),
      eq(compCodesTable.riderId, riderId)
    )
  ).orderBy(compCodesTable.createdAt);

  if (!codeRow) return res.json(null);

  return res.json({
    id: codeRow.id,
    code: codeRow.code,
    amount: Number(codeRow.amount),
    maxUses: codeRow.maxUses,
    usesCount: codeRow.usesCount,
    createdAt: codeRow.createdAt.toISOString(),
    riderId: codeRow.riderId,
    riderName: `${rider.firstName} ${rider.lastName}`,
  });
});

// ── Organizer: generate a rider-specific discount code ────────────────────────
router.post("/clubs/:clubId/riders/:riderId/discount-code", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = Number(req.params.clubId);
  const riderId = Number(req.params.riderId);
  const { amount } = req.body;

  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: "amount required and must be > 0" });

  const [club] = await db.select({ id: clubsTable.id }).from(clubsTable).where(eq(clubsTable.id, clubId));
  if (!club) return res.status(404).json({ error: "Club not found" });

  const [rider] = await db.select({ id: ridersTable.id, firstName: ridersTable.firstName, lastName: ridersTable.lastName })
    .from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider) return res.status(404).json({ error: "Rider not found" });

  // Check if an active (unused) code already exists
  const [existing] = await db.select().from(compCodesTable).where(
    and(
      isNull(compCodesTable.eventId),
      eq(compCodesTable.clubId, clubId),
      eq(compCodesTable.riderId, riderId)
    )
  );
  if (existing) {
    return res.status(409).json({ error: "This rider already has a discount code. Delete it first before generating a new one." });
  }

  // Generate unique code
  let attempts = 0;
  while (attempts < 20) {
    attempts++;
    const candidate = generateCode();
    try {
      const [row] = await db.insert(compCodesTable).values({
        clubId,
        riderId,
        code: candidate,
        amount: String(Number(amount)),
        maxUses: 1,
        usesCount: 0,
      }).returning();
      if (row) {
        return res.status(201).json({
          id: row.id,
          code: row.code,
          amount: Number(row.amount),
          maxUses: row.maxUses,
          usesCount: row.usesCount,
          createdAt: row.createdAt.toISOString(),
          riderId: row.riderId,
          riderName: `${rider.firstName} ${rider.lastName}`,
        });
      }
    } catch {
      // collision — retry
    }
  }

  return res.status(500).json({ error: "Failed to generate a unique code, please try again" });
});

// ── Organizer: delete a rider's discount code ─────────────────────────────────
router.delete("/clubs/:clubId/riders/:riderId/discount-code", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = Number(req.params.clubId);
  const riderId = Number(req.params.riderId);

  const [existing] = await db.select({ id: compCodesTable.id }).from(compCodesTable).where(
    and(
      isNull(compCodesTable.eventId),
      eq(compCodesTable.clubId, clubId),
      eq(compCodesTable.riderId, riderId)
    )
  );

  if (!existing) return res.status(404).json({ error: "No discount code found for this rider" });

  await db.delete(compCodesTable).where(eq(compCodesTable.id, existing.id));

  return res.json({ ok: true });
});

export default router;
