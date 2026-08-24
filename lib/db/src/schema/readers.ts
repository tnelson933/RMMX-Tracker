import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clubsTable } from "./clubs";

export interface ActiveTimingConfig {
  channel: number;
  power: number;
  loop1Enabled: boolean;
  loop2Enabled: boolean;
}

export const readersTable = pgTable("readers", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id),
  name: text("name").notNull(),
  type: text("type", { enum: ["rfid", "mylaps"] }).notNull().default("rfid"),
  token: text("token").notNull().unique(),
  hardwareAddress: text("hardware_address"),
  /** Race-critical F2000 configuration managed by the organizer portal. */
  activeTimingConfig: jsonb("active_timing_config").$type<ActiveTimingConfig | null>(),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertReaderSchema = createInsertSchema(readersTable).omit({ id: true, createdAt: true });
export type Reader = typeof readersTable.$inferSelect;
export type InsertReader = z.infer<typeof insertReaderSchema>;