import { useState, useMemo, useEffect, useRef, useLayoutEffect, useCallback } from "react";
import { useQueries } from "@tanstack/react-query";
import { useListEvents, useListMotos, useListResults } from "@workspace/api-client-react";
import type { Moto, Event, RaceResult } from "@workspace/api-client-react";
import { BadgeCheck, Clock } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  parseSecs, fmtSecs, safeRiderName, sortResults, gapLabel, raceRemainingMs, clockOffsetMs,
  pickFeatured, pickEventId, isStaggerSecondary, type DisplayResult,
} from "@/lib/gateDisplay";
import rmLogo from "@assets/rm-logo.png";

// ─── helpers ────────────────────────────────────────────────────────────────

/** A stored lap: live timing stores milliseconds, older manual entries text. */
function lapSecs(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v / 1000 : null;
  if (typeof v === "string") return parseSecs(v);
  return null;
}

function lapsOf(lapTimes: unknown): number[] {
  return Array.isArray(lapTimes) ? lapTimes.map(lapSecs).filter((x): x is number => x !== null) : [];
}

function bestLap(lapTimes: unknown, raceStyle?: string | null): number | null {
  const all = Array.isArray(lapTimes) ? lapTimes : [];
  const eligible = raceStyle === "motocross" ? all.slice(1) : all;
  const parsed = lapsOf(eligible);
  return parsed.length ? Math.min(...parsed) : null;
}

/** Re-renders every `ms` and returns Date.now(). */
function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** The public live-timing snapshot (GET /api/timing/leaderboard/:motoId). */
interface LeaderboardSnapshot {
  motoId: number;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  timeLimitMs: number | null;
  plusLaps: number | null;
  timeExpiredAt: string | null;
  pausedAt?: string | null;
  totalPausedMs?: number | null;
  resultsOfficial?: boolean;
  updatedAt?: string;
  leaderboard: Array<{
    position: number | null;
    riderId: number | null;
    riderName: string | null;
    bibNumber: string | null;
    laps?: number | null;
    lapTimes?: string[] | null;
    totalMs?: number | null;
    totalTime?: string | null;
    bestLapMs?: number | null;
    bestLap?: string | null;
    dnf?: boolean | null;
    dns?: boolean | null;
  }>;
}

async function fetchLeaderboard(motoId: number, onOffset: (ms: number) => void): Promise<LeaderboardSnapshot> {
  const sent = Date.now();
  const res = await fetch(`/api/timing/leaderboard/${motoId}`, { credentials: "include", cache: "no-store" });
  const received = Date.now();
  if (!res.ok) throw new Error(`Live timing unavailable (${res.status})`);
  const body = (await res.json()) as LeaderboardSnapshot;
  if (!body || !Array.isArray(body.leaderboard)) throw new Error("Live timing sent an unreadable update");
  // The snapshot's updatedAt is server time to the millisecond; the Date header is the fallback.
  const offset = clockOffsetMs(body.updatedAt, sent, received) ?? clockOffsetMs(res.headers.get("date"), sent, received);
  if (offset != null) onOffset(offset);
  return body;
}

function rowsFromSnapshot(s: LeaderboardSnapshot): DisplayResult[] {
  return s.leaderboard.map((e, i) => ({
    key: e.riderId ?? `${e.bibNumber ?? "x"}-${i}`,
    riderName: safeRiderName(e.riderName, e.bibNumber),
    bibNumber: e.bibNumber ?? null,
    position: e.position ?? null,
    laps: e.laps ?? e.lapTimes?.length ?? 0,
    totalSecs: e.totalMs ? e.totalMs / 1000 : parseSecs(e.totalTime),
    bestSecs: e.bestLapMs != null && e.bestLapMs > 0 ? e.bestLapMs / 1000 : parseSecs(e.bestLap),
    dnf: !!e.dnf,
    dns: !!e.dns,
  }));
}

function rowsFromResults(results: RaceResult[], raceStyle?: string | null): DisplayResult[] {
  return results.map((r) => ({
    key: r.id,
    riderName: safeRiderName(r.riderName, r.bibNumber),
    bibNumber: r.bibNumber ?? null,
    position: r.position ?? null,
    laps: lapsOf(r.lapTimes).length,
    totalSecs: parseSecs(r.totalTime),
    bestSecs: bestLap(r.lapTimes, raceStyle),
    dnf: !!r.dnf,
    dns: !!r.dns,
  }));
}

/**
 * Splits a list into pages that fit the container and flips pages on a timer,
 * so a long field is never cut off on a TV with nobody to scroll it.
 */
function usePager<T>(items: T[], intervalMs = 8000) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [perPage, setPerPage] = useState(0); // 0 = not measured yet: render everything
  const [page, setPage] = useState(0);

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const rowH = Math.max(0, ...Array.from(el.children).map((k) => (k as HTMLElement).offsetHeight));
    if (!rowH || !el.clientHeight) return;
    const next = Math.max(1, Math.floor(el.clientHeight / rowH));
    setPerPage((p) => (p === next ? p : next));
  }, []);

  useLayoutEffect(() => { measure(); }, [measure, items.length, perPage]);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const size = perPage || Math.max(1, items.length);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = page % pages;
  useEffect(() => {
    if (pages <= 1) return;
    const id = setInterval(() => setPage((p) => (p + 1) % pages), intervalMs);
    return () => clearInterval(id);
  }, [pages, intervalMs]);

  return { containerRef, visible: items.slice(current * size, current * size + size), page: current, pages };
}

/** Steps a horizontal strip along when it is wider than the screen. */
function useAutoScrollX(intervalMs = 4000) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = setInterval(() => {
      const el = ref.current;
      if (!el || el.scrollWidth <= el.clientWidth + 2) return;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
      el.scrollTo({ left: atEnd ? 0 : el.scrollLeft + el.clientWidth * 0.75, behavior: "smooth" });
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return ref;
}

function LiveClock() {
  const now = useNow(1000);
  return (
    <span className="font-mono tabular-nums text-white/80 text-xl font-bold tracking-widest">
      {new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </span>
  );
}

// ─── Rows ───────────────────────────────────────────────────────────────────

function PositionBubble({ label, className }: { label: string | number; className: string }) {
  return (
    <div className="w-16 shrink-0 flex justify-center">
      <div className={`h-12 rounded-full flex items-center justify-center font-heading font-black ${typeof label === "number" ? "w-12 text-xl" : "w-16 text-base"} ${className}`}>
        {label}
      </div>
    </div>
  );
}

function GateRow({ pos, riderName, bibNumber, raceClass, isFirst }: {
  pos: number; riderName: string; bibNumber?: string | null; raceClass?: string | null; isFirst: boolean;
}) {
  return (
    <div className={`flex items-center gap-4 px-6 py-3 ${isFirst ? "bg-amber-500/15 border-l-4 border-amber-400" : pos % 2 === 0 ? "bg-white/[0.03]" : ""}`}>
      <PositionBubble label={pos} className={isFirst ? "bg-amber-400 text-black" : "bg-white/15 text-white/80"} />
      <div className="flex-1 min-w-0">
        <p className={`font-heading font-black tracking-wide truncate ${isFirst ? "text-white text-2xl" : "text-white/90 text-xl"}`}>
          {riderName.toUpperCase()}
        </p>
        {raceClass && <p className="text-white/60 text-base font-semibold uppercase tracking-wider truncate">{raceClass}</p>}
      </div>
      {bibNumber && (
        <span className={`shrink-0 font-mono font-black tabular-nums ${isFirst ? "text-amber-400 text-2xl" : "text-white/70 text-xl"}`}>
          #{bibNumber}
        </span>
      )}
      {isFirst && (
        <div className="shrink-0 bg-amber-400 text-black text-base font-black uppercase tracking-widest px-3 py-1 rounded-full">
          First Pick
        </div>
      )}
    </div>
  );
}

function ResultRow({ row, displayPos, gap, isLeader }: { row: DisplayResult; displayPos: number; gap: string | null; isLeader: boolean }) {
  const out = row.dnf || row.dns;
  const posColors = out
    ? "bg-red-900/60 text-red-100"
    : isLeader
    ? "bg-amber-400 text-black"
    : displayPos === 2
    ? "bg-slate-300 text-black"
    : displayPos === 3
    ? "bg-amber-700 text-white"
    : "bg-white/15 text-white/80";

  return (
    <div className={`flex items-center gap-4 px-6 py-3 ${
      isLeader ? "bg-amber-500/15 border-l-4 border-amber-400"
        : out ? "bg-red-900/10 border-l-4 border-red-700/50"
        : displayPos % 2 === 0 ? "bg-white/[0.03]" : ""
    }`}>
      <PositionBubble label={row.dnf ? "DNF" : row.dns ? "DNS" : displayPos} className={posColors} />
      <div className="flex-1 min-w-0">
        <p className={`font-heading font-black tracking-wide truncate ${isLeader ? "text-white text-2xl" : out ? "text-white/60 text-xl" : "text-white/90 text-xl"}`}>
          {row.riderName.toUpperCase()}
        </p>
        {row.bibNumber && <p className="text-white/60 text-base font-mono">#{row.bibNumber}</p>}
      </div>
      <div className="shrink-0 text-right w-[140px]">
        {row.bestSecs !== null ? (
          <p className={`font-mono font-bold tabular-nums ${isLeader ? "text-amber-400 text-2xl" : "text-white/85 text-xl"}`}>{fmtSecs(row.bestSecs)}</p>
        ) : (
          <p className="text-white/40 text-xl font-mono">—</p>
        )}
      </div>
      <div className="shrink-0 text-right w-[130px]">
        {isLeader ? (
          <span className="text-amber-400 font-black text-base uppercase tracking-widest">Leader</span>
        ) : gap ? (
          <p className={`font-mono font-bold tabular-nums text-xl ${gap.includes("lap") ? "text-orange-300" : "text-red-300"}`}>{gap}</p>
        ) : (
          <p className="text-white/40 text-xl font-mono">—</p>
        )}
      </div>
    </div>
  );
}

// ─── Countdown / badges ─────────────────────────────────────────────────────

function GateCountdownTimer({ clock, plusLaps, offsetMs }: {
  clock: { startedAt: string; timeLimitMs: number; totalPausedMs?: number | null; pausedAt?: string | null };
  plusLaps: number | null;
  offsetMs: number;
}) {
  const now = useNow(500);
  const remaining = raceRemainingMs(clock, now + offsetMs) ?? 0;
  const paused = !!clock.pausedAt;
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const color = paused
    ? "text-red-200 border-red-500/60 bg-red-600/30"
    : remaining < 60_000 ? "text-red-300 border-red-500/50 bg-red-500/15"
    : remaining < 120_000 ? "text-orange-300 border-orange-500/50 bg-orange-500/15"
    : "text-white/85 border-white/25 bg-white/5";
  return (
    <div className={`flex items-center gap-2.5 border rounded-full px-4 py-1.5 ${color}`}>
      {paused && <span className="font-black text-base uppercase tracking-widest">Red Flag</span>}
      <span className="font-mono font-black text-2xl tabular-nums leading-none">
        {minutes}:{String(seconds).padStart(2, "0")}
      </span>
      {plusLaps != null && plusLaps > 0 && (
        <span className="text-base font-bold uppercase tracking-wider opacity-80">+{plusLaps} Lap{plusLaps > 1 ? "s" : ""}</span>
      )}
    </div>
  );
}

function StatusBadge({ status, official, paused }: { status: string; official: boolean; paused: boolean }) {
  if (status === "in_progress") {
    return paused ? (
      <div className="flex items-center gap-2 bg-red-600/30 border border-red-500/60 rounded-full px-4 py-1.5 animate-pulse">
        <span className="text-red-200 font-black text-base uppercase tracking-widest">Red Flag</span>
      </div>
    ) : (
      <div className="flex items-center gap-2 bg-green-500/20 border border-green-500/40 rounded-full px-4 py-1.5">
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-3 w-3 bg-green-400" />
        </span>
        <span className="text-green-300 font-black text-base uppercase tracking-widest">In Progress</span>
      </div>
    );
  }
  if (status === "completed") {
    // TV-sized take on OfficialResultsBadge: unofficial until the organizer finalizes.
    return official ? (
      <div className="flex items-center gap-2 bg-green-500/15 border border-green-500/50 rounded-full px-4 py-1.5">
        <BadgeCheck size={18} className="text-green-300" />
        <span className="text-green-300 font-black text-base uppercase tracking-widest">Official Results</span>
      </div>
    ) : (
      <div className="flex items-center gap-2 bg-amber-500/15 border border-amber-500/50 rounded-full px-4 py-1.5">
        <Clock size={18} className="text-amber-300" />
        <span className="text-amber-300 font-black text-base uppercase tracking-widest">Unofficial Results</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 bg-blue-500/20 border border-blue-500/40 rounded-full px-4 py-1.5">
      <span className="text-blue-300 font-black text-base uppercase tracking-widest">Up Next</span>
    </div>
  );
}

// ─── Moto panel ─────────────────────────────────────────────────────────────

type PanelRow =
  | { key: string | number; mode: "race"; row: DisplayResult; displayPos: number; gap: string | null; isLeader: boolean }
  | { key: string | number; mode: "gate"; pos: number; riderName: string; bibNumber?: string | null; raceClass: string | null; isFirst: boolean };

function MotoPanel({ moto, label, rows, snapshot, official, offsetMs }: {
  moto: Moto;
  label: string;
  rows: PanelRow[];
  snapshot: LeaderboardSnapshot | undefined;
  official: boolean;
  offsetMs: number;
}) {
  const { containerRef, visible, page, pages } = usePager(rows);
  const startedAt = snapshot?.startedAt ?? moto.startedAt ?? null;
  const timeLimitMs = snapshot?.timeLimitMs ?? moto.timeLimitMs ?? null;
  const timeExpiredAt = snapshot ? snapshot.timeExpiredAt : moto.timeExpiredAt ?? null;
  const pausedAt = snapshot ? snapshot.pausedAt ?? null : moto.pausedAt ?? null;
  const totalPausedMs = snapshot?.totalPausedMs ?? moto.totalPausedMs ?? 0;
  const plusLaps = snapshot?.plusLaps ?? moto.plusLaps ?? null;
  const inProgress = moto.status === "in_progress";
  const raceMode = rows[0]?.mode === "race";
  const header = "text-white/60 text-base font-black uppercase tracking-[0.15em]";

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
      <div className="px-8 py-5 bg-white/[0.03] border-b border-white/[0.08] flex items-center gap-4 flex-wrap shrink-0">
        <div className="flex-1 min-w-0">
          <div className="text-white/60 text-base font-black uppercase tracking-[0.2em] mb-1">
            {label}
            {moto.type && moto.type !== "main" && <span className="ml-2 text-white/50">· {moto.type.toUpperCase()}</span>}
          </div>
          <h2 className="font-heading font-black text-3xl text-white uppercase tracking-widest leading-none truncate">{moto.name}</h2>
          {(moto.raceClasses?.length || moto.raceClass) && (
            <p className="text-white/70 font-bold text-lg uppercase tracking-widest mt-1 truncate">
              {moto.raceClasses?.length ? moto.raceClasses.join(" · ") : moto.raceClass}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <StatusBadge status={moto.status} official={official} paused={inProgress && !!pausedAt} />
          {inProgress && timeLimitMs && startedAt && !timeExpiredAt && (
            <GateCountdownTimer clock={{ startedAt, timeLimitMs, totalPausedMs, pausedAt }} plusLaps={plusLaps} offsetMs={offsetMs} />
          )}
          {inProgress && timeExpiredAt && (plusLaps ?? 0) > 0 && (
            <div className="flex items-center gap-2 bg-orange-500/20 border border-orange-500/50 rounded-full px-4 py-1.5 animate-pulse">
              <span className="text-orange-300 font-black text-base uppercase tracking-widest">
                Time Expired — +{plusLaps} Lap{(plusLaps ?? 0) > 1 ? "s" : ""}
              </span>
            </div>
          )}
        </div>

        <div className="w-full flex items-center gap-4 pt-3 border-t border-white/[0.08] mt-2">
          <div className="w-16 shrink-0" />
          <div className={`flex-1 ${header}`}>
            Rider{pages > 1 && <span className="ml-3 text-white/50">Page {page + 1} / {pages}</span>}
          </div>
          {raceMode ? (
            <>
              <div className={`w-[140px] shrink-0 text-right ${header}`}>Best Lap</div>
              <div className={`w-[130px] shrink-0 text-right ${header}`}>Gap</div>
            </>
          ) : (
            <div className={`w-[120px] shrink-0 text-right ${header}`}>Bib #</div>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center py-20">
          <p className="text-white/50 font-heading font-black text-2xl uppercase tracking-widest">
            {inProgress ? "Waiting for first crossings" : "No Riders Assigned"}
          </p>
        </div>
      ) : (
        <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden divide-y divide-white/[0.05]">
          {visible.map((r) =>
            r.mode === "race" ? (
              <ResultRow key={r.key} row={r.row} displayPos={r.displayPos} gap={r.gap} isLeader={r.isLeader} />
            ) : (
              <GateRow key={r.key} pos={r.pos} riderName={r.riderName} bibNumber={r.bibNumber} raceClass={r.raceClass} isFirst={r.isFirst} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function GateSchedulePage() {
  const { user } = useAuth();

  const { clubId, urlEventId } = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    const c = Number(p.get("club"));
    const e = Number(p.get("event"));
    return {
      clubId: Number.isFinite(c) && c > 0 ? c : user?.clubId ?? null,
      urlEventId: Number.isFinite(e) && e > 0 ? e : null,
    };
  }, [user?.clubId]);

  const eventsQuery = useListEvents(
    { clubId: clubId ?? undefined, status: "race_day" },
    { query: { enabled: !!clubId, refetchInterval: 30_000 } as any },
  );
  const raceDayEvents = (eventsQuery.data ?? []) as Event[];

  // A link with &event= is pinned to that event while it is racing; the
  // dropdown (shown only on unpinned links) writes its choice into the URL.
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const activeEventId = pickEventId(raceDayEvents.map((e) => e.id), urlEventId, selectedEventId);
  const activeEvent = raceDayEvents.find((e) => e.id === activeEventId) ?? null;
  const pinned = urlEventId != null && urlEventId === activeEventId;
  const selectEvent = (id: number) => {
    setSelectedEventId(id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("event", String(id));
      window.history.replaceState(window.history.state, "", url);
    } catch { /* keep the in-memory choice */ }
  };

  const motosQuery = useListMotos(activeEventId!, { query: { enabled: !!activeEventId, refetchInterval: 5_000 } as any });
  // Anonymous viewers only get finished motos here; live positions come from
  // the public timing leaderboard below. Kept as a fallback for finished races.
  const resultsQuery = useListResults(activeEventId!, { query: { enabled: !!activeEventId, refetchInterval: 15_000 } as any });
  const results = (resultsQuery.data ?? []) as RaceResult[];

  const motos = useMemo(
    () => [...((motosQuery.data ?? []) as Moto[])].sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0)),
    [motosQuery.data],
  );

  // Server clock minus TV clock, so countdowns and the results hold don't
  // drift with a TV whose clock is off.
  const [offsetMs, setOffsetMs] = useState(0);
  const onOffset = useCallback((ms: number) => {
    setOffsetMs((prev) => (Math.abs(prev - ms) > 250 ? Math.round(ms) : prev));
  }, []);

  const now = useNow(1000);
  const serverNow = now + offsetMs;

  // Run-order numbers match the Schedule page: staggered partners share their primary's number.
  const runOrder = useMemo(() => {
    const primaries = motos.filter((m) => !isStaggerSecondary(m));
    const byId = new Map(primaries.map((m, i) => [m.id, i + 1]));
    const byGroup = new Map<number, number>();
    primaries.forEach((m, i) => { if (m.staggeredGroupId != null) byGroup.set(m.staggeredGroupId, i + 1); });
    return (m: Moto) => {
      if (isStaggerSecondary(m)) {
        const n = byGroup.get(m.staggeredGroupId!);
        return n != null ? `Moto ${n} · Wave ${m.staggeredOrder}` : `Moto ${m.motoNumber}`;
      }
      return `Moto ${byId.get(m.id) ?? m.motoNumber}`;
    };
  }, [motos]);

  const { featured, upcoming } = useMemo(() => pickFeatured(motos, serverNow), [motos, serverNow]);
  const raceMotos = featured.filter((m) => m.status === "in_progress" || m.status === "completed");

  const leaderboardQueries = useQueries({
    queries: raceMotos.map((m) => ({
      queryKey: ["gate-display-leaderboard", m.id],
      queryFn: () => fetchLeaderboard(m.id, onOffset),
      refetchInterval: m.status === "in_progress" ? 3_000 : 10_000,
      retry: 1,
    })),
  });
  const snapshots = new Map<number, LeaderboardSnapshot>();
  raceMotos.forEach((m, i) => {
    const d = leaderboardQueries[i]?.data;
    if (d) snapshots.set(m.id, d);
  });

  const panelRows = (moto: Moto): PanelRow[] => {
    const isRace = moto.status === "in_progress" || moto.status === "completed";
    if (isRace) {
      const snap = snapshots.get(moto.id);
      const motoResults = results.filter((r) => r.motoId === moto.id);
      const base = snap?.leaderboard.length ? rowsFromSnapshot(snap) : rowsFromResults(motoResults, activeEvent?.raceStyle);
      if (base.length) {
        const sorted = sortResults(base);
        const leader = sorted.find((r) => !r.dnf && !r.dns) ?? null;
        let place = 0;
        return sorted.map((row) => {
          const out = row.dnf || row.dns;
          if (!out) place += 1;
          return { key: row.key, mode: "race" as const, row, displayPos: out ? 0 : place, gap: gapLabel(row, leader), isLeader: row === leader };
        });
      }
      if (moto.status === "in_progress") return [];
    }
    const lineup = Array.isArray(moto.lineup) ? [...moto.lineup] : [];
    lineup.sort((a, b) => a.position - b.position);
    const raceClass = (moto.raceClasses?.length ? moto.raceClasses[0] : moto.raceClass) ?? null;
    return lineup.map((entry, i) => ({
      key: entry.riderId ?? i,
      mode: "gate" as const,
      pos: i + 1,
      riderName: safeRiderName(entry.riderName, entry.bibNumber),
      bibNumber: entry.bibNumber,
      raceClass,
      isFirst: i === 0,
    }));
  };

  const officialFor = (moto: Moto): boolean => {
    const snap = snapshots.get(moto.id);
    if (snap && typeof snap.resultsOfficial === "boolean") return snap.resultsOfficial;
    const motoResults = results.filter((r) => r.motoId === moto.id);
    return motoResults.length > 0 && motoResults.every((r) => r.official === true);
  };

  // Connection health: react-query keeps the last good data on screen; say so
  // instead of a permanently green "Live" pill.
  const lastUpdated = Math.max(motosQuery.dataUpdatedAt || 0, eventsQuery.dataUpdatedAt || 0);
  const anyError = eventsQuery.isError || motosQuery.isError || leaderboardQueries.some((q) => q.isError);
  const stale = lastUpdated > 0 && now - lastUpdated > 20_000;
  const unhealthy = (anyError || stale) && !!clubId;
  const ageSecs = lastUpdated > 0 ? Math.max(0, Math.round((now - lastUpdated) / 1000)) : null;

  const upNextRef = useAutoScrollX();

  const header = (
    <Header
      event={activeEvent}
      events={pinned ? [] : raceDayEvents}
      selectedId={activeEventId}
      onSelect={selectEvent}
      healthy={!unhealthy}
    />
  );
  const banner = unhealthy ? (
    <div className="bg-amber-500/20 border-b border-amber-500/50 px-6 py-2 text-center shrink-0">
      <span className="text-amber-200 text-xl font-black uppercase tracking-widest">
        Reconnecting…{ageSecs != null ? ` last updated ${ageSecs}s ago` : ""}
      </span>
    </div>
  ) : null;

  // ── No club ID ──
  if (!clubId) {
    return (
      <div className="min-h-screen bg-[#080c14] flex items-center justify-center">
        <div className="text-center px-6">
          <p className="font-heading font-black text-3xl text-white/60 uppercase tracking-widest">Invalid Link</p>
          <p className="text-white/50 mt-2 text-lg">Ask your promoter for the correct race day display link.</p>
        </div>
      </div>
    );
  }

  // ── No active event ──
  if (!activeEventId) {
    return (
      <div className="h-screen bg-[#080c14] flex flex-col overflow-hidden">
        {header}
        {banner}
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center px-6">
            <div className="w-24 h-24 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-6">
              <img src={rmLogo} alt="" className="w-14 h-14 opacity-40" />
            </div>
            <p className="font-heading font-black text-3xl text-white/60 uppercase tracking-widest">No Race Today</p>
            <p className="text-white/50 mt-3 text-lg">This display goes live when a race day event is active.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[#080c14] flex flex-col overflow-hidden select-none">
      {header}
      {banner}

      {featured.length ? (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* Staggered starts run together, so each wave in progress gets its own panel. */}
          <div className={`flex-1 min-h-0 flex overflow-hidden ${featured.length > 1 ? "flex-col xl:flex-row xl:divide-x divide-white/[0.08]" : "flex-col"}`}>
            {featured.map((m) => (
              <MotoPanel
                key={m.id}
                moto={m}
                label={runOrder(m)}
                rows={panelRows(m)}
                snapshot={snapshots.get(m.id)}
                official={officialFor(m)}
                offsetMs={offsetMs}
              />
            ))}
          </div>

          {/* ── Up Next strip ── */}
          {upcoming.length > 0 && (
            <div className="border-t border-white/[0.1] bg-white/[0.03] px-6 py-3 flex items-center gap-6 shrink-0">
              <span className="text-white/70 text-base font-black uppercase tracking-[0.2em] shrink-0">Up Next</span>
              <div ref={upNextRef} className="flex-1 min-w-0 flex items-center gap-6 overflow-x-hidden">
                {upcoming.map((m, i) => (
                  <div key={m.id} className="flex items-center gap-3 shrink-0">
                    {i > 0 && <span className="text-white/30">·</span>}
                    <span className="text-white/60 text-base font-bold uppercase tracking-wider">{runOrder(m)}</span>
                    <span className="text-white/90 text-lg font-heading font-black uppercase tracking-wide">{m.name}</span>
                    {(m.raceClasses?.length || m.raceClass) && (
                      <span className="text-white/60 text-base font-semibold uppercase">
                        {m.raceClasses?.length ? m.raceClasses.join(" · ") : m.raceClass}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-white/50 font-heading font-black text-3xl uppercase tracking-widest">No Motos Scheduled</p>
        </div>
      )}
    </div>
  );
}

// ─── Header ─────────────────────────────────────────────────────────────────

function Header({ event, events, selectedId, onSelect, healthy }: {
  event: Event | null;
  events: Event[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  healthy: boolean;
}) {
  return (
    <div className="bg-[#0d1220] border-b border-white/[0.08] px-6 py-4 flex items-center gap-4 shrink-0">
      <div className="flex items-center gap-3 shrink-0">
        <img src={`${import.meta.env.BASE_URL}brand/rm-roost-banner-640.png`} alt="RM Roost" className="h-11 w-auto" />
      </div>

      <div className="w-px h-8 bg-white/10 shrink-0" />

      <div className="flex-1 min-w-0">
        {events.length > 1 ? (
          <Select value={selectedId?.toString() ?? ""} onValueChange={(v) => onSelect(Number(v))}>
            <SelectTrigger className="bg-white/5 border-white/10 text-white font-heading font-bold uppercase tracking-wide text-base max-w-xs">
              <SelectValue placeholder="Select event" />
            </SelectTrigger>
            <SelectContent>
              {events.map((ev) => (
                <SelectItem key={ev.id} value={ev.id.toString()}>{ev.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : event ? (
          <p className="font-heading font-black text-white text-xl uppercase tracking-widest truncate">{event.name}</p>
        ) : null}
      </div>

      {healthy ? (
        <div className="flex items-center gap-2 shrink-0">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-400" />
          </span>
          <span className="text-green-300 text-base font-black uppercase tracking-widest">Live</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 shrink-0">
          <span className="inline-flex rounded-full h-2.5 w-2.5 bg-amber-400" />
          <span className="text-amber-300 text-base font-black uppercase tracking-widest">Reconnecting</span>
        </div>
      )}

      <div className="w-px h-8 bg-white/10 shrink-0" />

      <LiveClock />
    </div>
  );
}
