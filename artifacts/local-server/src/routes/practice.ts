import { Router } from "express";
import type { Response } from "express";
import { getDb } from "../db";
import { rejectForeignBrowserIngest } from "../lib/request-origin";
import { listPracticeSplits, practiceCourseOf, practiceSectors } from "../lib/sectors";
import { riderIdForTransponder } from "../lib/rider-transponders";

const router = Router();

const sseClients = new Map<number, Set<Response>>();

type PracticeSessionRow = {
  id: number;
  club_id: number;
  name: string;
  status: string;
  debounce_ms: number;
  venue_name: string | null;
  /** The track's course when the session started (JSON): its split readers give sector times. */
  course?: string | null;
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

// Older rows stored started_at with SQLite datetime('now') ("YYYY-MM-DD HH:MM:SS",
// UTC with no zone marker), which browsers parse as local time. Return those as
// ISO UTC like every other local timestamp.
function toIsoUtc(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
}

/** The pass just saved, as the website returns it. */
function savedPassJson(crossings: PracticeCrossingRow[], id: number) {
  const saved = crossings.find((c) => c.id === id);
  if (!saved) return { id };
  return {
    id: saved.id,
    sessionId: saved.session_id,
    rfidNumber: saved.rfid_number,
    riderId: saved.rider_id ?? null,
    riderName: saved.rider_name ?? null,
    bibNumber: saved.bib_number ?? null,
    crossingTime: saved.crossing_time,
    lapNumber: saved.lap_number,
    lapTimeMs: saved.lap_time_ms ?? null,
    createdAt: toIsoUtc(saved.created_at),
  };
}

function serializeSession(s: PracticeSessionRow) {
  return {
    id: s.id,
    clubId: s.club_id,
    name: s.name,
    status: s.status,
    debounceMs: s.debounce_ms,
    venueName: s.venue_name ?? null,
    trackId: (s as { track_id?: number | null }).track_id ?? null,
    course: practiceCourseOf(s),
    startedAt: toIsoUtc(s.started_at),
    endedAt: s.ended_at ?? null,
    createdAt: toIsoUtc(s.created_at),
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
    /** Sector times per timed lap, when the practice's track has split readers. */
    sectorLaps?: Array<{ lapNumber: number; sectorsMs: Array<number | null>; complete: boolean }>;
    bestSectors?: Array<number | null>;
  }> = [];

  for (const [rfidNumber, riderCrossings] of byRfid) {
    const sorted = [...riderCrossings].sort(
      (a, b) => new Date(a.crossing_time).getTime() - new Date(b.crossing_time).getTime(),
    );
    const withLap = sorted.filter(
      (c) => c.lap_number >= 1 && c.lap_time_ms !== null && c.lap_time_ms > 0,
    );
    const bestLapMs = withLap.length > 0 ? Math.min(...withLap.map((c) => c.lap_time_ms!)) : null;
    const last = sorted[sorted.length - 1];

    riders.push({
      rfidNumber,
      riderId: last.rider_id,
      riderName: last.rider_name,
      bibNumber: last.bib_number,
      // The first pass only starts the clock: count timed laps.
      lapCount: withLap.length,
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

  // Sector times, when the track's course has splits (as the cloud's board).
  const course = practiceCourseOf(session);
  const sectors = practiceSectors(
    course,
    crossings.map((c) => ({ rfidNumber: c.rfid_number, crossingTime: new Date(c.crossing_time) })),
    course?.splits.length ? listPracticeSplits(session.id) : [],
  );
  if (sectors) {
    for (const row of riders) {
      const mine = sectors.byTag.get(row.rfidNumber.toLowerCase());
      if (mine) { row.sectorLaps = mine.laps; row.bestSectors = mine.best; }
    }
  }

  return { session: serializeSession(session), riders, sectorNames: sectors?.names ?? [] };
}

function broadcast(sessionId: number, payload: object) {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const data = JSON.stringify(payload);
  for (const res of clients) {
    try {
      (res as any).write(`data: ${data}\n\n`);
      (res as any).flush?.();
    } catch {
      clients.delete(res);
    }
  }
}

/** Push the current board to everyone watching the session. */
export function broadcastPracticeBoard(sessionId: number): void {
  if (!sseClients.get(sessionId)?.size) return;
  const db = getDb();
  const session = db.prepare("SELECT * FROM practice_sessions WHERE id = ?").get(sessionId) as PracticeSessionRow | undefined;
  if (!session) return;
  const crossings = db
    .prepare("SELECT * FROM practice_crossings WHERE session_id = ? ORDER BY crossing_time ASC")
    .all(sessionId) as PracticeCrossingRow[];
  broadcast(sessionId, buildLiveBoard(session, crossings));
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

/** Same window as the cloud (api-server lib/liveSession.ts). */
export const LIVE_WINDOW_MS = 12 * 60 * 60_000;

/**
 * The rider a practice tag belongs to, matched like the cloud: the club's
 * newest RFID assignment, then a registration's active transponder, then the
 * rider profile (sticker or active transponder). Tags are compared without case.
 */
export function resolvePracticeRider(
  db: ReturnType<typeof getDb>,
  clubId: number,
  tag: string,
): { riderId: number; riderName: string | null; bibNumber: string | null } | null {
  const name = (r: { first_name?: string | null; last_name?: string | null }) =>
    [r.first_name, r.last_name].filter(Boolean).join(" ") || null;
  const assignment = db
    .prepare(
      `SELECT ra.rider_id, r.first_name, r.last_name, r.bib_number
       FROM rfid_assignments ra
       LEFT JOIN riders r ON ra.rider_id = r.id
       LEFT JOIN events e ON ra.event_id = e.id
       WHERE ra.rfid_number = ? COLLATE NOCASE AND e.club_id = ? AND ra.rider_id IS NOT NULL
         AND (ra.expires_at IS NULL OR ra.expires_at > ?)
       ORDER BY ra.id DESC
       LIMIT 1`,
    )
    .get(tag, clubId, new Date().toISOString()) as any;
  if (assignment) return { riderId: assignment.rider_id, riderName: name(assignment), bibNumber: assignment.bib_number ?? null };

  const registration = db
    .prepare(
      `SELECT reg.rider_id, r.first_name, r.last_name, reg.bib_number, r.bib_number AS rider_bib
       FROM registrations reg
       LEFT JOIN riders r ON reg.rider_id = r.id
       JOIN events e ON reg.event_id = e.id
       WHERE e.club_id = ? AND reg.mylaps_transponder_number = ? COLLATE NOCASE AND reg.rider_id IS NOT NULL
         AND COALESCE(reg.transponder_rental, 0) = 0
       ORDER BY reg.id ASC
       LIMIT 1`,
    )
    .get(clubId, tag) as any;
  if (registration) return { riderId: registration.rider_id, riderName: name(registration), bibNumber: registration.bib_number ?? registration.rider_bib ?? null };

  // Any transponder the rider owns (several RM TrackRs, one per bike), then the old single fields.
  const ownerId = riderIdForTransponder(db, tag);
  const direct = ownerId == null ? undefined : db
    .prepare("SELECT id, first_name, last_name, bib_number FROM riders WHERE id = ?")
    .get(ownerId) as any;
  if (direct) return { riderId: direct.id, riderName: name(direct), bibNumber: direct.bib_number ?? null };
  return null;
}

function processCrossing(
  db: ReturnType<typeof getDb>,
  session: PracticeSessionRow,
  rfidNumber: string,
  crossingTime: Date,
): { id: number } | { skipped: "debounce" } {
  const lastCrossing = db
    .prepare(
      "SELECT * FROM practice_crossings WHERE session_id = ? AND rfid_number = ? ORDER BY crossing_time DESC LIMIT 1",
    )
    .get(session.id, rfidNumber) as PracticeCrossingRow | undefined;

  if (lastCrossing) {
    const elapsed = crossingTime.getTime() - new Date(lastCrossing.crossing_time).getTime();
    if (elapsed < session.debounce_ms) return { skipped: "debounce" };
  }

  // A transponder nobody is assigned to yet still records its laps (rider
  // empty); claimUnassignedPracticeReads gives them to the rider once assigned.
  const rider = resolvePracticeRider(db, session.club_id, rfidNumber);
  const riderId = rider?.riderId ?? null, riderName = rider?.riderName ?? null, bibNumber = rider?.bibNumber ?? null;

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

  claimUnassignedPracticeReads(db, session.id);
  return { id: Number(ins.lastInsertRowid) };
}

/** How far back a newly assigned transponder claims its unassigned practice laps. */
export const PRACTICE_CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Gives practice laps recorded with no rider to the rider their transponder is
 * assigned to now (same rule as the website). Only sessions started within the
 * last 24 h, so a rental or reused transponder never hands old laps to its new
 * holder. Runs on every practice read and once a minute, which covers every way
 * a transponder gets assigned. Returns how many laps were claimed.
 */
export function claimUnassignedPracticeReads(db: ReturnType<typeof getDb>, sessionId?: number): number {
  const since = new Date(Date.now() - PRACTICE_CLAIM_WINDOW_MS).toISOString();
  const rows = db.prepare(
    `SELECT DISTINCT pc.session_id, ps.club_id, pc.rfid_number
     FROM practice_crossings pc JOIN practice_sessions ps ON ps.id = pc.session_id
     WHERE pc.rider_id IS NULL AND COALESCE(ps.started_at, ps.created_at) >= ?
       ${sessionId != null ? "AND pc.session_id = ?" : ""}`,
  ).all(...(sessionId != null ? [since, sessionId] : [since])) as Array<{ session_id: number; club_id: number; rfid_number: string }>;
  const update = db.prepare(
    `UPDATE practice_crossings SET rider_id = ?, rider_name = ?, bib_number = ?
     WHERE session_id = ? AND rfid_number = ? COLLATE NOCASE AND rider_id IS NULL`,
  );
  let claimed = 0;
  for (const row of rows) {
    const rider = resolvePracticeRider(db, row.club_id, row.rfid_number);
    if (!rider) continue;
    claimed += update.run(rider.riderId, rider.riderName, rider.bibNumber, row.session_id, row.rfid_number).changes;
  }
  return claimed;
}

// POST /practice/active/crossing — from an RFID bridge or timing decoder, no session ID needed
router.post("/practice/active/crossing", rejectForeignBrowserIngest, (req, res) => {
  const clubId = Number(req.query.clubId);
  if (!clubId || isNaN(clubId)) {
    return res.status(400).json({ error: "Something was missing from that request. Refresh the page and try again." });
  }

  const body = req.body as any;
  const rfidNumber: string | undefined =
    body?.rfidNumber ?? body?.transponder ?? body?.transponderId ?? body?.id;
  if (!rfidNumber) {
    return res.status(400).json({ error: "Enter a transponder or tag number." });
  }

  const rawTime: string | undefined =
    body?.crossingTime ?? body?.passingTime ?? body?.timestamp;
  const crossingTime = rawTime ? new Date(rawTime) : new Date();
  if (isNaN(crossingTime.getTime())) {
    return res.status(400).json({ error: "Invalid crossingTime" });
  }

  const db = getDb();
  // Newest live session; one nobody ended (older than the live window) doesn't count.
  const session = db
    .prepare(
      `SELECT * FROM practice_sessions WHERE club_id = ? AND status = 'active'
       AND COALESCE(started_at, created_at) >= ? ORDER BY id DESC LIMIT 1`,
    )
    .get(clubId, new Date(Date.now() - LIVE_WINDOW_MS).toISOString()) as PracticeSessionRow | undefined;

  if (!session) {
    return res.status(409).json({
      error: "No practice session is running. Start one on the Practice page.",
      hint: "Start a practice session in the organizer portal first.",
    });
  }

  const result = processCrossing(db, session, String(rfidNumber), crossingTime);
  if ("skipped" in result) return res.status(200).json({ skipped: true, reason: result.skipped });

  const crossings = db
    .prepare(
      "SELECT * FROM practice_crossings WHERE session_id = ? ORDER BY crossing_time ASC",
    )
    .all(session.id) as PracticeCrossingRow[];
  broadcast(session.id, buildLiveBoard(session, crossings));

  return res.status(201).json(savedPassJson(crossings, result.id));
});

// GET /practice
router.get("/practice", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const clubId = getClubId(req);
  if (!clubId) return res.status(403).json({ error: "Your account isn't linked to a club yet. Ask your club's owner to add you on the Team page." });

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
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const db = getDb();
  const session = db
    .prepare("SELECT * FROM practice_sessions WHERE id = ?")
    .get(Number(req.params.id)) as PracticeSessionRow | undefined;
  if (!session) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  return res.json(serializeSession(session));
});

// POST /practice
router.post("/practice", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const clubId = getClubId(req);
  if (!clubId) return res.status(403).json({ error: "Your account isn't linked to a club yet. Ask your club's owner to add you on the Team page." });

  const { name, debounceMs, venueName, trackId: pickedTrackId } = req.body as { name?: string; debounceMs?: number; venueName?: string; trackId?: unknown };
  if (!name) return res.status(400).json({ error: "Enter a name." });
  if (!venueName?.trim()) return res.status(400).json({ error: "Enter a track name." });

  const db = getDb();
  // One live practice per club, as in the cloud: reads go to the newest.
  db.prepare("UPDATE practice_sessions SET status = 'ended', ended_at = ? WHERE club_id = ? AND status = 'active'")
    .run(new Date().toISOString(), clubId);
  // The library track (picked, or matched by name) and its course right now:
  // its split readers give sector times for this session (same as the cloud).
  let track = pickedTrackId != null && pickedTrackId !== ""
    ? db.prepare("SELECT id, course FROM tracks WHERE id = ? AND club_id = ?").get(Number(pickedTrackId), clubId) as { id: number; course: string | null } | undefined
    : undefined;
  track ??= db.prepare("SELECT id, course FROM tracks WHERE club_id = ? AND lower(trim(name)) = lower(trim(?)) LIMIT 1").get(clubId, venueName) as { id: number; course: string | null } | undefined;
  let course: string | null = null;
  if (track?.course) {
    try {
      const points = JSON.parse(track.course) as Array<{ readerId: number; role: string; sequence?: number; label?: string | null }>;
      if (Array.isArray(points) && points.length > 0) {
        const finish = points.find(p => p.role === "finish");
        const splits = points.filter(p => p.role === "split")
          .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
          .map((p, i) => ({ readerId: p.readerId, sequence: i + 1, label: p.label?.trim() || `Split ${i + 1}` }));
        course = JSON.stringify({ finishReaderId: finish?.readerId ?? null, splits });
      }
    } catch { /* an unreadable course means no sector times */ }
  }
  const ins = db
    .prepare(
      "INSERT INTO practice_sessions (club_id, name, debounce_ms, venue_name, track_id, course, status, started_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
    )
    .run(clubId, name, debounceMs ? Number(debounceMs) : 10000, venueName.trim(), track?.id ?? null, course, new Date().toISOString());

  const session = db
    .prepare("SELECT * FROM practice_sessions WHERE id = ?")
    .get(ins.lastInsertRowid) as PracticeSessionRow;
  return res.status(201).json(serializeSession(session));
});

// PATCH /practice/:id — start / end / rename / debounce
router.patch("/practice/:id", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const clubId = getClubId(req);
  const id = Number(req.params.id);
  const db = getDb();

  const existing = db
    .prepare("SELECT * FROM practice_sessions WHERE id = ?")
    .get(id) as PracticeSessionRow | undefined;
  if (!existing) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  if (existing.club_id !== clubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });

  const sets: string[] = [];
  const vals: unknown[] = [];

  if (req.body.name !== undefined) {
    sets.push("name = ?");
    vals.push(req.body.name);
  }
  if (req.body.venueName !== undefined) {
    const venueName = String(req.body.venueName).trim();
    if (!venueName) return res.status(400).json({ error: "Enter a track name." });
    sets.push("venue_name = ?");
    vals.push(venueName);
  }
  if (req.body.debounceMs !== undefined) {
    const debounceMs = Number(req.body.debounceMs);
    if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > 600_000) {
      return res.status(400).json({ error: "Enter a minimum lap time between 0 and 600 seconds." });
    }
    sets.push("debounce_ms = ?");
    vals.push(debounceMs);
  }
  if (req.body.status !== undefined) {
    if (!["idle", "active", "ended"].includes(String(req.body.status))) {
      return res.status(400).json({ error: "status must be one of: idle, active, ended" });
    }
    sets.push("status = ?");
    vals.push(req.body.status);
    if (req.body.status === "active" && existing.status !== "active") {
      // Resuming starts it fresh, and ends the club's other live session.
      sets.push("started_at = ?");
      vals.push(new Date().toISOString());
      db.prepare("UPDATE practice_sessions SET status = 'ended', ended_at = ? WHERE club_id = ? AND status = 'active' AND id != ?")
        .run(new Date().toISOString(), existing.club_id, id);
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
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const clubId = getClubId(req);
  const id = Number(req.params.id);
  const db = getDb();

  const existing = db
    .prepare("SELECT * FROM practice_sessions WHERE id = ?")
    .get(id) as PracticeSessionRow | undefined;
  if (!existing) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  if (existing.club_id !== clubId) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });

  db.prepare("DELETE FROM practice_split_crossings WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM practice_crossings WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM practice_sessions WHERE id = ?").run(id);
  return res.status(204).send();
});

// GET /practice/:id/crossings
router.get("/practice/:id/crossings", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
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
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const sessionId = Number(req.params.id);
  const db = getDb();

  const session = db
    .prepare("SELECT * FROM practice_sessions WHERE id = ?")
    .get(sessionId) as PracticeSessionRow | undefined;
  if (!session) return res.status(404).json({ error: "This session couldn't be found. It may have been deleted. Refresh the page and try again." });
  if (session.status !== "active") {
    return res.status(409).json({ error: "This practice session has ended. Start a new session on the Practice page." });
  }

  const body = req.body as any;
  const rfidNumber: string | undefined =
    body?.rfidNumber ?? body?.transponder ?? body?.transponderId;
  if (!rfidNumber) return res.status(400).json({ error: "Enter a transponder or tag number." });

  const rawTime: string | undefined =
    body?.crossingTime ?? body?.passingTime ?? body?.timestamp;
  const crossingTime = rawTime ? new Date(rawTime) : new Date();
  if (isNaN(crossingTime.getTime())) return res.status(400).json({ error: "Invalid crossingTime" });

  const result = processCrossing(db, session, String(rfidNumber), crossingTime);
  if ("skipped" in result) return res.status(200).json({ skipped: true, reason: result.skipped });

  const crossings = db
    .prepare(
      "SELECT * FROM practice_crossings WHERE session_id = ? ORDER BY crossing_time ASC",
    )
    .all(session.id) as PracticeCrossingRow[];
  broadcast(session.id, buildLiveBoard(session, crossings));

  return res.status(201).json(savedPassJson(crossings, result.id));
});

// GET /practice/:id/live — SSE live board
router.get("/practice/:id/live", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) {
    res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
    return;
  }
  const id = Number(req.params.id);
  const db = getDb();
  const session = db
    .prepare("SELECT * FROM practice_sessions WHERE id = ?")
    .get(id) as PracticeSessionRow | undefined;
  if (!session) {
    res.status(404).json({ error: "This session couldn't be found. It may have been deleted. Refresh the page and try again." });
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
  (res as any).flush?.();

  const heartbeat = setInterval(() => {
    try {
      (res as any).write(": heartbeat\n\n");
      (res as any).flush?.();
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
