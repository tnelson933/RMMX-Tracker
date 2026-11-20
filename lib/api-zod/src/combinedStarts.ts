/**
 * Combined starts: two or more small classes leave the same gate together and
 * are scored separately. Pure planner shared by the cloud API and the
 * desktop's offline server (each one's routes/motos.ts links the motos), so
 * both combine the same classes for the same schedule.
 *
 * Each class keeps its own moto, lineup, results, points and overall, exactly
 * as when it runs alone. A combined start only links those motos into one
 * start group (the same link a staggered start uses) so they start and finish
 * together and each rider's laps go to their own class's moto.
 */

export interface CombineCandidate {
  id: number;
  raceClass: string;
  /** heat, main, lcq … only motos of the same type are combined. */
  type: string;
  motoNumber: number;
  status: string;
  /** Already in a staggered or combined group. */
  grouped: boolean;
  /** Rider ids on the lineup. */
  riderIds: number[];
}

const RACE_TYPES_NOT_COMBINED = new Set(["practice", "enduro_test"]);

/**
 * Which round of its class each moto is (1 = the class's first moto of that
 * type, 2 = its second …), so Moto 1s are combined with Moto 1s.
 */
export function motoRounds(motos: Array<Pick<CombineCandidate, "id" | "raceClass" | "type" | "motoNumber">>): Map<number, number> {
  const rounds = new Map<number, number>();
  const seen = new Map<string, number>();
  for (const m of [...motos].sort((a, b) => a.motoNumber - b.motoNumber || a.id - b.id)) {
    const key = `${m.type}|${m.raceClass}`;
    const round = (seen.get(key) ?? 0) + 1;
    seen.set(key, round);
    rounds.set(m.id, round);
  }
  return rounds;
}

/** Why these motos can't share a gate, or null when they can. */
export function combineProblem(motos: CombineCandidate[], gateSize?: number | null): string | null {
  if (motos.length < 2) return "Pick at least 2 races to combine.";
  if (motos.some(m => RACE_TYPES_NOT_COMBINED.has(m.type))) return "Practice sessions and enduro tests can't be combined.";
  if (motos.some(m => m.status !== "scheduled")) return "Only races that haven't started can be combined.";
  const seen = new Map<number, string>();
  for (const m of motos) {
    for (const riderId of m.riderIds) {
      const other = seen.get(riderId);
      if (other && other !== m.raceClass) {
        return `A rider is entered in both ${other} and ${m.raceClass}, so those two can't start together: their laps couldn't be told apart.`;
      }
      seen.set(riderId, m.raceClass);
    }
  }
  const riders = motos.reduce((n, m) => n + m.riderIds.length, 0);
  if (gateSize != null && gateSize > 0 && riders > gateSize) {
    return `These races have ${riders} riders together, more than the ${gateSize} gate spots.`;
  }
  return null;
}

/**
 * Groups of motos to start together so each group fits the gate. Per round
 * and moto type: classes are taken biggest first and placed with the fullest
 * group they still fit in (and share no rider with); a class that already
 * fills more than the gate, or fits with nobody, runs alone. Returns only
 * groups of two or more, each in run order.
 */
export function planCombinedStarts(motos: CombineCandidate[], gateSize: number): number[][] {
  if (!(gateSize > 1)) return [];
  const eligible = motos.filter(m => !RACE_TYPES_NOT_COMBINED.has(m.type) && m.status === "scheduled" && !m.grouped && m.riderIds.length > 0);
  // Rounds are counted over every race moto, so a class whose Moto 1 already ran still lines up.
  const rounds = motoRounds(motos.filter(m => !RACE_TYPES_NOT_COMBINED.has(m.type)));
  const buckets = new Map<string, CombineCandidate[]>();
  for (const m of eligible) {
    const key = `${m.type}|${rounds.get(m.id) ?? 1}`;
    buckets.set(key, [...(buckets.get(key) ?? []), m]);
  }

  const groups: CombineCandidate[][] = [];
  for (const bucket of buckets.values()) {
    const bins: Array<{ motos: CombineCandidate[]; riders: number; riderIds: Set<number> }> = [];
    const bySize = [...bucket].sort((a, b) => b.riderIds.length - a.riderIds.length || a.motoNumber - b.motoNumber || a.id - b.id);
    for (const m of bySize) {
      if (m.riderIds.length >= gateSize) continue; // a full gate on its own
      const fits = bins
        .filter(b => b.riders + m.riderIds.length <= gateSize && !m.riderIds.some(id => b.riderIds.has(id)))
        .sort((a, b) => b.riders - a.riders)[0];
      if (fits) {
        fits.motos.push(m);
        fits.riders += m.riderIds.length;
        for (const id of m.riderIds) fits.riderIds.add(id);
      } else {
        bins.push({ motos: [m], riders: m.riderIds.length, riderIds: new Set(m.riderIds) });
      }
    }
    for (const b of bins) if (b.motos.length >= 2) groups.push(b.motos);
  }
  return groups
    .map(g => [...g].sort((a, b) => a.motoNumber - b.motoNumber || a.id - b.id))
    .sort((a, b) => a[0].motoNumber - b[0].motoNumber || a[0].id - b[0].id)
    .map(g => g.map(m => m.id));
}
