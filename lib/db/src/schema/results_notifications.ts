import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { eventsTable } from "./events";
import { ridersTable } from "./riders";

/**
 * What a rider's results looked like (a fingerprint of their places and lap
 * times) when the last race day stats email or follower push about them went
 * out, so a re-finalized event only re-notifies riders whose results changed.
 * deploy/migrations/0042-results-notifications.sql
 */
export const resultsNotificationsTable = pgTable("results_notifications", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => eventsTable.id, { onDelete: "cascade" }),
  riderId: integer("rider_id").notNull().references(() => ridersTable.id, { onDelete: "cascade" }),
  /** stats_email | follow_push */
  kind: text("kind").notNull(),
  fingerprint: text("fingerprint").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("results_notifications_event_rider_kind_uq").on(t.eventId, t.riderId, t.kind),
]);
