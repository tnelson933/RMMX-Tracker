import { useState, useEffect, useRef, useCallback } from "react";
import { useRoute, Link } from "wouter";
import { Flag, Clock, Wifi, WifiOff, ChevronLeft, Radio, Volume2, VolumeX } from "lucide-react";
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
  leaderboard: LeaderboardEntry[];
  updatedAt: string;
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

export default function LiveLeaderboard() {
  const [, params] = useRoute("/live/:motoId");
  const motoId = params?.motoId;

  const [data, setData] = useState<LeaderboardData | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcerOn, setAnnouncerOn] = useState(true);
  const [announcerLabel, setAnnouncerLabel] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);

  // Track previous leaderboard state for change detection
  const prevLapsRef = useRef<Map<number, number>>(new Map());
  const prevPositionsRef = useRef<Map<number, number>>(new Map());

  // Audio queue — never overlap announcements
  const audioQueueRef = useRef<string[]>([]);
  const playingRef = useRef(false);
  const announcerOnRef = useRef(true);

  // Keep ref in sync with state so callbacks always see latest value
  useEffect(() => {
    announcerOnRef.current = announcerOn;
  }, [announcerOn]);

  const drainQueue = useCallback(() => {
    if (playingRef.current || audioQueueRef.current.length === 0) return;
    const url = audioQueueRef.current.shift()!;
    playingRef.current = true;
    const audio = new Audio(url);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      playingRef.current = false;
      drainQueue();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      playingRef.current = false;
      drainQueue();
    };
    audio.play().catch(() => {
      playingRef.current = false;
      drainQueue();
    });
  }, []);

  const enqueueAudio = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    audioQueueRef.current.push(url);
    drainQueue();
  }, [drainQueue]);

  const triggerAnnouncement = useCallback(async (
    lapCompleted: number,
    top5: LeaderboardEntry[],
    positionChanges: Array<{ riderName: string; from: number; to: number }>,
    isComplete: boolean
  ) => {
    if (!announcerOnRef.current) return;
    try {
      setAnnouncerLabel(isComplete ? "Race complete!" : `Lap ${lapCompleted} announced`);
      const res = await fetch("/api/timing/announce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lapCompleted,
          top5: top5.slice(0, 5).map(e => ({
            position: e.position,
            riderName: e.riderName,
            laps: e.laps,
            lastLap: e.lastLap,
            totalTime: e.totalTime,
            gap: e.gap,
            dnf: e.dnf,
            dns: e.dns,
          })),
          positionChanges,
          isComplete,
        }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      enqueueAudio(blob);
    } catch {
      // Network error — skip silently
    }
  }, [enqueueAudio]);

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

          setData(prev => {
            // Detect changes vs previous state
            const prevLaps = prevLapsRef.current;
            const prevPos = prevPositionsRef.current;

            const top5 = payload.leaderboard.filter(r => !r.dnf && !r.dns).slice(0, 5);

            // Find the max lap just completed by any top-5 rider
            let maxNewLap = 0;
            const posChanges: Array<{ riderName: string; from: number; to: number }> = [];

            for (const entry of top5) {
              const oldLaps = prevLaps.get(entry.riderId) ?? 0;
              const oldPos = prevPos.get(entry.riderId);

              if (entry.laps > oldLaps && entry.laps > 0) {
                maxNewLap = Math.max(maxNewLap, entry.laps);
              }

              if (oldPos !== undefined && oldPos !== entry.position && entry.position <= 5) {
                posChanges.push({ riderName: entry.riderName, from: oldPos, to: entry.position });
              }
            }

            // Update refs for next comparison
            for (const entry of payload.leaderboard) {
              prevLaps.set(entry.riderId, entry.laps);
              prevPos.set(entry.riderId, entry.position);
            }

            // Fire announcement if a new lap was completed by someone in the top 5
            const isComplete = payload.status === "completed";
            const wasInProgress = prev?.status === "in_progress";

            if (maxNewLap > 0) {
              triggerAnnouncement(maxNewLap, top5, posChanges, isComplete);
            } else if (isComplete && wasInProgress) {
              // Race just finished — announce final result even if no new lap
              triggerAnnouncement(top5[0]?.laps ?? 0, top5, posChanges, true);
            }

            return payload;
          });
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
    };
  }, [motoId, triggerAnnouncement]);

  const isLive = data?.status === "in_progress";

  return (
    <div className="min-h-screen bg-sidebar text-sidebar-foreground">
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

          {/* Announcer toggle */}
          <button
            onClick={() => setAnnouncerOn(v => !v)}
            title={announcerOn ? "Mute announcer" : "Enable announcer"}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider transition-all ${
              announcerOn
                ? "bg-primary/20 text-primary border border-primary/40 hover:bg-primary/30"
                : "bg-white/5 text-white/30 border border-white/10 hover:bg-white/10"
            }`}
          >
            {announcerOn ? <Volume2 size={13} /> : <VolumeX size={13} />}
            {announcerOn ? "Announcer" : "Muted"}
          </button>
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

              {isLive && data.startedAt && (
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

              {/* Subtle announcer status */}
              <AnimatePresence>
                {announcerOn && announcerLabel && (
                  <motion.span
                    key={announcerLabel}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.3 }}
                    className="text-primary/60 text-xs flex items-center gap-1"
                  >
                    <Volume2 size={10} />
                    {announcerLabel}
                  </motion.span>
                )}
              </AnimatePresence>
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
                    <th className="text-center w-16 py-3 px-2 font-bold hidden sm:table-cell">Bib</th>
                    <th className="text-center w-16 py-3 px-2 font-bold">Laps</th>
                    <th className="text-right py-3 px-3 font-bold">Total</th>
                    <th className="text-right py-3 px-3 font-bold hidden md:table-cell">Last Lap</th>
                    <th className="text-right w-24 py-3 px-3 font-bold hidden lg:table-cell">Gap</th>
                  </tr>
                </thead>
                <tbody>
                  <AnimatePresence initial={false}>
                    {data.leaderboard.map((entry) => (
                      <motion.tr
                        key={entry.riderId}
                        layout
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.3 }}
                        className={`border-b border-white/5 ${
                          entry.position === 1 ? "bg-white/5" : ""
                        } ${entry.dnf || entry.dns ? "opacity-40" : ""}`}
                      >
                        <td className="text-center py-3 px-3 w-12">
                          <span className={`font-heading font-bold text-lg ${
                            entry.position === 1 ? "text-yellow-400" :
                            entry.position === 2 ? "text-slate-300" :
                            entry.position === 3 ? "text-amber-600" :
                            "text-white/50"
                          }`}>
                            {entry.dnf ? "DNF" : entry.dns ? "DNS" : entry.position}
                          </span>
                        </td>
                        <td className="py-3 px-3">
                          <div className="font-heading font-bold text-base">{entry.riderName}</div>
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
                    ))}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
          )}

          {/* Footer */}
          <div className="p-4 text-center text-white/20 text-xs">
            Powered by Rocky Mountain MX Tracker · Updates live
          </div>
        </>
      )}
    </div>
  );
}
