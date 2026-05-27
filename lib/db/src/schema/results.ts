import { pgTable, serial, integer, text, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { eventsTable } from "./events";
import { motosTable } from "./motos";
import { ridersTable } from "./riders";

export const raceResultsTable = pgTable("race_results", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => eventsTable.id),
  motoId: integer("moto_id").notNull().references(() => motosTable.id),
  riderId: integer("rider_id").notNull().references(() => ridersTable.id),
  raceClass: text("race_class").notNull(),
  position: integer("position").notNull(),
  totalTime: text("total_time"),
  lapTimes: jsonb("lap_times").notNull().default([]),
  points: integer("points"),
  dnf: boolean("dnf").notNull().default(false),
  dns: boolean("dns").notNull().default(false),
  bibNumber: text("bib_number"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertRaceResultSchema = createInsertSchema(raceResultsTable).omit({ id: true, createdAt: true });
export type InsertRaceResult = z.infer<typeof insertRaceResultSchema>;
export type RaceResult = typeof raceResultsTable.$inferSelect;

export const eventPublicationTable = pgTable("event_publication", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => eventsTable.id).unique(),
  published: boolean("published").notNull().default(false),
  publishedAt: timestamp("published_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
