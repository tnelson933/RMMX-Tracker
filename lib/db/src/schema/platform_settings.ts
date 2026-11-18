import { pgTable, text, jsonb, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * RM Roost-wide settings that only super admins change, one row per key.
 * "registration_fee_cents": RM Roost's fee on each registration paid by card,
 * taken from the club's payment as a Stripe application fee (0 = no fee).
 */
export const platformSettingsTable = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: integer("updated_by"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PlatformSetting = typeof platformSettingsTable.$inferSelect;
