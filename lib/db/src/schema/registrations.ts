import { pgTable, serial, text, integer, numeric, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { eventsTable } from "./events";
import type { PurchaseOption } from "./events";
import { ridersTable } from "./riders";

export const registrationsTable = pgTable("registrations", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => eventsTable.id),
  riderId: integer("rider_id").notNull().references(() => ridersTable.id),
  raceClass: text("race_class").notNull(),
  status: text("status").notNull().default("confirmed"), // pending | confirmed | void
  paymentStatus: text("payment_status").notNull().default("unpaid"), // unpaid | paid | refunded
  paymentMethod: text("payment_method"), // card | cash | null
  amountPaid: numeric("amount_paid", { precision: 10, scale: 2 }),
  bibNumber: text("bib_number"),
  amaNumber: text("ama_number"),
  clubIdNumber: text("club_id_number"),
  bikeBrand: text("bike_brand"),
  bikeModel: text("bike_model"),
  bikeYear: text("bike_year"),
  sponsors: text("sponsors"),
  statsEmailOptIn: boolean("stats_email_opt_in").notNull().default(false),
  transponderRental: boolean("transponder_rental").notNull().default(false),
  myLapsTransponderNumber: text("mylaps_transponder_number"),
  selectedPurchaseOptions: jsonb("selected_purchase_options").$type<PurchaseOption[]>().notNull().default([]),
  compCode: text("comp_code"),
  compDiscount: numeric("comp_discount", { precision: 10, scale: 2 }),
  displayFirstName: text("display_first_name"),
  displayLastName: text("display_last_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertRegistrationSchema = createInsertSchema(registrationsTable).omit({ id: true, createdAt: true });
export type InsertRegistration = z.infer<typeof insertRegistrationSchema>;
export type Registration = typeof registrationsTable.$inferSelect;
