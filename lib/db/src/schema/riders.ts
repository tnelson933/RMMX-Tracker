import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ridersTable = pgTable("riders", {
  id: serial("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  bibNumber: text("bib_number"),
  dateOfBirth: text("date_of_birth"),
  emergencyContact: text("emergency_contact"),
  emergencyPhone: text("emergency_phone"),
  rfidNumber: text("rfid_number"),
  // Extended rider profile
  bikeManufacturer: text("bike_manufacturer"),
  sponsors: text("sponsors"),
  amaNumber: text("ama_number"),
  mylapsTransponderId: text("mylaps_transponder_id"),
  hometown: text("hometown"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertRiderSchema = createInsertSchema(ridersTable).omit({ id: true, createdAt: true });
export type InsertRider = z.infer<typeof insertRiderSchema>;
export type Rider = typeof ridersTable.$inferSelect;
