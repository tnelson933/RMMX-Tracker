import type Stripe from "stripe";
import { db, clubsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Card payments without leaving RM Roost: Stripe Checkout embedded in our page
 * (online), or a Stripe Terminal card reader (in person at check-in). Both end
 * in a Stripe object the existing confirmation code reads the same way.
 */

/** Embedded checkout stays in our page (no redirect); hosted keeps success/cancel URLs (QR codes, the rider app). */
export function checkoutUiParams(embedded: boolean, urls: { success_url: string; cancel_url: string }) {
  return embedded
    ? { ui_mode: "embedded" as const, redirect_on_completion: "never" as const }
    : urls;
}

/** The shape the confirmation code reads, from a Checkout Session or a reader's PaymentIntent. */
export interface PaidLike {
  id: string;
  payment_status: string | null;
  amount_total: number | null;
  metadata: Record<string, string> | null;
}

export function paymentIntentAsPaid(pi: Stripe.PaymentIntent): PaidLike {
  return {
    id: pi.id,
    payment_status: pi.status === "succeeded" ? "paid" : "unpaid",
    amount_total: pi.amount_received || pi.amount,
    metadata: (pi.metadata ?? null) as Record<string, string> | null,
  };
}

/** A Checkout Session (cs_…) or a card-reader PaymentIntent (pi_…), read the same way. */
export async function retrievePayment(stripe: Stripe, id: string): Promise<PaidLike> {
  if (id.startsWith("pi_")) return paymentIntentAsPaid(await stripe.paymentIntents.retrieve(id));
  const s = await stripe.checkout.sessions.retrieve(id);
  return { id: s.id, payment_status: s.payment_status, amount_total: s.amount_total, metadata: (s.metadata ?? null) as Record<string, string> | null };
}

/** The club's Terminal location (readers are registered to it), if it has one. */
export async function clubTerminalLocation(clubId: number): Promise<string | null> {
  const [club] = await db.select({ location: clubsTable.stripeTerminalLocationId }).from(clubsTable).where(eq(clubsTable.id, clubId));
  return club?.location ?? null;
}

/** A reader belongs to the club when it's registered to the club's location. */
export async function clubReader(stripe: Stripe, clubId: number, readerId: string): Promise<Stripe.Terminal.Reader | null> {
  const location = await clubTerminalLocation(clubId);
  if (!location || !/^tmr_[A-Za-z0-9]+$/.test(readerId)) return null;
  try {
    const reader = await stripe.terminal.readers.retrieve(readerId);
    if ((reader as { deleted?: boolean }).deleted) return null;
    const r = reader as Stripe.Terminal.Reader;
    const readerLocation = typeof r.location === "string" ? r.location : r.location?.id;
    return readerLocation === location ? r : null;
  } catch {
    return null;
  }
}

/**
 * Charge on a club's card reader: a card-present PaymentIntent paid out to the
 * club (destination charge, like online payments), shown on the reader. The
 * rider taps, inserts or swipes; the caller polls or the webhook confirms.
 */
export async function chargeOnReader(stripe: Stripe, opts: {
  clubId: number;
  readerId: string;
  destination: string;
  amountCents: number;
  description: string;
  metadata: Record<string, string>;
}): Promise<{ ok: true; paymentIntentId: string } | { ok: false; error: string }> {
  const reader = await clubReader(stripe, opts.clubId, opts.readerId);
  if (!reader) return { ok: false, error: "That card reader isn't connected to your club. Pick another one, or add it on the Payments page." };
  if (reader.status !== "online") return { ok: false, error: `${reader.label || "The card reader"} is offline. Turn it on and connect it to Wi-Fi, then try again.` };
  const pi = await stripe.paymentIntents.create({
    amount: opts.amountCents,
    currency: "usd",
    payment_method_types: ["card_present"],
    capture_method: "automatic",
    description: opts.description.slice(0, 200),
    transfer_data: { destination: opts.destination },
    metadata: { ...opts.metadata, readerId: opts.readerId },
  });
  try {
    await stripe.terminal.readers.processPaymentIntent(opts.readerId, { payment_intent: pi.id });
  } catch (err) {
    await stripe.paymentIntents.cancel(pi.id).catch(() => {});
    const busy = (err as { code?: string })?.code === "terminal_reader_busy";
    return { ok: false, error: busy ? "That card reader is busy with another payment. Finish or cancel it there, then try again." : "Couldn't send the payment to the card reader. Check it's on and online, then try again." };
  }
  return { ok: true, paymentIntentId: pi.id };
}

/** Cancel what's on the reader (and the PaymentIntent) when staff back out. */
export async function cancelReaderCharge(stripe: Stripe, paymentIntentId: string): Promise<void> {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  const readerId = pi.metadata?.readerId;
  if (readerId) await stripe.terminal.readers.cancelAction(readerId).catch(() => {});
  if (pi.status !== "succeeded" && pi.status !== "canceled") await stripe.paymentIntents.cancel(pi.id).catch(() => {});
}
