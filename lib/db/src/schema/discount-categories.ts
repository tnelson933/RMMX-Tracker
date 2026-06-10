import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { clubsTable } from "./clubs";

export const discountCategoriesTable = pgTable("discount_categories", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("discount_categories_club_id_name_unique").on(t.clubId, t.name),
]);

export type DiscountCategory = typeof discountCategoriesTable.$inferSelect;
