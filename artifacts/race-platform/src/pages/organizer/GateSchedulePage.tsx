import { useState, useMemo, useEffect } from "react";
import { useListEvents, useListMotos, useListResults } from "@workspace/api-client-react";
import type { Moto, Event, RaceResult } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import rmLogo from "@assets/rm-logo.png";

// ─── helpers ────────────────────────────────────────────────────────────────

function parseSecs(t: string | null | undefined): number | null {
  if (!t) return null;
  const n = parseFloat(t);
  if (!isNaN(n) && n > 0) return n;
  // "m:ss.xxx" format
  const match = t.match(/^(\d+):(\d{2})\.(\d+)$/);
  if (match) return parseInt(match[1]) * 60 + parseFloat(`${match[2]}.${match[3]}`);
  return null;
}

function bestLap(lapTimes: string[] | null | undefined): number | null {
  if (!lapTimes?.length) return null;
  const parsed = lapTimes.map(parseSecs).filter((x): x is number => x !== null);
  if (!parsed.length) return null;
  return Math.min(...parsed);
}

function fmtSecs(s: number): string {
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  const sec = rem.toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${sec}` : rem.toFixed(3);
}

function fmtGap(gap: number): string {
  return `+${gap.toFixed(3)}`;
}

function LiveClock() {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="font-mono tabular-nums text-white/70 text-xl font-bold tracking-widest">
      {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </span>
  );
}

// ─── Gate-order row (upcoming moto) ─────────────────────────────────────────

function GateRow({
  pos,
  riderName,
  bibNumber,
  raceClass,
  isFirst,
}: {
  pos: number;
  riderName: string;
  bibNumber?: string | null;
  raceClass?: string | null;
  isFirst: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-4 px-6 py-3 transition-all ${
        isFirst
          ? "bg-amber-500/15 border-l-4 border-amber-400"
          : pos % 2 === 0
          ? "bg-white/[0.03]"
          : "bg-transparent"
      }`}
    >
      {/* Position bubble */}
      <div
        className={`w-12 h-12 rounded-full flex items-center justify-center font-heading font-black text-xl shrink-0 ${
          isFirst
            ? "bg-amber-400 text-black"
            : "bg-white/10 text-white/60"
        }`}
      >
        {pos}
      </div>

      {/* Rider name */}
      <div className="flex-1 min-w-0">
        <p className={`font-heading font-black tracking-wide truncate ${isFirst ? "text-white text-2xl" : "text-white/90 text-xl"}`}>
          {riderName.toUpperCase()}
        </p>
        {raceClass && (
          <p className="text-white/40 text-sm font-semibold uppercase tracking-wider">{raceClass}</p>
        )}
      </div>

      {/* Bib */}
      {bibNumber && (
        <div className="shrink-0 text-right">
          <span className={`font-mono font-black tabular-nums ${isFirst ? "text-amber-400 text-2xl" : "text-white/50 text-xl"}`}>
            #{bibNumber}
          </span>
        </div>
      )}

      {isFirst && (
        <div className="shrink-0 bg-amber-400 text-black text-xs font-black uppercase tracking-widest px-3 py-1 rounded-full">
          FIRST PICK
        </div>
      )}
    </div>
  );
}

// ─── Race-results row (in-progress or completed moto) ───────────────────────

function ResultRow({
  pos,
  riderName,
  bibNumber,
  best,
  totalTime,
  leaderBest,
  leaderTotal,
  dnf,
  dns,
  isLeader,
}: {
  pos: number;
  riderName: string;
  bibNumber?: string | null;
  best: number | null;
  totalTime: number | null;
  leaderBest: number | null;
  leaderTotal: number | null;
  dnf: boolean;
  dns: boolean;
  isLeader: boolean;
}) {
  const gap = useMemo(() => {
    if (isLeader) return null;
    if (totalTime !== null && leaderTotal !== null) return totalTime - leaderTotal;
    if (best !== null && leaderBest !== null) return best - leaderBest;
    return null;
  }, [isLeader, totalTime, leaderTotal, best, leaderBest]);

  const posColors = isLeader
    ? "bg-amber-400 text-black"
    : pos === 2
    ? "bg-slate-300 text-black"
    : pos === 3
    ? "bg-amber-700 text-white"
    : "bg-white/10 text-white/60";

  return (
    <div
      className={`flex items-center gap-4 px-6 py-3 transition-all ${
        isLeader
          ? "bg-amber-500/15 border-l-4 border-amber-400"
          : (dnf || dns)
          ? "bg-red-900/10 border-l-4 border-red-700/40 opacity-50"
          : pos % 2 === 0
          ? "bg-white/[0.03]"
          : "bg-transparent"
      }`}
    >
      {/* Position */}
      <div className={`w-12 h-12 rounded-full flex items-center justify-center font-heading font-black text-xl shrink-0 ${posColors}`}>
        {dnf ? "DNF" : dns ? "DNS" : pos}
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0">
        <p className={`font-heading font-black tracking-wide truncate ${isLeader ? "text-white text-2xl" : "text-white/90 text-xl"}`}>
          {riderName.toUpperCase()}
        </p>
        {bibNumber && (
          <p className="text-white/40 text-sm font-mono">#{bibNumber}</p>
        )}
      </div>

      {/* Best Lap */}
      <div className="shrink-0 text-right min-w-[120px]">
        {best !== null ? (
          <>
            <p className="text-white/40 text-xs uppercase tracking-wider font-semibold">Best Lap</p>
            <p className={`font-mono font-bold tabular-nums ${isLeader ? "text-amber-400 text-xl" : "text-white/80 text-lg"}`}>
              {fmtSecs(best)}
            </p>
          </>
        ) : (
          <p className="text-white/20 text-sm font-mono">—</p>
        )}
      </div>

      {/* Gap */}
      <div className="shrink-0 text-right min-w-[110px]">
        {isLeader ? (
          <span className="text-amber-400 font-black text-sm uppercase tracking-widest">LEADER</span>
        ) : gap !== null ? (
          <>
            <p className="text-white/40 text-xs uppercase tracking-wider font-semibold">Gap</p>
            <p className="font-mono font-bold tabular-nums text-red-400 text-lg">{fmtGap(gap)}</p>
          </>
        ) : (
          <p className="text-white/20 text-sm font-mono">—</p>
        )}
      </div>
    </div>
  );
}

// ─── Status badge ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === "in_progress") {
    return (
      <div className="flex items-center gap-2 bg-green-500/20 border border-green-500/40 rounded-full px-4 py-1.5">
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-400" />
        </span>
        <span className="text-green-400 font-black text-sm uppercase tracking-widest">In Progress</span>
      </div>
    );
  }
  if (status === "completed") {
    return (
      <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-full px-4 py-1.5">
        <span className="text-white/40 font-black text-sm uppercase tracking-widest">Final</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 bg-blue-500/20 border border-blue-500/30 rounded-full px-4 py-1.5">
      <span className="text-blue-400 font-black text-sm uppercase tracking-widest">Up Next</span>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function GateSchedulePage() {
  const { user } = useAuth();

  const clubId = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    const c = p.get("club");
    if (c) return Number(c);
    return user?.clubId ?? null;
  }, [user?.clubId]);

  const { data: events = [] } = useListEvents(
    { clubId: clubId ?? undefined, status: "race_day" } as any,
    { query: { enabled: !!clubId, refetchInterval: 30_000 } as any }
  );

  const raceDayEvents = events as Event[];
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const activeEventId = selectedEventId ?? (raceDayEvents[0]?.id ?? null);
  const activeEvent = raceDayEvents.find((e) => e.id === activeEventId) ?? raceDayEvents[0];

  const { data: rawMotos = [] } = useListMotos(
    activeEventId!,
    { query: { enabled: !!activeEventId, refetchInterval: 5_000 } as any }
  );

  const { data: rawResults = [] } = useListResults(
    activeEventId!,
    { query: { enabled: !!activeEventId, refetchInterval: 5_000 } as any }
  );

  const motos = useMemo(
    () => [...(rawMotos as Moto[])].sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0)),
    [rawMotos]
  );

  const results = rawResults as RaceResult[];

  // Pick the "featured" moto: first in_progress, then first upcoming, then last completed
  const featuredMoto = useMemo(() => {
    const inProg = motos.find((m) => m.status === "in_progress");
    if (inProg) return inProg;
    const upcoming = motos.find((m) => m.status === "scheduled");
    if (upcoming) return upcoming;
    const lastCompleted = [...motos].filter((m) => m.status === "completed").pop();
    return lastCompleted ?? null;
  }, [motos]);

  const upcomingQueue = useMemo(
    () => motos.filter((m) => m.id !== featuredMoto?.id && m.status === "scheduled"),
    [motos, featuredMoto]
  );

  // Build display rows for the featured moto
  const displayRows = useMemo(() => {
    if (!featuredMoto) return [];
    const isActive = featuredMoto.status === "in_progress" || featuredMoto.status === "completed";
    const motoResults = results.filter((r) => r.motoId === featuredMoto.id);

    if (isActive && motoResults.length > 0) {
      // Race mode: use results, sort by position
      const withBest = motoResults.map((r) => ({
        ...r,
        bestSecs: bestLap(r.lapTimes),
        totalSecs: parseSecs(r.totalTime),
      }));

      // Sort: finishers by position, DNF/DNS at bottom
      withBest.sort((a, b) => {
        if (a.dnf || a.dns) return 1;
        if (b.dnf || b.dns) return -1;
        return (a.position ?? 99) - (b.position ?? 99);
      });

      const leaderBest = withBest[0]?.bestSecs ?? null;
      const leaderTotal = withBest[0]?.totalSecs ?? null;

      return withBest.map((r, i) => ({
        key: r.id,
        mode: "race" as const,
        pos: r.position ?? i + 1,
        riderName: r.riderName,
        bibNumber: r.bibNumber,
        best: r.bestSecs,
        totalTime: r.totalSecs,
        leaderBest,
        leaderTotal,
        dnf: r.dnf ?? false,
        dns: r.dns ?? false,
        isLeader: i === 0 && !(r.dnf || r.dns),
      }));
    }

    // Gate order mode: use lineup
    const lineup = Array.isArray(featuredMoto.lineup)
      ? ([...featuredMoto.lineup] as { position: number; riderId: number; riderName: string; bibNumber?: string | null; gateNumber?: number | null }[])
      : [];
    lineup.sort((a, b) => a.position - b.position);

    return lineup.map((entry, i) => ({
      key: entry.riderId,
      mode: "gate" as const,
      pos: i + 1,
      riderName: entry.riderName,
      bibNumber: entry.bibNumber,
      raceClass: (featuredMoto.raceClasses?.length ? featuredMoto.raceClasses[0] : featuredMoto.raceClass) ?? null,
      isFirst: i === 0,
    }));
  }, [featuredMoto, results]);

  // ── No club ID ──
  if (!clubId) {
    return (
      <div className="min-h-screen bg-[#080c14] flex items-center justify-center">
        <div className="text-center px-6">
          <p className="font-heading font-black text-2xl text-white/30 uppercase tracking-widest">Invalid Link</p>
          <p className="text-white/20 mt-2 text-sm">Ask your promoter for the correct race day display link.</p>
        </div>
      </div>
    );
  }

  // ── No active event ──
  if (!activeEventId) {
    return (
      <div className="min-h-screen bg-[#080c14] flex flex-col">
        <Header event={null} events={raceDayEvents} selectedId={null} onSelect={() => {}} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center px-6">
            <div className="w-24 h-24 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-6">
              <img src={rmLogo} alt="" className="w-14 h-14 opacity-30" />
            </div>
            <p className="font-heading font-black text-3xl text-white/30 uppercase tracking-widest">No Race Today</p>
            <p className="text-white/20 mt-3 text-base">This display goes live when a race day event is active.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#080c14] flex flex-col select-none">
      {/* ── Header ── */}
      <Header
        event={activeEvent ?? null}
        events={raceDayEvents}
        selectedId={activeEventId}
        onSelect={(id) => setSelectedEventId(id)}
      />

      {/* ── Featured moto ── */}
      {featuredMoto ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Moto title bar */}
          <div className="px-8 py-5 bg-white/[0.03] border-b border-white/[0.06] flex items-center gap-4 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="text-white/40 text-sm font-black uppercase tracking-[0.2em] mb-1">
                Moto {featuredMoto.motoNumber}
                {featuredMoto.type && featuredMoto.type !== "main" && (
                  <span className="ml-2 text-white/30">· {featuredMoto.type.toUpperCase()}</span>
                )}
              </div>
              <h2 className="font-heading font-black text-3xl text-white uppercase tracking-widest leading-none">
                {featuredMoto.name}
              </h2>
              {(featuredMoto.raceClasses?.length || featuredMoto.raceClass) && (
                <p className="text-white/50 font-bold text-base uppercase tracking-widest mt-1">
                  {featuredMoto.raceClasses?.length ? featuredMoto.raceClasses.join(" · ") : featuredMoto.raceClass}
                </p>
              )}
            </div>
            <StatusBadge status={featuredMoto.status} />

            {/* Column headers */}
            <div className="w-full flex items-center gap-4 px-0 pt-3 border-t border-white/[0.06] mt-2">
              <div className="w-12 shrink-0" />
              <div className="flex-1 text-white/25 text-xs font-black uppercase tracking-[0.2em]">Rider</div>
              {displayRows[0]?.mode === "race" ? (
                <>
                  <div className="w-[120px] shrink-0 text-right text-white/25 text-xs font-black uppercase tracking-[0.2em]">Best Lap</div>
                  <div className="w-[110px] shrink-0 text-right text-white/25 text-xs font-black uppercase tracking-[0.2em]">Gap</div>
                </>
              ) : (
                <div className="w-[120px] shrink-0 text-right text-white/25 text-xs font-black uppercase tracking-[0.2em]">Bib #</div>
              )}
            </div>
          </div>

          {/* Rider rows */}
          <div className="flex-1 overflow-y-auto">
            {displayRows.length === 0 ? (
              <div className="flex items-center justify-center py-20">
                <p className="text-white/20 font-heading font-black text-xl uppercase tracking-widest">No Riders Assigned</p>
              </div>
            ) : (
              <div className="divide-y divide-white/[0.04]">
                {displayRows.map((row) =>
                  row.mode === "race" ? (
                    <ResultRow
                      key={row.key}
                      pos={row.pos}
                      riderName={row.riderName}
                      bibNumber={row.bibNumber}
                      best={row.best}
                      totalTime={row.totalTime}
                      leaderBest={row.leaderBest}
                      leaderTotal={row.leaderTotal}
                      dnf={row.dnf}
                      dns={row.dns}
                      isLeader={row.isLeader}
                    />
                  ) : (
                    <GateRow
                      key={row.key}
                      pos={row.pos}
                      riderName={row.riderName}
                      bibNumber={row.bibNumber}
                      raceClass={row.raceClass}
                      isFirst={row.isFirst}
                    />
                  )
                )}
              </div>
            )}
          </div>

          {/* ── Up Next strip ── */}
          {upcomingQueue.length > 0 && (
            <div className="border-t border-white/[0.08] bg-white/[0.02] px-6 py-3 flex items-center gap-6 overflow-x-auto">
              <span className="text-white/30 text-xs font-black uppercase tracking-[0.2em] shrink-0">Up Next</span>
              {upcomingQueue.map((m, i) => (
                <div key={m.id} className="flex items-center gap-3 shrink-0">
                  {i > 0 && <span className="text-white/10">·</span>}
                  <span className="text-white/25 text-xs font-bold uppercase tracking-wider">Moto {m.motoNumber}</span>
                  <span className="text-white/50 text-sm font-heading font-black uppercase tracking-wide">{m.name}</span>
                  {(m.raceClasses?.length || m.raceClass) && (
                    <span className="text-white/25 text-xs font-semibold uppercase">
                      {m.raceClasses?.length ? m.raceClasses.join(" · ") : m.raceClass}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-white/20 font-heading font-black text-2xl uppercase tracking-widest">No Motos Scheduled</p>
        </div>
      )}
    </div>
  );
}

// ─── Header ─────────────────────────────────────────────────────────────────

function Header({
  event,
  events,
  selectedId,
  onSelect,
}: {
  event: Event | null;
  events: Event[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <div className="bg-[#0d1220] border-b border-white/[0.07] px-6 py-4 flex items-center gap-4 shrink-0">
      {/* Logo */}
      <div className="flex items-center gap-3 shrink-0">
        <img src={rmLogo} alt="RM Tracker" className="h-10 w-10" />
        <div className="flex flex-col leading-none">
          <span className="font-heading font-black text-white text-lg uppercase tracking-widest">RM</span>
          <span className="font-heading font-black text-white/30 text-[10px] uppercase tracking-[0.3em]">Tracker</span>
        </div>
      </div>

      <div className="w-px h-8 bg-white/10 shrink-0" />

      {/* Event name / selector */}
      <div className="flex-1 min-w-0">
        {events.length > 1 ? (
          <Select
            value={selectedId?.toString() ?? ""}
            onValueChange={(v) => onSelect(Number(v))}
          >
            <SelectTrigger className="bg-white/5 border-white/10 text-white font-heading font-bold uppercase tracking-wide text-sm max-w-xs">
              <SelectValue placeholder="Select event" />
            </SelectTrigger>
            <SelectContent>
              {events.map((ev) => (
                <SelectItem key={ev.id} value={ev.id.toString()}>
                  {ev.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : event ? (
          <p className="font-heading font-black text-white text-xl uppercase tracking-widest truncate">{event.name}</p>
        ) : null}
      </div>

      {/* Live pill */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
        </span>
        <span className="text-green-400 text-xs font-black uppercase tracking-widest">Live</span>
      </div>

      <div className="w-px h-8 bg-white/10 shrink-0" />

      <LiveClock />
    </div>
  );
}
