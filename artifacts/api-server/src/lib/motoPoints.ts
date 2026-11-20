/**
 * Points for race results under a scoring table (pure: no database). Shared by
 * the moto scorer, the manual results save and series scoring.
 */
import { formulaPoints } from "./safeFormula";
import { AMA_POINTS, isLowerBetter, olympicPenalty } from "./overallOrder";

/** No scoring table: the current AMA scale (see lib/overallOrder.ts). */
export const FALLBACK_POINTS = AMA_POINTS;

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

/** An event's scoring table and its club's Auto DNF setting. */
export interface MotoScoringSettings {
  scoringMethod: string;
  pointsScale: number[];
  scoringFormula: string | null;
  mainEventOnly: boolean;
  autoDnfEnabled?: boolean;
  autoDnfThreshold?: number;
}

/** One stored result of a moto. */
export interface MotoPointsRow {
  id: number;
  position: number;
  dnf: boolean | null;
  dns: boolean | null;
  lapTimes: unknown;
}

/**
 * Points for every result of one finished moto from its stored finishing
 * order. Starters are the riders who aren't DNS; the leader (for Auto DNF) is
 * the rider in 1st who finished.
 */
export function scoreMotoRows(rows: MotoPointsRow[], settings: MotoScoringSettings, motoType: string): Map<number, number> {
  const totalStarters = rows.filter(r => !r.dns).length;
  const lapsOf = (r: MotoPointsRow) => (Array.isArray(r.lapTimes) ? r.lapTimes.length : 0);
  const leader = rows.find(r => r.position === 1 && !r.dnf && !r.dns);
  const leaderLapsCompleted = settings.autoDnfEnabled && leader ? lapsOf(leader) : undefined;
  const points = new Map<number, number>();
  for (const r of rows) {
    points.set(r.id, calcPoints({
      position: r.position,
      dnf: !!r.dnf,
      dns: !!r.dns,
      totalStarters,
      classSize: rows.length,
      ...settings,
      motoType,
      lapsCompleted: lapsOf(r),
      leaderLapsCompleted,
    }));
  }
  return points;
}

/** Did an event edit change its Scoring Format (none and "" are the same: the AMA scale)? */
export function scoringFormatChanged(before: unknown, after: unknown): boolean {
  const id = (v: unknown) => (v == null || v === "" ? null : Number(v));
  return id(before) !== id(after);
}

/**
 * A moto whose results arrived from the desktop app needs its points worked
 * out here: the upload carries positions, laps and DNF/DNS but not points.
 * Only finished races score (practice never does; a race still running is
 * scored when it finishes).
 */
export function motoNeedsScoringAfterPush(moto: { type: string | null; status: string | null } | undefined): boolean {
  return !!moto && moto.status === "completed" && moto.type !== "practice";
}

/** What decides a result's points: two tables with the same values score the same. */
export interface ScoringStyle {
  scoringMethod: string;
  pointsScale: number[];
  scoringFormula: string | null;
  mainEventOnly: boolean;
}

/**
 * Do two scoring styles give every finish the same points? No table means the
 * AMA scale, so it matches a Highest Points table holding that scale. Trailing
 * zeros in a scale don't matter (a place past the end scores 0 anyway).
 */
export function scoringStylesMatch(a: ScoringStyle, b: ScoringStyle): boolean {
  const norm = (s: ScoringStyle) => {
    const known = ["highest_points", "lowest_positions", "per_rider", "formula"].includes(s.scoringMethod);
    const method = known ? s.scoringMethod : "highest_points";
    let scale = method === "highest_points" || method === "lowest_positions" ? [...(known ? s.pointsScale ?? [] : FALLBACK_POINTS)] : [];
    if (method === "highest_points") while (scale.length && scale[scale.length - 1] === 0) scale = scale.slice(0, -1);
    return JSON.stringify([method, scale, method === "formula" ? (s.scoringFormula ?? "").replace(/\s+/g, "") : "", !!s.mainEventOnly]);
  };
  return norm(a) === norm(b);
}

/**
 * Do a race's stored positions need working out again? Not when they already
 * are a complete finishing order: every place from 1 to the number of results,
 * each used once. (Live timing's placeholder 999, a gap or a repeated place
 * means the order is unfinished.)
 */
export function positionsNeedSorting(positions: number[]): boolean {
  const seen = new Set(positions);
  if (seen.size !== positions.length) return true;
  for (let p = 1; p <= positions.length; p++) if (!seen.has(p)) return true;
  return false;
}
