import { Router } from "express";
import { SUGGEST_SYSTEM_PROMPT, TWEAK_SYSTEM_PROMPT, aiReplyText, parseAiPointsTable, tweakUserMessage, type CurrentTableInput } from "../lib/pointsTableAi";

const router = Router();

// Replit's AI proxy vars are honored for compatibility; elsewhere ANTHROPIC_API_KEY
// is used against Anthropic's API (same rule as @workspace/integrations-anthropic-ai).
const ANTHROPIC_BASE_URL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || "https://api.anthropic.com";
const ANTHROPIC_API_KEY = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;

router.post("/ai/suggest-points-table", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) { res.status(401).json({ error: "You're signed out. Sign in again, then try once more." }); return; }

  if (!ANTHROPIC_BASE_URL || !ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "The AI helper isn't available right now. Try again later." });
    return;
  }

  const { scoringDescription, motoDescription } = req.body as {
    scoringDescription?: string;
    motoDescription?: string;
  };

  if (!scoringDescription?.trim()) {
    res.status(400).json({ error: "Describe how you want scoring to work." });
    return;
  }

  const userMessage = [
    `Scoring description: ${scoringDescription.trim()}`,
    motoDescription?.trim() ? `Moto structure description: ${motoDescription.trim()}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        // Thinking shares this room with the answer.
        max_tokens: 8000,
        output_config: { effort: "low" },
        system: SUGGEST_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      req.log.error({ err }, "Anthropic API error");
      res.status(500).json({ error: "The AI helper didn't respond. Try again in a moment." });
      return;
    }

    const reply = aiReplyText(await response.json() as Parameters<typeof aiReplyText>[0]);
    if ("error" in reply) { res.status(500).json({ error: reply.error }); return; }
    const parsed = parseAiPointsTable(reply.text);
    if ("error" in parsed) {
      req.log.warn({ text: reply.text.slice(0, 2000) }, "AI points table reply rejected");
      res.status(500).json({ error: parsed.error });
      return;
    }
    res.json(parsed.table);
  } catch (err) {
    req.log.error({ err }, "AI suggest-points-table error");
    res.status(500).json({ error: "The AI helper didn't respond. Try again in a moment." });
  }
});

router.post("/ai/tweak-points-table", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) { res.status(401).json({ error: "You're signed out. Sign in again, then try once more." }); return; }

  if (!ANTHROPIC_BASE_URL || !ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "The AI helper isn't available right now. Try again later." });
    return;
  }

  const { instruction, currentTable } = req.body as { instruction?: string; currentTable?: CurrentTableInput };

  if (!instruction?.trim()) {
    res.status(400).json({ error: "Type what you want to change." });
    return;
  }
  if (!currentTable || typeof currentTable !== "object") {
    res.status(400).json({ error: "Something was missing from that request. Refresh the page and try again." });
    return;
  }

  const userMessage = tweakUserMessage(currentTable, instruction.trim());

  try {
    const response = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        // Thinking shares this room with the answer.
        max_tokens: 8000,
        output_config: { effort: "low" },
        system: TWEAK_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      req.log.error({ err }, "Anthropic API error");
      res.status(500).json({ error: "The AI helper didn't respond. Try again in a moment." });
      return;
    }

    const reply = aiReplyText(await response.json() as Parameters<typeof aiReplyText>[0]);
    if ("error" in reply) { res.status(500).json({ error: reply.error }); return; }
    const parsed = parseAiPointsTable(reply.text);
    if ("error" in parsed) {
      req.log.warn({ text: reply.text.slice(0, 2000) }, "AI points table reply rejected");
      res.status(500).json({ error: parsed.error });
      return;
    }
    res.json(parsed.table);
  } catch (err) {
    req.log.error({ err }, "AI tweak-points-table error");
    res.status(500).json({ error: "The AI helper didn't respond. Try again in a moment." });
  }
});

export default router;
