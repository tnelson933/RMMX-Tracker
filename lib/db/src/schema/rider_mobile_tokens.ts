import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { riderAccountsTable } from "./rider_accounts";

export const riderMobileTokensTable = pgTable("rider_mobile_tokens", {
  id: serial("id").primaryKey(),
  riderAccountId: integer("rider_account_id")
    .notNull()
    .references(() => riderAccountsTable.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  /**
   * When the app last used this token (updated at most hourly). Null: never used
   * by the app, e.g. made by a website sign-in (the website uses its session
   * cookie, not the token), so it doesn't count as a phone.
   */
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

/**
 * Phones signed out because the account signed in on another phone (the phone
 * limit: 1, or 4 on the Family plan, once Premium is on). Lets the signed-out
 * phone say why instead of a plain "signed out". Kept 30 days.
 */
export const riderMobileSignoutsTable = pgTable("rider_mobile_signouts", {
  token: text("token").primaryKey(),
  riderAccountId: integer("rider_account_id").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
