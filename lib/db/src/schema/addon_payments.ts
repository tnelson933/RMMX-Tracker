import { pgTable, serial, integer, text, numeric, timestamp, index } from "drizzle-orm/pg-core";
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
  /** "cash" | "card" */
  method: text("method").notNull(),
  /** "paid" | "pending" */
  status: text("status").notNull(),
  stripeSessionId: text("stripe_session_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
}, (t) => [
  index("addon_payments_event_idx").on(t.eventId),
  index("addon_payments_registration_idx").on(t.registrationId),
  index("addon_payments_session_idx").on(t.stripeSessionId),
]);

export type AddonPayment = typeof addonPaymentsTable.$inferSelect;
