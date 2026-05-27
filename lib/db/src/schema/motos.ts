import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { eventsTable } from "./events";

export const motosTable = pgTable("motos", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => eventsTable.id),
  name: text("name").notNull(),
  type: text("type").notNull(), // heat | lcq | main | practice
  raceClass: text("race_class").notNull(),
  status: text("status").notNull().default("scheduled"), // scheduled | in_progress | completed | cancelled
  motoNumber: integer("moto_number").notNull(),
  scheduledTime: text("scheduled_time"),
  lineup: jsonb("lineup").notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertMotoSchema = createInsertSchema(motosTable).omit({ id: true, createdAt: true });
export type InsertMoto = z.infer<typeof insertMotoSchema>;
export type Moto = typeof motosTable.$inferSelect;
