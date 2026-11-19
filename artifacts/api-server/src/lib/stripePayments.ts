import type Stripe from "stripe";
import { db, clubsTable, eventsTable, registrationsTable, platformSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Card payments without leaving RM Roost: Stripe Checkout embedded in our page
 * (online), or a Stripe Terminal card reader (in person at check-in). Both end
 * in a Stripe object the existing confirmation code reads the same way.
 *
 * Where the money goes: a club on its own Stripe (Standard) account is charged
 * directly on that account (`stripeAccount` on every call), so RM Roost's
 * account takes no money, fees or losses. A club still on an older Express
 * account is charged on RM Roost's account and transferred, as before, until
 * it switches on the Payments page.
 */

/** `metadata.source` of a registration paid in the rider app's Stripe payment sheet (a PaymentIntent). */
export const RIDER_APP_PAYMENT = "rider_app";

/** PaymentIntents the registration code confirms: card readers and the rider app's payment sheet. */
export function isRegistrationIntent(pi: { metadata?: Record<string, string> | null }): boolean {
  return !!pi.metadata?.readerId || pi.metadata?.source === RIDER_APP_PAYMENT;
}

/** A club's Stripe account and how it's charged. */
export interface ClubStripe {
  accountId: string;
  /** True: charges are made on the club's own account. False: older Express, through RM Roost's account. */
  direct: boolean;
}

export function clubStripeOf(club: { stripeAccountId: string | null; stripeDirectCharges?: boolean | null }): ClubStripe | null {
  return club.stripeAccountId ? { accountId: club.stripeAccountId, direct: !!club.stripeDirectCharges } : null;
}

export async function clubStripe(clubId: number): Promise<ClubStripe | null> {
  const [club] = await db.select({ stripeAccountId: clubsTable.stripeAccountId, stripeDirectCharges: clubsTable.stripeDirectCharges })
    .from(clubsTable).where(eq(clubsTable.id, clubId));
  return club ? clubStripeOf(club) : null;
}

/** The Stripe account of the club running a registration's event. */
export async function registrationClubStripe(registrationId: number): Promise<ClubStripe | null> {
  const [row] = await db.select({ stripeAccountId: clubsTable.stripeAccountId, stripeDirectCharges: clubsTable.stripeDirectCharges })
    .from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .innerJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id))
    .where(eq(registrationsTable.id, registrationId));
  return row ? clubStripeOf(row) : null;
}

/** Request options: direct-charge clubs' calls run on their own account. */
export function onClub(c: ClubStripe): Stripe.RequestOptions | undefined {
  return c.direct ? { stripeAccount: c.accountId } : undefined;
}

/** Older Express clubs: paid through RM Roost's account and transferred. Direct clubs: nothing to add. */
export function transferTo(c: ClubStripe): { transfer_data?: { destination: string } } {
  return c.direct ? {} : { transfer_data: { destination: c.accountId } };
}

// ── RM Roost's registration fee ─────────────────────────────────────────────
//
// A flat "Service fee" per registration (class entry) paid by card, added to
// the rider's checkout on top of the entry and sent to RM Roost as a Stripe
// application fee. The club receives the entry (less Stripe's processing fee,
// as before). Refunds keep it (Stripe only returns an application fee when
// asked to). Cash, comp and free entries have no card charge, so no fee.

export const REGISTRATION_FEE_KEY = "registration_fee_cents";
/** Highest fee a super admin can set, so a typo can't take a club's whole entry. */
export const MAX_REGISTRATION_FEE_CENTS = 2_000;

export function validFeeCents(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_REGISTRATION_FEE_CENTS ? n : null;
}

/** The RM Roost-wide fee per registration, in cents (0 when never set). */
export async function defaultRegistrationFeeCents(): Promise<number> {
  const [row] = await db.select({ value: platformSettingsTable.value }).from(platformSettingsTable)
    .where(eq(platformSettingsTable.key, REGISTRATION_FEE_KEY));
  return validFeeCents(row?.value) ?? 0;
}

/** The fee per registration a club pays: its own override, else the RM Roost-wide fee. */
export async function clubRegistrationFeeCents(clubId: number): Promise<{ cents: number; override: boolean }> {
  const [club] = await db.select({ fee: clubsTable.registrationFeeCents }).from(clubsTable).where(eq(clubsTable.id, clubId));
  const own = validFeeCents(club?.fee);
  if (own != null) return { cents: own, override: true };
  return { cents: await defaultRegistrationFeeCents(), override: false };
}

/**
 * The service fee on one card charge: per registration (class entry) paid in
 * it. Added on top of the entry, so the rider pays it and the club's share is
 * unchanged. 0 when nothing in it is a paid entry.
 */
export function registrationFeeFor(paidRegistrations: number, perRegistrationCents: number): number {
  if (paidRegistrations <= 0 || perRegistrationCents <= 0) return 0;
  return paidRegistrations * perRegistrationCents;
}

/** Name of the checkout line riders see for RM Roost's fee. */
export const SERVICE_FEE_LABEL = "Service fee";

/** The Stripe Checkout line item for the service fee (one per paid entry). */
export function serviceFeeLineItem(perRegistrationCents: number, paidRegistrations: number) {
  return {
    price_data: { currency: "usd", product_data: { name: SERVICE_FEE_LABEL }, unit_amount: perRegistrationCents },
    quantity: paidRegistrations,
  };
}

/** Stripe params for the fee on a PaymentIntent (or a Checkout Session's payment_intent_data). */
export function applicationFee(cents: number): { application_fee_amount?: number } {
  return cents > 0 ? { application_fee_amount: cents } : {};
}

/** The service fee for a charge covering `paidRegistrations` entries of a club's event: per entry and total. */
export async function serviceFeeForCharge(clubId: number, paidRegistrations: number): Promise<{ perEntryCents: number; totalCents: number; entries: number }> {
  if (paidRegistrations <= 0) return { perEntryCents: 0, totalCents: 0, entries: 0 };
  const { cents } = await clubRegistrationFeeCents(clubId);
  return { perEntryCents: cents, totalCents: registrationFeeFor(paidRegistrations, cents), entries: cents > 0 ? paidRegistrations : 0 };
}

// ── Required switch to the club's own Stripe account ────────────────────────
//
// Clubs still on an older Express connection are paid through RM Roost's
// account, so RM Roost pays their Stripe fees and their money passes through
// RM Roost. A super admin sets a deadline (platform_settings); until then
// those clubs see a banner, and after it they can't turn on card payments for
// an event until they switch on the Payments page. Events that already take
// card payments keep working, so no rider is stuck mid-registration.

export const STRIPE_SWITCH_DEADLINE_KEY = "stripe_switch_deadline";

/** A YYYY-MM-DD date, or null. */
export function validDeadline(v: unknown): string | null {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

export async function stripeSwitchDeadline(): Promise<string | null> {
  const [row] = await db.select({ value: platformSettingsTable.value }).from(platformSettingsTable)
    .where(eq(platformSettingsTable.key, STRIPE_SWITCH_DEADLINE_KEY));
  return validDeadline(row?.value);
}

/** Past the deadline: the day after it, in UTC (the deadline day itself still counts). */
export function deadlinePassed(deadline: string | null, now = new Date()): boolean {
  return !!deadline && now.toISOString().slice(0, 10) > deadline;
}

export interface SwitchStatus {
  /** The club is on an older Express connection and must move to its own Stripe account. */
  mustSwitch: boolean;
  deadline: string | null;
  overdue: boolean;
}

export async function clubSwitchStatus(clubId: number): Promise<SwitchStatus> {
  const [club] = await db.select({ stripeAccountId: clubsTable.stripeAccountId, stripeDirectCharges: clubsTable.stripeDirectCharges })
    .from(clubsTable).where(eq(clubsTable.id, clubId));
  const mustSwitch = !!club?.stripeAccountId && !club.stripeDirectCharges;
  const deadline = mustSwitch ? await stripeSwitchDeadline() : null;
  return { mustSwitch, deadline, overdue: mustSwitch && deadlinePassed(deadline) };
}

/** Why the club can't turn on card payments for an event right now, or null. */
export async function cardPaymentsBlocked(clubId: number): Promise<string | null> {
  const s = await clubSwitchStatus(clubId);
  if (!s.overdue) return null;
  return "Your club needs to switch to its own Stripe account before turning on card payments. Open Payments and press Switch account; it takes a few minutes.";
}

/** The account the browser's Stripe form must load for (only direct-charge clubs). */
export function browserAccount(c: ClubStripe): string | null {
  return c.direct ? c.accountId : null;
}

/** The in-page form works only with the publishable key set; without it, Stripe's page is used (nobody gets stuck). */
export async function embeddedAllowed(requested: boolean): Promise<boolean> {
  if (!requested) return false;
  const { getStripePublishableKey } = await import("../stripeClient");
  return !!(await getStripePublishableKey().catch(() => ""));
}

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

function isMissing(err: unknown): boolean {
  return (err as { code?: string })?.code === "resource_missing";
}

/**
 * Look a payment up where it lives: on the club's own account when the club
 * is direct-charge, else (and for payments taken before it switched) on RM
 * Roost's account.
 */
export async function onClubOrPlatform<T>(c: ClubStripe | null, call: (opts?: Stripe.RequestOptions) => Promise<T>): Promise<T> {
  if (c?.direct) {
    try {
      return await call({ stripeAccount: c.accountId });
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  return call(undefined);
}

/** A Checkout Session (cs_…) or a card-reader PaymentIntent (pi_…), read the same way. */
export async function retrievePayment(stripe: Stripe, id: string, club: ClubStripe | null = null): Promise<PaidLike> {
  if (id.startsWith("pi_")) {
    return paymentIntentAsPaid(await onClubOrPlatform(club, o => stripe.paymentIntents.retrieve(id, undefined, o)));
  }
  const s = await onClubOrPlatform(club, o => stripe.checkout.sessions.retrieve(id, undefined, o));
  return { id: s.id, payment_status: s.payment_status, amount_total: s.amount_total, metadata: (s.metadata ?? null) as Record<string, string> | null };
}

/** The club's Terminal location (readers are registered to it), if it has one. */
export async function clubTerminalLocation(clubId: number): Promise<string | null> {
  const [club] = await db.select({ location: clubsTable.stripeTerminalLocationId }).from(clubsTable).where(eq(clubsTable.id, clubId));
  return club?.location ?? null;
}

/** A reader belongs to the club when it's registered to the club's location (on the club's own account). */
export async function clubReader(stripe: Stripe, clubId: number, c: ClubStripe, readerId: string): Promise<Stripe.Terminal.Reader | null> {
  const location = await clubTerminalLocation(clubId);
  if (!c.direct || !location || !/^tmr_[A-Za-z0-9]+$/.test(readerId)) return null;
  try {
    const reader = await stripe.terminal.readers.retrieve(readerId, undefined, onClub(c));
    if ((reader as { deleted?: boolean }).deleted) return null;
    const r = reader as Stripe.Terminal.Reader;
    const readerLocation = typeof r.location === "string" ? r.location : r.location?.id;
    return readerLocation === location ? r : null;
  } catch {
    return null;
  }
}

/**
 * Charge on a club's card reader: a card-present PaymentIntent on the club's
 * own Stripe account, shown on the reader. The rider taps, inserts or swipes;
 * the caller polls or the webhook confirms. Card readers need the club on its
 * own (Standard) account.
 */
export async function chargeOnReader(stripe: Stripe, opts: {
  clubId: number;
  club: ClubStripe;
  readerId: string;
  amountCents: number;
  description: string;
  metadata: Record<string, string>;
  /** RM Roost's registration fee on this charge, in cents (registrations only). */
  applicationFeeCents?: number;
}): Promise<{ ok: true; paymentIntentId: string } | { ok: false; error: string }> {
  if (!opts.club.direct) return { ok: false, error: "Card readers need your club on its own Stripe account. Switch on the Payments page first." };
  const reader = await clubReader(stripe, opts.clubId, opts.club, opts.readerId);
  if (!reader) return { ok: false, error: "That card reader isn't connected to your club. Pick another one, or add it on the Payments page." };
  if (reader.status !== "online") return { ok: false, error: `${reader.label || "The card reader"} is offline. Turn it on and connect it to Wi-Fi, then try again.` };
  const o = onClub(opts.club);
  const pi = await stripe.paymentIntents.create({
    amount: opts.amountCents,
    currency: "usd",
    payment_method_types: ["card_present"],
    capture_method: "automatic",
    ...applicationFee(opts.applicationFeeCents ?? 0),
    description: opts.description.slice(0, 200),
    metadata: { ...opts.metadata, readerId: opts.readerId },
  }, o);
  try {
    await stripe.terminal.readers.processPaymentIntent(opts.readerId, { payment_intent: pi.id }, o);
  } catch (err) {
    await stripe.paymentIntents.cancel(pi.id, undefined, o).catch(() => {});
    const busy = (err as { code?: string })?.code === "terminal_reader_busy";
    return { ok: false, error: busy ? "That card reader is busy with another payment. Finish or cancel it there, then try again." : "Couldn't send the payment to the card reader. Check it's on and online, then try again." };
  }
  return { ok: true, paymentIntentId: pi.id };
}

/** Cancel what's on the reader (and the PaymentIntent) when staff back out. */
export async function cancelReaderCharge(stripe: Stripe, c: ClubStripe, paymentIntentId: string): Promise<void> {
  const o = onClub(c);
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, undefined, o);
  const readerId = pi.metadata?.readerId;
  if (readerId) await stripe.terminal.readers.cancelAction(readerId, undefined, o).catch(() => {});
  if (pi.status !== "succeeded" && pi.status !== "canceled") await stripe.paymentIntents.cancel(pi.id, undefined, o).catch(() => {});
}
