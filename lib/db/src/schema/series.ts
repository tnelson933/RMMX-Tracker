import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clubsTable } from "./clubs";
import { pointsTablesTable } from "./points-tables";

export const seriesTable = pgTable("series", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id),
  season: integer("season").notNull(),
  classes: text("classes").array().notNull().default([]),
  pointsSystem: text("points_system").notNull().default("standard"),
  scoringTableId: integer("scoring_table_id").references(() => pointsTablesTable.id),
  eventIds: integer("event_ids").array().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const seriesPointsTable = pgTable("series_points", {
  id: serial("id").primaryKey(),
  seriesId: integer("series_id").notNull().references(() => seriesTable.id),
  riderId: integer("rider_id").notNull(),
  raceClass: text("race_class").notNull(),
  totalPoints: integer("total_points").notNull().default(0),
  eventsEntered: integer("events_entered").notNull().default(0),
  eventResults: jsonb("event_results").notNull().default([]),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSeriesSchema = createInsertSchema(seriesTable).omit({ id: true, createdAt: true });
export type InsertSeries = z.infer<typeof insertSeriesSchema>;
export type Series = typeof seriesTable.$inferSelect;
