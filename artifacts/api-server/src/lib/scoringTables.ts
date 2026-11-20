import { db, pointsTablesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { evaluateFormula } from "./safeFormula";

export const SCORING_METHODS = ["highest_points", "lowest_positions", "per_rider", "formula"] as const;

/**
 * An event or series may use a system scoring table or one of its own club's.
 * Another club's table would let that club's edits change this club's scoring.
 */
export async function scoringTableUsable(tableId: unknown, clubId: number): Promise<boolean> {
  if (tableId == null || tableId === "") return true;
  const [table] = await db.select({ clubId: pointsTablesTable.clubId })
    .from(pointsTablesTable).where(eq(pointsTablesTable.id, Number(tableId)));
  return !!table && (table.clubId == null || table.clubId === clubId);
}

/** Points must be whole, non-negative numbers, one per finishing position. */
export function pointsScaleError(scale: unknown): string | null {
  if (!Array.isArray(scale)) return "pointsScale must be a list of points";
  if (scale.length > 200) return "pointsScale can list at most 200 positions";
  if (!scale.every(v => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100_000)) {
    return "Points must be whole numbers of 0 or more";
  }
  return null;
}

export function scoringMethodError(method: unknown): string | null {
  return (SCORING_METHODS as readonly unknown[]).includes(method)
    ? null
    : `scoringMethod must be one of: ${SCORING_METHODS.join(", ")}`;
}

/** Reject formulas the points engine can't evaluate, so a bad one doesn't silently score 0. */
export function formulaError(formula: unknown): string | null {
  if (formula == null || formula === "") return null;
  if (typeof formula !== "string") return "scoringFormula must be a string";
  try {
    evaluateFormula(formula, { position: 1, riders: 10 });
    return null;
  } catch (err) {
    return `Invalid scoring formula: ${(err as Error).message}. Use position, riders, numbers, + - * / % **, comparisons, ?:, and Math functions.`;
  }
}

// The points rules are pure and live in lib/motoPoints.ts.
export { FALLBACK_POINTS, calcPoints } from "./motoPoints";

/** A series' scoring table settings, or the default 25-22-20... scale. */
export async function loadSeriesScoring(scoringTableId: number | null): Promise<{
  scoringMethod: string;
  pointsScale: number[];
  scoringFormula: string | null;
  mainEventOnly: boolean;
}> {
  if (scoringTableId) {
    const [tbl] = await db.select().from(pointsTablesTable).where(eq(pointsTablesTable.id, scoringTableId));
    if (tbl) {
      return {
        scoringMethod: tbl.scoringMethod,
        pointsScale: (tbl.pointsScale as number[]) ?? [],
        scoringFormula: tbl.scoringFormula ?? null,
        mainEventOnly: tbl.mainEventOnly,
      };
    }
  }
  return { scoringMethod: "fallback", pointsScale: [], scoringFormula: null, mainEventOnly: false };
}
