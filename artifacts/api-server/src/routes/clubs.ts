import { Router } from "express";
import { db } from "@workspace/db";
import { clubsTable, usersTable, practiceSessionsTable, practiceCrossingsTable, discountCategoriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

function requireAdmin(req: any, res: any, next: any) {
  if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
  if ((req as any).sessionUser?.role !== "super_admin") return res.status(403).json({ error: "Forbidden: super_admin only" });
  next();
}

router.get("/clubs", async (req, res) => {
  const staffCId: number | null = typeof (res as any).locals?.staffClubId === "number" ? (res as any).locals.staffClubId : null;
  if (staffCId !== null) {
    const clubs = await db.select().from(clubsTable).where(eq(clubsTable.id, staffCId));
    return res.json(clubs.map(c => ({ ...c, createdAt: c.createdAt.toISOString() })));
  }
  const clubs = await db.select().from(clubsTable).orderBy(clubsTable.name);
  return res.json(clubs.map(c => ({ ...c, createdAt: c.createdAt.toISOString() })));
});

router.post("/clubs", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const { name, state, contactEmail, contactPhone, logoUrl, website, description } = req.body;
  if (!name || !state) return res.status(400).json({ error: "name and state required" });

  const [club] = await db.insert(clubsTable).values({ name, state, contactEmail, contactPhone, logoUrl, website, description }).returning();

  // Seed the built-in "Entry Fees" category for every new club
  await db.insert(discountCategoriesTable).values({ clubId: club.id, name: "Entry Fees" }).onConflictDoNothing();

  return res.status(201).json({ ...club, createdAt: club.createdAt.toISOString() });
});

router.get("/clubs/:clubId", async (req, res) => {
  const id = Number(req.params.clubId);
  const staffCId: number | null = typeof (res as any).locals?.staffClubId === "number" ? (res as any).locals.staffClubId : null;
  if (staffCId !== null && staffCId !== id) return res.status(403).json({ error: "Forbidden" });
  const clubs = await db.select().from(clubsTable).where(eq(clubsTable.id, id));
  if (!clubs[0]) return res.status(404).json({ error: "Not found" });
  const c = clubs[0];
  return res.json({ ...c, createdAt: c.createdAt.toISOString() });
});

router.patch("/clubs/:clubId", async (req, res) => {
  const id = Number(req.params.clubId);
  const staffCId: number | null = typeof (res as any).locals?.staffClubId === "number" ? (res as any).locals.staffClubId : null;
  if (staffCId !== null && staffCId !== id) return res.status(403).json({ error: "Forbidden" });
  if (!req.session || !(req.session as any).userId) return res.status(401).json({ error: "Unauthorized" });

  const { name, state, contactEmail, contactPhone, logoUrl, website, description, autoDnfEnabled, autoDnfThreshold } = req.body;
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (state !== undefined) updates.state = state;
  if (contactEmail !== undefined) updates.contactEmail = contactEmail;
  if (contactPhone !== undefined) updates.contactPhone = contactPhone;
  if (logoUrl !== undefined) updates.logoUrl = logoUrl;
  if (website !== undefined) updates.website = website;
  if (description !== undefined) updates.description = description;
  if (autoDnfEnabled !== undefined) updates.autoDnfEnabled = !!autoDnfEnabled;
  if (autoDnfThreshold !== undefined) updates.autoDnfThreshold = Math.min(100, Math.max(1, Number(autoDnfThreshold)));

  const [updated] = await db.update(clubsTable).set(updates as any).where(eq(clubsTable.id, id)).returning();
  if (!updated) return res.status(404).json({ error: "Not found" });
  return res.json({ ...updated, createdAt: updated.createdAt.toISOString() });
});

export default router;
