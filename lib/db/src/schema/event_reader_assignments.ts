import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { eventsTable } from "./events";
import { readersTable } from "./readers";
import { motosTable } from "./motos";
import { enduroTimeChecksTable } from "./enduro_time_checks";

export const eventReaderAssignmentsTable = pgTable("event_reader_assignments", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => eventsTable.id),
  readerId: integer("reader_id").notNull().references(() => readersTable.id),
  antennaId: integer("antenna_id"),
  role: text("role", { enum: ["start", "finish", "time_check"] }).notNull(),
  motoId: integer("moto_id").references(() => motosTable.id),
  timeCheckId: integer("time_check_id").references(() => enduroTimeChecksTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEventReaderAssignmentSchema = createInsertSchema(eventReaderAssignmentsTable).omit({ id: true, createdAt: true });
export type EventReaderAssignment = typeof eventReaderAssignmentsTable.$inferSelect;
export type InsertEventReaderAssignment = z.infer<typeof insertEventReaderAssignmentSchema>;