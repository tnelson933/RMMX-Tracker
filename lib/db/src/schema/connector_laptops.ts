import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { clubsTable } from "./clubs";
import { readersTable } from "./readers";
import { usersTable } from "./users";

/** Short-lived code an organizer shows on Reader Setup to pair an RM Connect laptop. */
export const connectorPairingCodesTable = pgTable("connector_pairing_codes", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  /** Set for a hand scanner code: pairing hands that reader to the scanner. */
  readerId: integer("reader_id").references(() => readersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [index("connector_pairing_codes_code_idx").on(table.code)]);

/**
 * A paired RM Connect laptop. It authenticates with its own key (only the
 * SHA-256 hash is stored), so no organizer password lives on the laptop.
 */
export const connectorLaptopsTable = pgTable("connector_laptops", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [index("connector_laptops_club_idx").on(table.clubId)]);

export type ConnectorLaptop = typeof connectorLaptopsTable.$inferSelect;
