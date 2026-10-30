import { Router } from "express";
import { db } from "@workspace/db";
import { clubSettingsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { checkAcknowledgement, checkBrands, checkDefaultClasses, checkPdfUrl, checkWaiverFields } from "../lib/clubSettingsInput";

const router = Router();

async function requireOrganizerForClub(
  req: any,
  res: any,
  clubId: number
): Promise<boolean> {
  const sessionUserId = (req.session as any)?.userId;
  if (!sessionUserId) {
    res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
    return false;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, sessionUserId));
  if (!user || user.role !== "club_organizer" || user.clubId !== clubId) {
    res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
    return false;
  }
  return true;
}

// GET /clubs/:clubId/settings
router.get("/clubs/:clubId/settings", async (req, res) => {
  const clubId = Number(req.params.clubId);
  const ok = await requireOrganizerForClub(req, res, clubId);
  if (!ok) return;

  const [row] = await db.select().from(clubSettingsTable).where(eq(clubSettingsTable.clubId, clubId));
  return res.json({
    clubId,
    riderAcknowledgement: row?.riderAcknowledgement ?? null,
    waiverPdfUrl: row?.waiverPdfUrl ?? null,
    liabilityWaiverText: row?.liabilityWaiverText ?? null,
    liabilityWaiverPdfUrl: row?.liabilityWaiverPdfUrl ?? null,
    liabilityWaiverFields: row?.liabilityWaiverFields ?? null,
    defaultClasses: row?.defaultClasses ?? [],
    brandContingencies: row?.brandContingencies ?? [],
    trackName: row?.trackName ?? null,
  });
});

// PUT /clubs/:clubId/settings
router.put("/clubs/:clubId/settings", async (req, res) => {
  const clubId = Number(req.params.clubId);
  const ok = await requireOrganizerForClub(req, res, clubId);
  if (!ok) return;

  const { riderAcknowledgement, waiverPdfUrl, liabilityWaiverText, liabilityWaiverPdfUrl, liabilityWaiverFields, defaultClasses, brandContingencies, trackName } = req.body;

  const values: any = { clubId };
  // Riders open the waiver links and read these texts at registration: check them first.
  const checks = [
    riderAcknowledgement !== undefined && ["riderAcknowledgement", checkAcknowledgement(riderAcknowledgement)],
    waiverPdfUrl !== undefined && ["waiverPdfUrl", checkPdfUrl(waiverPdfUrl, "acknowledgement form")],
    liabilityWaiverText !== undefined && ["liabilityWaiverText", checkAcknowledgement(liabilityWaiverText)],
    liabilityWaiverPdfUrl !== undefined && ["liabilityWaiverPdfUrl", checkPdfUrl(liabilityWaiverPdfUrl, "liability waiver")],
    liabilityWaiverFields !== undefined && ["liabilityWaiverFields", checkWaiverFields(liabilityWaiverFields)],
    defaultClasses !== undefined && ["defaultClasses", checkDefaultClasses(defaultClasses)],
    brandContingencies !== undefined && ["brandContingencies", checkBrands(brandContingencies)],
  ].filter(Boolean) as Array<[string, { ok: true; value: unknown } | { ok: false; error: string }]>;
  for (const [key, result] of checks) {
    if (!result.ok) return res.status(400).json({ error: result.error });
    values[key] = result.value;
  }
  if (trackName !== undefined) values.trackName = typeof trackName === "string" && trackName.trim() ? trackName.trim().slice(0, 120) : null;

  const [row] = await db
    .insert(clubSettingsTable)
    .values(values)
    .onConflictDoUpdate({
      target: clubSettingsTable.clubId,
      set: {
        ...(riderAcknowledgement !== undefined ? { riderAcknowledgement: values.riderAcknowledgement } : {}),
        ...(waiverPdfUrl !== undefined ? { waiverPdfUrl: values.waiverPdfUrl } : {}),
        ...(liabilityWaiverText !== undefined ? { liabilityWaiverText: values.liabilityWaiverText } : {}),
        ...(liabilityWaiverPdfUrl !== undefined ? { liabilityWaiverPdfUrl: values.liabilityWaiverPdfUrl } : {}),
        ...(liabilityWaiverFields !== undefined ? { liabilityWaiverFields: values.liabilityWaiverFields } : {}),
        ...(defaultClasses !== undefined ? { defaultClasses: values.defaultClasses } : {}),
        ...(brandContingencies !== undefined ? { brandContingencies: values.brandContingencies } : {}),
        ...(trackName !== undefined ? { trackName: values.trackName } : {}),
      },
    })
    .returning();

  return res.json({
    clubId: row.clubId,
    riderAcknowledgement: row.riderAcknowledgement ?? null,
    waiverPdfUrl: row.waiverPdfUrl ?? null,
    liabilityWaiverText: row.liabilityWaiverText ?? null,
    liabilityWaiverPdfUrl: row.liabilityWaiverPdfUrl ?? null,
    liabilityWaiverFields: row.liabilityWaiverFields ?? null,
    defaultClasses: row.defaultClasses ?? [],
    brandContingencies: row.brandContingencies ?? [],
    trackName: row.trackName ?? null,
  });
});

export default router;
