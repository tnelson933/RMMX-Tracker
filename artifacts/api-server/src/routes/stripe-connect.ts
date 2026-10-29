import { Router } from "express";
import { db } from "@workspace/db";
import { clubsTable, usersTable, registrationsTable, eventsTable } from "@workspace/db";
import { and, eq, gt, isNotNull, isNull, ne } from "drizzle-orm";
import { getUncachableStripeClient } from "../stripeClient";

const router = Router();

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:80";
}

/** Setup is complete only when Stripe will both take card payments and pay the club out. */
function isOnboardingComplete(account: { charges_enabled?: boolean | null; payouts_enabled?: boolean | null }): boolean {
  return !!(account.charges_enabled && account.payouts_enabled);
}

/** Store Stripe's current setup state in either direction (it can be revoked too). */
async function syncOnboardingState(clubId: number, account: { charges_enabled?: boolean | null; payouts_enabled?: boolean | null }, stored: boolean): Promise<boolean> {
  const complete = isOnboardingComplete(account);
  if (complete !== stored) {
    await db.update(clubsTable).set({ stripeOnboardingComplete: complete }).where(eq(clubsTable.id, clubId));
  }
  return complete;
}

async function requireAuth(req: any, res: any): Promise<{ userId: number; clubId: number | null; role: string } | null> {
  const sessionUserId = (req.session as any).userId;
  if (!sessionUserId) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, sessionUserId));
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  return { userId: user.id, clubId: user.clubId, role: user.role };
}

/**
 * Connecting, disconnecting or opening the club's Stripe account changes where the
 * club's money goes, so it's for the club organizer (or a super admin), not staff
 * who only have the payments permission.
 */
async function requireOrganizer(req: any, res: any) {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (auth.role !== "club_organizer" && auth.role !== "super_admin") {
    res.status(403).json({ error: "Only the club organizer can change the club's Stripe connection." });
    return null;
  }
  return auth;
}

router.get("/stripe/connect/status", async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!auth.clubId) return res.json({ connected: false, onboardingComplete: false, accountId: null });

  const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, auth.clubId));
  if (!club) return res.json({ connected: false, onboardingComplete: false, accountId: null, email: null });

  let accountEmail: string | null = null;
  let onboardingComplete = club.stripeOnboardingComplete ?? false;

  if (club.stripeAccountId) {
    try {
      const stripe = await getUncachableStripeClient();
      const account = await stripe.accounts.retrieve(club.stripeAccountId);
      accountEmail = account.email ?? null;

      // Keep the stored state in step with Stripe, in both directions.
      onboardingComplete = await syncOnboardingState(auth.clubId, account, onboardingComplete);
    } catch {
      // non-fatal — email will just be null, onboardingComplete stays as-is
    }
  }

  return res.json({
    connected: !!club.stripeAccountId,
    onboardingComplete,
    accountId: club.stripeAccountId ?? null,
    email: accountEmail,
  });
});

// Public endpoint — no auth required — used by desktop local server to check
// real-time Stripe status without relying solely on the sync cycle.
router.get("/stripe/clubs/:clubId/status", async (req, res) => {
  const clubId = Number(req.params.clubId);
  if (isNaN(clubId) || clubId <= 0) return res.status(400).json({ error: "Invalid clubId" });

  const [club] = await db
    .select({
      stripeAccountId: clubsTable.stripeAccountId,
      stripeOnboardingComplete: clubsTable.stripeOnboardingComplete,
    })
    .from(clubsTable)
    .where(eq(clubsTable.id, clubId));

  if (!club) return res.json({ connected: false, onboardingComplete: false });

  return res.json({
    connected: !!club.stripeAccountId,
    onboardingComplete: club.stripeOnboardingComplete ?? false,
  });
});

router.post("/stripe/connect/start", async (req, res) => {
  const auth = await requireOrganizer(req, res);
  if (!auth) return;
  if (!auth.clubId) return res.status(400).json({ error: "No club associated with this account" });

  const appUrl = getAppUrl();

  try {
    const stripe = await getUncachableStripeClient();
    const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, auth.clubId));
    if (!club) return res.status(404).json({ error: "Club not found" });

    let accountId = club.stripeAccountId;

    const emailOverride = typeof req.body?.email === "string" && req.body.email.trim()
      ? req.body.email.trim()
      : undefined;

    if (!accountId) {
      // Two taps (or two organizers) at once must not create two Stripe accounts:
      // the idempotency key makes Stripe return the same account for this club
      // (for 24 hours), and only a club with no account yet gets one stored.
      const account = await stripe.accounts.create({
        type: "express",
        email: emailOverride ?? club.contactEmail ?? undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      }, { idempotencyKey: `club-${auth.clubId}-connect-account` });
      const [stored] = await db
        .update(clubsTable)
        .set({ stripeAccountId: account.id, stripeOnboardingComplete: false })
        .where(and(eq(clubsTable.id, auth.clubId), isNull(clubsTable.stripeAccountId)))
        .returning({ stripeAccountId: clubsTable.stripeAccountId });
      if (stored?.stripeAccountId) {
        accountId = stored.stripeAccountId;
      } else {
        const [current] = await db.select({ stripeAccountId: clubsTable.stripeAccountId })
          .from(clubsTable).where(eq(clubsTable.id, auth.clubId));
        accountId = current?.stripeAccountId ?? account.id;
      }
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${appUrl}/payments?refresh=1`,
      return_url: `${appUrl}/api/stripe/connect/return`,
      type: "account_onboarding",
    });

    return res.json({ url: accountLink.url });
  } catch (err: any) {
    req.log?.error({ err: err?.message, type: err?.type, code: err?.code }, "[stripe-connect] start failed");
    return res.status(500).json({ error: "Couldn't start Stripe setup right now. Please try again in a few minutes." });
  }
});

router.get("/stripe/connect/return", async (req, res) => {
  const sessionUserId = (req.session as any)?.userId;
  if (sessionUserId) {
    try {
      const [user] = await db.select().from(usersTable).where(eq(usersTable.id, sessionUserId));
      if (user?.clubId) {
        const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, user.clubId));
        if (club?.stripeAccountId) {
          const stripe = await getUncachableStripeClient();
          const account = await stripe.accounts.retrieve(club.stripeAccountId);
          await syncOnboardingState(user.clubId, account, club.stripeOnboardingComplete ?? false);
        }
      }
    } catch {
      // non-fatal — redirect anyway
    }
  }
  return res.redirect("/payments?connected=1");
});

router.get("/stripe/connect/dashboard-link", async (req, res) => {
  const auth = await requireOrganizer(req, res);
  if (!auth) return;
  if (!auth.clubId) return res.status(400).json({ error: "No club" });

  const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, auth.clubId));
  if (!club?.stripeAccountId) return res.status(400).json({ error: "No Stripe account connected" });

  try {
    const stripe = await getUncachableStripeClient();
    const loginLink = await stripe.accounts.createLoginLink(club.stripeAccountId);
    return res.json({ url: loginLink.url });
  } catch (err: any) {
    req.log?.error({ err: err?.message, type: err?.type, code: err?.code }, "[stripe-connect] dashboard link failed");
    return res.status(500).json({ error: "Couldn't open the Stripe dashboard. If setup isn't finished, finish it first." });
  }
});

router.delete("/stripe/connect", async (req, res) => {
  const auth = await requireOrganizer(req, res);
  if (!auth) return;
  if (!auth.clubId) return res.status(400).json({ error: "No club" });

  // A rider may be paying right now: their money would go to the old account
  // with nothing here to record it. Wait until open checkouts finish or expire.
  const [openCheckout] = await db.select({ id: registrationsTable.id })
    .from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .where(and(
      eq(eventsTable.clubId, auth.clubId),
      isNotNull(registrationsTable.stripeSessionId),
      eq(registrationsTable.paymentStatus, "unpaid"),
      ne(registrationsTable.status, "void"),
      gt(registrationsTable.createdAt, new Date(Date.now() - 24 * 60 * 60_000)),
    ))
    .limit(1);
  if (openCheckout) {
    return res.status(409).json({
      error: "A rider started a card payment in the last 24 hours that hasn't finished. You can disconnect once it's paid or has expired (checkouts expire within 24 hours).",
    });
  }

  await db
    .update(clubsTable)
    .set({ stripeAccountId: null, stripeOnboardingComplete: false })
    .where(eq(clubsTable.id, auth.clubId));
  return res.json({ ok: true });
});

export default router;
