import { Router } from "express";
import type Database from "better-sqlite3";
import { getDb, parseJson, parseJsonArr } from "../db";

/**
 * Enduro time checks, checkpoint arrivals, penalty summary and event reader
 * assignments, offline. Mirrors the cloud's routes/enduro-time-checks.ts and
 * routes/event-reader-assignments.ts.
 *
 * Sync: arrivals are queued row by row by SQLite triggers. Time checks, the
 * event's penalty config and reader assignments are each saved as a whole (PUT
 * replaces them), so a save queues one per-event snapshot ("event_enduro_setup",
 * record_id = event id) that the desktop sync engine pushes to the cloud.
 *
 * Not mirrored: the cloud recomputes penalty-adjusted enduro positions after
 * each change. The local server has no enduro scoring; the cloud recomputes
 * when the change syncs.
 */

const router = Router();

type TimeCheckTarget = { raceClass: string; durationMs: number; startTimeOfDay?: string | null };
type EnduroPenaltyConfig = {
  earlySecPerMin: number;
  lateSecPerMin: number;
  earlyDqMinutes: number | null;
  lateDqMinutes: number | null;
  timezone: string | null;
};

function eventExists(res: any, eventId: number): boolean {
  const ev = getDb().prepare("SELECT id FROM events WHERE id = ?").get(eventId);
  if (!ev) {
    res.status(404).json({ error: "Event not found" });
    return false;
  }
  return true;
}

function authEvent(req: any, res: any, eventId: number): boolean {
  if (!(req.session as any)?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return eventExists(res, eventId);
}

/** Queue this event's time checks + penalty config + reader assignments for push. */
export function queueEnduroSetup(db: Database.Database, eventId: number): void {
  const pending = db
    .prepare(
      `SELECT 1 FROM _write_queue
       WHERE table_name = 'event_enduro_setup' AND record_id = ? AND synced_at IS NULL AND attempt_count = 0`,
    )
    .get(eventId);
  if (!pending) {
    db.prepare("INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('event_enduro_setup', ?, 'upsert')")
      .run(eventId);
  }
}

function sanitizeTargets(raw: unknown): TimeCheckTarget[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      const rc = typeof (t as any)?.raceClass === "string" ? (t as any).raceClass.trim() : "";
      const ms = Number((t as any)?.durationMs);
      const startTimeOfDay = typeof (t as any)?.startTimeOfDay === "string" && (t as any).startTimeOfDay.trim()
        ? (t as any).startTimeOfDay.trim()
        : null;
      return {
        raceClass: rc,
        durationMs: Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : 0,
        startTimeOfDay,
      };
    })
    .filter((t) => t.raceClass.length > 0);
}

function sanitizePenaltyConfig(raw: unknown): EnduroPenaltyConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as any;
  const earlySecPerMin = Number(r.earlySecPerMin);
  const lateSecPerMin = Number(r.lateSecPerMin);
  if (!Number.isFinite(earlySecPerMin) || !Number.isFinite(lateSecPerMin)) return null;
  const earlyDqMinutes = r.earlyDqMinutes != null && Number.isFinite(Number(r.earlyDqMinutes))
    ? Number(r.earlyDqMinutes)
    : null;
  const lateDqMinutes = r.lateDqMinutes != null && Number.isFinite(Number(r.lateDqMinutes))
    ? Number(r.lateDqMinutes)
    : null;
  const timezone = typeof r.timezone === "string" && r.timezone.trim() ? r.timezone.trim() : null;
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch {
      return null;
    }
  }
  return { earlySecPerMin, lateSecPerMin, earlyDqMinutes, lateDqMinutes, timezone };
}

function serializeTimeCheck(r: any) {
  return {
    id: r.id,
    eventId: r.event_id,
    checkNumber: r.check_number,
    name: r.name,
    targets: parseJsonArr(r.targets),
    createdAt: r.created_at,
  };
}

function serializeArrival(a: any) {
  return {
    id: a.id,
    eventId: a.event_id,
    timeCheckId: a.time_check_id,
    riderId: a.rider_id,
    arrivalTime: a.arrival_time,
    recordedBy: a.recorded_by,
    createdAt: a.created_at,
  };
}

function listTimeChecks(eventId: number) {
  return (getDb()
    .prepare("SELECT * FROM enduro_time_checks WHERE event_id = ? ORDER BY check_number ASC, id ASC")
    .all(eventId) as any[]).map(serializeTimeCheck);
}

// GET /events/:eventId/time-checks
router.get("/events/:eventId/time-checks", (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Invalid eventId" });
  if (!authEvent(req, res, eventId)) return;
  return res.json(listTimeChecks(eventId));
});

// PUT /events/:eventId/time-checks — replace ALL time checks + save penalty config
router.put("/events/:eventId/time-checks", (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Invalid eventId" });
  if (!authEvent(req, res, eventId)) return;

  const body = req.body as { timeChecks?: unknown; penaltyConfig?: unknown };
  if (!Array.isArray(body?.timeChecks)) {
    return res.status(400).json({ error: "timeChecks array is required" });
  }

  const incoming = body.timeChecks.map((tc: any, i: number) => ({
    checkNumber: Number.isFinite(Number(tc?.checkNumber)) ? Number(tc.checkNumber) : i + 1,
    name: typeof tc?.name === "string" && tc.name.trim() ? tc.name.trim() : `Time Check ${i + 1}`,
    targets: sanitizeTargets(tc?.targets),
  }));
  const penaltyConfig = sanitizePenaltyConfig(body.penaltyConfig);

  const db = getDb();
  // The replaced checks are deleted, and arrivals reference them. The cloud's
  // foreign key refuses that delete, so refuse it here too instead of
  // orphaning recorded arrivals.
  const hasArrivals = db.prepare("SELECT 1 FROM enduro_checkpoint_arrivals WHERE event_id = ? LIMIT 1").get(eventId);
  if (hasArrivals) {
    return res.status(409).json({ error: "Time checks can't be replaced after arrivals have been recorded for this event." });
  }

  db.transaction(() => {
    const existingIds = (db.prepare("SELECT id FROM enduro_time_checks WHERE event_id = ?").all(eventId) as Array<{ id: number }>)
      .map((r) => r.id);
    if (existingIds.length > 0) {
      db.prepare(
        `UPDATE event_reader_assignments SET time_check_id = NULL
         WHERE time_check_id IN (${existingIds.map(() => "?").join(",")})`,
      ).run(...existingIds);
    }
    db.prepare("DELETE FROM enduro_time_checks WHERE event_id = ?").run(eventId);
    const insert = db.prepare("INSERT INTO enduro_time_checks (event_id, check_number, name, targets) VALUES (?, ?, ?, ?)");
    for (const tc of incoming) insert.run(eventId, tc.checkNumber, tc.name, JSON.stringify(tc.targets));
    db.prepare("UPDATE events SET enduro_penalty_config = ? WHERE id = ?")
      .run(penaltyConfig ? JSON.stringify(penaltyConfig) : null, eventId);
    queueEnduroSetup(db, eventId);
  })();

  return res.json(incoming.length === 0 ? [] : listTimeChecks(eventId));
});

// GET /events/:eventId/time-checks/:checkId/arrivals
router.get("/events/:eventId/time-checks/:checkId/arrivals", (req, res) => {
  const eventId = Number(req.params.eventId);
  const checkId = Number(req.params.checkId);
  if (!eventId || !checkId) return res.status(400).json({ error: "Invalid params" });
  if (!authEvent(req, res, eventId)) return;

  const rows = getDb()
    .prepare(
      `SELECT a.*, r.first_name, r.last_name
       FROM enduro_checkpoint_arrivals a
       LEFT JOIN riders r ON r.id = a.rider_id
       WHERE a.event_id = ? AND a.time_check_id = ?`,
    )
    .all(eventId, checkId) as any[];

  return res.json(rows.map((a) => ({
    ...serializeArrival(a),
    riderName: a.first_name && a.last_name ? `${a.first_name} ${a.last_name}` : null,
    riderLastName: a.last_name ?? null,
  })));
});

// POST /events/:eventId/time-checks/:checkId/arrivals — record/upsert manual arrival
router.post("/events/:eventId/time-checks/:checkId/arrivals", (req, res) => {
  const eventId = Number(req.params.eventId);
  const checkId = Number(req.params.checkId);
  if (!eventId || !checkId) return res.status(400).json({ error: "Invalid params" });
  if (!authEvent(req, res, eventId)) return;

  const { riderId, arrivalTime } = (req.body ?? {}) as { riderId?: unknown; arrivalTime?: unknown };
  if (!riderId || !arrivalTime) return res.status(400).json({ error: "riderId and arrivalTime are required" });
  const parsedArrival = new Date(arrivalTime as string);
  if (isNaN(parsedArrival.getTime())) return res.status(400).json({ error: "Invalid arrivalTime" });

  const db = getDb();
  const check = db.prepare("SELECT id FROM enduro_time_checks WHERE id = ? AND event_id = ?").get(checkId, eventId);
  if (!check) return res.status(404).json({ error: "Time check not found" });

  db.prepare(
    `INSERT INTO enduro_checkpoint_arrivals (event_id, time_check_id, rider_id, arrival_time, recorded_by)
     VALUES (?, ?, ?, ?, 'manual')
     ON CONFLICT (time_check_id, rider_id) DO UPDATE SET arrival_time = excluded.arrival_time, recorded_by = 'manual'`,
  ).run(eventId, checkId, Number(riderId), parsedArrival.toISOString());

  const arrival = db
    .prepare("SELECT * FROM enduro_checkpoint_arrivals WHERE time_check_id = ? AND rider_id = ?")
    .get(checkId, Number(riderId));
  return res.json(serializeArrival(arrival));
});

// DELETE /events/:eventId/time-checks/:checkId/arrivals/:riderId
router.delete("/events/:eventId/time-checks/:checkId/arrivals/:riderId", (req, res) => {
  const eventId = Number(req.params.eventId);
  const checkId = Number(req.params.checkId);
  const riderId = Number(req.params.riderId);
  if (!eventId || !checkId || !riderId) return res.status(400).json({ error: "Invalid params" });
  if (!authEvent(req, res, eventId)) return;

  const result = getDb()
    .prepare("DELETE FROM enduro_checkpoint_arrivals WHERE event_id = ? AND time_check_id = ? AND rider_id = ?")
    .run(eventId, checkId, riderId);
  if (result.changes === 0) return res.status(404).json({ error: "Arrival not found" });
  return res.json({ ok: true });
});

// ── Penalty computation (mirrors cloud routes/enduro-scoring.ts) ─────────────

function parseTimeMinutes(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function extractTimeOfDayMins(d: Date, tz: string | null | undefined): number {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: tz,
      }).formatToParts(d);
      const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
      const h = get("hour") % 24;
      return h * 60 + get("minute") + get("second") / 60;
    } catch {
      // Fall through to local time if the timezone string is invalid.
    }
  }
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

function computeEnduroPenalty(
  arrivalTime: Date,
  target: TimeCheckTarget,
  config: EnduroPenaltyConfig,
): { penaltySeconds: number; disqualified: boolean; diffMinutes: number } {
  const startMins = parseTimeMinutes(target.startTimeOfDay);
  if (startMins == null) return { penaltySeconds: 0, disqualified: false, diffMinutes: 0 };
  const expectedMins = startMins + target.durationMs / 60_000;
  const actualMins = extractTimeOfDayMins(arrivalTime, config.timezone);
  const diffMinutes = actualMins - expectedMins;
  if (diffMinutes > 0) {
    if (config.lateDqMinutes != null && diffMinutes > config.lateDqMinutes) return { penaltySeconds: 0, disqualified: true, diffMinutes };
    return { penaltySeconds: Math.floor(diffMinutes) * config.lateSecPerMin, disqualified: false, diffMinutes };
  } else if (diffMinutes < 0) {
    const minsEarly = -diffMinutes;
    if (config.earlyDqMinutes != null && minsEarly > config.earlyDqMinutes) return { penaltySeconds: 0, disqualified: true, diffMinutes };
    return { penaltySeconds: Math.floor(minsEarly) * config.earlySecPerMin, disqualified: false, diffMinutes };
  }
  return { penaltySeconds: 0, disqualified: false, diffMinutes: 0 };
}

// GET /events/:eventId/penalty-summary — per-rider penalty totals.
// Organizers always; anyone else only once results are published (as the cloud).
router.get("/events/:eventId/penalty-summary", (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Invalid eventId" });
  const db = getDb();
  const event = db.prepare("SELECT id, enduro_penalty_config FROM events WHERE id = ?").get(eventId) as
    | { id: number; enduro_penalty_config: string | null }
    | undefined;
  if (!event) return res.status(404).json({ error: "Event not found" });
  if (!(req.session as any)?.userId) {
    const pub = db.prepare("SELECT published FROM event_publication WHERE event_id = ?").get(eventId) as
      | { published: number }
      | undefined;
    if (pub?.published !== 1) return res.status(403).json({ error: "Results not published" });
  }

  const config = parseJson<EnduroPenaltyConfig | null>(event.enduro_penalty_config, null);
  if (!config) return res.json([]);

  const checks = db
    .prepare("SELECT * FROM enduro_time_checks WHERE event_id = ? ORDER BY check_number ASC, id ASC")
    .all(eventId) as any[];
  if (checks.length === 0) return res.json([]);

  const arrivals = db
    .prepare(
      `SELECT a.rider_id, a.time_check_id, a.arrival_time, ri.first_name, ri.last_name,
              (SELECT g.race_class FROM registrations g
               WHERE g.rider_id = a.rider_id AND g.event_id = a.event_id
               ORDER BY g.id LIMIT 1) AS race_class
       FROM enduro_checkpoint_arrivals a
       LEFT JOIN riders ri ON ri.id = a.rider_id
       WHERE a.event_id = ?`,
    )
    .all(eventId) as any[];

  const arrivalsByRider = new Map<number, any[]>();
  for (const a of arrivals) {
    if (!arrivalsByRider.has(a.rider_id)) arrivalsByRider.set(a.rider_id, []);
    arrivalsByRider.get(a.rider_id)!.push(a);
  }

  const summary = [];
  for (const [riderId, riderArrivals] of arrivalsByRider) {
    const sample = riderArrivals[0];
    const riderName = `${sample.first_name ?? ""} ${sample.last_name ?? ""}`.trim();
    const raceClass = sample.race_class ?? null;
    let totalPenaltySeconds = 0;
    let disqualified = false;
    const checkDetails = [];

    for (const check of checks) {
      const targets = parseJsonArr<TimeCheckTarget>(check.targets);
      const target = targets.find((t) => t.raceClass === raceClass);
      if (!target || !target.startTimeOfDay) continue;
      const arrival = riderArrivals.find((a) => a.time_check_id === check.id);
      if (!arrival) {
        checkDetails.push({ checkId: check.id, checkName: check.name, diffMinutes: 0, penaltySeconds: 0, disqualified: false, hasArrival: false });
        continue;
      }
      const result = computeEnduroPenalty(new Date(arrival.arrival_time), target, config);
      totalPenaltySeconds += result.penaltySeconds;
      if (result.disqualified) disqualified = true;
      checkDetails.push({
        checkId: check.id,
        checkName: check.name,
        diffMinutes: result.diffMinutes,
        penaltySeconds: result.penaltySeconds,
        disqualified: result.disqualified,
        hasArrival: true,
      });
    }
    summary.push({ riderId, riderName, raceClass, totalPenaltySeconds, disqualified, checkDetails });
  }

  summary.sort((a, b) => {
    if (a.disqualified !== b.disqualified) return a.disqualified ? 1 : -1;
    return a.totalPenaltySeconds - b.totalPenaltySeconds;
  });
  return res.json(summary);
});

// ── Event reader assignments ─────────────────────────────────────────────────

function serializeAssignment(a: any) {
  return {
    id: a.id,
    eventId: a.event_id,
    readerId: a.reader_id,
    antennaId: a.antenna_id ?? null,
    role: a.role,
    motoId: a.moto_id ?? null,
    timeCheckId: a.time_check_id ?? null,
    sequence: a.sequence ?? null,
    label: a.label ?? null,
    createdAt: a.created_at,
  };
}

router.get("/events/:eventId/reader-assignments", (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Invalid eventId" });
  if (!authEvent(req, res, eventId)) return;
  const rows = getDb().prepare("SELECT * FROM event_reader_assignments WHERE event_id = ? ORDER BY id").all(eventId);
  return res.json(rows.map(serializeAssignment));
});

// PUT /events/:eventId/reader-assignments — replace all assignments for this event.
// Readers are cloud records; the cloud re-checks that each belongs to the club
// when the change syncs.
router.put("/events/:eventId/reader-assignments", (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Invalid eventId" });
  if (!authEvent(req, res, eventId)) return;

  const body = req.body as { assignments?: unknown };
  if (!Array.isArray(body?.assignments)) {
    return res.status(400).json({ error: "assignments array is required" });
  }
  const incoming = body.assignments.map((a: any) => ({
    readerId: Number(a?.readerId),
    antennaId: a?.antennaId != null ? Number(a.antennaId) : null,
    role: ["start", "finish", "split", "time_check"].includes(a?.role) ? a.role : "start",
    motoId: a?.motoId != null ? Number(a.motoId) : null,
    timeCheckId: a?.timeCheckId != null ? Number(a.timeCheckId) : null,
    sequence: Number.isInteger(a?.sequence) ? a.sequence : null,
    label: typeof a?.label === "string" && a.label.trim() ? a.label.trim().slice(0, 60) : null,
  }));
  if (incoming.some((a) => !Number.isInteger(a.readerId) || a.readerId <= 0)) {
    return res.status(400).json({ error: "Each assignment needs a readerId" });
  }
  // Same course map rules as the cloud.
  const course = incoming.filter((a) => a.motoId == null && (a.role === "finish" || a.role === "split"));
  if (incoming.some((a) => a.role === "split" && a.motoId != null)) {
    return res.status(400).json({ error: "Split readers apply to the whole event, not one moto" });
  }
  if (course.filter((a) => a.role === "finish").length > 1) {
    return res.status(400).json({ error: "An event has one finish-line reader" });
  }
  if (new Set(course.map((a) => a.readerId)).size !== course.length) {
    return res.status(400).json({ error: "Each reader can only be in one place on the course" });
  }

  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM event_reader_assignments WHERE event_id = ?").run(eventId);
    const insert = db.prepare(
      `INSERT INTO event_reader_assignments (event_id, reader_id, antenna_id, role, moto_id, time_check_id, sequence, label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of incoming) insert.run(eventId, a.readerId, a.antennaId, a.role, a.motoId, a.timeCheckId, a.sequence, a.label);
    queueEnduroSetup(db, eventId);
  })();

  const rows = db.prepare("SELECT * FROM event_reader_assignments WHERE event_id = ? ORDER BY id").all(eventId);
  return res.json(rows.map(serializeAssignment));
});

export default router;
