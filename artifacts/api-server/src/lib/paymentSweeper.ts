import { db } from "@workspace/db";
import { registrationsTable } from "@workspace/db";
import { and, desc, eq, gt, isNotNull, ne, sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Catches card payments neither the rider's browser nor Stripe's webhook
 * recorded: every couple of minutes, look up the checkout sessions of recent
 * unpaid entries and record the ones Stripe says are paid. Without this, a
 * rider who paid and closed the tab stays "unpaid" and is blocked at the gate.
 */

const SWEEP_MS = 2 * 60_000;
const LOOKBACK_MS = 3 * 24 * 60 * 60_000;
const MAX_SESSIONS_PER_SWEEP = 25;

export async function sweepPendingPayments(): Promise<number> {
  // Only entries still waiting for payment (never refunded or voided ones),
  // newest checkouts first so a backlog can't starve today's riders.
  const rows = await db
    .select({ sessionId: registrationsTable.stripeSessionId })
    .from(registrationsTable)
    .where(and(
      isNotNull(registrationsTable.stripeSessionId),
      eq(registrationsTable.paymentStatus, "unpaid"),
      ne(registrationsTable.status, "void"),
      gt(registrationsTable.createdAt, new Date(Date.now() - LOOKBACK_MS)),
    ))
    .groupBy(registrationsTable.stripeSessionId)
    .orderBy(desc(sql`max(${registrationsTable.createdAt})`))
    .limit(MAX_SESSIONS_PER_SWEEP);
  if (rows.length === 0) return 0;

  const { getUncachableStripeClient } = await import("../stripeClient");
  const { confirmRegistrationSession } = await import("../routes/registrations");
  const stripe = await getUncachableStripeClient();
  let confirmed = 0;
  for (const { sessionId } of rows) {
    if (!sessionId) continue;
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.status === "expired" && session.payment_status !== "paid") {
        // An expired checkout can never be paid: stop sweeping it. The entry stays
        // unpaid (pay at the gate, or start a new checkout).
        await db.update(registrationsTable)
          .set({ stripeSessionId: null })
          .where(and(
            eq(registrationsTable.stripeSessionId, sessionId),
            eq(registrationsTable.paymentStatus, "unpaid"),
          ));
        continue;
      }
      if (session.payment_status !== "paid") continue;
      const regs = await confirmRegistrationSession(session);
      if (regs.length) {
        confirmed += regs.length;
        logger.info({ sessionId, entries: regs.length }, "Registration paid (background payment check)");
      }
    } catch (err) {
      logger.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, "Payment check failed for a session");
    }
  }
  return confirmed;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startPaymentSweeper(): void {
  if (timer) return;
  timer = setInterval(() => { sweepPendingPayments().catch(() => {}); }, SWEEP_MS);
  timer.unref?.();
}
