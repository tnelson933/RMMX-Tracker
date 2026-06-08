import { Router } from "express";
import { db } from "@workspace/db";
import { motosTable, checkinsTable, ridersTable, eventsTable, raceResultsTable, pointsTablesTable, clubsTable, usersTable, practiceSessionsTable, practiceCrossingsTable, eventPublicationTable } from "@workspace/db";
import { eq, and, inArray, min } from "drizzle-orm";
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
  const { name, type, raceClass, motoNumber, scheduledTime, lineup, lapCount } = req.body;
  if (!name || !type || !raceClass || motoNumber === undefined) return res.status(400).json({ error: "name, type, raceClass, motoNumber required" });

  const [moto] = await db.insert(motosTable).values({
    eventId, name, type, raceClass, motoNumber, scheduledTime, lineup: lineup || [], status: "scheduled",
    lapCount: lapCount ? Number(lapCount) : null,
  }).returning();

  return res.status(201).json({ ...moto, lineup: Array.isArray(moto.lineup) ? moto.lineup : [], createdAt: moto.createdAt.toISOString() });
});

router.patch("/motos/:motoId", async (req, res) => {
  const id = Number(req.params.motoId);
  const updates: Record<string, unknown> = {};
  if (req.body.status !== undefined) {
    updates.status = req.body.status;
    if (req.body.status === "in_progress") updates.startedAt = new Date();
    if (req.body.status === "completed") updates.completedAt = new Date();
  }
  if (req.body.lineup !== undefined) updates.lineup = req.body.lineup;
  if (req.body.scheduledTime !== undefined) updates.scheduledTime = req.body.scheduledTime;
  if (req.body.lapCount !== undefined) updates.lapCount = req.body.lapCount !== null ? Number(req.body.lapCount) : null;
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
  const { raceFormat, classes, ridersPerHeat, usePracticeSeeding, gateConfigId } = req.body;

  // --- Guard: skip classes that already have completed motos to preserve results ---
  const existingMotos = await db.select({
    id: motosTable.id,
    raceClass: motosTable.raceClass,
    status: motosTable.status,
    motoNumber: motosTable.motoNumber,
  }).from(motosTable).where(eq(motosTable.eventId, eventId));

  const lockedClasses = new Set(
    existingMotos
      .filter(m => m.status === "completed")
      .map(m => m.raceClass)
      .filter((c): c is string => c != null)
  );

  // Only generate for classes that have no completed motos
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

  // --- Practice seeding: load gate settings + best lap times ---
  let gateSeeding: number[] = [];
  let gateCountFromClub: number | null = null;
  let bestLapByRider: Map<number, number> = new Map(); // riderId → best lap ms

  if (usePracticeSeeding) {
    // Get the club for this event
    const [eventRow] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
    if (eventRow?.clubId) {
      const [club] = await db.select({ gateSeeding: clubsTable.gateSeeding })
        .from(clubsTable).where(eq(clubsTable.id, eventRow.clubId));

      // Support new multi-config format (GateConfig[]) or empty
      const gateConfigs = (club?.gateSeeding as any[] | null) ?? [];
      const selectedConfig = gateConfigId
        ? gateConfigs.find((c: any) => c.id === gateConfigId)
        : gateConfigs[0];

      if (selectedConfig?.gatePriorities) {
        gateSeeding = gateConfigToSeedingOrder(selectedConfig);
        gateCountFromClub = selectedConfig.gateCount ?? null;
      }

      // Get all practice sessions for this club
      const sessions = await db.select({ id: practiceSessionsTable.id })
        .from(practiceSessionsTable)
        .where(eq(practiceSessionsTable.clubId, eventRow.clubId));

      if (sessions.length > 0) {
        const sessionIds = sessions.map(s => s.id);
        // Best lap time per rider across all practice sessions for this club
        const bestLaps = await db.select({
          riderId: practiceCrossingsTable.riderId,
          bestLap: min(practiceCrossingsTable.lapTimeMs),
        })
          .from(practiceCrossingsTable)
          .where(and(
            inArray(practiceCrossingsTable.sessionId, sessionIds),
          ))
          .groupBy(practiceCrossingsTable.riderId);

        for (const row of bestLaps) {
          if (row.riderId != null && row.bestLap != null && row.bestLap > 0) {
            bestLapByRider.set(row.riderId, Number(row.bestLap));
          }
        }
      }
    }
  }

  // Effective max per heat: explicit input OR gate count (if practice seeding) OR unlimited
  const effectiveMax: number = ridersPerHeat && ridersPerHeat > 0
    ? ridersPerHeat
    : (usePracticeSeeding && gateCountFromClub ? gateCountFromClub : Infinity);

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

  // Helper: build a lineup entry, optionally assigning a gate from the seeding order
  type CheckinRow = typeof checkins[0];
  function buildLineup(groupRiders: CheckinRow[], seedingOrder: number[]): Array<Record<string, unknown>> {
    if (!usePracticeSeeding || seedingOrder.length === 0) {
      return groupRiders.map((r, i) => ({
        position: i + 1,
        riderId: r.riderId,
        riderName: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
        bibNumber: r.bibNumber,
        rfidNumber: r.rfidNumber,
      }));
    }
    // Sort riders within this group by best practice lap (fastest first, unranked last)
    const sorted = [...groupRiders].sort((a, b) => {
      const la = a.riderId != null ? (bestLapByRider.get(a.riderId) ?? Infinity) : Infinity;
      const lb = b.riderId != null ? (bestLapByRider.get(b.riderId) ?? Infinity) : Infinity;
      return la - lb;
    });
    return sorted.map((r, i) => ({
      position: i + 1,
      gate: seedingOrder[i] ?? null, // null if more riders than gate seeds defined
      riderId: r.riderId,
      riderName: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
      bibNumber: r.bibNumber,
      rfidNumber: r.rfidNumber,
    }));
  }

  // Pre-compute groups for every class before inserting any motos so we can
  // interleave them in round-robin order (all classes run Moto 1 before any run Moto 2).
  type ClassEntry = { cls: string; groups: CheckinRow[][] };
  const allClassGroups: ClassEntry[] = [];

  for (const cls of classesToGenerate) {
    let classRiders = checkins.filter(c => c.raceClass === cls);
    if (classRiders.length === 0) continue;

    // --- Serpentine seeding: sort by practice lap time, then snake-distribute into groups ---
    if (usePracticeSeeding) {
      classRiders = [...classRiders].sort((a, b) => {
        const la = a.riderId != null ? (bestLapByRider.get(a.riderId) ?? Infinity) : Infinity;
        const lb = b.riderId != null ? (bestLapByRider.get(b.riderId) ?? Infinity) : Infinity;
        return la - lb;
      });
    }

    const numGroups = effectiveMax === Infinity ? 1 : Math.ceil(classRiders.length / effectiveMax);
    const groups: CheckinRow[][] = Array.from({ length: numGroups }, () => []);

    if (usePracticeSeeding && numGroups > 1) {
      // Serpentine (snake) distribution: ensures balanced competition
      classRiders.forEach((rider, idx) => {
        const round = Math.floor(idx / numGroups);
        const posInRound = idx % numGroups;
        const groupIdx = round % 2 === 0 ? posInRound : numGroups - 1 - posInRound;
        groups[groupIdx].push(rider);
      });
    } else {
      // Default: sequential fill
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
