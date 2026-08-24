import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { clubsTable } from "./clubs";
import { eventsTable } from "./events";

export const notificationLogsTable = pgTable("notification_logs", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").references(() => clubsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  audienceType: text("audience_type").notNull(),
  eventId: integer("event_id").references(() => eventsTable.id, { onDelete: "set null" }),
  sentCount: integer("sent_count").notNull().default(0),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
});

export type NotificationLog = typeof notificationLogsTable.$inferSelect;