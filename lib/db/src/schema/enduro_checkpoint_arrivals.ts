import { pgTable, serial, integer, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { eventsTable } from "./events";
import { enduroTimeChecksTable } from "./enduro_time_checks";
import { ridersTable } from "./riders";

export const enduroCheckpointArrivalsTable = pgTable(
  "enduro_checkpoint_arrivals",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id").notNull().references(() => eventsTable.id),
    timeCheckId: integer("time_check_id").notNull().references(() => enduroTimeChecksTable.id),
    riderId: integer("rider_id").notNull().references(() => ridersTable.id),
    arrivalTime: timestamp("arrival_time").notNull(),
    recordedBy: text("recorded_by").notNull().default("rfid"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [unique("unique_rider_per_check").on(table.timeCheckId, table.riderId)],
);

export const insertEnduroCheckpointArrivalSchema = createInsertSchema(enduroCheckpointArrivalsTable).omit({ id: true, createdAt: true });
export type EnduroCheckpointArrival = typeof enduroCheckpointArrivalsTable.$inferSelect;
export type InsertEnduroCheckpointArrival = z.infer<typeof insertEnduroCheckpointArrivalSchema>;