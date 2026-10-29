import { Router } from "express";
import { db, clubsTable, eventsTable, supportTicketsTable, usersTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { checkApprovalToken, decideTicket, resolveTicket, type TicketDecision } from "../lib/supportTickets";
import { checkFixToken, decideFix, startInvestigation } from "../lib/supportInvestigation";

/**
 * Support tickets Rocky escalated. The emailed Approve / Decline links open a
 * confirm page that posts to /email-decision with the single-use token (a GET
 * never decides, so mail scanners following links can't). Everything else is
 * for super admins only (Admin → Support).
 */
const router = Router();

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:80";
}

async function superAdminId(req: any, res: any): Promise<number | null> {
  const userId = (req.session as any)?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return null; }
  const [user] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.id, userId));
  if (user?.role !== "super_admin") { res.status(403).json({ error: "Forbidden" }); return null; }
  return userId;
}

const TOKEN_MESSAGES = {
  invalid: "This link isn't valid. Open the ticket in RM Roost instead.",
  expired: "This link has expired. Open the ticket in RM Roost instead.",
  already_decided: "This request was already handled.",
} as const;

async function ticketWithNames(id: number) {
  const [row] = await db.select({
    ticket: supportTicketsTable,
    clubName: clubsTable.name,
    eventName: eventsTable.name,
    eventDate: eventsTable.date,
    reporterName: usersTable.name,
    reporterEmail: usersTable.email,
  }).from(supportTicketsTable)
    .leftJoin(clubsTable, eq(supportTicketsTable.clubId, clubsTable.id))
    .leftJoin(eventsTable, eq(supportTicketsTable.eventId, eventsTable.id))
    .leftJoin(usersTable, eq(supportTicketsTable.userId, usersTable.id))
    .where(eq(supportTicketsTable.id, id));
  return row ?? null;
}

function publicTicket(row: NonNullable<Awaited<ReturnType<typeof ticketWithNames>>>) {
  const { approvalTokenHash: _hash, approvalTokenExpiresAt: _exp, fixTokenHash: _fixHash, fixTokenExpiresAt: _fixExp, ...ticket } = row.ticket;
  return {
    ...ticket,
    clubName: row.clubName,
    eventName: row.eventName,
    eventDate: row.eventDate ? String(row.eventDate).slice(0, 10) : null,
    reporterName: row.reporterName,
    reporterEmail: row.reporterEmail,
  };
}

// ── Emailed link (token, no login) ────────────────────────────────────────────

// GET: what the confirm page shows. Reads only; deciding needs the POST below.
router.get("/support/tickets/:id/email-decision", async (req, res) => {
  const row = await ticketWithNames(Number(req.params.id));
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!row) return res.status(404).json({ error: TOKEN_MESSAGES.invalid });
  if (req.query.stage === "fix") {
    const check = checkFixToken(row.ticket, token);
    if (check === "invalid") return res.status(403).json({ error: TOKEN_MESSAGES.invalid });
    const fix = row.ticket.proposedFix;
    return res.json({
      id: row.ticket.id,
      stage: "fix",
      summary: row.ticket.summary,
      urgency: row.ticket.urgency,
      status: row.ticket.status,
      clubName: row.clubName,
      eventName: row.eventName,
      fix: fix ? { kind: fix.kind, summary: fix.summary, rootCause: fix.rootCause, sql: fix.sql ?? null, expectedRows: fix.expectedRows ?? null, files: fix.files?.map(f => f.path) ?? [] } : null,
      fixStatus: row.ticket.fixStatus,
      fixResult: row.ticket.fixResult,
      canDecide: check === "ok",
      message: check === "ok" ? null : check === "already_decided" ? "This fix was already handled." : TOKEN_MESSAGES[check],
    });
  }
  const check = checkApprovalToken(row.ticket, token);
  if (check === "invalid") return res.status(403).json({ error: TOKEN_MESSAGES.invalid });
  return res.json({
    id: row.ticket.id,
    summary: row.ticket.summary,
    urgency: row.ticket.urgency,
    status: row.ticket.status,
    clubName: row.clubName,
    eventName: row.eventName,
    canDecide: check === "ok",
    message: check === "ok" ? null : TOKEN_MESSAGES[check],
  });
});

router.post("/support/tickets/:id/email-decision", async (req, res) => {
  const id = Number(req.params.id);
  const { token, decision, stage } = req.body as { token?: string; decision?: string; stage?: string };
  if (decision !== "approve" && decision !== "decline") return res.status(400).json({ error: "decision must be approve or decline" });
  const row = await ticketWithNames(id);
  if (!row) return res.status(404).json({ error: TOKEN_MESSAGES.invalid });
  if (stage === "fix") {
    const check = checkFixToken(row.ticket, token);
    if (check !== "ok") return res.status(check === "already_decided" ? 409 : 403).json({ error: check === "already_decided" ? "This fix was already handled." : TOKEN_MESSAGES[check] });
    const outcome = await decideFix(id, decision, null);
    if (!outcome.ticket) return res.status(409).json({ error: outcome.message });
    return res.json({ id, stage: "fix", fixStatus: outcome.ticket.fixStatus, message: outcome.message, prUrl: outcome.ticket.fixPrUrl });
  }
  const check = checkApprovalToken(row.ticket, token);
  if (check !== "ok") return res.status(check === "already_decided" ? 409 : 403).json({ error: TOKEN_MESSAGES[check] });
  const ticket = await decideTicket(id, decision as TicketDecision, null);
  if (!ticket) return res.status(409).json({ error: TOKEN_MESSAGES.already_decided });
  // Approved: the investigation agent starts right away.
  if (ticket.status === "approved") await startInvestigation(ticket.id, getAppUrl());
  return res.json({ id: ticket.id, status: ticket.status });
});

// ── Admin → Support (super admins) ────────────────────────────────────────────

router.get("/support/tickets", async (req, res) => {
  if (await superAdminId(req, res) == null) return;
  const rows = await db.select({
    ticket: supportTicketsTable,
    clubName: clubsTable.name,
    eventName: eventsTable.name,
    eventDate: eventsTable.date,
    reporterName: usersTable.name,
    reporterEmail: usersTable.email,
  }).from(supportTicketsTable)
    .leftJoin(clubsTable, eq(supportTicketsTable.clubId, clubsTable.id))
    .leftJoin(eventsTable, eq(supportTicketsTable.eventId, eventsTable.id))
    .leftJoin(usersTable, eq(supportTicketsTable.userId, usersTable.id))
    .orderBy(desc(supportTicketsTable.createdAt))
    .limit(200);
  return res.json(rows.map(publicTicket));
});

router.get("/support/tickets/:id", async (req, res) => {
  if (await superAdminId(req, res) == null) return;
  const row = await ticketWithNames(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Not found" });
  return res.json(publicTicket(row));
});

router.post("/support/tickets/:id/decide", async (req, res) => {
  const adminId = await superAdminId(req, res);
  if (adminId == null) return;
  const decision = (req.body as { decision?: string }).decision;
  if (decision !== "approve" && decision !== "decline") return res.status(400).json({ error: "decision must be approve or decline" });
  const ticket = await decideTicket(Number(req.params.id), decision, adminId);
  if (!ticket) return res.status(409).json({ error: "This request was already handled." });
  if (ticket.status === "approved") await startInvestigation(ticket.id, getAppUrl());
  return res.json({ id: ticket.id, status: ticket.status });
});

// Run (or re-run) the investigation agent on an approved ticket.
router.post("/support/tickets/:id/investigate", async (req, res) => {
  if (await superAdminId(req, res) == null) return;
  const started = await startInvestigation(Number(req.params.id), getAppUrl());
  if (!started) return res.status(409).json({ error: "Approve the request first, or wait for the running investigation to finish." });
  return res.json({ id: Number(req.params.id), investigationStatus: "running" });
});

// Approve or decline the fix the investigation proposed.
router.post("/support/tickets/:id/fix-decision", async (req, res) => {
  const adminId = await superAdminId(req, res);
  if (adminId == null) return;
  const decision = (req.body as { decision?: string }).decision;
  if (decision !== "approve" && decision !== "decline") return res.status(400).json({ error: "decision must be approve or decline" });
  const outcome = await decideFix(Number(req.params.id), decision, adminId);
  if (!outcome.ticket) return res.status(409).json({ error: outcome.message });
  return res.json({ id: outcome.ticket.id, fixStatus: outcome.ticket.fixStatus, message: outcome.message, prUrl: outcome.ticket.fixPrUrl });
});

router.post("/support/tickets/:id/resolve", async (req, res) => {
  const adminId = await superAdminId(req, res);
  if (adminId == null) return;
  const resolution = typeof req.body?.resolution === "string" ? req.body.resolution.trim().slice(0, 2000) : "";
  if (!resolution) return res.status(400).json({ error: "Say what was fixed: the organizer sees it in Rocky." });
  const ticket = await resolveTicket(Number(req.params.id), resolution, adminId);
  if (!ticket) return res.status(404).json({ error: "Not found" });
  return res.json({ id: ticket.id, status: ticket.status });
});

export default router;
