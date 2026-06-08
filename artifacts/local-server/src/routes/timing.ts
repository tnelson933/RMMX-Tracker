import { Router } from "express";
import type { Response } from "express";
import { getDb, parseJsonArr, parseJson } from "../db";

const router = Router();

// ── Utility: format milliseconds → "M:SS.mm" ─────────────────────────────────
export function formatLapTime(ms: number): string {
  if (ms <= 0) return "0:00.00";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const centis = Math.floor((ms % 1000) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

// ── SSE registry: motoId → connected Response objects ────────────────────────
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

// ── Build leaderboard snapshot from SQLite ────────────────────────────────────
export function buildLeaderboard(motoId: number) {
  const db = getDb();

  const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(motoId) as any;
  if (!moto) return null;

  const results = db.prepare(`
    SELECT rr.*, r.first_name, r.last_name
    FROM race_results rr
    LEFT JOIN riders r ON rr.rider_id = r.id
    WHERE rr.moto_id = ?
    ORDER BY rr.position ASC NULLS LAST
  `).all(motoId) as any[];

  const leaderboard = results.map((r: any) => {
    const lapMs = parseJsonArr<number>(r.lap_times);
    const totalMs = lapMs.reduce((s, t) => s + t, 0);
    const lastMs = lapMs.length > 0 ? lapMs[lapMs.length - 1] : null;
    const bestMs = lapMs.length ? Math.min(...lapMs) : null;
    return {
      position: r.position ?? 999,
      riderId: r.rider_id,
      riderName: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "Unknown",
      bibNumber: r.bib_number ?? null,
      laps: lapMs.length,
      lapTimes: lapMs.map(formatLapTime),
      lastLapMs: lastMs,
      lastLap: lastMs != null ? formatLapTime(lastMs) : null,
      bestLapMs: bestMs,
      bestLap: bestMs != null ? formatLapTime(bestMs) : null,
      totalMs,
      totalTime: lapMs.length ? formatLapTime(totalMs) : null,
      dnf: r.dnf === 1,
      dns: r.dns === 1,
    };
  });

  const leader = leaderboard[0];
  const withGaps = leaderboard.map((entry) => {
    if (!leader || entry.position === 1) return { ...entry, gap: "Leader" };
    if (entry.laps < leader.laps)
      return { ...entry, gap: `+${leader.laps - entry.laps} lap${leader.laps - entry.laps > 1 ? "s" : ""}` };
    return {
      ...entry,
      gap:
        entry.totalMs > 0 && leader.totalMs > 0
          ? `+${formatLapTime(entry.totalMs - leader.totalMs)}`
          : "—",
    };
  });

  return {
    motoId,
    motoName: moto.name ?? "",
    raceClass: moto.race_class,
    status: moto.status,
    startedAt: moto.started_at ?? null,
    completedAt: moto.completed_at ?? null,
    leaderboard: withGaps,
    updatedAt: new Date().toISOString(),
  };
}

// ── Default minimum lap gap to prevent antenna burst duplication ───────────────
const DEBOUNCE_MS = 30_000;

// ── Core crossing processor (synchronous — SQLite is single-writer) ───────────
function processCrossing(opts: {
  rfidNumber: string;
  motoId: number;
  crossingTime: Date;
  readerId?: string;
  antennaId?: number;
  bypassDebounce?: boolean;
  overrideRiderId?: number | null;
}) {
  const db = getDb();
  const { rfidNumber, motoId, crossingTime, readerId, antennaId, bypassDebounce, overrideRiderId } = opts;

  type CrossingResult =
    | { debounced: true; crossing: null; lapNumber: null; lapTimeMs: null }
    | { debounced: false; crossing: { id: number }; lapNumber: number; lapTimeMs: number };

  const result = db.transaction((): CrossingResult => {
    const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(motoId) as any;
    if (!moto) throw new Error("Moto not found");
    if (moto.status !== "in_progress") throw new Error("Moto is not in progress");
    if (!moto.started_at) throw new Error("Moto has no start time");

    // Per-class debounce threshold
    const event = db.prepare("SELECT min_lap_times FROM events WHERE id = ?").get(moto.event_id) as any;
    const minLapTimes = parseJson<Record<string, number>>(event?.min_lap_times, {});
    const classMinMs = minLapTimes[moto.race_class ?? ""] ?? null;
    const debounceMs = classMinMs ?? DEBOUNCE_MS;

    // Resolve rider from RFID assignment (or use override for manual crossings)
    let riderId: number | null = overrideRiderId !== undefined ? overrideRiderId : null;
    if (riderId === null && overrideRiderId === undefined) {
      const assignment = db
        .prepare("SELECT rider_id FROM rfid_assignments WHERE rfid_number = ? AND event_id = ? LIMIT 1")
        .get(rfidNumber, moto.event_id) as any;
      riderId = assignment?.rider_id ?? null;
    }

    // Previous crossings for this tag+moto (ordered oldest → newest)
    const prevCrossings = db
      .prepare("SELECT * FROM lap_crossings WHERE moto_id = ? AND rfid_number = ? ORDER BY crossing_time ASC")
      .all(motoId, rfidNumber) as any[];

    // Debounce: reject burst antenna reads
    if (!bypassDebounce && prevCrossings.length > 0) {
      const lastCrossing = prevCrossings[prevCrossings.length - 1];
      const gapMs = crossingTime.getTime() - new Date(lastCrossing.crossing_time).getTime();
      if (gapMs < debounceMs) {
        return { debounced: true, crossing: null, lapNumber: null, lapTimeMs: null };
      }
    }

    const lapNumber = prevCrossings.length + 1;
    const prevTime =
      prevCrossings.length > 0
        ? new Date(prevCrossings[prevCrossings.length - 1].crossing_time)
        : new Date(moto.started_at);
    const lapTimeMs = crossingTime.getTime() - prevTime.getTime();

    // Store the crossing
    const ins = db.prepare(`
      INSERT INTO lap_crossings
        (event_id, moto_id, rider_id, rfid_number, crossing_time, lap_number, lap_time_ms, reader_id, antenna_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insResult = ins.run(
      moto.event_id, motoId, riderId, rfidNumber,
      crossingTime.toISOString(), lapNumber, lapTimeMs,
      readerId ?? null, antennaId ?? null
    );
    const crossing = { id: Number(insResult.lastInsertRowid) };

    // Upsert race_results for this rider
    if (riderId) {
      const checkin = (db
        .prepare("SELECT race_class, bib_number FROM checkins WHERE event_id = ? AND rider_id = ? AND race_class = ? LIMIT 1")
        .get(moto.event_id, riderId, moto.race_class) as any) ??
        (db
          .prepare("SELECT race_class, bib_number FROM checkins WHERE event_id = ? AND rider_id = ? LIMIT 1")
          .get(moto.event_id, riderId) as any);

      const existing = db
        .prepare("SELECT * FROM race_results WHERE moto_id = ? AND rider_id = ? LIMIT 1")
        .get(motoId, riderId) as any;

      if (existing) {
        const prevLaps = parseJsonArr<number>(existing.lap_times);
        const newLaps = [...prevLaps, lapTimeMs];
        const totalMs = newLaps.reduce((s, t) => s + t, 0);
        db.prepare("UPDATE race_results SET lap_times = ?, total_time = ? WHERE id = ?")
          .run(JSON.stringify(newLaps), formatLapTime(totalMs), existing.id);
      } else {
        db.prepare(`
          INSERT INTO race_results (event_id, moto_id, rider_id, race_class, position, bib_number, lap_times, total_time, dnf, dns)
          VALUES (?, ?, ?, ?, 999, ?, ?, ?, 0, 0)
        `).run(
          moto.event_id, motoId, riderId,
          moto.race_class,
          checkin?.bib_number ?? null,
          JSON.stringify([lapTimeMs]),
          formatLapTime(lapTimeMs)
        );
      }

      // Recalculate positions for all riders in this moto
      const allResults = db
        .prepare("SELECT id, lap_times FROM race_results WHERE moto_id = ?")
        .all(motoId) as any[];

      const sorted = allResults
        .map((r: any) => {
          const laps = parseJsonArr<number>(r.lap_times);
          return { id: r.id, laps: laps.length, totalMs: laps.reduce((s: number, t: number) => s + t, 0) };
        })
        .sort((a, b) => b.laps - a.laps || a.totalMs - b.totalMs);

      const updatePos = db.prepare("UPDATE race_results SET position = ? WHERE id = ?");
      for (let i = 0; i < sorted.length; i++) {
        updatePos.run(i + 1, sorted[i].id);
      }
    }

    return { debounced: false, crossing, lapNumber, lapTimeMs };
  })();

  return result;
}

// ── Helpers: find active moto ─────────────────────────────────────────────────
function getActiveMotoForEvent(eventId: number): any {
  return (
    getDb()
      .prepare("SELECT * FROM motos WHERE event_id = ? AND status = 'in_progress' LIMIT 1")
      .get(eventId) ?? null
  );
}

function getActiveMotoForAnyEvent(): any {
  return (
    getDb()
      .prepare("SELECT * FROM motos WHERE status = 'in_progress' LIMIT 1")
      .get() ?? null
  );
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /timing/crossing — direct motoId crossing (hardware or simulation)
router.post("/timing/crossing", (req, res) => {
  const { rfidNumber, motoId, crossingTime, readerId, antennaId } = req.body;
  if (!rfidNumber || !motoId) {
    return res.status(400).json({ error: "rfidNumber and motoId are required" });
  }
  const time = crossingTime ? new Date(crossingTime) : new Date();
  if (isNaN(time.getTime())) return res.status(400).json({ error: "Invalid crossingTime" });
  const antenna = antennaId !== undefined ? Number(antennaId) : undefined;
  try {
    const result = processCrossing({ rfidNumber, motoId: Number(motoId), crossingTime: time, readerId, antennaId: antenna });
    if (result.debounced) return res.json({ ok: true, debounced: true });
    const snapshot = buildLeaderboard(Number(motoId));
    if (snapshot) sseBroadcast(Number(motoId), snapshot);
    return res.json({ ok: true, crossingId: result.crossing!.id, lapNumber: result.lapNumber, lapTime: formatLapTime(result.lapTimeMs!), lapTimeMs: result.lapTimeMs });
  } catch (err: any) {
    return res.status(409).json({ error: err.message });
  }
});

// POST /timing/active/crossing?clubId=N — stable facility endpoint
// Accepts all hardware formats: Generic/RFID bridge, AMBrc/MyLaps, Impinj R700, Zebra FX7500
// In the local server, clubId is accepted for compatibility but ignored (only one club).
router.post("/timing/active/crossing", (req, res) => {
  const body = req.body as any;

  // Impinj R700 native IoT Connector format
  if (Array.isArray(body?.events)) {
    const tagEvents = (body.events as any[])
      .filter((e: any) => e?.type === "tagInventoryEvent" && e?.tagInventoryEvent?.epcHex)
      .map((e: any) => e.tagInventoryEvent as { epcHex: string; antennaPort?: number; firstSeenTime?: string });
    if (tagEvents.length === 0) return res.json({ ok: true, processed: 0, note: "No tagInventoryEvent entries" });
    const moto = getActiveMotoForAnyEvent();
    if (!moto) return res.status(409).json({ error: "No moto in progress", hint: "Start a moto from the Race Day tab first." });
    const results: unknown[] = [];
    for (const tag of tagEvents) {
      const rfidNumber = tag.epcHex.toUpperCase();
      const crossingTime = tag.firstSeenTime ? new Date(tag.firstSeenTime) : new Date();
      if (isNaN(crossingTime.getTime())) { results.push({ rfidNumber, error: "Invalid firstSeenTime" }); continue; }
      try {
        const r = processCrossing({ rfidNumber, motoId: moto.id, crossingTime, readerId: "impinj-r700", antennaId: tag.antennaPort });
        results.push(r.debounced ? { rfidNumber, debounced: true } : { rfidNumber, crossingId: r.crossing?.id, lapNumber: r.lapNumber, lapTimeMs: r.lapTimeMs });
      } catch (err: any) { results.push({ rfidNumber, error: err.message }); }
    }
    const snapshot = buildLeaderboard(moto.id);
    if (snapshot) sseBroadcast(moto.id, snapshot);
    return res.json({ ok: true, processed: tagEvents.length, motoId: moto.id, results });
  }

  // Zebra FX7500 format
  const zebraTags: any[] = Array.isArray(body?.data?.tags) ? body.data.tags : Array.isArray(body?.tags) ? body.tags : [];
  if (zebraTags.length > 0) {
    const moto = getActiveMotoForAnyEvent();
    if (!moto) return res.status(409).json({ error: "No moto in progress", hint: "Start a moto from the Race Day tab first." });
    const results: unknown[] = [];
    for (const tag of zebraTags) {
      const rfidNumber = ((tag.idHex || tag.epc) as string | undefined ?? "").toUpperCase();
      if (!rfidNumber) { results.push({ error: "Tag missing idHex/epc field" }); continue; }
      const crossingTime = tag.firstSeenTimestamp ? new Date(tag.firstSeenTimestamp) : new Date();
      try {
        const r = processCrossing({ rfidNumber, motoId: moto.id, crossingTime, readerId: "zebra-fx7500", antennaId: tag.antennaPort });
        results.push(r.debounced ? { rfidNumber, debounced: true } : { rfidNumber, crossingId: r.crossing?.id, lapNumber: r.lapNumber, lapTimeMs: r.lapTimeMs });
      } catch (err: any) { results.push({ rfidNumber, error: err.message }); }
    }
    const snapshot = buildLeaderboard(moto.id);
    if (snapshot) sseBroadcast(moto.id, snapshot);
    return res.json({ ok: true, processed: zebraTags.length, motoId: moto.id, results });
  }

  // Generic / AMBrc / MyLaps format
  const rfidNumber: string | undefined = body?.rfidNumber ?? body?.transponder ?? body?.transponderId ?? body?.id;
  if (!rfidNumber) {
    return res.status(400).json({ error: "Cannot extract tag/transponder ID — expected rfidNumber, transponder, transponderId, Impinj events[], or Zebra tags[]" });
  }
  const rawTime = body?.crossingTime ?? body?.passingTime ?? body?.timestamp ?? body?.passTime;
  const crossingTime = rawTime ? new Date(rawTime) : new Date();
  if (isNaN(crossingTime.getTime())) return res.status(400).json({ error: "Invalid crossing time — must be ISO 8601" });

  const moto = getActiveMotoForAnyEvent();
  if (!moto) return res.status(409).json({ error: "No moto in progress", hint: "Start a moto from the Race Day tab first." });
  const readerId: string = body?.loopId ?? body?.readerId ?? body?.readername ?? "rfid";

  try {
    const result = processCrossing({ rfidNumber: String(rfidNumber), motoId: moto.id, crossingTime, readerId });
    if (result.debounced) return res.json({ ok: true, debounced: true, motoId: moto.id });
    const snapshot = buildLeaderboard(moto.id);
    if (snapshot) sseBroadcast(moto.id, snapshot);
    return res.json({ ok: true, motoId: moto.id, crossingId: result.crossing?.id, lapNumber: result.lapNumber, lapTime: result.lapTimeMs != null ? formatLapTime(result.lapTimeMs) : null, lapTimeMs: result.lapTimeMs });
  } catch (err: any) {
    return res.status(409).json({ error: err.message });
  }
});

// POST /timing/mylaps-crossing?eventId=N — AMBrc / MyLaps native format
router.post("/timing/mylaps-crossing", (req, res) => {
  const eventId = Number(req.query.eventId);
  if (!eventId || isNaN(eventId)) return res.status(400).json({ error: "eventId query param is required" });
  const body = req.body as any;
  const transponder: string | undefined = body?.transponder ?? body?.rfidNumber ?? body?.transponderId ?? body?.id;
  if (!transponder) return res.status(400).json({ error: "Missing transponder field — expected 'transponder', 'rfidNumber', or 'transponderId'" });
  const rawTime = body?.passingTime ?? body?.crossingTime ?? body?.timestamp ?? body?.passTime;
  const crossingTime = rawTime ? new Date(rawTime) : new Date();
  if (isNaN(crossingTime.getTime())) return res.status(400).json({ error: "Invalid passingTime — must be ISO 8601" });
  const moto = getActiveMotoForEvent(eventId);
  if (!moto) return res.status(409).json({ error: "No moto currently in progress for this event" });
  const readerId: string = body?.loopId ?? body?.readerId ?? "mylaps";
  try {
    const result = processCrossing({ rfidNumber: String(transponder), motoId: moto.id, crossingTime, readerId });
    if (result.debounced) return res.json({ ok: true, debounced: true, motoId: moto.id });
    const snapshot = buildLeaderboard(moto.id);
    if (snapshot) sseBroadcast(moto.id, snapshot);
    return res.json({ ok: true, motoId: moto.id, crossingId: result.crossing?.id, lapNumber: result.lapNumber, lapTime: result.lapTimeMs != null ? formatLapTime(result.lapTimeMs) : null, lapTimeMs: result.lapTimeMs });
  } catch (err: any) {
    return res.status(409).json({ error: err.message });
  }
});

// POST /timing/impinj-crossing?eventId=N — Impinj R700 native IoT Connector format
router.post("/timing/impinj-crossing", (req, res) => {
  const eventId = Number(req.query.eventId);
  if (!eventId || isNaN(eventId)) return res.status(400).json({ error: "eventId query param is required" });
  const body = req.body as { events?: unknown[] };
  const tagEvents = (Array.isArray(body.events) ? body.events : [])
    .filter((e: any) => e?.type === "tagInventoryEvent" && e?.tagInventoryEvent?.epcHex)
    .map((e: any) => e.tagInventoryEvent as { epcHex: string; antennaPort?: number; firstSeenTime?: string });
  if (tagEvents.length === 0) return res.json({ ok: true, processed: 0, note: "No tagInventoryEvent entries" });
  const moto = getActiveMotoForEvent(eventId);
  if (!moto) return res.status(409).json({ error: "No moto currently in progress for this event" });
  const results: unknown[] = [];
  for (const tag of tagEvents) {
    const rfidNumber = tag.epcHex.toUpperCase();
    const crossingTime = tag.firstSeenTime ? new Date(tag.firstSeenTime) : new Date();
    if (isNaN(crossingTime.getTime())) { results.push({ rfidNumber, error: "Invalid firstSeenTime" }); continue; }
    try {
      const r = processCrossing({ rfidNumber, motoId: moto.id, crossingTime, readerId: "impinj-r700", antennaId: tag.antennaPort });
      results.push(r.debounced ? { rfidNumber, debounced: true } : { rfidNumber, crossingId: r.crossing?.id, lapNumber: r.lapNumber, lapTimeMs: r.lapTimeMs });
    } catch (err: any) { results.push({ rfidNumber, error: err.message }); }
  }
  const snapshot = buildLeaderboard(moto.id);
  if (snapshot) sseBroadcast(moto.id, snapshot);
  return res.json({ ok: true, processed: tagEvents.length, motoId: moto.id, results });
});

// POST /timing/zebra-crossing?eventId=N — Zebra FX7500 IoT Connector format
router.post("/timing/zebra-crossing", (req, res) => {
  const eventId = Number(req.query.eventId);
  if (!eventId || isNaN(eventId)) return res.status(400).json({ error: "eventId query param is required" });
  const body = req.body as any;
  const tags: any[] = Array.isArray(body?.data?.tags) ? body.data.tags : Array.isArray(body?.tags) ? body.tags : [];
  if (tags.length === 0) return res.json({ ok: true, processed: 0, note: "No tags in payload" });
  const moto = getActiveMotoForEvent(eventId);
  if (!moto) return res.status(409).json({ error: "No moto currently in progress for this event" });
  const results: unknown[] = [];
  for (const tag of tags) {
    const rfidNumber = ((tag.idHex || tag.epc) as string | undefined ?? "").toUpperCase();
    if (!rfidNumber) { results.push({ error: "Tag missing idHex/epc field" }); continue; }
    const crossingTime = tag.firstSeenTimestamp ? new Date(tag.firstSeenTimestamp) : new Date();
    try {
      const r = processCrossing({ rfidNumber, motoId: moto.id, crossingTime, readerId: "zebra-fx7500", antennaId: tag.antennaPort });
      results.push(r.debounced ? { rfidNumber, debounced: true } : { rfidNumber, crossingId: r.crossing?.id, lapNumber: r.lapNumber, lapTimeMs: r.lapTimeMs });
    } catch (err: any) { results.push({ rfidNumber, error: err.message }); }
  }
  const snapshot = buildLeaderboard(moto.id);
  if (snapshot) sseBroadcast(moto.id, snapshot);
  return res.json({ ok: true, processed: tags.length, motoId: moto.id, results });
});

// POST /timing/manual-crossing — record a lap by riderId (no RFID required)
router.post("/timing/manual-crossing", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const { riderId, motoId } = req.body;
  if (!riderId || !motoId) return res.status(400).json({ error: "riderId and motoId are required" });
  const db = getDb();
  const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(Number(motoId)) as any;
  if (!moto) return res.status(404).json({ error: `Moto ${motoId} not found` });
  const assignment = db
    .prepare("SELECT rfid_number FROM rfid_assignments WHERE rider_id = ? AND event_id = ? LIMIT 1")
    .get(Number(riderId), moto.event_id) as any;
  const rfidNumber = assignment?.rfid_number ?? `MANUAL-${riderId}`;
  try {
    const result = processCrossing({ rfidNumber, motoId: Number(motoId), crossingTime: new Date(), readerId: "MANUAL", bypassDebounce: true, overrideRiderId: Number(riderId) });
    const snapshot = buildLeaderboard(Number(motoId));
    if (snapshot) sseBroadcast(Number(motoId), snapshot);
    return res.json({ ok: true, crossingId: result.crossing?.id ?? null, lapNumber: result.lapNumber, lapTime: result.lapTimeMs != null ? formatLapTime(result.lapTimeMs) : null, lapTimeMs: result.lapTimeMs });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /timing/live/:motoId — SSE stream for live leaderboard
router.get("/timing/live/:motoId", (req, res) => {
  const motoId = Number(req.params.motoId);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  (res as any).flushHeaders?.();

  const snapshot = buildLeaderboard(motoId);
  if (snapshot) {
    (res as any).write(`data: ${JSON.stringify(snapshot)}\n\n`);
  } else {
    (res as any).write(`data: ${JSON.stringify({ error: "Moto not found" })}\n\n`);
  }

  sseSubscribe(motoId, res);

  const heartbeat = setInterval(() => {
    try { (res as any).write(": heartbeat\n\n"); }
    catch { clearInterval(heartbeat); }
  }, 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseUnsubscribe(motoId, res);
  });
});

// GET /timing/leaderboard/:motoId — polling fallback snapshot
router.get("/timing/leaderboard/:motoId", (req, res) => {
  const snapshot = buildLeaderboard(Number(req.params.motoId));
  if (!snapshot) return res.status(404).json({ error: "Moto not found" });
  return res.json(snapshot);
});

// GET /timing/crossings/:motoId — all raw crossings (debug / replay / delete UI)
router.get("/timing/crossings/:motoId", (req, res) => {
  const db = getDb();
  const motoId = Number(req.params.motoId);
  const crossings = db.prepare(`
    SELECT lc.*, r.first_name, r.last_name
    FROM lap_crossings lc
    LEFT JOIN riders r ON lc.rider_id = r.id
    WHERE lc.moto_id = ?
    ORDER BY lc.crossing_time ASC
  `).all(motoId) as any[];
  return res.json(crossings.map((c: any) => ({
    id: c.id,
    rfidNumber: c.rfid_number,
    riderId: c.rider_id,
    crossingTime: c.crossing_time,
    lapNumber: c.lap_number,
    lapTimeMs: c.lap_time_ms,
    readerId: c.reader_id,
    riderName: c.first_name ? `${c.first_name} ${c.last_name ?? ""}`.trim() : null,
    lapTime: c.lap_time_ms ? formatLapTime(c.lap_time_ms) : null,
  })));
});

// DELETE /timing/crossings/:crossingId — remove a phantom/bad crossing and recalculate
router.delete("/timing/crossings/:crossingId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const crossingId = Number(req.params.crossingId);
  if (!crossingId || isNaN(crossingId)) return res.status(400).json({ error: "Invalid crossingId" });

  const db = getDb();
  const crossing = db.prepare("SELECT * FROM lap_crossings WHERE id = ?").get(crossingId) as any;
  if (!crossing) return res.status(404).json({ error: "Crossing not found" });

  const { moto_id: motoId, rfid_number: rfidNumber, rider_id: riderId } = crossing;
  const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(motoId) as any;
  if (!moto) return res.status(404).json({ error: "Moto not found" });

  const newLapTimes: number[] = [];

  db.transaction(() => {
    db.prepare("DELETE FROM lap_crossings WHERE id = ?").run(crossingId);

    const remaining = db
      .prepare("SELECT * FROM lap_crossings WHERE moto_id = ? AND rfid_number = ? ORDER BY crossing_time ASC")
      .all(motoId, rfidNumber) as any[];

    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const prevTime = i === 0 ? new Date(moto.started_at!) : new Date(remaining[i - 1].crossing_time);
      const lapTimeMs = new Date(c.crossing_time).getTime() - prevTime.getTime();
      const lapNumber = i + 1;
      db.prepare("UPDATE lap_crossings SET lap_number = ?, lap_time_ms = ? WHERE id = ?").run(lapNumber, lapTimeMs, c.id);
      newLapTimes.push(lapTimeMs);
    }

    if (riderId) {
      const existing = db.prepare("SELECT * FROM race_results WHERE moto_id = ? AND rider_id = ? LIMIT 1").get(motoId, riderId) as any;
      if (existing) {
        if (newLapTimes.length === 0) {
          db.prepare("DELETE FROM race_results WHERE id = ?").run(existing.id);
        } else {
          const totalMs = newLapTimes.reduce((s, t) => s + t, 0);
          db.prepare("UPDATE race_results SET lap_times = ?, total_time = ? WHERE id = ?")
            .run(JSON.stringify(newLapTimes), formatLapTime(totalMs), existing.id);
        }
      }

      const allResults = db.prepare("SELECT id, lap_times FROM race_results WHERE moto_id = ?").all(motoId) as any[];
      const sorted = allResults
        .map((r: any) => {
          const laps = parseJsonArr<number>(r.lap_times);
          return { id: r.id, laps: laps.length, totalMs: laps.reduce((s: number, t: number) => s + t, 0) };
        })
        .sort((a, b) => b.laps - a.laps || a.totalMs - b.totalMs);
      const updatePos = db.prepare("UPDATE race_results SET position = ? WHERE id = ?");
      for (let i = 0; i < sorted.length; i++) updatePos.run(i + 1, sorted[i].id);
    }
  })();

  const snapshot = buildLeaderboard(motoId);
  if (snapshot) sseBroadcast(motoId, { ...snapshot, correction: true });

  return res.json({ ok: true });
});

export default router;
