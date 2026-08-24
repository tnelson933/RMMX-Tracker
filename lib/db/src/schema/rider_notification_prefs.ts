import { pgTable, serial, integer, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { riderAccountsTable } from "./rider_accounts";
import { clubsTable } from "./clubs";

export const riderNotificationPrefsTable = pgTable(
  "rider_notification_prefs",
  {
    id: serial("id").primaryKey(),
    riderAccountId: integer("rider_account_id").notNull().references(() => riderAccountsTable.id, { onDelete: "cascade" }),
    clubId: integer("club_id").notNull().references(() => clubsTable.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique().on(table.riderAccountId, table.clubId)],
);

export type RiderNotificationPref = typeof riderNotificationPrefsTable.$inferSelect;