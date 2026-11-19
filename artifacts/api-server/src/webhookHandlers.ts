import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { logger } from "./lib/logger";
import { isRegistrationIntent, paymentIntentAsPaid, registrationClubStripe, type PaidLike } from "./lib/stripePayments";

const PAID_CHECKOUT_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error("Webhook payload must be a Buffer. Ensure webhook route is registered before express.json().");
    }
    const sync = await getStripeSync();
    // Verifies the signature (throws if it doesn't match) and syncs Stripe data.
    await sync.processWebhook(payload, signature);

    // A finished checkout pays for registrations even if the rider never got
    // back to the success page (closed the tab, lost signal).
    try {
      const event = JSON.parse(payload.toString("utf8")) as { type?: string; data?: { object?: { id?: string; object?: string } } };
      const sessionId = event.data?.object?.id;
      // Card-reader payments (Stripe Terminal) arrive as PaymentIntents.
      if (event.type === "payment_intent.succeeded" && sessionId && event.data?.object?.object === "payment_intent") {
        const stripe = await getUncachableStripeClient();
        const pi = paymentIntentAsPaid(await stripe.paymentIntents.retrieve(sessionId));
        if (isRegistrationIntent(pi)) {
          const { confirmRegistrationSession, confirmAddonSession } = await import("./routes/registrations");
          const confirmed = await confirmRegistrationSession(pi);
          if (confirmed.length) logger.info({ paymentIntentId: sessionId }, "Registration paid on card reader (Stripe webhook)");
          if (await confirmAddonSession(pi)) logger.info({ paymentIntentId: sessionId }, "Check-in add-on paid on card reader (Stripe webhook)");
        }
      }
      if (event.type && PAID_CHECKOUT_EVENTS.has(event.type) && sessionId && event.data?.object?.object === "checkout.session") {
        // Re-read the session from Stripe rather than trusting the payload.
        const stripe = await getUncachableStripeClient();
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const { confirmRegistrationSession, confirmAddonSession } = await import("./routes/registrations");
        const confirmed = await confirmRegistrationSession(session);
        if (confirmed.length) logger.info({ sessionId, entries: confirmed.length }, "Registration paid (Stripe webhook)");
        // Rentals and transponder or tag sales paid by card at check-in.
        if (await confirmAddonSession(session as any)) logger.info({ sessionId }, "Check-in add-on paid (Stripe webhook)");
      }
    } catch (err) {
      // The background payment check picks it up if this fails.
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Couldn't record checkout from webhook");
    }
  }
}

/**
 * Events from clubs' own Stripe accounts (direct charges): a separate Connect
 * webhook endpoint with its own signing secret (STRIPE_CONNECT_WEBHOOK_SECRET).
 * A payment counts only when it was made on the account of the club running
 * the registration's event, so no other connected account can mark entries paid.
 */
export async function processConnectWebhook(payload: Buffer, signature: string): Promise<void> {
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_CONNECT_WEBHOOK_SECRET is not set");
  const stripe = await getUncachableStripeClient();
  const event = stripe.webhooks.constructEvent(payload, signature, secret);
  const account = event.account;
  if (!account) return;
  const o = { stripeAccount: account };
  let paid: PaidLike | null = null;
  if (PAID_CHECKOUT_EVENTS.has(event.type)) {
    const s = await stripe.checkout.sessions.retrieve((event.data.object as { id: string }).id, undefined, o);
    paid = { id: s.id, payment_status: s.payment_status, amount_total: s.amount_total, metadata: (s.metadata ?? null) as Record<string, string> | null };
  } else if (event.type === "payment_intent.succeeded") {
    const pi = await stripe.paymentIntents.retrieve((event.data.object as { id: string }).id, undefined, o);
    // Website payments arrive as checkout.session.completed; card readers and the rider app's sheet as PaymentIntents.
    if (!isRegistrationIntent(pi)) return;
    paid = paymentIntentAsPaid(pi);
  }
  if (!paid || paid.payment_status !== "paid") return;

  const regIds = (paid.metadata?.registrationIds || paid.metadata?.registrationId || "").split(",").map(Number).filter(Boolean);
  for (const id of regIds) {
    const club = await registrationClubStripe(id);
    if (!club?.direct || club.accountId !== account) {
      logger.warn({ account, registrationId: id }, "Connect webhook: payment on an account that doesn't run this event; ignored");
      return;
    }
  }
  const { confirmRegistrationSession, confirmAddonSession } = await import("./routes/registrations");
  const confirmed = await confirmRegistrationSession(paid);
  if (confirmed.length) logger.info({ id: paid.id, entries: confirmed.length }, "Registration paid on the club's account (Stripe Connect webhook)");
  if (await confirmAddonSession(paid as any)) logger.info({ id: paid.id }, "Check-in add-on paid on the club's account (Stripe Connect webhook)");
}
