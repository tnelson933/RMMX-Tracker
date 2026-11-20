/**
 * The AI Points Assistant (Points Scoring Tables page): the prompts, and the
 * checks every AI reply passes before it reaches the form. Pure (no network),
 * so the rules are unit-tested; routes/ai.ts makes the API call.
 *
 * The prompts describe what the scoring engine really does (motoPoints.ts,
 * overallOrder.ts), so the AI never "encodes" a rule a table can't hold.
 */
// Same list as scoringTables.SCORING_METHODS (that module loads the database).
const SCORING_METHODS = ["highest_points", "lowest_positions", "per_rider", "formula"] as const;
import { evaluateFormula } from "./safeFormula";
import { AMA_POINTS, OLYMPIC_DNF_MINIMUM, OLYMPIC_DNS_EXTRA } from "./overallOrder";

export type AiScoringMethod = (typeof SCORING_METHODS)[number];

export interface AiPointsTable {
  name: string;
  description: string;
  scoringMethod: AiScoringMethod;
  mainEventOnly: boolean;
  pointsScale: number[];
  scoringFormula: string | null;
  /** A note for the organizer: race structure, or a rule that is automatic / set elsewhere (absent when none). */
  motoNotes?: string;
}

const NAME_MAX = 60;
const SCALE_MAX = 200;

/** What a table can and can't hold. Shared by both prompts. */
const ENGINE_RULES = `How RM Roost scores (fixed rules: a table can't change them, so never try to fake them with a scale or formula):
- A points scale lists points per finishing position: pointsScale[0] = 1st place. On a highest_points table, places past the end of the scale score 0. On a lowest_positions (Olympic) table, places past the end score their position number.
- DNF and DNS score 0 on every points table (highest_points, per_rider, formula). On an Olympic table: DNF = the moto's starters (riders who started), never less than ${OLYMPIC_DNF_MINIMUM}; DNS or a missed moto = starters + ${OLYMPIC_DNS_EXTRA}.
- "riders" / per_rider count the moto's starters (riders who aren't DNS). per_rider: 1st = starters, then one less per place, never below 0.
- Ties are broken automatically: points tables by the better finish in the last moto (series: most wins, then most 2nds, 3rds…, then the final moto of the last round); Olympic by the better last-moto finish. On equal totals a rider who raced the main event beats one who didn't, and a DNF beats a DNS.
- Auto DNF (riders under a % of the leader's laps score as a DNF; the laps needed round up) is a separate club-wide setting on the same page, not part of a table.
- mainEventOnly = true: only races of type "main" score; heats and LCQs score 0.
If the organizer asks for one of these fixed rules (e.g. "DNF gets last-place points", "ties go to the last moto", "auto DNF at 75%"), keep the table to what it can hold and say in motoNotes that the rule is automatic or where to set it.`;

const FIELDS = `{
  "name": "short memorable name (max 40 characters)",
  "description": "1-2 sentences on how this table scores",
  "scoringMethod": "highest_points" | "lowest_positions" | "per_rider" | "formula",
  "mainEventOnly": true | false,
  "pointsScale": [whole numbers of 0 or more, one per finishing position; [] for per_rider and formula],
  "scoringFormula": null, or for "formula" only: an expression using position (1-based) and riders (starters),
  "motoNotes": a short note for the organizer (race structure, or a rule that is automatic / set elsewhere), or null
}`;

const METHOD_RULES = `Scoring methods:
- "highest_points": most points wins. pointsScale[0] is the most points; each later place earns the same or fewer. scoringFormula null.
- "lowest_positions" (Olympic): lowest total wins, like golf. pointsScale is 1, 2, 3 … (each place the same or more). scoringFormula null.
- "per_rider": dynamic by field size (1st = number of starters). pointsScale [], scoringFormula null.
- "formula": custom math. pointsScale [], scoringFormula is the expression. Allowed: numbers, position, riders, + - * / % **, comparisons, && || !, cond ? a : b, Math.abs/ceil/floor/round/trunc/sign/sqrt/cbrt/log/log2/log10/exp/pow/min/max, Math.PI, Math.E. Nothing else. The result is rounded and never below 0.`;

export const SUGGEST_SYSTEM_PROMPT = `You are an expert motorsport race administrator helping club organizers set up points scoring tables for ATV and motorcycle racing in RM Roost.

From the organizer's description of how points should work (and, optionally, how races are structured), return one JSON object with exactly these fields:

${FIELDS}

${METHOD_RULES}

Formats:
- "AMA", "pro motocross", "standard MX": highest_points, mainEventOnly false, the current AMA scale (Pro Motocross and Supercross since 2024): ${AMA_POINTS.join(", ")}.
- "supercross", "SX", "main event only", or heats described as qualifiers: the same AMA scale with mainEventOnly true.
- "enduro", "hare scramble", "special test", "sprint enduro", "ECEA", "WORCS": highest_points, mainEventOnly false, 25, 22, 20, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1.
- "national enduro", "hare and hound", "GNCC pro", "RMEC", "AMA off-road" or "30 for a win": highest_points, mainEventOnly false, 30, 25, 21, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1.
- "GNCC amateur": highest_points, mainEventOnly false, 20, 19, 18 … down to 1 (20 places).
- Enduro races may be called "tests" (special tests); they score like any other race.
- "Olympic", "lowest position", "fewest points": lowest_positions, mainEventOnly false, 1 through 20.
- "per rider", "1 point per rider", "dynamic", "field size": per_rider.
- Custom math ("double points for the top 3", "bonus for the win", "square root"): formula. Examples: "riders - position + 1", "Math.max(0, 50 - position * 2)", "position <= 3 ? (4 - position) * 10 : Math.max(1, 30 - position)".
- A list of points the organizer gives is copied exactly, in order.

${ENGINE_RULES}

Return the JSON object only: no markdown, no text before or after it.`;

export const TWEAK_SYSTEM_PROMPT = `You are an expert motorsport race administrator. An organizer has an existing RM Roost points scoring table and wants a specific change.

You receive the current table and the requested change. Apply ONLY that change; keep every other field exactly as it is unless the change requires it (switching to per_rider or formula empties pointsScale; switching away from formula sets scoringFormula to null).

Return one JSON object with exactly these fields:

${FIELDS}

${METHOD_RULES}

${ENGINE_RULES}

Return the JSON object only: no markdown, no text before or after it.`;

export interface CurrentTableInput {
  name?: unknown;
  description?: unknown;
  scoringMethod?: unknown;
  mainEventOnly?: unknown;
  pointsScale?: unknown;
  scoringFormula?: unknown;
}

/** The user message for an edit: the whole current table, formula included. */
export function tweakUserMessage(current: CurrentTableInput, instruction: string): string {
  const scale = Array.isArray(current.pointsScale) ? current.pointsScale : [];
  return [
    "Current table:",
    `  Name: ${String(current.name ?? "")}`,
    `  Description: ${String(current.description ?? "")}`,
    `  Scoring method: ${String(current.scoringMethod ?? "")}`,
    `  Main event only: ${current.mainEventOnly === true}`,
    `  Points scale: ${scale.length ? scale.join(", ") : "(none)"}`,
    `  Scoring formula: ${typeof current.scoringFormula === "string" && current.scoringFormula.trim() ? current.scoringFormula.trim() : "(none)"}`,
    "",
    `Change requested: ${instruction}`,
  ].join("\n");
}

/** The JSON object in a reply, even when wrapped in a code fence or a sentence. */
function extractJson(text: string): unknown {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try { return JSON.parse(unfenced); } catch { /* fall through */ }
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(unfenced.slice(start, end + 1)); } catch { return undefined; }
}

/** A whole number of 0 or more (numeric strings like "25" count). */
function wholePoints(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : null;
}

/**
 * Check an AI reply and turn it into a table the form and the scoring engine
 * accept, or say (in the organizer's words) why it can't be used.
 */
export function parseAiPointsTable(text: string): { table: AiPointsTable } | { error: string } {
  const raw = extractJson(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "The AI's answer couldn't be read. Try rephrasing your description." };
  }
  const r = raw as Record<string, unknown>;

  const scoringMethod = r.scoringMethod as AiScoringMethod;
  if (!(SCORING_METHODS as readonly unknown[]).includes(scoringMethod)) {
    return { error: "The AI didn't pick a scoring method. Say whether most points wins, lowest score wins, per rider, or a formula." };
  }
  const name = typeof r.name === "string" ? r.name.trim().slice(0, NAME_MAX) : "";
  if (!name) return { error: "The AI's answer was incomplete. Try adding more detail." };
  const description = typeof r.description === "string" ? r.description.trim() : "";
  const note = typeof r.motoNotes === "string" ? r.motoNotes.trim() : "";
  const motoNotes = note ? { motoNotes: note } : {};
  const mainEventOnly = r.mainEventOnly === true;

  if (scoringMethod === "per_rider") {
    return { table: { name, description, scoringMethod, mainEventOnly, pointsScale: [], scoringFormula: null, ...motoNotes } };
  }

  if (scoringMethod === "formula") {
    const formula = typeof r.scoringFormula === "string" ? r.scoringFormula.trim() : "";
    if (!formula) return { error: "The AI chose a formula but didn't write one. Describe the math you want." };
    // The formula must evaluate for any finish the engine will score.
    try {
      for (const riders of [1, 5, 20, 40]) {
        for (let position = 1; position <= riders; position++) {
          const v = evaluateFormula(formula, { position, riders });
          if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`no number for ${position} of ${riders}`);
        }
      }
    } catch (err) {
      return { error: `The AI wrote a formula RM Roost can't use (${(err as Error).message}). Try describing the math another way.` };
    }
    return { table: { name, description, scoringMethod, mainEventOnly, pointsScale: [], scoringFormula: formula, ...motoNotes } };
  }

  // highest_points / lowest_positions: a list of whole points per place.
  if (!Array.isArray(r.pointsScale) || r.pointsScale.length === 0) {
    return { error: "The AI didn't list any points. Say how many points each place earns." };
  }
  if (r.pointsScale.length > SCALE_MAX) return { error: `A points table can list at most ${SCALE_MAX} places.` };
  const pointsScale: number[] = [];
  for (const v of r.pointsScale) {
    const p = wholePoints(v);
    if (p == null) return { error: "The AI listed points that aren't whole numbers of 0 or more. Try again." };
    pointsScale.push(p);
  }
  const ordered = scoringMethod === "highest_points"
    ? pointsScale.every((p, i) => i === 0 || p <= pointsScale[i - 1])
    : pointsScale.every((p, i) => i === 0 || p >= pointsScale[i - 1]);
  if (!ordered) {
    return {
      error: scoringMethod === "highest_points"
        ? "The AI's scale gave a lower place more points than a higher one. Try again, or list the points yourself."
        : "On a lowest-score table each place must score the same or more than the one before. Try again.",
    };
  }
  return { table: { name, description, scoringMethod, mainEventOnly, pointsScale, scoringFormula: null, ...motoNotes } };
}

/**
 * The reply's text, or why there is none to use: the API stops early on
 * refusals and when it runs out of room.
 */
export function aiReplyText(data: { stop_reason?: string | null; content?: Array<{ type: string; text?: string }> }): { text: string } | { error: string } {
  if (data.stop_reason === "refusal") return { error: "The AI helper declined that request. Try describing the scoring another way." };
  if (data.stop_reason === "max_tokens") return { error: "The AI's answer was cut off. Try a shorter description." };
  const text = (data.content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join("").trim();
  return text ? { text } : { error: "The AI's answer was empty. Try again." };
}
