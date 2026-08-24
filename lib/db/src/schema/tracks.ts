import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { clubsTable } from "./clubs";

export const tracksTable = pgTable("tracks", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Track = typeof tracksTable.$inferSelect;
export type NewTrack = typeof tracksTable.$inferInsert;