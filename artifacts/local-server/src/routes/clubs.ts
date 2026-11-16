import { Router } from "express";
import { getDb } from "../db";
import { isoTime, parseJson } from "../lib/cloud-shape";
import { checkAcknowledgement, checkBrands, checkDefaultClasses, checkPdfUrl, checkWaiverFields } from "../lib/clubSettingsInput";

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
    // Payment account state as last pulled from the cloud (Stripe itself is online only).
    stripeAccountId: c.stripe_account_id ?? null,
    stripeOnboardingComplete: c.stripe_onboarding_complete === 1,
    stripeDirectCharges: c.stripe_direct_charges === 1,
    stripePendingAccountId: c.stripe_pending_account_id ?? null,
    stripeTerminalLocationId: c.stripe_terminal_location_id ?? null,
    autoDnfEnabled: c.auto_dnf_enabled === 1,
    autoDnfThreshold: c.auto_dnf_threshold ?? 75,
    active: c.active == null ? true : c.active === 1,
    timingIngestAuth: c.timing_ingest_auth ?? "off",
    createdAt: isoTime(c.created_at),
  };
}

/** The website's club settings JSON, from the copy pulled from the cloud. */
function clubSettingsJson(clubId: number) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM club_settings WHERE id = ?").get(clubId) as any;
  return {
    clubId,
    riderAcknowledgement: row?.rider_acknowledgement ?? null,
    waiverPdfUrl: row?.waiver_pdf_url ?? null,
    liabilityWaiverText: row?.liability_waiver_text ?? null,
    liabilityWaiverPdfUrl: row?.liability_waiver_pdf_url ?? null,
    liabilityWaiverFields: parseJson<unknown>(row?.liability_waiver_fields, null),
    defaultClasses: parseJson<unknown[]>(row?.default_classes, []) ?? [],
    brandContingencies: parseJson<unknown[]>(row?.brand_contingencies, []) ?? [],
    trackName: row?.track_name ?? null,
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
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const id = Number(req.params.clubId);
  const club = db.prepare("SELECT * FROM clubs WHERE id = ?").get(id) as any;
  if (!club) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  return res.json(serializeClub(club));
});

// GET /clubs  (returns the user's club)
router.get("/clubs", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const clubId = getUserClubId(session);
  if (!clubId) return res.json([]);

  const club = db.prepare("SELECT * FROM clubs WHERE id = ?").get(clubId) as any;
  if (!club) return res.json([]);
  // The club's organizer account, as the website lists it.
  const org = db
    .prepare("SELECT id, name, email, password_hash FROM users WHERE role = 'club_organizer' AND club_id = ? ORDER BY id LIMIT 1")
    .get(clubId) as any;
  return res.json([{
    ...serializeClub(club),
    organizer: org ? { id: org.id, name: org.name ?? "", email: org.email, hasPassword: !!org.password_hash } : null,
  }]);
});

// PATCH /clubs/:clubId
router.patch("/clubs/:clubId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

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
  if (!club) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  return res.json(serializeClub(club));
});

// GET /clubs/:clubId/settings
router.get("/clubs/:clubId/settings", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const id = Number(req.params.clubId);
  const club = db.prepare("SELECT id FROM clubs WHERE id = ?").get(id) as any;
  if (!club) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  return res.json(clubSettingsJson(id));
});

// PUT /clubs/:clubId/settings
router.put("/clubs/:clubId/settings", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const id = Number(req.params.clubId);

  const club = db.prepare("SELECT id FROM clubs WHERE id = ?").get(id) as any;
  if (!club) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });

  // Saved in club_settings (the table check-in and registration read, and the
  // one the sync sends to the website), one column per field sent.
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const columns: Record<string, unknown> = {};
  const b = req.body ?? {};
  // The website's checks and messages, in the website's order.
  const checks = [
    b.riderAcknowledgement !== undefined && checkAcknowledgement(b.riderAcknowledgement),
    b.waiverPdfUrl !== undefined && checkPdfUrl(b.waiverPdfUrl, "acknowledgement form"),
    b.liabilityWaiverText !== undefined && checkAcknowledgement(b.liabilityWaiverText),
    b.liabilityWaiverPdfUrl !== undefined && checkPdfUrl(b.liabilityWaiverPdfUrl, "liability waiver"),
    b.liabilityWaiverFields !== undefined && checkWaiverFields(b.liabilityWaiverFields),
    b.defaultClasses !== undefined && checkDefaultClasses(b.defaultClasses),
    b.brandContingencies !== undefined && checkBrands(b.brandContingencies),
  ];
  for (const result of checks) {
    if (result && !result.ok) return res.status(400).json({ error: result.error });
  }
  const checked = (i: number) => (checks[i] as { ok: true; value: unknown }).value;
  if (b.riderAcknowledgement !== undefined) columns.rider_acknowledgement = text(checked(0));
  if (b.waiverPdfUrl !== undefined) columns.waiver_pdf_url = text(checked(1));
  if (b.liabilityWaiverText !== undefined) columns.liability_waiver_text = text(checked(2));
  if (b.liabilityWaiverPdfUrl !== undefined) columns.liability_waiver_pdf_url = text(checked(3));
  if (b.liabilityWaiverFields !== undefined) columns.liability_waiver_fields = checked(4) == null ? null : JSON.stringify(checked(4));
  if (b.defaultClasses !== undefined) columns.default_classes = JSON.stringify(checked(5));
  if (b.brandContingencies !== undefined) columns.brand_contingencies = JSON.stringify(checked(6));
  if (b.trackName !== undefined) columns.track_name = typeof b.trackName === "string" && b.trackName.trim() ? b.trackName.trim().slice(0, 120) : null;

  db.prepare("INSERT OR IGNORE INTO club_settings (id, club_id) VALUES (?, ?)").run(id, id);
  const names = Object.keys(columns);
  if (names.length > 0) {
    db.prepare(`UPDATE club_settings SET ${names.map(n => `${n} = ?`).join(", ")} WHERE id = ?`)
      .run(...(Object.values(columns) as any[]), id);
  }
  return res.json(clubSettingsJson(id));
});

export default router;
