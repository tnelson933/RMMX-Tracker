import { Router } from "express";
import { db } from "@workspace/db";
import { motosTable, checkinsTable, ridersTable, eventsTable, raceResultsTable, pointsTablesTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
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
  const motos = await db.select().from(motosTable).where(eq(motosTable.eventId, eventId)).orderBy(motosTable.motoNumber);
  return res.json(motos.map(m => ({
    ...m,
    lineup: Array.isArray(m.lineup) ? m.lineup : [],
    createdAt: m.createdAt.toISOString(),
  })));
});

router.post("/events/:eventId/motos", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { name, type, raceClass, motoNumber, scheduledTime, lineup } = req.body;
  if (!name || !type || !raceClass || motoNumber === undefined) return res.status(400).json({ error: "name, type, raceClass, motoNumber required" });

  const [moto] = await db.insert(motosTable).values({
    eventId, name, type, raceClass, motoNumber, scheduledTime, lineup: lineup || [], status: "scheduled",
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

  const [moto] = await db.update(motosTable).set(updates as any).where(eq(motosTable.id, id)).returning();
  if (!moto) return res.status(404).json({ error: "Not found" });

  if (req.body.status !== undefined) {
    buildLeaderboard(id).then(snapshot => {
      if (snapshot) sseBroadcast(id, snapshot);
    }).catch(() => {});
  }

  // Auto-advance to main when a heat completes (Supercross format only)
  if (req.body.status === "completed" && moto.type === "heat") {
    getEventFormat(moto.eventId).then(async ({ isSupercross, topPerHeat }) => {
      if (isSupercross) {
        await autoAdvanceToMain(moto.eventId, moto.raceClass, topPerHeat);
      }
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

router.post("/events/:eventId/generate-lineups", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { raceFormat, classes, ridersPerHeat } = req.body;
  const maxPerHeat: number = ridersPerHeat && ridersPerHeat > 0 ? ridersPerHeat : Infinity;

  // Determine if this is a Supercross-style event (main event only, heats feed into main)
  const { isSupercross: isSupercrossFormat } = await getEventFormat(eventId);

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
  let motoNumber = 1;

  const divCount = raceFormat === "three_moto" ? 3 : raceFormat === "two_moto" ? 2 : 1;

  for (const cls of (classes || [])) {
    const classRiders = checkins.filter(c => c.raceClass === cls);
    if (classRiders.length === 0) continue;

    // Distribute riders as evenly as possible across groups
    const groups: typeof classRiders[] = [];
    const numGroups = maxPerHeat === Infinity ? 1 : Math.ceil(classRiders.length / maxPerHeat);
    const baseSize = Math.floor(classRiders.length / numGroups);
    const extras = classRiders.length % numGroups; // first `extras` groups get baseSize+1
    let offset = 0;
    for (let g = 0; g < numGroups; g++) {
      const size = baseSize + (g < extras ? 1 : 0);
      groups.push(classRiders.slice(offset, offset + size));
      offset += size;
    }
    const multiGroup = groups.length > 1;

    if (isSupercrossFormat) {
      // Supercross: one Heat per group → riders qualify for Main Event
      for (let h = 0; h < groups.length; h++) {
        const heatRiders = groups[h];
        const lineup = heatRiders.map((r, i) => ({
          position: i + 1,
          riderId: r.riderId,
          riderName: `${r.firstName} ${r.lastName}`,
          bibNumber: r.bibNumber,
          rfidNumber: r.rfidNumber,
        }));

        const heatName = multiGroup ? `${cls} Heat ${h + 1}` : `${cls} Heat`;
        const [moto] = await db.insert(motosTable).values({
          eventId,
          name: heatName,
          type: "heat",
          raceClass: cls,
          motoNumber: motoNumber++,
          status: "scheduled",
          lineup,
        }).returning();
        motos.push(moto);
      }

      // Create empty Main Event moto — populated via advance-to-main (manual or auto on heat completion)
      const [mainMoto] = await db.insert(motosTable).values({
        eventId,
        name: `${cls} Main Event`,
        type: "main",
        raceClass: cls,
        motoNumber: motoNumber++,
        status: "scheduled",
        lineup: [],
      }).returning();
      motos.push(mainMoto);
    } else {
      // AMA / Olympic: Divisions — each rider runs the same division(s)
      for (let h = 0; h < groups.length; h++) {
        const groupRiders = groups[h];
        const groupLabel = multiGroup ? ` Group ${h + 1}` : "";

        for (let d = 1; d <= divCount; d++) {
          const lineup = groupRiders.map((r, i) => ({
            position: i + 1,
            riderId: r.riderId,
            riderName: `${r.firstName} ${r.lastName}`,
            bibNumber: r.bibNumber,
            rfidNumber: r.rfidNumber,
          }));

          const divLabel = divCount > 1 ? ` Division ${d}` : " Division";
          const name = `${cls}${groupLabel}${divLabel}`;

          const [moto] = await db.insert(motosTable).values({
            eventId,
            name,
            type: "heat",
            raceClass: cls,
            motoNumber: motoNumber++,
            status: "scheduled",
            lineup,
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
