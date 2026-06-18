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
  // Address fields
  streetAddress: text("street_address"),
  city: text("city"),
  homeState: text("home_state"),
  zip: text("zip"),
  // Extended rider profile
  bikeManufacturer: text("bike_manufacturer"),
  bikeModel: text("bike_model"),
  bikeYear: text("bike_year"),
  sponsors: text("sponsors"),
  amaNumber: text("ama_number"),
  mylapsTransponderId: text("mylaps_transponder_id"),
  skillLevel: text("skill_level"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertRiderSchema = createInsertSchema(ridersTable).omit({ id: true, createdAt: true });
export type InsertRider = z.infer<typeof insertRiderSchema>;
export type Rider = typeof ridersTable.$inferSelect;
