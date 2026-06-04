import { pgTable, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const clubsTable = pgTable("clubs", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity({ startWith: 1000 }),
  name: text("name").notNull(),
  state: text("state").notNull(),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  logoUrl: text("logo_url"),
  website: text("website"),
  description: text("description"),
  stripeAccountId: text("stripe_account_id"),
  stripeOnboardingComplete: boolean("stripe_onboarding_complete").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertClubSchema = createInsertSchema(clubsTable).omit({ id: true, createdAt: true });
export type InsertClub = z.infer<typeof insertClubSchema>;
export type Club = typeof clubsTable.$inferSelect;
