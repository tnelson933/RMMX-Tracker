import { pgTable, serial, integer, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { clubsTable } from "./clubs";
import { ridersTable } from "./riders";

export const practiceSessionsTable = pgTable("practice_sessions", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id),
  name: text("name").notNull(),
  venueName: text("venue_name"),
  /** Library track (tracks.id; FK in deploy/migrations/0011). */
  trackId: integer("track_id"),
  /** The track's course when the session started: its split readers give sector times. */
  course: jsonb("course").$type<PracticeCourse | null>(),
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

export interface PracticeCourse {
  finishReaderId: number | null;
  splits: Array<{ readerId: number; sequence: number; label: string }>;
}

/** A rider passing a split reader during practice (sector times only, never a lap). */
export const practiceSplitCrossingsTable = pgTable("practice_split_crossings", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => practiceSessionsTable.id, { onDelete: "cascade" }),
  readerId: integer("reader_id"),
  splitSequence: integer("split_sequence").notNull(),
  label: text("label"),
  riderId: integer("rider_id").references(() => ridersTable.id),
  rfidNumber: text("rfid_number").notNull(),
  /** The timed lap the rider was on (1 = the lap after their first pass). */
  lapNumber: integer("lap_number").notNull(),
  crossingTime: timestamp("crossing_time", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("practice_split_crossings_once_per_lap").on(t.sessionId, t.rfidNumber, t.splitSequence, t.lapNumber),
]);

export type PracticeSession = typeof practiceSessionsTable.$inferSelect;
export type PracticeCrossing = typeof practiceCrossingsTable.$inferSelect;
