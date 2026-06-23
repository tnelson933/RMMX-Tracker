import { Router } from "express";
import { getDb } from "../db";

const router = Router();

function serializeClub(c: any) {
  return {
    id: c.id,
    name: c.name,
    state: c.state ?? null,
    contactEmail: c.contact_email ?? null,
    contactPhone: c.contact_phone ?? null,
    logoUrl: c.logo_url ?? null,
    website: c.website ?? null,
    description: c.description ?? null,
    autoDnfEnabled: c.auto_dnf_enabled === 1,
    autoDnfThreshold: c.auto_dnf_threshold ?? 75,
    createdAt: c.created_at,
  };
}

function getUserClubId(session: any): number | null {
  const db = getDb();
  const user = db
    .prepare("SELECT club_id FROM users WHERE id = ?")
    .get(session.userId) as any;
  return user?.club_id ?? null;
}

// GET /clubs/:clubId
router.get("/clubs/:clubId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const id = Number(req.params.clubId);
  const club = db.prepare("SELECT * FROM clubs WHERE id = ?").get(id) as any;
  if (!club) return res.status(404).json({ error: "Not found" });
  return res.json(serializeClub(club));
});

// GET /clubs  (returns the user's club)
router.get("/clubs", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const clubId = getUserClubId(session);
  if (!clubId) return res.json([]);

  const club = db.prepare("SELECT * FROM clubs WHERE id = ?").get(clubId) as any;
  if (!club) return res.json([]);
  return res.json([serializeClub(club)]);
});

// PATCH /clubs/:clubId
router.patch("/clubs/:clubId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const id = Number(req.params.clubId);

  const fieldMap: Record<string, string> = {
    name: "name",
    state: "state",
    contactEmail: "contact_email",
    contactPhone: "contact_phone",
    logoUrl: "logo_url",
    website: "website",
    description: "description",
  };

  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
    if (req.body[jsKey] !== undefined) {
      fields.push(`${dbCol} = ?`);
      values.push(req.body[jsKey]);
    }
  }

  if (req.body.autoDnfEnabled !== undefined) {
    fields.push("auto_dnf_enabled = ?");
    values.push(req.body.autoDnfEnabled ? 1 : 0);
  }
  if (req.body.autoDnfThreshold !== undefined) {
    fields.push("auto_dnf_threshold = ?");
    values.push(Math.min(100, Math.max(1, Number(req.body.autoDnfThreshold))));
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  values.push(id);
  db.prepare(`UPDATE clubs SET ${fields.join(", ")} WHERE id = ?`).run(
    ...(values as any[]),
  );

  const club = db.prepare("SELECT * FROM clubs WHERE id = ?").get(id) as any;
  if (!club) return res.status(404).json({ error: "Not found" });
  return res.json(serializeClub(club));
});

// GET /clubs/:clubId/settings
router.get("/clubs/:clubId/settings", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const id = Number(req.params.clubId);
  const club = db
    .prepare("SELECT id, rider_acknowledgement, default_classes, track_name FROM clubs WHERE id = ?")
    .get(id) as any;
  if (!club) return res.status(404).json({ error: "Not found" });

  let defaultClasses: unknown[] = [];
  try { defaultClasses = JSON.parse(club.default_classes ?? "[]"); } catch { /* ignore */ }

  return res.json({
    clubId: club.id,
    riderAcknowledgement: club.rider_acknowledgement ?? null,
    defaultClasses,
    trackName: club.track_name ?? null,
  });
});

// PUT /clubs/:clubId/settings
router.put("/clubs/:clubId/settings", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const id = Number(req.params.clubId);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (req.body.riderAcknowledgement !== undefined) {
    fields.push("rider_acknowledgement = ?");
    values.push(req.body.riderAcknowledgement ?? null);
  }
  if (req.body.defaultClasses !== undefined) {
    fields.push("default_classes = ?");
    values.push(JSON.stringify(Array.isArray(req.body.defaultClasses) ? req.body.defaultClasses : []));
  }
  if (req.body.trackName !== undefined) {
    fields.push("track_name = ?");
    values.push(req.body.trackName ?? null);
  }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE clubs SET ${fields.join(", ")} WHERE id = ?`).run(...(values as any[]));
  }

  const club = db
    .prepare("SELECT id, rider_acknowledgement, default_classes, track_name FROM clubs WHERE id = ?")
    .get(id) as any;
  if (!club) return res.status(404).json({ error: "Not found" });

  let defaultClasses: unknown[] = [];
  try { defaultClasses = JSON.parse(club.default_classes ?? "[]"); } catch { /* ignore */ }

  return res.json({
    clubId: club.id,
    riderAcknowledgement: club.rider_acknowledgement ?? null,
    defaultClasses,
    trackName: club.track_name ?? null,
  });
});

export default router;
