import { integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { clubsTable } from "./clubs";
import { ridersTable } from "./riders";

// A desktop database has its own numeric ID space.  This is deliberately
// separate from email: multiple rider profiles may legitimately share one.
export const offlineRiderIdentitiesTable = pgTable("offline_rider_identities", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id),
  clientIdentity: text("client_identity").notNull(),
  riderId: integer("rider_id").notNull().references(() => ridersTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("offline_rider_identities_club_identity_uq").on(table.clubId, table.clientIdentity),
  uniqueIndex("offline_rider_identities_club_rider_uq").on(table.clubId, table.riderId),
]);