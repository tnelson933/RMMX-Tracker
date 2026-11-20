/**
 * Racer profile extras built from a rider's results: big wins, the tracks and
 * states they've raced, extra career numbers, a filterable results history,
 * and who to suggest following. Pure functions (no database), tested in
 * riderProfilePlus.test.ts. The loaders are in riderCareer.ts.
 *
 * Like the résumé (riderResume.ts), every line comes from timing data with
 * fixed rules, so it can't be faked.
 */

const FINISH_SENTINEL = 999;

/** A "big win": a race won against at least this many starters. */
export const BIG_WIN_FIELD = 10;

export interface ExtrasMoto {
  motoId: number;
  motoType: string | null;
  motoName: string;
  position: number;
  dnf: boolean;
  dns: boolean;
  eventId: number;
  eventName: string;
  /** "YYYY-MM-DD" (or longer ISO). */
  eventDate: string;
  raceClass: string;
  track: string | null;
  /** The event's state (two-letter code), when known. */
  state: string | null;
}

export interface ProfileExtras {
  /** Events raced (at least one start). */
  events: number;
  top10s: number;
  /** Wins against BIG_WIN_FIELD or more starters, biggest field first. */
  bigWins: Array<{ eventId: number; eventName: string; eventDate: string; raceClass: string; motoName: string; fieldSize: number }>;
  /** Every track raced, most-raced first (count = events there). */
  tracks: Array<{ name: string; events: number }>;
  /** Every state raced in, most-raced first (count = events there). */
  states: Array<{ code: string; events: number }>;
}

const finished = (m: { position: number; dnf: boolean; dns: boolean }) =>
  !m.dns && !m.dnf && m.position > 0 && m.position < FINISH_SENTINEL;

/** `startersByMoto`: riders who started each moto (not DNS), from everyone's results. */
export function computeProfileExtras(motos: ExtrasMoto[], startersByMoto: Map<number, number>): ProfileExtras {
  const raced = motos.filter(m => m.motoType !== "practice" && !m.dns);
  const done = raced.filter(finished);

  const bigWins = done
    .filter(m => m.position === 1 && (startersByMoto.get(m.motoId) ?? 0) >= BIG_WIN_FIELD)
    .map(m => ({
      eventId: m.eventId, eventName: m.eventName, eventDate: m.eventDate.slice(0, 10), raceClass: m.raceClass,
      motoName: m.motoName, fieldSize: startersByMoto.get(m.motoId)!,
    }))
    .sort((a, b) => b.fieldSize - a.fieldSize || b.eventDate.localeCompare(a.eventDate));

  const eventsAt = (key: (m: ExtrasMoto) => string | null) => {
    const seen = new Map<string, Set<number>>();
    for (const m of raced) {
      const k = (key(m) ?? "").trim();
      if (!k) continue;
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k)!.add(m.eventId);
    }
    return [...seen.entries()].map(([k, ids]) => ({ k, events: ids.size })).sort((a, b) => b.events - a.events || a.k.localeCompare(b.k));
  };

  return {
    events: new Set(raced.map(m => m.eventId)).size,
    top10s: done.filter(m => m.position <= 10).length,
    bigWins: bigWins.slice(0, 12),
    tracks: eventsAt(m => m.track).map(t => ({ name: t.k, events: t.events })),
    states: eventsAt(m => (m.state ?? "").toUpperCase()).filter(s => /^[A-Z]{2}$/.test(s.k)).map(s => ({ code: s.k, events: s.events })),
  };
}

// ── Results history with filters ─────────────────────────────────────────────

export interface HistoryItem {
  eventId: number;
  eventDate: string;
  raceClass: string;
  track?: string | null;
}

export interface HistoryFilter {
  year?: string | null;
  raceClass?: string | null;
  track?: string | null;
}

/** The values a rider's history can be filtered by, newest year first, then A to Z. */
export function historyFilterOptions(items: HistoryItem[]): { years: string[]; classes: string[]; tracks: string[] } {
  const uniq = (values: Array<string | null | undefined>) => [...new Set(values.map(v => (v ?? "").trim()).filter(Boolean))];
  return {
    years: uniq(items.map(i => i.eventDate.slice(0, 4))).filter(y => /^\d{4}$/.test(y)).sort().reverse(),
    classes: uniq(items.map(i => i.raceClass)).sort((a, b) => a.localeCompare(b)),
    tracks: uniq(items.map(i => i.track)).sort((a, b) => a.localeCompare(b)),
  };
}

export function filterHistory<T extends HistoryItem>(items: T[], filter: HistoryFilter): T[] {
  const same = (a: string | null | undefined, b: string) => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
  return items.filter(i =>
    (!filter.year || i.eventDate.startsWith(filter.year)) &&
    (!filter.raceClass || same(i.raceClass, filter.raceClass)) &&
    (!filter.track || same(i.track, filter.track)));
}

// ── Who to follow ────────────────────────────────────────────────────────────

export interface SuggestCandidate {
  riderId: number;
  /** Races shared with your riders (competitors), wins (top riders) or 0. */
  weight: number;
}

/**
 * Up to `limit` riders to suggest, strongest first, leaving out your own
 * riders, riders you already follow and riders already suggested in an
 * earlier list (so one rider shows once).
 */
export function pickSuggestions(candidates: SuggestCandidate[], exclude: Set<number>, limit: number): number[] {
  const picked: number[] = [];
  for (const c of [...candidates].sort((a, b) => b.weight - a.weight || a.riderId - b.riderId)) {
    if (exclude.has(c.riderId) || picked.includes(c.riderId)) continue;
    picked.push(c.riderId);
    if (picked.length >= limit) break;
  }
  return picked;
}

/** "2024 KTM 250 SX-F" from the rider's bike fields; null when there's no make or model. */
export function bikeLabel(bike: { year?: string | null; make?: string | null; model?: string | null }): string | null {
  const make = (bike.make ?? "").trim(), model = (bike.model ?? "").trim();
  if (!make && !model) return null;
  return [(bike.year ?? "").trim(), make, model].filter(Boolean).join(" ");
}

/** Sponsors typed as free text ("Fox, Dunlop; Bell") become a short list ("/" stays: "ATV/MC"). */
export function sponsorList(text: string | null | undefined): string[] {
  return [...new Set((text ?? "").split(/[,;\n|]+/).map(s => s.trim()).filter(Boolean))].slice(0, 12);
}
