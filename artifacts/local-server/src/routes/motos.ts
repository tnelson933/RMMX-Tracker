import { Router } from "express";
import { getDb, parseJsonArr } from "../db";
import { sseBroadcast, buildLeaderboard } from "./timing";

const router = Router();

function serializeMoto(m: any) {
  return {
    id: m.id,
    eventId: m.event_id,
    name: m.name ?? "",
    type: m.type ?? "moto",
    raceClass: m.race_class,
    raceClasses: parseJsonArr(m.race_classes),
    motoNumber: m.moto_number,
    scheduledTime: m.scheduled_time ?? null,
    lineup: parseJsonArr(m.lineup),
    lapCount: m.lap_count ?? null,
    timeLimitMs: m.time_limit_ms ?? null,
    status: m.status,
    startedAt: m.started_at ?? null,
    completedAt: m.completed_at ?? null,
    staggeredWithMotoId: m.staggered_with_moto_id ?? null,
    staggeredOrder: m.staggered_order ?? null,
    createdAt: m.created_at,
  };
}

// GET /events/:eventId/motos
router.get("/events/:eventId/motos", (req, res) => {
  const db = getDb();
  const eventId = Number(req.params.eventId);
  const motos = db
    .prepare("SELECT * FROM motos WHERE event_id = ? ORDER BY moto_number ASC")
    .all(eventId) as any[];
  return res.json(motos.map(serializeMoto));
});

// POST /events/:eventId/motos
router.post("/events/:eventId/motos", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const eventId = Number(req.params.eventId);
  const { name, type, raceClass, motoNumber, scheduledTime, lineup, lapCount, timeLimitMs } =
    req.body;
  if (!name || !type || !raceClass || motoNumber === undefined) {
    return res
      .status(400)
      .json({ error: "name, type, raceClass, motoNumber required" });
  }
  const result = db
    .prepare(
      `INSERT INTO motos (event_id, name, type, race_class, moto_number, scheduled_time, lineup, lap_count, time_limit_ms, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', datetime('now'))`,
    )
    .run(
      eventId,
      name,
      type,
      raceClass,
      Number(motoNumber),
      scheduledTime ?? null,
      JSON.stringify(lineup ?? []),
      lapCount ? Number(lapCount) : null,
      timeLimitMs ? Number(timeLimitMs) : null,
    );
  const moto = db
    .prepare("SELECT * FROM motos WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as any;
  return res.status(201).json(serializeMoto(moto));
});

// PATCH /motos/:motoId — update status, lineup, lapCount, scheduledTime, motoNumber, name
router.patch("/motos/:motoId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const id = Number(req.params.motoId);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (req.body.status !== undefined) {
    fields.push("status = ?");
    values.push(req.body.status);
    if (req.body.status === "in_progress") {
      fields.push("started_at = ?");
      values.push(new Date().toISOString());
    }
    if (req.body.status === "completed") {
      fields.push("completed_at = ?");
      values.push(new Date().toISOString());
    }
  }
  if (req.body.lineup !== undefined) {
    fields.push("lineup = ?");
    values.push(JSON.stringify(req.body.lineup));
  }
  if (req.body.scheduledTime !== undefined) {
    fields.push("scheduled_time = ?");
    values.push(req.body.scheduledTime);
  }
  if (req.body.lapCount !== undefined) {
    fields.push("lap_count = ?");
    values.push(req.body.lapCount !== null ? Number(req.body.lapCount) : null);
  }
  if (req.body.timeLimitMs !== undefined) {
    fields.push("time_limit_ms = ?");
    values.push(
      req.body.timeLimitMs !== null ? Number(req.body.timeLimitMs) : null,
    );
  }
  if (req.body.motoNumber !== undefined) {
    fields.push("moto_number = ?");
    values.push(Number(req.body.motoNumber));
  }
  if (req.body.name !== undefined) {
    fields.push("name = ?");
    values.push(String(req.body.name));
  }
  if (req.body.raceClass !== undefined) {
    fields.push("race_class = ?");
    values.push(String(req.body.raceClass));
  }
  if (req.body.practiceMode !== undefined) {
    fields.push("practice_mode = ?");
    values.push(req.body.practiceMode !== null ? String(req.body.practiceMode) : null);
  }
  if (req.body.countdownSeconds !== undefined) {
    fields.push("countdown_seconds = ?");
    values.push(req.body.countdownSeconds !== null ? Number(req.body.countdownSeconds) : null);
  }

  if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });

  values.push(id);
  db.prepare(`UPDATE motos SET ${fields.join(", ")} WHERE id = ?`).run(
    ...(values as any[]),
  );

  const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(id) as any;
  if (!moto) return res.status(404).json({ error: "Not found" });

  if (req.body.status !== undefined) {
    const snapshot = buildLeaderboard(id);
    if (snapshot) sseBroadcast(id, snapshot);
  }

  return res.json(serializeMoto(moto));
});

// DELETE /motos/:motoId
router.delete("/motos/:motoId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const id = Number(req.params.motoId);

  const moto = db.prepare("SELECT id, status FROM motos WHERE id = ?").get(id) as any;
  if (!moto) return res.status(404).json({ error: "Not found" });

  db.prepare("DELETE FROM lap_crossings WHERE moto_id = ?").run(id);
  if (moto.status !== "completed") {
    db.prepare("DELETE FROM race_results WHERE moto_id = ?").run(id);
  }
  db.prepare("DELETE FROM motos WHERE id = ?").run(id);
  return res.status(204).send();
});

// DELETE /events/:eventId/motos — bulk-delete non-completed motos
router.delete("/events/:eventId/motos", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const eventId = Number(req.params.eventId);

  const targets = db
    .prepare(
      "SELECT id FROM motos WHERE event_id = ? AND status != 'completed'",
    )
    .all(eventId) as any[];

  if (targets.length === 0) return res.status(204).send();

  const ids = targets.map((m: any) => m.id);
  const placeholders = ids.map(() => "?").join(",");

  db.prepare(`DELETE FROM lap_crossings WHERE moto_id IN (${placeholders})`).run(
    ...ids,
  );
  db.prepare(`DELETE FROM race_results WHERE moto_id IN (${placeholders})`).run(
    ...ids,
  );
  db.prepare(`DELETE FROM motos WHERE id IN (${placeholders})`).run(...ids);

  return res.status(204).send();
});

// POST /motos/:motoId/restart — wipe crossings and reset status to scheduled
router.post("/motos/:motoId/restart", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const id = Number(req.params.motoId);

  const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(id) as any;
  if (!moto) return res.status(404).json({ error: "Not found" });

  db.prepare("DELETE FROM lap_crossings WHERE moto_id = ?").run(id);
  db.prepare(
    "UPDATE race_results SET lap_times = '[]', total_time = NULL WHERE moto_id = ?",
  ).run(id);
  db.prepare(
    "UPDATE motos SET status = 'scheduled', started_at = NULL WHERE id = ?",
  ).run(id);

  const updated = db.prepare("SELECT * FROM motos WHERE id = ?").get(id) as any;

  const snapshot = buildLeaderboard(id);
  if (snapshot) sseBroadcast(id, snapshot);

  return res.json({ ok: true, moto: serializeMoto(updated) });
});

// POST /events/:eventId/stagger — link two motos as staggered start pair
router.post("/events/:eventId/stagger", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const { motoId1, motoId2, firstMotoId } = req.body;
  if (!motoId1 || !motoId2 || !firstMotoId) {
    return res
      .status(400)
      .json({ error: "motoId1, motoId2, firstMotoId required" });
  }
  const id1 = Number(motoId1);
  const id2 = Number(motoId2);
  const firstId = Number(firstMotoId);
  if (id1 === id2) {
    return res.status(400).json({ error: "Cannot stagger a moto with itself" });
  }
  const secondId = firstId === id1 ? id2 : id1;
  db.prepare(
    "UPDATE motos SET staggered_with_moto_id = ?, staggered_order = 1 WHERE id = ?",
  ).run(secondId, firstId);
  db.prepare(
    "UPDATE motos SET staggered_with_moto_id = ?, staggered_order = 2 WHERE id = ?",
  ).run(firstId, secondId);
  return res.json({ ok: true });
});

// DELETE /motos/:motoId/stagger — unlink stagger pair
router.delete("/motos/:motoId/stagger", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const id = Number(req.params.motoId);
  const moto = db
    .prepare("SELECT staggered_with_moto_id FROM motos WHERE id = ?")
    .get(id) as any;
  if (!moto) return res.status(404).json({ error: "Not found" });

  db.prepare(
    "UPDATE motos SET staggered_with_moto_id = NULL, staggered_order = NULL WHERE id = ?",
  ).run(id);
  if (moto.staggered_with_moto_id) {
    db.prepare(
      "UPDATE motos SET staggered_with_moto_id = NULL, staggered_order = NULL WHERE id = ?",
    ).run(moto.staggered_with_moto_id);
  }
  return res.json({ ok: true });
});

// POST /events/:eventId/motos/reorder — bulk reassign motoNumber values
router.post("/events/:eventId/motos/reorder", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const eventId = Number(req.params.eventId);
  const { motoIds } = req.body as { motoIds: number[] };

  if (!Array.isArray(motoIds) || motoIds.length === 0) {
    return res.status(400).json({ error: "motoIds array is required" });
  }
  const unique = new Set(motoIds);
  if (unique.size !== motoIds.length) {
    return res.status(400).json({ error: "motoIds must not contain duplicates" });
  }

  const existing = db
    .prepare(
      `SELECT id FROM motos WHERE event_id = ? AND id IN (${motoIds.map(() => "?").join(",")})`,
    )
    .all(eventId, ...motoIds) as any[];

  const existingIds = new Set(existing.map((m: any) => m.id));
  const invalid = motoIds.filter((id) => !existingIds.has(id));
  if (invalid.length > 0) {
    return res
      .status(400)
      .json({ error: `Moto IDs not found in event: ${invalid.join(", ")}` });
  }

  const updateStmt = db.prepare(
    "UPDATE motos SET moto_number = ? WHERE id = ? AND event_id = ?",
  );
  const reorderTx = db.transaction(() => {
    for (let i = 0; i < motoIds.length; i++) {
      updateStmt.run(i + 1, motoIds[i], eventId);
    }
  });
  reorderTx();

  const motos = db
    .prepare("SELECT * FROM motos WHERE event_id = ? ORDER BY moto_number ASC")
    .all(eventId) as any[];
  return res.json(motos.map(serializeMoto));
});

// GET /motos/:motoId/results — race results for a moto (used by results tab + results entry)
router.get("/motos/:motoId/results", (req, res) => {
  const db = getDb();
  const motoId = Number(req.params.motoId);
  const results = db
    .prepare(
      `SELECT rr.*, r.first_name, r.last_name
       FROM race_results rr
       LEFT JOIN riders r ON rr.rider_id = r.id
       WHERE rr.moto_id = ?
       ORDER BY rr.position ASC`,
    )
    .all(motoId) as any[];
  return res.json(
    results.map((r: any) => ({
      id: r.id,
      motoId: r.moto_id,
      eventId: r.event_id,
      riderId: r.rider_id,
      riderName: r.first_name
        ? `${r.first_name} ${r.last_name ?? ""}`.trim()
        : null,
      raceClass: r.race_class,
      position: r.position,
      bibNumber: r.bib_number,
      lapTimes: parseJsonArr<number>(r.lap_times),
      totalTime: r.total_time,
      dnf: r.dnf === 1,
      dns: r.dns === 1,
    })),
  );
});

// GET /events/:eventId/race-results — all results for an event (results browser)
router.get("/events/:eventId/race-results", (req, res) => {
  const db = getDb();
  const eventId = Number(req.params.eventId);
  const results = db
    .prepare(
      `SELECT rr.*, r.first_name, r.last_name, m.name AS moto_name, m.type AS moto_type
       FROM race_results rr
       LEFT JOIN riders r ON rr.rider_id = r.id
       LEFT JOIN motos m ON rr.moto_id = m.id
       WHERE rr.event_id = ?
       ORDER BY rr.moto_id ASC, rr.position ASC`,
    )
    .all(eventId) as any[];
  return res.json(
    results.map((r: any) => ({
      id: r.id,
      motoId: r.moto_id,
      motoName: r.moto_name,
      motoType: r.moto_type,
      riderId: r.rider_id,
      riderName: r.first_name
        ? `${r.first_name} ${r.last_name ?? ""}`.trim()
        : null,
      raceClass: r.race_class,
      position: r.position,
      bibNumber: r.bib_number,
      lapTimes: parseJsonArr<number>(r.lap_times),
      totalTime: r.total_time,
      dnf: r.dnf === 1,
      dns: r.dns === 1,
    })),
  );
});

// ─── Generate lineups ────────────────────────────────────────────────────────

function getEventFormat(eventId: number): { isSupercross: boolean } {
  const db = getDb();
  const event = db
    .prepare("SELECT scoring_table_id FROM events WHERE id = ?")
    .get(eventId) as any;
  if (!event?.scoring_table_id) return { isSupercross: false };

  const table = db
    .prepare("SELECT main_event_only FROM points_tables WHERE id = ?")
    .get(event.scoring_table_id) as any;
  return { isSupercross: table?.main_event_only === 1 };
}

// POST /events/:eventId/generate-lineups
router.post("/events/:eventId/generate-lineups", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const eventId = Number(req.params.eventId);

  const {
    raceFormat,
    classes,
    ridersPerHeat,
    usePracticeSeeding,
    gateSeedingMethod: rawMethod,
    gatePickMethod,
    rounds: roundsFilter,
    lapCount,
    minRacesBetween,
  } = req.body;

  const minGap: number =
    minRacesBetween && Number(minRacesBetween) >= 1
      ? Math.min(3, Number(minRacesBetween))
      : 0;
  const motoLapCount: number | null =
    lapCount != null && Number(lapCount) > 0 ? Number(lapCount) : null;

  let seedingMethod:
    | "random"
    | "practice_fastest_lap"
    | "previous_round"
    | "registration_order"
    | "series_points";

  if (gatePickMethod) {
    seedingMethod =
      gatePickMethod === "practice"
        ? "practice_fastest_lap"
        : gatePickMethod === "prior_round_finish"
          ? "previous_round"
          : gatePickMethod === "first_registered"
            ? "registration_order"
            : gatePickMethod === "series_points"
              ? "series_points"
              : "random";
  } else {
    seedingMethod =
      rawMethod ?? (usePracticeSeeding ? "practice_fastest_lap" : "random");
  }

  function getRoundFromMoto(m: {
    name: string | null;
    type: string | null;
  }): number {
    const nameMatch = (m.name ?? "").match(/\bMoto\s+(\d+)\b/i);
    if (nameMatch) return parseInt(nameMatch[1]);
    if (m.type === "main") return 2;
    return 1;
  }

  const existingMotos = db
    .prepare(
      "SELECT id, race_class, status, moto_number, name, type FROM motos WHERE event_id = ?",
    )
    .all(eventId) as any[];

  const lockedClasses =
    seedingMethod === "previous_round"
      ? new Set<string>()
      : new Set(
          existingMotos
            .filter((m: any) => m.status === "completed")
            .map((m: any) => m.race_class)
            .filter((c: any): c is string => c != null),
        );

  const classesToGenerate: string[] = ((classes as string[]) || []).filter(
    (c) => !lockedClasses.has(c),
  );

  const divCount =
    raceFormat === "three_moto" ? 3 : raceFormat === "two_moto" ? 2 : 1;

  const deletedMotoIds = new Set<number>();
  const roundsSet =
    roundsFilter && (roundsFilter as number[]).length > 0
      ? new Set<number>(roundsFilter as number[])
      : null;

  const idsToDelete = existingMotos
    .filter((m: any) => {
      if (m.race_class == null) return false;
      if (m.status === "completed") return false;
      if (m.type === "practice") return false;
      if (lockedClasses.has(m.race_class)) {
        return getRoundFromMoto(m) > divCount;
      }
      if (!classesToGenerate.includes(m.race_class)) return false;
      if (roundsSet !== null && !roundsSet.has(getRoundFromMoto(m)))
        return false;
      return true;
    })
    .map((m: any) => m.id);

  if (idsToDelete.length > 0) {
    idsToDelete.forEach((id: number) => deletedMotoIds.add(id));
    const ph = idsToDelete.map(() => "?").join(",");
    db.prepare(`DELETE FROM motos WHERE id IN (${ph})`).run(...idsToDelete);
  }

  const { isSupercross: isSupercrossFormat } = getEventFormat(eventId);

  // Registration order seeding
  let registrationOrderByRider = new Map<number, number>();
  if (seedingMethod === "registration_order") {
    const regs = db
      .prepare(
        "SELECT rider_id, created_at FROM registrations WHERE event_id = ? ORDER BY created_at ASC",
      )
      .all(eventId) as any[];
    regs.forEach((r: any, idx: number) => {
      if (r.rider_id != null)
        registrationOrderByRider.set(r.rider_id, idx + 1);
    });
  }

  // Practice fastest lap seeding
  let bestLapByRider = new Map<number, number>();
  if (seedingMethod === "practice_fastest_lap") {
    const eventRow = db
      .prepare("SELECT club_id FROM events WHERE id = ?")
      .get(eventId) as any;
    if (eventRow?.club_id) {
      const sessions = db
        .prepare(
          "SELECT id FROM practice_sessions WHERE club_id = ?",
        )
        .all(eventRow.club_id) as any[];
      if (sessions.length > 0) {
        const sessionIds = sessions.map((s: any) => s.id);
        const ph = sessionIds.map(() => "?").join(",");
        const bestLaps = db
          .prepare(
            `SELECT rider_id, MIN(lap_time_ms) as best_lap
             FROM practice_crossings
             WHERE session_id IN (${ph}) AND lap_time_ms > 0
             GROUP BY rider_id`,
          )
          .all(...sessionIds) as any[];
        for (const row of bestLaps) {
          if (row.rider_id != null && row.best_lap != null && row.best_lap > 0) {
            bestLapByRider.set(row.rider_id, Number(row.best_lap));
          }
        }
      }
    }
  }

  // Previous round seeding
  const prevRoundByClass = new Map<
    string,
    Map<number, { position: number; bestLapMs: number | null }>
  >();

  if (seedingMethod === "previous_round") {
    const completedMotos = existingMotos.filter(
      (m: any) =>
        m.status === "completed" && m.race_class != null && m.type !== "practice",
    );

    const completedByClass = new Map<string, any[]>();
    for (const m of completedMotos) {
      const cls = m.race_class as string;
      if (!completedByClass.has(cls)) completedByClass.set(cls, []);
      completedByClass.get(cls)!.push(m);
    }

    const motoRoundNumber = new Map<number, number>();
    for (const [, motos] of completedByClass) {
      for (const m of motos) {
        motoRoundNumber.set(m.id, getRoundFromMoto(m));
      }
    }

    const maxRoundByClass = new Map<string, number>();
    for (const m of completedMotos) {
      const cls = m.race_class as string;
      const rn = motoRoundNumber.get(m.id) ?? 1;
      maxRoundByClass.set(cls, Math.max(maxRoundByClass.get(cls) ?? 0, rn));
    }

    const prevRoundMotoIds: number[] = [];
    for (const m of completedMotos) {
      const cls = m.race_class as string;
      if ((motoRoundNumber.get(m.id) ?? 1) === maxRoundByClass.get(cls)) {
        prevRoundMotoIds.push(m.id);
      }
    }

    if (prevRoundMotoIds.length > 0) {
      const ph = prevRoundMotoIds.map(() => "?").join(",");
      const results = db
        .prepare(
          `SELECT moto_id, rider_id, race_class, position, dnf, dns
           FROM race_results WHERE moto_id IN (${ph})`,
        )
        .all(...prevRoundMotoIds) as any[];

      const bestLapsForRound = db
        .prepare(
          `SELECT moto_id, rider_id, MIN(lap_time_ms) as best_lap
           FROM lap_crossings
           WHERE moto_id IN (${ph}) AND lap_time_ms > 0
           GROUP BY moto_id, rider_id`,
        )
        .all(...prevRoundMotoIds) as any[];

      const bestLapInRound = new Map<number, number>();
      for (const row of bestLapsForRound) {
        if (row.rider_id != null && row.best_lap != null && row.best_lap > 0) {
          const existing = bestLapInRound.get(row.rider_id);
          const lap = Number(row.best_lap);
          bestLapInRound.set(
            row.rider_id,
            existing != null ? Math.min(existing, lap) : lap,
          );
        }
      }

      const HIGH_POS = 9999;
      for (const r of results) {
        const cls = r.race_class;
        if (!prevRoundByClass.has(cls)) prevRoundByClass.set(cls, new Map());
        const classMap = prevRoundByClass.get(cls)!;
        const pos = r.dnf === 1 || r.dns === 1 ? HIGH_POS : r.position;
        const existing = classMap.get(r.rider_id);
        if (!existing || pos < existing.position) {
          classMap.set(r.rider_id, {
            position: pos,
            bestLapMs: bestLapInRound.get(r.rider_id) ?? null,
          });
        }
      }
    }
  }

  // Series points seeding
  const seriesPointsByClass = new Map<string, Map<number, number>>();
  if (seedingMethod === "series_points") {
    const allSeries = db
      .prepare("SELECT id, event_ids FROM series")
      .all() as any[];
    const eventSeries = allSeries.find((s: any) => {
      const ids: number[] = (() => { try { return JSON.parse(s.event_ids || "[]"); } catch { return []; } })();
      return ids.includes(eventId);
    });
    if (eventSeries) {
      const pts = db
        .prepare(
          "SELECT rider_id, race_class, total_points FROM series_points WHERE series_id = ?",
        )
        .all(eventSeries.id) as any[];
      for (const row of pts) {
        if (!seriesPointsByClass.has(row.race_class))
          seriesPointsByClass.set(row.race_class, new Map());
        seriesPointsByClass
          .get(row.race_class)!
          .set(row.rider_id, row.total_points);
      }
    }
  }

  const effectiveMax: number =
    ridersPerHeat && ridersPerHeat > 0 ? ridersPerHeat : Infinity;

  const checkins = db
    .prepare(
      `SELECT c.rider_id, c.race_class, c.bib_number, c.rfid_number,
              r.first_name, r.last_name
       FROM checkins c
       LEFT JOIN riders r ON c.rider_id = r.id
       WHERE c.event_id = ? AND c.checked_in = 1`,
    )
    .all(eventId) as any[];

  const maxExistingMotoNumber = existingMotos
    .filter((m: any) => !deletedMotoIds.has(m.id))
    .reduce((max: number, m: any) => Math.max(max, m.moto_number ?? 0), 0);
  let motoNumber = maxExistingMotoNumber + 1;

  type CheckinRow = (typeof checkins)[0];

  function buildLineup(
    groupRiders: CheckinRow[],
    seedingOrder: number[],
  ): Array<Record<string, unknown>> {
    if (seedingOrder.length === 0) {
      return groupRiders.map((r: any, i: number) => ({
        position: i + 1,
        riderId: r.rider_id,
        riderName: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
        bibNumber: r.bib_number,
        rfidNumber: r.rfid_number,
      }));
    }
    return groupRiders.map((r: any, i: number) => ({
      position: i + 1,
      gate: seedingOrder[i] ?? null,
      riderId: r.rider_id,
      riderName: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
      bibNumber: r.bib_number,
      rfidNumber: r.rfid_number,
    }));
  }

  function sortRidersForClass(riders: CheckinRow[], cls: string): CheckinRow[] {
    if (seedingMethod === "registration_order") {
      return [...riders].sort((a: any, b: any) => {
        const ra =
          a.rider_id != null
            ? (registrationOrderByRider.get(a.rider_id) ?? Infinity)
            : Infinity;
        const rb =
          b.rider_id != null
            ? (registrationOrderByRider.get(b.rider_id) ?? Infinity)
            : Infinity;
        return ra - rb;
      });
    }
    if (seedingMethod === "practice_fastest_lap") {
      return [...riders].sort((a: any, b: any) => {
        const la =
          a.rider_id != null
            ? (bestLapByRider.get(a.rider_id) ?? Infinity)
            : Infinity;
        const lb =
          b.rider_id != null
            ? (bestLapByRider.get(b.rider_id) ?? Infinity)
            : Infinity;
        return la - lb;
      });
    }
    if (seedingMethod === "previous_round") {
      const classMap = prevRoundByClass.get(cls);
      return [...riders].sort((a: any, b: any) => {
        const da =
          a.rider_id != null ? classMap?.get(a.rider_id) : undefined;
        const db_ =
          b.rider_id != null ? classMap?.get(b.rider_id) : undefined;
        const posA = da?.position ?? Infinity;
        const posB = db_?.position ?? Infinity;
        if (posA !== posB) return posA - posB;
        const lapA = da?.bestLapMs ?? Infinity;
        const lapB = db_?.bestLapMs ?? Infinity;
        return lapA - lapB;
      });
    }
    if (seedingMethod === "series_points") {
      const classPoints = seriesPointsByClass.get(cls);
      const withPts = [...riders].filter(
        (r: any) => r.rider_id != null && (classPoints?.get(r.rider_id) ?? 0) > 0,
      );
      const noPts = [...riders].filter(
        (r: any) =>
          r.rider_id == null || (classPoints?.get(r.rider_id) ?? 0) === 0,
      );
      withPts.sort((a: any, b: any) => {
        const pa =
          a.rider_id != null ? (classPoints?.get(a.rider_id) ?? 0) : 0;
        const pb =
          b.rider_id != null ? (classPoints?.get(b.rider_id) ?? 0) : 0;
        return pb - pa;
      });
      for (let i = noPts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [noPts[i], noPts[j]] = [noPts[j], noPts[i]];
      }
      return [...withPts, ...noPts];
    }
    // random shuffle
    const arr = [...riders];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  type ClassEntry = { cls: string; groups: CheckinRow[][] };
  const allClassGroups: ClassEntry[] = [];

  for (const cls of classesToGenerate) {
    let classRiders = checkins.filter((c: any) => c.race_class === cls);
    if (classRiders.length === 0) continue;

    classRiders = sortRidersForClass(classRiders, cls);

    const numGroups =
      effectiveMax === Infinity
        ? 1
        : Math.ceil(classRiders.length / effectiveMax);
    const groups: CheckinRow[][] = Array.from({ length: numGroups }, () => []);

    const useSerp =
      (seedingMethod === "registration_order" ||
        seedingMethod === "practice_fastest_lap" ||
        seedingMethod === "previous_round" ||
        seedingMethod === "series_points") &&
      numGroups > 1;

    if (useSerp) {
      classRiders.forEach((rider: any, idx: number) => {
        const round = Math.floor(idx / numGroups);
        const posInRound = idx % numGroups;
        const groupIdx =
          round % 2 === 0 ? posInRound : numGroups - 1 - posInRound;
        groups[groupIdx].push(rider);
      });
    } else {
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

  const insertMoto = db.prepare(
    `INSERT INTO motos (event_id, name, type, race_class, moto_number, status, lineup, lap_count, created_at)
     VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, datetime('now'))`,
  );

  const insertedMotos: any[] = [];

  const generateTx = db.transaction(() => {
    if (isSupercrossFormat) {
      for (const { cls, groups } of allClassGroups) {
        const multiGroup = groups.length > 1;
        for (let h = 0; h < groups.length; h++) {
          const heatName = multiGroup ? `${cls} Heat ${h + 1}` : `${cls} Heat`;
          const lineup = buildLineup(groups[h], []);
          const r = insertMoto.run(
            eventId, heatName, "heat", cls,
            motoNumber++, JSON.stringify(lineup), motoLapCount,
          );
          insertedMotos.push(Number(r.lastInsertRowid));
        }
      }
      for (const { cls } of allClassGroups) {
        const r = insertMoto.run(
          eventId, `${cls} Main Event`, "main", cls,
          motoNumber++, "[]", motoLapCount,
        );
        insertedMotos.push(Number(r.lastInsertRowid));
      }
    } else {
      const roundsSetLocal =
        roundsFilter && (roundsFilter as number[]).length > 0
          ? new Set<number>(roundsFilter as number[])
          : null;

      type ScheduleTask = {
        cls: string;
        groupIdx: number;
        round: number;
        name: string;
        riders: CheckinRow[];
      };
      const tasks: ScheduleTask[] = [];

      for (let d = 1; d <= divCount; d++) {
        if (roundsSetLocal !== null && !roundsSetLocal.has(d)) continue;
        for (const { cls, groups } of allClassGroups) {
          const multiGroup = groups.length > 1;
          for (let h = 0; h < groups.length; h++) {
            const groupLabel = multiGroup ? ` Div ${h + 1}` : "";
            const motoLabel = divCount > 1 ? ` Moto ${d}` : " Moto";
            tasks.push({
              cls,
              groupIdx: h,
              round: d,
              name: `${cls}${groupLabel}${motoLabel}`,
              riders: groups[h],
            });
          }
        }
      }

      // Greedy multi-class spacing (minGap > 0)
      let orderedTasks = tasks;
      if (minGap > 0 && tasks.length > 1) {
        const riderTaskIndices = new Map<number, number[]>();
        for (let i = 0; i < tasks.length; i++) {
          for (const r of tasks[i].riders as any[]) {
            if (r.rider_id == null) continue;
            if (!riderTaskIndices.has(r.rider_id))
              riderTaskIndices.set(r.rider_id, []);
            riderTaskIndices.get(r.rider_id)!.push(i);
          }
        }
        const multiClassRiders = new Map<number, number[]>();
        for (const [rid, idxs] of riderTaskIndices) {
          if (idxs.length > 1) multiClassRiders.set(rid, idxs);
        }

        if (multiClassRiders.size > 0) {
          const remaining = new Set<number>(tasks.map((_, i) => i));
          const scheduled: number[] = [];
          const riderLastPos = new Map<number, number>();

          while (remaining.size > 0) {
            let bestIdx = -1;
            let bestViolations = Infinity;
            let bestMinGapForBest = -Infinity;
            const pos = scheduled.length;

            for (const taskIdx of remaining) {
              const task = tasks[taskIdx];
              let violations = 0;
              let worstGap = Infinity;

              for (const r of task.riders as any[]) {
                if (r.rider_id == null) continue;
                const lastPos = riderLastPos.get(r.rider_id);
                if (lastPos == null) continue;
                const gap = pos - lastPos;
                if (gap < minGap) violations++;
                worstGap = Math.min(worstGap, gap);
              }

              if (
                violations < bestViolations ||
                (violations === bestViolations && worstGap > bestMinGapForBest)
              ) {
                bestViolations = violations;
                bestMinGapForBest = worstGap;
                bestIdx = taskIdx;
              }
            }

            if (bestIdx === -1) bestIdx = [...remaining][0];
            scheduled.push(bestIdx);
            remaining.delete(bestIdx);

            for (const r of tasks[bestIdx].riders as any[]) {
              if (r.rider_id != null)
                riderLastPos.set(r.rider_id, pos);
            }
          }

          orderedTasks = scheduled.map((i) => tasks[i]);
        }
      }

      for (const task of orderedTasks) {
        const lineup = buildLineup(task.riders, []);
        const r = insertMoto.run(
          eventId, task.name, "moto", task.cls,
          motoNumber++, JSON.stringify(lineup), motoLapCount,
        );
        insertedMotos.push(Number(r.lastInsertRowid));
      }
    }
  });

  generateTx();

  const motos = insertedMotos
    .map((id) => db.prepare("SELECT * FROM motos WHERE id = ?").get(id) as any)
    .filter(Boolean);

  return res.json(motos.map(serializeMoto));
});

// POST /events/:eventId/motos/:motoId/generate-lineup — regenerate lineup for single moto
router.post("/events/:eventId/motos/:motoId/generate-lineup", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const eventId = Number(req.params.eventId);
  const motoId = Number(req.params.motoId);
  const { gatePickMethod = "random" } = req.body;

  const moto = db
    .prepare("SELECT * FROM motos WHERE id = ? AND event_id = ?")
    .get(motoId, eventId) as any;
  if (!moto) return res.status(404).json({ error: "Moto not found" });
  if (moto.status === "completed")
    return res.status(409).json({ error: "Moto is completed — lineup is locked" });
  if (!moto.race_class)
    return res.status(400).json({ error: "Moto has no race class" });

  const raceClass = moto.race_class as string;
  const seedingMethod: "random" | "practice_fastest_lap" | "previous_round" | "registration_order" =
    gatePickMethod === "practice"
      ? "practice_fastest_lap"
      : gatePickMethod === "prior_round_finish"
        ? "previous_round"
        : gatePickMethod === "first_registered"
          ? "registration_order"
          : "random";

  const checkins = db
    .prepare(
      `SELECT c.rider_id, c.race_class, c.bib_number, c.rfid_number,
              r.first_name, r.last_name
       FROM checkins c
       LEFT JOIN riders r ON c.rider_id = r.id
       WHERE c.event_id = ? AND c.race_class = ? AND c.checked_in = 1`,
    )
    .all(eventId, raceClass) as any[];

  let sorted = [...checkins];

  if (seedingMethod === "registration_order") {
    const regs = db
      .prepare(
        "SELECT rider_id, created_at FROM registrations WHERE event_id = ? ORDER BY created_at ASC",
      )
      .all(eventId) as any[];
    const order = new Map<number, number>();
    regs.forEach((r: any, i: number) => {
      if (r.rider_id != null) order.set(r.rider_id, i);
    });
    sorted.sort(
      (a: any, b: any) =>
        (order.get(a.rider_id) ?? Infinity) - (order.get(b.rider_id) ?? Infinity),
    );
  } else if (seedingMethod === "practice_fastest_lap") {
    const eventRow = db
      .prepare("SELECT club_id FROM events WHERE id = ?")
      .get(eventId) as any;
    let bestLap = new Map<number, number>();
    if (eventRow?.club_id) {
      const sessions = db
        .prepare("SELECT id FROM practice_sessions WHERE club_id = ?")
        .all(eventRow.club_id) as any[];
      if (sessions.length > 0) {
        const ph = sessions.map(() => "?").join(",");
        const rows = db
          .prepare(
            `SELECT rider_id, MIN(lap_time_ms) as best FROM practice_crossings
             WHERE session_id IN (${ph}) AND lap_time_ms > 0 GROUP BY rider_id`,
          )
          .all(...sessions.map((s: any) => s.id)) as any[];
        for (const r of rows) {
          if (r.rider_id != null && r.best != null)
            bestLap.set(r.rider_id, Number(r.best));
        }
      }
    }
    sorted.sort(
      (a: any, b: any) =>
        (bestLap.get(a.rider_id) ?? Infinity) -
        (bestLap.get(b.rider_id) ?? Infinity),
    );
  } else if (seedingMethod === "previous_round") {
    const completedMotos = db
      .prepare(
        "SELECT id FROM motos WHERE event_id = ? AND race_class = ? AND status = 'completed' AND type != 'practice'",
      )
      .all(eventId, raceClass) as any[];
    if (completedMotos.length > 0) {
      const ph = completedMotos.map(() => "?").join(",");
      const results = db
        .prepare(
          `SELECT rider_id, position, dnf, dns FROM race_results
           WHERE moto_id IN (${ph}) ORDER BY position ASC`,
        )
        .all(...completedMotos.map((m: any) => m.id)) as any[];
      const posMap = new Map<number, number>();
      for (const r of results) {
        const pos = r.dnf === 1 || r.dns === 1 ? 9999 : r.position;
        if (!posMap.has(r.rider_id) || pos < posMap.get(r.rider_id)!)
          posMap.set(r.rider_id, pos);
      }
      sorted.sort(
        (a: any, b: any) =>
          (posMap.get(a.rider_id) ?? Infinity) -
          (posMap.get(b.rider_id) ?? Infinity),
      );
    }
  } else {
    // random
    for (let i = sorted.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
    }
  }

  const lineup = sorted.map((r: any, i: number) => ({
    position: i + 1,
    riderId: r.rider_id,
    riderName: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
    bibNumber: r.bib_number,
    rfidNumber: r.rfid_number,
  }));

  db.prepare("UPDATE motos SET lineup = ? WHERE id = ?").run(
    JSON.stringify(lineup),
    motoId,
  );

  const updated = db.prepare("SELECT * FROM motos WHERE id = ?").get(motoId) as any;
  return res.json(serializeMoto(updated));
});

// POST /events/:eventId/generate-practice-sessions
router.post("/events/:eventId/generate-practice-sessions", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const eventId = Number(req.params.eventId);
  const {
    raceClass, raceClasses, maxRidersPerSession, timeLimitMs, scheduledTime,
    name: customName, lapCount, countdownSeconds, practiceMode,
  } = req.body;

  const targetClasses: string[] = Array.isArray(raceClasses) && raceClasses.length > 0
    ? raceClasses
    : raceClass ? [raceClass] : [];

  if (targetClasses.length === 0 || !maxRidersPerSession) {
    return res.status(400).json({ error: "raceClasses (or raceClass) and maxRidersPerSession required" });
  }

  const max = Number(maxRidersPerSession);
  if (isNaN(max) || max < 1) return res.status(400).json({ error: "maxRidersPerSession must be a positive integer" });

  const isAllClasses = targetClasses.includes("All Classes");

  const db = getDb();

  let checkinRows: any[];
  if (isAllClasses) {
    checkinRows = db.prepare(
      `SELECT c.rider_id, c.race_class, c.bib_number, c.rfid_number,
              r.first_name, r.last_name
       FROM checkins c LEFT JOIN riders r ON c.rider_id = r.id
       WHERE c.event_id = ? AND c.checked_in = 1`,
    ).all(eventId) as any[];
  } else {
    const placeholders = targetClasses.map(() => "?").join(", ");
    checkinRows = db.prepare(
      `SELECT c.rider_id, c.race_class, c.bib_number, c.rfid_number,
              r.first_name, r.last_name
       FROM checkins c LEFT JOIN riders r ON c.rider_id = r.id
       WHERE c.event_id = ? AND c.checked_in = 1 AND c.race_class IN (${placeholders})`,
    ).all(eventId, ...targetClasses) as any[];
  }

  if (checkinRows.length === 0) {
    return res.status(400).json({ error: "No checked-in riders found for the selected class(es)" });
  }

  const existingMotos = db.prepare(
    "SELECT moto_number FROM motos WHERE event_id = ?",
  ).all(eventId) as any[];
  const maxMotoNumber = existingMotos.reduce((mx: number, m: any) => Math.max(mx, m.moto_number ?? 0), 0);
  let nextMotoNumber = maxMotoNumber + 1;

  const sessionCount = Math.ceil(checkinRows.length / max);
  const created: any[] = [];

  const insert = db.prepare(
    `INSERT INTO motos
       (event_id, name, type, race_class, race_classes, moto_number, status,
        lineup, time_limit_ms, scheduled_time, lap_count, practice_mode, countdown_seconds, created_at)
     VALUES (?, ?, 'practice', ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );

  for (let i = 0; i < checkinRows.length; i += max) {
    const group = checkinRows.slice(i, i + max);
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

    const lineup = group.map((r: any, idx: number) => ({
      position: idx + 1,
      riderId: r.rider_id,
      riderName: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || `Rider #${r.rider_id}`,
      bibNumber: r.bib_number ?? null,
      rfidNumber: r.rfid_number ?? null,
    }));

    const result = insert.run(
      eventId,
      name,
      isAllClasses ? "" : targetClasses[0],
      isAllClasses ? null : JSON.stringify(targetClasses),
      nextMotoNumber++,
      JSON.stringify(lineup),
      timeLimitMs ? Number(timeLimitMs) : null,
      scheduledTime ?? null,
      lapCount ? Number(lapCount) : null,
      practiceMode ?? "lap_count",
      countdownSeconds ? Number(countdownSeconds) : null,
    );

    const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(result.lastInsertRowid) as any;
    created.push(serializeMoto(moto));
  }

  return res.status(201).json(created);
});

export default router;
