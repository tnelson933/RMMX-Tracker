import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clubsTable } from "./clubs";

export const readersTable = pgTable("readers", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id),
  name: text("name").notNull(),
  type: text("type", { enum: ["rfid", "mylaps"] }).notNull().default("rfid"),
  token: text("token").notNull().unique(),
  hardwareAddress: text("hardware_address"),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertReaderSchema = createInsertSchema(readersTable).omit({ id: true, createdAt: true });
export type Reader = typeof readersTable.$inferSelect;
export type InsertReader = z.infer<typeof insertReaderSchema>;