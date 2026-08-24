import { pgTable, serial, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { clubsTable } from "./clubs";
import { eventsTable } from "./events";

export const liabilityWaiverSignaturesTable = pgTable("liability_waiver_signatures", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id),
  eventId: integer("event_id").notNull().references(() => eventsTable.id),
  registrationId: integer("registration_id"),
  signerName: text("signer_name").notNull(),
  signerEmail: text("signer_email").notNull(),
  signerIp: text("signer_ip"),
  signerUserAgent: text("signer_user_agent"),
  consentToEsign: boolean("consent_to_esign").notNull().default(false),
  waiverContentHash: text("waiver_content_hash").notNull(),
  waiverSnapshot: text("waiver_snapshot").notNull(),
  fieldLayout: jsonb("field_layout").$type<Array<{ id: string; type: string; page: number; x: number; y: number; width: number; height: number }>>(),
  signerType: text("signer_type").notNull().default("self"),
  minorRiderName: text("minor_rider_name"),
  signedAt: timestamp("signed_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type LiabilityWaiverSignature = typeof liabilityWaiverSignaturesTable.$inferSelect;