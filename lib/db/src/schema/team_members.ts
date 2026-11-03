import { pgTable, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { eventsTable } from "./events";
import { registrationsTable } from "./registrations";
import { ridersTable } from "./riders";

/**
 * Group races: the riders on a team. The team is one registration (its rider is
 * the captain, member 1). Each member can carry their own RFID tag and/or RM
 * TrackR (active transponder); a read of either counts as a lap for the team.
 */
export const teamMembersTable = pgTable("team_members", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => eventsTable.id, { onDelete: "cascade" }),
  registrationId: integer("registration_id").notNull().references(() => registrationsTable.id, { onDelete: "cascade" }),
  /** 1 = the captain (the registration's rider). */
  position: integer("position").notNull(),
  riderId: integer("rider_id").references(() => ridersTable.id),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  rfidNumber: text("rfid_number"),
  trackrNumber: text("trackr_number"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("team_members_event_idx").on(t.eventId),
  uniqueIndex("team_members_registration_position_idx").on(t.registrationId, t.position),
]);

export type TeamMember = typeof teamMembersTable.$inferSelect;
