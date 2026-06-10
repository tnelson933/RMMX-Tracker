import { Router } from "express";
import { db } from "@workspace/db";
import { clubsTable, usersTable, practiceSessionsTable, practiceCrossingsTable } from "@workspace/db";
import type { GateConfig } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

function requireAdmin(req: any, res: any, next: any) {
  if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
  if ((req as any).sessionUser?.role !== "super_admin") return res.status(403).json({ error: "Forbidden: super_admin only" });
  next();
}

router.get("/clubs", async (req, res) => {
  const clubs = await db.select().from(clubsTable).orderBy(clubsTable.name);
  return res.json(clubs.map(c => ({ ...c, createdAt: c.createdAt.toISOString() })));
});

router.post("/clubs", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const { name, state, contactEmail, contactPhone, logoUrl, website, description } = req.body;
  if (!name || !state) return res.status(400).json({ error: "name and state required" });

  const [club] = await db.insert(clubsTable).values({ name, state, contactEmail, contactPhone, logoUrl, website, description }).returning();
  return res.status(201).json({ ...club, createdAt: club.createdAt.toISOString() });
});

// GET /clubs/gate-settings — MUST be before /clubs/:clubId to avoid param capture
router.get("/clubs/gate-settings", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, session.userId));
  if (!user?.clubId) return res.status(404).json({ error: "No club assigned to this account" });

  const [club] = await db.select({ gateSeeding: clubsTable.gateSeeding })
    .from(clubsTable).where(eq(clubsTable.id, user.clubId));
  if (!club) return res.status(404).json({ error: "Club not found" });

  const gateConfigs = (club.gateSeeding as GateConfig[] | null) ?? [];

  // Check if club has any practice sessions with recorded lap times
  const sessions = await db
    .select({ id: practiceSessionsTable.id })
    .from(practiceSessionsTable)
    .where(eq(practiceSessionsTable.clubId, user.clubId));

  let hasPracticeData = false;
  if (sessions.length > 0) {
    const sessionIds = sessions.map(s => s.id);
    const [crossing] = await db
      .select({ id: practiceCrossingsTable.id })
      .from(practiceCrossingsTable)
      .where(eq(practiceCrossingsTable.sessionId, sessionIds[0]))
      .limit(1);
    // Quick check: if any crossing with valid lap time exists, there's practice data
    if (!crossing) {
      // Check all sessions
      for (const s of sessions) {
        const [c] = await db
          .select({ id: practiceCrossingsTable.id })
          .from(practiceCrossingsTable)
          .where(eq(practiceCrossingsTable.sessionId, s.id))
          .limit(1);
        if (c) { hasPracticeData = true; break; }
      }
    } else {
      hasPracticeData = true;
    }
  }

  return res.json({ gateConfigs, hasPracticeData });
});

// PATCH /clubs/gate-settings — MUST be before /clubs/:clubId
router.patch("/clubs/gate-settings", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, session.userId));
  if (!user?.clubId) return res.status(404).json({ error: "No club assigned to this account" });

  const { gateConfigs } = req.body as { gateConfigs: GateConfig[] };
  if (!Array.isArray(gateConfigs)) return res.status(400).json({ error: "gateConfigs must be an array" });

  const [club] = await db.update(clubsTable)
    .set({ gateSeeding: gateConfigs })
    .where(eq(clubsTable.id, user.clubId))
    .returning({ gateSeeding: clubsTable.gateSeeding });

  return res.json({ gateConfigs: (club.gateSeeding as GateConfig[] | null) ?? [] });
});

router.get("/clubs/:clubId", async (req, res) => {
  const id = Number(req.params.clubId);
  const clubs = await db.select().from(clubsTable).where(eq(clubsTable.id, id));
  if (!clubs[0]) return res.status(404).json({ error: "Not found" });
  const c = clubs[0];
  return res.json({ ...c, createdAt: c.createdAt.toISOString() });
});

export default router;
