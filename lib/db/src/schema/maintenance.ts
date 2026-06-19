import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { ridersTable } from "./riders";

export const riderMaintenanceTable = pgTable("rider_maintenance", {
  id: serial("id").primaryKey(),
  riderId: integer("rider_id").notNull().references(() => ridersTable.id),
  itemKey: text("item_key").notNull(),
  itemName: text("item_name").notNull(),
  intervalDesc: text("interval_desc"),
  intervalDays: integer("interval_days"),
  lastServicedAt: text("last_serviced_at"),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type RiderMaintenance = typeof riderMaintenanceTable.$inferSelect;
