import { pgTable, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { ridersTable } from "./riders";

/**
 * Every transponder a rider owns (deploy/migrations/0046-rider-transponders.sql):
 * RM TrackR active transponders and RFID stickers, e.g. one per bike. A read of
 * any of them times the rider. A number belongs to one rider at a time
 * (unique), stored trimmed and lower-case.
 *
 * riders.mylaps_transponder_id / riders.rfid_number stay as each kind's
 * "primary" (oldest) number. Database triggers keep the two in step both ways,
 * so older apps and desktop versions that only know the single field still work.
 */
export const riderTranspondersTable = pgTable("rider_transponders", {
  id: serial("id").primaryKey(),
  riderId: integer("rider_id").notNull().references(() => ridersTable.id, { onDelete: "cascade" }),
  /** Trimmed, lower-case. */
  transponderNumber: text("transponder_number").notNull(),
  /** "trackr" (RM TrackR / active transponder) or "rfid" (sticker). */
  kind: text("kind").notNull().default("trackr"),
  /** Optional rider-facing note, e.g. the bike it's on. */
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("rider_transponders_number_idx").on(t.transponderNumber),
  index("rider_transponders_rider_idx").on(t.riderId),
]);

export type RiderTransponder = typeof riderTranspondersTable.$inferSelect;
