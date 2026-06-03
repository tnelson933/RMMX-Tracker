import { pgTable, serial, text, integer, boolean, numeric, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clubsTable } from "./clubs";

export const eventsTable = pgTable("events", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id),
  name: text("name").notNull(),
  date: text("date").notNull(),
  state: text("state").notNull(),
  location: text("location"),
  trackName: text("track_name"),
  raceClasses: text("race_classes").array().notNull().default([]),
  registrationOpen: text("registration_open"),
  registrationClose: text("registration_close"),
  status: text("status").notNull().default("draft"),
  paymentEnabled: boolean("payment_enabled").notNull().default(false),
  requireAma: boolean("require_ama").notNull().default(false),
  entryFee: numeric("entry_fee", { precision: 10, scale: 2 }),
  maxRiders: integer("max_riders"),
  raceClassLimits: jsonb("race_class_limits").$type<Record<string, number | null>>().default({}),
  imageUrl: text("image_url"),
  timingTechnology: text("timing_technology").notNull().default("rfid"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEventSchema = createInsertSchema(eventsTable).omit({ id: true, createdAt: true });
export type InsertEvent = z.infer<typeof insertEventSchema>;
export type Event = typeof eventsTable.$inferSelect;
