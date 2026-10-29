import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { logger } from "./lib/logger";

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
      if (event.type && PAID_CHECKOUT_EVENTS.has(event.type) && sessionId && event.data?.object?.object === "checkout.session") {
        // Re-read the session from Stripe rather than trusting the payload.
        const stripe = await getUncachableStripeClient();
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const { confirmRegistrationSession } = await import("./routes/registrations");
        const confirmed = await confirmRegistrationSession(session);
        if (confirmed.length) logger.info({ sessionId, entries: confirmed.length }, "Registration paid (Stripe webhook)");
      }
    } catch (err) {
      // The background payment check picks it up if this fails.
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Couldn't record checkout from webhook");
    }
  }
}
