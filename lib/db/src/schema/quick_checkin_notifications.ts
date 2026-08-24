import { pgTable, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { eventsTable } from "./events";
import { riderAccountsTable } from "./rider_accounts";

export const quickCheckinNotificationsTable = pgTable(
  "quick_checkin_notifications",
  {
    eventId: integer("event_id").notNull().references(() => eventsTable.id, { onDelete: "cascade" }),
    riderAccountId: integer("rider_account_id").notNull().references(() => riderAccountsTable.id, { onDelete: "cascade" }),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.riderAccountId] })],
);