import { Router } from "express";
import { createContext, Script } from "vm";
import { db } from "@workspace/db";
import { raceResultsTable, motosTable, ridersTable, eventPublicationTable, registrationsTable, eventsTable, pointsTablesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const FALLBACK_POINTS = [25, 22, 20, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

/**
 * Safely evaluate a user-defined formula string.
 * Sandbox only exposes: position (1-based), riders (total starters), Math.
 * Returns 0 on any error or non-finite result.
 */
function evalFormula(formula: string, position: number, riders: number): number {
  try {
    const sandbox = createContext({ position, riders, Math });
    const result = new Script(formula).runInContext(sandbox, { timeout: 50 });
    if (typeof result !== "number" || !isFinite(result)) return 0;
    return Math.max(0, Math.round(result));
  } catch {
    return 0;
  }
}

/**
 * Compute points for a single finisher given the event's scoring configuration.
 *
 * scoringMethod values:
 *   "formula"         — evaluate scoringFormula with {position, riders} in scope.
 *   "per_rider"       — 1st gets N pts (total starters), 2nd gets N-1, …, last gets 1.
 *   "highest_points"  — look up position in pointsScale (first entry = 1st place).
 *   "lowest_positions"— look up position in pointsScale; lower total is better (Olympic).
 *   (fallback)        — use hardcoded FALLBACK_POINTS array.
 *
 * mainEventOnly — if true, heats score 0; only moto type "main" scores points.
 */
function calcPoints(opts: {
  position: number;
  dnf: boolean;
  dns: boolean;
  totalStarters: number;
  scoringMethod: string;
  pointsScale: number[];
  scoringFormula: string | null;
  mainEventOnly: boolean;
  motoType: string;
}): number {
  if (opts.dnf || opts.dns) return 0;
  if (opts.mainEventOnly && opts.motoType !== "main") return 0;

  switch (opts.scoringMethod) {
    case "formula":
      if (!opts.scoringFormula) return 0;
      return evalFormula(opts.scoringFormula, opts.position, opts.totalStarters);
    case "per_rider":
      return Math.max(0, opts.totalStarters - opts.position + 1);
    case "highest_points":
      return opts.pointsScale[opts.position - 1] ?? 0;
    case "lowest_positions":
      return opts.pointsScale[opts.position - 1] ?? opts.position;
    default:
      return FALLBACK_POINTS[opts.position - 1] ?? 0;
  }
}

const router = Router();

router.get("/events/:eventId/results", async (req, res) => {
  const eventId = Number(req.params.eventId);

  const results = await db.select({
    id: raceResultsTable.id,
    eventId: raceResultsTable.eventId,
    motoId: raceResultsTable.motoId,
    riderId: raceResultsTable.riderId,
    raceClass: raceResultsTable.raceClass,
    position: raceResultsTable.position,
    totalTime: raceResultsTable.totalTime,
    lapTimes: raceResultsTable.lapTimes,
    points: raceResultsTable.points,
    dnf: raceResultsTable.dnf,
    dns: raceResultsTable.dns,
    bibNumber: raceResultsTable.bibNumber,
    motoName: motosTable.name,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
    amaNumber: registrationsTable.amaNumber,
    bikeBrand: registrationsTable.bikeBrand,
  }).from(raceResultsTable)
    .leftJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .leftJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
    .leftJoin(registrationsTable, and(
      eq(registrationsTable.riderId, raceResultsTable.riderId),
      eq(registrationsTable.eventId, raceResultsTable.eventId),
    ))
    .where(eq(raceResultsTable.eventId, eventId))
    .orderBy(raceResultsTable.position);

  return res.json(results.map(r => ({
    id: r.id,
    eventId: r.eventId,
    motoId: r.motoId,
    motoName: r.motoName || "",
    riderId: r.riderId,
    riderName: `${r.firstName} ${r.lastName}`,
    raceClass: r.raceClass,
    position: r.position,
    totalTime: r.totalTime,
    lapTimes: Array.isArray(r.lapTimes) ? r.lapTimes : [],
    points: r.points,
    dnf: r.dnf,
    dns: r.dns,
    bibNumber: r.bibNumber,
    amaNumber: r.amaNumber ?? null,
    bikeBrand: r.bikeBrand ?? null,
  })));
});

router.post("/events/:eventId/results", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { motoId, results: riderResults } = req.body;
  if (!motoId || !Array.isArray(riderResults)) return res.status(400).json({ error: "motoId and results[] required" });

  const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, motoId));
  if (!moto) return res.status(404).json({ error: "Moto not found" });
  const raceClass = moto.raceClass;
  const motoType: string = (moto as any).type ?? "heat";

  // ── Resolve scoring table for this event ─────────────────────────────────
  const [event] = await db.select({ scoringTableId: eventsTable.scoringTableId })
    .from(eventsTable)
    .where(eq(eventsTable.id, eventId));

  let scoringMethod = "fallback";
  let pointsScale: number[] = [];
  let scoringFormula: string | null = null;
  let mainEventOnly = false;

  if (event?.scoringTableId) {
    const [table] = await db.select().from(pointsTablesTable)
      .where(eq(pointsTablesTable.id, event.scoringTableId));
    if (table) {
      scoringMethod  = table.scoringMethod;
      pointsScale    = (table.pointsScale as number[]) ?? [];
      scoringFormula = table.scoringFormula ?? null;
      mainEventOnly  = table.mainEventOnly;
    }
  }

  // Total starters = riders who are NOT dns (did not start)
  const totalStarters = riderResults.filter((r: any) => !r.dns).length;

  // ── Delete existing results for this moto then re-insert ─────────────────
  await db.delete(raceResultsTable).where(eq(raceResultsTable.motoId, motoId));

  const inserted = [];
  for (const r of riderResults) {
    const points = calcPoints({
      position:      r.position,
      dnf:           !!r.dnf,
      dns:           !!r.dns,
      totalStarters,
      scoringMethod,
      pointsScale,
      scoringFormula,
      mainEventOnly,
      motoType,
    });

    const [result] = await db.insert(raceResultsTable).values({
      eventId, motoId, riderId: r.riderId, raceClass,
      position:  r.position,
      totalTime: r.totalTime || null,
      lapTimes:  r.lapTimes || [],
      points,
      dnf: r.dnf || false,
      dns: r.dns || false,
    }).returning();
    inserted.push(result);
  }

  // Mark moto as completed
  await db.update(motosTable).set({ status: "completed" }).where(eq(motosTable.id, motoId));

  return res.status(201).json(inserted.map(r => ({
    id: r.id,
    eventId: r.eventId,
    motoId: r.motoId,
    motoName: moto.name,
    riderId: r.riderId,
    riderName: "",
    raceClass: r.raceClass,
    position: r.position,
    totalTime: r.totalTime,
    lapTimes: Array.isArray(r.lapTimes) ? r.lapTimes : [],
    points: r.points,
    dnf: r.dnf,
    dns: r.dns,
    bibNumber: r.bibNumber,
  })));
});

function formatMs(ms: number): string {
  if (ms <= 0) return "0:00.00";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const centis = Math.floor((ms % 1000) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

router.patch("/events/:eventId/results/:resultId/laps", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const resultId = Number(req.params.resultId);
  const { lapTimes } = req.body as { lapTimes?: unknown };

  if (!Array.isArray(lapTimes) || lapTimes.some((t) => typeof t !== "number")) {
    res.status(400).json({ error: "lapTimes must be an array of numbers (milliseconds)" });
    return;
  }

  const totalMs = (lapTimes as number[]).reduce((s, t) => s + t, 0);
  const totalTime = lapTimes.length > 0 ? formatMs(totalMs) : null;

  const [updated] = await db
    .update(raceResultsTable)
    .set({ lapTimes: lapTimes as number[], totalTime })
    .where(eq(raceResultsTable.id, resultId))
    .returning();

  if (!updated) { res.status(404).json({ error: "Result not found" }); return; }

  res.json({ id: updated.id, lapTimes: updated.lapTimes, totalTime: updated.totalTime });
});

router.post("/events/:eventId/results/publish", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { published } = req.body;

  const existing = await db.select().from(eventPublicationTable).where(eq(eventPublicationTable.eventId, eventId));
  if (existing[0]) {
    await db.update(eventPublicationTable).set({
      published,
      publishedAt: published ? new Date() : null,
      updatedAt: new Date(),
    }).where(eq(eventPublicationTable.eventId, eventId));
  } else {
    await db.insert(eventPublicationTable).values({ eventId, published, publishedAt: published ? new Date() : null });
  }

  return res.json({ ok: true, published });
});

// ── AMA Export CSV ─────────────────────────────────────────────────────────────
router.get("/events/:eventId/ama-export", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const eventId = Number(req.params.eventId);

  const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event) return res.status(404).json({ error: "Event not found" });
  if ((event as any).clubId !== session.clubId && session.role !== "super_admin") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const motos = await db.select().from(motosTable)
    .where(eq(motosTable.eventId, eventId))
    .orderBy(motosTable.id);

  const results = await db.select({
    riderId: raceResultsTable.riderId,
    motoId: raceResultsTable.motoId,
    position: raceResultsTable.position,
    raceClass: motosTable.raceClass,
    motoNumber: motosTable.motoNumber,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
    hometown: ridersTable.hometown,
    amaNumber: registrationsTable.amaNumber,
    bibNumber: raceResultsTable.bibNumber,
  }).from(raceResultsTable)
    .innerJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .innerJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
    .leftJoin(registrationsTable, and(
      eq(registrationsTable.riderId, raceResultsTable.riderId),
      eq(registrationsTable.eventId, eventId),
    ))
    .where(eq(motosTable.eventId, eventId));

  // Also get homeState from riders (stored as separate column)
  const riderIds = [...new Set(results.map(r => r.riderId))];
  const riderRows = riderIds.length > 0
    ? await db.select({ id: ridersTable.id }).from(ridersTable).where(eq(ridersTable.id, riderIds[0]))
    : [];

  // Collect homeState via raw column access
  const riderHomeStateMap = new Map<number, string>();
  if (riderIds.length > 0) {
    const { sql: sqlTag } = await import("drizzle-orm");
    const homeStateRows = await db.execute(
      sqlTag`SELECT id, home_state FROM riders WHERE id = ANY(${riderIds})`
    );
    for (const row of homeStateRows.rows as Array<{ id: number; home_state: string | null }>) {
      riderHomeStateMap.set(Number(row.id), row.home_state ?? "");
    }
  }

  const amaEventId = (event as any).amaEventId ?? "";
  const eventDate = event.date ? String(event.date).substring(0, 10) : "";
  const trackName = event.trackName ?? event.name;

  const escCsv = (v: unknown): string => {
    const s = String(v ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const header = ["AMA Event ID", "Event Name", "Event Date", "Track Name", "Class", "Moto", "AMA #", "Bib #", "First Name", "Last Name", "Hometown", "State", "Overall Position"].join(",");

  const rows: string[] = [header];
  for (const r of results) {
    rows.push([
      escCsv(amaEventId),
      escCsv(event.name),
      escCsv(eventDate),
      escCsv(trackName),
      escCsv(r.raceClass),
      escCsv(r.motoNumber),
      escCsv(r.amaNumber ?? ""),
      escCsv(r.bibNumber ?? ""),
      escCsv(r.firstName ?? ""),
      escCsv(r.lastName ?? ""),
      escCsv(r.hometown ?? ""),
      escCsv(riderHomeStateMap.get(r.riderId) ?? ""),
      escCsv(r.position ?? ""),
    ].join(","));
  }

  const filename = `ama-export-event-${eventId}.csv`;
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(rows.join("\n"));
});

export default router;
