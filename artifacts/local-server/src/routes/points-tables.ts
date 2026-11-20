import { Router } from "express";
import { getDb } from "../db";
import { evaluateFormula } from "../lib/safeFormula";
import { newDesktopId } from "../lib/desktop-ids";
import { isoTime } from "../lib/cloud-shape";
import { rescoreEvents } from "./results";

const router = Router();

function serializeTable(t: any) {
  return {
    id: t.id,
    clubId: t.club_id ?? null,
    name: t.name,
    description: t.description ?? "",
    scoringMethod: t.scoring_method ?? "highest_points",
    mainEventOnly: t.main_event_only === 1,
    pointsScale: (() => { try { return JSON.parse(t.points_scale || "[]"); } catch { return []; } })(),
    scoringFormula: t.scoring_formula ?? null,
    isSystemDefault: t.is_system_default === 1,
    autoDnfEnabled: t.auto_dnf_enabled === 1,
    autoDnfThreshold: t.auto_dnf_threshold ?? 75,
    createdAt: isoTime(t.created_at),
  };
}

function getUserClubId(session: any): number | null {
  const db = getDb();
  const user = db
    .prepare("SELECT club_id FROM users WHERE id = ?")
    .get(session.userId) as any;
  return user?.club_id ?? null;
}

// GET /points-tables
router.get("/points-tables", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const clubId = getUserClubId(session);

  const tables = db
    .prepare(
      `SELECT * FROM points_tables
       WHERE club_id IS NULL ${clubId ? "OR club_id = ?" : ""}
       ORDER BY is_system_default ASC, julianday(created_at) ASC, id ASC`,
    )
    .all(...(clubId ? [clubId] : [])) as any[];

  return res.json(tables.map(serializeTable));
});

/** Same checks as the cloud: a known method, whole-number points, a formula that evaluates. */
function tableInputError(body: any): string | null {
  const methods = ["highest_points", "lowest_positions", "per_rider", "formula"];
  if (body.scoringMethod !== undefined && !methods.includes(body.scoringMethod)) {
    return `scoringMethod must be one of: ${methods.join(", ")}`;
  }
  if (body.pointsScale !== undefined) {
    const scale = body.pointsScale;
    if (!Array.isArray(scale)) return "pointsScale must be a list of points";
    if (scale.length > 200) return "pointsScale can list at most 200 positions";
    if (!scale.every((v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100_000)) {
      return "Points must be whole numbers of 0 or more";
    }
  }
  if (body.scoringFormula != null && body.scoringFormula !== "" && typeof body.scoringFormula !== "string") return "scoringFormula must be a string";
  if (body.scoringFormula) {
    try {
      evaluateFormula(String(body.scoringFormula), { position: 1, riders: 10 });
    } catch (err) {
      return `Invalid scoring formula: ${(err as Error).message}. Use position, riders, numbers, + - * / % **, comparisons, ?:, and Math functions.`;
    }
  }
  return null;
}

// POST /points-tables
router.post("/points-tables", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const clubId = getUserClubId(session);
  if (!clubId) return res.status(403).json({ error: "Your account isn't linked to a club yet. Ask your club's owner to add you on the Team page." });

  const {
    name, description, scoringMethod, mainEventOnly,
    pointsScale, scoringFormula, autoDnfEnabled, autoDnfThreshold,
  } = req.body;

  if (!name || !scoringMethod || !Array.isArray(pointsScale)) {
    return res.status(400).json({ error: "Enter a name, choose a scoring method, and fill in the points." });
  }
  const invalid = tableInputError(req.body);
  if (invalid) return res.status(400).json({ error: invalid });

  const result = db
    .prepare(
      `INSERT INTO points_tables
         (id, club_id, name, description, scoring_method, main_event_only,
          points_scale, scoring_formula, is_system_default,
          auto_dnf_enabled, auto_dnf_threshold, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, datetime('now'))`,
    )
    .run(
      newDesktopId(db, "points_tables"), clubId, String(name), description ?? "",
      String(scoringMethod), mainEventOnly ? 1 : 0,
      JSON.stringify(pointsScale), scoringFormula ?? null,
      autoDnfEnabled ? 1 : 0,
      autoDnfThreshold != null ? Number(autoDnfThreshold) : 75,
    );

  const row = db
    .prepare("SELECT * FROM points_tables WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as any;
  return res.status(201).json(serializeTable(row));
});

// PATCH /points-tables/:tableId
router.patch("/points-tables/:tableId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const id = Number(req.params.tableId);
  const existing = db.prepare("SELECT is_system_default, club_id FROM points_tables WHERE id = ?").get(id) as any;
  if (!existing) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  if (existing.is_system_default === 1) return res.status(403).json({ error: "Built-in scoring tables can't be edited. Make a copy, then edit the copy." });
  if (existing.club_id !== getUserClubId(session)) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
  const invalid = tableInputError(req.body);
  if (invalid) return res.status(400).json({ error: invalid });

  const fields: string[] = [];
  const values: unknown[] = [];

  if (req.body.name !== undefined) { fields.push("name = ?"); values.push(String(req.body.name)); }
  if (req.body.description !== undefined) { fields.push("description = ?"); values.push(String(req.body.description)); }
  if (req.body.scoringMethod !== undefined) { fields.push("scoring_method = ?"); values.push(String(req.body.scoringMethod)); }
  if (req.body.mainEventOnly !== undefined) { fields.push("main_event_only = ?"); values.push(req.body.mainEventOnly ? 1 : 0); }
  if (req.body.pointsScale !== undefined) { fields.push("points_scale = ?"); values.push(JSON.stringify(req.body.pointsScale)); }
  if (req.body.scoringFormula !== undefined) { fields.push("scoring_formula = ?"); values.push(req.body.scoringFormula ?? null); }
  if (req.body.autoDnfEnabled !== undefined) { fields.push("auto_dnf_enabled = ?"); values.push(req.body.autoDnfEnabled ? 1 : 0); }
  if (req.body.autoDnfThreshold !== undefined) { fields.push("auto_dnf_threshold = ?"); values.push(Number(req.body.autoDnfThreshold)); }

  if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });

  values.push(id);
  db.prepare(`UPDATE points_tables SET ${fields.join(", ")} WHERE id = ?`).run(...(values as any[]));

  // Saving a table in use re-scores the finished races of every event using it, as on the website.
  const scoringChanged = ["scoringMethod", "mainEventOnly", "pointsScale", "scoringFormula", "autoDnfEnabled", "autoDnfThreshold"]
    .some(k => req.body[k] !== undefined);
  if (scoringChanged) {
    const users = db.prepare("SELECT id FROM events WHERE scoring_table_id = ?").all(id) as Array<{ id: number }>;
    rescoreEvents(users.map(e => e.id));
  }

  const row = db.prepare("SELECT * FROM points_tables WHERE id = ?").get(id) as any;
  if (!row) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  return res.json(serializeTable(row));
});

// DELETE /points-tables/:tableId
router.delete("/points-tables/:tableId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const id = Number(req.params.tableId);
  const row = db.prepare("SELECT is_system_default, club_id FROM points_tables WHERE id = ?").get(id) as any;
  if (!row) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  if (row.is_system_default === 1) return res.status(403).json({ error: "Built-in scoring tables can't be deleted." });
  if (row.club_id !== getUserClubId(session)) return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });

  // The website's checks and messages: named series first, then named events.
  const seriesUsing = db.prepare("SELECT name FROM series WHERE scoring_table_id = ?").all(id) as Array<{ name: string }>;
  if (seriesUsing.length > 0) {
    const names = seriesUsing.map(s => `"${s.name}"`).join(", ");
    return res.status(409).json({
      error: `This scoring table is used by ${seriesUsing.length === 1 ? "a series" : "series"}: ${names}. Remove it from ${seriesUsing.length === 1 ? "that series" : "those series"} before deleting.`,
    });
  }
  const eventsUsing = db.prepare("SELECT name FROM events WHERE scoring_table_id = ?").all(id) as Array<{ name: string }>;
  if (eventsUsing.length > 0) {
    const names = eventsUsing.map(e => `"${e.name}"`).join(", ");
    return res.status(409).json({
      error: `This scoring table is used by ${eventsUsing.length === 1 ? "an event" : "events"}: ${names}. Remove it from ${eventsUsing.length === 1 ? "that event" : "those events"} before deleting.`,
    });
  }

  db.prepare("DELETE FROM points_tables WHERE id = ?").run(id);
  return res.status(204).send();
});

export default router;
