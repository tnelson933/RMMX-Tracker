import { pgTable, serial, integer, boolean, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { eventsTable } from "./events";
import { ridersTable } from "./riders";

export const checkinsTable = pgTable("checkins", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => eventsTable.id),
  riderId: integer("rider_id").notNull().references(() => ridersTable.id),
  raceClass: text("race_class").notNull(),
  bibNumber: text("bib_number"),
  checkedIn: boolean("checked_in").notNull().default(false),
  checkedInAt: timestamp("checked_in_at"),
  rfidNumber: text("rfid_number"),
  rfidLinked: boolean("rfid_linked").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCheckinSchema = createInsertSchema(checkinsTable).omit({ id: true, createdAt: true });
export type InsertCheckin = z.infer<typeof insertCheckinSchema>;
export type Checkin = typeof checkinsTable.$inferSelect;
