import { integer, pgTable, serial, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { riderAccountsTable } from "./rider_accounts";
import { ridersTable } from "./riders";

/**
 * Extra rider accounts that may manage a rider profile (a second parent, a coach).
 * The profile's owner is still the account whose email matches riders.email; a manager
 * is invited by email and gains access once an account with that email signs in.
 * Created by deploy/migrations/0002-rider-managers-and-follows.sql.
 */
export const riderProfileManagersTable = pgTable("rider_profile_managers", {
  id: serial("id").primaryKey(),
  riderId: integer("rider_id").notNull().references(() => ridersTable.id, { onDelete: "cascade" }),
  invitedEmail: text("invited_email").notNull(),
  riderAccountId: integer("rider_account_id").references(() => riderAccountsTable.id, { onDelete: "cascade" }),
  invitedByAccountId: integer("invited_by_account_id").references(() => riderAccountsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("rider_profile_managers_rider_email_uq").on(t.riderId, t.invitedEmail),
  index("rider_profile_managers_email_idx").on(t.invitedEmail),
]);

/** A rider account following a rider profile (results in the feed + push alerts). */
export const riderFollowsTable = pgTable("rider_follows", {
  id: serial("id").primaryKey(),
  riderAccountId: integer("rider_account_id").notNull().references(() => riderAccountsTable.id, { onDelete: "cascade" }),
  riderId: integer("rider_id").notNull().references(() => ridersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("rider_follows_account_rider_uq").on(t.riderAccountId, t.riderId),
  index("rider_follows_rider_idx").on(t.riderId),
]);

export type RiderProfileManager = typeof riderProfileManagersTable.$inferSelect;
export type RiderFollow = typeof riderFollowsTable.$inferSelect;
