import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { eventsTable } from "./events";

export type TimeCheckTarget = { raceClass: string; durationMs: number; startTimeOfDay?: string | null };

export const enduroTimeChecksTable = pgTable("enduro_time_checks", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => eventsTable.id),
  checkNumber: integer("check_number").notNull(),
  name: text("name").notNull(),
  targets: jsonb("targets").$type<TimeCheckTarget[]>().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEnduroTimeCheckSchema = createInsertSchema(enduroTimeChecksTable).omit({ id: true, createdAt: true });
export type EnduroTimeCheck = typeof enduroTimeChecksTable.$inferSelect;
export type InsertEnduroTimeCheck = z.infer<typeof insertEnduroTimeCheckSchema>;