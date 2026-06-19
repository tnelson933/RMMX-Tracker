import { Router } from "express";
import { db } from "@workspace/db";
import { conversations, messages, eventsTable, motosTable, checkinsTable, usersTable } from "@workspace/db";
import { eq, and, desc, count, asc } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import SYSTEM_PROMPT from "./SYSTEM_PROMPT.md";

const router = Router();

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

  let systemPrompt = SYSTEM_PROMPT;

  if (eventId && Number.isInteger(Number(eventId))) {
    const numericEventId = Number(eventId);

    const [user] = await db
      .select({ clubId: usersTable.clubId })
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    const userClubId = user?.clubId;

    const [event] = userClubId
      ? await db
          .select()
          .from(eventsTable)
          .where(and(eq(eventsTable.id, numericEventId), eq(eventsTable.clubId, userClubId)))
      : [];

    if (event) {
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

      const classes = Array.isArray(event.raceClasses) ? event.raceClasses : [];
      const contextLines: string[] = [
        `## Current Event Context`,
        ``,
        `The organizer currently has the following event open:`,
        ``,
        `- **Event name:** ${event.name}`,
        `- **Date:** ${event.date}`,
        `- **Status:** ${event.status.replace(/_/g, " ")}`,
        `- **Race classes:** ${classes.length > 0 ? classes.join(", ") : "none set"}`,
        `- **Total motos:** ${motoCountRow?.count ?? 0}`,
        `- **Riders checked in:** ${checkinCountRow?.count ?? 0}`,
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

      systemPrompt = contextLines.join("\n") + "\n---\n\n" + SYSTEM_PROMPT;
    }
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let fullResponse = "";

  try {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: systemPrompt,
      messages: chatMessages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        fullResponse += event.delta.text;
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
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
