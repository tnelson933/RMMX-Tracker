import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ridersTable } from "./riders";
import { eventsTable } from "./events";

export const rfidAssignmentsTable = pgTable("rfid_assignments", {
  id: serial("id").primaryKey(),
  riderId: integer("rider_id").notNull().references(() => ridersTable.id),
  rfidNumber: text("rfid_number").notNull(),
  eventId: integer("event_id").references(() => eventsTable.id),
  assignedAt: timestamp("assigned_at").defaultNow().notNull(),
});

export const insertRfidAssignmentSchema = createInsertSchema(rfidAssignmentsTable).omit({ id: true, assignedAt: true });
export type InsertRfidAssignment = z.infer<typeof insertRfidAssignmentSchema>;
export type RfidAssignment = typeof rfidAssignmentsTable.$inferSelect;
