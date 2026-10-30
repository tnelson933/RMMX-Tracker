/**
 * Where a newly added practice runs: just before the first race (non-practice)
 * moto that hasn't been raced yet, so practice comes before the racing still
 * to come. Practices already queued ahead of that moto keep their place, and
 * with nothing left to race the practice goes at the end. The organizer can
 * still drag it elsewhere afterwards.
 *
 * Shared by the cloud API and the desktop app's local server.
 */
export interface MotoSlot {
  motoNumber: number | null;
  type: string;
  status: string;
}

/** The moto number the first new practice takes; later motos from there move down. */
export function practiceInsertNumber(motos: MotoSlot[]): number {
  const numbered = motos.filter(m => m.motoNumber != null) as Array<MotoSlot & { motoNumber: number }>;
  const nextUnraced = numbered
    .filter(m => m.type !== "practice" && m.status === "scheduled")
    .reduce<number | null>((min, m) => (min == null || m.motoNumber < min ? m.motoNumber : min), null);
  if (nextUnraced != null) return nextUnraced;
  return numbered.reduce((max, m) => Math.max(max, m.motoNumber), 0) + 1;
}
