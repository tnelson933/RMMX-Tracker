import { Router } from "express";
import { db } from "@workspace/db";
import { compCodesTable, eventsTable } from "@workspace/db";
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

// ── Organizer: generate comp codes ──────────────────────────────────────────
router.post("/events/:eventId/comp-codes", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const eventId = Number(req.params.eventId);
  const { amount, count } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ error: "amount required and must be > 0" });
  const numCodes = Math.min(Math.max(Number(count) || 1, 1), 100);

  const [event] = await db.select({ id: eventsTable.id }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event) return res.status(404).json({ error: "Event not found" });

  const generated: string[] = [];
  let attempts = 0;
  while (generated.length < numCodes && attempts < numCodes * 10) {
    attempts++;
    const code = generateCode();
    try {
      const [row] = await db.insert(compCodesTable).values({
        eventId,
        code,
        amount: String(amount),
        maxUses: 1,
        usesCount: 0,
      }).returning({ code: compCodesTable.code });
      if (row) generated.push(row.code);
    } catch {
      // collision — retry
    }
  }

  return res.status(201).json({ codes: generated, amount: Number(amount) });
});

// ── Organizer: list comp codes for event ─────────────────────────────────────
router.get("/events/:eventId/comp-codes", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const eventId = Number(req.params.eventId);
  const codes = await db.select().from(compCodesTable)
    .where(eq(compCodesTable.eventId, eventId))
    .orderBy(compCodesTable.createdAt);

  return res.json(codes.map(c => ({
    ...c,
    amount: Number(c.amount),
    createdAt: c.createdAt.toISOString(),
  })));
});

// ── Public: validate comp code ───────────────────────────────────────────────
router.post("/public/events/:eventId/validate-comp-code", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });

  const [row] = await db.select().from(compCodesTable).where(
    and(eq(compCodesTable.eventId, eventId), eq(compCodesTable.code, String(code).trim().toUpperCase()))
  );

  if (!row) return res.status(404).json({ valid: false, error: "Invalid comp code" });
  if (row.usesCount >= row.maxUses) return res.status(409).json({ valid: false, error: "This comp code has already been used" });

  return res.json({ valid: true, amount: Number(row.amount) });
});

export default router;
