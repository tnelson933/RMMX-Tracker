import { Router } from "express";

const router = Router();

const ANTHROPIC_BASE_URL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
const ANTHROPIC_API_KEY = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are an expert motorsport race administrator helping club organizers configure points scoring tables for ATV and motorcycle races.

When given a natural language description of how points should work and how motos should be structured, you must return a single JSON object with exactly these fields:

{
  "name": "short memorable name for this scoring system (max 40 chars)",
  "description": "clear 1-2 sentence explanation of how this system works",
  "scoringMethod": "highest_points" or "lowest_positions",
  "mainEventOnly": true or false,
  "pointsScale": [array of numbers, one per position, descending or ascending based on method],
  "motoNotes": "brief explanation of how motos/heats should be structured based on their description"
}

Rules:
- scoringMethod "highest_points": winner gets the most points (e.g. 25, 22, 20...). pointsScale[0] is 1st place points (highest).
- scoringMethod "lowest_positions": lower total is better, like golf (e.g. 1, 2, 3...). pointsScale[0] = 1 (1st place = 1 point).
- mainEventOnly = true means only the final/main event moto counts for championship points (Supercross style). Use this when the user describes heats as qualifiers or mentions a "main event".
- mainEventOnly = false means all motos/divisions count toward the championship total (AMA/Olympic multi-moto style).
- If user says "like AMA" or "standard MX" → highest_points, mainEventOnly false, scale like 25, 22, 20, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1
- If user says "like Supercross" or "main event only" → highest_points, mainEventOnly true, same scale
- If user says "Olympic" or "lowest position" or "fewest points" → lowest_positions, mainEventOnly false, scale 1-20
- Always return valid JSON only. No markdown, no explanation outside the JSON.`;

router.post("/ai/suggest-points-table", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  if (!ANTHROPIC_BASE_URL || !ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "AI integration not configured" });
    return;
  }

  const { scoringDescription, motoDescription } = req.body as {
    scoringDescription?: string;
    motoDescription?: string;
  };

  if (!scoringDescription?.trim()) {
    res.status(400).json({ error: "scoringDescription is required" });
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
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      req.log.error({ err }, "Anthropic API error");
      res.status(500).json({ error: "AI request failed" });
      return;
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };

    const rawText = data.content.find((b) => b.type === "text")?.text ?? "";
    // Strip markdown code fences if the model wrapped the JSON
    const text = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

    let parsed: {
      name: string;
      description: string;
      scoringMethod: "highest_points" | "lowest_positions";
      mainEventOnly: boolean;
      pointsScale: number[];
      motoNotes?: string;
    };

    try {
      parsed = JSON.parse(text);
    } catch {
      req.log.error({ text }, "Failed to parse AI JSON response");
      res.status(500).json({ error: "AI returned an unreadable response. Try rephrasing your description." });
      return;
    }

    if (
      !parsed.name ||
      !parsed.scoringMethod ||
      !Array.isArray(parsed.pointsScale) ||
      parsed.pointsScale.length === 0
    ) {
      res.status(500).json({ error: "AI response was incomplete. Try adding more detail to your description." });
      return;
    }

    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "AI suggest-points-table error");
    res.status(500).json({ error: "AI request failed. Please try again." });
  }
});

export default router;
