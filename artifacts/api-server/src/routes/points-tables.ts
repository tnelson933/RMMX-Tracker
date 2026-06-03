import { Router } from "express";
import { db } from "@workspace/db";
import { pointsTablesTable, usersTable } from "@workspace/db";
import { eq, isNull, or } from "drizzle-orm";

const router = Router();

router.get("/points-tables", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  const userClubId = user?.clubId ?? null;

  const tables = await db.select().from(pointsTablesTable)
    .where(userClubId
      ? or(isNull(pointsTablesTable.clubId), eq(pointsTablesTable.clubId, userClubId))
      : isNull(pointsTablesTable.clubId)
    )
    .orderBy(pointsTablesTable.isSystemDefault, pointsTablesTable.createdAt);

  return res.json(tables.map(t => ({
    ...t,
    pointsScale: t.pointsScale as number[],
    createdAt: t.createdAt.toISOString(),
  })));
});

router.post("/points-tables", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  const userClubId = user?.clubId;
  if (!userClubId) return res.status(403).json({ error: "No club associated with this account" });

  const { name, description, scoringMethod, mainEventOnly, pointsScale } = req.body;
  if (!name || !scoringMethod || !Array.isArray(pointsScale)) {
    return res.status(400).json({ error: "name, scoringMethod, and pointsScale are required" });
  }

  const [table] = await db.insert(pointsTablesTable).values({
    clubId: userClubId,
    name,
    description: description || "",
    scoringMethod,
    mainEventOnly: !!mainEventOnly,
    pointsScale,
    isSystemDefault: false,
  }).returning();

  return res.status(201).json({
    ...table,
    pointsScale: table.pointsScale as number[],
    createdAt: table.createdAt.toISOString(),
  });
});

router.patch("/points-tables/:tableId", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const tableId = Number(req.params.tableId);
  const [existing] = await db.select().from(pointsTablesTable).where(eq(pointsTablesTable.id, tableId));
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (existing.isSystemDefault) return res.status(403).json({ error: "System default tables cannot be edited" });

  const { name, description, scoringMethod, mainEventOnly, pointsScale } = req.body;
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (scoringMethod !== undefined) updates.scoringMethod = scoringMethod;
  if (mainEventOnly !== undefined) updates.mainEventOnly = mainEventOnly;
  if (pointsScale !== undefined) updates.pointsScale = pointsScale;

  const [updated] = await db.update(pointsTablesTable).set(updates as any).where(eq(pointsTablesTable.id, tableId)).returning();
  return res.json({
    ...updated,
    pointsScale: updated.pointsScale as number[],
    createdAt: updated.createdAt.toISOString(),
  });
});

router.delete("/points-tables/:tableId", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const tableId = Number(req.params.tableId);
  const [existing] = await db.select().from(pointsTablesTable).where(eq(pointsTablesTable.id, tableId));
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (existing.isSystemDefault) return res.status(403).json({ error: "System default tables cannot be deleted" });

  await db.delete(pointsTablesTable).where(eq(pointsTablesTable.id, tableId));
  return res.status(204).end();
});

export default router;
