import { pgTable, serial, integer, text, numeric, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { eventsTable } from "./events";
import { registrationsTable } from "./registrations";

/**
 * Add-ons paid at check-in, separate from the registration's own payment:
 * transponder rentals, RM TrackR Transponder and RFID tag sales. Cash is paid
 * when recorded; card is "pending" until Stripe confirms the checkout.
 */
export const addonPaymentsTable = pgTable("addon_payments", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => eventsTable.id, { onDelete: "cascade" }),
  registrationId: integer("registration_id").notNull().references(() => registrationsTable.id, { onDelete: "cascade" }),
  /** "transponder_rental" | "rm_trackr" | "rfid_sticker" */
  item: text("item").notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  /** How many were bought in this payment (group races buy one per team member); amount is the total. */
  quantity: integer("quantity").notNull().default(1),
  /** "cash" | "card" */
  method: text("method").notNull(),
  /** "paid" | "pending" */
  status: text("status").notNull(),
  stripeSessionId: text("stripe_session_id"),
  /** Cash only: what the rider handed over, and the change given back (amount is what's kept). */
  cashTendered: numeric("cash_tendered", { precision: 10, scale: 2 }),
  cashChange: numeric("cash_change", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  /** Taken on the offline desktop app: its own id for the payment, so a retried sync never doubles it. */
  desktopRef: text("desktop_ref"),
}, (t) => [
  index("addon_payments_event_idx").on(t.eventId),
  index("addon_payments_registration_idx").on(t.registrationId),
  index("addon_payments_session_idx").on(t.stripeSessionId),
  uniqueIndex("addon_payments_desktop_ref_idx").on(t.desktopRef).where(sql`${t.desktopRef} IS NOT NULL`),
]);

export type AddonPayment = typeof addonPaymentsTable.$inferSelect;
