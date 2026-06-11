import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { clubsTable } from "./clubs";
import { ridersTable } from "./riders";

export const practiceSessionsTable = pgTable("practice_sessions", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id),
  name: text("name").notNull(),
  status: text("status").notNull().default("idle"), // idle | active | ended
  debounceMs: integer("debounce_ms").notNull().default(10000),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const practiceCrossingsTable = pgTable("practice_crossings", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => practiceSessionsTable.id),
  rfidNumber: text("rfid_number").notNull(),
  riderId: integer("rider_id").references(() => ridersTable.id),
  riderName: text("rider_name"),
  bibNumber: text("bib_number"),
  crossingTime: timestamp("crossing_time", { withTimezone: true }).notNull(),
  lapNumber: integer("lap_number").notNull(),
  lapTimeMs: integer("lap_time_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PracticeSession = typeof practiceSessionsTable.$inferSelect;
export type PracticeCrossing = typeof practiceCrossingsTable.$inferSelect;
