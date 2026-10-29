import { pgTable, serial, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { clubsTable } from "./clubs";
import { usersTable } from "./users";
import { eventsTable } from "./events";

/**
 * A problem Rocky (the in-app assistant) couldn't solve, escalated to the RM
 * Roost team. The owner approves or declines it from the emailed link (the
 * token is single-use; only its SHA-256 hash is stored) or the Support page.
 */
export const supportTicketsTable = pgTable("support_tickets", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").references(() => clubsTable.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  eventId: integer("event_id").references(() => eventsTable.id, { onDelete: "set null" }),
  /** Rocky's conversation, so updates can be posted back to the organizer. */
  conversationId: integer("conversation_id"),
  summary: text("summary").notNull(),
  details: text("details").notNull(),
  /** "normal" | "urgent" (racing is blocked right now). */
  urgency: text("urgency").notNull().default("normal"),
  /** What Rocky checked before escalating: [{ tool, input, result }]. */
  diagnostics: jsonb("diagnostics").$type<Array<{ tool: string; input: unknown; result: string }>>().default([]),
  /** "open" | "approved" | "declined" | "resolved". */
  status: text("status").notNull().default("open"),
  approvalTokenHash: text("approval_token_hash"),
  approvalTokenExpiresAt: timestamp("approval_token_expires_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedByUserId: integer("decided_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  resolution: text("resolution"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("support_tickets_status_idx").on(t.status, t.createdAt), index("support_tickets_club_idx").on(t.clubId, t.createdAt)]);

export type SupportTicket = typeof supportTicketsTable.$inferSelect;
