import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { db, clubsTable, eventsTable, messages, supportTicketsTable, usersTable, type SupportTicket } from "@workspace/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { sendSupportTicketEmail } from "./email";
import { logger } from "./logger";
import { parsePhoneList, sendSms } from "./sms";

/**
 * Support tickets: problems Rocky couldn't solve, escalated to the RM Roost
 * team. The owner approves or declines each one from an emailed link (a
 * single-use token, stored only as a SHA-256 hash) or the Admin → Support page.
 * Nothing here changes club data: approving only marks the ticket for
 * investigation.
 */

export const TICKETS_PER_CLUB_PER_DAY = 5;
export const APPROVAL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type TicketDecision = "approve" | "decline";

export function hashApprovalToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A new emailed-link token, its hash for storage, and when it expires. */
export function newApprovalToken(now = new Date()): { token: string; hash: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashApprovalToken(token), expiresAt: new Date(now.getTime() + APPROVAL_TOKEN_TTL_MS) };
}

/** Can this emailed token decide the ticket? */
export function checkApprovalToken(
  ticket: Pick<SupportTicket, "status" | "approvalTokenHash" | "approvalTokenExpiresAt">,
  token: string | null | undefined,
  now = new Date(),
): "ok" | "invalid" | "expired" | "already_decided" {
  if (ticket.status !== "open") return "already_decided";
  if (!token || !ticket.approvalTokenHash) return "invalid";
  const given = Buffer.from(hashApprovalToken(token), "hex");
  const stored = Buffer.from(ticket.approvalTokenHash, "hex");
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return "invalid";
  if (!ticket.approvalTokenExpiresAt || ticket.approvalTokenExpiresAt.getTime() < now.getTime()) return "expired";
  return "ok";
}

/** Is the club under its daily ticket limit? (Keeps a looping chat from flooding the inbox.) */
export function underTicketLimit(ticketsInLast24h: number, limit = TICKETS_PER_CLUB_PER_DAY): boolean {
  return ticketsInLast24h < limit;
}

export const CREATE_SUPPORT_TICKET_TOOL: Anthropic.Tool = {
  name: "create_support_ticket",
  description:
    "Escalate a problem to the RM Roost team when you've checked what you can (with the diagnostic tools) and the organizer can't fix it themselves: it looks like a bug, a data problem, or something only the RM Roost team can change. Emails the team. Ask the organizer before creating one, and create at most one per problem. Don't use it for how-to questions.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One line: what's wrong (e.g. 'Finish reader not receiving reads during moto 3')." },
      details: {
        type: "string",
        description: "What the organizer reported, what you checked and found, what they already tried, and anything the team needs to reproduce it. Plain sentences; no passwords or card details.",
      },
      urgency: { type: "string", enum: ["normal", "urgent"], description: "urgent only when racing or check-in is blocked right now." },
    },
    required: ["summary", "details", "urgency"],
    additionalProperties: false,
  },
};

export interface TicketContext {
  clubId: number | null;
  userId: number;
  eventId: number | null;
  conversationId: number;
  appUrl: string;
}

/** Create a ticket from Rocky's tool call and email the team. Returns text for the tool_result. */
export async function createSupportTicket(
  ctx: TicketContext,
  input: unknown,
  diagnostics: Array<{ tool: string; input: unknown; result: string }>,
): Promise<{ content: string; isError: boolean }> {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const summary = typeof args.summary === "string" ? args.summary.trim().slice(0, 200) : "";
  const details = typeof args.details === "string" ? args.details.trim().slice(0, 5000) : "";
  const urgency = args.urgency === "urgent" ? "urgent" : "normal";
  if (!summary || !details) return { content: "summary and details are required", isError: true };

  if (ctx.clubId != null) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(supportTicketsTable)
      .where(and(eq(supportTicketsTable.clubId, ctx.clubId), gte(supportTicketsTable.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000))));
    if (!underTicketLimit(row?.n ?? 0)) {
      return { content: `This club has already sent ${TICKETS_PER_CLUB_PER_DAY} tickets today. Tell the organizer the team has their earlier tickets and will follow up; don't create another.`, isError: true };
    }
  }

  const { token, hash, expiresAt } = newApprovalToken();
  const [ticket] = await db.insert(supportTicketsTable).values({
    clubId: ctx.clubId,
    userId: ctx.userId,
    eventId: ctx.eventId,
    conversationId: ctx.conversationId,
    summary,
    details,
    urgency,
    diagnostics: diagnostics.slice(-10).map(d => ({ tool: d.tool, input: d.input, result: d.result.slice(0, 4000) })),
    approvalTokenHash: hash,
    approvalTokenExpiresAt: expiresAt,
  }).returning();

  try {
    await alertTeam(ticket, token, ctx.appUrl);
  } catch (err) {
    logger.error({ err, ticketId: ticket.id }, "support ticket alert failed");
  }
  return { content: JSON.stringify({ ticketId: ticket.id, status: "sent to the RM Roost team" }), isError: false };
}

/** Email and text the RM Roost team, so a request isn't missed. */
async function alertTeam(ticket: SupportTicket, token: string, appUrl: string): Promise<void> {
  const [club] = ticket.clubId != null
    ? await db.select({ name: clubsTable.name }).from(clubsTable).where(eq(clubsTable.id, ticket.clubId))
    : [];
  const [event] = ticket.eventId != null
    ? await db.select({ name: eventsTable.name, date: eventsTable.date }).from(eventsTable).where(eq(eventsTable.id, ticket.eventId))
    : [];
  const [reporter] = await db.select({ name: usersTable.name, email: usersTable.email }).from(usersTable)
    .where(eq(usersTable.id, ticket.userId ?? 0));
  // Recipients: SUPPORT_ALERT_EMAILS (comma-separated), else every super admin.
  const configured = (process.env.SUPPORT_ALERT_EMAILS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const recipients = configured.length > 0 ? configured
    : (await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.role, "super_admin")))
        .map(u => u.email).filter((e): e is string => !!e);
  const decideUrl = (decision?: TicketDecision) =>
    `${appUrl}/support/decide?ticket=${ticket.id}&token=${encodeURIComponent(token)}${decision ? `&decision=${decision}` : ""}`;

  // Texts: SUPPORT_ALERT_PHONES (comma-separated, +15551234567 format).
  const phones = parsePhoneList(process.env.SUPPORT_ALERT_PHONES);
  const text = `RM Roost support #${ticket.id}${ticket.urgency === "urgent" ? " URGENT" : ""}: ${ticket.summary.slice(0, 90)}`
    + `${club?.name ? ` (${club.name.slice(0, 40)})` : ""}. Approve or decline: ${decideUrl()}`;
  if (phones.length === 0) logger.warn({ ticketId: ticket.id }, "support ticket: no SUPPORT_ALERT_PHONES set, no text sent");
  for (const phone of phones) await sendSms(phone, text);

  if (recipients.length === 0) {
    logger.warn({ ticketId: ticket.id }, "support ticket: no email recipients (set SUPPORT_ALERT_EMAILS or add a super admin)");
    return;
  }
  await sendSupportTicketEmail({
    to: recipients,
    ticketId: ticket.id,
    urgency: ticket.urgency as "normal" | "urgent",
    summary: ticket.summary,
    details: ticket.details,
    clubName: club?.name ?? null,
    eventName: event ? `${event.name} (${String(event.date).slice(0, 10)})` : null,
    reporter: reporter ? (reporter.name || reporter.email || null) : null,
    checked: (ticket.diagnostics ?? []).map(d => d.tool),
    approveUrl: decideUrl("approve"),
    declineUrl: decideUrl("decline"),
    ticketUrl: `${appUrl}/admin/support?ticket=${ticket.id}`,
  });
}

/** Post an update into the organizer's Rocky conversation, so they see it next time they open Rocky. */
export async function postTicketUpdate(ticket: SupportTicket, text: string): Promise<void> {
  if (ticket.conversationId == null) return;
  await db.insert(messages).values({ conversationId: ticket.conversationId, role: "assistant", content: text });
}

/** Approve or decline a ticket, once. Returns the updated ticket, or null if it was already decided. */
export async function decideTicket(ticketId: number, decision: TicketDecision, decidedByUserId: number | null): Promise<SupportTicket | null> {
  const [ticket] = await db.update(supportTicketsTable)
    .set({
      status: decision === "approve" ? "approved" : "declined",
      decidedAt: new Date(),
      decidedByUserId,
      // The emailed link works once.
      approvalTokenHash: null,
      approvalTokenExpiresAt: null,
    })
    .where(and(eq(supportTicketsTable.id, ticketId), eq(supportTicketsTable.status, "open")))
    .returning();
  if (!ticket) return null;
  await postTicketUpdate(ticket, decision === "approve"
    ? `**Update on your support request** ("${ticket.summary}"): the RM Roost team is looking into this. I'll post here when it's fixed.`
    : `**Update on your support request** ("${ticket.summary}"): the RM Roost team reviewed it and isn't taking action right now. If it's still a problem, tell me what's happening and I'll check again.`);
  return ticket;
}

/** Mark a ticket fixed and tell the organizer. */
export async function resolveTicket(ticketId: number, resolution: string, byUserId: number): Promise<SupportTicket | null> {
  const [ticket] = await db.update(supportTicketsTable)
    .set({
      status: "resolved",
      resolution,
      resolvedAt: new Date(),
      decidedByUserId: byUserId,
      decidedAt: sql`coalesce(${supportTicketsTable.decidedAt}, now())`,
      approvalTokenHash: null,
      approvalTokenExpiresAt: null,
    })
    .where(eq(supportTicketsTable.id, ticketId))
    .returning();
  if (!ticket) return null;
  await postTicketUpdate(ticket, `**Fixed: "${ticket.summary}"**\n\n${resolution}\n\nTry again, and tell me if anything still isn't working.`);
  return ticket;
}
