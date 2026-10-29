import { Router } from "express";
import { db } from "@workspace/db";
import { conversations, messages, eventsTable, motosTable, checkinsTable, usersTable, registrationsTable } from "@workspace/db";
import { eq, and, desc, count, asc, ne } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import SYSTEM_PROMPT from "./SYSTEM_PROMPT.md";
import { eventTimingTags, timingTagsLabel } from "../../lib/eventTimingTags";
import type Anthropic from "@anthropic-ai/sdk";
import { ROCKY_DIAGNOSTIC_TOOLS, runRockyDiagnosticTool } from "../../lib/rockyTools";
import { CREATE_SUPPORT_TICKET_TOOL, createSupportTicket } from "../../lib/supportTickets";

const router = Router();

// Rocky's tools: read-only diagnostics for the organizer's own club, plus
// escalation to the RM Roost team. Fixed order so the cached prefix is stable.
const ROCKY_TOOLS: Anthropic.Tool[] = [...ROCKY_DIAGNOSTIC_TOOLS, CREATE_SUPPORT_TICKET_TOOL];
// Model calls per answer (each tool round is one); keeps a confused loop short.
const MAX_ROCKY_ROUNDS = 6;
const TOOL_STATUS: Record<string, string> = {
  get_reader_status: "Checking your readers…",
  get_event_timing_status: "Checking the event's timing…",
  find_rider_entry: "Looking up the rider…",
  create_support_ticket: "Sending this to the RM Roost team…",
};

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:80";
}

// SYSTEM_PROMPT is loaded from SYSTEM_PROMPT.md at build time (esbuild text loader).
// When you add a new organizer-facing feature, update SYSTEM_PROMPT.md — do NOT edit
// an inline string here. See the feature-coverage list at the top of that file.

router.get("/anthropic/conversations", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.createdAt));

  res.json(rows);
});

router.post("/anthropic/conversations", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { title } = req.body as { title?: string };
  if (!title?.trim()) { res.status(400).json({ error: "title is required" }); return; }

  const [row] = await db
    .insert(conversations)
    .values({ title: title.trim(), userId } as any)
    .returning();

  res.status(201).json(row);
});

router.get("/anthropic/conversations/:id", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = Number(req.params.id);
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)));

  if (!conv) { res.status(404).json({ error: "Not found" }); return; }

  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);

  res.json({ ...conv, messages: msgs });
});

router.delete("/anthropic/conversations/:id", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = Number(req.params.id);
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)));

  if (!conv) { res.status(404).json({ error: "Not found" }); return; }

  await db.delete(conversations).where(eq(conversations.id, id));
  res.status(204).end();
});

router.get("/anthropic/conversations/:id/messages", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = Number(req.params.id);
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)));

  if (!conv) { res.status(404).json({ error: "Not found" }); return; }

  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);

  res.json(msgs);
});

router.post("/anthropic/conversations/:id/messages", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = Number(req.params.id);
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)));

  if (!conv) { res.status(404).json({ error: "Not found" }); return; }

  const { content, eventId } = req.body as { content?: string; eventId?: number };
  if (!content?.trim()) { res.status(400).json({ error: "content is required" }); return; }

  await db.insert(messages).values({
    conversationId: id,
    role: "user",
    content: content.trim(),
  });

  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);

  const chatMessages = history.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  // The knowledge base goes first and is cached; per-event context follows it
  // so it never invalidates the cached prefix.
  let eventContext: string | null = null;

  const [user] = await db
    .select({ clubId: usersTable.clubId, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  // Tools are limited to this club: the organizer's own, or for a super admin
  // (no club of their own) the club of the event they have open.
  let toolClubId: number | null = user?.clubId ?? null;
  let toolEventId: number | null = null;
  if (toolClubId == null && user?.role === "super_admin" && eventId && Number.isInteger(Number(eventId))) {
    const [owner] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, Number(eventId)));
    toolClubId = owner?.clubId ?? null;
  }

  if (eventId && Number.isInteger(Number(eventId))) {
    const numericEventId = Number(eventId);
    const userClubId = toolClubId;

    const [event] = userClubId
      ? await db
          .select()
          .from(eventsTable)
          .where(and(eq(eventsTable.id, numericEventId), eq(eventsTable.clubId, userClubId)))
      : [];

    if (event) {
      toolEventId = event.id;
      const [motoCountRow] = await db
        .select({ count: count() })
        .from(motosTable)
        .where(eq(motosTable.eventId, numericEventId));

      const [checkinCountRow] = await db
        .select({ count: count() })
        .from(checkinsTable)
        .where(and(eq(checkinsTable.eventId, numericEventId), eq(checkinsTable.checkedIn, true)));

      const [inProgressMoto] = await db
        .select()
        .from(motosTable)
        .where(and(eq(motosTable.eventId, numericEventId), eq(motosTable.status, "in_progress")))
        .limit(1);

      const [nextScheduledMoto] = await db
        .select()
        .from(motosTable)
        .where(and(eq(motosTable.eventId, numericEventId), eq(motosTable.status, "scheduled")))
        .orderBy(asc(motosTable.motoNumber))
        .limit(1);

      // Entries are class registrations, not unique riders.
      const [entryCountRow] = await db
        .select({ count: count() })
        .from(registrationsTable)
        .where(and(eq(registrationsTable.eventId, numericEventId), ne(registrationsTable.status, "void")));

      const classes = Array.isArray(event.raceClasses) ? event.raceClasses : [];
      const purchaseOptions = Array.isArray(event.purchaseOptions)
        ? (event.purchaseOptions as Array<{ name?: string } | null>).map(o => o?.name).filter(Boolean)
        : [];
      const venue = [event.trackName, event.location, event.state].filter(Boolean).join(", ");
      const contextLines: string[] = [
        `## Current Event Context`,
        ``,
        `The organizer currently has the following event open:`,
        ``,
        `- **Event name:** ${event.name}`,
        `- **Date:** ${event.date}`,
        `- **Status:** ${event.status.replace(/_/g, " ")}`,
        `- **Race style:** ${event.raceStyle}`,
        `- **Timing tags (from its readers):** ${timingTagsLabel(await eventTimingTags(event.id))}`,
        ...(venue ? [`- **Venue:** ${venue}`] : []),
        `- **Race classes:** ${classes.length > 0 ? classes.join(", ") : "none set"}`,
        `- **Online payments:** ${event.paymentEnabled ? "on" : "off"}`,
        `- **Quick Check-In:** ${event.quickCheckinEnabled ? "on" : "off"}`,
        `- **Transponder rental:** ${event.transponderRentalEnabled ? "on" : "off"}`,
        ...(purchaseOptions.length > 0 ? [`- **Purchase options:** ${purchaseOptions.join(", ")}`] : []),
        `- **Registration entries (class entries, not unique riders):** ${entryCountRow?.count ?? 0}`,
        `- **Total motos:** ${motoCountRow?.count ?? 0}`,
        `- **Entries checked in:** ${checkinCountRow?.count ?? 0}`,
      ];

      if (inProgressMoto) {
        contextLines.push(`- **Currently racing:** ${inProgressMoto.name} (${inProgressMoto.raceClass}, moto #${inProgressMoto.motoNumber})`);
      }

      if (nextScheduledMoto) {
        contextLines.push(`- **Next up (scheduled):** ${nextScheduledMoto.name} (${nextScheduledMoto.raceClass}, moto #${nextScheduledMoto.motoNumber})`);
      }

      if (!inProgressMoto && !nextScheduledMoto) {
        contextLines.push(`- **Moto status:** No motos currently in progress or scheduled`);
      }

      contextLines.push(``, `When answering, reference this event by name and use these numbers to give specific, accurate answers.`, ``);

      eventContext = contextLines.join("\n");
    }
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let fullResponse = "";
  // What Rocky checked this answer, attached to a support ticket if it makes one.
  const diagnostics: Array<{ tool: string; input: unknown; result: string }> = [];
  const send = (payload: Record<string, unknown>) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  try {
    const loopMessages: Anthropic.MessageParam[] = chatMessages;
    for (let round = 1; ; round++) {
      const stream = anthropic.messages.stream({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        // Help-desk answers: low effort keeps replies quick.
        output_config: { effort: "low" },
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          ...(eventContext ? [{ type: "text" as const, text: eventContext }] : []),
        ],
        tools: ROCKY_TOOLS,
        messages: loopMessages,
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          fullResponse += event.delta.text;
          send({ content: event.delta.text });
        }
      }

      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") {
        if (!fullResponse) {
          fullResponse = "Sorry, I can't help with that one. Try rephrasing, or ask about a specific RM Roost page or task.";
          send({ content: fullResponse });
        }
        break;
      }
      const toolUses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      // Done, or a tool call cut off at max_tokens (never run a truncated input).
      if (final.stop_reason !== "tool_use" || toolUses.length === 0) break;
      if (round >= MAX_ROCKY_ROUNDS) {
        const note = "\n\nI've run out of checks for this one. Tell me what you'd like me to look at next, or ask me to send it to the RM Roost team.";
        fullResponse += note;
        send({ content: note });
        break;
      }

      // Text between checks reads as separate paragraphs.
      if (fullResponse && !fullResponse.endsWith("\n")) {
        fullResponse += "\n\n";
        send({ content: "\n\n" });
      }
      loopMessages.push({ role: "assistant", content: final.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        send({ status: TOOL_STATUS[call.name] ?? "Checking…" });
        let outcome: { content: string; isError: boolean };
        if (call.name === "create_support_ticket") {
          outcome = await createSupportTicket(
            { clubId: toolClubId, userId, eventId: toolEventId, conversationId: id, appUrl: getAppUrl() },
            call.input,
            diagnostics,
          );
        } else if (toolClubId == null) {
          outcome = { content: "No club to check: this account has no club. Open one of the club's events first.", isError: true };
        } else {
          outcome = await runRockyDiagnosticTool(call.name, call.input, { clubId: toolClubId, eventId: toolEventId });
          diagnostics.push({ tool: call.name, input: call.input, result: outcome.content });
        }
        results.push({ type: "tool_result", tool_use_id: call.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
      }
      // Every result goes back in one user message.
      loopMessages.push({ role: "user", content: results });
    }

    await db.insert(messages).values({
      conversationId: id,
      role: "assistant",
      content: fullResponse,
    });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    req.log.error({ err }, "Anthropic stream error");
    res.write(`data: ${JSON.stringify({ error: "AI request failed. Please try again." })}\n\n`);
    res.end();
  }
});

export default router;
