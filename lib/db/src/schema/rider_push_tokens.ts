import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { riderAccountsTable } from "./rider_accounts";

export const riderPushTokensTable = pgTable("rider_push_tokens", {
  id: serial("id").primaryKey(),
  riderAccountId: integer("rider_account_id")
    .notNull()
    .references(() => riderAccountsTable.id, { onDelete: "cascade" }),
  expoPushToken: text("expo_push_token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
