import { useState, useEffect, useRef, type ReactNode } from "react";
import { useRoute, Link } from "wouter";
import {
  Flag, Clock, WifiOff, ChevronLeft, Radio, AlertTriangle, TrendingUp,
  ArrowDown, ArrowUp, BarChart3, Repeat2, Timer, Zap,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export interface LeaderboardEntry {
  position: number;
  riderId: number;
  riderName: string;
  bibNumber: string | null;
  laps: number;
  lapTimes: string[];
  lastLap: string | null;
  totalTime: string | null;
  gap: string;
  dnf: boolean;
  dns: boolean;
  bestLapMs: number | null;
  bestLap: string | null;
}

interface RiderIdentity {
  riderId: number;
  riderName: string;
  bibNumber: string | null;
}

interface AnalyticsRider extends RiderIdentity {
  bestLapMs: number | null;
  bestLap: string | null;
}

interface PositionMover extends RiderIdentity {
  startPosition?: number;
  currentPosition?: number;
  positionsGained?: number;
  positionsLost?: number;
  fromPosition?: number;
  toPosition?: number;
  lapNumber?: number;
}

interface RaceAnalytics {
  lastCompletedLap: number | null;
  movingUp: PositionMover | null;
  mostPasses: PositionMover | null;
  fallingBack: PositionMover | null;
  fastestLap: (AnalyticsRider & {
    marginMs: number | null;
    margin: string | null;
    nextRiderName: string | null;
  }) | null;
  fastestLaps: AnalyticsRider[];
}

export interface LeaderboardData {
  motoId: number;
  motoName: string;
  raceClass: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  timeLimitMs: number | null;
  plusLaps: number | null;
  timeExpiredAt: string | null;
  leaderboard: LeaderboardEntry[];
  updatedAt: string;
  correction?: boolean;
  analytics?: RaceAnalytics;
}

function ElapsedClock({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = new Date(startedAt).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [startedAt]);

  const totalSeconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const centis = Math.floor((elapsed % 1000) / 10);
  return (
    <span className="font-mono tabular-nums">
      {minutes}:{String(seconds).padStart(2, "0")}.{String(centis).padStart(2, "0")}
    </span>
  );
}

function CountdownClock({ startedAt, timeLimitMs }: { startedAt: string; timeLimitMs: number }) {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    const start = new Date(startedAt).getTime();
    const tick = () => setRemaining(Math.max(0, timeLimitMs - (Date.now() - start)));
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [startedAt, timeLimitMs]);

  const totalSeconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const centis = Math.floor((remaining % 1000) / 10);
  return (
    <span className={`font-mono tabular-nums ${remaining < 60_000 ? "text-red-400" : remaining < 120_000 ? "text-orange-400" : ""}`}>
      {minutes}:{String(seconds).padStart(2, "0")}.{String(centis).padStart(2, "0")}
    </span>
  );
}

type LiveView = "timing" | "analytics" | "fastest";

function ViewTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative flex min-w-max items-center justify-center gap-2 px-4 py-3 text-xs font-heading font-bold uppercase tracking-wider transition-colors sm:px-7 sm:text-sm ${
        active ? "text-white" : "text-white/45 hover:text-white/80"
      }`}
    >
      {icon}
      {label}
      {active && (
        <motion.span
          layoutId="live-view-active-tab"
          className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary"
        />
      )}
    </button>
  );
}

function EmptyInsight({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-28 items-center justify-center rounded-lg border border-dashed border-white/10 bg-black/10 px-5 text-center text-sm text-white/35">
      {children}
    </div>
  );
}

function InsightCard({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <article className="rounded-xl border border-white/10 bg-white/[0.035] p-5 shadow-lg shadow-black/10">
      <div className="mb-5 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          {icon}
        </div>
        <div>
          <h2 className="font-heading text-lg font-bold uppercase tracking-wide text-white">{title}</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-white/40">{description}</p>
        </div>
      </div>
      {children}
    </article>
  );
}

function RiderInsight({
  riderName,
  bibNumber,
  metric,
  detail,
}: {
  riderName: string;
  bibNumber: string | null;
  metric: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/15 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-heading text-xl font-bold text-white">{riderName}</span>
            {bibNumber && (
              <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] text-white/50">
                #{bibNumber}
              </span>
            )}
          </div>
          <div className="mt-2 text-sm text-white/45">{detail}</div>
        </div>
        <div className="shrink-0 text-right font-mono text-lg font-bold tabular-nums text-primary">{metric}</div>
      </div>
    </div>
  );
}

function QuickAnalytics({ analytics }: { analytics?: RaceAnalytics }) {
  const movingUp = analytics?.movingUp;
  const mostPasses = analytics?.mostPasses;
  const fallingBack = analytics?.fallingBack;
  const fastestLap = analytics?.fastestLap;

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4 p-4 sm:p-6 lg:grid-cols-2 lg:gap-5 lg:p-8">
      <InsightCard
        icon={<ArrowUp size={20} />}
        title="Moving Up"
        description="Most positions gained during the latest completed lap."
      >
        {movingUp ? (
          <RiderInsight
            riderName={movingUp.riderName}
            bibNumber={movingUp.bibNumber}
            metric={`+${movingUp.positionsGained ?? 0}`}
            detail={`Lap ${movingUp.lapNumber}: #${movingUp.fromPosition} → #${movingUp.toPosition}`}
          />
        ) : (
          <EmptyInsight>Waiting for a rider to gain a position during a completed lap.</EmptyInsight>
        )}
      </InsightCard>

      <InsightCard
        icon={<Repeat2 size={20} />}
        title="Most Passes"
        description="Biggest position gain from the end of lap 1 to the current order."
      >
        {mostPasses ? (
          <RiderInsight
            riderName={mostPasses.riderName}
            bibNumber={mostPasses.bibNumber}
            metric={`${mostPasses.positionsGained ?? 0} pass${mostPasses.positionsGained === 1 ? "" : "es"}`}
            detail={`Started #${mostPasses.startPosition} after lap 1 · Now #${mostPasses.currentPosition}`}
          />
        ) : (
          <EmptyInsight>No net position gains have been recorded since lap 1.</EmptyInsight>
        )}
      </InsightCard>

      <InsightCard
        icon={<ArrowDown size={20} />}
        title="Falling Back"
        description="Largest position loss from the end of lap 1 to the current order."
      >
        {fallingBack ? (
          <RiderInsight
            riderName={fallingBack.riderName}
            bibNumber={fallingBack.bibNumber}
            metric={`-${fallingBack.positionsLost ?? 0}`}
            detail={`Started #${fallingBack.startPosition} after lap 1 · Now #${fallingBack.currentPosition}`}
          />
        ) : (
          <EmptyInsight>No rider has lost a net position since lap 1.</EmptyInsight>
        )}
      </InsightCard>

      <InsightCard
        icon={<Zap size={20} />}
        title="Fastest Lap"
        description="Best single lap of the race compared with the next-fastest rider."
      >
        {fastestLap ? (
          <RiderInsight
            riderName={fastestLap.riderName}
            bibNumber={fastestLap.bibNumber}
            metric={fastestLap.bestLap ?? "—"}
            detail={fastestLap.margin && fastestLap.nextRiderName
              ? `${fastestLap.margin} faster than ${fastestLap.nextRiderName}`
              : "No second timed rider available for comparison yet"}
          />
        ) : (
          <EmptyInsight>Waiting for the first completed timed lap.</EmptyInsight>
        )}
      </InsightCard>
    </div>
  );
}

function FastestLapRanking({ data }: { data: LeaderboardData }) {
  const fastestLaps = data.analytics?.fastestLaps ?? [...data.leaderboard]
    .sort((a, b) => {
      if (a.bestLapMs == null && b.bestLapMs == null) return a.position - b.position;
      if (a.bestLapMs == null) return 1;
      if (b.bestLapMs == null) return -1;
      return a.bestLapMs - b.bestLapMs;
    })
    .map(entry => ({
      riderId: entry.riderId,
      riderName: entry.riderName,
      bibNumber: entry.bibNumber,
      bestLapMs: entry.bestLapMs,
      bestLap: entry.bestLap,
    }));
  const leaderTime = fastestLaps.find(entry => entry.bestLapMs != null)?.bestLapMs ?? null;

  if (fastestLaps.length === 0) {
    return (
      <div className="flex min-h-full items-center justify-center p-8 text-center text-white/35">
        <div>
          <Timer size={36} className="mx-auto mb-3 opacity-40" />
          Waiting for timed laps…
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.025]">
        <div className="border-b border-white/10 px-4 py-4 sm:px-6">
          <h2 className="font-heading text-xl font-bold uppercase tracking-wide text-white">Fastest laps</h2>
          <p className="mt-1 text-sm text-white/40">Each rider’s quickest completed lap, fastest to slowest.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs uppercase tracking-widest text-white/30">
                <th className="w-14 px-3 py-3 text-center font-bold">Rank</th>
                <th className="px-3 py-3 text-left font-bold">Rider</th>
                <th className="hidden w-20 px-3 py-3 text-center font-bold sm:table-cell">#</th>
                <th className="px-3 py-3 text-right font-bold">Best lap</th>
                <th className="hidden w-32 px-3 py-3 text-right font-bold md:table-cell">Off fastest</th>
              </tr>
            </thead>
            <tbody>
              {fastestLaps.map((entry, index) => {
                const gapMs = leaderTime != null && entry.bestLapMs != null ? entry.bestLapMs - leaderTime : null;
                return (
                  <tr key={entry.riderId} className={`border-b border-white/5 last:border-0 ${index === 0 ? "bg-yellow-400/[0.06]" : ""}`}>
                    <td className={`px-3 py-4 text-center font-heading text-lg font-bold ${index === 0 ? "text-yellow-400" : "text-white/45"}`}>
                      {entry.bestLapMs != null ? index + 1 : "—"}
                    </td>
                    <td className="px-3 py-4 font-heading text-base font-bold text-white">{entry.riderName}</td>
                    <td className="hidden px-3 py-4 text-center font-mono text-xs text-white/45 sm:table-cell">{entry.bibNumber ?? "—"}</td>
                    <td className="px-3 py-4 text-right font-mono font-bold tabular-nums text-white">{entry.bestLap ?? "Waiting"}</td>
                    <td className="hidden px-3 py-4 text-right font-mono tabular-nums text-white/40 md:table-cell">
                      {gapMs == null ? "—" : gapMs === 0 ? "Fastest" : `+${(gapMs / 1000).toFixed(2)}s`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function LiveTimingTable({
  data,
  positionGains,
}: {
  data: LeaderboardData;
  positionGains: Set<number>;
}) {
  if (data.leaderboard.length === 0) {
    return (
      <div className="flex min-h-full items-center justify-center py-16 text-center text-sm text-white/30">
        <div>
          <Radio size={32} className="mx-auto mb-3 opacity-30" />
          Waiting for first tag crossing…
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-sidebar/95 backdrop-blur">
          <tr className="border-b border-white/10 text-xs uppercase tracking-widest text-white/30">
            <th className="w-12 px-3 py-3 text-center font-bold">Pos</th>
            <th className="px-3 py-3 text-left font-bold">Rider</th>
            <th className="hidden w-16 px-2 py-3 text-center font-bold sm:table-cell">#</th>
            <th className="w-16 px-2 py-3 text-center font-bold">Laps</th>
            <th className="px-3 py-3 text-right font-bold">Total</th>
            <th className="hidden px-3 py-3 text-right font-bold md:table-cell">Last Lap</th>
            <th className="hidden w-24 px-3 py-3 text-right font-bold lg:table-cell">Gap</th>
          </tr>
        </thead>
        <tbody>
          <AnimatePresence initial={false}>
            {data.leaderboard.map((entry) => {
              const justGained = positionGains.has(entry.riderId);
              return (
                <motion.tr
                  key={entry.riderId}
                  layout
                  layoutId={`rider-${entry.riderId}`}
                  initial={{ opacity: 0, y: -12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ layout: { type: "spring", stiffness: 400, damping: 35 }, duration: 0.3 }}
                  className={`border-b border-white/5 ${
                    entry.position === 1 ? "bg-white/5" : ""
                  } ${entry.dnf || entry.dns ? "opacity-40" : ""}`}
                >
                  <td className="w-12 px-3 py-3 text-center">
                    <motion.span
                      layout
                      className={`font-heading text-lg font-bold ${
                        entry.position === 1 ? "text-yellow-400" :
                        entry.position === 2 ? "text-slate-300" :
                        entry.position === 3 ? "text-amber-600" :
                        "text-white/50"
                      }`}
                    >
                      {entry.dnf ? "DNF" : entry.dns ? "DNS" : entry.position}
                    </motion.span>
                  </td>
                  <td className="px-3 py-2">
                    <motion.div
                      animate={justGained
                        ? { scale: 1.18, color: "#4ade80" }
                        : { scale: 1, color: "#ffffff" }
                      }
                      transition={{ type: "spring", stiffness: 300, damping: 22 }}
                      style={{ originX: 0 }}
                      className="flex items-center gap-2 font-heading text-base font-bold"
                    >
                      <AnimatePresence>
                        {justGained && (
                          <motion.span
                            key="gain-arrow"
                            initial={{ opacity: 0, x: -6, scale: 0.7 }}
                            animate={{ opacity: 1, x: 0, scale: 1 }}
                            exit={{ opacity: 0, x: -6, scale: 0.7 }}
                            transition={{ duration: 0.2 }}
                            className="inline-flex items-center"
                          >
                            <TrendingUp size={16} className="shrink-0 text-green-400" />
                          </motion.span>
                        )}
                      </AnimatePresence>
                      {entry.riderName}
                    </motion.div>
                  </td>
                  <td className="hidden px-2 py-3 text-center sm:table-cell">
                    <span className="font-mono text-xs text-white/50">{entry.bibNumber ?? "—"}</span>
                  </td>
                  <td className="px-2 py-3 text-center">
                    <span className="font-heading font-bold text-white">{entry.laps}</span>
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-sm tabular-nums">{entry.totalTime ?? "—"}</td>
                  <td className="hidden px-3 py-3 text-right font-mono text-sm tabular-nums text-white/50 md:table-cell">{entry.lastLap ?? "—"}</td>
                  <td className="hidden px-3 py-3 text-right text-sm text-white/40 lg:table-cell">{entry.gap}</td>
                </motion.tr>
              );
            })}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  );
}

export function useLiveRaceStream(motoId: number | string | null | undefined) {
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correctionVisible, setCorrectionVisible] = useState(false);
  const [positionGains, setPositionGains] = useState<Set<number>>(new Set());
  const previousPositions = useRef<Map<number, number>>(new Map());
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const correctionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gainTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    setData(null);
    setError(null);
    setConnected(false);
    setCorrectionVisible(false);
    setPositionGains(new Set());
    previousPositions.current = new Map();
    if (motoId == null) return;

    let disposed = false;
    let source: EventSource | null = null;

    const connect = () => {
      if (disposed) return;
      source = new EventSource(`/api/timing/live/${motoId}`);
      source.onopen = () => setConnected(true);
      source.onmessage = event => {
        try {
          const payload = JSON.parse(event.data) as LeaderboardData & { error?: string };
          if (payload.error) {
            setError(payload.error);
            return;
          }
          if (payload.correction) {
            setCorrectionVisible(true);
            if (correctionTimer.current) clearTimeout(correctionTimer.current);
            correctionTimer.current = setTimeout(() => setCorrectionVisible(false), 5_000);
          }
          const gainers = payload.leaderboard
            .filter(entry => !entry.dnf && !entry.dns)
            .filter(entry => {
              const oldPosition = previousPositions.current.get(entry.riderId);
              return oldPosition != null && entry.position < oldPosition;
            })
            .map(entry => entry.riderId);
          payload.leaderboard.forEach(entry => previousPositions.current.set(entry.riderId, entry.position));
          if (gainers.length) {
            setPositionGains(current => new Set([...current, ...gainers]));
            gainers.forEach(riderId => {
              const existing = gainTimers.current.get(riderId);
              if (existing) clearTimeout(existing);
              gainTimers.current.set(riderId, setTimeout(() => {
                setPositionGains(current => {
                  const next = new Set(current);
                  next.delete(riderId);
                  return next;
                });
              }, 2_000));
            });
          }
          setData(payload);
          setError(null);
        } catch {
          setError("Live timing sent an unreadable update.");
        }
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        reconnectTimer.current = setTimeout(connect, 3_000);
      };
    };

    connect();
    return () => {
      disposed = true;
      source?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (correctionTimer.current) clearTimeout(correctionTimer.current);
      gainTimers.current.forEach(clearTimeout);
      gainTimers.current.clear();
    };
  }, [motoId]);

  return { data, connected, error, correctionVisible, positionGains };
}

export function LiveRaceViews({
  data,
  connected,
  error,
  correctionVisible = false,
  positionGains = new Set<number>(),
  compact = false,
  showRaceStatus = false,
}: {
  data: LeaderboardData | null;
  connected: boolean;
  error?: string | null;
  correctionVisible?: boolean;
  positionGains?: Set<number>;
  compact?: boolean;
  showRaceStatus?: boolean;
}) {
  const [activeView, setActiveView] = useState<LiveView>("timing");
  const isLive = data?.status === "in_progress";
  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
      <AnimatePresence>
        {correctionVisible && (
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="z-20 flex items-center justify-center gap-2 bg-amber-500 px-3 py-2 text-center text-xs font-bold text-black"
          >
            <AlertTriangle size={14} /> Results corrected — a timing entry was removed by the organizer
          </motion.div>
        )}
      </AnimatePresence>
      <div className={`flex items-center justify-between border-b border-white/10 ${compact ? "px-3 py-2" : "px-4 py-3"}`}>
        <div className="min-w-0">
          <div className="truncate font-heading text-sm font-bold uppercase text-white">{data?.motoName ?? "Live race"}</div>
          {data?.raceClass && <div className="truncate text-[10px] uppercase tracking-wider text-white/35">{data.raceClass}</div>}
        </div>
        <span className={`ml-3 flex shrink-0 items-center gap-1.5 text-xs ${connected ? "text-green-400" : "text-yellow-400"}`}>
          {connected ? <Radio size={13} /> : <WifiOff size={13} />}
          {connected ? "Live" : "Reconnecting…"}
        </span>
      </div>
      {showRaceStatus && data && (
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-3 border-b border-white/10 px-4 py-3">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${
            isLive ? "bg-primary text-white" :
            data.status === "completed" ? "border border-secondary/30 bg-secondary/30 text-secondary" :
            "bg-white/10 text-white/60"
          }`}>
            {isLive && (
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" />
              </span>
            )}
            {data.status.replace("_", " ")}
          </span>
          {isLive && data.startedAt && data.timeLimitMs && !data.timeExpiredAt && (
            <span className="flex items-center gap-1.5 text-sm text-white/70">
              <Clock size={13} />
              <CountdownClock startedAt={data.startedAt} timeLimitMs={data.timeLimitMs} />
              {data.plusLaps != null && data.plusLaps > 0 && (
                <span className="text-xs text-white/40">+{data.plusLaps} lap{data.plusLaps > 1 ? "s" : ""}</span>
              )}
            </span>
          )}
          {isLive && data.startedAt && data.timeLimitMs && data.timeExpiredAt && (
            <span className="flex items-center gap-1.5 rounded-full bg-orange-500/20 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-orange-400 animate-pulse">
              <Flag size={11} />
              Time Expired{data.plusLaps != null && data.plusLaps > 0 ? ` — +${data.plusLaps} Lap${data.plusLaps > 1 ? "s" : ""}` : ""}
            </span>
          )}
          {isLive && data.startedAt && !data.timeLimitMs && (
            <span className="flex items-center gap-1.5 text-sm text-white/50">
              <Clock size={13} />
              <ElapsedClock startedAt={data.startedAt} />
            </span>
          )}
          {data.status === "completed" && (
            <span className="flex items-center gap-1.5 text-sm text-white/50">
              <Flag size={13} /> Race finished
            </span>
          )}
        </div>
      )}
      <div role="tablist" aria-label="Live race views" className="flex shrink-0 justify-start overflow-x-auto border-b border-white/10 bg-black/10">
        <ViewTab active={activeView === "timing"} icon={<Radio size={15} />} label="Live Timing" onClick={() => setActiveView("timing")} />
        <ViewTab active={activeView === "analytics"} icon={<BarChart3 size={15} />} label="Quick Analytics" onClick={() => setActiveView("analytics")} />
        <ViewTab active={activeView === "fastest"} icon={<Timer size={15} />} label="Fastest Lap" onClick={() => setActiveView("fastest")} />
      </div>
      <section role="tabpanel" className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${compact ? "text-xs" : ""}`}>
        {error ? (
          <div className="flex min-h-40 items-center justify-center p-6 text-center text-sm text-white/45">{error}</div>
        ) : !data ? (
          <div className="flex min-h-40 items-center justify-center p-6 text-center font-heading text-sm uppercase tracking-widest text-white/35 animate-pulse">
            Connecting to timing system…
          </div>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={activeView} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-h-full">
              {activeView === "timing" && <LiveTimingTable data={data} positionGains={positionGains} />}
              {activeView === "analytics" && <QuickAnalytics analytics={data.analytics} />}
              {activeView === "fastest" && <FastestLapRanking data={data} />}
            </motion.div>
          </AnimatePresence>
        )}
      </section>
    </div>
  );
}

function LegacyLiveLeaderboard() {
  const [, params] = useRoute("/live/:motoId");
  const motoId = params?.motoId;

  const [data, setData] = useState<LeaderboardData | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<LiveView>("timing");
  const [correctionVisible, setCorrectionVisible] = useState(false);
  const correctionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // Track previous state for change detection
  const prevPositionsRef = useRef<Map<number, number>>(new Map());
  const prevLapsRef = useRef<Map<number, number>>(new Map());

  // Set of riderIds currently in their 2-second "gained position" highlight
  const [positionGains, setPositionGains] = useState<Set<number>>(new Set());
  const gainTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (!motoId) return;

    function connect() {
      const es = new EventSource(`/api/timing/live/${motoId}`);
      esRef.current = es;

      es.onopen = () => setConnected(true);

      es.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data) as LeaderboardData;
          if ((payload as any).error) { setError((payload as any).error); return; }

          // Show correction banner
          if (payload.correction) {
            setCorrectionVisible(true);
            if (correctionTimerRef.current) clearTimeout(correctionTimerRef.current);
            correctionTimerRef.current = setTimeout(() => setCorrectionVisible(false), 5000);
          }

          // Detect riders who gained a position
          const gainers: number[] = [];
          for (const entry of payload.leaderboard) {
            if (entry.dnf || entry.dns) continue;
            const oldPos = prevPositionsRef.current.get(entry.riderId);
            if (oldPos !== undefined && entry.position < oldPos) {
              gainers.push(entry.riderId);
            }
          }

          // Update tracking refs
          for (const entry of payload.leaderboard) {
            prevPositionsRef.current.set(entry.riderId, entry.position);
            prevLapsRef.current.set(entry.riderId, entry.laps);
          }

          // Trigger 2-second highlight for gainers
          if (gainers.length > 0) {
            setPositionGains(prev => {
              const next = new Set(prev);
              gainers.forEach(id => next.add(id));
              return next;
            });
            gainers.forEach(riderId => {
              const existing = gainTimersRef.current.get(riderId);
              if (existing) clearTimeout(existing);
              gainTimersRef.current.set(riderId, setTimeout(() => {
                setPositionGains(prev => {
                  const next = new Set(prev);
                  next.delete(riderId);
                  return next;
                });
                gainTimersRef.current.delete(riderId);
              }, 2000));
            });
          }

          setData(payload);
          setError(null);
        } catch { /* ignore parse errors */ }
      };

      es.onerror = () => {
        setConnected(false);
        es.close();
        setTimeout(connect, 3000);
      };
    }

    connect();
    return () => {
      esRef.current?.close();
      if (correctionTimerRef.current) clearTimeout(correctionTimerRef.current);
      gainTimersRef.current.forEach(t => clearTimeout(t));
    };
  }, [motoId]);

  const isLive = data?.status === "in_progress";

  return (
    <main className="fixed inset-0 z-40 flex h-[100dvh] flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
      {/* Correction notice banner */}
      <AnimatePresence>
        {correctionVisible && (
          <motion.div
            key="correction-banner"
            initial={{ opacity: 0, y: -40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -40 }}
            transition={{ duration: 0.3 }}
            className="fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-2 bg-amber-500 text-black text-sm font-bold px-4 py-2 shadow-lg"
          >
            <AlertTriangle size={15} />
            Results corrected — a timing entry was removed by the organizer
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header bar */}
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-white/50 hover:text-white text-sm transition-colors">
          <ChevronLeft size={16} /> Home
        </Link>

        <div className="flex items-center gap-3 text-sm" aria-live="polite">
          {connected ? (
            <span className="flex items-center gap-1.5 text-green-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400"></span>
              </span>
              Live
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-yellow-400">
              <WifiOff size={14} /> Reconnecting…
            </span>
          )}
        </div>
      </div>

      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center space-y-4 p-8 text-center">
          <Radio size={48} className="text-white/20" />
          <h2 className="text-2xl font-heading font-bold uppercase">{error}</h2>
          <p className="text-white/50 text-sm">Check the moto ID or wait for the race to start.</p>
          <Link href="/"><button className="text-sm text-primary hover:underline">← Back to Home</button></Link>
        </div>
      ) : !data ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="font-heading text-lg uppercase tracking-widest text-white/40 animate-pulse">Connecting to timing system…</div>
        </div>
      ) : (
        <>
          {/* Moto header */}
          <div className="shrink-0 border-b border-white/10 px-4 py-4 text-center sm:py-5">
            <div className="text-white/40 text-xs font-bold uppercase tracking-widest mb-1">{data.raceClass}</div>
            <h1 className="font-heading text-2xl font-bold uppercase tracking-tight sm:text-3xl">{data.motoName}</h1>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-3 sm:mt-3 sm:gap-4">
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
                isLive ? "bg-primary text-white" :
                data.status === "completed" ? "bg-secondary/30 text-secondary border border-secondary/30" :
                "bg-white/10 text-white/60"
              }`}>
                {isLive && (
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-white"></span>
                  </span>
                )}
                {data.status.replace("_", " ")}
              </span>

              {isLive && data.startedAt && data.timeLimitMs && !data.timeExpiredAt && (
                <span className="text-white/70 text-sm flex items-center gap-1.5">
                  <Clock size={13} />
                  <CountdownClock startedAt={data.startedAt} timeLimitMs={data.timeLimitMs} />
                  {data.plusLaps != null && data.plusLaps > 0 && (
                    <span className="text-white/40 text-xs">+{data.plusLaps} lap{data.plusLaps > 1 ? "s" : ""}</span>
                  )}
                </span>
              )}

              {isLive && data.startedAt && data.timeLimitMs && data.timeExpiredAt && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-orange-500/20 text-orange-400 text-xs font-bold uppercase tracking-wide animate-pulse">
                  <Flag size={11} />
                  Time Expired{data.plusLaps != null && data.plusLaps > 0 ? ` — +${data.plusLaps} Lap${data.plusLaps > 1 ? "s" : ""}` : ""}
                </span>
              )}

              {isLive && data.startedAt && !data.timeLimitMs && (
                <span className="text-white/50 text-sm flex items-center gap-1.5">
                  <Clock size={13} />
                  <ElapsedClock startedAt={data.startedAt} />
                </span>
              )}

              {data.status === "completed" && (
                <span className="text-white/50 text-sm flex items-center gap-1.5">
                  <Flag size={13} /> Race finished
                </span>
              )}
            </div>
          </div>

          <div
            role="tablist"
            aria-label="Live race views"
            className="flex shrink-0 justify-start overflow-x-auto border-b border-white/10 bg-black/10 sm:justify-center"
          >
            <ViewTab
              active={activeView === "timing"}
              icon={<Radio size={16} />}
              label="Live Timing"
              onClick={() => setActiveView("timing")}
            />
            <ViewTab
              active={activeView === "analytics"}
              icon={<BarChart3 size={16} />}
              label="Quick Analytics"
              onClick={() => setActiveView("analytics")}
            />
            <ViewTab
              active={activeView === "fastest"}
              icon={<Timer size={16} />}
              label="Fastest Lap"
              onClick={() => setActiveView("fastest")}
            />
          </div>

          <section
            role="tabpanel"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={activeView}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.16 }}
                className="min-h-full"
              >
                {activeView === "timing" && (
                  <LiveTimingTable data={data} positionGains={positionGains} />
                )}
                {activeView === "analytics" && (
                  <QuickAnalytics analytics={data.analytics} />
                )}
                {activeView === "fastest" && (
                  <FastestLapRanking data={data} />
                )}
              </motion.div>
            </AnimatePresence>

            <footer className="p-4 text-center text-xs text-white/20">
              Powered by RM Tracker · Updates live
            </footer>
          </section>
        </>
      )}
    </main>
  );
}

export default function LiveLeaderboard() {
  const [, params] = useRoute("/live/:motoId");
  const stream = useLiveRaceStream(params?.motoId);
  return (
    <main className="fixed inset-0 z-40 flex h-[100dvh] flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-sm text-white/50 transition-colors hover:text-white">
          <ChevronLeft size={16} /> Home
        </Link>
        <span className="text-xs uppercase tracking-wider text-white/35">RM Tracker Live</span>
      </div>
      <LiveRaceViews {...stream} showRaceStatus />
    </main>
  );
}
