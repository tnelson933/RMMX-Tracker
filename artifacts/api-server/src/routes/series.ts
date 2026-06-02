import { Router } from "express";
import { db } from "@workspace/db";
import { seriesTable, seriesPointsTable, raceResultsTable, ridersTable, eventsTable, motosTable, registrationsTable } from "@workspace/db";
import { eq, inArray, and } from "drizzle-orm";

const router = Router();

router.get("/series", async (req, res) => {
  const series = await db.select().from(seriesTable).orderBy(seriesTable.name);
  return res.json(series.map(s => ({ ...s, createdAt: s.createdAt.toISOString() })));
});

router.post("/series", async (req, res) => {
  const { name, clubId, season, classes, pointsSystem, eventIds } = req.body;
  if (!name || !clubId || !season) return res.status(400).json({ error: "name, clubId, season required" });
  const [series] = await db.insert(seriesTable).values({ name, clubId, season, classes: classes || [], pointsSystem: pointsSystem || "standard", eventIds: eventIds || [] }).returning();
  return res.status(201).json({ ...series, createdAt: series.createdAt.toISOString() });
});

router.patch("/series/:seriesId", async (req, res) => {
  const seriesId = Number(req.params.seriesId);
  const { name, season, classes, eventIds } = req.body;
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (season !== undefined) updates.season = season;
  if (classes !== undefined) updates.classes = classes;
  if (eventIds !== undefined) updates.eventIds = eventIds;
  const [updated] = await db.update(seriesTable).set(updates as any).where(eq(seriesTable.id, seriesId)).returning();
  if (!updated) return res.status(404).json({ error: "Not found" });
  return res.json({ ...updated, createdAt: updated.createdAt.toISOString() });
});

router.get("/series/:seriesId/leaderboard", async (req, res) => {
  const seriesId = Number(req.params.seriesId);
  const [series] = await db.select().from(seriesTable).where(eq(seriesTable.id, seriesId));
  if (!series) return res.status(404).json({ error: "Not found" });

  const eventIds = series.eventIds as number[];
  if (eventIds.length === 0) return res.json([]);

  // Load event names
  const events = await db.select({ id: eventsTable.id, name: eventsTable.name })
    .from(eventsTable)
    .where(inArray(eventsTable.id, eventIds));
  const eventNameMap: Record<number, string> = {};
  events.forEach(e => { eventNameMap[e.id] = e.name; });

  // Load all completed motos across all series events
  const allMotos = await db.select()
    .from(motosTable)
    .where(and(inArray(motosTable.eventId, eventIds), eq(motosTable.status, "completed")));

  if (allMotos.length === 0) return res.json([]);

  const motoIds = allMotos.map(m => m.id);

  // Load all results for those motos
  const allResults = await db.select({
    motoId: raceResultsTable.motoId,
    riderId: raceResultsTable.riderId,
    riderName: ridersTable.firstName,
    riderLastName: ridersTable.lastName,
    raceClass: raceResultsTable.raceClass,
    position: raceResultsTable.position,
    points: raceResultsTable.points,
    dnf: raceResultsTable.dnf,
    dns: raceResultsTable.dns,
  })
    .from(raceResultsTable)
    .leftJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
    .where(inArray(raceResultsTable.motoId, motoIds));

  // Build: raceClass → eventId → array of { moto, results[] }
  type MotoEntry = { moto: typeof allMotos[0]; results: typeof allResults };
  const classByEvent: Record<string, Record<number, MotoEntry[]>> = {};

  for (const moto of allMotos) {
    const cls = moto.raceClass ?? "";
    if (!classByEvent[cls]) classByEvent[cls] = {};
    if (!classByEvent[cls][moto.eventId]) classByEvent[cls][moto.eventId] = [];
    const motoResults = allResults.filter(r => r.motoId === moto.id);
    classByEvent[cls][moto.eventId].push({ moto, results: motoResults });
  }

  const standings: Array<{
    position: number;
    riderId: number;
    riderName: string;
    raceClass: string;
    totalScore: number;
    eventsEntered: number;
    events: Array<{ eventId: number; eventName: string; eventScore: number; attended: boolean; motos: number[] }>;
  }> = [];

  for (const [raceClass, eventMap] of Object.entries(classByEvent)) {
    // Collect all unique riders who appear in any moto for this class
    const riderNames: Record<number, string> = {};
    for (const motoEntries of Object.values(eventMap)) {
      for (const { results } of motoEntries) {
        for (const r of results) {
          riderNames[r.riderId] = `${r.riderName ?? ""} ${r.riderLastName ?? ""}`.trim();
        }
      }
    }
    const allRiderIds = Object.keys(riderNames).map(Number);

    const classRows: typeof standings = [];

    for (const riderId of allRiderIds) {
      let totalScore = 0;
      let eventsEntered = 0;
      const eventBreakdowns: typeof standings[0]["events"] = [];

      // Iterate in series event order
      for (const eventId of eventIds) {
        const motoEntries = eventMap[eventId];
        if (!motoEntries || motoEntries.length === 0) continue; // no motos in this class for this event

        // Sort motos by motoNumber so columns are consistent
        const sortedMotos = [...motoEntries].sort((a, b) => (a.moto.motoNumber ?? 0) - (b.moto.motoNumber ?? 0));

        let eventScore = 0;
        const motoPositions: number[] = [];
        let attended = false;

        for (const { results } of sortedMotos) {
          const result = results.find(r => r.riderId === riderId);
          if (result) {
            attended = true;
            // DNF/DNS = 0 points; otherwise use stored points
            const pts = (result.dnf || result.dns) ? 0 : (result.points ?? 0);
            eventScore += pts;
            motoPositions.push(pts);
          } else {
            // Missed moto = 0 points
            motoPositions.push(0);
          }
        }

        if (attended) eventsEntered++;
        totalScore += eventScore;
        eventBreakdowns.push({
          eventId,
          eventName: eventNameMap[eventId] ?? `Event ${eventId}`,
          eventScore,
          attended,
          motos: motoPositions,
        });
      }

      classRows.push({
        position: 0, // assigned below
        riderId,
        riderName: riderNames[riderId],
        raceClass,
        totalScore,
        eventsEntered,
        events: eventBreakdowns,
      });
    }

    // Sort descending by totalScore (highest points wins), assign positions with tie handling
    classRows.sort((a, b) => b.totalScore - a.totalScore);
    classRows.forEach((row, idx) => {
      if (idx > 0 && row.totalScore === classRows[idx - 1].totalScore) {
        row.position = classRows[idx - 1].position;
      } else {
        row.position = idx + 1;
      }
    });

    standings.push(...classRows);
  }

  return res.json(standings);
});

// Keep recalculate endpoint (no-op now — standings are computed live)
router.post("/series/:seriesId/recalculate", async (req, res) => {
  return res.json({ ok: true });
});

// ── Public: series info (for embeddable widget) ───────────────────────────────
router.get("/public/series/:seriesId", async (req, res) => {
  const seriesId = Number(req.params.seriesId);
  const [series] = await db.select().from(seriesTable).where(eq(seriesTable.id, seriesId));
  if (!series) return res.status(404).json({ error: "Not found" });

  const eventIds = series.eventIds as number[];
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

  const eventMap = new Map(eventsData.map(e => [e.id, e]));
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
  if (!series) return res.status(404).json({ error: "Not found" });

  const eventIds = series.eventIds as number[];
  if (eventIds.length === 0) return res.json([]);

  const events = await db.select({ id: eventsTable.id, name: eventsTable.name })
    .from(eventsTable).where(inArray(eventsTable.id, eventIds));
  const eventNameMap: Record<number, string> = {};
  events.forEach(e => { eventNameMap[e.id] = e.name; });

  const allMotos = await db.select().from(motosTable)
    .where(and(inArray(motosTable.eventId, eventIds), eq(motosTable.status, "completed")));

  if (allMotos.length === 0) return res.json([]);

  const motoIds = allMotos.map(m => m.id);
  const allResults = await db.select({
    motoId: raceResultsTable.motoId,
    riderId: raceResultsTable.riderId,
    riderName: ridersTable.firstName,
    riderLastName: ridersTable.lastName,
    raceClass: raceResultsTable.raceClass,
    position: raceResultsTable.position,
    points: raceResultsTable.points,
    dnf: raceResultsTable.dnf,
    dns: raceResultsTable.dns,
  }).from(raceResultsTable)
    .leftJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
    .where(inArray(raceResultsTable.motoId, motoIds));

  type MotoEntry = { moto: typeof allMotos[0]; results: typeof allResults };
  const classByEvent: Record<string, Record<number, MotoEntry[]>> = {};

  for (const moto of allMotos) {
    const cls = moto.raceClass ?? "";
    if (!classByEvent[cls]) classByEvent[cls] = {};
    if (!classByEvent[cls][moto.eventId]) classByEvent[cls][moto.eventId] = [];
    classByEvent[cls][moto.eventId].push({ moto, results: allResults.filter(r => r.motoId === moto.id) });
  }

  const standings: Array<{
    position: number; riderId: number; riderName: string; raceClass: string;
    totalScore: number; eventsEntered: number; amaNumber: string | null; bikeBrand: string | null;
    events: Array<{ eventId: number; eventName: string; eventScore: number; attended: boolean; motos: number[] }>;
  }> = [];

  for (const [raceClass, eventMap] of Object.entries(classByEvent)) {
    const riderNames: Record<number, string> = {};
    for (const motoEntries of Object.values(eventMap)) {
      for (const { results } of motoEntries) {
        for (const r of results) {
          riderNames[r.riderId] = `${r.riderName ?? ""} ${r.riderLastName ?? ""}`.trim();
        }
      }
    }
    const allRiderIds = Object.keys(riderNames).map(Number);
    const classRows: typeof standings = [];

    for (const riderId of allRiderIds) {
      let totalScore = 0; let eventsEntered = 0;
      const eventBreakdowns: typeof standings[0]["events"] = [];
      for (const eventId of eventIds) {
        const motoEntries = eventMap[eventId];
        if (!motoEntries?.length) continue;
        const sortedMotos = [...motoEntries].sort((a, b) => (a.moto.motoNumber ?? 0) - (b.moto.motoNumber ?? 0));
        let eventScore = 0; const motoPositions: number[] = []; let attended = false;
        for (const { results } of sortedMotos) {
          const result = results.find(r => r.riderId === riderId);
          if (result) {
            attended = true;
            const pts = (result.dnf || result.dns) ? 0 : (result.points ?? 0);
            eventScore += pts; motoPositions.push(pts);
          } else { motoPositions.push(0); }
        }
        if (attended) eventsEntered++;
        totalScore += eventScore;
        eventBreakdowns.push({ eventId, eventName: eventNameMap[eventId] ?? `Event ${eventId}`, eventScore, attended, motos: motoPositions });
      }
      classRows.push({ position: 0, riderId, riderName: riderNames[riderId], raceClass, totalScore, eventsEntered, amaNumber: null, bikeBrand: null, events: eventBreakdowns });
    }

    classRows.sort((a, b) => b.totalScore - a.totalScore);
    classRows.forEach((row, idx) => {
      row.position = (idx > 0 && row.totalScore === classRows[idx - 1].totalScore) ? classRows[idx - 1].position : idx + 1;
    });
    standings.push(...classRows);
  }

  // Attach AMA# and bike brand from registrations
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
