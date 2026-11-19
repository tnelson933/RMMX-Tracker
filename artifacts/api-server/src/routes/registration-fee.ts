import { Router } from "express";
import { db, clubsTable, usersTable, platformSettingsTable, registrationsTable, eventsTable } from "@workspace/db";
import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  REGISTRATION_FEE_KEY, MAX_REGISTRATION_FEE_CENTS, validFeeCents,
  defaultRegistrationFeeCents, clubRegistrationFeeCents,
  STRIPE_SWITCH_DEADLINE_KEY, validDeadline, stripeSwitchDeadline, clubSwitchStatus,
} from "../lib/stripePayments";

/**
 * RM Roost's flat fee per registration paid by card (see lib/stripePayments.ts).
 * Super admins set the RM Roost-wide fee and per-club overrides (Admin → Clubs);
 * organizers see what their club pays on the Payments page.
 */
const router = Router();

async function superAdminId(req: any, res: any): Promise<number | null> {
  const userId = (req.session as any)?.userId;
  if (!userId) { res.status(401).json({ error: "You're signed out. Sign in again, then try once more." }); return null; }
  const [user] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.id, userId));
  if (user?.role !== "super_admin") { res.status(403).json({ error: "Only RM Roost admins can change the registration fee." }); return null; }
  return userId;
}

const badFee = `Enter a fee from $0.00 to $${(MAX_REGISTRATION_FEE_CENTS / 100).toFixed(2)}.`;

// GET /admin/registration-fee: the RM Roost-wide fee and every club's override.
router.get("/admin/registration-fee", async (req, res) => {
  if (!(await superAdminId(req, res))) return;
  const clubs = await db.select({
    id: clubsTable.id, name: clubsTable.name, feeCents: clubsTable.registrationFeeCents,
    stripeAccountId: clubsTable.stripeAccountId, stripeDirectCharges: clubsTable.stripeDirectCharges,
  }).from(clubsTable).orderBy(asc(clubsTable.name));
  // Each club's entries at events in the last 12 months (by event date), to
  // judge which clubs need a higher fee to cover their hardware. Card-paid
  // entries are the ones the fee applies to; void entries don't count.
  const since = new Date(Date.now() - 365 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const counts = await db.select({
    clubId: eventsTable.clubId,
    entries: sql<number>`count(*)::int`,
    cardEntries: sql<number>`(count(*) filter (where ${registrationsTable.paymentMethod} = 'card' and ${registrationsTable.paymentStatus} in ('paid', 'refunded')))::int`,
  }).from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .where(and(ne(registrationsTable.status, "void"), gte(eventsTable.date, since)))
    .groupBy(eventsTable.clubId);
  const byClub = new Map(counts.map(c => [c.clubId, c]));
  res.json({
    defaultCents: await defaultRegistrationFeeCents(),
    maxCents: MAX_REGISTRATION_FEE_CENTS,
    switchDeadline: await stripeSwitchDeadline(),
    clubs: clubs.map(c => ({
      id: c.id, name: c.name, overrideCents: c.feeCents,
      entries12mo: byClub.get(c.id)?.entries ?? 0,
      cardEntries12mo: byClub.get(c.id)?.cardEntries ?? 0,
      // Still on an older Express connection: RM Roost pays its Stripe fees until it switches.
      mustSwitch: !!c.stripeAccountId && !c.stripeDirectCharges,
    })),
  });
});

// PUT /admin/registration-fee { cents }: the RM Roost-wide fee.
router.put("/admin/registration-fee", async (req, res) => {
  const adminId = await superAdminId(req, res);
  if (!adminId) return;
  const cents = validFeeCents(req.body?.cents);
  if (cents == null) return res.status(400).json({ error: badFee });
  await db.insert(platformSettingsTable)
    .values({ key: REGISTRATION_FEE_KEY, value: cents, updatedBy: adminId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettingsTable.key, set: { value: sql`excluded.value`, updatedBy: adminId, updatedAt: new Date() } });
  logger.info({ adminId, cents }, "Registration fee changed");
  return res.json({ defaultCents: cents });
});

// PUT /admin/stripe-switch-deadline { date: "YYYY-MM-DD" | null }: when clubs on an older
// Express connection must be on their own Stripe account to turn on card payments.
router.put("/admin/stripe-switch-deadline", async (req, res) => {
  const adminId = await superAdminId(req, res);
  if (!adminId) return;
  const raw = req.body?.date;
  if (raw === null || raw === "") {
    await db.delete(platformSettingsTable).where(eq(platformSettingsTable.key, STRIPE_SWITCH_DEADLINE_KEY));
    logger.info({ adminId }, "Stripe switch deadline cleared");
    return res.json({ switchDeadline: null });
  }
  const date = validDeadline(raw);
  if (!date) return res.status(400).json({ error: "Pick a deadline date." });
  await db.insert(platformSettingsTable)
    .values({ key: STRIPE_SWITCH_DEADLINE_KEY, value: date, updatedBy: adminId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettingsTable.key, set: { value: sql`excluded.value`, updatedBy: adminId, updatedAt: new Date() } });
  logger.info({ adminId, date }, "Stripe switch deadline set");
  return res.json({ switchDeadline: date });
});

// PUT /admin/clubs/:clubId/registration-fee { cents | null }: one club's override (null = RM Roost-wide fee).
router.put("/admin/clubs/:clubId/registration-fee", async (req, res) => {
  const adminId = await superAdminId(req, res);
  if (!adminId) return;
  const clubId = Number(req.params.clubId);
  const raw = req.body?.cents;
  const cents = raw === null || raw === "" ? null : validFeeCents(raw);
  if (raw !== null && raw !== "" && cents == null) return res.status(400).json({ error: badFee });
  const updated = await db.update(clubsTable).set({ registrationFeeCents: cents })
    .where(eq(clubsTable.id, clubId)).returning({ id: clubsTable.id });
  if (updated.length === 0) return res.status(404).json({ error: "That club couldn't be found. Refresh the page and try again." });
  logger.info({ adminId, clubId, cents }, "Club registration fee changed");
  return res.json({ id: clubId, overrideCents: cents });
});

// GET /stripe/registration-fee: what the caller's club pays per card registration, and
// whether it must switch to its own Stripe account (Payments page, organizer banner).
router.get("/stripe/registration-fee", async (_req, res) => {
  const clubId = res.locals.callerClubId as number | undefined;
  if (clubId == null) return res.json({ cents: null, mustSwitch: false, deadline: null, overdue: false });
  const { cents } = await clubRegistrationFeeCents(clubId);
  return res.json({ cents, ...(await clubSwitchStatus(clubId)) });
});

export default router;
