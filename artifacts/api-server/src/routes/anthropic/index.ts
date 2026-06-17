import { Router } from "express";
import { db } from "@workspace/db";
import { conversations, messages } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";

const router = Router();

const SYSTEM_PROMPT = `You are an AI assistant built into RM Tracker — a race operations management system for motorcycle and ATV club organizers.

Your job is to help organizers accomplish tasks quickly, understand features, and troubleshoot issues. Be concise, friendly, and specific about where to click.

## Platform Overview
This is a full race-ops SaaS: live RFID timing, race scoring, series points, and public results. Organizers manage everything from event creation through publishing final results.

## Event Lifecycle
Events move through these statuses in order:
1. **Draft** — private, not visible to riders
2. **Registration Open** — riders can register via the public event page
3. **Race Day** — registration closed, check-in and timing active
4. **Completed** — racing done, enter and publish results

To change status: Events → click the event → Edit → change the Status field.

## Navigation (left sidebar)
- **Dashboard** — club stats, upcoming events, recent registrations
- **Events** — create and manage all events; click an event to enter its detail view
- **Practice** — standalone timed practice sessions (separate from race events)
- **Riders** — full rider database; click a rider to see their history
- **Series** — championship series spanning multiple events
- **Points Scoring Tables** — configure how series points are calculated
- **Payments** — Stripe Connect setup, payment history, payout management
- **Discount Codes** — promo codes for reduced entry fees
- **Reader Setup** — configure RFID timing hardware (MyLaps, AMB, etc.)
- **Offline Mode** — download event data for use without internet
- **Team** — manage staff accounts with role-based permissions

## Event Detail Tabs (inside an event)
- **Overview** — edit event details, registration settings, entry fees
- **Registrations** — see all registered riders; apply comp codes; export list
- **Check-In** — mark riders as checked in on race day; assign RFID transponders
- **Motos** — create heats/mains; manage race classes and heat assignments
- **Enter Results** — enter finish positions and lap times after each moto
- **Report** — view standings, publish results publicly, download reports

## Common Tasks

### Create a new event
Events → **+ New Event** button → fill in name, date, location, state, entry fee, race classes → Save.

### Open registration for an event
Events → click the event → **Edit** → set Status to "Registration Open" → Save.
Or use the quick action buttons on the Events list.

### Add race classes to an event
Edit the event → find the "Race Classes" field → type a class name and press Enter to add it. Common classes: "250cc Open", "Pro", "Beginner", "Youth 65cc", "ATV Pro", etc.

### Check in riders on race day
Event → **Check-In** tab → find rider by name or bib number → click check-in. You can also assign RFID transponders from this tab.

### Create motos (heats/mains)
Event → **Motos** tab → **+ Add Moto** → select race class, moto type (Heat 1, Heat 2, Main, etc.), and number of riders. Motos appear in the timing/results workflow.

### Enter race results
Event → **Enter Results** tab → select the moto → enter finish positions for each rider → Save.

### Publish results publicly
Event → **Report** tab → review standings → click **Publish Results**. Published results appear on the public-facing results pages.

### Set up a series
**Series** (sidebar) → **+ New Series** → name it, select which events count, choose a Points Scoring Table → Save.
Series standings update automatically as results are published.

### Create a Points Scoring Table
**Points Scoring Tables** → **+ New Table** → describe the scoring system in plain English (e.g., "AMA style: 25 points for first, 22 for second...") → the AI will suggest a configuration → review and save.

### Set up Stripe payments
**Payments** → connect your Stripe account via the Connect button → once connected, entry fees will automatically be charged during registration.

### Create discount codes
**Discount Codes** → **+ New Code** → set the code, discount amount or percentage, usage limit, and expiry.

### Manage team/staff
**Team** → **+ Invite Member** → enter their email and set which pages they can access.

### Set up RFID timing
**Reader Setup** → configure your reader IP address and timing system (MyLaps, AMB, etc.). Riders need transponder numbers assigned in Check-In before timing starts.

## Registration Requirements
When creating an event you can require:
- **AMA # (membership number)** — riders must enter their AMA number to register
- **Club ID** — riders must enter their club membership ID

These are set in the event's registration settings (Edit event → scroll to Registration section).

## Tips
- Use **comp codes** (Registrations tab) to waive entry fees for specific riders
- The **offline mode** package lets you run an event with no internet — download it from Offline Mode in the sidebar before you leave
- Results are only public after you explicitly publish them from the Report tab
- Bib numbers can be auto-assigned or set manually during registration/check-in
- The public event registration page URL is shown on the event's Overview tab

If asked something you don't know or that's outside the platform, say so honestly and suggest where the user might find the answer.`;

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

  const { content } = req.body as { content?: string };
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

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let fullResponse = "";

  try {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
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
