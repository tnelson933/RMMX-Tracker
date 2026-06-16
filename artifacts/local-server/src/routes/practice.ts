import { Router } from "express";
import type { Response } from "express";
import { getDb } from "../db";

const router = Router();

const sseClients = new Map<number, Set<Response>>();

type PracticeSessionRow = {
  id: number;
  club_id: number;
  name: string;
  status: string;
  debounce_ms: number;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
};

type PracticeCrossingRow = {
  id: number;
  session_id: number;
  rfid_number: string;
  rider_id: number | null;
  rider_name: string | null;
  bib_number: string | null;
  crossing_time: string;
  lap_number: number;
  lap_time_ms: number | null;
  created_at: string;
};

function serializeSession(s: PracticeSessionRow) {
  return {
    id: s.id,
    clubId: s.club_id,
    name: s.name,
    status: s.status,
    debounceMs: s.debounce_ms,
    startedAt: s.started_at ?? null,
    endedAt: s.ended_at ?? null,
    createdAt: s.created_at,
  };
}

function buildLiveBoard(session: PracticeSessionRow, crossings: PracticeCrossingRow[]) {
  const byRfid = new Map<string, PracticeCrossingRow[]>();
  for (const c of crossings) {
    if (!byRfid.has(c.rfid_number)) byRfid.set(c.rfid_number, []);
    byRfid.get(c.rfid_number)!.push(c);
  }

  const riders: Array<{
    rfidNumber: string;
    riderId: number | null;
    riderName: string | null;
    bibNumber: string | null;
    lapCount: number;
    bestLapMs: number | null;
    lastLapMs: number | null;
    lastCrossingTime: string;
    laps: { lapNumber: number; lapTimeMs: number | null; crossingTime: string }[];
  }> = [];

  for (const [rfidNumber, riderCrossings] of byRfid) {
    const sorted = [...riderCrossings].sort(
      (a, b) => new Date(a.crossing_time).getTime() - new Date(b.crossing_time).getTime(),
    );
    const withLap = sorted.filter((c) => c.lap_time_ms !== null && c.lap_time_ms > 0);
    const bestLapMs = withLap.length > 0 ? Math.min(...withLap.map((c) => c.lap_time_ms!)) : null;
    const last = sorted[sorted.length - 1];

    riders.push({
      rfidNumber,
      riderId: last.rider_id,
      riderName: last.rider_name,
      bibNumber: last.bib_number,
      lapCount: sorted.length,
      bestLapMs,
      lastLapMs: last.lap_time_ms,
      lastCrossingTime: last.crossing_time,
      laps: sorted.map((c) => ({
        lapNumber: c.lap_number,
        lapTimeMs: c.lap_time_ms,
        crossingTime: c.crossing_time,
      })),
    });
  }

  riders.sort((a, b) => {
    if (a.bestLapMs == null && b.bestLapMs == null) return 0;
    if (a.bestLapMs == null) return 1;
    if (b.bestLapMs == null) return -1;
    return a.bestLapMs - b.bestLapMs;
  });

  return { session: serializeSession(session), riders };
}

function broadcast(sessionId: number, payload: object) {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const data = JSON.stringify(payload);
  for (const res of clients) {
    try {
      (res as any).write(`data: ${data}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

function getClubId(req: any): number | null {
  const userId = (req.session as any)?.userId;
  if (!userId) return null;
  const db = getDb();
  const user = db
    .prepare("SELECT club_id FROM users WHERE id = ?")
    .get(userId) as { club_id: number } | undefined;
  return user?.club_id ?? null;
}

function processCrossing(
  db: ReturnType<typeof getDb>,
  session: PracticeSessionRow,
  rfidNumber: string,
  crossingTime: Date,
): { id: number } | null {
  const lastCrossing = db
    .prepare(
      "SELECT * FROM practice_crossings WHERE session_id = ? AND rfid_number = ? ORDER BY crossing_time DESC LIMIT 1",
    )
    .get(session.id, rfidNumber) as PracticeCrossingRow | undefined;

  if (lastCrossing) {
    const elapsed = crossingTime.getTime() - new Date(lastCrossing.crossing_time).getTime();
    if (elapsed < session.debounce_ms) return null;
  }

  const assignment = db
    .prepare(
      `SELECT ra.rider_id, r.first_name, r.last_name, r.bib_number
       FROM rfid_assignments ra
       LEFT JOIN riders r ON ra.rider_id = r.id
       LEFT JOIN events e ON ra.event_id = e.id
       WHERE ra.rfid_number = ? AND e.club_id = ?
       LIMIT 1`,
    )
    .get(rfidNumber, session.club_id) as
    | { rider_id: number; first_name: string; last_name: string; bib_number: string | null }
    | undefined;

  let riderId: number | null = null;
  let riderName: string | null = null;
  let bibNumber: string | null = null;

  if (assignment) {
    riderId = assignment.rider_id;
    riderName =
      [assignment.first_name, assignment.last_name].filter(Boolean).join(" ") || null;
    bibNumber = assignment.bib_number;
  } else {
    const directRider = db
      .prepare("SELECT id, first_name, last_name, bib_number FROM riders WHERE rfid_number = ? LIMIT 1")
      .get(rfidNumber) as
      | { id: number; first_name: string; last_name: string; bib_number: string | null }
      | undefined;
    if (directRider) {
      riderId = directRider.id;
      riderName =
        [directRider.first_name, directRider.last_name].filter(Boolean).join(" ") || null;
      bibNumber = directRider.bib_number;
    }
  }

  const lapNumber = (lastCrossing?.lap_number ?? 0) + 1;
  const lapTimeMs = lastCrossing
    ? crossingTime.getTime() - new Date(lastCrossing.crossing_time).getTime()
    : null;

  const ins = db
    .prepare(
      `INSERT INTO practice_crossings
         (session_id, rfid_number, rider_id, rider_name, bib_number, crossing_time, lap_number, lap_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      session.id,
      rfidNumber,
      riderId,
      riderName,
      bibNumber,
      crossingTime.toISOString(),
      lapNumber,
      lapTimeMs,
    );

  return { id: Number(ins.lastInsertRowid) };
}

// POST /practice/active/crossing — from RFID bridge / MyLaps, no session ID needed
router.post("/practice/active/crossing", (req, res) => {
  const clubId = Number(req.query.clubId);
  if (!clubId || isNaN(clubId)) {
    return res.status(400).json({ error: "clubId query param is required" });
  }

  const body = req.body as any;
  const rfidNumber: string | undefined =
    body?.rfidNumber ?? body?.transponder ?? body?.transponderId ?? body?.id;
  if (!rfidNumber) {
    return res.status(400).json({ error: "rfidNumber (or transponder) is required" });
  }

  const rawTime: string | undefined =
    body?.crossingTime ?? body?.passingTime ?? body?.timestamp;
  const crossingTime = rawTime ? new Date(rawTime) : new Date();
  if (isNaN(crossingTime.getTime())) {
    return res.status(400).json({ error: "Invalid crossingTime" });
  }

  const db = getDb();
  const session = db
    .prepare(
      "SELECT * FROM practice_sessions WHERE club_id = ? AND status = 'active' LIMIT 1",
    )
    .get(clubId) as PracticeSessionRow | undefined;

  if (!session) {
    return res.status(409).json({
      error: "No active practice session for this club",
      hint: "Start a practice session in the organizer portal first.",
    });
  }

  const result = processCrossing(db, session, String(rfidNumber), crossingTime);
  if (!result) return res.status(200).json({ skipped: true, reason: "debounce" });

  const crossings = db
    .prepare(
      "SELECT * FROM practice_crossings WHERE session_id = ? ORDER BY crossing_time ASC",
    )
    .all(session.id) as PracticeCrossingRow[];
  broadcast(session.id, buildLiveBoard(session, crossings));

  return res.status(201).json({ id: result.id });
});

// GET /practice
router.get("/practice", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const clubId = getClubId(req);
  if (!clubId) return res.status(403).json({ error: "No club" });

  const db = getDb();
  const sessions = db
    .prepare(
      "SELECT * FROM practice_sessions WHERE club_id = ? ORDER BY created_at DESC",
    )
    .all(clubId) as PracticeSessionRow[];
  return res.json(sessions.map(serializeSession));
});

// GET /practice/:id
router.get("/practice/:id", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const session = db
    .prepare("SELECT * FROM practice_sessions WHERE id = ?")
    .get(Number(req.params.id)) as PracticeSessionRow | undefined;
  if (!session) return res.status(404).json({ error: "Not found" });
  return res.json(serializeSession(session));
});

// POST /practice
router.post("/practice", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const clubId = getClubId(req);
  if (!clubId) return res.status(403).json({ error: "No club" });

  const { name, debounceMs } = req.body as { name?: string; debounceMs?: number };
  if (!name) return res.status(400).json({ error: "name required" });

  const db = getDb();
  const ins = db
    .prepare(
      "INSERT INTO practice_sessions (club_id, name, debounce_ms) VALUES (?, ?, ?)",
    )
    .run(clubId, name, debounceMs ? Number(debounceMs) : 10000);

  const session = db
    .prepare("SELECT * FROM practice_sessions WHERE id = ?")
    .get(ins.lastInsertRowid) as PracticeSessionRow;
  return res.status(201).json(serializeSession(session));
});

// PATCH /practice/:id — start / end / rename / debounce
router.patch("/practice/:id", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const clubId = getClubId(req);
  const id = Number(req.params.id);
  const db = getDb();

  const existing = db
    .prepare("SELECT * FROM practice_sessions WHERE id = ?")
    .get(id) as PracticeSessionRow | undefined;
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (existing.club_id !== clubId) return res.status(403).json({ error: "Forbidden" });

  const sets: string[] = [];
  const vals: unknown[] = [];

  if (req.body.name !== undefined) {
    sets.push("name = ?");
    vals.push(req.body.name);
  }
  if (req.body.debounceMs !== undefined) {
    sets.push("debounce_ms = ?");
    vals.push(Number(req.body.debounceMs));
  }
  if (req.body.status !== undefined) {
    sets.push("status = ?");
    vals.push(req.body.status);
    if (req.body.status === "active" && !existing.started_at) {
      sets.push("started_at = ?");
      vals.push(new Date().toISOString());
    }
    if (req.body.status === "ended") {
      sets.push("ended_at = ?");
      vals.push(new Date().toISOString());
    }
  }

  if (sets.length > 0) {
    vals.push(id);
    db.prepare(`UPDATE practice_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  const session = db
    .prepare("SELECT * FROM practice_sessions WHERE id = ?")
    .get(id) as PracticeSessionRow;
  const crossings = db
    .prepare(
      "SELECT * FROM practice_crossings WHERE session_id = ? ORDER BY crossing_time ASC",
    )
    .all(id) as PracticeCrossingRow[];
  broadcast(id, buildLiveBoard(session, crossings));

  return res.json(serializeSession(session));
});

// DELETE /practice/:id
router.delete("/practice/:id", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const clubId = getClubId(req);
  const id = Number(req.params.id);
  const db = getDb();

  const existing = db
    .prepare("SELECT * FROM practice_sessions WHERE id = ?")
    .get(id) as PracticeSessionRow | undefined;
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (existing.club_id !== clubId) return res.status(403).json({ error: "Forbidden" });

  db.prepare("DELETE FROM practice_crossings WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM practice_sessions WHERE id = ?").run(id);
  return res.status(204).send();
});

// GET /practice/:id/crossings
router.get("/practice/:id/crossings", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const id = Number(req.params.id);
  const db = getDb();
  const crossings = db
    .prepare(
      "SELECT * FROM practice_crossings WHERE session_id = ? ORDER BY crossing_time ASC",
    )
    .all(id) as PracticeCrossingRow[];
  return res.json(
    crossings.map((c) => ({
      id: c.id,
      sessionId: c.session_id,
      rfidNumber: c.rfid_number,
      riderId: c.rider_id,
      riderName: c.rider_name,
      bibNumber: c.bib_number,
      crossingTime: c.crossing_time,
      lapNumber: c.lap_number,
      lapTimeMs: c.lap_time_ms,
      createdAt: c.created_at,
    })),
  );
});

// POST /practice/:id/crossing — crossing by explicit session ID
router.post("/practice/:id/crossing", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const sessionId = Number(req.params.id);
  const db = getDb();

  const session = db
    .prepare("SELECT * FROM practice_sessions WHERE id = ?")
    .get(sessionId) as PracticeSessionRow | undefined;
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "active") {
    return res.status(409).json({ error: "Session not active" });
  }

  const body = req.body as any;
  const rfidNumber: string | undefined =
    body?.rfidNumber ?? body?.transponder ?? body?.transponderId;
  if (!rfidNumber) return res.status(400).json({ error: "rfidNumber required" });

  const rawTime: string | undefined =
    body?.crossingTime ?? body?.passingTime ?? body?.timestamp;
  const crossingTime = rawTime ? new Date(rawTime) : new Date();

  const result = processCrossing(db, session, String(rfidNumber), crossingTime);
  if (!result) return res.status(200).json({ skipped: true, reason: "debounce" });

  const crossings = db
    .prepare(
      "SELECT * FROM practice_crossings WHERE session_id = ? ORDER BY crossing_time ASC",
    )
    .all(session.id) as PracticeCrossingRow[];
  broadcast(session.id, buildLiveBoard(session, crossings));

  return res.status(201).json({ id: result.id });
});

// GET /practice/:id/live — SSE live board
router.get("/practice/:id/live", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = Number(req.params.id);
  const db = getDb();
  const session = db
    .prepare("SELECT * FROM practice_sessions WHERE id = ?")
    .get(id) as PracticeSessionRow | undefined;
  if (!session) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  (res as any).flushHeaders();

  if (!sseClients.has(id)) sseClients.set(id, new Set());
  sseClients.get(id)!.add(res);

  const crossings = db
    .prepare(
      "SELECT * FROM practice_crossings WHERE session_id = ? ORDER BY crossing_time ASC",
    )
    .all(id) as PracticeCrossingRow[];
  (res as any).write(`data: ${JSON.stringify(buildLiveBoard(session, crossings))}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      (res as any).write(": heartbeat\n\n");
    } catch {
      /* ignore */
    }
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.get(id)?.delete(res);
    if (sseClients.get(id)?.size === 0) sseClients.delete(id);
  });
});

export default router;
