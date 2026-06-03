import { Router } from "express";
import { db } from "@workspace/db";
import {
  lapCrossingsTable,
  motosTable,
  raceResultsTable,
  rfidAssignmentsTable,
  ridersTable,
  checkinsTable,
  eventsTable,
  usersTable,
} from "@workspace/db";
import { eq, and, asc, isNotNull } from "drizzle-orm";
import type { Response } from "express";
import { textToSpeech } from "@workspace/integrations-openai-ai-server/audio";

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

// Minimum milliseconds between two valid crossings for the same tag in the same moto.
// A rider physically cannot complete a motocross/ATV lap in under 30 seconds.
// This prevents a single antenna burst (50+ reads in 0.2 s) from being recorded as 50 laps.
const DEBOUNCE_MS = 30_000;

// ── Core crossing processor ───────────────────────────────────────────────────
async function processCrossing(opts: {
  rfidNumber: string;
  motoId: number;
  crossingTime: Date;
  readerId?: string;
  antennaId?: number;
}) {
  const { rfidNumber, motoId, crossingTime, readerId, antennaId } = opts;

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

  // 3. Previous crossings for this tag+moto
  const prevCrossings = await db
    .select()
    .from(lapCrossingsTable)
    .where(and(eq(lapCrossingsTable.motoId, motoId), eq(lapCrossingsTable.rfidNumber, rfidNumber)))
    .orderBy(asc(lapCrossingsTable.crossingTime));

  // ── Debounce: reject burst reads from the same antenna pass ─────────────────
  // A real RFID gantry fires 50+ reads in 0.2 s for one physical crossing.
  // Use the hardware crossingTime (not server clock) to measure the gap so
  // clock skew on the scoring laptop never inflates or deflates the window.
  if (prevCrossings.length > 0) {
    const lastCrossing = prevCrossings[prevCrossings.length - 1];
    const gapMs = crossingTime.getTime() - new Date(lastCrossing.crossingTime).getTime();
    if (gapMs < DEBOUNCE_MS) {
      // Silent accept — not an error, just a duplicate burst read
      return { debounced: true, crossing: null, lapNumber: null, lapTimeMs: null };
    }
  }

  const lapNumber = prevCrossings.length + 1;
  const prevTime =
    prevCrossings.length > 0
      ? prevCrossings[prevCrossings.length - 1].crossingTime
      : moto.startedAt;
  const lapTimeMs = crossingTime.getTime() - new Date(prevTime).getTime();

  // 4. Store crossing
  const [crossing] = await db
    .insert(lapCrossingsTable)
    .values({ eventId: moto.eventId, motoId, riderId, rfidNumber, crossingTime, lapNumber, lapTimeMs, readerId: readerId ?? null, antennaId: antennaId ?? null })
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
  const { rfidNumber, motoId, crossingTime, readerId, antennaId } = req.body;
  if (!rfidNumber || !motoId) {
    return res.status(400).json({ error: "rfidNumber and motoId are required" });
  }

  const time = crossingTime ? new Date(crossingTime) : new Date();
  if (isNaN(time.getTime())) {
    return res.status(400).json({ error: "Invalid crossingTime" });
  }

  const antenna = antennaId !== undefined ? Number(antennaId) : undefined;

  try {
    const result = await processCrossing({ rfidNumber, motoId: Number(motoId), crossingTime: time, readerId, antennaId: antenna });
    if (result.debounced) {
      // Burst duplicate — acknowledge silently so the reader doesn't retry
      return res.json({ ok: true, debounced: true });
    }
    return res.json({
      ok: true,
      crossingId: result.crossing!.id,
      lapNumber: result.lapNumber,
      lapTime: formatLapTime(result.lapTimeMs!),
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

// DELETE /timing/crossings/:crossingId — remove a phantom/bad crossing and recalculate results
router.delete("/timing/crossings/:crossingId", async (req, res) => {
  // ── Auth: must be a logged-in organizer ──────────────────────────────────
  const session = req.session as any;
  if (!session?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const crossingId = Number(req.params.crossingId);
  if (!crossingId || isNaN(crossingId)) {
    return res.status(400).json({ error: "Invalid crossingId" });
  }

  // Load the crossing to delete
  const [crossing] = await db
    .select()
    .from(lapCrossingsTable)
    .where(eq(lapCrossingsTable.id, crossingId));

  if (!crossing) {
    return res.status(404).json({ error: "Crossing not found" });
  }

  const { motoId, rfidNumber, riderId } = crossing;

  // Load the moto (need startedAt for lap time recalculation)
  const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, motoId));
  if (!moto) return res.status(404).json({ error: "Moto not found" });

  // ── Ownership check: session user must belong to the same club as the event ──
  const [sessionUser] = await db
    .select({ clubId: usersTable.clubId, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, session.userId));

  if (!sessionUser) return res.status(401).json({ error: "Unauthorized" });

  if (sessionUser.role !== "super_admin") {
    const [event] = await db
      .select({ clubId: eventsTable.clubId })
      .from(eventsTable)
      .where(eq(eventsTable.id, moto.eventId));

    if (!event || event.clubId !== sessionUser.clubId) {
      return res.status(403).json({ error: "Forbidden: not your event" });
    }
  }

  // ── All mutations in a single transaction ────────────────────────────────
  const newLapTimes: number[] = [];

  await db.transaction(async (tx) => {
    // Delete the crossing
    await tx.delete(lapCrossingsTable).where(eq(lapCrossingsTable.id, crossingId));

    // Reload remaining crossings for this rfid+moto in time order
    const remaining = await tx
      .select()
      .from(lapCrossingsTable)
      .where(and(eq(lapCrossingsTable.motoId, motoId), eq(lapCrossingsTable.rfidNumber, rfidNumber)))
      .orderBy(asc(lapCrossingsTable.crossingTime));

    // Renumber crossings and recalculate lap times
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const prevTime = i === 0 ? moto.startedAt! : remaining[i - 1].crossingTime;
      const lapTimeMs = new Date(c.crossingTime).getTime() - new Date(prevTime).getTime();
      const lapNumber = i + 1;
      await tx
        .update(lapCrossingsTable)
        .set({ lapNumber, lapTimeMs })
        .where(eq(lapCrossingsTable.id, c.id));
      newLapTimes.push(lapTimeMs);
    }

    // Update race_results for this rider
    if (riderId) {
      const existingResults = await tx
        .select()
        .from(raceResultsTable)
        .where(and(eq(raceResultsTable.motoId, motoId), eq(raceResultsTable.riderId, riderId)));

      if (existingResults[0]) {
        if (newLapTimes.length === 0) {
          // No laps left — remove the result row entirely
          await tx.delete(raceResultsTable).where(eq(raceResultsTable.id, existingResults[0].id));
        } else {
          const totalMs = newLapTimes.reduce((s, t) => s + t, 0);
          await tx
            .update(raceResultsTable)
            .set({ lapTimes: newLapTimes, totalTime: formatLapTime(totalMs) })
            .where(eq(raceResultsTable.id, existingResults[0].id));
        }
      }

      // Recalculate positions for all riders in moto
      const allResults = await tx
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
        await tx
          .update(raceResultsTable)
          .set({ position: i + 1 })
          .where(eq(raceResultsTable.id, sorted[i].id));
      }
    }
  });

  // Broadcast updated leaderboard (outside transaction — read-only)
  const snapshot = await buildLeaderboard(motoId);
  if (snapshot) sseBroadcast(motoId, snapshot);

  return res.json({ ok: true });
});

// GET /timing/leaderboard/:motoId — snapshot (polling fallback)
router.get("/timing/leaderboard/:motoId", async (req, res) => {
  const snapshot = await buildLeaderboard(Number(req.params.motoId));
  if (!snapshot) return res.status(404).json({ error: "Moto not found" });
  return res.json(snapshot);
});

// ── Announcement script builder (pure code — no LLM needed) ───────────────────

interface Top5Entry {
  position: number;
  riderName: string;
  laps: number;
  lastLap: string | null;
  totalTime: string | null;
  gap: string;
  dnf?: boolean;
  dns?: boolean;
}

interface PositionChange {
  riderName: string;
  from: number;
  to: number;
}

function buildAnnouncementScript(opts: {
  lapCompleted: number;
  top5: Top5Entry[];
  positionChanges: PositionChange[];
  isComplete: boolean;
}): string {
  const { lapCompleted, top5, positionChanges, isComplete } = opts;

  const ORDINALS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  const CARDINALS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

  function lapWord(n: number): string {
    return n < CARDINALS.length ? CARDINALS[n] : String(n);
  }

  function posWord(n: number): string {
    return n <= 5 ? ORDINALS[n] : `${n}th`;
  }

  // Parse "M:SS.cc" gap string → natural English
  function gapToSpeech(gap: string): string | null {
    if (!gap || gap === "Leader" || gap === "—") return null;
    const lapMatch = gap.match(/^\+(\d+)\s+laps?/);
    if (lapMatch) {
      const n = parseInt(lapMatch[1]);
      return `${lapWord(n)} lap${n !== 1 ? "s" : ""} back`;
    }
    const timeMatch = gap.match(/^\+(\d+):(\d+)\.(\d+)/);
    if (!timeMatch) return null;
    const mins = parseInt(timeMatch[1]);
    const secs = parseInt(timeMatch[2]);
    const cents = parseInt(timeMatch[3]);
    if (mins === 0) {
      const tenths = Math.round(cents / 10);
      return tenths > 0 ? `${secs} point ${tenths} seconds back` : `${secs} seconds back`;
    }
    const tenths = Math.round(cents / 10);
    const secStr = tenths > 0 ? `${secs} point ${tenths} seconds` : `${secs} seconds`;
    return `${mins} minute${mins > 1 ? "s" : ""} and ${secStr} back`;
  }

  // Format total time "M:SS.cc" → natural speech
  function totalToSpeech(t: string | null): string | null {
    if (!t) return null;
    const m = t.match(/^(\d+):(\d+)\.(\d+)/);
    if (!m) return null;
    const mins = parseInt(m[1]);
    const secs = parseInt(m[2]);
    const cents = parseInt(m[3]);
    const tenths = Math.round(cents / 10);
    const secStr = tenths > 0 ? `${secs} point ${tenths}` : String(secs);
    if (mins === 0) return `${secStr} seconds`;
    return `${mins} minute${mins > 1 ? "s" : ""} and ${secStr} seconds`;
  }

  const parts: string[] = [];

  if (isComplete) {
    parts.push("Checkered flag!");
    const winner = top5[0];
    if (winner) {
      const timeStr = totalToSpeech(winner.totalTime);
      parts.push(
        `${winner.riderName} takes the win${timeStr ? ` in ${timeStr}` : ""}!`
      );
    }
    if (top5[1]) parts.push(`${top5[1].riderName} crosses in second.`);
    if (top5[2]) parts.push(`${top5[2].riderName} rounds out the podium.`);
    if (top5[3]) parts.push(`${top5[3].riderName} finishes fourth.`);
  } else {
    // Lead with position changes first — most dramatic
    for (const change of positionChanges) {
      if (change.to < change.from) {
        parts.push(`${change.riderName} makes a move — up to ${posWord(change.to)}!`);
      }
    }

    // Lap callout
    const lapStr = lapCompleted < CARDINALS.length ? CARDINALS[lapCompleted] : String(lapCompleted);
    parts.push(`Lap ${lapStr} is complete.`);

    // Leader
    const leader = top5[0];
    if (leader) {
      const timeStr = totalToSpeech(leader.totalTime);
      parts.push(
        `${leader.riderName} leads${timeStr ? `, ${timeStr} on the clock` : ""}.`
      );
    }

    // P2–P5
    for (let i = 1; i < Math.min(top5.length, 5); i++) {
      const r = top5[i];
      if (r.dnf || r.dns) continue;
      const gapStr = gapToSpeech(r.gap);
      if (gapStr) {
        parts.push(`${r.riderName} running ${posWord(r.position)}, ${gapStr}.`);
      } else {
        parts.push(`${r.riderName} in ${posWord(r.position)}.`);
      }
    }
  }

  return parts.join(" ");
}

// POST /timing/announce — generate AI voice announcement for current leaderboard
router.post("/timing/announce", async (req, res) => {
  try {
    const { lapCompleted, top5, positionChanges = [], isComplete = false } = req.body as {
      lapCompleted: number;
      top5: Top5Entry[];
      positionChanges: PositionChange[];
      isComplete: boolean;
    };

    if (!Array.isArray(top5) || top5.length === 0) {
      return res.status(400).json({ error: "top5 array is required" });
    }

    const script = buildAnnouncementScript({ lapCompleted, top5, positionChanges, isComplete });

    const audioBuffer = await textToSpeech(script, "onyx", "mp3");

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.send(audioBuffer);
  } catch (err: any) {
    req.log.error({ err }, "announce TTS error");
    return res.status(500).json({ error: "Failed to generate announcement" });
  }
});

export default router;
