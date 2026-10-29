import { Router } from "express";
import { db } from "@workspace/db";
import { pointsTablesTable, usersTable, seriesTable, eventsTable } from "@workspace/db";
import { eq, isNull, or } from "drizzle-orm";
import { evaluateFormula } from "../lib/safeFormula";
import { pointsScaleError, scoringMethodError } from "../lib/scoringTables";
import { recalculateSeriesPoints, scoreMotoPoints } from "./results";
import { motosTable } from "@workspace/db";
import { and, inArray, ne } from "drizzle-orm";
import { logger } from "../lib/logger";

/**
 * After a table in use changes, re-score the finished races of events that use
 * it and rebuild the series that use it, so standings follow the new points.
 * Runs in the background; the edit itself is already saved.
 */
function rescoreUsers(tableId: number, clubId: number | null) {
  setImmediate(() => {
    void (async () => {
      try {
        const events = await db.select({ id: eventsTable.id }).from(eventsTable)
          .where(clubId == null ? eq(eventsTable.scoringTableId, tableId)
            : and(eq(eventsTable.scoringTableId, tableId), eq(eventsTable.clubId, clubId)));
        if (events.length > 0) {
          const motos = await db.select({ id: motosTable.id }).from(motosTable).where(and(
            inArray(motosTable.eventId, events.map(e => e.id)),
            eq(motosTable.status, "completed"),
            ne(motosTable.type, "practice"),
          ));
          for (const m of motos) await scoreMotoPoints(m.id);
        }
        const series = await db.select({ id: seriesTable.id }).from(seriesTable)
          .where(eq(seriesTable.scoringTableId, tableId));
        await recalculateSeriesPoints(series.map(s => s.id));
      } catch (err) {
        logger.error({ err, tableId }, "Re-scoring after a points table edit failed");
      }
    })();
  });
}

const router = Router();

/** Reject formulas the points engine can't evaluate, so a bad one doesn't silently score 0. */
function formulaError(formula: unknown): string | null {
  if (formula == null || formula === "") return null;
  if (typeof formula !== "string") return "scoringFormula must be a string";
  try {
    evaluateFormula(formula, { position: 1, riders: 10 });
    return null;
  } catch (err) {
    return `Invalid scoring formula: ${(err as Error).message}. Use position, riders, numbers, + - * / % **, comparisons, ?:, and Math functions.`;
  }
}

router.get("/points-tables", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

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
    scoringFormula: t.scoringFormula ?? null,
    autoDnfEnabled: t.autoDnfEnabled ?? false,
    autoDnfThreshold: t.autoDnfThreshold ?? 75,
    createdAt: t.createdAt.toISOString(),
  })));
});

router.post("/points-tables", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  const userClubId = user?.clubId;
  if (!userClubId) return res.status(403).json({ error: "Your account isn't linked to a club yet. Ask your club's owner to add you on the Team page." });

  const { name, description, scoringMethod, mainEventOnly, pointsScale, scoringFormula, autoDnfEnabled, autoDnfThreshold } = req.body;
  if (!name || !scoringMethod || !Array.isArray(pointsScale)) {
    return res.status(400).json({ error: "Enter a name, choose a scoring method, and fill in the points." });
  }
  const postShapeError = scoringMethodError(scoringMethod) ?? pointsScaleError(pointsScale);
  if (postShapeError) return res.status(400).json({ error: postShapeError });
  const postFormulaError = formulaError(scoringFormula);
  if (postFormulaError) return res.status(400).json({ error: postFormulaError });

  const [table] = await db.insert(pointsTablesTable).values({
    clubId: userClubId,
    name,
    description: description || "",
    scoringMethod,
    mainEventOnly: !!mainEventOnly,
    pointsScale,
    scoringFormula: scoringFormula ?? null,
    isSystemDefault: false,
    autoDnfEnabled: !!autoDnfEnabled,
    autoDnfThreshold: autoDnfThreshold != null ? Number(autoDnfThreshold) : 75,
  }).returning();

  return res.status(201).json({
    ...table,
    pointsScale: table.pointsScale as number[],
    scoringFormula: table.scoringFormula ?? null,
    autoDnfEnabled: table.autoDnfEnabled ?? false,
    autoDnfThreshold: table.autoDnfThreshold ?? 75,
    createdAt: table.createdAt.toISOString(),
  });
});

router.patch("/points-tables/:tableId", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  const userClubId = user?.clubId ?? null;

  const tableId = Number(req.params.tableId);
  const [existing] = await db.select().from(pointsTablesTable).where(eq(pointsTablesTable.id, tableId));
  if (!existing) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  if (existing.isSystemDefault) return res.status(403).json({ error: "Built-in scoring tables can't be edited. Make a copy, then edit the copy." });
  if (userClubId !== null && existing.clubId !== userClubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });

  const { name, description, scoringMethod, mainEventOnly, pointsScale, scoringFormula, autoDnfEnabled, autoDnfThreshold } = req.body;
  const patchFormulaError = formulaError(scoringFormula)
    ?? (scoringMethod !== undefined ? scoringMethodError(scoringMethod) : null)
    ?? (pointsScale !== undefined ? pointsScaleError(pointsScale) : null);
  if (patchFormulaError) return res.status(400).json({ error: patchFormulaError });
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (scoringMethod !== undefined) updates.scoringMethod = scoringMethod;
  if (mainEventOnly !== undefined) updates.mainEventOnly = mainEventOnly;
  if (pointsScale !== undefined) updates.pointsScale = pointsScale;
  if (scoringFormula !== undefined) updates.scoringFormula = scoringFormula ?? null;
  if (autoDnfEnabled !== undefined) updates.autoDnfEnabled = !!autoDnfEnabled;
  if (autoDnfThreshold !== undefined) updates.autoDnfThreshold = Number(autoDnfThreshold);

  const [updated] = await db.update(pointsTablesTable).set(updates as any).where(eq(pointsTablesTable.id, tableId)).returning();
  const scoringChanged = ["scoringMethod", "mainEventOnly", "pointsScale", "scoringFormula", "autoDnfEnabled", "autoDnfThreshold"]
    .some(k => k in updates);
  if (scoringChanged) rescoreUsers(tableId, existing.clubId);
  return res.json({
    ...updated,
    pointsScale: updated.pointsScale as number[],
    scoringFormula: updated.scoringFormula ?? null,
    autoDnfEnabled: updated.autoDnfEnabled ?? false,
    autoDnfThreshold: updated.autoDnfThreshold ?? 75,
    createdAt: updated.createdAt.toISOString(),
  });
});

router.delete("/points-tables/:tableId", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  const userClubId = user?.clubId ?? null;

  const tableId = Number(req.params.tableId);
  const [existing] = await db.select().from(pointsTablesTable).where(eq(pointsTablesTable.id, tableId));
  if (!existing) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  if (existing.isSystemDefault) return res.status(403).json({ error: "Built-in scoring tables can't be deleted." });
  if (userClubId !== null && existing.clubId !== userClubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });

  // Check for series using this table (FK constraint)
  const seriesUsing = await db.select({ id: seriesTable.id, name: seriesTable.name })
    .from(seriesTable).where(existing.clubId == null ? eq(seriesTable.scoringTableId, tableId)
      : and(eq(seriesTable.scoringTableId, tableId), eq(seriesTable.clubId, existing.clubId)));
  if (seriesUsing.length > 0) {
    const names = seriesUsing.map(s => `"${s.name}"`).join(", ");
    return res.status(409).json({
      error: `This scoring table is used by ${seriesUsing.length === 1 ? "a series" : "series"}: ${names}. Remove it from ${seriesUsing.length === 1 ? "that series" : "those series"} before deleting.`,
    });
  }

  // Check for events using this table
  const eventsUsing = await db.select({ id: eventsTable.id, name: eventsTable.name })
    .from(eventsTable).where(existing.clubId == null ? eq(eventsTable.scoringTableId, tableId)
      : and(eq(eventsTable.scoringTableId, tableId), eq(eventsTable.clubId, existing.clubId)));
  if (eventsUsing.length > 0) {
    const names = eventsUsing.map(e => `"${e.name}"`).join(", ");
    return res.status(409).json({
      error: `This scoring table is used by ${eventsUsing.length === 1 ? "an event" : "events"}: ${names}. Remove it from ${eventsUsing.length === 1 ? "that event" : "those events"} before deleting.`,
    });
  }

  try {
    await db.delete(pointsTablesTable).where(eq(pointsTablesTable.id, tableId));
  } catch {
    // Still referenced somewhere (e.g. an older link from another club).
    return res.status(409).json({ error: "This scoring table is still in use and can't be deleted." });
  }
  return res.status(204).end();
});

export default router;
