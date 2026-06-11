import { Router, type Response } from "express";
import { db } from "@workspace/db";
import { motosTable, checkinsTable, ridersTable, eventsTable, raceResultsTable, pointsTablesTable, clubsTable, usersTable, practiceSessionsTable, practiceCrossingsTable, eventPublicationTable, lapCrossingsTable, registrationsTable, seriesTable, seriesPointsTable } from "@workspace/db";
import { eq, and, inArray, min, ne, gt } from "drizzle-orm";
import { sseBroadcast, buildLeaderboard } from "./timing";

const router = Router();

/** Returns the staff user's club restriction, or null for organizer/admin. */
function getStaffClubId(res: Response): number | null {
  const id = res.locals.staffClubId;
  return typeof id === "number" ? id : null;
}

/**
 * Fetches the clubId of the event that owns a moto.
 * Returns null if the moto doesn't exist.
 */
async function getMotoClubId(motoId: number): Promise<number | null> {
  const [m] = await db.select({ eventId: motosTable.eventId }).from(motosTable).where(eq(motosTable.id, motoId));
  if (!m) return null;
  const [ev] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, m.eventId));
  return ev?.clubId ?? null;
}

/** Returns the clubId of a given event. */
async function getEventClubId(eventId: number): Promise<number | null> {
  const [ev] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  return ev?.clubId ?? null;
}

// Helper: check if event uses Supercross format (mainEventOnly=true)
async function getEventFormat(eventId: number): Promise<{ isSupercross: boolean; topPerHeat: number }> {
  const [event] = await db.select({ scoringTableId: eventsTable.scoringTableId })
    .from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event?.scoringTableId) return { isSupercross: false, topPerHeat: 5 };

  const [table] = await db.select({ mainEventOnly: pointsTablesTable.mainEventOnly })
    .from(pointsTablesTable).where(eq(pointsTablesTable.id, event.scoringTableId));
  return {
    isSupercross: table?.mainEventOnly ?? false,
    topPerHeat: 5,
  };
}

// Helper: advance top heat finishers to main event for a specific class
async function autoAdvanceToMain(eventId: number, raceClass: string, topPerHeat: number) {
  const heatMotos = await db.select().from(motosTable)
    .where(and(
      eq(motosTable.eventId, eventId),
      eq(motosTable.raceClass, raceClass),
      eq(motosTable.type, "heat"),
    ));

  const [mainMoto] = await db.select().from(motosTable)
    .where(and(
      eq(motosTable.eventId, eventId),
      eq(motosTable.raceClass, raceClass),
      eq(motosTable.type, "main"),
    ));
  if (!mainMoto) return;

  // Only auto-advance if ALL heats for this class are completed
  const allHeatsComplete = heatMotos.every(m => m.status === "completed");
  if (!allHeatsComplete) return;

  const heatMotoIds = heatMotos.map(m => m.id);
  const allResults = heatMotoIds.length > 0
    ? await db.select().from(raceResultsTable).where(inArray(raceResultsTable.motoId, heatMotoIds))
    : [];

  const resultsByMoto = new Map<number, typeof allResults>();
  for (const r of allResults) {
    if (!resultsByMoto.has(r.motoId)) resultsByMoto.set(r.motoId, []);
    resultsByMoto.get(r.motoId)!.push(r);
  }

  type LineupEntry = { position: number; riderId: number; riderName: string; bibNumber: string | null; rfidNumber: string | null };
  const advancedRiderIds = new Set<number>();
  const advancedLineup: LineupEntry[] = [];

  for (const heat of heatMotos) {
    const results = resultsByMoto.get(heat.id) ?? [];
    const heatLineup = (Array.isArray(heat.lineup) ? heat.lineup : []) as LineupEntry[];

    if (results.length > 0) {
      const sorted = [...results].filter(r => !r.dnf && !r.dns).sort((a, b) => a.position - b.position);
      for (const r of sorted.slice(0, topPerHeat)) {
        if (!advancedRiderIds.has(r.riderId)) {
          advancedRiderIds.add(r.riderId);
          const fromLineup = heatLineup.find(l => l.riderId === r.riderId);
          advancedLineup.push({
            position: advancedLineup.length + 1,
            riderId: r.riderId,
            riderName: fromLineup?.riderName ?? `Rider #${r.riderId}`,
            bibNumber: r.bibNumber ?? fromLineup?.bibNumber ?? null,
            rfidNumber: fromLineup?.rfidNumber ?? null,
          });
        }
      }
    } else {
      const sorted = [...heatLineup].sort((a, b) => a.position - b.position);
      for (const l of sorted.slice(0, topPerHeat)) {
        if (!advancedRiderIds.has(l.riderId)) {
          advancedRiderIds.add(l.riderId);
          advancedLineup.push({
            position: advancedLineup.length + 1,
            riderId: l.riderId,
            riderName: l.riderName,
            bibNumber: l.bibNumber ?? null,
            rfidNumber: l.rfidNumber ?? null,
          });
        }
      }
    }
  }

  advancedLineup.forEach((r, i) => { r.position = i + 1; });

  await db.update(motosTable)
    .set({ lineup: advancedLineup })
    .where(eq(motosTable.id, mainMoto.id));
}

router.get("/events/:eventId/motos", async (req, res) => {
  const eventId = Number(req.params.eventId);

  // Unauthenticated requests: allow published events and active race-day events (gate page)
  if (!(req.session as any).userId) {
    const [[pub], [evt]] = await Promise.all([
      db.select({ published: eventPublicationTable.published })
        .from(eventPublicationTable).where(eq(eventPublicationTable.eventId, eventId)),
      db.select({ status: eventsTable.status })
        .from(eventsTable).where(eq(eventsTable.id, eventId)),
    ]);
    if (!pub?.published && evt?.status !== "race_day") return res.json([]);
  }

  // Staff club scoping: reject if event belongs to a different club
  const staffCId = getStaffClubId(res);
  if (staffCId !== null) {
    const evClubId = await getEventClubId(eventId);
    if (evClubId !== staffCId) return res.status(403).json({ error: "Forbidden" });
  }

  const motos = await db.select().from(motosTable).where(eq(motosTable.eventId, eventId)).orderBy(motosTable.motoNumber);
  return res.json(motos.map(m => ({
    ...m,
    lineup: Array.isArray(m.lineup) ? m.lineup : [],
    createdAt: m.createdAt.toISOString(),
    startedAt: m.startedAt?.toISOString() ?? null,
    completedAt: m.completedAt?.toISOString() ?? null,
  })));
});

router.post("/events/:eventId/motos", async (req, res) => {
  const eventId = Number(req.params.eventId);

  // Staff club scoping
  const staffCIdPost = getStaffClubId(res);
  if (staffCIdPost !== null) {
    const evClubId = await getEventClubId(eventId);
    if (evClubId !== staffCIdPost) return res.status(403).json({ error: "Forbidden" });
  }

  const { name, type, raceClass, raceClasses, motoNumber, scheduledTime, lineup, lapCount, timeLimitMs, practiceMode, countdownSeconds } = req.body;

  // raceClasses (multi-class practice): raceClass can be derived from first entry
  const resolvedRaceClass = raceClass || (Array.isArray(raceClasses) && raceClasses.length > 0 ? raceClasses[0] : null);
  if (!name || !type || !resolvedRaceClass || motoNumber === undefined) return res.status(400).json({ error: "name, type, raceClass (or raceClasses), motoNumber required" });

  const [moto] = await db.insert(motosTable).values({
    eventId, name, type,
    raceClass: resolvedRaceClass,
    raceClasses: Array.isArray(raceClasses) && raceClasses.length > 0 ? raceClasses : null,
    motoNumber, scheduledTime, lineup: lineup || [], status: "scheduled",
    lapCount: lapCount ? Number(lapCount) : null,
    timeLimitMs: timeLimitMs ? Number(timeLimitMs) : null,
    practiceMode: practiceMode ?? "lap_count",
    countdownSeconds: countdownSeconds ? Number(countdownSeconds) : null,
  }).returning();

  return res.status(201).json({ ...moto, lineup: Array.isArray(moto.lineup) ? moto.lineup : [], createdAt: moto.createdAt.toISOString() });
});

router.patch("/motos/:motoId", async (req, res) => {
  const id = Number(req.params.motoId);

  // Staff club scoping: verify this moto belongs to the staff user's club
  const staffCIdPatch = getStaffClubId(res);
  if (staffCIdPatch !== null) {
    const motoClubId = await getMotoClubId(id);
    if (motoClubId === null) return res.status(404).json({ error: "Not found" });
    if (motoClubId !== staffCIdPatch) return res.status(403).json({ error: "Forbidden" });
  }

  const updates: Record<string, unknown> = {};
  if (req.body.status !== undefined) {
    updates.status = req.body.status;
    if (req.body.status === "in_progress") {
      // Guard: reject if another moto in the same event is already running
      const [target] = await db.select({ eventId: motosTable.eventId }).from(motosTable).where(eq(motosTable.id, id));
      if (target) {
        const [conflict] = await db
          .select({ id: motosTable.id, name: motosTable.name })
          .from(motosTable)
          .where(and(eq(motosTable.eventId, target.eventId), eq(motosTable.status, "in_progress"), ne(motosTable.id, id)));
        if (conflict) {
          return res.status(409).json({ error: "conflict", activeMoto: { id: conflict.id, name: conflict.name } });
        }
      }
      updates.startedAt = new Date();
    }
    if (req.body.status === "completed") updates.completedAt = new Date();
  }
  if (req.body.lineup !== undefined) updates.lineup = req.body.lineup;
  if (req.body.scheduledTime !== undefined) updates.scheduledTime = req.body.scheduledTime;
  if (req.body.lapCount !== undefined) updates.lapCount = req.body.lapCount !== null ? Number(req.body.lapCount) : null;
  if (req.body.timeLimitMs !== undefined) updates.timeLimitMs = req.body.timeLimitMs !== null ? Number(req.body.timeLimitMs) : null;
  if (req.body.practiceMode !== undefined) updates.practiceMode = req.body.practiceMode !== null ? String(req.body.practiceMode) : null;
  if (req.body.countdownSeconds !== undefined) updates.countdownSeconds = req.body.countdownSeconds !== null ? Number(req.body.countdownSeconds) : null;
  if (req.body.motoNumber !== undefined) updates.motoNumber = Number(req.body.motoNumber);
  if (req.body.name !== undefined) updates.name = String(req.body.name);

  const [moto] = await db.update(motosTable).set(updates as any).where(eq(motosTable.id, id)).returning();
  if (!moto) return res.status(404).json({ error: "Not found" });

  if (req.body.status !== undefined) {
    buildLeaderboard(id).then(snapshot => {
      if (snapshot) sseBroadcast(id, snapshot);
    }).catch(() => {});
  }

  // Auto-advance to main when a heat completes (Supercross format only)
  if (req.body.status === "completed" && moto.type === "heat") {
    getEventFormat(moto.eventId).then(async ({ isSupercross }) => {
      if (!isSupercross) return;
      // Calculate topPerHeat dynamically: 30% of the average heat lineup size for this class
      const classHeats = await db.select().from(motosTable)
        .where(and(
          eq(motosTable.eventId, moto.eventId),
          eq(motosTable.raceClass, moto.raceClass),
          eq(motosTable.type, "heat"),
        ));
      const totalRiders = classHeats.reduce((sum, h) => sum + (Array.isArray(h.lineup) ? h.lineup.length : 0), 0);
      const avgSize = classHeats.length > 0 ? totalRiders / classHeats.length : 0;
      const topPerHeat = Math.max(1, Math.round(avgSize * 0.3));
      await autoAdvanceToMain(moto.eventId, moto.raceClass, topPerHeat);
    }).catch(() => {});
  }

  return res.json({
    ...moto,
    lineup: Array.isArray(moto.lineup) ? moto.lineup : [],
    createdAt: moto.createdAt.toISOString(),
    startedAt: moto.startedAt?.toISOString() ?? null,
    completedAt: moto.completedAt?.toISOString() ?? null,
  });
});

// POST /motos/:motoId/restart — wipe all crossings and restart the clock
router.post("/motos/:motoId/restart", async (req, res) => {
  const id = Number(req.params.motoId);
  const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, id));
  if (!moto) return res.status(404).json({ error: "Not found" });

  // Staff club scoping
  const staffCIdRestart = getStaffClubId(res);
  if (staffCIdRestart !== null) {
    const evClubId = await getEventClubId(moto.eventId);
    if (evClubId !== staffCIdRestart) return res.status(403).json({ error: "Forbidden" });
  }
  await db.delete(lapCrossingsTable).where(eq(lapCrossingsTable.motoId, id));
  // Clear timing data from race_results so short-lap flags reset correctly
  await db
    .update(raceResultsTable)
    .set({ lapTimes: [], totalTime: null })
    .where(eq(raceResultsTable.motoId, id));
  const [updated] = await db
    .update(motosTable)
    .set({ status: "scheduled", startedAt: null })
    .where(eq(motosTable.id, id))
    .returning();
  buildLeaderboard(id).then(snap => { if (snap) sseBroadcast(id, snap); }).catch(() => {});
  return res.json({ ok: true, moto: updated });
});

router.delete("/motos/:motoId", async (req, res) => {
  const id = Number(req.params.motoId);

  // Staff club scoping: verify this moto belongs to the staff user's club
  const staffCIdDel = getStaffClubId(res);
  if (staffCIdDel !== null) {
    const motoClubId = await getMotoClubId(id);
    if (motoClubId === null) return res.status(404).json({ error: "Not found" });
    if (motoClubId !== staffCIdDel) return res.status(403).json({ error: "Forbidden" });
  }

  const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, id));
  if (!moto) return res.status(404).json({ error: "Not found" });

  // Delete FK-dependent rows before deleting the moto
  await db.delete(lapCrossingsTable).where(eq(lapCrossingsTable.motoId, id));
  if (moto.status !== "completed") {
    await db.delete(raceResultsTable).where(eq(raceResultsTable.motoId, id));
  }
  await db.delete(motosTable).where(eq(motosTable.id, id));
  return res.status(204).send();
});

// Link two motos as a staggered start pair
router.post("/events/:eventId/stagger", async (req, res) => {
  const { motoId1, motoId2, firstMotoId } = req.body;
  if (!motoId1 || !motoId2 || !firstMotoId) return res.status(400).json({ error: "motoId1, motoId2, firstMotoId required" });
  const id1 = Number(motoId1);
  const id2 = Number(motoId2);
  const firstId = Number(firstMotoId);
  if (id1 === id2) return res.status(400).json({ error: "Cannot stagger a moto with itself" });
  const secondId = firstId === id1 ? id2 : id1;
  await db.update(motosTable).set({ staggeredWithMotoId: secondId, staggeredOrder: 1 }).where(eq(motosTable.id, firstId));
  await db.update(motosTable).set({ staggeredWithMotoId: firstId, staggeredOrder: 2 }).where(eq(motosTable.id, secondId));
  return res.json({ ok: true });
});

// Unlink stagger for a moto (also unlinks partner)
router.delete("/motos/:motoId/stagger", async (req, res) => {
  const id = Number(req.params.motoId);
  const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, id));
  if (!moto) return res.status(404).json({ error: "Not found" });
  await db.update(motosTable).set({ staggeredWithMotoId: null, staggeredOrder: null }).where(eq(motosTable.id, id));
  if (moto.staggeredWithMotoId) {
    await db.update(motosTable).set({ staggeredWithMotoId: null, staggeredOrder: null }).where(eq(motosTable.id, moto.staggeredWithMotoId));
  }
  return res.json({ ok: true });
});

// Bulk-delete all non-completed motos for an event
router.delete("/events/:eventId/motos", async (req, res) => {
  const eventId = Number(req.params.eventId);

  // Collect the IDs first so we can clean up FK-dependent rows
  const targets = await db
    .select({ id: motosTable.id })
    .from(motosTable)
    .where(and(eq(motosTable.eventId, eventId), ne(motosTable.status, "completed")));

  if (targets.length === 0) return res.status(204).send();

  const ids = targets.map((m) => m.id);

  // Delete FK-dependent rows before deleting motos
  // (lap_crossings and race_results both have non-cascading FKs on moto_id)
  await db.delete(lapCrossingsTable).where(inArray(lapCrossingsTable.motoId, ids));
  await db.delete(raceResultsTable).where(inArray(raceResultsTable.motoId, ids));
  await db.delete(motosTable).where(inArray(motosTable.id, ids));

  return res.status(204).send();
});

router.post("/events/:eventId/generate-lineups", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const {
    raceFormat, classes, ridersPerHeat, usePracticeSeeding, gateSeedingMethod: rawMethod,
    gatePickMethod,        // "random" | "practice" | "prior_round_finish" | "first_registered"
    rounds: roundsFilter,  // new: number[] — if provided, only generate these round numbers
    lapCount,              // optional: target laps for laps-based races
    minRacesBetween,       // optional: minimum motos between a rider's consecutive races
  } = req.body;
  const minGap: number = minRacesBetween && Number(minRacesBetween) >= 1 ? Math.min(3, Number(minRacesBetween)) : 0;
  const motoLapCount: number | null = lapCount != null && Number(lapCount) > 0 ? Number(lapCount) : null;

  // Map gatePickMethod to internal seeding method + gate assignment flag.
  // gatePickMethod supersedes gateSeedingMethod when both are present.
  let seedingMethod: "random" | "practice_fastest_lap" | "previous_round" | "registration_order" | "series_points";
  if (gatePickMethod) {
    seedingMethod = gatePickMethod === "practice" ? "practice_fastest_lap"
      : gatePickMethod === "prior_round_finish" ? "previous_round"
      : gatePickMethod === "first_registered" ? "registration_order"
      : gatePickMethod === "series_points" ? "series_points"
      : "random";
  } else {
    // Backward compat: legacy gateSeedingMethod / usePracticeSeeding fields
    seedingMethod = rawMethod ?? (usePracticeSeeding ? "practice_fastest_lap" : "random");
  }

  // Helper: infer round number from moto name/type.
  // Used for both round-filtered deletion and previous_round seeding.
  function getRoundFromMoto(m: { name: string | null; type: string | null }): number {
    const nameMatch = (m.name ?? "").match(/\bMoto\s+(\d+)\b/i);
    if (nameMatch) return parseInt(nameMatch[1]);
    if (m.type === "main") return 2;
    return 1; // heat / lcq / unknown → qualifying round
  }

  // --- Guard: skip classes that already have completed motos to preserve results ---
  // Exception: previous_round intentionally uses completed motos for seeding, so those classes
  // are NOT locked — we keep completed motos and only delete/replace the scheduled ones.
  const existingMotos = await db.select({
    id: motosTable.id,
    raceClass: motosTable.raceClass,
    status: motosTable.status,
    motoNumber: motosTable.motoNumber,
    name: motosTable.name,
    type: motosTable.type,
  }).from(motosTable).where(eq(motosTable.eventId, eventId));

  const lockedClasses = seedingMethod === "previous_round"
    ? new Set<string>()  // previous_round: no locking — completed motos are needed for seeding
    : new Set(
        existingMotos
          .filter(m => m.status === "completed")
          .map(m => m.raceClass)
          .filter((c): c is string => c != null)
      );

  // Only generate for classes that have no completed motos (or all classes for previous_round)
  const classesToGenerate: string[] = ((classes as string[]) || []).filter(c => !lockedClasses.has(c));

  // Compute divCount early so the deletion step can use it for locked-class cleanup.
  const divCount = raceFormat === "three_moto" ? 3 : raceFormat === "two_moto" ? 2 : 1;

  // Delete existing non-completed motos:
  //  - For unlocked classes being regenerated: delete all scheduled motos (or only the
  //    specified rounds if a roundsFilter was provided).
  //  - For locked classes (have ≥1 completed moto): delete scheduled motos in rounds
  //    BEYOND divCount so stale future rounds are cleaned up when the user switches formats
  //    (e.g. switching from 3-moto to 1-moto removes the scheduled rounds 2 and 3).
  // Completed motos are always preserved.
  const deletedMotoIds = new Set<number>();
  const roundsSet = roundsFilter && (roundsFilter as number[]).length > 0 ? new Set<number>(roundsFilter as number[]) : null;
  const idsToDelete = existingMotos
    .filter(m => {
      if (m.raceClass == null) return false;
      if (m.status === "completed") return false;
      if (lockedClasses.has(m.raceClass)) {
        // Locked class: only prune rounds beyond what was requested.
        return getRoundFromMoto(m) > divCount;
      }
      // Unlocked class: only touch classes being regenerated.
      if (!classesToGenerate.includes(m.raceClass)) return false;
      if (roundsSet !== null && !roundsSet.has(getRoundFromMoto(m))) return false;
      return true;
    })
    .map(m => m.id);
  if (idsToDelete.length > 0) {
    idsToDelete.forEach(id => deletedMotoIds.add(id));
    await db.delete(motosTable).where(inArray(motosTable.id, idsToDelete));
  }

  // Determine if this is a Supercross-style event (main event only, heats feed into main)
  const { isSupercross: isSupercrossFormat } = await getEventFormat(eventId);

  // --- Registration order (registration_order method) ---
  // riderId → position (1 = first registered, higher = later)
  let registrationOrderByRider: Map<number, number> = new Map();

  if (seedingMethod === "registration_order") {
    const regs = await db.select({
      riderId: registrationsTable.riderId,
      createdAt: registrationsTable.createdAt,
    }).from(registrationsTable)
      .where(eq(registrationsTable.eventId, eventId))
      .orderBy(registrationsTable.createdAt);
    regs.forEach((r, idx) => {
      if (r.riderId != null) registrationOrderByRider.set(r.riderId, idx + 1);
    });
  }

  // --- Practice lap times (practice_fastest_lap method) ---
  let bestLapByRider: Map<number, number> = new Map(); // riderId → best lap ms

  if (seedingMethod === "practice_fastest_lap") {
    const [eventRow] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
    if (eventRow?.clubId) {
      const sessions = await db.select({ id: practiceSessionsTable.id })
        .from(practiceSessionsTable)
        .where(eq(practiceSessionsTable.clubId, eventRow.clubId));
      if (sessions.length > 0) {
        const sessionIds = sessions.map(s => s.id);
        const bestLaps = await db.select({
          riderId: practiceCrossingsTable.riderId,
          bestLap: min(practiceCrossingsTable.lapTimeMs),
        })
          .from(practiceCrossingsTable)
          .where(inArray(practiceCrossingsTable.sessionId, sessionIds))
          .groupBy(practiceCrossingsTable.riderId);
        for (const row of bestLaps) {
          if (row.riderId != null && row.bestLap != null && row.bestLap > 0) {
            bestLapByRider.set(row.riderId, Number(row.bestLap));
          }
        }
      }
    }
  }

  // --- Previous round data (previous_round method) ---
  // Key: class → Map<riderId, { position: number; bestLapMs: number | null }>
  const prevRoundByClass = new Map<string, Map<number, { position: number; bestLapMs: number | null }>>();

  if (seedingMethod === "previous_round") {
    // Only race motos (heat/main/lcq) carry race_results — exclude practice motos
    const completedMotos = existingMotos.filter(m =>
      m.status === "completed" && m.raceClass != null && m.type !== "practice"
    );

    // Group completed motos by class for round detection
    const completedByClass = new Map<string, { id: number; motoNumber: number; name: string | null; type: string | null }[]>();
    for (const m of completedMotos) {
      const cls = m.raceClass as string;
      if (!completedByClass.has(cls)) completedByClass.set(cls, []);
      completedByClass.get(cls)!.push(m);
    }

    // Assign round numbers using the shared getRoundFromMoto helper defined at handler scope.
    // Strategy:
    //  1. "Moto N" in name -> use N (covers standard multi-round and multi-div classes,
    //     e.g. "Div 1 Moto 1" and "Div 2 Moto 1" both yield round 1).
    //  2. No "Moto N" (Supercross-style): heat/lcq -> round 1, main -> round 2.
    const motoRoundNumber = new Map<number, number>(); // motoId → round number
    for (const [, motos] of completedByClass) {
      for (const m of motos) {
        motoRoundNumber.set(m.id, getRoundFromMoto(m));
      }
    }

    // For each class, find the maximum (most recent) round number
    const maxRoundByClass = new Map<string, number>();
    for (const m of completedMotos) {
      const cls = m.raceClass as string;
      const rn = motoRoundNumber.get(m.id) ?? 1;
      maxRoundByClass.set(cls, Math.max(maxRoundByClass.get(cls) ?? 0, rn));
    }

    // Collect moto IDs that belong to the most recent round for each class
    const prevRoundMotoIds: number[] = [];
    for (const m of completedMotos) {
      const cls = m.raceClass as string;
      if ((motoRoundNumber.get(m.id) ?? 1) === maxRoundByClass.get(cls)) {
        prevRoundMotoIds.push(m.id);
      }
    }

    if (prevRoundMotoIds.length > 0) {
      // Load race results for those motos
      const results = await db.select({
        motoId: raceResultsTable.motoId,
        riderId: raceResultsTable.riderId,
        raceClass: raceResultsTable.raceClass,
        position: raceResultsTable.position,
        dnf: raceResultsTable.dnf,
        dns: raceResultsTable.dns,
      }).from(raceResultsTable).where(inArray(raceResultsTable.motoId, prevRoundMotoIds));

      // Load best lap time per rider from those motos (for tiebreaking)
      const bestLapsForRound = await db.select({
        motoId: lapCrossingsTable.motoId,
        riderId: lapCrossingsTable.riderId,
        bestLap: min(lapCrossingsTable.lapTimeMs),
      })
        .from(lapCrossingsTable)
        .where(and(
          inArray(lapCrossingsTable.motoId, prevRoundMotoIds),
          gt(lapCrossingsTable.lapTimeMs, 0),
        ))
        .groupBy(lapCrossingsTable.motoId, lapCrossingsTable.riderId);

      // Build riderId → best lap ms across all prev-round motos
      const bestLapInRound = new Map<number, number>(); // riderId → best lap ms
      for (const row of bestLapsForRound) {
        if (row.riderId != null && row.bestLap != null && row.bestLap > 0) {
          const existing = bestLapInRound.get(row.riderId);
          const lap = Number(row.bestLap);
          bestLapInRound.set(row.riderId, existing != null ? Math.min(existing, lap) : lap);
        }
      }

      // Build per-class seed map: riderId → { position, bestLapMs }
      // DNF/DNS riders get a high synthetic position so they seed last
      const HIGH_POS = 9999;
      for (const r of results) {
        const cls = r.raceClass;
        if (!prevRoundByClass.has(cls)) prevRoundByClass.set(cls, new Map());
        const classMap = prevRoundByClass.get(cls)!;
        const pos = (r.dnf || r.dns) ? HIGH_POS : r.position;
        const existing = classMap.get(r.riderId);
        // Keep best (lowest) position if a rider appeared in multiple motos this round
        if (!existing || pos < existing.position) {
          classMap.set(r.riderId, {
            position: pos,
            bestLapMs: bestLapInRound.get(r.riderId) ?? null,
          });
        }
      }
    }
  }

  // --- Series points (series_points method) ---
  // Key: raceClass → Map<riderId, totalPoints>
  const seriesPointsByClass = new Map<string, Map<number, number>>();

  if (seedingMethod === "series_points") {
    const allSeries = await db.select().from(seriesTable);
    const eventSeries = allSeries.find(s => (s.eventIds as number[]).includes(eventId));
    if (eventSeries) {
      const pts = await db.select({
        riderId: seriesPointsTable.riderId,
        raceClass: seriesPointsTable.raceClass,
        totalPoints: seriesPointsTable.totalPoints,
      }).from(seriesPointsTable).where(eq(seriesPointsTable.seriesId, eventSeries.id));

      for (const row of pts) {
        if (!seriesPointsByClass.has(row.raceClass)) seriesPointsByClass.set(row.raceClass, new Map());
        seriesPointsByClass.get(row.raceClass)!.set(row.riderId, row.totalPoints);
      }
    }
  }

  // Effective max per heat: explicit input OR unlimited
  const effectiveMax: number = ridersPerHeat && ridersPerHeat > 0 ? ridersPerHeat : Infinity;

  const checkins = await db.select({
    riderId: checkinsTable.riderId,
    raceClass: checkinsTable.raceClass,
    bibNumber: checkinsTable.bibNumber,
    rfidNumber: checkinsTable.rfidNumber,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(checkinsTable)
    .leftJoin(ridersTable, eq(checkinsTable.riderId, ridersTable.id))
    .where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.checkedIn, true)));

  const motos: typeof motosTable.$inferSelect[] = [];
  // Start numbering after the highest surviving moto number (excluding deleted ones).
  // If all motos were deleted (full re-generation), this resets to 1.
  // If some completed motos survive, numbering continues from their max.
  const maxExistingMotoNumber = existingMotos
    .filter(m => !deletedMotoIds.has(m.id))
    .reduce((max, m) => Math.max(max, m.motoNumber ?? 0), 0);
  let motoNumber = maxExistingMotoNumber + 1;

  type CheckinRow = typeof checkins[0];

  // Helper: assign gate positions to a pre-ordered group of riders
  function buildLineup(groupRiders: CheckinRow[], seedingOrder: number[]): Array<Record<string, unknown>> {
    if (seedingOrder.length === 0) {
      return groupRiders.map((r, i) => ({
        position: i + 1,
        riderId: r.riderId,
        riderName: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
        bibNumber: r.bibNumber,
        rfidNumber: r.rfidNumber,
      }));
    }
    return groupRiders.map((r, i) => ({
      position: i + 1,
      gate: seedingOrder[i] ?? null,
      riderId: r.riderId,
      riderName: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
      bibNumber: r.bibNumber,
      rfidNumber: r.rfidNumber,
    }));
  }

  // Helper: sort riders for a class according to the chosen seeding method
  function sortRidersForClass(riders: CheckinRow[], cls: string): CheckinRow[] {
    if (seedingMethod === "registration_order") {
      return [...riders].sort((a, b) => {
        const ra = a.riderId != null ? (registrationOrderByRider.get(a.riderId) ?? Infinity) : Infinity;
        const rb = b.riderId != null ? (registrationOrderByRider.get(b.riderId) ?? Infinity) : Infinity;
        return ra - rb;
      });
    }
    if (seedingMethod === "practice_fastest_lap") {
      return [...riders].sort((a, b) => {
        const la = a.riderId != null ? (bestLapByRider.get(a.riderId) ?? Infinity) : Infinity;
        const lb = b.riderId != null ? (bestLapByRider.get(b.riderId) ?? Infinity) : Infinity;
        return la - lb;
      });
    }
    if (seedingMethod === "previous_round") {
      const classMap = prevRoundByClass.get(cls);
      return [...riders].sort((a, b) => {
        const da = a.riderId != null ? classMap?.get(a.riderId) : undefined;
        const db_ = b.riderId != null ? classMap?.get(b.riderId) : undefined;
        // Riders with no prior result go last
        const posA = da?.position ?? Infinity;
        const posB = db_?.position ?? Infinity;
        if (posA !== posB) return posA - posB;
        // Tiebreak: fastest lap (ascending, nulls last)
        const lapA = da?.bestLapMs ?? Infinity;
        const lapB = db_?.bestLapMs ?? Infinity;
        return lapA - lapB;
      });
    }
    if (seedingMethod === "series_points") {
      const classPoints = seriesPointsByClass.get(cls);
      // Split: riders with points vs zero/no points
      const withPts = [...riders].filter(r => r.riderId != null && (classPoints?.get(r.riderId) ?? 0) > 0);
      const noPts = [...riders].filter(r => r.riderId == null || (classPoints?.get(r.riderId) ?? 0) === 0);
      // Sort points-holders descending
      withPts.sort((a, b) => {
        const pa = a.riderId != null ? (classPoints?.get(a.riderId) ?? 0) : 0;
        const pb = b.riderId != null ? (classPoints?.get(b.riderId) ?? 0) : 0;
        return pb - pa;
      });
      // Shuffle zero-point riders randomly
      for (let i = noPts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [noPts[i], noPts[j]] = [noPts[j], noPts[i]];
      }
      return [...withPts, ...noPts];
    }
    // random: shuffle
    const arr = [...riders];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Pre-compute groups for every class before inserting any motos so we can
  // interleave them in round-robin order (all classes run Moto 1 before any run Moto 2).
  type ClassEntry = { cls: string; groups: CheckinRow[][] };
  const allClassGroups: ClassEntry[] = [];

  for (const cls of classesToGenerate) {
    let classRiders = checkins.filter(c => c.raceClass === cls);
    if (classRiders.length === 0) continue;

    // Sort riders according to chosen method before group distribution
    classRiders = sortRidersForClass(classRiders, cls);

    const numGroups = effectiveMax === Infinity ? 1 : Math.ceil(classRiders.length / effectiveMax);
    const groups: CheckinRow[][] = Array.from({ length: numGroups }, () => []);

    const useSerp = (seedingMethod === "registration_order" || seedingMethod === "practice_fastest_lap" || seedingMethod === "previous_round" || seedingMethod === "series_points") && numGroups > 1;
    if (useSerp) {
      // Serpentine (snake) distribution: ensures balanced competition across groups
      classRiders.forEach((rider, idx) => {
        const round = Math.floor(idx / numGroups);
        const posInRound = idx % numGroups;
        const groupIdx = round % 2 === 0 ? posInRound : numGroups - 1 - posInRound;
        groups[groupIdx].push(rider);
      });
    } else {
      // Default: sequential fill (also used for random — each group is already shuffled)
      const baseSize = Math.floor(classRiders.length / numGroups);
      const extras = classRiders.length % numGroups;
      let offset = 0;
      for (let g = 0; g < numGroups; g++) {
        const size = baseSize + (g < extras ? 1 : 0);
        groups[g] = classRiders.slice(offset, offset + size);
        offset += size;
      }
    }

    allClassGroups.push({ cls, groups });
  }

  if (isSupercrossFormat) {
    // Supercross: all heats across all classes run before any main events
    for (const { cls, groups } of allClassGroups) {
      const multiGroup = groups.length > 1;
      for (let h = 0; h < groups.length; h++) {
        const heatName = multiGroup ? `${cls} Heat ${h + 1}` : `${cls} Heat`;
        const lineup = buildLineup(groups[h], []);
        const [moto] = await db.insert(motosTable).values({
          eventId, name: heatName, type: "heat", raceClass: cls,
          motoNumber: motoNumber++, status: "scheduled", lineup,
          lapCount: motoLapCount,
        }).returning();
        motos.push(moto);
      }
    }
    for (const { cls } of allClassGroups) {
      const [mainMoto] = await db.insert(motosTable).values({
        eventId, name: `${cls} Main Event`, type: "main", raceClass: cls,
        motoNumber: motoNumber++, status: "scheduled", lineup: [],
        lapCount: motoLapCount,
      }).returning();
      motos.push(mainMoto);
    }
  } else {
    // Round-robin: all classes complete Moto 1 before any class runs Moto 2, etc.
    // If roundsFilter is provided, only generate the specified rounds.
    const roundsSet = roundsFilter && (roundsFilter as number[]).length > 0 ? new Set<number>(roundsFilter as number[]) : null;

    // Build the flat list of tasks to insert (before scheduling)
    type ScheduleTask = { cls: string; groupIdx: number; round: number; name: string; riders: CheckinRow[] };
    const tasks: ScheduleTask[] = [];
    for (let d = 1; d <= divCount; d++) {
      if (roundsSet !== null && !roundsSet.has(d)) continue;
      for (const { cls, groups } of allClassGroups) {
        const multiGroup = groups.length > 1;
        for (let h = 0; h < groups.length; h++) {
          const groupLabel = multiGroup ? ` Div ${h + 1}` : "";
          const motoLabel = divCount > 1 ? ` Moto ${d}` : " Moto";
          tasks.push({ cls, groupIdx: h, round: d, name: `${cls}${groupLabel}${motoLabel}`, riders: groups[h] });
        }
      }
    }

    // Greedy multi-class spacing scheduler (only when minGap > 0 and multiple classes exist)
    let orderedTasks = tasks;
    if (minGap > 0 && tasks.length > 1) {
      // Build: riderId → set of task indices
      const riderTaskIndices = new Map<number, number[]>();
      for (let i = 0; i < tasks.length; i++) {
        for (const r of tasks[i].riders) {
          if (r.riderId == null) continue;
          if (!riderTaskIndices.has(r.riderId)) riderTaskIndices.set(r.riderId, []);
          riderTaskIndices.get(r.riderId)!.push(i);
        }
      }
      // Only consider riders who appear in multiple tasks (multi-class riders)
      const multiClassRiders = new Map<number, number[]>();
      for (const [rid, idxs] of riderTaskIndices) {
        if (idxs.length > 1) multiClassRiders.set(rid, idxs);
      }

      if (multiClassRiders.size > 0) {
        // Greedy: at each position, pick the remaining task that causes fewest gap violations
        const remaining = new Set<number>(tasks.map((_, i) => i));
        const scheduled: number[] = []; // task indices in scheduled order
        const riderLastPos = new Map<number, number>(); // riderId → last scheduled position (0-indexed)

        while (remaining.size > 0) {
          let bestIdx = -1;
          let bestViolations = Infinity;
          let bestMinGapForBest = -Infinity;

          const pos = scheduled.length;
          for (const taskIdx of remaining) {
            const task = tasks[taskIdx];
            let violations = 0;
            let worstGap = Infinity; // worst (smallest) gap this task would create
            for (const r of task.riders) {
              if (r.riderId == null) continue;
              const lastPos = riderLastPos.get(r.riderId);
              if (lastPos == null) continue;
              const gap = pos - lastPos - 1;
              if (gap < minGap) violations++;
              if (gap < worstGap) worstGap = gap;
            }
            // Primary: fewest violations; Secondary: largest worstGap (most breathing room)
            const minGapForTask = worstGap === Infinity ? Infinity : worstGap;
            if (violations < bestViolations || (violations === bestViolations && minGapForTask > bestMinGapForBest)) {
              bestViolations = violations;
              bestMinGapForBest = minGapForTask;
              bestIdx = taskIdx;
            }
          }

          scheduled.push(bestIdx);
          remaining.delete(bestIdx);
          for (const r of tasks[bestIdx].riders) {
            if (r.riderId != null) riderLastPos.set(r.riderId, scheduled.length - 1);
          }
        }

        orderedTasks = scheduled.map(i => tasks[i]);
      }
    }

    // Insert motos in the final scheduled order
    for (const task of orderedTasks) {
      const lineup = buildLineup(task.riders, []);
      const [moto] = await db.insert(motosTable).values({
        eventId, name: task.name, type: "heat", raceClass: task.cls,
        motoNumber: motoNumber++, status: "scheduled", lineup,
        lapCount: motoLapCount,
      }).returning();
      motos.push(moto);
    }
  }

  return res.json(motos.map(m => ({
    ...m,
    lineup: Array.isArray(m.lineup) ? m.lineup : [],
    createdAt: m.createdAt.toISOString(),
  })));
});

// Auto-assign checked-in riders to scheduled practice sessions
router.post("/events/:eventId/generate-practice-sessions", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const {
    raceClass, raceClasses, maxRidersPerSession, timeLimitMs, scheduledTime,
    name: customName, lapCount, countdownSeconds, practiceMode,
  } = req.body;

  // Accept raceClasses[] (multi-class) or legacy raceClass string
  const targetClasses: string[] = Array.isArray(raceClasses) && raceClasses.length > 0
    ? raceClasses
    : raceClass ? [raceClass] : [];

  if (targetClasses.length === 0 || !maxRidersPerSession) {
    return res.status(400).json({ error: "raceClasses (or raceClass) and maxRidersPerSession required" });
  }

  const max = Number(maxRidersPerSession);
  if (isNaN(max) || max < 1) return res.status(400).json({ error: "maxRidersPerSession must be a positive integer" });

  const isAllClasses = targetClasses.includes("All Classes");

  const checkins = await db.select({
    riderId: checkinsTable.riderId,
    raceClass: checkinsTable.raceClass,
    bibNumber: checkinsTable.bibNumber,
    rfidNumber: checkinsTable.rfidNumber,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(checkinsTable)
    .leftJoin(ridersTable, eq(checkinsTable.riderId, ridersTable.id))
    .where(and(
      eq(checkinsTable.eventId, eventId),
      eq(checkinsTable.checkedIn, true),
      ...(!isAllClasses ? [inArray(checkinsTable.raceClass, targetClasses)] : []),
    ));

  if (checkins.length === 0) {
    return res.status(400).json({ error: "No checked-in riders found for the selected class(es)" });
  }

  const existingMotos = await db.select({ motoNumber: motosTable.motoNumber })
    .from(motosTable).where(eq(motosTable.eventId, eventId));
  const maxMotoNumber = existingMotos.reduce((mx, m) => Math.max(mx, m.motoNumber ?? 0), 0);
  let nextMotoNumber = maxMotoNumber + 1;

  type LineupEntry = { position: number; riderId: number; riderName: string; bibNumber: string | null; rfidNumber: string | null };

  const sessionCount = Math.ceil(checkins.length / max);
  const created = [];

  for (let i = 0; i < checkins.length; i += max) {
    const group = checkins.slice(i, i + max);
    const sessionNum = Math.floor(i / max) + 1;
    const suffix = sessionCount > 1 ? ` – Group ${sessionNum}` : "";

    const baseName = customName?.trim()
      ? customName.trim()
      : isAllClasses
        ? "Open Practice"
        : targetClasses.length > 1
          ? "Mixed Practice"
          : `${targetClasses[0]} Practice`;
    const name = `${baseName}${suffix}`;

    const lineup: LineupEntry[] = group.map((r, idx) => ({
      position: idx + 1,
      riderId: r.riderId,
      riderName: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || `Rider #${r.riderId}`,
      bibNumber: r.bibNumber ?? null,
      rfidNumber: r.rfidNumber ?? null,
    }));

    const [moto] = await db.insert(motosTable).values({
      eventId,
      name,
      type: "practice",
      raceClass: isAllClasses ? "" : targetClasses[0],
      raceClasses: isAllClasses ? null : targetClasses,
      motoNumber: nextMotoNumber++,
      status: "scheduled",
      lineup,
      timeLimitMs: timeLimitMs ? Number(timeLimitMs) : null,
      scheduledTime: scheduledTime ?? null,
      lapCount: lapCount ? Number(lapCount) : null,
      practiceMode: practiceMode ?? "lap_count",
      countdownSeconds: countdownSeconds ? Number(countdownSeconds) : null,
    }).returning();

    created.push({
      ...moto,
      lineup: Array.isArray(moto.lineup) ? moto.lineup : [],
      createdAt: moto.createdAt.toISOString(),
    });
  }

  return res.status(201).json(created);
});

// Bulk reorder motos for an event by reassigning motoNumber values
router.post("/events/:eventId/motos/reorder", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { motoIds } = req.body as { motoIds: number[] };
  if (!Array.isArray(motoIds) || motoIds.length === 0) {
    return res.status(400).json({ error: "motoIds array is required" });
  }

  // Reject duplicate IDs
  const unique = new Set(motoIds);
  if (unique.size !== motoIds.length) {
    return res.status(400).json({ error: "motoIds must not contain duplicates" });
  }

  // Validate all IDs belong to this event
  const existing = await db.select({ id: motosTable.id })
    .from(motosTable)
    .where(and(eq(motosTable.eventId, eventId), inArray(motosTable.id, motoIds)));

  const existingIds = new Set(existing.map(m => m.id));
  const invalid = motoIds.filter(id => !existingIds.has(id));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Moto IDs not found in event: ${invalid.join(", ")}` });
  }

  // Atomically update all motoNumber values in a transaction
  await db.transaction(async (tx) => {
    await Promise.all(
      motoIds.map((id, index) =>
        tx.update(motosTable)
          .set({ motoNumber: index + 1 })
          .where(and(eq(motosTable.id, id), eq(motosTable.eventId, eventId)))
      )
    );
  });

  const motos = await db.select().from(motosTable)
    .where(eq(motosTable.eventId, eventId))
    .orderBy(motosTable.motoNumber);

  return res.json(motos.map(m => ({
    ...m,
    lineup: Array.isArray(m.lineup) ? m.lineup : [],
    createdAt: m.createdAt.toISOString(),
    startedAt: m.startedAt?.toISOString() ?? null,
    completedAt: m.completedAt?.toISOString() ?? null,
  })));
});

// Regenerate lineup for a single moto
router.post("/events/:eventId/motos/:motoId/generate-lineup", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const motoId = Number(req.params.motoId);
  const { gatePickMethod = "random" } = req.body;

  const [moto] = await db.select().from(motosTable).where(
    and(eq(motosTable.id, motoId), eq(motosTable.eventId, eventId))
  );
  if (!moto) return res.status(404).json({ error: "Moto not found" });
  if (moto.status === "completed") return res.status(409).json({ error: "Moto is completed — lineup is locked" });
  if (!moto.raceClass) return res.status(400).json({ error: "Moto has no race class" });

  const raceClass = moto.raceClass;
  const seedingMethod: "random" | "practice_fastest_lap" | "previous_round" | "registration_order" =
    gatePickMethod === "practice" ? "practice_fastest_lap"
    : gatePickMethod === "prior_round_finish" ? "previous_round"
    : gatePickMethod === "first_registered" ? "registration_order"
    : "random";

  // Load checked-in riders for this class
  const checkins = await db.select({
    riderId: checkinsTable.riderId,
    raceClass: checkinsTable.raceClass,
    bibNumber: checkinsTable.bibNumber,
    rfidNumber: checkinsTable.rfidNumber,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(checkinsTable)
    .leftJoin(ridersTable, eq(checkinsTable.riderId, ridersTable.id))
    .where(and(
      eq(checkinsTable.eventId, eventId),
      eq(checkinsTable.checkedIn, true),
      eq(checkinsTable.raceClass, raceClass),
    ));

  if (checkins.length === 0) {
    return res.status(400).json({ error: `No checked-in riders found for ${raceClass}` });
  }

  // Load registration order if needed
  const registrationOrderByRiderPerMoto = new Map<number, number>();
  if (seedingMethod === "registration_order") {
    const regs = await db.select({
      riderId: registrationsTable.riderId,
      createdAt: registrationsTable.createdAt,
    }).from(registrationsTable)
      .where(eq(registrationsTable.eventId, eventId))
      .orderBy(registrationsTable.createdAt);
    regs.forEach((r, idx) => {
      if (r.riderId != null) registrationOrderByRiderPerMoto.set(r.riderId, idx + 1);
    });
  }

  // Load practice laps if needed
  const bestLapByRider = new Map<number, number>();
  if (seedingMethod === "practice_fastest_lap") {
    const [eventRow] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
    if (eventRow?.clubId) {
      const sessions = await db.select({ id: practiceSessionsTable.id })
        .from(practiceSessionsTable).where(eq(practiceSessionsTable.clubId, eventRow.clubId));
      if (sessions.length > 0) {
        const sessionIds = sessions.map(s => s.id);
        const bestLaps = await db.select({
          riderId: practiceCrossingsTable.riderId,
          bestLap: min(practiceCrossingsTable.lapTimeMs),
        }).from(practiceCrossingsTable)
          .where(inArray(practiceCrossingsTable.sessionId, sessionIds))
          .groupBy(practiceCrossingsTable.riderId);
        for (const row of bestLaps) {
          if (row.riderId != null && row.bestLap != null && row.bestLap > 0) {
            bestLapByRider.set(row.riderId, Number(row.bestLap));
          }
        }
      }
    }
  }

  // Load previous round data if needed
  const prevRoundSeedMap = new Map<number, { position: number; bestLapMs: number | null }>();
  if (seedingMethod === "previous_round") {
    function getPerMotoRound(m: { name: string | null; type: string | null }): number {
      const nameMatch = (m.name ?? "").match(/\bMoto\s+(\d+)\b/i);
      if (nameMatch) return parseInt(nameMatch[1]);
      if (m.type === "main") return 2;
      return 1;
    }
    const completedMotos = await db.select({
      id: motosTable.id, name: motosTable.name, type: motosTable.type,
    }).from(motosTable).where(and(
      eq(motosTable.eventId, eventId),
      eq(motosTable.raceClass, raceClass),
      eq(motosTable.status, "completed"),
    ));
    const maxRound = completedMotos.reduce((mx, m) => Math.max(mx, getPerMotoRound(m)), 0);
    const prevRoundMotoIds = completedMotos.filter(m => getPerMotoRound(m) === maxRound).map(m => m.id);
    if (prevRoundMotoIds.length > 0) {
      const results = await db.select({
        riderId: raceResultsTable.riderId,
        position: raceResultsTable.position,
        dnf: raceResultsTable.dnf,
        dns: raceResultsTable.dns,
      }).from(raceResultsTable).where(inArray(raceResultsTable.motoId, prevRoundMotoIds));
      const bestLapsRound = await db.select({
        riderId: lapCrossingsTable.riderId,
        bestLap: min(lapCrossingsTable.lapTimeMs),
      }).from(lapCrossingsTable)
        .where(and(inArray(lapCrossingsTable.motoId, prevRoundMotoIds), gt(lapCrossingsTable.lapTimeMs, 0)))
        .groupBy(lapCrossingsTable.riderId);
      const bestLapInRound = new Map<number, number>();
      for (const row of bestLapsRound) {
        if (row.riderId != null && row.bestLap != null && row.bestLap > 0) {
          bestLapInRound.set(row.riderId, Number(row.bestLap));
        }
      }
      const HIGH_POS = 9999;
      for (const r of results) {
        if (r.riderId == null) continue;
        const pos = (r.dnf || r.dns) ? HIGH_POS : r.position;
        const existing = prevRoundSeedMap.get(r.riderId);
        if (!existing || pos < existing.position) {
          prevRoundSeedMap.set(r.riderId, { position: pos, bestLapMs: bestLapInRound.get(r.riderId) ?? null });
        }
      }
    }
  }

  // Sort riders according to seeding method
  let sortedRiders = [...checkins];
  if (seedingMethod === "registration_order") {
    sortedRiders.sort((a, b) => {
      const ra = a.riderId != null ? (registrationOrderByRiderPerMoto.get(a.riderId) ?? Infinity) : Infinity;
      const rb = b.riderId != null ? (registrationOrderByRiderPerMoto.get(b.riderId) ?? Infinity) : Infinity;
      return ra - rb;
    });
  } else if (seedingMethod === "practice_fastest_lap") {
    sortedRiders.sort((a, b) => {
      const la = a.riderId != null ? (bestLapByRider.get(a.riderId) ?? Infinity) : Infinity;
      const lb = b.riderId != null ? (bestLapByRider.get(b.riderId) ?? Infinity) : Infinity;
      return la - lb;
    });
  } else if (seedingMethod === "previous_round") {
    sortedRiders.sort((a, b) => {
      const da = a.riderId != null ? prevRoundSeedMap.get(a.riderId) : undefined;
      const db_ = b.riderId != null ? prevRoundSeedMap.get(b.riderId) : undefined;
      const posA = da?.position ?? Infinity;
      const posB = db_?.position ?? Infinity;
      if (posA !== posB) return posA - posB;
      return (da?.bestLapMs ?? Infinity) - (db_?.bestLapMs ?? Infinity);
    });
  } else {
    for (let i = sortedRiders.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [sortedRiders[i], sortedRiders[j]] = [sortedRiders[j], sortedRiders[i]];
    }
  }

  // Build lineup
  const lineup = sortedRiders.map((r, i) => ({
    position: i + 1,
    riderId: r.riderId,
    riderName: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
    bibNumber: r.bibNumber,
    rfidNumber: r.rfidNumber,
  }));

  const [updated] = await db.update(motosTable)
    .set({ lineup })
    .where(eq(motosTable.id, motoId))
    .returning();

  return res.json({
    ...updated,
    lineup: Array.isArray(updated.lineup) ? updated.lineup : [],
    createdAt: updated.createdAt.toISOString(),
    startedAt: updated.startedAt?.toISOString() ?? null,
    completedAt: updated.completedAt?.toISOString() ?? null,
  });
});

// Advance top heat finishers into the Main Event lineup (manual trigger)
router.post("/events/:eventId/advance-to-main", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { raceClass, topPerHeat = 5 } = req.body;
  if (!raceClass) return res.status(400).json({ error: "raceClass is required" });

  const heatMotos = await db.select().from(motosTable)
    .where(and(
      eq(motosTable.eventId, eventId),
      eq(motosTable.raceClass, raceClass),
      eq(motosTable.type, "heat"),
    ));

  if (heatMotos.length === 0) return res.status(404).json({ error: "No heat motos found for this class" });

  const [mainMoto] = await db.select().from(motosTable)
    .where(and(
      eq(motosTable.eventId, eventId),
      eq(motosTable.raceClass, raceClass),
      eq(motosTable.type, "main"),
    ));
  if (!mainMoto) return res.status(404).json({ error: "No main event moto found. Generate lineups first." });

  const heatMotoIds = heatMotos.map(m => m.id);
  const allResults = heatMotoIds.length > 0
    ? await db.select().from(raceResultsTable)
        .where(inArray(raceResultsTable.motoId, heatMotoIds))
    : [];

  const resultsByMoto = new Map<number, typeof allResults>();
  for (const r of allResults) {
    if (!resultsByMoto.has(r.motoId)) resultsByMoto.set(r.motoId, []);
    resultsByMoto.get(r.motoId)!.push(r);
  }

  type LineupEntry = { position: number; riderId: number; riderName: string; bibNumber: string | null; rfidNumber: string | null };
  const advancedRiderIds = new Set<number>();
  const advancedLineup: LineupEntry[] = [];

  for (const heat of heatMotos) {
    const results = resultsByMoto.get(heat.id) ?? [];
    const heatLineup = (Array.isArray(heat.lineup) ? heat.lineup : []) as LineupEntry[];

    if (results.length > 0) {
      const sorted = [...results].filter(r => !r.dnf && !r.dns).sort((a, b) => a.position - b.position);
      for (const r of sorted.slice(0, topPerHeat)) {
        if (!advancedRiderIds.has(r.riderId)) {
          advancedRiderIds.add(r.riderId);
          const fromLineup = heatLineup.find(l => l.riderId === r.riderId);
          advancedLineup.push({
            position: advancedLineup.length + 1,
            riderId: r.riderId,
            riderName: fromLineup?.riderName ?? `Rider #${r.riderId}`,
            bibNumber: r.bibNumber ?? fromLineup?.bibNumber ?? null,
            rfidNumber: fromLineup?.rfidNumber ?? null,
          });
        }
      }
    } else {
      const sorted = [...heatLineup].sort((a, b) => a.position - b.position);
      for (const l of sorted.slice(0, topPerHeat)) {
        if (!advancedRiderIds.has(l.riderId)) {
          advancedRiderIds.add(l.riderId);
          advancedLineup.push({
            position: advancedLineup.length + 1,
            riderId: l.riderId,
            riderName: l.riderName,
            bibNumber: l.bibNumber ?? null,
            rfidNumber: l.rfidNumber ?? null,
          });
        }
      }
    }
  }

  advancedLineup.forEach((r, i) => { r.position = i + 1; });

  const [updated] = await db.update(motosTable)
    .set({ lineup: advancedLineup })
    .where(eq(motosTable.id, mainMoto.id))
    .returning();

  return res.json({
    ...updated,
    lineup: Array.isArray(updated.lineup) ? updated.lineup : [],
    createdAt: updated.createdAt.toISOString(),
    startedAt: updated.startedAt?.toISOString() ?? null,
    completedAt: updated.completedAt?.toISOString() ?? null,
  });
});

export default router;
