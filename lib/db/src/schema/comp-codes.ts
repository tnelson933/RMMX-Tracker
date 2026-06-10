import { pgTable, serial, integer, text, numeric, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { eventsTable } from "./events";
import { clubsTable } from "./clubs";
import { ridersTable } from "./riders";

export const compCodesTable = pgTable("comp_codes", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").references(() => eventsTable.id),
  clubId: integer("club_id").references(() => clubsTable.id),
  riderId: integer("rider_id").references(() => ridersTable.id),
  code: text("code").notNull().unique(),
  discountType: text("discount_type").$type<"fixed" | "percentage">().notNull().default("fixed"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  maxUses: integer("max_uses").notNull().default(1),
  usesCount: integer("uses_count").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  expiresAt: timestamp("expires_at"),
  categoryIds: jsonb("category_ids").$type<number[]>().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type CompCode = typeof compCodesTable.$inferSelect;
