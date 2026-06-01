import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { eventsTable } from "./events";
import { motosTable } from "./motos";
import { ridersTable } from "./riders";

export const lapCrossingsTable = pgTable("lap_crossings", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => eventsTable.id),
  motoId: integer("moto_id").notNull().references(() => motosTable.id),
  riderId: integer("rider_id").references(() => ridersTable.id),
  rfidNumber: text("rfid_number").notNull(),
  crossingTime: timestamp("crossing_time", { withTimezone: true }).notNull(),
  lapNumber: integer("lap_number"),
  lapTimeMs: integer("lap_time_ms"),
  readerId: text("reader_id"),
  antennaId: integer("antenna_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type LapCrossing = typeof lapCrossingsTable.$inferSelect;
