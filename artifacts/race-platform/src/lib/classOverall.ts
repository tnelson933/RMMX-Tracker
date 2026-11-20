import { compareOverall, olympicPenalty, overallPositions, type OverallRow } from "./overallOrder";

type ResultLike = {
  riderId: number;
  motoId: number;
  position: number | null;
  points?: number | null;
  dnf?: boolean | null;
  dns?: boolean | null;
};

/** A class's finished races (practice excluded) in running order: moto number, then id. */
export function finishedMotoOrder(
  motos: Array<{ id: number; motoNumber?: number | null; status?: string | null; type?: string | null; raceClass?: string | null }>,
  raceClass: string,
): number[] {
  return motos
    .filter(m => m.raceClass === raceClass && m.status === "completed" && m.type !== "practice")
    .sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0) || a.id - b.id)
    .map(m => m.id);
}


/**
 * One class's overall standings for an event from its moto results (the same
 * rules as the server, lib/overallOrder.ts): points tables add points, highest
 * first; Olympic tables add finishing scores with DNF/DNS/missed-moto
 * penalties, lowest first, ties to the better last-moto finish.
 * `motoOrder` lists the class's finished motos in running order.
 */
export function rankClassOverall<T extends ResultLike>(
  rows: T[],
  lowerIsBetter: boolean,
  motoOrder?: number[],
): Array<{ result: T; total: number; position: number }> {
  const motoIds = motoOrder ?? [...new Set(rows.map(r => r.motoId))].sort((a, b) => a - b);
  const classSize = new Map<number, number>();
  for (const r of rows) classSize.set(r.motoId, (classSize.get(r.motoId) ?? 0) + 1);

  const byRider = new Map<number, T[]>();
  for (const r of rows) {
    if (!byRider.has(r.riderId)) byRider.set(r.riderId, []);
    byRider.get(r.riderId)!.push(r);
  }

  const entries = [...byRider.values()].map(mine => {
    let total = 0;
    let lastMotoFinish: number | null = null;
    let finishedAny = false;
    for (const motoId of motoIds) {
      const r = mine.find(x => x.motoId === motoId);
      const out = !r || r.dnf || r.dns;
      if (lowerIsBetter) {
        total += !r || r.dns ? olympicPenalty("dns", classSize.get(motoId) ?? 0)
          : r.dnf ? olympicPenalty("dnf", classSize.get(motoId) ?? 0)
          : r.points ?? r.position ?? 0;
      } else if (r && !r.dnf && !r.dns) {
        total += r.points ?? 0;
      }
      lastMotoFinish = out ? null : r!.position ?? null;
      if (!out) finishedAny = true;
    }
    const order: OverallRow = { total, finishedAny, lastMotoFinish };
    const best = Math.min(...mine.filter(r => !r.dnf && !r.dns).map(r => r.position ?? 999), 999);
    return { result: mine[0], total, order, best };
  });

  // Points tables with no points yet (heats before a Supercross main): order
  // by best finish, as the server does.
  const hasPoints = lowerIsBetter || rows.some(r => (r.points ?? 0) > 0);
  entries.sort((a, b) => (hasPoints ? compareOverall(a.order, b.order, lowerIsBetter) : 0) || a.best - b.best);
  const positions = hasPoints ? overallPositions(entries.map(e => e.order), lowerIsBetter) : entries.map((_, i) => i + 1);
  return entries.map((e, i) => ({ result: e.result, total: e.total, position: positions[i] }));
}
