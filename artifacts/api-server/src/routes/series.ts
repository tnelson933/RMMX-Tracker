import { Router } from "express";
import { db } from "@workspace/db";
import { seriesTable, seriesPointsTable, raceResultsTable, ridersTable, eventsTable, motosTable, registrationsTable, pointsTablesTable, clubsTable, eventPublicationTable, usersTable } from "@workspace/db";
import { eq, inArray, and } from "drizzle-orm";
import { computeSeriesStandings } from "../lib/seriesStandings";
import { scoringTableUsable } from "../lib/scoringTables";
import { recalculateSeriesPoints } from "./results";

const router = Router();

/** Event ids without duplicates (a duplicate would count an event twice). */
function uniqueIds(ids: unknown): number[] {
  return Array.isArray(ids) ? [...new Set(ids.map(Number).filter(Number.isFinite))] : [];
}

function getStaffClubId(res: any): number | null {
  const v = res.locals?.staffClubId;
  return typeof v === "number" ? v : null;
}

/** Event IDs from `eventIds` that don't belong to `clubId` (a series may only use its own club's events). */
async function foreignEventIds(eventIds: unknown, clubId: number): Promise<number[]> {
  if (!Array.isArray(eventIds) || eventIds.length === 0) return [];
  const ids = eventIds.map(Number);
  const rows = await db.select({ id: eventsTable.id, clubId: eventsTable.clubId })
    .from(eventsTable).where(inArray(eventsTable.id, ids));
  const own = new Set(rows.filter(r => r.clubId === clubId).map(r => r.id));
  return ids.filter(id => !own.has(id));
}

router.get("/series", async (req, res) => {
  const staffCId = getStaffClubId(res);
  const series = staffCId !== null
    ? await db.select().from(seriesTable).where(eq(seriesTable.clubId, staffCId)).orderBy(seriesTable.name)
    : await db.select().from(seriesTable).orderBy(seriesTable.name);
  return res.json(series.map(s => ({ ...s, createdAt: s.createdAt.toISOString() })));
});

router.post("/series", async (req, res) => {
  const staffCId = getStaffClubId(res);
  const { name, clubId: rawClubId, season, classes, pointsSystem, scoringTableId, eventIds } = req.body;
  const clubId = staffCId !== null ? staffCId : rawClubId;
  if (!name || !clubId || !season) return res.status(400).json({ error: "Enter a series name and season." });
  if (!(await scoringTableUsable(scoringTableId, Number(clubId)))) return res.status(400).json({ error: "That scoring table isn't available to this club." });
  const foreignOnCreate = await foreignEventIds(eventIds, Number(clubId));
  if (foreignOnCreate.length > 0) return res.status(400).json({ error: `Events ${foreignOnCreate.join(", ")} don't belong to this club.` });
  const [series] = await db.insert(seriesTable).values({
    name,
    clubId,
    season,
    classes: classes || [],
    pointsSystem: pointsSystem || "standard",
    scoringTableId: scoringTableId ?? null,
    eventIds: uniqueIds(eventIds),
  }).returning();
  return res.status(201).json({ ...series, createdAt: series.createdAt.toISOString() });
});

router.patch("/series/:seriesId", async (req, res) => {
  const seriesId = Number(req.params.seriesId);

  const [existingSeries] = await db.select().from(seriesTable).where(eq(seriesTable.id, seriesId));
  if (!existingSeries) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });

  const staffCId = getStaffClubId(res);
  if (staffCId !== null && existingSeries.clubId !== staffCId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });

  const { name, season, classes, scoringTableId, eventIds } = req.body;

  const foreignOnUpdate = await foreignEventIds(eventIds, existingSeries.clubId);
  if (foreignOnUpdate.length > 0) return res.status(400).json({ error: `Events ${foreignOnUpdate.join(", ")} don't belong to this club.` });

  if (scoringTableId !== undefined && !(await scoringTableUsable(scoringTableId, existingSeries.clubId))) {
    return res.status(400).json({ error: "That scoring table isn't available to this club." });
  }

  // Events must match the series' scoring format, whether the events or the table change.
  const checkIds = eventIds !== undefined ? uniqueIds(eventIds) : uniqueIds(existingSeries.eventIds);
  if (checkIds.length > 0 && (eventIds !== undefined || scoringTableId !== undefined)) {
    const tableId = scoringTableId !== undefined ? (scoringTableId ?? null) : existingSeries.scoringTableId;

    if (tableId) {
      const events = await db.select({ id: eventsTable.id, scoringTableId: eventsTable.scoringTableId })
        .from(eventsTable).where(inArray(eventsTable.id, checkIds));
      const mismatched = events.filter(e => e.scoringTableId !== tableId);
      if (mismatched.length > 0) {
        const mismatchedIds = mismatched.map(e => e.id).join(", ");
        return res.status(400).json({
          error: `Events ${mismatchedIds} use a different scoring format than this series. All events in a series must use the same scoring format.`,
        });
      }
    }
  }

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (season !== undefined) updates.season = season;
  if (classes !== undefined) updates.classes = classes;
  if (scoringTableId !== undefined) updates.scoringTableId = scoringTableId ?? null;
  if (eventIds !== undefined) updates.eventIds = uniqueIds(eventIds);

  const [updated] = await db.update(seriesTable).set(updates as any).where(eq(seriesTable.id, seriesId)).returning();
  if (!updated) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  // Events or scoring changed: rebuild the stored series points.
  if (eventIds !== undefined || scoringTableId !== undefined || classes !== undefined) {
    await recalculateSeriesPoints([seriesId]);
  }
  return res.json({ ...updated, createdAt: updated.createdAt.toISOString() });
});

router.get("/series/:seriesId/leaderboard", async (req, res) => {
  const seriesId = Number(req.params.seriesId);
  const [series] = await db.select().from(seriesTable).where(eq(seriesTable.id, seriesId));
  if (!series) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });

  // Public (embed widgets): finished races count, each class flagged official
  // once all its races are finalized. Same rules as the stored series points.
  const { standings } = await computeSeriesStandings(series);
  return res.json(standings);
});

router.post("/series/:seriesId/recalculate", async (req, res) => {
  const seriesId = Number(req.params.seriesId);
  const staffCId = getStaffClubId(res);
  if (staffCId !== null) {
    const [series] = await db.select({ clubId: seriesTable.clubId }).from(seriesTable).where(eq(seriesTable.id, seriesId));
    if (!series || series.clubId !== staffCId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
  }
  await recalculateSeriesPoints([seriesId]);
  return res.json({ ok: true });
});

// ── Public: states that have at least one series ──────────────────────────────
router.get("/public/series/states", async (_req, res) => {
  const rows = await db
    .selectDistinct({ state: clubsTable.state })
    .from(seriesTable)
    .innerJoin(clubsTable, eq(seriesTable.clubId, clubsTable.id))
    .orderBy(clubsTable.state);
  return res.json(rows.map(r => r.state));
});

// ── Public: all series across all clubs (optional ?state= filter) ─────────────
router.get("/public/series", async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const query = db
    .select({
      id: seriesTable.id,
      name: seriesTable.name,
      season: seriesTable.season,
      clubId: seriesTable.clubId,
      clubName: clubsTable.name,
      state: clubsTable.state,
      classes: seriesTable.classes,
    })
    .from(seriesTable)
    .innerJoin(clubsTable, eq(seriesTable.clubId, clubsTable.id));
  const rows = state
    ? await query.where(eq(clubsTable.state, state)).orderBy(seriesTable.name)
    : await query.orderBy(seriesTable.name);
  return res.json(rows);
});

// ── Public: series info (for embeddable widget) ───────────────────────────────
router.get("/public/series/:seriesId", async (req, res) => {
  const seriesId = Number(req.params.seriesId);
  const [series] = await db.select().from(seriesTable).where(eq(seriesTable.id, seriesId));
  if (!series) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });

  const allEventIds = series.eventIds as number[];

  // Every event in the series is listed; results inside are marked official or not.
  const eventIds = allEventIds;

  const eventsData = eventIds.length > 0
    ? await db.select({
        id: eventsTable.id,
        name: eventsTable.name,
        date: eventsTable.date,
        status: eventsTable.status,
        location: eventsTable.location,
        state: eventsTable.state,
      }).from(eventsTable).where(inArray(eventsTable.id, eventIds))
    : [];

  // Draft events aren't announced yet: keep them off the public page.
  const eventMap = new Map(eventsData.filter(e => e.status !== "draft").map(e => [e.id, e]));
  const sortedEvents = eventIds.map(id => eventMap.get(id)).filter(Boolean);

  return res.json({
    id: series.id,
    name: series.name,
    season: series.season,
    classes: series.classes,
    eventIds,
    events: sortedEvents,
  });
});

// ── Public: series standings with AMA# and bike brand ────────────────────────
router.get("/public/series/:seriesId/standings", async (req, res) => {
  const seriesId = Number(req.params.seriesId);
  const [series] = await db.select().from(seriesTable).where(eq(seriesTable.id, seriesId));
  if (!series) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });

  const { standings: rows, eventIds } = await computeSeriesStandings(series);
  const standings = rows.map(row => ({ ...row, amaNumber: null as string | null, bikeBrand: null as string | null }));

  const allRiderIds = [...new Set(standings.map(s => s.riderId))];
  if (allRiderIds.length > 0) {
    const regs = await db.select({
      riderId: registrationsTable.riderId,
      amaNumber: registrationsTable.amaNumber,
      bikeBrand: registrationsTable.bikeBrand,
    }).from(registrationsTable)
      .where(and(
        inArray(registrationsTable.riderId, allRiderIds),
        inArray(registrationsTable.eventId, eventIds),
      ));

    const riderInfo: Record<number, { amaNumber: string | null; bikeBrand: string | null }> = {};
    for (const reg of regs) {
      if (!riderInfo[reg.riderId]) riderInfo[reg.riderId] = { amaNumber: null, bikeBrand: null };
      if (!riderInfo[reg.riderId].amaNumber && reg.amaNumber) riderInfo[reg.riderId].amaNumber = reg.amaNumber;
      if (!riderInfo[reg.riderId].bikeBrand && reg.bikeBrand) riderInfo[reg.riderId].bikeBrand = reg.bikeBrand;
    }
    for (const row of standings) {
      row.amaNumber = riderInfo[row.riderId]?.amaNumber ?? null;
      row.bikeBrand = riderInfo[row.riderId]?.bikeBrand ?? null;
    }
  }

  return res.json(standings);
});

export default router;
