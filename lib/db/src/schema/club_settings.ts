import { pgTable, integer, text, jsonb } from "drizzle-orm/pg-core";
import { clubsTable } from "./clubs";

export const clubSettingsTable = pgTable("club_settings", {
  clubId: integer("club_id").primaryKey().references(() => clubsTable.id),
  riderAcknowledgement: text("rider_acknowledgement"),
  waiverPdfUrl: text("waiver_pdf_url"),
  liabilityWaiverText: text("liability_waiver_text"),
  liabilityWaiverPdfUrl: text("liability_waiver_pdf_url"),
  liabilityWaiverFields: jsonb("liability_waiver_fields").$type<Array<{ id: string; type: string; page: number; x: number; y: number; width: number; height: number }>>(),
  defaultClasses: jsonb("default_classes").$type<{ id: string; name: string }[]>(),
  brandContingencies: jsonb("brand_contingencies").$type<string[]>(),
  trackName: text("track_name"),
});

export type ClubSettings = typeof clubSettingsTable.$inferSelect;