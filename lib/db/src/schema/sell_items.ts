import { pgTable, serial, integer, text, numeric, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clubsTable } from "./clubs";

/**
 * What a club sells to riders (Admin → Sell Items): the RM TrackR Transponder
 * and RFID Tag (always present, priced by the club), plus anything else such as
 * camping or pit passes. Event forms offer these as one-click purchase options;
 * check-in sells the RM TrackR and RFID Tag at these prices.
 */
export const clubSellItemsTable = pgTable("club_sell_items", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id, { onDelete: "cascade" }),
  /** "rm_trackr" | "rfid_tag" (one each per club) | "custom". */
  kind: text("kind").notNull().default("custom"),
  name: text("name").notNull(),
  /** Null: no price set yet (only possible for the built-in items). */
  price: numeric("price", { precision: 10, scale: 2 }),
  hidden: boolean("hidden").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("club_sell_items_club_idx").on(t.clubId),
  uniqueIndex("club_sell_items_builtin_uq").on(t.clubId, t.kind).where(sql`${t.kind} <> 'custom'`),
]);

export type ClubSellItem = typeof clubSellItemsTable.$inferSelect;
