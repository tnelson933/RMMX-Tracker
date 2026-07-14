import { Router } from "express";
import { db } from "@workspace/db";
import { clubSettingsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

async function requireOrganizerForClub(
  req: any,
  res: any,
  clubId: number
): Promise<boolean> {
  const sessionUserId = (req.session as any)?.userId;
  if (!sessionUserId) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, sessionUserId));
  if (!user || user.role !== "club_organizer" || user.clubId !== clubId) {
    res.status(403).json({ error: "Forbidden" });
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

  const { riderAcknowledgement, waiverPdfUrl, defaultClasses, brandContingencies, trackName } = req.body;

  const values: { clubId: number; riderAcknowledgement?: string | null; waiverPdfUrl?: string | null; defaultClasses?: { id: string; name: string }[]; brandContingencies?: string[]; trackName?: string | null } = { clubId };
  if (riderAcknowledgement !== undefined) values.riderAcknowledgement = riderAcknowledgement ?? null;
  if (waiverPdfUrl !== undefined) values.waiverPdfUrl = waiverPdfUrl ?? null;
  if (defaultClasses !== undefined) values.defaultClasses = Array.isArray(defaultClasses) ? defaultClasses : [];
  if (brandContingencies !== undefined) values.brandContingencies = Array.isArray(brandContingencies) ? brandContingencies : [];
  if (trackName !== undefined) values.trackName = trackName ?? null;

  const [row] = await db
    .insert(clubSettingsTable)
    .values(values)
    .onConflictDoUpdate({
      target: clubSettingsTable.clubId,
      set: {
        ...(riderAcknowledgement !== undefined ? { riderAcknowledgement: values.riderAcknowledgement } : {}),
        ...(waiverPdfUrl !== undefined ? { waiverPdfUrl: values.waiverPdfUrl } : {}),
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
    defaultClasses: row.defaultClasses ?? [],
    brandContingencies: row.brandContingencies ?? [],
    trackName: row.trackName ?? null,
  });
});

export default router;
