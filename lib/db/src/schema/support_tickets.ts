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
  // ── Investigation (runs after approval) ──
  /** null | "running" | "done" | "failed". */
  investigationStatus: text("investigation_status"),
  investigationStartedAt: timestamp("investigation_started_at", { withTimezone: true }),
  investigationFinishedAt: timestamp("investigation_finished_at", { withTimezone: true }),
  /** The agent's write-up: root cause, evidence, what it proposes. */
  investigationReport: text("investigation_report"),
  investigationError: text("investigation_error"),
  /** Token usage of the run ({ inputTokens, outputTokens, rounds }). */
  investigationUsage: jsonb("investigation_usage").$type<Record<string, number> | null>(),
  /** What the agent proposes (see lib/supportInvestigation ProposedFix). */
  proposedFix: jsonb("proposed_fix").$type<ProposedFix | null>(),
  // ── Fix approval ──
  /** null | "awaiting_approval" | "applied" | "rolled_back" | "pr_opened" | "declined" | "failed". */
  fixStatus: text("fix_status"),
  fixTokenHash: text("fix_token_hash"),
  fixTokenExpiresAt: timestamp("fix_token_expires_at", { withTimezone: true }),
  fixResult: text("fix_result"),
  fixPrUrl: text("fix_pr_url"),
  /** One-time codes for replying YES/NO by text (SHA-256 hashes); they expire with the tokens above. */
  approvalSmsCodeHash: text("approval_sms_code_hash"),
  fixSmsCodeHash: text("fix_sms_code_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("support_tickets_status_idx").on(t.status, t.createdAt), index("support_tickets_club_idx").on(t.clubId, t.createdAt)]);

export interface ProposedFix {
  /** data: one SQL statement; code: file changes for a pull request; config: settings the organizer or owner changes; none. */
  kind: "data" | "code" | "config" | "none";
  rootCause: string;
  summary: string;
  /** What the organizer is told in Rocky when it's fixed. */
  organizerMessage: string;
  sql?: string;
  expectedRows?: number;
  files?: Array<{ path: string; content: string }>;
  steps?: string;
}

export type SupportTicket = typeof supportTicketsTable.$inferSelect;

/**
 * Support-alert phone numbers (SUPPORT_ALERT_PHONES): when each was sent the
 * enrollment confirmation text, and whether it replied STOP.
 */
export const smsAlertEnrollmentsTable = pgTable("sms_alert_enrollments", {
  phone: text("phone").primaryKey(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  optedOutAt: timestamp("opted_out_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
