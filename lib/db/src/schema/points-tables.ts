import { pgTable, serial, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clubsTable } from "./clubs";

export const pointsTablesTable = pgTable("points_tables", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").references(() => clubsTable.id),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  scoringMethod: text("scoring_method").notNull().default("highest_points"),
  mainEventOnly: boolean("main_event_only").notNull().default(false),
  pointsScale: jsonb("points_scale").$type<number[]>().notNull().default([]),
  isSystemDefault: boolean("is_system_default").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPointsTableSchema = createInsertSchema(pointsTablesTable).omit({ id: true, createdAt: true });
export type InsertPointsTable = z.infer<typeof insertPointsTableSchema>;
export type PointsTable = typeof pointsTablesTable.$inferSelect;
