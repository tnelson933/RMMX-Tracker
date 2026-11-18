import { pgTable, serial, text, timestamp, numeric, integer, index, primaryKey, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const riderAccountsTable = pgTable("rider_accounts", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  rockyMemory: text("rocky_memory"),
  rmCashBalance: numeric("rm_cash_balance", { precision: 10, scale: 2 }).notNull().default("0"),
  /**
   * RM Roost Premium is active until this time (null = never had it). Set by
   * billing (website or app store) or by an RM Roost admin. Only matters once
   * Premium is switched on (platform_settings "premium_enforced"); until then
   * every rider gets everything.
   */
  premiumUntil: timestamp("premium_until"),
  /** Where the current Premium came from: "admin", "apple", "google" (in-app purchase) or "stripe" (website). */
  premiumSource: text("premium_source"),
  /** Website purchases: the Stripe customer and subscription on RM Roost's own Stripe account. */
  premiumStripeCustomerId: text("premium_stripe_customer_id"),
  premiumStripeSubscriptionId: text("premium_stripe_subscription_id"),
  /**
   * "individual": Premium for 1 rider profile on the account, 1 phone signed in.
   * "family" ($79.99/year): up to 4 rider profiles, up to 4 phones signed in.
   */
  premiumPlan: text("premium_plan", { enum: ["individual", "family"] }),
  /** The rider profiles Premium unlocks (1 on Individual, up to 4 on Family). */
  premiumRiderIds: jsonb("premium_rider_ids").$type<number[]>().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * One row per question a rider asks Rocky (coach, mechanic, training plan).
 * Recorded whether or not Premium is on, so the free allowance (1 per 24 hours)
 * can be enforced and AI cost watched.
 */
export const riderAiUsageTable = pgTable("rider_ai_usage", {
  id: serial("id").primaryKey(),
  riderAccountId: integer("rider_account_id").notNull().references(() => riderAccountsTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, t => [index("rider_ai_usage_account_time_idx").on(t.riderAccountId, t.createdAt)]);

/**
 * Live-stream time a rider watched for free, kept per event. Once Premium is on, a
 * free rider gets FREE_STREAM_SECONDS (30 minutes) in total, across all events and
 * never reset, before Premium is needed.
 */
export const riderStreamUsageTable = pgTable("rider_stream_usage", {
  riderAccountId: integer("rider_account_id").notNull().references(() => riderAccountsTable.id, { onDelete: "cascade" }),
  eventId: integer("event_id").notNull(),
  seconds: integer("seconds").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, t => [primaryKey({ columns: [t.riderAccountId, t.eventId] })]);

export const insertRiderAccountSchema = createInsertSchema(riderAccountsTable).omit({ id: true, createdAt: true });
export type InsertRiderAccount = z.infer<typeof insertRiderAccountSchema>;
export type RiderAccount = typeof riderAccountsTable.$inferSelect;
