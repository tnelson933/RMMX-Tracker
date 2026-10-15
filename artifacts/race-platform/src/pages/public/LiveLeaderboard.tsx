import { useState, useEffect, useRef } from "react";
import { useRoute, Link } from "wouter";
import { Flag, Clock, WifiOff, ChevronLeft, Radio, AlertTriangle, TrendingUp } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface LeaderboardEntry {
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
}

interface LeaderboardData {
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

export default function LiveLeaderboard() {
  const [, params] = useRoute("/live/:motoId");
  const motoId = params?.motoId;

  const [data, setData] = useState<LeaderboardData | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    <div className="min-h-screen bg-sidebar text-sidebar-foreground">
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
      <div className="border-b border-white/10 px-4 py-3 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 text-white/50 hover:text-white text-sm transition-colors">
          <ChevronLeft size={16} /> Home
        </Link>

        <div className="flex items-center gap-3 text-sm">
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
        <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4 p-8 text-center">
          <Radio size={48} className="text-white/20" />
          <h2 className="text-2xl font-heading font-bold uppercase">{error}</h2>
          <p className="text-white/50 text-sm">Check the moto ID or wait for the race to start.</p>
          <Link href="/"><button className="text-sm text-primary hover:underline">← Back to Home</button></Link>
        </div>
      ) : !data ? (
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="font-heading text-lg uppercase tracking-widest text-white/40 animate-pulse">Connecting to timing system…</div>
        </div>
      ) : (
        <>
          {/* Moto header */}
          <div className="px-4 py-6 text-center border-b border-white/10">
            <div className="text-white/40 text-xs font-bold uppercase tracking-widest mb-1">{data.raceClass}</div>
            <h1 className="text-3xl font-heading font-bold uppercase tracking-tight">{data.motoName}</h1>
            <div className="mt-3 flex items-center justify-center gap-4 flex-wrap">
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

          {/* Leaderboard table */}
          {data.leaderboard.length === 0 ? (
            <div className="text-center py-16 text-white/30 text-sm">
              <Radio size={32} className="mx-auto mb-3 opacity-30" />
              Waiting for first tag crossing…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-white/30 text-xs uppercase tracking-widest border-b border-white/10">
                    <th className="text-center w-12 py-3 px-3 font-bold">Pos</th>
                    <th className="text-left py-3 px-3 font-bold">Rider</th>
                    <th className="text-center w-16 py-3 px-2 font-bold hidden sm:table-cell">#</th>
                    <th className="text-center w-16 py-3 px-2 font-bold">Laps</th>
                    <th className="text-right py-3 px-3 font-bold">Total</th>
                    <th className="text-right py-3 px-3 font-bold hidden md:table-cell">Last Lap</th>
                    <th className="text-right w-24 py-3 px-3 font-bold hidden lg:table-cell">Gap</th>
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
                          <td className="text-center py-3 px-3 w-12">
                            <motion.span
                              layout
                              className={`font-heading font-bold text-lg ${
                                entry.position === 1 ? "text-yellow-400" :
                                entry.position === 2 ? "text-slate-300" :
                                entry.position === 3 ? "text-amber-600" :
                                "text-white/50"
                              }`}
                            >
                              {entry.dnf ? "DNF" : entry.dns ? "DNS" : entry.position}
                            </motion.span>
                          </td>

                          {/* Rider name — enlarges for 2s on position gain */}
                          <td className="py-2 px-3">
                            <motion.div
                              animate={justGained
                                ? { scale: 1.18, color: "#4ade80" }
                                : { scale: 1, color: "#ffffff" }
                              }
                              transition={{ type: "spring", stiffness: 300, damping: 22 }}
                              style={{ originX: 0 }}
                              className="font-heading font-bold text-base flex items-center gap-2"
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
                                    <TrendingUp size={16} className="text-green-400 shrink-0" />
                                  </motion.span>
                                )}
                              </AnimatePresence>
                              {entry.riderName}
                            </motion.div>
                          </td>

                          <td className="text-center py-3 px-2 hidden sm:table-cell">
                            <span className="font-mono text-white/50 text-xs">{entry.bibNumber ?? "—"}</span>
                          </td>
                          <td className="text-center py-3 px-2">
                            <span className="font-heading font-bold text-white">{entry.laps}</span>
                          </td>
                          <td className="text-right py-3 px-3 font-mono text-sm tabular-nums">
                            {entry.totalTime ?? "—"}
                          </td>
                          <td className="text-right py-3 px-3 font-mono text-sm text-white/50 tabular-nums hidden md:table-cell">
                            {entry.lastLap ?? "—"}
                          </td>
                          <td className="text-right py-3 px-3 text-sm text-white/40 hidden lg:table-cell">
                            {entry.gap}
                          </td>
                        </motion.tr>
                      );
                    })}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
          )}

          {/* Footer */}
          <div className="p-4 text-center text-white/20 text-xs">
            Powered by RM Tracker · Updates live
          </div>
        </>
      )}
    </div>
  );
}
