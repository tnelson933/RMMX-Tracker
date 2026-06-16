import { Router } from "express";
import { getDb } from "../db";

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
    createdAt: t.created_at,
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
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const clubId = getUserClubId(session);

  const tables = db
    .prepare(
      `SELECT * FROM points_tables
       WHERE club_id IS NULL ${clubId ? "OR club_id = ?" : ""}
       ORDER BY is_system_default DESC, created_at ASC`,
    )
    .all(...(clubId ? [clubId] : [])) as any[];

  return res.json(tables.map(serializeTable));
});

// POST /points-tables
router.post("/points-tables", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const clubId = getUserClubId(session);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const {
    name, description, scoringMethod, mainEventOnly,
    pointsScale, scoringFormula, autoDnfEnabled, autoDnfThreshold,
  } = req.body;

  if (!name || !scoringMethod || !Array.isArray(pointsScale)) {
    return res.status(400).json({ error: "name, scoringMethod, and pointsScale are required" });
  }

  const result = db
    .prepare(
      `INSERT INTO points_tables
         (club_id, name, description, scoring_method, main_event_only,
          points_scale, scoring_formula, is_system_default,
          auto_dnf_enabled, auto_dnf_threshold, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, datetime('now'))`,
    )
    .run(
      clubId, String(name), description ?? "",
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
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const id = Number(req.params.tableId);

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

  const row = db.prepare("SELECT * FROM points_tables WHERE id = ?").get(id) as any;
  if (!row) return res.status(404).json({ error: "Not found" });
  return res.json(serializeTable(row));
});

// DELETE /points-tables/:tableId
router.delete("/points-tables/:tableId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const id = Number(req.params.tableId);
  const row = db.prepare("SELECT is_system_default FROM points_tables WHERE id = ?").get(id) as any;
  if (!row) return res.status(404).json({ error: "Not found" });
  if (row.is_system_default === 1) return res.status(409).json({ error: "Cannot delete system default table" });

  db.prepare("DELETE FROM points_tables WHERE id = ?").run(id);
  return res.status(204).send();
});

export default router;
