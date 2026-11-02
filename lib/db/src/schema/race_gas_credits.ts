import { pgTable, serial, integer, text, timestamp, numeric, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { eventsTable } from "./events";
import { ridersTable } from "./riders";

/**
 * Race Gas: every rider who races an event earns a website credit from Rocky
 * Mountain ATV (the Race Gas template's fields). One row per rider per event,
 * gathered as their races finish, then sent to the CRM (or downloaded as the
 * Race Gas Excel file) — never twice for the same rider and event.
 */
export const raceGasCreditsTable = pgTable("race_gas_credits", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => eventsTable.id),
  riderId: integer("rider_id").notNull().references(() => ridersTable.id),
  firstName: text("first_name"),
  lastName: text("last_name"),
  streetAddress: text("street_address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  email: text("email"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull().default("15"),
  /** ready | missing_info | sent | failed */
  status: text("status").notNull().default("ready"),
  /** Template fields missing from the rider's profile (all are required). */
  missingFields: text("missing_fields").array(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("race_gas_credits_event_rider").on(table.eventId, table.riderId),
  index("race_gas_credits_status_idx").on(table.status),
]);

export type RaceGasCredit = typeof raceGasCreditsTable.$inferSelect;

/**
 * Race Gas sending, set by an RM Roost admin (one row, id 1). The key is
 * write-only: it's sent to the CRM but never shown back.
 */
export const raceGasSettingsTable = pgTable("race_gas_settings", {
  id: integer("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  /** Where credits are POSTed (the CRM's endpoint, or a middleware such as Zapier). */
  endpointUrl: text("endpoint_url"),
  /** Sent as "Authorization: Bearer <key>" and used to sign each request (HMAC-SHA256). */
  apiKey: text("api_key"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull().default("15"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
