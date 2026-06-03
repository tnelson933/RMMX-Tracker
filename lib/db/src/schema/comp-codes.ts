import { pgTable, serial, integer, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { eventsTable } from "./events";

export const compCodesTable = pgTable("comp_codes", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => eventsTable.id),
  code: text("code").notNull().unique(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  maxUses: integer("max_uses").notNull().default(1),
  usesCount: integer("uses_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type CompCode = typeof compCodesTable.$inferSelect;
