/**
 * Pure helpers for the Race Day Display (the big-screen TV page at /gate).
 * Kept free of React so they can be unit tested with node:test.
 */

/** Seconds from "1:23.45", "83.45" or "1:02:03.4". Null when unreadable or not positive. */
export function parseSecs(t: string | number | null | undefined): number | null {
  if (t == null) return null;
  if (typeof t === "number") return Number.isFinite(t) && t > 0 ? t : null;
  const s = t.trim();
  if (!s) return null;
  // Colon forms first: parseFloat("1:23.45") would read 1.
  const hms = s.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (hms) {
    const v = Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
    return v > 0 ? v : null;
  }
  const ms = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (ms) {
    const v = Number(ms[1]) * 60 + Number(ms[2]);
    return v > 0 ? v : null;
  }
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "1:05.123" or "58.400". */
export function fmtSecs(s: number): string {
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return m > 0 ? `${m}:${rem.toFixed(3).padStart(6, "0")}` : rem.toFixed(3);
}

/** A rider name safe to show: offline servers can send null or "null null". */
export function safeRiderName(name: string | null | undefined, bib?: string | null): string {
  const cleaned = (name ?? "")
    .split(/\s+/)
    .filter((part) => part && part !== "null" && part !== "undefined")
    .join(" ")
    .trim();
  if (cleaned) return cleaned;
  return bib ? `Rider #${bib}` : "Unknown Rider";
}

export interface DisplayResult {
  key: string | number;
  riderName: string;
  bibNumber: string | null;
  position: number | null;
  laps: number;
  totalSecs: number | null;
  bestSecs: number | null;
  dnf: boolean;
  dns: boolean;
}

function statusRank(r: DisplayResult): number {
  if (r.dns) return 2;
  if (r.dnf) return 1;
  return 0;
}

/**
 * Racing riders by position (missing positions last, then by laps and time),
 * then DNF, then DNS. Stable for equal keys.
 */
export function sortResults<T extends DisplayResult>(rows: T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ra = statusRank(a.row);
      const rb = statusRank(b.row);
      if (ra !== rb) return ra - rb;
      const pa = a.row.position;
      const pb = b.row.position;
      if (pa != null && pb != null && pa !== pb) return pa - pb;
      if (pa == null && pb != null) return 1;
      if (pa != null && pb == null) return -1;
      if (a.row.laps !== b.row.laps) return b.row.laps - a.row.laps;
      const ta = a.row.totalSecs ?? Infinity;
      const tb = b.row.totalSecs ?? Infinity;
      if (ta !== tb) return ta - tb;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

/**
 * Gap to the leader: "+N laps" for a lapped rider, otherwise the time gap.
 * Null when there is nothing meaningful to show (never a negative gap).
 */
export function gapLabel(row: DisplayResult, leader: DisplayResult | null | undefined): string | null {
  if (!leader || row === leader || row.dnf || row.dns) return null;
  if (row.laps > 0 && leader.laps > 0 && row.laps < leader.laps) {
    const down = leader.laps - row.laps;
    return `+${down} lap${down > 1 ? "s" : ""}`;
  }
  if (row.totalSecs != null && leader.totalSecs != null) {
    const diff = row.totalSecs - leader.totalSecs;
    if (diff >= 0) return `+${fmtSecs(diff)}`;
  }
  return null;
}

/**
 * Time left on a timed race at server time `nowMs`, following the server's
 * flagTimeFor: start + limit + red-flag time, and the clock stands still
 * while the race is red-flagged (pausedAt set).
 */
export function raceRemainingMs(
  moto: { startedAt: string | null | undefined; timeLimitMs: number | null | undefined; totalPausedMs?: number | null; pausedAt?: string | null },
  nowMs: number,
): number | null {
  if (!moto.startedAt || !moto.timeLimitMs) return null;
  const start = Date.parse(moto.startedAt);
  if (!Number.isFinite(start)) return null;
  const pausedAt = moto.pausedAt ? Date.parse(moto.pausedAt) : NaN;
  const end = Number.isFinite(pausedAt) ? pausedAt : nowMs;
  const elapsed = end - start - Math.max(0, moto.totalPausedMs ?? 0);
  return Math.max(0, moto.timeLimitMs - Math.max(0, elapsed));
}

/**
 * Server clock minus TV clock, from a server timestamp (ISO, or an HTTP Date
 * header) taken while a request was in flight. Null when unreadable.
 */
export function clockOffsetMs(serverTime: string | null | undefined, sentAtMs: number, receivedAtMs: number): number | null {
  if (!serverTime) return null;
  const server = Date.parse(serverTime);
  if (!Number.isFinite(server)) return null;
  return server - (sentAtMs + receivedAtMs) / 2;
}

export interface DisplayMoto {
  id: number;
  status: string;
  motoNumber?: number | null;
  completedAt?: string | null;
  staggeredGroupId?: number | null;
  staggeredOrder?: number | null;
}

export function isStaggerSecondary(m: DisplayMoto): boolean {
  return m.staggeredGroupId != null && (m.staggeredOrder ?? 1) > 1;
}

export interface FeaturedSelection<M extends DisplayMoto> {
  /** Motos to show full-size, in run order (a staggered group can be several). */
  featured: M[];
  /** True when showing a just-finished race during the hold period. */
  holding: boolean;
  /** Scheduled primaries after the featured ones. */
  upcoming: M[];
}

/** How long a just-finished race stays up before the next gate list. */
export const RESULTS_HOLD_MS = 2 * 60_000;

/**
 * Which motos the TV features:
 *  1. every moto in progress (staggered starts run together), plus members of
 *     the same staggered group that finished within the hold period;
 *  2. otherwise the race that finished within the hold period;
 *  3. otherwise the next scheduled primary and its staggered partners;
 *  4. otherwise the last finished race.
 * `motos` must be in run order.
 */
export function pickFeatured<M extends DisplayMoto>(motos: M[], serverNowMs: number, holdMs = RESULTS_HOLD_MS): FeaturedSelection<M> {
  const completedAtMs = (m: M) => (m.completedAt ? Date.parse(m.completedAt) : NaN);
  const recentlyDone = (m: M) => {
    const t = completedAtMs(m);
    return m.status === "completed" && Number.isFinite(t) && serverNowMs - t < holdMs && serverNowMs - t >= -holdMs;
  };
  const upcomingPrimaries = motos.filter((m) => m.status === "scheduled" && !isStaggerSecondary(m));

  const inProgress = motos.filter((m) => m.status === "in_progress");
  if (inProgress.length) {
    const groups = new Set(inProgress.map((m) => m.staggeredGroupId).filter((g): g is number => g != null));
    const featured = motos.filter((m) =>
      m.status === "in_progress" || (m.staggeredGroupId != null && groups.has(m.staggeredGroupId) && recentlyDone(m)));
    return { featured, holding: false, upcoming: upcomingPrimaries };
  }

  const recent = motos.filter(recentlyDone).sort((a, b) => completedAtMs(b) - completedAtMs(a))[0];
  if (recent) {
    const featured = recent.staggeredGroupId != null
      ? motos.filter((m) => m.staggeredGroupId === recent.staggeredGroupId && recentlyDone(m))
      : [recent];
    return { featured, holding: true, upcoming: upcomingPrimaries };
  }

  const next = upcomingPrimaries[0] ?? motos.find((m) => m.status === "scheduled");
  if (next) {
    const featured = next.staggeredGroupId != null
      ? motos.filter((m) => m.staggeredGroupId === next.staggeredGroupId && m.status === "scheduled")
      : [next];
    const ids = new Set(featured.map((m) => m.id));
    return { featured, holding: false, upcoming: upcomingPrimaries.filter((m) => !ids.has(m.id)) };
  }

  const done = motos.filter((m) => m.status === "completed");
  const last = done.sort((a, b) => (completedAtMs(a) || 0) - (completedAtMs(b) || 0)).pop();
  return { featured: last ? [last] : [], holding: false, upcoming: [] };
}

/** The event the TV should show: the pinned one, else the chosen one, else the first — only if still racing today. */
export function pickEventId(raceDayIds: number[], pinnedId: number | null, selectedId: number | null): number | null {
  if (pinnedId != null && raceDayIds.includes(pinnedId)) return pinnedId;
  if (selectedId != null && raceDayIds.includes(selectedId)) return selectedId;
  return raceDayIds[0] ?? null;
}
