import { pgTable, serial, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { ridersTable } from "./riders";

export const riderBikesTable = pgTable("rider_bikes", {
  id: serial("id").primaryKey(),
  riderId: integer("rider_id").notNull().references(() => ridersTable.id, { onDelete: "cascade" }),
  bikeManufacturer: text("bike_manufacturer"),
  bikeModel: text("bike_model"),
  bikeYear: text("bike_year"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type RiderBike = typeof riderBikesTable.$inferSelect;