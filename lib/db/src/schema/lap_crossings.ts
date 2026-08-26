import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
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
}, (table) => [
  index("lap_crossings_moto_rider_lap_time_idx")
    .on(table.motoId, table.riderId, table.lapTimeMs),
  index("lap_crossings_moto_lap_crossing_idx")
    .on(table.motoId, table.lapNumber, table.crossingTime, table.id),
  index("lap_crossings_moto_rfid_crossing_idx")
    .on(table.motoId, table.rfidNumber, table.crossingTime),
]);

export type LapCrossing = typeof lapCrossingsTable.$inferSelect;
