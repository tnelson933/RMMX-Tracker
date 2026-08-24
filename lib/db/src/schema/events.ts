import { pgTable, serial, text, integer, boolean, numeric, timestamp, jsonb, doublePrecision } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clubsTable } from "./clubs";
import { discountCategoriesTable } from "./discount-categories";

export type PurchaseOption = { id: string; name: string; amount: number; categoryId?: number | null };

export const eventsTable = pgTable("events", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id),
  name: text("name").notNull(),
  date: text("date").notNull(),
  endDate: text("end_date"),
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
  raceClassSeriesMap: jsonb("race_class_series_map").$type<Record<string, number[]>>().default({}),
  raceClassDetails: jsonb("race_class_details").$type<Record<string, string>>().default({}),
  classOrder: jsonb("class_order").$type<string[] | null>(),
  contingencyBrands: jsonb("contingency_brands").$type<string[] | null>(),
  purchaseOptions: jsonb("purchase_options").$type<PurchaseOption[]>().notNull().default([]),
  imageUrl: text("image_url"),
  timingTechnology: text("timing_technology").notNull().default("rfid"),
  transponderRentalEnabled: boolean("transponder_rental_enabled").notNull().default(false),
  transponderRentalFee: numeric("transponder_rental_fee", { precision: 10, scale: 2 }),
  rfidStickerFee: numeric("rfid_sticker_fee", { precision: 10, scale: 2 }),
  noDuplicateBibs: boolean("no_duplicate_bibs").notNull().default(false),
  requireClubId: boolean("require_club_id").notNull().default(false),
  requireWaiver: boolean("require_waiver").notNull().default(false),
  requireLiabilityWaiver: boolean("require_liability_waiver").notNull().default(false),
  requireTransponder: boolean("require_transponder").notNull().default(false),
  scoringTableId: integer("scoring_table_id"),
  entryFeeCategoryId: integer("entry_fee_category_id").references(() => discountCategoriesTable.id),
  minLapMs: integer("min_lap_ms"),
  amaEventId: text("ama_event_id"),
  earlyBirdFee: numeric("early_bird_fee", { precision: 10, scale: 2 }),
  earlyBirdEndsAt: text("early_bird_ends_at"),
  raceStyle: text("race_style").notNull().default("motocross"),
  enduroPenaltyConfig: jsonb("enduro_penalty_config").$type<Record<string, unknown> | null>(),
  quickCheckinEnabled: boolean("quick_checkin_enabled").notNull().default(false),
  trackLat: doublePrecision("track_lat"),
  trackLng: doublePrecision("track_lng"),
  streetAddress: text("street_address"),
  zip: text("zip"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEventSchema = createInsertSchema(eventsTable).omit({ id: true, createdAt: true });
export type InsertEvent = z.infer<typeof insertEventSchema>;
export type Event = typeof eventsTable.$inferSelect;
