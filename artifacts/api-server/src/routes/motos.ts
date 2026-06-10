import { Router } from "express";
import { db } from "@workspace/db";
import { motosTable, checkinsTable, ridersTable, eventsTable, raceResultsTable, pointsTablesTable, clubsTable, usersTable, practiceSessionsTable, practiceCrossingsTable, eventPublicationTable, lapCrossingsTable } from "@workspace/db";
import { eq, and, inArray, min, ne, gt } from "drizzle-orm";
import { sseBroadcast, buildLeaderboard } from "./timing";

const router = Router();

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

  // Unauthenticated requests (widgets, public pages) only see published events
  if (!(req.session as any).userId) {
    const [pub] = await db.select({ published: eventPublicationTable.published })
      .from(eventPublicationTable).where(eq(eventPublicationTable.eventId, eventId));
    if (!pub?.published) return res.json([]);
  }

  const motos = await db.select().from(motosTable).where(eq(motosTable.eventId, eventId)).orderBy(motosTable.motoNumber);
  return res.json(motos.map(m => ({
    ...m,
    lineup: Array.isArray(m.lineup) ? m.lineup : [],
    createdAt: m.createdAt.toISOString(),
  })));
});

router.post("/events/:eventId/motos", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { name, type, raceClass, raceClasses, motoNumber, scheduledTime, lineup, lapCount, timeLimitMs } = req.body;

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
  }).returning();

  return res.status(201).json({ ...moto, lineup: Array.isArray(moto.lineup) ? moto.lineup : [], createdAt: moto.createdAt.toISOString() });
});

router.patch("/motos/:motoId", async (req, res) => {
  const id = Number(req.params.motoId);
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
  await db.delete(lapCrossingsTable).where(eq(lapCrossingsTable.motoId, id));
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
  const deleted = await db.delete(motosTable).where(eq(motosTable.id, id)).returning();
  if (deleted.length === 0) return res.status(404).json({ error: "Not found" });
  return res.status(204).send();
});

// Helper: convert a GateConfig's gatePriorities to the seeding order array used by lineup builder
// seedingOrder[seedPos] = gate number for that seed position
function gateConfigToSeedingOrder(config: { gateCount: number; gatePriorities: number[] }): number[] {
  const order: number[] = [];
  for (let seed = 1; seed <= config.gateCount; seed++) {
    const gateIdx = config.gatePriorities.indexOf(seed);
    if (gateIdx !== -1) order.push(gateIdx + 1); // 1-indexed gate number
  }
  return order;
}

router.post("/events/:eventId/generate-lineups", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { raceFormat, classes, ridersPerHeat, usePracticeSeeding, gateSeedingMethod: rawMethod, gateConfigId } = req.body;

  // Determine seeding method — backward compat: usePracticeSeeding:true → practice_fastest_lap
  const seedingMethod: "random" | "practice_fastest_lap" | "previous_round" =
    rawMethod ?? (usePracticeSeeding ? "practice_fastest_lap" : "random");

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

  // Delete existing non-completed motos for the classes we will regenerate (avoid duplicates)
  if (classesToGenerate.length > 0) {
    const idsToDelete = existingMotos
      .filter(m => m.raceClass != null && classesToGenerate.includes(m.raceClass) && m.status !== "completed")
      .map(m => m.id);
    if (idsToDelete.length > 0) {
      await db.delete(motosTable).where(inArray(motosTable.id, idsToDelete));
    }
  }

  // Determine if this is a Supercross-style event (main event only, heats feed into main)
  const { isSupercross: isSupercrossFormat } = await getEventFormat(eventId);

  // --- Load gate config (applies to all seeding methods when gateConfigId is provided) ---
  let gateSeeding: number[] = [];
  let gateCountFromClub: number | null = null;

  // Always resolve a gate config: selected id → event default → first config.
  // This ensures gate assignments are applied regardless of seeding method.
  if (true) {
    const [eventRow] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
    if (eventRow?.clubId) {
      const [club] = await db.select({ gateSeeding: clubsTable.gateSeeding })
        .from(clubsTable).where(eq(clubsTable.id, eventRow.clubId));
      const gateConfigs = (club?.gateSeeding as any[] | null) ?? [];
      const selectedConfig = gateConfigId
        ? gateConfigs.find((c: any) => c.id === gateConfigId)
        : gateConfigs[0];
      if (selectedConfig?.gatePriorities) {
        gateSeeding = gateConfigToSeedingOrder(selectedConfig);
        gateCountFromClub = selectedConfig.gateCount ?? null;
      }
    }
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

    // Assign round numbers using a tiered strategy:
    //  1. "Moto N" in name (e.g. "450 Pro Moto 1") → use N; handles standard multi-round formats and
    //     multi-group classes ("Group 1 Moto 1" and "Group 2 Moto 1" both yield round 1).
    //  2. moto type signal (no "Moto N" in name, i.e. Supercross-style naming):
    //       heat / lcq  → round 1  (qualifying; all heats are the same round)
    //       main        → round 2  (final; always higher than heats/lcq)
    //  Never use sequential index — it incorrectly splits "Heat 1" and "Heat 2" into different rounds.
    function getRoundFromMoto(m: { name: string | null; type: string | null }): number {
      const nameMatch = (m.name ?? "").match(/\bMoto\s+(\d+)\b/i);
      if (nameMatch) return parseInt(nameMatch[1]);
      if (m.type === "main") return 2;
      return 1; // heat / lcq / unknown → qualifying round
    }

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

  // Effective max per heat: explicit input OR gate count (when gate config loaded) OR unlimited
  const effectiveMax: number = ridersPerHeat && ridersPerHeat > 0
    ? ridersPerHeat
    : (gateCountFromClub ? gateCountFromClub : Infinity);

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
  // Start numbering after the highest existing moto number so new motos don't collide with preserved ones
  const maxExistingMotoNumber = existingMotos.reduce((max, m) => Math.max(max, m.motoNumber ?? 0), 0);
  let motoNumber = maxExistingMotoNumber + 1;

  const divCount = raceFormat === "three_moto" ? 3 : raceFormat === "two_moto" ? 2 : 1;

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

    const useSerp = (seedingMethod === "practice_fastest_lap" || seedingMethod === "previous_round") && numGroups > 1;
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
        const lineup = buildLineup(groups[h], gateSeeding);
        const [moto] = await db.insert(motosTable).values({
          eventId, name: heatName, type: "heat", raceClass: cls,
          motoNumber: motoNumber++, status: "scheduled", lineup,
        }).returning();
        motos.push(moto);
      }
    }
    for (const { cls } of allClassGroups) {
      const [mainMoto] = await db.insert(motosTable).values({
        eventId, name: `${cls} Main Event`, type: "main", raceClass: cls,
        motoNumber: motoNumber++, status: "scheduled", lineup: [],
      }).returning();
      motos.push(mainMoto);
    }
  } else {
    // Round-robin: all classes complete Moto 1 before any class runs Moto 2, etc.
    for (let d = 1; d <= divCount; d++) {
      for (const { cls, groups } of allClassGroups) {
        const multiGroup = groups.length > 1;
        for (let h = 0; h < groups.length; h++) {
          const groupLabel = multiGroup ? ` Group ${h + 1}` : "";
          const motoLabel = divCount > 1 ? ` Moto ${d}` : " Moto";
          const name = `${cls}${groupLabel}${motoLabel}`;
          const lineup = buildLineup(groups[h], gateSeeding);
          const [moto] = await db.insert(motosTable).values({
            eventId, name, type: "heat", raceClass: cls,
            motoNumber: motoNumber++, status: "scheduled", lineup,
          }).returning();
          motos.push(moto);
        }
      }
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
  const { raceClass, maxRidersPerSession, timeLimitMs, scheduledTime } = req.body;

  if (!raceClass || !maxRidersPerSession) {
    return res.status(400).json({ error: "raceClass and maxRidersPerSession required" });
  }

  const max = Number(maxRidersPerSession);
  if (isNaN(max) || max < 1) return res.status(400).json({ error: "maxRidersPerSession must be a positive integer" });

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
      ...(raceClass !== "All Classes" ? [eq(checkinsTable.raceClass, raceClass)] : []),
    ));

  if (checkins.length === 0) {
    return res.status(400).json({ error: "No checked-in riders found for the selected class" });
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
    const name = raceClass === "All Classes"
      ? `Open Practice${suffix}`
      : `${raceClass} Practice${suffix}`;

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
      raceClass: raceClass === "All Classes" ? "" : raceClass,
      motoNumber: nextMotoNumber++,
      status: "scheduled",
      lineup,
      timeLimitMs: timeLimitMs ? Number(timeLimitMs) : null,
      scheduledTime: scheduledTime ?? null,
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
