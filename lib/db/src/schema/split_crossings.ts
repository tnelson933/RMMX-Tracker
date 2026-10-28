import { pgTable, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { eventsTable } from "./events";
import { motosTable } from "./motos";
import { ridersTable } from "./riders";

/**
 * A rider passing a split reader (a course point between finish-line passes).
 * Splits never change laps or placings; they only produce sector times.
 * assignmentId/readerId are informational: assignments are replaced when the
 * course map is saved, so splits are keyed by their course order instead.
 */
export const splitCrossingsTable = pgTable("split_crossings", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => eventsTable.id),
  motoId: integer("moto_id").notNull().references(() => motosTable.id),
  assignmentId: integer("assignment_id"),
  readerId: integer("reader_id"),
  /** Course order of the split (1 = first split after the finish line). */
  splitSequence: integer("split_sequence").notNull(),
  label: text("label"),
  riderId: integer("rider_id").references(() => ridersTable.id),
  rfidNumber: text("rfid_number").notNull(),
  /** The lap the rider was on when passing the split. */
  lapNumber: integer("lap_number").notNull(),
  crossingTime: timestamp("crossing_time", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("split_crossings_once_per_lap").on(table.motoId, table.rfidNumber, table.splitSequence, table.lapNumber),
  index("split_crossings_moto_rider_idx").on(table.motoId, table.riderId),
]);

export type SplitCrossing = typeof splitCrossingsTable.$inferSelect;
