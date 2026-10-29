import { db, pointsTablesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { formulaPoints } from "./safeFormula";
import { isLowerBetter, olympicPenalty } from "./overallOrder";

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

export const FALLBACK_POINTS = [25, 22, 20, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

/** Points for one result under a scoring table (shared by event and series scoring). */
export function calcPoints(opts: {
  position: number;
  dnf: boolean;
  dns: boolean;
  totalStarters: number;
  scoringMethod: string;
  pointsScale: number[];
  scoringFormula: string | null;
  mainEventOnly: boolean;
  motoType: string;
  autoDnfEnabled?: boolean;
  autoDnfThreshold?: number;
  lapsCompleted?: number;
  leaderLapsCompleted?: number;
  /** Riders in the class for this moto (Olympic DNF/DNS scores); defaults to the starters. */
  classSize?: number;
}): number {
  if (opts.mainEventOnly && opts.motoType !== "main") return 0;
  // Olympic (lowest wins): a DNF or DNS scores a penalty, not 0 (lib/overallOrder.ts).
  const olympic = isLowerBetter(opts.scoringMethod);
  const classSize = opts.classSize ?? opts.totalStarters;
  if (opts.dns) return olympic ? olympicPenalty("dns", classSize) : 0;
  if (opts.dnf) return olympic ? olympicPenalty("dnf", classSize) : 0;

  // Auto DNF: rider completed too few laps vs the leader → treat as DNF for scoring
  if (
    opts.autoDnfEnabled &&
    opts.leaderLapsCompleted != null &&
    opts.leaderLapsCompleted > 0 &&
    opts.lapsCompleted != null &&
    opts.autoDnfThreshold != null
  ) {
    const minLaps = Math.floor(opts.leaderLapsCompleted * opts.autoDnfThreshold / 100);
    if (opts.lapsCompleted < minLaps) return olympic ? olympicPenalty("dnf", classSize) : 0;
  }

  switch (opts.scoringMethod) {
    case "formula":
      if (!opts.scoringFormula) return 0;
      return formulaPoints(opts.scoringFormula, opts.position, opts.totalStarters);
    case "per_rider":
      return Math.max(0, opts.totalStarters - opts.position + 1);
    case "highest_points":
      return opts.pointsScale[opts.position - 1] ?? 0;
    case "lowest_positions":
      return opts.pointsScale[opts.position - 1] ?? opts.position;
    default:
      return FALLBACK_POINTS[opts.position - 1] ?? 0;
  }
}

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
