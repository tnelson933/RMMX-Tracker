import { Router } from "express";
import { db } from "@workspace/db";
import { clubsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getUncachableStripeClient } from "../stripeClient";

const router = Router();

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:80";
}

async function requireAuth(req: any, res: any): Promise<{ userId: number; clubId: number | null } | null> {
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
  return { userId: user.id, clubId: user.clubId };
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

      // Auto-sync: if Stripe says charges are enabled but our DB doesn't know yet, update it.
      const stripeReady = account.charges_enabled || account.details_submitted;
      if (stripeReady && !onboardingComplete) {
        await db
          .update(clubsTable)
          .set({ stripeOnboardingComplete: true })
          .where(eq(clubsTable.id, auth.clubId!));
        onboardingComplete = true;
      }
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

router.post("/stripe/connect/start", async (req, res) => {
  const auth = await requireAuth(req, res);
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
      const account = await stripe.accounts.create({
        type: "express",
        email: emailOverride ?? club.contactEmail ?? undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });
      accountId = account.id;
      await db
        .update(clubsTable)
        .set({ stripeAccountId: accountId, stripeOnboardingComplete: false })
        .where(eq(clubsTable.id, auth.clubId));
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${appUrl}/payments?refresh=1`,
      return_url: `${appUrl}/api/stripe/connect/return`,
      type: "account_onboarding",
    });

    return res.json({ url: accountLink.url });
  } catch (err: any) {
    req.log?.error({ err: err?.message }, "[stripe-connect] start failed");
    return res.status(500).json({ error: err?.message ?? "Failed to start Stripe Connect" });
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
          if (account.charges_enabled) {
            await db
              .update(clubsTable)
              .set({ stripeOnboardingComplete: true })
              .where(eq(clubsTable.id, user.clubId));
          }
        }
      }
    } catch {
      // non-fatal — redirect anyway
    }
  }
  return res.redirect("/payments?connected=1");
});

router.get("/stripe/connect/dashboard-link", async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!auth.clubId) return res.status(400).json({ error: "No club" });

  const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, auth.clubId));
  if (!club?.stripeAccountId) return res.status(400).json({ error: "No Stripe account connected" });

  try {
    const stripe = await getUncachableStripeClient();
    const loginLink = await stripe.accounts.createLoginLink(club.stripeAccountId);
    return res.json({ url: loginLink.url });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to generate dashboard link" });
  }
});

router.delete("/stripe/connect", async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!auth.clubId) return res.status(400).json({ error: "No club" });

  await db
    .update(clubsTable)
    .set({ stripeAccountId: null, stripeOnboardingComplete: false })
    .where(eq(clubsTable.id, auth.clubId));
  return res.json({ ok: true });
});

export default router;
