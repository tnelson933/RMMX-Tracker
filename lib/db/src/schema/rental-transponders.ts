import { pgTable, serial, integer, text, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { clubsTable } from "./clubs";

/**
 * A club's rental transponders. Whether a unit is out comes from the event
 * rentals (registrations.transponder_rental with that number, not returned);
 * this holds the unit list and the organizer's flags.
 */
export const rentalTranspondersTable = pgTable("rental_transponders", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id, { onDelete: "cascade" }),
  /** Normalized active transponder id (lower-case hex). */
  transponderNumber: text("transponder_number").notNull(),
  /** Organizer's name for the unit, e.g. "Rental 12". */
  label: text("label"),
  /** Reported lost; cleared when the unit is handed out again. */
  missing: boolean("missing").notNull().default(false),
  /** No longer in service: not offered at check-in. */
  retired: boolean("retired").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("rental_transponders_club_number_uq").on(t.clubId, t.transponderNumber)]);

export type RentalTransponder = typeof rentalTranspondersTable.$inferSelect;
