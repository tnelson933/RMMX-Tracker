/**
 * Stripe errors in plain language, with what to do about them. Raw Stripe
 * messages ("No such destination: 'acct_…'") never reach organizers or riders.
 */

/**
 * The club's saved Stripe account can't be used by RM Roost's Stripe account:
 * it was connected in the other mode (test vs live) or under other keys, or it
 * was deleted or disconnected. The fix is to connect Stripe again.
 */
export function isStripeAccountUnreachable(err: unknown): boolean {
  const e = err as { code?: string; type?: string; message?: string; raw?: { code?: string; message?: string } } | null;
  const message = `${e?.message ?? ""} ${e?.raw?.message ?? ""}`.toLowerCase();
  if (/no such (destination|account)/.test(message)) return true;
  if (/does not have access to account|account .* (is not|isn't) connected|not connected to your platform/.test(message)) return true;
  return e?.type === "StripePermissionError" && message.includes("acct_");
}

/** Organizer screens (check-in sales, charging an entry): say how to fix it. */
export const ORGANIZER_NO_STRIPE =
  "Card payments aren't set up for your club yet. Go to Payments and connect Stripe, or take cash for now.";
export const ORGANIZER_STRIPE_UNREACHABLE =
  "Card payments can't reach your club's Stripe account. Go to Payments and reconnect Stripe, or take cash for now.";

export function organizerCardError(err: unknown): string {
  return isStripeAccountUnreachable(err)
    ? ORGANIZER_STRIPE_UNREACHABLE
    : "Couldn't start the card payment. Try again in a moment, or take cash.";
}

/** Rider screens: riders can't fix the club's Stripe, so point them to the organizer. */
export function riderCardError(err: unknown, fallback: string): string {
  return isStripeAccountUnreachable(err)
    ? "This event can't take card payments right now. Please contact the event organizer, or pay at the gate if they allow it."
    : fallback;
}
