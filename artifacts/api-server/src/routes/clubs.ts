import { Router } from "express";
import crypto from "crypto";
import { db } from "@workspace/db";
import { clubsTable, usersTable, passwordSetupTokensTable, practiceSessionsTable, practiceCrossingsTable, discountCategoriesTable, eventsTable, seriesTable, compCodesTable, pointsTablesTable, clubSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendSetupEmail } from "../lib/email";

const router = Router();

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:80";
}

async function requireAdmin(req: any, res: any, next: any) {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user || user.role !== "super_admin") return res.status(403).json({ error: "Forbidden: super_admin only" });
  next();
}

router.get("/clubs", async (req, res) => {
  const staffCId: number | null = typeof (res as any).locals?.staffClubId === "number" ? (res as any).locals.staffClubId : null;

  let clubs;
  if (staffCId !== null) {
    clubs = await db.select().from(clubsTable).where(eq(clubsTable.id, staffCId));
  } else {
    clubs = await db.select().from(clubsTable).orderBy(clubsTable.name);
  }

  // Fetch all club_organizer users and map by clubId
  const organizers = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      passwordHash: usersTable.passwordHash,
      clubId: usersTable.clubId,
    })
    .from(usersTable)
    .where(eq(usersTable.role, "club_organizer"));

  // Use Map — only keep the first organizer per club
  const organizerByClub = new Map<number, typeof organizers[0]>();
  for (const o of organizers) {
    if (o.clubId !== null && !organizerByClub.has(o.clubId)) {
      organizerByClub.set(o.clubId, o);
    }
  }

  return res.json(
    clubs.map((c) => {
      const org = organizerByClub.get(c.id);
      return {
        ...c,
        createdAt: c.createdAt.toISOString(),
        organizer: org
          ? { id: org.id, name: org.name, email: org.email, hasPassword: !!org.passwordHash }
          : null,
      };
    })
  );
});

router.post("/clubs", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const { name, state, contactEmail, contactPhone, logoUrl, website, description, organizerName, organizerEmail } = req.body;
  if (!name || !state) return res.status(400).json({ error: "name and state required" });
  if (!organizerName || !organizerEmail) return res.status(400).json({ error: "organizerName and organizerEmail are required" });

  const [club] = await db
    .insert(clubsTable)
    .values({ name, state, contactEmail, contactPhone, logoUrl, website, description })
    .returning();

  // Seed the built-in "Entry Fees" category for every new club
  await db.insert(discountCategoriesTable).values({ clubId: club.id, name: "Entry Fees" }).onConflictDoNothing();

  // Create organizer user if provided
  let organizer: { id: number; name: string; email: string; hasPassword: boolean } | null = null;
  let emailSent = false;
  let setupUrl: string | undefined;

  if (organizerName && organizerEmail) {
    const trimmedEmail = String(organizerEmail).toLowerCase().trim();
    const existing = await db.select().from(usersTable).where(eq(usersTable.email, trimmedEmail));

    if (!existing[0]) {
      const [newUser] = await db
        .insert(usersTable)
        .values({
          email: trimmedEmail,
          name: String(organizerName),
          role: "club_organizer",
          clubId: club.id,
          passwordHash: null,
        })
        .returning();

      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
      await db.insert(passwordSetupTokensTable).values({ userId: newUser.id, token, expiresAt });

      const emailResult = await sendSetupEmail({
        to: newUser.email,
        name: newUser.name,
        token,
        appUrl: getAppUrl(),
        isNew: true,
      });

      emailSent = emailResult.ok;
      setupUrl = (emailResult as any).setupUrl ?? `${getAppUrl()}/setup-account?token=${token}`;
      organizer = { id: newUser.id, name: newUser.name, email: newUser.email, hasPassword: false };
    }
  }

  return res.status(201).json({
    ...club,
    createdAt: club.createdAt.toISOString(),
    organizer,
    emailSent,
    setupUrl,
  });
});

router.get("/clubs/:clubId", async (req, res) => {
  const id = Number(req.params.clubId);
  const staffCId: number | null = typeof (res as any).locals?.staffClubId === "number" ? (res as any).locals.staffClubId : null;
  if (staffCId !== null && staffCId !== id) return res.status(403).json({ error: "Forbidden" });
  const clubs = await db.select().from(clubsTable).where(eq(clubsTable.id, id));
  if (!clubs[0]) return res.status(404).json({ error: "Not found" });
  const c = clubs[0];
  return res.json({ ...c, createdAt: c.createdAt.toISOString() });
});

router.delete("/clubs/:clubId", requireAdmin, async (req, res) => {
  const id = Number(req.params.clubId);
  const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, id));
  if (!club) return res.status(404).json({ error: "Not found" });

  // Block deletion if the club has any events — too much cascading data
  const events = await db.select({ id: eventsTable.id }).from(eventsTable).where(eq(eventsTable.clubId, id));
  if (events.length > 0) {
    return res.status(409).json({
      error: "CLUB_HAS_EVENTS",
      message: `Cannot delete "${club.name}" — it has ${events.length} event(s). Deactivate the club instead.`,
    });
  }

  // Clean up supporting records in dependency order
  const userIds = (await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.clubId, id))).map(u => u.id);
  if (userIds.length > 0) {
    for (const uid of userIds) {
      await db.delete(passwordSetupTokensTable).where(eq(passwordSetupTokensTable.userId, uid));
    }
    await db.delete(usersTable).where(eq(usersTable.clubId, id));
  }
  await db.delete(practiceSessionsTable).where(eq(practiceSessionsTable.clubId, id));
  await db.delete(discountCategoriesTable).where(eq(discountCategoriesTable.clubId, id));
  await db.delete(seriesTable).where(eq(seriesTable.clubId, id));
  await db.delete(compCodesTable).where(eq(compCodesTable.clubId, id));
  await db.delete(pointsTablesTable).where(eq(pointsTablesTable.clubId, id));
  await db.delete(clubSettingsTable).where(eq(clubSettingsTable.clubId, id));
  await db.delete(clubsTable).where(eq(clubsTable.id, id));

  return res.status(204).send();
});

router.patch("/clubs/:clubId", async (req, res) => {
  const id = Number(req.params.clubId);
  const staffCId: number | null = typeof (res as any).locals?.staffClubId === "number" ? (res as any).locals.staffClubId : null;
  if (staffCId !== null && staffCId !== id) return res.status(403).json({ error: "Forbidden" });
  if (!req.session || !(req.session as any).userId) return res.status(401).json({ error: "Unauthorized" });

  const { name, state, contactEmail, contactPhone, logoUrl, website, description, autoDnfEnabled, autoDnfThreshold, active, organizerName, organizerEmail } = req.body;
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (state !== undefined) updates.state = state;
  if (contactEmail !== undefined) updates.contactEmail = contactEmail;
  if (contactPhone !== undefined) updates.contactPhone = contactPhone;
  if (logoUrl !== undefined) updates.logoUrl = logoUrl;
  if (website !== undefined) updates.website = website;
  if (description !== undefined) updates.description = description;
  if (autoDnfEnabled !== undefined) updates.autoDnfEnabled = !!autoDnfEnabled;
  if (autoDnfThreshold !== undefined) updates.autoDnfThreshold = Math.min(100, Math.max(1, Number(autoDnfThreshold)));

  // super_admin role check — do a real DB lookup (sessionUser is not pre-populated)
  const sessionUserId = (req.session as any).userId;
  const [sessionUser] = await db.select().from(usersTable).where(eq(usersTable.id, sessionUserId));
  if (active !== undefined && sessionUser?.role === "super_admin") updates.active = !!active;

  const [updated] = await db.update(clubsTable).set(updates as any).where(eq(clubsTable.id, id)).returning();
  if (!updated) return res.status(404).json({ error: "Not found" });

  // Add organizer if none exists yet and fields were provided
  let organizer: { id: number; name: string; email: string; hasPassword: boolean } | null = null;
  let emailSent = false;
  let setupUrl: string | undefined;

  if (organizerName && organizerEmail) {
    const existingOrg = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.clubId, id));

    if (existingOrg.length === 0) {
      const trimmedEmail = String(organizerEmail).toLowerCase().trim();
      const emailTaken = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, trimmedEmail));
      if (!emailTaken[0]) {
        const [newUser] = await db
          .insert(usersTable)
          .values({ email: trimmedEmail, name: String(organizerName), role: "club_organizer", clubId: id, passwordHash: null })
          .returning();
        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
        await db.insert(passwordSetupTokensTable).values({ userId: newUser.id, token, expiresAt });
        const emailResult = await sendSetupEmail({ to: newUser.email, name: newUser.name, token, appUrl: getAppUrl(), isNew: true });
        emailSent = emailResult.ok;
        setupUrl = (emailResult as any).setupUrl ?? `${getAppUrl()}/setup-account?token=${token}`;
        organizer = { id: newUser.id, name: newUser.name, email: newUser.email, hasPassword: false };
      }
    }
  }

  return res.json({ ...updated, createdAt: updated.createdAt.toISOString(), organizer, emailSent, setupUrl });
});

export default router;
