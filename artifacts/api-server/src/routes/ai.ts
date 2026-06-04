import { Router } from "express";

const router = Router();

const ANTHROPIC_BASE_URL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
const ANTHROPIC_API_KEY = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are an expert motorsport race administrator helping club organizers configure points scoring tables for ATV and motorcycle races.

When given a natural language description of how points should work and how motos should be structured, you must return a single JSON object with exactly these fields:

{
  "name": "short memorable name for this scoring system (max 40 chars)",
  "description": "clear 1-2 sentence explanation of how this system works",
  "scoringMethod": "highest_points" or "lowest_positions" or "per_rider" or "formula",
  "mainEventOnly": true or false,
  "pointsScale": [array of numbers, one per position, or empty array [] for per_rider/formula],
  "scoringFormula": null or "a JS expression string using position (1-based) and riders (total starters)",
  "motoNotes": "brief explanation of how motos/heats should be structured based on their description"
}

Rules:
- scoringMethod "highest_points": winner gets the most points (e.g. 25, 22, 20...). pointsScale[0] is 1st place points (highest). scoringFormula = null.
- scoringMethod "lowest_positions": lower total is better, like golf (e.g. 1, 2, 3...). pointsScale[0] = 1 (1st place = 1 point). scoringFormula = null.
- scoringMethod "per_rider": fully dynamic — 1st place gets N points where N = total number of riders who started, 2nd gets N-1, last place gets 1. pointsScale = []. scoringFormula = null. Use when user says "1 point per rider", "dynamic", "based on field size".
- scoringMethod "formula": use a custom JS expression. pointsScale = []. scoringFormula = the expression string. Variables available: position (1-based integer), riders (total starters integer). Use Math functions freely. Result is clamped to >= 0 and rounded. Use this when the user describes any custom math that doesn't fit the other methods.
- mainEventOnly = true means only the final/main event moto counts for championship points (Supercross style). Use this when the user describes heats as qualifiers or mentions a "main event".
- mainEventOnly = false means all motos/divisions count toward the championship total (AMA/Olympic multi-moto style).
- If user says "like AMA" or "standard MX" → highest_points, mainEventOnly false, scale like 25, 22, 20, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1
- If user says "like Supercross" or "main event only" → highest_points, mainEventOnly true, same scale
- If user says "Olympic" or "lowest position" or "fewest points" → lowest_positions, mainEventOnly false, scale 1-20
- If user says "per rider", "1 point per rider", "dynamic", or "field size" → per_rider, pointsScale [], scoringFormula null
- If user describes custom math (e.g. "double points for top 3", "square root", "bonus points") → formula, provide the expression
- Formula examples: "riders - position + 1" (same as per_rider), "Math.max(0, 50 - position * 2)", "position <= 3 ? (4 - position) * 10 : Math.max(1, 30 - position)"
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

    const needsScale = parsed.scoringMethod === "highest_points" || parsed.scoringMethod === "lowest_positions";
    if (
      !parsed.name ||
      !parsed.scoringMethod ||
      !Array.isArray(parsed.pointsScale) ||
      (needsScale && parsed.pointsScale.length === 0)
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

const TWEAK_SYSTEM_PROMPT = `You are an expert motorsport race administrator. The user has an existing points scoring table and wants to make specific changes to it.

You will receive the current table configuration and a natural language instruction describing what to change.

Apply ONLY the requested changes. Keep everything else the same unless the change logically requires updating other fields.

Return a single JSON object with exactly these fields:
{
  "name": "table name (update only if the change warrants it)",
  "description": "updated description reflecting the change",
  "scoringMethod": "highest_points" or "lowest_positions",
  "mainEventOnly": true or false,
  "pointsScale": [array of numbers, one per position],
  "motoNotes": null
}

Rules:
- scoringMethod "highest_points": winner gets most points, pointsScale[0] is highest (1st place)
- scoringMethod "lowest_positions": lower total is better, pointsScale[0] = 1
- Always return valid JSON only. No markdown, no explanation outside the JSON.`;

router.post("/ai/tweak-points-table", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  if (!ANTHROPIC_BASE_URL || !ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "AI integration not configured" });
    return;
  }

  const { instruction, currentTable } = req.body as {
    instruction?: string;
    currentTable?: {
      name: string;
      description: string;
      scoringMethod: string;
      mainEventOnly: boolean;
      pointsScale: number[];
    };
  };

  if (!instruction?.trim()) {
    res.status(400).json({ error: "instruction is required" });
    return;
  }
  if (!currentTable || !Array.isArray(currentTable.pointsScale)) {
    res.status(400).json({ error: "currentTable is required" });
    return;
  }

  const userMessage = [
    `Current table:`,
    `  Name: ${currentTable.name}`,
    `  Description: ${currentTable.description}`,
    `  Scoring method: ${currentTable.scoringMethod}`,
    `  Main event only: ${currentTable.mainEventOnly}`,
    `  Points scale: ${currentTable.pointsScale.join(", ")}`,
    ``,
    `Change requested: ${instruction.trim()}`,
  ].join("\n");

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
        system: TWEAK_SYSTEM_PROMPT,
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
    const text = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

    let parsed: {
      name: string;
      description: string;
      scoringMethod: "highest_points" | "lowest_positions";
      mainEventOnly: boolean;
      pointsScale: number[];
      motoNotes?: string | null;
    };

    try {
      parsed = JSON.parse(text);
    } catch {
      req.log.error({ text }, "Failed to parse AI JSON response");
      res.status(500).json({ error: "AI returned an unreadable response. Try rephrasing your instruction." });
      return;
    }

    const needsScale2 = parsed.scoringMethod === "highest_points" || parsed.scoringMethod === "lowest_positions";
    if (
      !parsed.name ||
      !parsed.scoringMethod ||
      !Array.isArray(parsed.pointsScale) ||
      (needsScale2 && parsed.pointsScale.length === 0)
    ) {
      res.status(500).json({ error: "AI response was incomplete. Try adding more detail." });
      return;
    }

    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "AI tweak-points-table error");
    res.status(500).json({ error: "AI request failed. Please try again." });
  }
});

export default router;
