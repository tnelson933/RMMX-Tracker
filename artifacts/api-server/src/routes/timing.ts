import { Router } from "express";
import { db } from "@workspace/db";
import {
  lapCrossingsTable,
  motosTable,
  raceResultsTable,
  rfidAssignmentsTable,
  ridersTable,
  checkinsTable,
} from "@workspace/db";
import { eq, and, asc, isNotNull } from "drizzle-orm";
import type { Response } from "express";

const router = Router();

// ── SSE registry: motoId → connected Response objects ─────────────────────────
const sseClients = new Map<number, Set<Response>>();

function sseSubscribe(motoId: number, res: Response) {
  if (!sseClients.has(motoId)) sseClients.set(motoId, new Set());
  sseClients.get(motoId)!.add(res);
}

function sseUnsubscribe(motoId: number, res: Response) {
  sseClients.get(motoId)?.delete(res);
}

export function sseBroadcast(motoId: number, data: object) {
  const clients = sseClients.get(motoId);
  if (!clients?.size) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of [...clients]) {
    try {
      (client as any).write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

// ── Utility: format milliseconds → "M:SS.mm" ──────────────────────────────────
export function formatLapTime(ms: number): string {
  if (ms <= 0) return "0:00.00";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const centis = Math.floor((ms % 1000) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

// ── Utility: parse "M:SS.f" or "M:SS.ff" time string → ms ────────────────────
function parseTimeToMs(t: string): number {
  try {
    const [minPart, rest] = t.split(":");
    const [secPart, fracPart] = rest.split(".");
    const mins = parseInt(minPart, 10);
    const secs = parseInt(secPart, 10);
    // Pad fraction to 3 digits (tenths → ms, centiseconds → ms, etc.)
    const frac = fracPart ? parseInt(fracPart.padEnd(3, "0").slice(0, 3), 10) : 0;
    return (mins * 60 + secs) * 1000 + frac;
  } catch {
    return 0;
  }
}

// ── Normalize a lapTime entry to milliseconds (handles both legacy objects and numbers) ──
function normalizeLapMs(val: unknown): number {
  if (typeof val === "number") return val;
  if (val && typeof val === "object" && "time" in val) {
    return parseTimeToMs((val as { time: string }).time);
  }
  return 0;
}

// ── Leaderboard snapshot from current race_results ─────────────────────────────
export async function buildLeaderboard(motoId: number) {
  const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, motoId));
  if (!moto) return null;

  const results = await db
    .select({
      id: raceResultsTable.id,
      riderId: raceResultsTable.riderId,
      raceClass: raceResultsTable.raceClass,
      position: raceResultsTable.position,
      lapTimes: raceResultsTable.lapTimes,
      totalTime: raceResultsTable.totalTime,
      dnf: raceResultsTable.dnf,
      dns: raceResultsTable.dns,
      bibNumber: raceResultsTable.bibNumber,
      firstName: ridersTable.firstName,
      lastName: ridersTable.lastName,
    })
    .from(raceResultsTable)
    .leftJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
    .where(eq(raceResultsTable.motoId, motoId))
    .orderBy(asc(raceResultsTable.position));

  const leaderboard = results.map((r) => {
    const raw = Array.isArray(r.lapTimes) ? (r.lapTimes as unknown[]) : [];
    const lapMs = raw.map(normalizeLapMs);
    const totalMs = lapMs.reduce((s, t) => s + t, 0);
    const lastMs = lapMs.at(-1) ?? null;
    return {
      position: r.position,
      riderId: r.riderId,
      riderName: `${r.firstName} ${r.lastName}`,
      bibNumber: r.bibNumber,
      laps: lapMs.length,
      lapTimes: lapMs.map(formatLapTime),
      lastLapMs: lastMs,
      lastLap: lastMs != null ? formatLapTime(lastMs) : null,
      totalMs,
      totalTime: lapMs.length ? formatLapTime(totalMs) : null,
      dnf: r.dnf,
      dns: r.dns,
    };
  });

  // Compute gaps relative to leader
  const leader = leaderboard[0];
  const withGaps = leaderboard.map((entry) => {
    if (!leader || entry.position === 1) return { ...entry, gap: "Leader" };
    if (entry.laps < leader.laps)
      return { ...entry, gap: `+${leader.laps - entry.laps} lap${leader.laps - entry.laps > 1 ? "s" : ""}` };
    return {
      ...entry,
      gap: entry.totalMs > 0 && leader.totalMs > 0 ? `+${formatLapTime(entry.totalMs - leader.totalMs)}` : "—",
    };
  });

  return {
    motoId,
    motoName: moto.name,
    raceClass: moto.raceClass,
    status: moto.status,
    startedAt: moto.startedAt?.toISOString() ?? null,
    completedAt: moto.completedAt?.toISOString() ?? null,
    leaderboard: withGaps,
    updatedAt: new Date().toISOString(),
  };
}

// ── Core crossing processor ───────────────────────────────────────────────────
async function processCrossing(opts: {
  rfidNumber: string;
  motoId: number;
  crossingTime: Date;
  readerId?: string;
}) {
  const { rfidNumber, motoId, crossingTime, readerId } = opts;

  // 1. Load moto
  const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, motoId));
  if (!moto) throw new Error("Moto not found");
  if (moto.status !== "in_progress") throw new Error("Moto is not in progress");
  if (!moto.startedAt) throw new Error("Moto has no start time");

  // 2. Resolve rider from RFID assignment for this event
  const assignments = await db
    .select({ riderId: rfidAssignmentsTable.riderId })
    .from(rfidAssignmentsTable)
    .where(and(eq(rfidAssignmentsTable.rfidNumber, rfidNumber), eq(rfidAssignmentsTable.eventId, moto.eventId)));

  const riderId = assignments[0]?.riderId ?? null;

  // 3. Previous crossings for this rider+moto
  const prevCrossings = await db
    .select()
    .from(lapCrossingsTable)
    .where(and(eq(lapCrossingsTable.motoId, motoId), eq(lapCrossingsTable.rfidNumber, rfidNumber)))
    .orderBy(asc(lapCrossingsTable.crossingTime));

  const lapNumber = prevCrossings.length + 1;
  const prevTime =
    prevCrossings.length > 0
      ? prevCrossings[prevCrossings.length - 1].crossingTime
      : moto.startedAt;
  const lapTimeMs = crossingTime.getTime() - new Date(prevTime).getTime();

  // 4. Store crossing
  const [crossing] = await db
    .insert(lapCrossingsTable)
    .values({ eventId: moto.eventId, motoId, riderId, rfidNumber, crossingTime, lapNumber, lapTimeMs, readerId: readerId ?? null })
    .returning();

  // 5. Upsert race_results for this rider
  if (riderId) {
    // Get checkin to find raceClass + bibNumber
    const checkins = await db
      .select()
      .from(checkinsTable)
      .where(and(eq(checkinsTable.eventId, moto.eventId), eq(checkinsTable.riderId, riderId)));
    const checkin = checkins.find((c) => c.raceClass === moto.raceClass) ?? checkins[0];

    const existing = await db
      .select()
      .from(raceResultsTable)
      .where(and(eq(raceResultsTable.motoId, motoId), eq(raceResultsTable.riderId, riderId)));

    if (existing[0]) {
      const prevLaps = Array.isArray(existing[0].lapTimes) ? (existing[0].lapTimes as number[]) : [];
      const newLaps = [...prevLaps, lapTimeMs];
      const totalMs = newLaps.reduce((s, t) => s + t, 0);
      await db
        .update(raceResultsTable)
        .set({ lapTimes: newLaps, totalTime: formatLapTime(totalMs) })
        .where(eq(raceResultsTable.id, existing[0].id));
    } else {
      const totalMs = lapTimeMs;
      await db.insert(raceResultsTable).values({
        eventId: moto.eventId,
        motoId,
        riderId,
        raceClass: moto.raceClass,
        position: 999,
        lapTimes: [lapTimeMs],
        totalTime: formatLapTime(totalMs),
        bibNumber: checkin?.bibNumber ?? null,
        dnf: false,
        dns: false,
      });
    }

    // 6. Recalculate positions for all riders in moto
    const allResults = await db
      .select()
      .from(raceResultsTable)
      .where(eq(raceResultsTable.motoId, motoId));

    const sorted = allResults
      .map((r) => {
        const laps = Array.isArray(r.lapTimes) ? (r.lapTimes as number[]) : [];
        return { id: r.id, laps: laps.length, totalMs: laps.reduce((s, t) => s + t, 0) };
      })
      .sort((a, b) => b.laps - a.laps || a.totalMs - b.totalMs);

    for (let i = 0; i < sorted.length; i++) {
      await db
        .update(raceResultsTable)
        .set({ position: i + 1 })
        .where(eq(raceResultsTable.id, sorted[i].id));
    }
  }

  // 7. Build & broadcast leaderboard
  const snapshot = await buildLeaderboard(motoId);
  if (snapshot) sseBroadcast(motoId, snapshot);

  return { crossing, lapNumber, lapTimeMs };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /timing/crossing — called by hardware readers (or simulation)
router.post("/timing/crossing", async (req, res) => {
  const { rfidNumber, motoId, crossingTime, readerId } = req.body;
  if (!rfidNumber || !motoId) {
    return res.status(400).json({ error: "rfidNumber and motoId are required" });
  }

  const time = crossingTime ? new Date(crossingTime) : new Date();
  if (isNaN(time.getTime())) {
    return res.status(400).json({ error: "Invalid crossingTime" });
  }

  try {
    const result = await processCrossing({ rfidNumber, motoId: Number(motoId), crossingTime: time, readerId });
    return res.json({
      ok: true,
      crossingId: result.crossing.id,
      lapNumber: result.lapNumber,
      lapTime: formatLapTime(result.lapTimeMs),
      lapTimeMs: result.lapTimeMs,
    });
  } catch (err: any) {
    return res.status(409).json({ error: err.message });
  }
});

// GET /timing/live/:motoId — SSE stream for live leaderboard
router.get("/timing/live/:motoId", async (req, res) => {
  const motoId = Number(req.params.motoId);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  (res as any).flushHeaders?.();

  // Send initial state immediately
  const snapshot = await buildLeaderboard(motoId);
  if (snapshot) {
    (res as any).write(`data: ${JSON.stringify(snapshot)}\n\n`);
  } else {
    (res as any).write(`data: ${JSON.stringify({ error: "Moto not found" })}\n\n`);
  }

  sseSubscribe(motoId, res);

  // Heartbeat every 20s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    try {
      (res as any).write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseUnsubscribe(motoId, res);
  });
});

// GET /timing/crossings/:motoId — all raw crossings (debug / replay)
router.get("/timing/crossings/:motoId", async (req, res) => {
  const motoId = Number(req.params.motoId);
  const crossings = await db
    .select({
      id: lapCrossingsTable.id,
      rfidNumber: lapCrossingsTable.rfidNumber,
      riderId: lapCrossingsTable.riderId,
      crossingTime: lapCrossingsTable.crossingTime,
      lapNumber: lapCrossingsTable.lapNumber,
      lapTimeMs: lapCrossingsTable.lapTimeMs,
      readerId: lapCrossingsTable.readerId,
      firstName: ridersTable.firstName,
      lastName: ridersTable.lastName,
    })
    .from(lapCrossingsTable)
    .leftJoin(ridersTable, eq(lapCrossingsTable.riderId, ridersTable.id))
    .where(eq(lapCrossingsTable.motoId, motoId))
    .orderBy(asc(lapCrossingsTable.crossingTime));

  return res.json(
    crossings.map((c) => ({
      ...c,
      crossingTime: c.crossingTime.toISOString(),
      riderName: c.firstName ? `${c.firstName} ${c.lastName}` : null,
      lapTime: c.lapTimeMs ? formatLapTime(c.lapTimeMs) : null,
    }))
  );
});

// GET /timing/leaderboard/:motoId — snapshot (polling fallback)
router.get("/timing/leaderboard/:motoId", async (req, res) => {
  const snapshot = await buildLeaderboard(Number(req.params.motoId));
  if (!snapshot) return res.status(404).json({ error: "Moto not found" });
  return res.json(snapshot);
});

export default router;
