import { Router } from "express";
import { db, clubsTable, eventsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getStripePublishableKey, getUncachableStripeClient } from "../stripeClient";
import { cancelReaderCharge, clubStripe, clubTerminalLocation, onClub, type ClubStripe } from "../lib/stripePayments";
import { checkStatesCode } from "../lib/cardReaderInput";

/**
 * Stripe card readers (Stripe Terminal smart readers such as the WisePOS E or
 * S700) for in-person card payments at check-in, and the publishable key the
 * website needs to show Stripe's payment form in its own page.
 *
 * Readers live on the club's own Stripe account (clubs on Standard accounts;
 * older Express clubs switch first), registered to one Terminal location per
 * club, so reader payments go straight to the club. Payments page: add (by the code the reader shows), rename, remove.
 * Check-in: list the club's readers, cancel a charge, and in test mode tap a
 * simulated card.
 */
const router = Router();

// GET /stripe/config — public: what the browser needs to load Stripe's form.
router.get("/stripe/config", async (_req, res) => {
  const publishableKey = await getStripePublishableKey().catch(() => "");
  return res.json({ publishableKey: publishableKey || null, testMode: publishableKey.startsWith("pk_test_") });
});

async function clubFor(req: any, res: any): Promise<number | null> {
  const staffClubId = res.locals?.staffClubId;
  if (typeof staffClubId === "number") return staffClubId;
  const userId = req.session?.userId;
  if (!userId) { res.status(401).json({ error: "You're signed out. Sign in again, then try once more." }); return null; }
  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  if (!user?.clubId) { res.status(400).json({ error: "Your account isn't linked to a club." }); return null; }
  return user.clubId;
}

function readerView(r: any) {
  return {
    id: r.id as string,
    label: (r.label as string) || "Card reader",
    deviceType: r.device_type as string,
    status: (r.status as string) === "online" ? "online" : "offline",
    serialNumber: (r.serial_number as string) ?? null,
    simulated: String(r.device_type ?? "").startsWith("simulated") || String(r.serial_number ?? "").startsWith("simulated"),
  };
}

/** The club's Stripe account when it can use card readers (its own Standard account). */
async function readerAccount(clubId: number): Promise<ClubStripe | null> {
  const c = await clubStripe(clubId);
  return c?.direct ? c : null;
}

async function listClubReaders(clubId: number) {
  const [location, c] = await Promise.all([clubTerminalLocation(clubId), readerAccount(clubId)]);
  if (!location || !c) return [];
  const stripe = await getUncachableStripeClient();
  const readers = await stripe.terminal.readers.list({ location, limit: 100 }, onClub(c));
  return readers.data.map(readerView);
}

// GET /stripe/connect/readers — the club's readers (Payments page)
router.get("/stripe/connect/readers", async (req, res) => {
  const clubId = await clubFor(req, res);
  if (clubId == null) return;
  try {
    return res.json(await listClubReaders(clubId));
  } catch (err: any) {
    req.log?.error({ err: err?.message }, "[card-readers] list failed");
    return res.status(502).json({ error: "Couldn't load your card readers from Stripe. Try again in a minute." });
  }
});

// POST /stripe/connect/readers — add a reader by the registration code it shows
router.post("/stripe/connect/readers", async (req, res) => {
  const clubId = await clubFor(req, res);
  if (clubId == null) return;
  const code = typeof req.body?.registrationCode === "string" ? req.body.registrationCode.trim() : "";
  const label = typeof req.body?.label === "string" && req.body.label.trim() ? req.body.label.trim().slice(0, 60) : "Card reader";
  if (!code) return res.status(400).json({ error: "Enter the code shown on the reader (Settings → Generate pairing code)." });

  const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, clubId));
  if (!club?.stripeAccountId) return res.status(400).json({ error: "Connect Stripe first (above), then add card readers." });
  const c = await readerAccount(clubId);
  if (!c) return res.status(400).json({ error: "Card readers need your club on its own Stripe account. Use \"Switch to your own Stripe account\" above first." });

  try {
    const stripe = await getUncachableStripeClient();
    let location = club.stripeTerminalLocationId;
    if (!location) {
      // Stripe needs an address for the location (the reader's home base).
      const a = req.body?.address ?? {};
      const address = {
        line1: String(a.line1 ?? "").trim(),
        city: String(a.city ?? "").trim(),
        state: String(a.state ?? club.state ?? "").trim().toUpperCase(),
        postal_code: String(a.postalCode ?? "").trim(),
        country: "US",
      };
      if (!address.line1 || !address.city || !address.postal_code || !checkStatesCode(address.state)) {
        return res.status(400).json({ error: "Enter your club's street address, city, state and ZIP. Stripe needs it for your first card reader.", needsAddress: true });
      }
      const created = await stripe.terminal.locations.create({
        display_name: club.name.slice(0, 100),
        address,
        metadata: { clubId: String(clubId) },
      }, { idempotencyKey: `club-${clubId}-${c.accountId}-terminal-location`, stripeAccount: c.accountId });
      const [stored] = await db.update(clubsTable).set({ stripeTerminalLocationId: created.id })
        .where(eq(clubsTable.id, clubId)).returning({ location: clubsTable.stripeTerminalLocationId });
      location = stored?.location ?? created.id;
    }
    const reader = await stripe.terminal.readers.create({ registration_code: code, label, location, metadata: { clubId: String(clubId) } }, onClub(c));
    return res.status(201).json(readerView(reader));
  } catch (err: any) {
    req.log?.error({ err: err?.message, code: err?.code }, "[card-readers] add failed");
    const badCode = err?.code === "resource_missing" || /registration code/i.test(err?.message ?? "");
    return res.status(400).json({
      error: badCode
        ? "That code didn't match a reader. On the reader, open Settings → Generate pairing code, and enter the new code within a few minutes."
        : "Couldn't add the reader. Check it's online and the code is current, then try again.",
    });
  }
});

// PATCH /stripe/connect/readers/:id — rename
router.patch("/stripe/connect/readers/:id", async (req, res) => {
  const clubId = await clubFor(req, res);
  if (clubId == null) return;
  const label = typeof req.body?.label === "string" ? req.body.label.trim().slice(0, 60) : "";
  if (!label) return res.status(400).json({ error: "Enter a name for the reader." });
  const readers = await listClubReaders(clubId).catch(() => []);
  if (!readers.some(r => r.id === req.params.id)) return res.status(404).json({ error: "That reader isn't connected to your club." });
  const stripe = await getUncachableStripeClient();
  const updated = await stripe.terminal.readers.update(req.params.id, { label }, onClub((await readerAccount(clubId))!));
  return res.json(readerView(updated));
});

// DELETE /stripe/connect/readers/:id — remove from the club
router.delete("/stripe/connect/readers/:id", async (req, res) => {
  const clubId = await clubFor(req, res);
  if (clubId == null) return;
  const readers = await listClubReaders(clubId).catch(() => []);
  if (!readers.some(r => r.id === req.params.id)) return res.status(404).json({ error: "That reader isn't connected to your club." });
  const stripe = await getUncachableStripeClient();
  await stripe.terminal.readers.del(req.params.id, undefined, onClub((await readerAccount(clubId))!));
  return res.json({ ok: true });
});

/** The event's club, checked against the caller's. */
async function eventClub(req: any, res: any): Promise<number | null> {
  const clubId = await clubFor(req, res);
  if (clubId == null) return null;
  const [event] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, Number(req.params.eventId)));
  if (!event || event.clubId !== clubId) { res.status(404).json({ error: "That event wasn't found." }); return null; }
  return clubId;
}

// GET /events/:eventId/card-readers — check-in: the club's readers to charge on
router.get("/events/:eventId/card-readers", async (req, res) => {
  const clubId = await eventClub(req, res);
  if (clubId == null) return;
  try {
    return res.json(await listClubReaders(clubId));
  } catch {
    return res.json([]);
  }
});

/** A reader payment for this club's event (its metadata names the event). */
async function clubPayment(req: any, res: any) {
  const clubId = await eventClub(req, res);
  if (clubId == null) return null;
  const id = String(req.params.paymentIntentId);
  if (!/^pi_[A-Za-z0-9]+$/.test(id)) { res.status(400).json({ error: "That payment wasn't found." }); return null; }
  const c = await readerAccount(clubId);
  if (!c) { res.status(404).json({ error: "That payment wasn't found." }); return null; }
  const stripe = await getUncachableStripeClient();
  const pi = await stripe.paymentIntents.retrieve(id, undefined, onClub(c)).catch(() => null);
  if (!pi || pi.metadata?.eventId !== String(req.params.eventId) || !pi.metadata?.readerId) {
    res.status(404).json({ error: "That payment wasn't found." });
    return null;
  }
  return { stripe, pi, c };
}

// POST /events/:eventId/reader-payments/:paymentIntentId/cancel — staff backed out
router.post("/events/:eventId/reader-payments/:paymentIntentId/cancel", async (req, res) => {
  const found = await clubPayment(req, res);
  if (!found) return;
  if (found.pi.status === "succeeded") return res.status(409).json({ error: "That payment already went through." });
  await cancelReaderCharge(found.stripe, found.c, found.pi.id);
  return res.json({ ok: true });
});

// POST /events/:eventId/reader-payments/:paymentIntentId/simulate — test mode: tap a test card on a simulated reader
router.post("/events/:eventId/reader-payments/:paymentIntentId/simulate", async (req, res) => {
  const found = await clubPayment(req, res);
  if (!found) return;
  if (found.pi.livemode) return res.status(400).json({ error: "Simulated taps only work in Stripe test mode." });
  await found.stripe.testHelpers.terminal.readers.presentPaymentMethod(found.pi.metadata.readerId, undefined, onClub(found.c));
  return res.json({ ok: true });
});

export default router;
