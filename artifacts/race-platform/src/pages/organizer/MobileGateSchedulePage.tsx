import { useState, useMemo, useEffect } from "react";
import { useListEvents, useListMotos, useListResults } from "@workspace/api-client-react";
import type { Moto, Event, RaceResult } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import rmLogo from "@assets/rm-logo.png";

// ─── Types ───────────────────────────────────────────────────────────────────

interface LineupEntry {
  position: number;
  riderId: number;
  riderName: string;
  bibNumber?: string | null;
  gateNumber?: number | null;
}

// ─── Live clock ──────────────────────────────────────────────────────────────

function LiveClock() {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="font-mono tabular-nums text-sm text-muted-foreground">
      {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </span>
  );
}

// ─── Gate pick row ───────────────────────────────────────────────────────────

function GatePickRow({ entry, isFirst }: { entry: LineupEntry; isFirst: boolean }) {
  const gateLabel = entry.gateNumber != null ? `GATE ${entry.gateNumber}` : `${entry.position}`;
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 ${isFirst ? "bg-amber-50 border-l-4 border-amber-400" : "border-l-4 border-transparent"}`}>
      <div className={`shrink-0 min-w-[60px] text-center rounded font-black text-xs py-1 px-2 uppercase tracking-widest ${
        isFirst ? "bg-amber-400 text-black" : "bg-muted text-muted-foreground"
      }`}>
        {gateLabel}
      </div>
      <span className={`flex-1 font-semibold truncate ${isFirst ? "text-foreground" : "text-foreground/80"}`}>
        {entry.riderName}
      </span>
      {entry.bibNumber && (
        <span className="shrink-0 font-mono text-sm text-muted-foreground">#{entry.bibNumber}</span>
      )}
    </div>
  );
}

// ─── Result row (in-progress/completed motos) ────────────────────────────────

function ResultRow({ pos, riderName, bibNumber, dnf, dns }: {
  pos: number;
  riderName: string;
  bibNumber?: string | null;
  dnf: boolean;
  dns: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 ${dnf || dns ? "opacity-40" : ""}`}>
      <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-black text-sm ${
        dnf || dns ? "bg-muted text-muted-foreground" :
        pos === 1 ? "bg-amber-400 text-black" :
        pos === 2 ? "bg-slate-300 text-black" :
        pos === 3 ? "bg-amber-700 text-white" :
        "bg-muted text-muted-foreground"
      }`}>
        {dnf ? "D" : dns ? "N" : pos}
      </div>
      <span className="flex-1 font-semibold truncate text-foreground/90">{riderName}</span>
      {bibNumber && (
        <span className="shrink-0 font-mono text-sm text-muted-foreground">#{bibNumber}</span>
      )}
      {(dnf || dns) && (
        <span className="shrink-0 text-xs font-black text-destructive/60">{dnf ? "DNF" : "DNS"}</span>
      )}
    </div>
  );
}

// ─── Featured moto card ──────────────────────────────────────────────────────

function FeaturedMotoCard({ moto, results }: { moto: Moto; results: RaceResult[] }) {
  const isLive = moto.status === "in_progress";
  const motoResults = results.filter((r) => r.motoId === moto.id);
  const hasResults = isLive && motoResults.length > 0;

  const lineup = useMemo<LineupEntry[]>(() => {
    if (!Array.isArray(moto.lineup)) return [];
    return [...(moto.lineup as LineupEntry[])].sort((a, b) => a.position - b.position);
  }, [moto.lineup]);

  const sortedResults = useMemo(() => {
    return [...motoResults].sort((a, b) => {
      if (a.dnf || a.dns) return 1;
      if (b.dnf || b.dns) return -1;
      return (a.position ?? 99) - (b.position ?? 99);
    });
  }, [motoResults]);

  const className = moto.raceClasses?.length
    ? moto.raceClasses.join(" · ")
    : (moto.raceClass ?? "");

  return (
    <div className="rounded-xl border-2 border-primary/20 bg-card overflow-hidden shadow-sm">
      {/* Header */}
      <div className={`px-4 py-3 flex items-center gap-3 ${isLive ? "bg-green-50 border-b border-green-200" : "bg-blue-50 border-b border-blue-100"}`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {isLive ? (
              <span className="flex items-center gap-1.5 text-xs font-black uppercase tracking-widest text-green-700">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
                In Progress
              </span>
            ) : (
              <span className="text-xs font-black uppercase tracking-widest text-blue-600">Up Next</span>
            )}
            <span className="text-xs text-muted-foreground font-semibold">Moto {moto.motoNumber}</span>
          </div>
          <h2 className="font-heading font-black text-lg text-foreground leading-tight truncate">{moto.name}</h2>
          {className && (
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider truncate">{className}</p>
          )}
        </div>
      </div>

      {/* Rows */}
      <div className="divide-y divide-border">
        {hasResults ? (
          sortedResults.length > 0 ? (
            sortedResults.map((r, i) => (
              <ResultRow
                key={r.id}
                pos={r.position ?? i + 1}
                riderName={r.riderName}
                bibNumber={r.bibNumber}
                dnf={r.dnf ?? false}
                dns={r.dns ?? false}
              />
            ))
          ) : (
            <p className="px-4 py-4 text-sm text-muted-foreground text-center">Waiting for results…</p>
          )
        ) : lineup.length > 0 ? (
          lineup.map((entry, i) => (
            <GatePickRow key={entry.riderId} entry={entry} isFirst={i === 0} />
          ))
        ) : (
          <p className="px-4 py-4 text-sm text-muted-foreground text-center">No riders assigned</p>
        )}
      </div>
    </div>
  );
}

// ─── Upcoming moto card ──────────────────────────────────────────────────────

function UpcomingMotoCard({ moto }: { moto: Moto }) {
  const [expanded, setExpanded] = useState(true);

  const lineup = useMemo<LineupEntry[]>(() => {
    if (!Array.isArray(moto.lineup)) return [];
    return [...(moto.lineup as LineupEntry[])].sort((a, b) => a.position - b.position);
  }, [moto.lineup]);

  const className = moto.raceClasses?.length
    ? moto.raceClasses.join(" · ")
    : (moto.raceClass ?? "");

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <button
        type="button"
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-muted/40 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Moto {moto.motoNumber}</span>
          </div>
          <p className="font-heading font-black text-base text-foreground leading-tight truncate">{moto.name}</p>
          {className && (
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider truncate">{className}</p>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {lineup.length > 0 && (
            <span className="text-xs text-muted-foreground">{lineup.length} riders</span>
          )}
          <span className="text-muted-foreground text-lg leading-none">{expanded ? "▲" : "▼"}</span>
        </div>
      </button>

      {expanded && lineup.length > 0 && (
        <div className="border-t border-border divide-y divide-border">
          {lineup.map((entry, i) => (
            <GatePickRow key={entry.riderId} entry={entry} isFirst={i === 0} />
          ))}
        </div>
      )}

      {expanded && lineup.length === 0 && (
        <div className="border-t border-border px-4 py-3">
          <p className="text-sm text-muted-foreground text-center">Gate picks not yet set</p>
        </div>
      )}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function MobileGateSchedulePage() {
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
  const activeEvent = raceDayEvents[0] ?? null;
  const activeEventId = activeEvent?.id ?? null;

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

  // Split into featured (in_progress first, else first scheduled) and upcoming queue
  const featuredMoto = useMemo(() => {
    const live = motos.find((m) => m.status === "in_progress");
    if (live) return live;
    return motos.find((m) => m.status === "scheduled") ?? null;
  }, [motos]);

  const upcomingQueue = useMemo(
    () => motos.filter((m) => m.status === "scheduled" && m.id !== featuredMoto?.id),
    [motos, featuredMoto]
  );

  // ── No club ID ──
  if (!clubId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6">
        <div className="text-center">
          <p className="font-heading font-black text-xl text-muted-foreground">Invalid Link</p>
          <p className="text-sm text-muted-foreground mt-1">Ask your promoter for the correct gate schedule link.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background border-b border-border px-4 py-3 flex items-center gap-3 shadow-sm">
        <img src={rmLogo} alt="RM" className="h-7 w-7 shrink-0" />
        <div className="flex-1 min-w-0">
          {activeEvent ? (
            <p className="font-heading font-black text-sm uppercase tracking-widest truncate text-foreground">{activeEvent.name}</p>
          ) : (
            <p className="font-heading font-black text-sm uppercase tracking-widest text-muted-foreground">Gate Schedule</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {activeEventId && (
            <>
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              <span className="text-xs font-black text-green-600 uppercase tracking-widest">Live</span>
            </>
          )}
          <LiveClock />
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-4 space-y-4 max-w-lg mx-auto">
        {!activeEventId ? (
          <div className="text-center py-20">
            <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
              <img src={rmLogo} alt="" className="w-10 h-10 opacity-30" />
            </div>
            <p className="font-heading font-black text-xl text-muted-foreground uppercase tracking-widest">No Race Today</p>
            <p className="text-sm text-muted-foreground mt-2">This page goes live when a race day event is active.</p>
          </div>
        ) : motos.filter((m) => m.status !== "completed").length === 0 ? (
          <div className="text-center py-20">
            <p className="font-heading font-black text-xl text-muted-foreground uppercase tracking-widest">All Done!</p>
            <p className="text-sm text-muted-foreground mt-2">All motos have been completed.</p>
          </div>
        ) : (
          <>
            {/* Featured / current moto */}
            {featuredMoto && (
              <div>
                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-2 px-1">
                  {featuredMoto.status === "in_progress" ? "Now Racing" : "On Deck"}
                </p>
                <FeaturedMotoCard moto={featuredMoto} results={results} />
              </div>
            )}

            {/* Upcoming queue */}
            {upcomingQueue.length > 0 && (
              <div>
                <p className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-2 px-1">Coming Up</p>
                <div className="space-y-3">
                  {upcomingQueue.map((m) => (
                    <UpcomingMotoCard key={m.id} moto={m} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
