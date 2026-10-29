import { compareOverall, olympicPenalty, overallPositions, type OverallRow } from "./overallOrder";

type ResultLike = {
  riderId: number;
  motoId: number;
  position: number | null;
  points?: number | null;
  dnf?: boolean | null;
  dns?: boolean | null;
};

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
      } else if (r) {
        total += r.points ?? 0;
      }
      lastMotoFinish = out ? null : r!.position ?? null;
      if (!out) finishedAny = true;
    }
    const order: OverallRow = { total, finishedAny, lastMotoFinish };
    const best = Math.min(...mine.filter(r => !r.dnf && !r.dns).map(r => r.position ?? 999), 999);
    return { result: mine[0], total, order, best };
  });

  entries.sort((a, b) => compareOverall(a.order, b.order, lowerIsBetter) || a.best - b.best);
  const positions = overallPositions(entries.map(e => e.order), lowerIsBetter);
  return entries.map((e, i) => ({ result: e.result, total: e.total, position: positions[i] }));
}
