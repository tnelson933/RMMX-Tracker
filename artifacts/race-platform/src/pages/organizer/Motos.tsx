import { useState, useEffect, useRef, useMemo } from "react";
import { useRoute, Link } from "wouter";
import { getPublicOrigin } from "@/lib/publicOrigin";
import {
  useListMotos, useGenerateLineups, useGenerateMotoLineup, useUpdateMoto, useDeleteMoto,
  useGetEvent, useListCheckins, useCreateMoto, useListPointsTables,
  useUpdateResultLaps, useListResults, useGeneratePracticeSessions,
  getListMotosQueryKey, getListCheckinsQueryKey, Moto, updateMoto,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Settings, Play, CheckCircle, Flag, RefreshCw, Radio, ExternalLink, Copy, Check, Trash2, Video, PlusCircle, Plus, Users, Zap, GripVertical, Maximize2, Timer, Search, Clock, LayoutList, LayoutGrid, Trophy, Printer, ChevronLeft, ChevronRight, Wand2, Link2 } from "lucide-react";
import {
  DndContext, DragOverlay, useDraggable, useDroppable,
  PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
  pointerWithin,
} from "@dnd-kit/core";
import { useToast } from "@/hooks/use-toast";
import { LiveBroadcast } from "./LiveBroadcast";
import { format } from "date-fns";

type RawCrossing = {
  id: number;
  rfidNumber: string;
  riderId: number | null;
  riderName: string | null;
  lapNumber: number;
  lapTime: string | null;
  lapTimeMs: number | null;
  crossingTime: string;
  readerId: string | null;
};

type LeaderboardEntry = {
  position: number;
  riderId: number | null;
  riderName: string;
  bibNumber: string | null;
  laps: number;
  lastLap: string | null;
  totalTime: string | null;
  gap: string;
  dnf?: boolean;
  dns?: boolean;
};

type LeaderboardSnapshot = {
  motoId: number;
  motoName: string;
  raceClass: string;
  status: string;
  leaderboard: LeaderboardEntry[];
  updatedAt: string;
};

const POLL_INTERVAL_MS = 3000;

// ── AudioContext singleton ─────────────────────────────────────────────────────
// Re-creating AudioContext on every crossing adds 50-200ms of hardware init
// latency. We create it once on first use and reuse it indefinitely.
let _sharedAudioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext | null {
  try {
    if (!_sharedAudioCtx || _sharedAudioCtx.state === "closed") {
      _sharedAudioCtx = new AudioContext();
    }
    if (_sharedAudioCtx.state === "suspended") {
      void _sharedAudioCtx.resume();
    }
    return _sharedAudioCtx;
  } catch {
    return null;
  }
}

// Guard: timestamp of the last manual-lap optimistic ping.
// Prevents the SSE handler from double-pinging when a manual lap was just clicked.
let _lastManualPingAt = 0;

async function playRfidPing(count: number) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  // Await resume so ctx.currentTime is advancing before we schedule notes.
  // Without this, oscillators scheduled at time 0 are in the past by the time
  // the context actually starts and are silently dropped.
  if (ctx.state === "suspended") {
    try { await ctx.resume(); } catch { return; }
  }
  if (ctx.state !== "running") return;
  const pings = Math.min(count, 4);
  for (let i = 0; i < pings; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = 1046;
    // Small leading offset (0.01 s) so the first note is never scheduled at
    // exactly currentTime, which can be dropped on some Chromium builds.
    const t = ctx.currentTime + 0.01 + i * 0.18;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.35, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.start(t);
    osc.stop(t + 0.25);
  }
  // Context stays open and warm for the next crossing.
}

function LiveLeaderboard({ motoId }: { motoId: number }) {
  const [snapshot, setSnapshot] = useState<LeaderboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // Track total laps across all riders so we know when a new crossing arrives.
  // -1 on first load so we skip playing a sound for the initial snapshot.
  const prevLapTotalRef = useRef<number>(-1);

  useEffect(() => {
    setLoading(true);
    setSnapshot(null);
    prevLapTotalRef.current = -1;

    const es = new EventSource(`/api/timing/live/${motoId}`);
    esRef.current = es;

    es.onmessage = (evt) => {
      try {
        const data: LeaderboardSnapshot = JSON.parse(evt.data);
        if (!("error" in data)) {
          // Sound fires here — driven by SSE, not the polling loop.
          // This fires the instant the server broadcasts the crossing update.
          const totalLaps = data.leaderboard.reduce((s, e) => s + e.laps, 0);
          const prev = prevLapTotalRef.current;
          if (prev >= 0 && totalLaps > prev) {
            // Suppress if a manual lap button was just clicked (≤1.5 s ago)
            // to avoid double-pinging alongside the optimistic click sound.
            if (Date.now() - _lastManualPingAt > 1500) {
              void playRfidPing(totalLaps - prev);
            }
          }
          prevLapTotalRef.current = totalLaps;
          setSnapshot(data);
          setLastUpdated(new Date());
          setLoading(false);
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      setLoading(false);
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [motoId]);

  return (
    <div className="flex flex-col min-w-0">
      <div className="flex items-center justify-between px-3 py-2 bg-secondary/10 border-b">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-secondary" />
          </span>
          <span className="text-xs font-bold uppercase tracking-widest text-secondary">Live Order</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {lastUpdated ? `${format(lastUpdated, "h:mm:ss a")}` : "Waiting…"}
        </span>
      </div>

      {loading ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground animate-pulse">
          Connecting…
        </div>
      ) : !snapshot || snapshot.leaderboard.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground flex flex-col items-center gap-1.5">
          <Trophy size={16} className="text-muted-foreground/40" />
          No results yet
        </div>
      ) : (
        <div className="max-h-44 overflow-y-auto">
          <Table>
            <TableHeader className="bg-muted/40 sticky top-0">
              <TableRow>
                <TableHead className="text-xs py-1.5 w-8 text-center px-2">P</TableHead>
                <TableHead className="text-xs py-1.5">Rider</TableHead>
                <TableHead className="text-xs py-1.5 text-center w-10">Lps</TableHead>
                <TableHead className="text-xs py-1.5 text-right pr-3 w-20">Gap</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshot.leaderboard.map((entry) => (
                <TableRow
                  key={entry.riderId ?? entry.riderName}
                  className={`h-7 ${entry.position === 1 ? "bg-secondary/10" : ""}`}
                >
                  <TableCell className="py-1 px-2 text-center">
                    <span className={`font-heading font-bold text-xs ${entry.position === 1 ? "text-secondary" : "text-muted-foreground"}`}>
                      {entry.position}
                    </span>
                  </TableCell>
                  <TableCell className="py-1 text-xs font-medium leading-tight">
                    <span className={entry.dnf || entry.dns ? "line-through text-muted-foreground" : ""}>
                      {entry.riderName}
                    </span>
                    {entry.dnf && <span className="ml-1 text-[10px] text-destructive font-bold">DNF</span>}
                    {entry.dns && <span className="ml-1 text-[10px] text-muted-foreground font-bold">DNS</span>}
                  </TableCell>
                  <TableCell className="py-1 text-center text-xs font-mono font-bold tabular-nums">
                    {entry.laps}
                  </TableCell>
                  <TableCell className="py-1 pr-3 text-right text-xs tabular-nums text-muted-foreground">
                    {entry.gap === "Leader" ? (
                      <span className="text-secondary font-bold">Ldr</span>
                    ) : (
                      entry.gap
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function LiveCrossingsFeed({ motoId, minLapTimeMs }: { motoId: number; minLapTimeMs?: number | null }) {
  const [crossings, setCrossings] = useState<RawCrossing[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const knownIdsRef = useRef<Set<number>>(new Set());
  const { toast } = useToast();

  const fetchCrossings = async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(`/api/timing/crossings/${motoId}`, { signal: ctrl.signal });
      if (!res.ok) return;
      const data: RawCrossing[] = await res.json();
      if (Array.isArray(data)) {
        const newOnes = data.filter((c) => !knownIdsRef.current.has(c.id));
        if (newOnes.length > 0 && knownIdsRef.current.size > 0) {
          // Sound is now driven by the SSE leaderboard push (instant).
          // The poll only handles the visual flash here.
          setFlash(true);
          setTimeout(() => setFlash(false), 600);
        }
        data.forEach((c) => knownIdsRef.current.add(c.id));
        setCrossings([...data].reverse().slice(0, 15));
      }
      setLastUpdated(new Date());
    } catch {
      // ignore abort or network errors
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteCrossing = async (crossingId: number) => {
    setDeletingId(crossingId);
    try {
      const res = await fetch(`/api/timing/crossings/${crossingId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast({ title: "Failed to delete crossing", description: body.error ?? "Unknown error", variant: "destructive" });
        return;
      }
      toast({ title: "Crossing deleted", description: "Lap times recalculated." });
      await fetchCrossings();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not reach server";
      toast({ title: "Failed to delete crossing", description: msg, variant: "destructive" });
    } finally {
      setDeletingId(null);
    }
  };

  useEffect(() => {
    setLoading(true);
    setCrossings([]);
    fetchCrossings();
    const timer = setInterval(fetchCrossings, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [motoId]);

  return (
    <div className={`flex flex-col min-w-0 transition-all duration-150 ${flash ? "ring-2 ring-primary ring-offset-0" : ""}`}>
      <div className="flex items-center justify-between px-3 py-2 bg-primary/5 border-b">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          <span className="text-xs font-bold uppercase tracking-widest text-primary">Live Crossing Feed</span>
          {flash && (
            <span className="text-[10px] font-bold uppercase tracking-widest text-primary animate-pulse">
              ● RFID READ
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {lastUpdated ? `Updated ${format(lastUpdated, "h:mm:ss a")}` : "Loading…"}
        </span>
      </div>

      {loading ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground animate-pulse">
          Fetching crossings…
        </div>
      ) : crossings.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground flex flex-col items-center gap-1.5">
          <Zap size={16} className="text-muted-foreground/40" />
          No crossings yet — waiting for riders
        </div>
      ) : (
        <div className="max-h-44 overflow-y-auto">
          <Table>
            <TableHeader className="bg-muted/40 sticky top-0">
              <TableRow>
                <TableHead className="text-xs py-1.5 px-3">Rider</TableHead>
                <TableHead className="text-xs py-1.5 text-center w-14">Lap</TableHead>
                <TableHead className="text-xs py-1.5 text-center w-20">Lap Time</TableHead>
                <TableHead className="text-xs py-1.5 text-right pr-3 w-20">Time</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {crossings.map((c, idx) => {
                // Lap #1 is the start-gate crossing, not a full lap — never flag it.
                const isFlagged = minLapTimeMs != null && c.lapTimeMs != null && c.lapNumber !== 1 && c.lapTimeMs < minLapTimeMs;
                return (
                  <TableRow
                    key={c.id}
                    className={`h-7 ${
                      isFlagged
                        ? "bg-red-500/10 border-l-2 border-l-red-500"
                        : idx === 0
                        ? "bg-primary/5"
                        : ""
                    }`}
                  >
                    <TableCell className={`py-1 px-3 text-xs font-medium ${isFlagged ? "text-red-600 dark:text-red-400" : ""}`}>
                      {c.riderName ?? (
                        <span className="text-muted-foreground font-mono">{c.rfidNumber}</span>
                      )}
                    </TableCell>
                    <TableCell className={`py-1 text-center text-xs font-heading font-bold ${isFlagged ? "text-red-600 dark:text-red-400" : ""}`}>{c.lapNumber}</TableCell>
                    <TableCell className={`py-1 text-center text-xs font-mono ${isFlagged ? "text-red-600 dark:text-red-400" : ""}`}>
                      {c.lapTime ?? <span className="text-muted-foreground">—</span>}
                      {isFlagged && (
                        <span className="ml-1 text-[10px] font-bold uppercase text-red-500" title="Below minimum lap time">⚠</span>
                      )}
                    </TableCell>
                    <TableCell className="py-1 pr-3 text-right text-xs text-muted-foreground tabular-nums">
                      {format(new Date(c.crossingTime), "h:mm:ss")}
                    </TableCell>
                    <TableCell className="py-1 pr-1 text-right">
                      {confirmDeleteId === c.id ? (
                        <span className="inline-flex items-center gap-1">
                          <button
                            onClick={() => { setConfirmDeleteId(null); handleDeleteCrossing(c.id); }}
                            disabled={deletingId === c.id}
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-40"
                          >
                            Yes
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(c.id)}
                          disabled={deletingId === c.id}
                          className="text-muted-foreground/40 hover:text-destructive transition-colors disabled:opacity-40 p-0.5 rounded"
                          title="Delete crossing"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ── First Place Countdown ────────────────────────────────────────────────────

function formatCountdown(ms: number): string {
  if (ms <= 0) return "any moment";
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}

function FirstPlaceCountdown({ motoId, lapCount, variant = "banner" }: { motoId: number; lapCount?: number | null; variant?: "banner" | "inline" }) {
  const [allCrossings, setAllCrossings] = useState<RawCrossing[]>([]);
  const [now, setNow] = useState(Date.now());

  // Poll crossings every 3s
  useEffect(() => {
    let cancelled = false;
    const fetch_ = async () => {
      try {
        const res = await fetch(`/api/timing/crossings/${motoId}`);
        if (!res.ok || cancelled) return;
        const data: RawCrossing[] = await res.json();
        if (Array.isArray(data)) setAllCrossings(data);
      } catch { /* ignore */ }
    };
    fetch_();
    const poll = setInterval(fetch_, 3000);
    return () => { cancelled = true; clearInterval(poll); };
  }, [motoId]);

  // Tick countdown every second
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (allCrossings.length === 0) return null;

  // Find the leader: rider with highest lapNumber, tie-broken by most-recent crossingTime.
  // Group by riderId when available, falling back to rfidNumber as a stable key.
  // This prevents bib numbers from leaking into the display name.
  const byRider = new Map<string, RawCrossing[]>();
  for (const c of allCrossings) {
    const key = c.riderId != null ? `rider:${c.riderId}` : `rfid:${c.rfidNumber}`;
    if (!byRider.has(key)) byRider.set(key, []);
    byRider.get(key)!.push(c);
  }

  let leaderName = "";
  let leaderMaxLap = 0;
  let leaderLastCrossing: RawCrossing | null = null;
  let leaderLapTimes: number[] = [];

  for (const [, crossings] of byRider) {
    const maxLap = Math.max(...crossings.map(c => c.lapNumber));
    const latest = crossings.filter(c => c.lapNumber === maxLap).sort(
      (a, b) => new Date(b.crossingTime).getTime() - new Date(a.crossingTime).getTime()
    )[0];
    if (
      maxLap > leaderMaxLap ||
      (maxLap === leaderMaxLap && leaderLastCrossing &&
        new Date(latest.crossingTime) < new Date(leaderLastCrossing.crossingTime))
    ) {
      leaderMaxLap = maxLap;
      // Use the actual rider name from any crossing in the group; never the rfidNumber
      leaderName = crossings.find(c => c.riderName)?.riderName ?? crossings[0].rfidNumber;
      leaderLastCrossing = latest;
      leaderLapTimes = crossings.map(c => c.lapTimeMs).filter((v): v is number => v != null && v > 0);
    }
  }

  if (!leaderLastCrossing || leaderLapTimes.length < 2) return null;

  const avgLapMs = leaderLapTimes.reduce((a, b) => a + b, 0) / leaderLapTimes.length;
  const lastCrossingMs = new Date(leaderLastCrossing.crossingTime).getTime();

  // Always project one avg-lap forward from the leader's last crossing
  const projectedMs = lastCrossingMs + avgLapMs;
  const msUntil = projectedMs - now;
  const isOverdue = msUntil < 0;
  const isFinish = false;
  const timeStr = isOverdue ? `${formatCountdown(Math.abs(msUntil))} ago` : formatCountdown(msUntil);

  if (variant === "inline") {
    return (
      <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium shrink-0 transition-all ${
        isOverdue
          ? "bg-orange-500/10 border-orange-500/30 text-orange-600"
          : msUntil < 30000
          ? "bg-primary/10 border-primary/30 text-primary animate-pulse"
          : "bg-amber-500/5 border-amber-500/20 text-amber-700 dark:text-amber-400"
      }`}>
        <Flag size={11} className="shrink-0" />
        <span className="truncate max-w-[90px]">{leaderName.split(" ")[0]}</span>
        <span className="font-mono font-bold tabular-nums shrink-0">{timeStr}</span>
      </div>
    );
  }

  return (
    <div className={`border-t flex items-center gap-3 px-4 py-2.5 transition-all ${
      isOverdue
        ? "bg-orange-500/10 border-orange-500/30"
        : msUntil < 30000
        ? "bg-primary/10 animate-pulse"
        : "bg-amber-500/5"
    }`}>
      <div className={`shrink-0 ${isOverdue ? "text-orange-500" : msUntil < 30000 ? "text-primary" : "text-amber-500"}`}>
        <Flag size={15} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground leading-none mb-0.5">
          {isFinish ? "1st Place Finish Expected" : "1st Place Next Crossing"}
        </div>
        <div className="text-xs font-medium truncate text-foreground">{leaderName}</div>
      </div>
      <div className={`shrink-0 text-right font-heading font-bold tabular-nums ${
        isOverdue ? "text-orange-500" : msUntil < 30000 ? "text-primary text-base" : "text-amber-600 text-sm"
      }`}>
        {timeStr}
      </div>
    </div>
  );
}

// ── Practice Time Limit Countdown ────────────────────────────────────────────

function PracticeTimeLimitCountdown({
  startedAt,
  timeLimitMs,
  onExpire,
}: {
  startedAt: string | null;
  timeLimitMs: number | null;
  onExpire?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const expiredRef = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    expiredRef.current = false;
  }, [startedAt, timeLimitMs]);

  if (!startedAt || !timeLimitMs) return null;

  const endMs = new Date(startedAt).getTime() + timeLimitMs;
  const remaining = endMs - now;
  const isExpired = remaining <= 0;

  if (isExpired && !expiredRef.current) {
    expiredRef.current = true;
    onExpire?.();
  }

  if (isExpired) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-bold bg-destructive/10 border-destructive/30 text-destructive animate-pulse shrink-0">
        <Timer size={11} />
        Time&apos;s Up!
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium shrink-0 transition-all ${
      remaining < 60000
        ? "bg-destructive/10 border-destructive/30 text-destructive animate-pulse"
        : remaining < 120000
        ? "bg-primary/10 border-primary/30 text-primary"
        : "bg-sky-500/5 border-sky-500/20 text-sky-600 dark:text-sky-400"
    }`}>
      <Timer size={11} className="shrink-0" />
      <span className="font-mono font-bold tabular-nums">{formatCountdown(remaining)}</span>
    </div>
  );
}

// ── Drag-and-drop sub-components ───────────────────────────────────────────

type LineupEntry = { riderId: number; riderName: string; position: number; bibNumber?: string | null; rfidNumber?: string | null };

function DraggablePoolRider({ riderId, riderName, bibNumber }: { riderId: number; riderName: string; bibNumber?: string | null }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `pool-${riderId}` });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`flex items-center gap-2 px-3 py-1.5 cursor-grab active:cursor-grabbing select-none hover:bg-muted/60 transition-opacity touch-none ${isDragging ? "opacity-20" : ""}`}
    >
      <GripVertical size={12} className="text-muted-foreground/50 shrink-0" />
      {bibNumber && <span className="font-mono text-xs text-muted-foreground w-9 shrink-0">#{bibNumber}</span>}
      <span className="text-sm truncate">{riderName}</span>
    </div>
  );
}

// ── Lineup sort ────────────────────────────────────────────────────────────────

type LineupSort = "gate" | "name-asc" | "name-desc" | "bib" | "rfid";

function sortLineup(entries: LineupEntry[], sort: LineupSort): LineupEntry[] {
  if (sort === "gate") return entries;
  return [...entries].sort((a, b) => {
    switch (sort) {
      case "name-asc": return (a.riderName ?? "").localeCompare(b.riderName ?? "");
      case "name-desc": return (b.riderName ?? "").localeCompare(a.riderName ?? "");
      case "bib": {
        const na = parseInt(a.bibNumber ?? "") || Infinity;
        const nb = parseInt(b.bibNumber ?? "") || Infinity;
        return na !== nb ? na - nb : (a.bibNumber ?? "").localeCompare(b.bibNumber ?? "");
      }
      case "rfid": return (a.rfidNumber ?? "").localeCompare(b.rfidNumber ?? "");
    }
  });
}

function LineupSortBar({ sort, onChange }: { sort: LineupSort; onChange: (s: LineupSort) => void }) {
  const opts: { key: LineupSort; label: string }[] = [
    { key: "gate", label: "Gate Pick" },
    { key: "name-asc", label: "A→Z" },
    { key: "name-desc", label: "Z→A" },
    { key: "bib", label: "#" },
    { key: "rfid", label: "RFID" },
  ];
  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b bg-muted/20 flex-wrap">
      <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mr-0.5 shrink-0">Sort</span>
      {opts.map(o => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border transition-colors ${
            sort === o.key
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-background text-muted-foreground border-border hover:bg-muted/60"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Lap time helpers (mirrors server formatMs / parseTimeToMs) ─────────────────

function fmtLapMs(ms: number): string {
  if (ms <= 0) return "0:00.00";
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const centis = Math.floor((ms % 1000) / 10);
  return `${mins}:${String(secs).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

function parseLapInput(s: string): number {
  const colIdx = s.indexOf(":");
  if (colIdx >= 0) {
    const mins = parseInt(s.slice(0, colIdx), 10) || 0;
    const [secStr, fracStr = "0"] = s.slice(colIdx + 1).split(".");
    const secs = parseInt(secStr, 10) || 0;
    const frac = parseInt(fracStr.padEnd(3, "0").slice(0, 3), 10) || 0;
    return (mins * 60 + secs) * 1000 + frac;
  }
  const [secStr, fracStr = "0"] = s.split(".");
  const secs = parseInt(secStr, 10) || 0;
  const frac = parseInt(fracStr.padEnd(3, "0").slice(0, 3), 10) || 0;
  return secs * 1000 + frac;
}

// ── Lap Times Editor Dialog ────────────────────────────────────────────────────

type LapEditTarget = { riderId: number; riderName: string; motoId: number; eventId: number; minLapTimeMs?: number | null };

function LapTimesDialog({ target, onClose }: { target: LapEditTarget; onClose: () => void }) {
  const [laps, setLaps] = useState<string[]>([]);
  const [resultId, setResultId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();
  const updateLaps = useUpdateResultLaps();
  const queryClient = useQueryClient();

  useEffect(() => {
    setLoading(true);
    fetch(`/api/events/${target.eventId}/results`)
      .then(r => r.json())
      .then((results: any[]) => {
        const match = results.find((r: any) => r.motoId === target.motoId && r.riderId === target.riderId);
        if (match) {
          setResultId(match.id);
          const rawLaps: unknown[] = Array.isArray(match.lapTimes) ? match.lapTimes : [];
          setLaps(rawLaps.map(t => fmtLapMs(typeof t === "number" ? t : 0)));
        } else {
          setResultId(null);
          setLaps([]);
        }
      })
      .catch(() => toast({ title: "Failed to load lap times", variant: "destructive" }))
      .finally(() => setLoading(false));
  }, [target.eventId, target.motoId, target.riderId]);

  const lapMs = laps.map(parseLapInput).filter(ms => ms > 0);
  const totalMs = lapMs.reduce((s, t) => s + t, 0);

  const handleSave = () => {
    if (resultId === null) {
      toast({ title: "No result record found for this rider", variant: "destructive" });
      return;
    }
    updateLaps.mutate(
      { eventId: target.eventId, resultId, data: { lapTimes: lapMs } },
      {
        onSuccess: () => {
          toast({ title: "Lap times saved", description: `${lapMs.length} laps for ${target.riderName}` });
          queryClient.invalidateQueries({ queryKey: ["listResults", target.eventId] as any });
          onClose();
        },
        onError: (err: any) => {
          toast({ title: "Failed to save", description: err?.message ?? "Unknown error", variant: "destructive" });
        },
      }
    );
  };

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-heading uppercase tracking-tight flex items-center gap-2">
            <Clock size={16} className="text-primary" />
            Lap Times — {target.riderName}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-10 text-center text-sm text-muted-foreground animate-pulse">Loading…</div>
        ) : (
          <div className="space-y-3">
            {laps.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-2">No lap times recorded yet. Add one below.</p>
            )}
            <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
              {laps.map((lap, i) => {
                const lapMsValue = parseLapInput(lap);
                // i === 0 is the start-gate crossing, not a full lap — never flag it below minimum.
                const isBelowMin = i !== 0 && target.minLapTimeMs != null && lapMsValue > 0 && lapMsValue < target.minLapTimeMs;
                return (
                  <div key={i} className={`flex items-center gap-2 ${isBelowMin ? "rounded px-1 -mx-1 bg-red-50 dark:bg-red-950/30" : ""}`}>
                    <span className={`w-8 text-xs text-right font-mono shrink-0 ${isBelowMin ? "text-red-600 dark:text-red-400 font-bold" : "text-muted-foreground"}`}>
                      L{i + 1}
                    </span>
                    <Input
                      value={lap}
                      onChange={e => setLaps(prev => { const n = [...prev]; n[i] = e.target.value; return n; })}
                      className={`font-mono text-sm h-8 ${isBelowMin ? "border-red-400 text-red-600 dark:text-red-400 focus-visible:ring-red-400" : ""}`}
                      placeholder="0:00.00"
                    />
                    {isBelowMin && (
                      <span className="text-red-500 shrink-0" title="Below minimum lap time">
                        <Flag size={12} />
                      </span>
                    )}
                    <button
                      onClick={() => setLaps(prev => prev.filter((_, j) => j !== i))}
                      className="text-muted-foreground/40 hover:text-destructive transition-colors shrink-0 p-0.5"
                      title="Remove lap"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>

            <Button variant="outline" size="sm" className="w-full" onClick={() => setLaps(prev => [...prev, ""])}>
              <Plus size={13} className="mr-1" /> Add Lap
            </Button>

            {lapMs.length > 0 && (
              <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs font-mono text-muted-foreground flex justify-between">
                <span>{lapMs.length} laps</span>
                <span>Total: {fmtLapMs(totalMs)}</span>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={updateLaps.isPending || loading || resultId === null}>
            {updateLaps.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DraggableRiderRow({ entry, motoId, locked, onRecordLap, lapCooldown, rowNum, onViewLaps, hasShortLap }: {
  entry: LineupEntry; motoId: number; locked?: boolean;
  onRecordLap?: () => void; lapCooldown?: boolean; rowNum?: number;
  onViewLaps?: () => void; hasShortLap?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `rider-${motoId}-${entry.riderId}-${entry.position}`,
    disabled: locked,
  });
  return (
    <TableRow ref={setNodeRef} className={`h-8 select-none ${isDragging ? "opacity-25" : ""}`}>
      <TableCell className="w-12 text-center">
        <span className="font-heading font-bold text-sm text-foreground">{rowNum ?? ""}</span>
      </TableCell>
      <TableCell className="w-8 text-center">
        {locked ? (
          <span className="inline-flex items-center justify-center text-muted-foreground/30" title="Moto is completed — lineup locked">
            <GripVertical size={14} />
          </span>
        ) : (
          <span
            {...listeners}
            {...attributes}
            className="cursor-grab active:cursor-grabbing inline-flex items-center justify-center text-muted-foreground hover:text-foreground touch-none"
            title="Drag to move rider to another heat"
          >
            <GripVertical size={14} />
          </span>
        )}
      </TableCell>
      <TableCell className={`font-medium ${hasShortLap ? "text-red-600 dark:text-red-400" : ""}`}>
        {onViewLaps ? (
          <button onClick={onViewLaps} className={`flex items-center gap-1 transition-colors group ${hasShortLap ? "hover:text-red-700 dark:hover:text-red-300" : "hover:text-primary"}`}>
            {entry.riderName}
            <Clock size={11} className="opacity-0 group-hover:opacity-60 transition-opacity" />
          </button>
        ) : entry.riderName}
      </TableCell>
      <TableCell className="w-16 text-center font-mono text-xs">{entry.bibNumber || "—"}</TableCell>
      <TableCell className="w-20 text-center overflow-hidden">
        {entry.rfidNumber ? (
          <span className="inline-flex items-center gap-1 text-green-600 max-w-full">
            <Radio size={10} className="shrink-0" /> <span className="font-mono text-xs truncate">{entry.rfidNumber}</span>
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </TableCell>
      {onRecordLap !== undefined && (
        <TableCell className="pr-2 text-right">
          <button
            onClick={onRecordLap}
            disabled={lapCooldown}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-heading font-bold uppercase tracking-wide transition-all border ${
              lapCooldown
                ? "bg-green-100 border-green-300 text-green-600 opacity-60 cursor-not-allowed"
                : "bg-background border-border text-muted-foreground hover:border-orange-400 hover:text-orange-600 hover:bg-orange-50"
            }`}
            title="Record manual lap crossing for this rider"
          >
            <Timer size={11} />
            {lapCooldown ? "Recorded" : "Lap"}
          </button>
        </TableCell>
      )}
    </TableRow>
  );
}

function DroppableTrashZone({ visible }: { visible: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: "drop-trash" });
  return (
    <div
      ref={setNodeRef}
      className={`fixed right-4 bottom-6 z-50 flex flex-col items-center justify-center gap-1 sm:gap-2 w-14 h-14 sm:w-20 sm:h-20 rounded-2xl border-2 transition-all duration-150 pointer-events-auto ${
        visible ? "opacity-100 scale-100" : "opacity-0 scale-75 pointer-events-none"
      } ${
        isOver
          ? "bg-destructive border-destructive text-white shadow-xl shadow-destructive/40 scale-110"
          : "bg-background border-destructive/40 text-destructive/60 shadow-lg"
      }`}
    >
      <Trash2 size={isOver ? 22 : 18} className="transition-all sm:[--size:28px]" />
      <span className="text-[9px] sm:text-[10px] font-heading font-bold uppercase tracking-wider leading-none text-center">
        {isOver ? "Drop!" : "Remove"}
      </span>
    </div>
  );
}

function DroppableMotoLineup({ motoId, children, locked, disableDrop, className }: { motoId: number; children: React.ReactNode; locked?: boolean; disableDrop?: boolean; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `drop-${motoId}`, disabled: locked || disableDrop });
  return (
    <div
      ref={setNodeRef}
      className={`border-b transition-colors ${isOver && !locked && !disableDrop ? "bg-primary/5 ring-2 ring-inset ring-primary/30" : ""} ${className ?? "flex-1 overflow-y-auto max-h-52"}`}
    >
      {children}
    </div>
  );
}

function DraggableMotoGrip({ motoId, disabled }: { motoId: number; disabled?: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `moto-card-${motoId}`,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`cursor-grab active:cursor-grabbing p-1 rounded hover:bg-white/10 text-sidebar-foreground/40 hover:text-sidebar-foreground/80 transition-colors touch-none shrink-0 ${isDragging ? "opacity-40" : ""}`}
      title="Drag to reorder"
    >
      <GripVertical size={15} />
    </div>
  );
}

function DroppableMotoSlot({ id, active }: { id: string; active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !active });
  return (
    <div
      ref={setNodeRef}
      className={`transition-all duration-150 rounded-xl mx-0.5 ${
        active
          ? isOver
            ? "h-14 bg-primary/10 border-2 border-dashed border-primary/50 flex items-center justify-center"
            : "h-2.5 border-2 border-dashed border-transparent"
          : "h-1"
      }`}
    >
      {active && isOver && (
        <span className="text-[10px] font-bold uppercase tracking-widest text-primary/70">Drop here</span>
      )}
    </div>
  );
}

function GateDropSlotRow({ id, isActive, colSpan }: { id: string; isActive: boolean; colSpan: number }) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !isActive });
  return (
    <tr ref={setNodeRef} style={{ height: isActive ? (isOver ? "6px" : "4px") : "0px" }}>
      <td
        colSpan={colSpan}
        style={{ padding: 0, height: "inherit" }}
        className={`transition-colors ${isActive && isOver ? "bg-primary" : ""}`}
      />
    </tr>
  );
}

// ── Min lap time helpers ─────────────────────────────────────────────────────

function parseMinLapTime(str: string): number | null {
  const s = str.trim();
  if (!s) return null;
  const colonIdx = s.indexOf(":");
  if (colonIdx >= 0) {
    const m = parseInt(s.slice(0, colonIdx), 10);
    const sec = parseFloat(s.slice(colonIdx + 1));
    if (isNaN(m) || isNaN(sec) || sec < 0 || sec >= 60) return null;
    const ms = (m * 60 + sec) * 1000;
    return ms > 0 ? ms : null;
  }
  const sec = parseFloat(s);
  if (isNaN(sec) || sec <= 0) return null;
  return sec * 1000;
}

function formatMinLapTime(ms: number): string {
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) {
    const sInt = Math.floor(s);
    const frac = Math.round((s - sInt) * 10);
    const sStr = frac > 0
      ? `${sInt.toString().padStart(2, "0")}.${frac}`
      : sInt.toString().padStart(2, "0");
    return `${m}:${sStr}`;
  }
  return s === Math.floor(s) ? String(Math.floor(s)) : s.toFixed(1);
}

// ── Main component ──────────────────────────────────────────────────────────

export default function Motos() {
  const [match, params] = useRoute("/events/:eventId/motos");
  const eventId = parseInt(params?.eventId || "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isGenerateOpen, setIsGenerateOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [format, setFormat] = useState<"one_moto" | "two_moto" | "three_moto">("two_moto");
  const [ridersPerHeat, setRidersPerHeat] = useState<string>("");
  const [generateLapCount, setGenerateLapCount] = useState<string>("");
  const [gatePickMethod, setGatePickMethod] = useState<"random" | "practice" | "prior_round_finish" | "first_registered">("random");
  const [selectedRounds, setSelectedRounds] = useState<number[]>([]);
  const [perMotoDialog, setPerMotoDialog] = useState<{ open: boolean; motoId: number | null; motoName: string; motoClass: string }>({ open: false, motoId: null, motoName: "", motoClass: "" });
  const [perMotoGateMethod, setPerMotoGateMethod] = useState<"random" | "practice" | "prior_round_finish" | "first_registered">("random");
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [expandedMotoId, setExpandedMotoId] = useState<number | null>(null);
  const [lapEditTarget, setLapEditTarget] = useState<LapEditTarget | null>(null);
  const [poolSearch, setPoolSearch] = useState("");
  const [poolOpen, setPoolOpen] = useState(true);
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [classFilter, setClassFilter] = useState<string>("schedule");
  const [roundFilter, setRoundFilter] = useState<number | "all">("all");
  const [localOrderIds, setLocalOrderIds] = useState<number[] | null>(null);
  const [lineupSorts, setLineupSorts] = useState<Record<number, LineupSort>>({});
  const getMotoSort = (id: number): LineupSort => lineupSorts[id] ?? "gate";
  const setMotoSort = (id: number, s: LineupSort) => setLineupSorts(p => ({ ...p, [id]: s }));
  const [manualLapCooldown, setManualLapCooldown] = useState<Set<string>>(new Set());
  const [bibInputs, setBibInputs] = useState<Record<number, string>>({});
  const [viewMode, setViewMode] = useState<"grid" | "run-order">("grid");
  const [conflictDialog, setConflictDialog] = useState<{
    open: boolean;
    existingMoto: Moto | null;
    pendingMotoId: number | null;
  }>({ open: false, existingMoto: null, pendingMotoId: null });
  const [restartDialog, setRestartDialog] = useState<{ open: boolean; motoId: number | null; motoName: string }>({ open: false, motoId: null, motoName: "" });
  const [practiceStartDialog, setPracticeStartDialog] = useState<{ open: boolean; moto: Moto | null; timeLimitMinutes: string }>({ open: false, moto: null, timeLimitMinutes: "" });
  const [poolDropMismatch, setPoolDropMismatch] = useState<{
    open: boolean;
    riderId: number | null;
    riderName: string;
    targetMotoId: number | null;
    checkinClass: string | null;
    motoClass: string | null;
  }>({ open: false, riderId: null, riderName: "", targetMotoId: null, checkinClass: null, motoClass: null });

  // Scroll expanded moto card into view when jumping from run-order
  useEffect(() => {
    if (viewMode !== "grid" || expandedMotoId === null) return;
    const el = document.getElementById(`moto-card-${expandedMotoId}`);
    if (!el) return;
    // Small timeout lets React finish rendering before we scroll
    const t = setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    return () => clearTimeout(t);
  }, [expandedMotoId, viewMode]);

  // Drag-and-drop state
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [lineupDrafts, setLineupDrafts] = useState<Record<number, LineupEntry[]>>({});
  const [activeDrag, setActiveDrag] = useState<{ riderName: string; bibNumber?: string | null } | null>(null);
  const [activeMotoCardDrag, setActiveMotoCardDrag] = useState<{ motoId: number; name: string } | null>(null);
  const [activeDragMotoId, setActiveDragMotoId] = useState<number | null>(null);

  // Manual create moto state
  const [newMotoName, setNewMotoName] = useState("");
  const [newMotoType, setNewMotoType] = useState<"heat" | "lcq" | "main" | "practice">("heat");
  const [newMotoClass, setNewMotoClass] = useState("");
  const [newMotoLapCount, setNewMotoLapCount] = useState("");
  const [newMotoScheduledTime, setNewMotoScheduledTime] = useState("");
  const [newMotoTimeLimitMinutes, setNewMotoTimeLimitMinutes] = useState("");
  const [newMotoMaxRiders, setNewMotoMaxRiders] = useState("");
  const [selectedRiderIds, setSelectedRiderIds] = useState<Set<number>>(new Set());

  const { data: event } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const { data: motos, isLoading } = useListMotos(eventId, { query: { enabled: !!eventId } as any });
  const { data: checkins } = useListCheckins(eventId, { query: { enabled: !!eventId } as any });
  const { data: results } = useListResults(eventId, { query: { enabled: !!eventId } as any });

  const generateMutation = useGenerateLineups();
  const perMotoGenerateMutation = useGenerateMotoLineup();
  const createMotoMutation = useCreateMoto();
  const generatePracticeSessionsMutation = useGeneratePracticeSessions();
  const updateMutation = useUpdateMoto();
  const deleteMutation = useDeleteMoto();

  // When the generate dialog opens (or format changes), pre-select the lowest non-done round(s).
  useEffect(() => {
    if (!isGenerateOpen) return;
    const divCount = format === "three_moto" ? 3 : format === "two_moto" ? 2 : 1;
    if (divCount <= 1) { setSelectedRounds([1]); return; }
    const allClasses: string[] = (event?.raceClasses as string[] | undefined) ?? [];
    const nonDoneRounds: number[] = [];
    for (let r = 1; r <= divCount; r++) {
      const isDone = allClasses.length > 0 && allClasses.every(cls =>
        (motos ?? []).some(m =>
          m.raceClass === cls && m.type !== "practice" &&
          m.status === "completed" && roundMap.get(m.id) === r
        )
      );
      if (!isDone) nonDoneRounds.push(r);
    }
    setSelectedRounds(nonDoneRounds.length > 0 ? nonDoneRounds : [1]);
  }, [isGenerateOpen, format]);

  // Deep-link from Schedule tab: if ?motoId=X is in the URL, expand and scroll to that card.
  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const motoIdParam = searchParams.get("motoId");
    if (!motoIdParam) return;
    const id = parseInt(motoIdParam);
    if (isNaN(id)) return;
    setViewMode("grid");
    setExpandedMotoId(id);
  }, []);


  const { data: pointsTables } = useListPointsTables({ query: {} as any });
  const eventScoringTable = (pointsTables ?? []).find(t => t.id === (event as any)?.scoringTableId);
  const isSupercrossFormat = eventScoringTable?.mainEventOnly === true;

  // Build a set of "motoId-riderId" keys for riders who have at least one lap under
  // the minimum lap time for their class — used to highlight names red in the lineup.
  const minLapMs = (event as any)?.minLapMs as number | null | undefined;
  const shortLapSet = useMemo(() => {
    const set = new Set<string>();
    if (!results || !minLapMs) return set;
    for (const r of results) {
      const laps = Array.isArray((r as any).lapTimes) ? (r as any).lapTimes as number[] : [];
      // Skip laps[0] — it's the start-gate crossing (not a full lap).
      if (laps.slice(1).some(t => t > 0 && t < minLapMs)) set.add(`${(r as any).motoId}-${(r as any).riderId}`);
    }
    return set;
  }, [results, minLapMs]);

  // Checked-in riders for the currently selected class in the create dialog
  const classCheckins = (checkins ?? []).filter(c => c.checkedIn && c.raceClass === newMotoClass);
  const allSelected = classCheckins.length > 0 && classCheckins.every(c => selectedRiderIds.has(c.riderId));

  const toggleRider = (riderId: number) => {
    setSelectedRiderIds(prev => {
      const next = new Set(prev);
      if (next.has(riderId)) next.delete(riderId); else next.add(riderId);
      return next;
    });
  };

  // Return the live lineup for a moto, preferring any optimistic draft
  const getLineup = (moto: { id: number; lineup?: unknown }): LineupEntry[] =>
    lineupDrafts[moto.id] ?? (Array.isArray(moto.lineup) ? (moto.lineup as LineupEntry[]) : []);

  const handleQuickAddHeat = (sourceMoto: Moto) => {
    const nextMotoNumber = (motos?.length ? Math.max(...motos.map(m => m.motoNumber ?? 0)) : 0) + 1;
    const typeLabel = sourceMoto.type === "heat" ? (isSupercrossFormat ? "Heat" : "Moto")
      : sourceMoto.type === "main" ? "Main Event"
      : sourceMoto.type === "lcq" ? "LCQ"
      : "Practice";
    const newName = `New ${typeLabel}`;
    createMotoMutation.mutate(
      { eventId, data: { name: newName, type: sourceMoto.type, raceClass: sourceMoto.raceClass!, motoNumber: nextMotoNumber, lineup: [] as any }},
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          toast({ title: `+ ${newName} added — drag it into position` });
        },
        onError: (err) => {
          toast({ title: "Failed to create", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const handleMotoDrop = async (movedMotoId: number, beforeMotoId: number | "end") => {
    const allMotos = [...(motos ?? [])].sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));
    const without = allMotos.filter(m => m.id !== movedMotoId);
    let insertIdx: number;
    if (beforeMotoId === "end") {
      insertIdx = without.length;
    } else {
      insertIdx = without.findIndex(m => m.id === beforeMotoId);
      if (insertIdx === -1) insertIdx = without.length;
    }
    const movedMoto = allMotos.find(m => m.id === movedMotoId);
    if (!movedMoto) return;
    const newOrder = [...without.slice(0, insertIdx), movedMoto, ...without.slice(insertIdx)];

    setLocalOrderIds(newOrder.map(m => m.id));

    // Build motoNumber + name updates per moto
    const updateMap = new Map<number, Record<string, unknown>>();
    newOrder.forEach((m, i) => {
      if ((m.motoNumber ?? 0) !== i + 1) {
        updateMap.set(m.id, { motoNumber: i + 1 });
      }
    });

    // Auto-rename within each class+type group by their new order
    const groups = new Map<string, typeof newOrder>();
    for (const m of newOrder) {
      const key = `${m.raceClass}|${m.type}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    for (const [, group] of groups) {
      const cls = group[0].raceClass ?? "";
      const type = group[0].type;
      const typeLabel = type === "heat" ? (isSupercrossFormat ? "Heat" : "Moto")
        : type === "main" ? "Main Event"
        : type === "lcq" ? "LCQ"
        : "Practice";
      group.forEach((m, i) => {
        const newName = type === "main" && group.length === 1
          ? `${cls} Main Event`
          : `${cls} ${typeLabel} ${i + 1}`;
        const existing = updateMap.get(m.id) ?? {};
        updateMap.set(m.id, { ...existing, name: newName });
      });
    }

    try {
      await Promise.all([...updateMap.entries()].map(([motoId, data]) =>
        updateMutation.mutateAsync({ motoId, data })
      ));
      queryClient.refetchQueries({ queryKey: getListMotosQueryKey(eventId) as any }).then(() => {
        setLocalOrderIds(null);
      });
      toast({ title: "✅ Order updated" });
    } catch {
      setLocalOrderIds(null);
      toast({ title: "Failed to reorder", variant: "destructive" });
    }
  };

  const addPoolRiderToMoto = (riderId: number, targetMotoId: number) => {
    const targetMoto = motos?.find(m => m.id === targetMotoId);
    const checkin = (checkins ?? []).find(c => c.riderId === riderId);
    if (!targetMoto || !checkin || targetMoto.status === "completed") return;
    const lineup = getLineup(targetMoto);
    if (lineup.find(e => e.riderId === riderId)) {
      toast({ title: `${(checkin as any).riderName ?? "Rider"} is already in this moto` });
      return;
    }
    const newEntry: LineupEntry = {
      position: lineup.length + 1,
      riderId,
      riderName: (checkin as any).riderName ?? "",
      bibNumber: (checkin as any).bibNumber || (checkin as any).registrationBib || null,
      rfidNumber: (checkin as any).rfidNumber || null,
    };
    const newLineup = [...lineup, newEntry];
    setLineupDrafts(p => ({ ...p, [targetMotoId]: newLineup }));
    updateMutation.mutate(
      { motoId: targetMotoId, data: { lineup: newLineup as any } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) as any });
          setLineupDrafts(p => { const n = { ...p }; delete n[targetMotoId]; return n; });
          toast({ title: `✅ ${(checkin as any).riderName ?? "Rider"} added to ${targetMoto.name}` });
        },
        onError: () => {
          setLineupDrafts(p => { const n = { ...p }; delete n[targetMotoId]; return n; });
          toast({ title: "Failed to add rider", variant: "destructive" });
        },
      }
    );
  };

  const handleRiderDragStart = (event: DragStartEvent) => {
    const idStr = String(event.active.id);
    if (idStr.startsWith("moto-card-")) {
      const motoId = parseInt(idStr.replace("moto-card-", ""));
      const moto = motos?.find(m => m.id === motoId);
      setActiveMotoCardDrag(moto ? { motoId, name: moto.name } : null);
      return;
    }
    const parts = idStr.split("-");
    if (parts[0] === "pool") {
      const riderId = parseInt(parts[1]);
      const c = (checkins ?? []).find(c => c.riderId === riderId);
      setActiveDrag(c ? { riderName: c.riderName ?? "Rider", bibNumber: c.bibNumber } : null);
      setActiveDragMotoId(null);
      return;
    }
    if (parts[0] !== "rider") return;
    const motoId = parseInt(parts[1]);
    const riderId = parseInt(parts[2]);
    const position = parseInt(parts[3]);
    const moto = motos?.find(m => m.id === motoId);
    if (!moto) return;
    const entry = getLineup(moto).find(e => e.riderId === riderId && e.position === position);
    setActiveDrag(entry ? { riderName: entry.riderName, bibNumber: entry.bibNumber } : null);
    setActiveDragMotoId(motoId);
  };

  const handleRiderDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    const idStr = String(active.id);

    // ── Moto card reorder ────────────────────────────────────────────────────
    if (idStr.startsWith("moto-card-")) {
      setActiveMotoCardDrag(null);
      if (!over) return;
      const overId = String(over.id);
      if (!overId.startsWith("moto-slot-")) return;
      const movedMotoId = parseInt(idStr.replace("moto-card-", ""));
      const slotTarget = overId.replace("moto-slot-", "");
      handleMotoDrop(movedMotoId, slotTarget === "end" ? "end" : parseInt(slotTarget));
      return;
    }

    setActiveDrag(null);
    setActiveDragMotoId(null);
    if (!over) return;
    const parts = idStr.split("-");

    // ── Pool rider → trash: un-check from event ──────────────────────────────
    if (parts[0] === "pool" && String(over.id) === "drop-trash") {
      const riderId = parseInt(parts[1]);
      const c = (checkins ?? []).find(c => c.riderId === riderId);
      fetch(`/api/events/${eventId}/checkins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ riderId, checkedIn: false }),
      }).then(() => {
        queryClient.invalidateQueries({ queryKey: getListCheckinsQueryKey(eventId) as any });
        toast({ title: `🗑 ${c?.riderName ?? "Rider"} removed from check-in` });
      }).catch(() => {
        toast({ title: "Failed to remove rider", variant: "destructive" });
      });
      return;
    }

    // ── Pool rider → moto: add to lineup ─────────────────────────────────────
    if (parts[0] === "pool") {
      const riderId = parseInt(parts[1]);
      const overId = String(over.id);
      if (!overId.startsWith("drop-")) return;
      const targetMotoId = parseInt(overId.replace("drop-", ""));
      if (isNaN(targetMotoId)) return;
      const targetMoto = motos?.find(m => m.id === targetMotoId);
      if (!targetMoto || targetMoto.status === "completed") return;
      const checkin = (checkins ?? []).find(c => c.riderId === riderId);
      if (!checkin) return;
      const checkinClass = (checkin as any).raceClass ?? null;
      const motoClass = targetMoto.raceClass ?? null;
      if (checkinClass && motoClass && checkinClass !== motoClass) {
        setPoolDropMismatch({
          open: true,
          riderId,
          riderName: (checkin as any).riderName ?? "Rider",
          targetMotoId,
          checkinClass,
          motoClass,
        });
      } else {
        addPoolRiderToMoto(riderId, targetMotoId);
      }
      return;
    }

    if (parts[0] !== "rider") return;
    const sourceMotoId = parseInt(parts[1]);
    const riderId = parseInt(parts[2]);
    const dragPosition = parseInt(parts[3]);

    // ── Same-moto gate reorder via slot drop ──────────────────────────────────
    const overId = String(over.id);
    if (overId.startsWith("gate-slot-")) {
      const slotParts = overId.split("-"); // ["gate", "slot", motoId, index]
      const slotMotoId = parseInt(slotParts[2]);
      const slotIndex = parseInt(slotParts[3]);
      if (slotMotoId !== sourceMotoId) return;
      const moto = motos?.find(m => m.id === sourceMotoId);
      if (!moto || moto.status === "completed") return;
      const lineup = getLineup(moto);
      const draggedIdx = lineup.findIndex(e => e.riderId === riderId && e.position === dragPosition);
      const draggedEntry = lineup[draggedIdx];
      if (!draggedEntry) return;
      // Remove only the specific entry by index, not all entries with matching riderId
      const without = [...lineup.slice(0, draggedIdx), ...lineup.slice(draggedIdx + 1)];
      const insertAt = draggedIdx < slotIndex ? slotIndex - 1 : slotIndex;
      // Skip if no-op (dropping right before or after current position)
      if (insertAt === draggedIdx) return;
      const newLineup = [
        ...without.slice(0, insertAt),
        draggedEntry,
        ...without.slice(insertAt),
      ].map((e, i) => ({ ...e, position: i + 1 }));
      setLineupDrafts(p => ({ ...p, [sourceMotoId]: newLineup }));
      updateMutation.mutate(
        { motoId: sourceMotoId, data: { lineup: newLineup as any } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) as any });
            setLineupDrafts(p => { const n = { ...p }; delete n[sourceMotoId]; return n; });
            toast({ title: `✅ Gate pick order updated` });
          },
          onError: () => {
            setLineupDrafts(p => { const n = { ...p }; delete n[sourceMotoId]; return n; });
            toast({ title: "Failed to reorder", variant: "destructive" });
          },
        }
      );
      return;
    }

    // ── Trash drop: remove rider from lineup ──────────────────────────────────
    if (String(over.id) === "drop-trash") {
      const sourceMoto = motos?.find(m => m.id === sourceMotoId);
      if (!sourceMoto || sourceMoto.status === "completed") return;
      const srcLineup = getLineup(sourceMoto);
      const draggedIdx = srcLineup.findIndex(e => e.riderId === riderId && e.position === dragPosition);
      const riderEntry = srcLineup[draggedIdx];
      if (!riderEntry) return;
      const newLineup = [...srcLineup.slice(0, draggedIdx), ...srcLineup.slice(draggedIdx + 1)]
        .map((e, i) => ({ ...e, position: i + 1 }));
      setLineupDrafts(p => ({ ...p, [sourceMotoId]: newLineup }));
      updateMutation.mutate(
        { motoId: sourceMotoId, data: { lineup: newLineup as any } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) as any });
            setLineupDrafts(p => { const n = { ...p }; delete n[sourceMotoId]; return n; });
            toast({ title: `🗑 ${riderEntry.riderName} removed from lineup` });
          },
        }
      );
      return;
    }

    // ── Move between motos ─────────────────────────────────────────────────────
    const targetMotoId = parseInt(String(over.id).replace("drop-", ""));
    if (isNaN(targetMotoId) || sourceMotoId === targetMotoId) return;
    const sourceMoto = motos?.find(m => m.id === sourceMotoId);
    const targetMoto = motos?.find(m => m.id === targetMotoId);
    // Only allow moves within the same race class, between incomplete heat motos
    if (!sourceMoto || !targetMoto) return;
    if (sourceMoto.raceClass !== targetMoto.raceClass) return;
    if (sourceMoto.type !== "heat" || targetMoto.type !== "heat") return;
    if (sourceMoto.status === "completed" || targetMoto.status === "completed") return;
    const srcLineup = getLineup(sourceMoto);
    const draggedIdx = srcLineup.findIndex(e => e.riderId === riderId && e.position === dragPosition);
    const riderEntry = srcLineup[draggedIdx];
    if (!riderEntry) return;
    const newSrc = [...srcLineup.slice(0, draggedIdx), ...srcLineup.slice(draggedIdx + 1)]
      .map((e, i) => ({ ...e, position: i + 1 }));
    const tgtLineup = getLineup(targetMoto);
    const newTgt = [...tgtLineup, { ...riderEntry, position: tgtLineup.length + 1 }];
    // Optimistic update
    setLineupDrafts(p => ({ ...p, [sourceMotoId]: newSrc, [targetMotoId]: newTgt }));
    // Persist both motos, then clear drafts and refresh
    updateMutation.mutate({ motoId: sourceMotoId, data: { lineup: newSrc as any } });
    updateMutation.mutate(
      { motoId: targetMotoId, data: { lineup: newTgt as any } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) as any });
          setLineupDrafts(p => {
            const n = { ...p };
            delete n[sourceMotoId];
            delete n[targetMotoId];
            return n;
          });
          toast({ title: `✅ ${riderEntry.riderName} moved to ${targetMoto.name}` });
        },
      }
    );
  };

  const resetCreateDialog = () => {
    setNewMotoName("");
    setNewMotoType("heat");
    setNewMotoClass("");
    setNewMotoLapCount("");
    setNewMotoScheduledTime("");
    setNewMotoTimeLimitMinutes("");
    setNewMotoMaxRiders("");
    setSelectedRiderIds(new Set());
  };

  const handleCreateMoto = () => {
    if (!newMotoName.trim() || (newMotoType !== "practice" && !newMotoClass)) return;
    const nextMotoNumber = motos?.length ? Math.max(...motos.map(m => m.motoNumber ?? 0)) + 1 : 1;
    const lapCountNum = newMotoLapCount.trim() ? parseInt(newMotoLapCount.trim(), 10) : undefined;
    const timeLimitMs = newMotoTimeLimitMinutes.trim() && parseFloat(newMotoTimeLimitMinutes) > 0
      ? Math.round(parseFloat(newMotoTimeLimitMinutes) * 60 * 1000)
      : undefined;
    const maxRiders = newMotoMaxRiders.trim() ? parseInt(newMotoMaxRiders, 10) : 0;

    // Practice + max riders → auto-generate sessions via generate endpoint
    if (newMotoType === "practice" && maxRiders > 0) {
      generatePracticeSessionsMutation.mutate(
        { eventId, data: { raceClass: newMotoClass || undefined, maxRidersPerSession: maxRiders, ...(timeLimitMs ? { timeLimitMs } : {}), ...(newMotoScheduledTime.trim() ? { scheduledTime: newMotoScheduledTime.trim() } : {}) } as any },
        {
          onSuccess: (sessions) => {
            queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
            setIsCreateOpen(false);
            resetCreateDialog();
            toast({ title: `${sessions.length} practice session${sessions.length !== 1 ? "s" : ""} created` });
          },
          onError: (err) => {
            toast({ title: "Failed to create sessions", description: err.message, variant: "destructive" });
          },
        }
      );
      return;
    }

    const lineup = classCheckins
      .filter(c => selectedRiderIds.has(c.riderId))
      .map((c, i) => ({
        position: i + 1,
        riderId: c.riderId,
        riderName: c.riderName,
        bibNumber: c.bibNumber || c.registrationBib || null,
        rfidNumber: c.rfidNumber || null,
      }));

    createMotoMutation.mutate(
      { eventId, data: { name: newMotoName.trim(), type: newMotoType, raceClass: (newMotoClass || undefined) as string, motoNumber: nextMotoNumber, lineup: lineup as any, lapCount: lapCountNum, ...(timeLimitMs ? { timeLimitMs } : {}), ...(newMotoScheduledTime.trim() ? { scheduledTime: newMotoScheduledTime.trim() } : {}) } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setIsCreateOpen(false);
          resetCreateDialog();
          toast({ title: "Moto created" });
        },
        onError: (err) => {
          toast({ title: "Failed to create moto", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const handleGenerate = () => {
    if (!event?.raceClasses) return;
    const allClasses: string[] = event.raceClasses as string[];
    const lockedClasses = gatePickMethod === "prior_round_finish"
      ? []
      : allClasses.filter(cls =>
          (motos ?? []).some(m => m.raceClass === cls && m.status === "completed")
        );
    const perHeat = ridersPerHeat.trim() ? parseInt(ridersPerHeat, 10) : undefined;
    const lapCountVal = generateLapCount.trim() ? parseInt(generateLapCount, 10) : undefined;
    const divCount = format === "three_moto" ? 3 : format === "two_moto" ? 2 : 1;
    const allRoundsSet = new Set(Array.from({ length: divCount }, (_, i) => i + 1));
    const roundsToSend = selectedRounds.length > 0 && !selectedRounds.every(r => allRoundsSet.has(r) && selectedRounds.length === divCount)
      ? selectedRounds
      : undefined;
    generateMutation.mutate(
      { eventId, data: { raceFormat: format, classes: allClasses, ridersPerHeat: perHeat, lapCount: lapCountVal, gatePickMethod, rounds: roundsToSend } as any },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setIsGenerateOpen(false);
          if (gatePickMethod === "prior_round_finish") {
            toast({ title: "Lineups generated", description: "Gate picks seeded from prior moto finish order." });
          } else if (lockedClasses.length > 0) {
            toast({
              title: "Lineups generated",
              description: `Skipped ${lockedClasses.length} class${lockedClasses.length > 1 ? "es" : ""} with completed motos: ${lockedClasses.join(", ")}`,
            });
          } else {
            toast({ title: "Lineups generated" });
          }
        },
        onError: (err) => {
          toast({ title: "Failed to generate", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const handlePerMotoGenerate = () => {
    if (!perMotoDialog.motoId) return;
    perMotoGenerateMutation.mutate(
      { eventId, motoId: perMotoDialog.motoId, data: { gatePickMethod: perMotoGateMethod } as any },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setPerMotoDialog(p => ({ ...p, open: false }));
          toast({ title: "Lineup regenerated", description: perMotoDialog.motoName });
        },
        onError: (err: any) => {
          toast({ title: "Failed to regenerate", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const handleDelete = (motoId: number) => {
    deleteMutation.mutate({ motoId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
        setConfirmDeleteId(null);
        toast({ title: "Moto deleted" });
      },
      onError: (err) => {
        toast({ title: "Failed to delete", description: err.message, variant: "destructive" });
      },
    });
  };

  // Round map: motoId → 1-indexed position within its class (sorted by motoNumber)
  // Round number comes from the moto name ("Moto N" → N) rather than sequential
  // position within a class, so Div 1 Moto 1 and Div 2 Moto 1 both map to round 1.
  const { roundMap, maxRounds } = useMemo(() => {
    const raceMotos = (motos ?? []).filter(m => m.type !== "practice");
    const map = new Map<number, number>();
    for (const m of raceMotos) {
      const nameMatch = (m.name ?? "").match(/\bMoto\s+(\d+)\b/i);
      const round = nameMatch ? parseInt(nameMatch[1]) : (m.type === "main" ? 2 : 1);
      map.set(m.id, round);
    }
    const max = map.size ? Math.max(...map.values()) : 0;
    return { roundMap: map, maxRounds: max };
  }, [motos]);

  const doStartMoto = async (motoId: number, _motoName?: string) => {
    const motoObj = (motos ?? []).find(m => m.id === motoId);
    const groupMembers: number[] = (motoObj as any)?.staggeredGroupMembers ?? [];
    const partnerIds = groupMembers.filter(id => id !== motoId);

    const timingLabel = (event as any)?.timingTechnology === "mylaps" ? "MyLaps" : "RFID";

    try {
      // Fire all group start requests simultaneously so no moto briefly shows "Waiting".
      await Promise.all([
        updateMoto(motoId, { status: "in_progress" } as any),
        ...partnerIds.map(pid => updateMoto(pid, { status: "in_progress" } as any)),
      ]);
      await queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
      toast({ title: partnerIds.length > 0 ? `🏁 Staggered start — ${groupMembers.length} motos now live` : `🏁 Moto started — ${timingLabel} timing active` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not start moto";
      toast({ title: "Failed to start moto", description: msg, variant: "destructive" });
    }
  };

  const handleStatusUpdate = (motoId: number, status: string) => {
    if (status === "in_progress") {
      const existing = motos?.find(m => m.status === "in_progress" && m.id !== motoId);
      if (existing) {
        setConflictDialog({ open: true, existingMoto: existing, pendingMotoId: motoId });
        return;
      }
    }
    updateMutation.mutate(
      { motoId, data: { status } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          if (status === "in_progress") toast({ title: `🏁 Moto started — ${(event as any)?.timingTechnology === "mylaps" ? "MyLaps" : "RFID"} timing active` });
          if (status === "completed") {
            toast({ title: "Moto finished" });
            if (autoStartEnabled) {
              const sorted = [...(motos ?? [])].sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));
              const finishedIdx = sorted.findIndex(m => m.id === motoId);
              const next = sorted.slice(finishedIdx + 1).find(m => m.status === "scheduled");
              if (next) {
                setTimeout(() => {
                  updateMutation.mutate(
                    { motoId: next.id, data: { status: "in_progress" } },
                    {
                      onSuccess: () => {
                        queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
                        toast({ title: `⚡ Auto-started: ${next.name}` });
                      },
                    }
                  );
                }, 800);
              }
            }
          }
        },
      }
    );
  };

  // Finish a moto — finish all motos in the stagger group simultaneously.
  const doFinishMoto = async (motoId: number) => {
    const motoObj = (motos ?? []).find(m => m.id === motoId);
    const groupMembers: number[] = (motoObj as any)?.staggeredGroupMembers ?? [];
    const partnerIds = groupMembers.filter(id => id !== motoId);
    try {
      await Promise.all([
        updateMoto(motoId, { status: "completed" } as any),
        ...partnerIds.map(pid => updateMoto(pid, { status: "completed" } as any)),
      ]);
      await queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
      toast({ title: partnerIds.length > 0 ? `🏁 Group finished — ${groupMembers.length} motos completed` : "Moto finished" });
      if (autoStartEnabled) {
        const sorted = [...(motos ?? [])].sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));
        const finishedIdx = sorted.findIndex(m => m.id === motoId);
        const next = sorted.slice(finishedIdx + 1).find(m => m.status === "scheduled");
        if (next) {
          setTimeout(() => doStartMoto(next.id), 800);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not finish moto";
      toast({ title: "Failed to finish moto", description: msg, variant: "destructive" });
    }
  };

  const handleStartMoto = (moto: Moto) => {
    const groupMembers: number[] = (moto as any)?.staggeredGroupMembers ?? [];
    const existing = motos?.find(m => m.status === "in_progress" && !groupMembers.includes(m.id) && m.id !== moto.id);
    if (existing) {
      setConflictDialog({ open: true, existingMoto: existing, pendingMotoId: moto.id });
      return;
    }
    if (moto.type === "practice") {
      const existingMinutes = (moto as any).timeLimitMs
        ? String(Math.round((moto as any).timeLimitMs / 60000))
        : "";
      setPracticeStartDialog({ open: true, moto, timeLimitMinutes: existingMinutes });
      return;
    }
    doStartMoto(moto.id);
  };

  const doStartPractice = () => {
    const { moto, timeLimitMinutes } = practiceStartDialog;
    if (!moto) return;
    const timeLimitMs = timeLimitMinutes.trim() && parseFloat(timeLimitMinutes) > 0
      ? Math.round(parseFloat(timeLimitMinutes) * 60 * 1000)
      : null;
    setPracticeStartDialog({ open: false, moto: null, timeLimitMinutes: "" });
    updateMutation.mutate(
      { motoId: moto.id, data: { status: "in_progress", ...(timeLimitMs ? { timeLimitMs } : {}) } as any },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          toast({ title: `🏁 Practice started${timeLimitMs ? ` — ${Math.round(timeLimitMs / 60000)} min timer` : ""}` });
        },
      }
    );
  };

  const handlePoolDropMismatchConfirm = () => {
    const { riderId, targetMotoId } = poolDropMismatch;
    setPoolDropMismatch(p => ({ ...p, open: false }));
    if (riderId === null || targetMotoId === null) return;
    addPoolRiderToMoto(riderId, targetMotoId);
  };

  const handleRestartConfirm = async () => {
    const { motoId, motoName } = restartDialog;
    if (motoId === null) return;
    setRestartDialog({ open: false, motoId: null, motoName: "" });

    // Find all group members and restart them simultaneously
    const motoObj = (motos ?? []).find(m => m.id === motoId);
    const groupMembers: number[] = (motoObj as any)?.staggeredGroupMembers ?? [];
    const partnerIds = groupMembers.filter(id => id !== motoId);

    try {
      await Promise.all([
        fetch(`/api/motos/${motoId}/restart`, { method: "POST" }).then(r => { if (!r.ok) throw new Error("Failed"); }),
        ...partnerIds.map(pid => fetch(`/api/motos/${pid}/restart`, { method: "POST" }).then(r => { if (!r.ok) throw new Error("Failed"); })),
      ]);
      await queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
      toast({ title: partnerIds.length > 0 ? `🔄 Group restarted — ${groupMembers.length} motos` : `🔄 Moto restarted: ${motoName}` });
    } catch {
      toast({ title: "Failed to restart moto", variant: "destructive" });
    }
  };

  const handleConflictStartWave = () => {
    const { pendingMotoId } = conflictDialog;
    if (pendingMotoId === null) return;
    setConflictDialog({ open: false, existingMoto: null, pendingMotoId: null });
    doStartMoto(pendingMotoId);
  };

  const handleConflictConfirm = () => {
    const { existingMoto, pendingMotoId } = conflictDialog;
    if (!existingMoto || pendingMotoId === null) return;
    setConflictDialog({ open: false, existingMoto: null, pendingMotoId: null });
    updateMutation.mutate(
      { motoId: existingMoto.id, data: { status: "completed" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          toast({ title: `Moto ended: ${existingMoto.name}` });
          doStartMoto(pendingMotoId);
        },
        onError: () => {
          toast({ title: "Failed to end current moto", variant: "destructive" });
        },
      }
    );
  };

  const copyLiveLink = (motoId: number) => {
    const url = `${getPublicOrigin()}/live/${motoId}`;
    navigator.clipboard.writeText(url);
    setCopiedId(motoId);
    setTimeout(() => setCopiedId(null), 2000);
    toast({ title: "Live timing link copied" });
  };

  const handleManualLap = async (riderId: number, motoId: number) => {
    const key = `${motoId}-${riderId}`;
    // Play the ping immediately on click — no waiting for the network round-trip.
    // Set the guard so the SSE handler doesn't double-ping within 1.5s.
    _lastManualPingAt = Date.now();
    void playRfidPing(1);
    setManualLapCooldown(prev => new Set(prev).add(key));
    try {
      const res = await fetch("/api/timing/manual-crossing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ riderId, motoId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: "Failed to record lap", description: data.error ?? "Unknown error", variant: "destructive" });
      } else {
        toast({
          title: `⏱ Lap ${data.lapNumber} recorded`,
          description: data.lapTime ? `Lap time: ${data.lapTime}` : "Timestamp captured",
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not reach server";
      toast({ title: "Failed to record lap", description: msg, variant: "destructive" });
    } finally {
      setTimeout(() => {
        setManualLapCooldown(prev => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }, 4000);
    }
  };

  const handleBibEntry = (motoId: number, lineup: LineupEntry[]) => {
    const raw = (bibInputs[motoId] ?? "").trim().replace(/^#/, "");
    if (!raw) return;
    const entry = lineup.find(e => e.bibNumber && e.bibNumber.replace(/^#/, "") === raw);
    if (!entry) {
      toast({ title: `#${raw} not found in this lineup`, variant: "destructive" });
      return;
    }
    setBibInputs(prev => ({ ...prev, [motoId]: "" }));
    handleManualLap(entry.riderId, motoId);
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-heading font-bold uppercase tracking-tight">Moto Management</h2>
          <p className="text-muted-foreground">Manage heats, mains, and {(event as any)?.timingTechnology === "mylaps" ? "MyLaps" : "RFID"} timing.</p>
        </div>

        <div className="flex items-center gap-2">
          {/* Auto Start Next Moto toggle */}
          <button
            onClick={() => setAutoStartEnabled(v => !v)}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-heading font-bold uppercase tracking-wider transition-all select-none ${
              autoStartEnabled
                ? "bg-green-600 border-green-600 text-white shadow-sm shadow-green-500/30"
                : "bg-background border-border text-muted-foreground hover:border-green-500/50 hover:text-green-600"
            }`}
            title="When on, finishing a moto automatically starts the next scheduled moto"
          >
            <span className={`relative flex h-2 w-2 shrink-0 ${autoStartEnabled ? "" : "opacity-40"}`}>
              {autoStartEnabled && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${autoStartEnabled ? "bg-white" : "bg-muted-foreground"}`} />
            </span>
            Auto Start Next
          </button>

          <Button
            variant={showBroadcast ? "default" : "outline"}
            className={`font-heading uppercase tracking-wider gap-2 ${showBroadcast ? "bg-red-600 hover:bg-red-700 text-white border-red-600" : ""}`}
            onClick={() => setShowBroadcast(v => !v)}
          >
            <Video size={16} /> {showBroadcast ? "Hide Video Feed" : "Live Video Feed"}
          </Button>

          {/* Manual create moto */}
          <Dialog open={isCreateOpen} onOpenChange={open => { setIsCreateOpen(open); if (!open) resetCreateDialog(); }}>
            <DialogTrigger asChild>
              <Button variant="outline" className="font-heading uppercase tracking-wider">
                <PlusCircle size={16} className="mr-2" /> Create Moto
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle className="font-heading uppercase text-xl">Create Moto Manually</DialogTitle>
              </DialogHeader>
              <div className="space-y-5 py-2">

                {/* Name */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Moto Name</label>
                  <Input
                    value={newMotoName}
                    onChange={e => setNewMotoName(e.target.value)}
                    placeholder="e.g. 250 Pro LCQ, Open Moto 1..."
                    className="h-9"
                  />
                </div>

                {/* Type + Class row */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Type</label>
                    <Select value={newMotoType} onValueChange={(v: any) => { setNewMotoType(v); if (v === "practice") { setNewMotoClass(""); setSelectedRiderIds(new Set()); } }}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="heat">Heat</SelectItem>
                        <SelectItem value="lcq">LCQ</SelectItem>
                        <SelectItem value="main">Main</SelectItem>
                        <SelectItem value="practice">Practice</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">
                      Race Class
                      {newMotoType === "practice" && <span className="ml-1 text-muted-foreground font-normal text-xs">(optional)</span>}
                    </label>
                    <Select
                      value={newMotoClass}
                      onValueChange={v => { setNewMotoClass(v === "__all__" ? "" : v); setSelectedRiderIds(new Set()); }}
                    >
                      <SelectTrigger className="h-9"><SelectValue placeholder={newMotoType === "practice" ? "All Classes / Open" : "Select class"} /></SelectTrigger>
                      <SelectContent>
                        {newMotoType === "practice" && (
                          <SelectItem value="__all__">All Classes / Open</SelectItem>
                        )}
                        {(event?.raceClasses ?? []).map(cls => (
                          <SelectItem key={cls} value={cls}>{cls}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Practice-specific settings */}
                {newMotoType === "practice" ? (
                  <div className="space-y-3 rounded-lg border border-sky-400/30 bg-sky-500/5 p-3">
                    <p className="text-xs font-bold uppercase tracking-wider text-sky-600 flex items-center gap-1.5">
                      <Timer size={12} /> Practice Settings
                    </p>

                    {/* Time limit */}
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium flex items-center gap-1.5">
                        Time Limit
                        <span className="text-muted-foreground font-normal text-xs">(optional — minutes)</span>
                      </label>
                      <div className="relative w-36">
                        <Timer size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                        <Input
                          type="number"
                          min={1}
                          placeholder="e.g. 15"
                          value={newMotoTimeLimitMinutes}
                          onChange={e => setNewMotoTimeLimitMinutes(e.target.value)}
                          className="h-9 pl-8"
                        />
                      </div>
                    </div>

                    {/* Max riders */}
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium flex items-center gap-1.5">
                        Max Riders Per Session
                        <span className="text-muted-foreground font-normal text-xs">(optional — auto-assigns riders)</span>
                      </label>
                      <Input
                        type="number"
                        min={1}
                        placeholder="e.g. 20"
                        value={newMotoMaxRiders}
                        onChange={e => setNewMotoMaxRiders(e.target.value)}
                        className="h-9 w-36"
                      />
                      {newMotoMaxRiders.trim() && parseInt(newMotoMaxRiders) > 0 && (() => {
                        const classRiders = newMotoClass
                          ? (checkins ?? []).filter(c => c.checkedIn && c.raceClass === newMotoClass).length
                          : (checkins ?? []).filter(c => c.checkedIn).length;
                        const sessions = Math.ceil(classRiders / parseInt(newMotoMaxRiders));
                        return (
                          <p className="text-xs text-primary">
                            {classRiders} riders → {sessions} session{sessions !== 1 ? "s" : ""}
                          </p>
                        );
                      })()}
                    </div>
                  </div>
                ) : (
                  /* Lap count — non-practice only */
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Number of Laps <span className="text-muted-foreground font-normal text-xs">(optional — enables finish countdown)</span></label>
                    <Input
                      type="number"
                      min={1}
                      placeholder="e.g. 5"
                      value={newMotoLapCount}
                      onChange={e => setNewMotoLapCount(e.target.value)}
                      className="h-9 w-28"
                    />
                  </div>
                )}

                {/* Scheduled start time — shown for all types */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium flex items-center gap-1.5">
                    <Clock size={13} className="text-muted-foreground" />
                    Start Time
                    <span className="text-muted-foreground font-normal text-xs">(optional)</span>
                  </label>
                  <div className="relative">
                    <input
                      type="time"
                      value={newMotoScheduledTime}
                      onChange={e => setNewMotoScheduledTime(e.target.value)}
                      className="h-9 w-36 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-0"
                    />
                  </div>
                </div>

                {/* Rider picker */}
                <div className="space-y-2">
                  {newMotoType === "practice" ? (
                    <div className="border rounded-md bg-muted/30 py-3 px-4 text-sm text-muted-foreground text-center">
                      {newMotoMaxRiders.trim() && parseInt(newMotoMaxRiders) > 0
                        ? "Riders will be auto-assigned from the checked-in list when sessions are created."
                        : "Practice is open to all checked-in riders — no gate picks needed."}
                    </div>
                  ) : (
                  <>
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium flex items-center gap-1.5">
                      <Users size={14} /> Riders
                      {selectedRiderIds.size > 0 && (
                        <Badge variant="secondary" className="ml-1 font-mono">{selectedRiderIds.size} selected</Badge>
                      )}
                    </label>
                    {newMotoClass && classCheckins.length > 0 && (
                      <div className="flex gap-2">
                        <button
                          className="text-xs text-primary hover:underline font-medium"
                          onClick={() => setSelectedRiderIds(new Set(classCheckins.map(c => c.riderId)))}
                        >
                          Select all
                        </button>
                        <span className="text-muted-foreground text-xs">·</span>
                        <button
                          className="text-xs text-muted-foreground hover:underline"
                          onClick={() => setSelectedRiderIds(new Set())}
                        >
                          Clear
                        </button>
                      </div>
                    )}
                  </div>

                  {!newMotoClass ? (
                    <div className="border rounded-md bg-muted/30 py-8 text-center text-sm text-muted-foreground">
                      Select a race class to see riders
                    </div>
                  ) : classCheckins.length === 0 ? (
                    <div className="border rounded-md bg-muted/30 py-8 text-center text-sm text-muted-foreground">
                      No checked-in riders for {newMotoClass}
                    </div>
                  ) : (
                    <ScrollArea className="border rounded-md h-52">
                      <div className="p-1">
                        {classCheckins.map(c => (
                          <label
                            key={c.riderId}
                            className="flex items-center gap-3 px-3 py-2 rounded hover:bg-muted/60 cursor-pointer select-none"
                          >
                            <Checkbox
                              checked={selectedRiderIds.has(c.riderId)}
                              onCheckedChange={() => toggleRider(c.riderId)}
                              id={`rider-${c.riderId}`}
                            />
                            <div className="flex-1 min-w-0">
                              <span className="font-medium text-sm">{c.riderName}</span>
                            </div>
                            {(c.bibNumber || c.registrationBib) && (
                              <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded border text-muted-foreground shrink-0">
                                #{c.bibNumber || c.registrationBib}
                              </span>
                            )}
                            {c.rfidNumber && (
                              <span className="text-green-600 text-xs flex items-center gap-0.5 shrink-0">
                                <Radio size={10} /> RFID
                              </span>
                            )}
                          </label>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                  </>
                  )}
                </div>
              </div>

              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => { setIsCreateOpen(false); resetCreateDialog(); }}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreateMoto}
                  disabled={createMotoMutation.isPending || !newMotoName.trim() || (newMotoType !== "practice" && !newMotoClass)}
                  className="font-heading uppercase tracking-wider"
                >
                  {createMotoMutation.isPending ? "Creating..." : "Create Moto"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Generate Lineups moved to Schedule page */}
          <Dialog open={isGenerateOpen} onOpenChange={(open) => {
            setIsGenerateOpen(open);
            if (!open) {
              setGatePickMethod("random");
              setSelectedRounds([]);
            }
          }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-heading uppercase text-xl">Generate Lineups</DialogTitle>
            </DialogHeader>
            <div className="space-y-6 py-4">
              {(() => {
                const allClasses: string[] = (event?.raceClasses as string[] | undefined) ?? [];
                const lockedClasses = allClasses.filter(cls =>
                  (motos ?? []).some(m => m.raceClass === cls && m.status === "completed")
                );
                const regenerableClasses = allClasses.filter(cls => !lockedClasses.includes(cls));
                if (lockedClasses.length === 0) return null;
                return (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-3 py-2.5 space-y-1.5">
                    <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                      <span>⚠️</span> Some classes have completed motos
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      Completed motos and their results are never overwritten. Only classes without completed motos will be regenerated.
                    </p>
                    <div className="space-y-1 pt-0.5">
                      <p className="text-[11px] font-medium text-amber-800 dark:text-amber-300 uppercase tracking-wider">Skipped (has completed motos):</p>
                      <div className="flex flex-wrap gap-1">
                        {lockedClasses.map(cls => (
                          <span key={cls} className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-700">
                            {cls}
                          </span>
                        ))}
                      </div>
                      {regenerableClasses.length > 0 && (
                        <>
                          <p className="text-[11px] font-medium text-green-700 dark:text-green-400 uppercase tracking-wider pt-1">Will regenerate:</p>
                          <div className="flex flex-wrap gap-1">
                            {regenerableClasses.map(cls => (
                              <span key={cls} className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-700">
                                {cls}
                              </span>
                            ))}
                          </div>
                        </>
                      )}
                      {regenerableClasses.length === 0 && (
                        <p className="text-xs text-amber-700 dark:text-amber-400 pt-1 font-medium">All classes are locked — nothing to regenerate.</p>
                      )}
                    </div>
                  </div>
                );
              })()}
              {isSupercrossFormat ? (
                <p className="text-sm text-muted-foreground">
                  <span className="font-semibold text-foreground">Supercross format:</span> Heat motos and an empty Main Event will be created per class. Use <span className="font-semibold">Advance to Main</span> after heats to populate the Main Event lineup.
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Generates motos based on checked-in riders for all classes.
                  </p>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Motos per Class</label>
                    <Select value={format} onValueChange={(v: any) => setFormat(v)}>
                      <SelectTrigger><SelectValue placeholder="Select Format" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="one_moto">1 Moto</SelectItem>
                        <SelectItem value="two_moto">2 Motos</SelectItem>
                        <SelectItem value="three_moto">3 Motos</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {/* Round selection — only shown for multi-round formats */}
                  {(() => {
                    const divCount = format === "three_moto" ? 3 : format === "two_moto" ? 2 : 1;
                    if (divCount <= 1) return null;
                    const allClasses: string[] = (event?.raceClasses as string[] | undefined) ?? [];
                    const isRoundDone = (r: number) => allClasses.length > 0 && allClasses.every(cls =>
                      (motos ?? []).some(m =>
                        m.raceClass === cls && m.type !== "practice" &&
                        m.status === "completed" && roundMap.get(m.id) === r
                      )
                    );
                    return (
                      <div className="space-y-2">
                        <label className="text-sm font-medium">Generate Moto(s)</label>
                        <div className="flex gap-2 flex-wrap">
                          {Array.from({ length: divCount }, (_, i) => i + 1).map(r => {
                            const done = isRoundDone(r);
                            const checked = selectedRounds.includes(r);
                            return (
                              <button key={r} type="button"
                                onClick={() => setSelectedRounds(prev =>
                                  checked ? prev.filter(x => x !== r) : [...prev, r].sort((a, b) => a - b)
                                )}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
                                  checked
                                    ? "bg-primary/10 border-primary text-primary"
                                    : "bg-muted/30 border-border text-muted-foreground hover:bg-muted/50"
                                }`}
                              >
                                <div className={`h-4 w-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                                  checked ? "border-primary bg-primary" : "border-muted-foreground/40"
                                }`}>
                                  {checked && <Check size={10} className="text-white" />}
                                </div>
                                Round {r}
                                {done && <span className="text-[10px] font-normal text-muted-foreground ml-1">done</span>}
                              </button>
                            );
                          })}
                        </div>
                        <p className="text-xs text-muted-foreground">Select which moto(s) to generate. Uncheck to leave existing motos for that moto untouched.</p>
                      </div>
                    );
                  })()}
                </>
              )}
              {/* Div Size */}
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Max Riders per Moto <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <Input
                  type="number"
                  min={1}
                  value={ridersPerHeat}
                  onChange={e => setRidersPerHeat(e.target.value)}
                  placeholder="No limit (all in one div)"
                  className="h-9"
                />
                <p className="text-xs text-muted-foreground">
                  If a class exceeds this number, riders are split into separate motos. Leave blank for no limit.
                </p>
              </div>

              {/* Lap count */}
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Laps per Race <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <Input
                  type="number"
                  min={1}
                  value={generateLapCount}
                  onChange={e => setGenerateLapCount(e.target.value)}
                  placeholder="e.g. 6"
                  className="h-9"
                />
                <p className="text-xs text-muted-foreground">
                  For laps-based races. Sets the target lap count on every moto — shown on the race card.
                </p>
              </div>
              {/* Gate Pick Method */}
              {(() => {
                const hasCompletedRaceMotos = (motos ?? []).some(m => m.status === "completed" && m.type !== "practice");
                const methods: { value: "random" | "practice" | "prior_round_finish" | "first_registered"; label: string; description: string; disabled?: boolean; disabledReason?: string }[] = [
                  {
                    value: "random",
                    label: "Random Draw",
                    description: "Riders are shuffled randomly into gate positions.",
                  },
                  {
                    value: "first_registered",
                    label: "First Registered",
                    description: "Riders are ordered by registration date — earliest registration gets first gate pick.",
                  },
                  {
                    value: "practice",
                    label: "Practice Fastest Lap",
                    description: "Riders are seeded by best practice lap time — fastest gets first gate pick.",
                    disabledReason: "No practice lap data recorded for this club yet.",
                  },
                  {
                    value: "prior_round_finish",
                    label: "Prior Moto Finish",
                    description: "Riders are seeded by their finish position in the most recently completed moto. Ties broken by fastest lap.",
                    disabled: !hasCompletedRaceMotos,
                    disabledReason: "No completed race motos yet — run Moto 1 first.",
                  },
                ];
                return (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Gate Pick Method</label>
                    <TooltipProvider>
                      <div className="rounded-lg border divide-y overflow-hidden">
                        {methods.map((m) => {
                          const isSelected = gatePickMethod === m.value;
                          const btn = (
                            <button
                              key={m.value}
                              type="button"
                              disabled={m.disabled}
                              onClick={() => { if (!m.disabled) setGatePickMethod(m.value); }}
                              className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors ${
                                m.disabled
                                  ? "opacity-50 cursor-not-allowed bg-muted/20"
                                  : isSelected
                                  ? "bg-primary/5"
                                  : "hover:bg-muted/30"
                              }`}
                            >
                              <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                                isSelected ? "border-primary bg-primary" : "border-muted-foreground/40"
                              }`}>
                                {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                              </span>
                              <span className="flex flex-col gap-0.5 min-w-0">
                                <span className={`text-sm font-medium leading-tight ${m.disabled ? "text-muted-foreground" : ""}`}>
                                  {m.label}
                                  {m.disabled && (
                                    <span className="ml-2 text-[10px] font-normal text-muted-foreground uppercase tracking-wide">Unavailable</span>
                                  )}
                                </span>
                                <span className="text-xs text-muted-foreground leading-snug">{m.description}</span>
                              </span>
                            </button>
                          );
                          if (m.disabled && m.disabledReason) {
                            return (
                              <Tooltip key={m.value}>
                                <TooltipTrigger asChild>{btn}</TooltipTrigger>
                                <TooltipContent side="top">{m.disabledReason}</TooltipContent>
                              </Tooltip>
                            );
                          }
                          return btn;
                        })}
                      </div>
                    </TooltipProvider>
                  </div>
                );
              })()}
              <Button
                onClick={handleGenerate}
                disabled={generateMutation.isPending || (() => {
                  if (gatePickMethod === "prior_round_finish") return false;
                  const allClasses: string[] = (event?.raceClasses as string[] | undefined) ?? [];
                  return allClasses.length > 0 && allClasses.every(cls =>
                    (motos ?? []).some(m => m.raceClass === cls && m.status === "completed")
                  );
                })()}
                className="w-full font-heading uppercase"
              >
                {generateMutation.isPending ? "Generating..." : "Generate Lineups"}
              </Button>
            </div>
          </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Per-moto regenerate lineup dialog */}
      <Dialog open={perMotoDialog.open} onOpenChange={(open) => {
        if (!open) setPerMotoDialog(p => ({ ...p, open: false }));
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-heading uppercase text-xl">Regenerate Lineup</DialogTitle>
            <DialogDescription>
              Replace the current lineup for <span className="font-semibold text-foreground">{perMotoDialog.motoName}</span> with a fresh one from checked-in riders.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-2">
            {/* Gate pick method */}
            {(() => {
              const hasCompletedRaceMotos = (motos ?? []).some(m => m.status === "completed" && m.type !== "practice");
              const methods: { value: "random" | "practice" | "prior_round_finish" | "first_registered"; label: string; description: string; disabled?: boolean; disabledReason?: string }[] = [
                {
                  value: "random",
                  label: "Random Draw",
                  description: "Riders are shuffled randomly into gate positions.",
                },
                {
                  value: "first_registered",
                  label: "First Registered",
                  description: "Riders are ordered by registration date — earliest registration gets first gate pick.",
                },
                {
                  value: "practice",
                  label: "Practice Fastest Lap",
                  description: "Riders are seeded by best practice lap time — fastest gets first gate pick.",
                  disabledReason: "No practice lap data recorded for this club yet.",
                },
                {
                  value: "prior_round_finish",
                  label: "Prior Moto Finish",
                  description: "Riders are seeded by their finish position in the most recently completed moto.",
                  disabled: !hasCompletedRaceMotos,
                  disabledReason: "No completed race motos yet — run Moto 1 first.",
                },
              ];
              return (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Gate Pick Method</label>
                  <TooltipProvider>
                    <div className="rounded-lg border divide-y overflow-hidden">
                      {methods.map((m) => {
                        const isSelected = perMotoGateMethod === m.value;
                        const btn = (
                          <button key={m.value} type="button" disabled={m.disabled}
                            onClick={() => { if (!m.disabled) setPerMotoGateMethod(m.value); }}
                            className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors ${
                              m.disabled ? "opacity-50 cursor-not-allowed bg-muted/20"
                              : isSelected ? "bg-primary/5"
                              : "hover:bg-muted/30"
                            }`}
                          >
                            <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                              isSelected ? "border-primary bg-primary" : "border-muted-foreground/40"
                            }`}>
                              {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                            </span>
                            <span className="flex flex-col gap-0.5 min-w-0">
                              <span className={`text-sm font-medium leading-tight ${m.disabled ? "text-muted-foreground" : ""}`}>
                                {m.label}
                                {m.disabled && <span className="ml-2 text-[10px] font-normal text-muted-foreground uppercase tracking-wide">Unavailable</span>}
                              </span>
                              <span className="text-xs text-muted-foreground leading-snug">{m.description}</span>
                            </span>
                          </button>
                        );
                        if (m.disabled && m.disabledReason) {
                          return (
                            <Tooltip key={m.value}>
                              <TooltipTrigger asChild>{btn}</TooltipTrigger>
                              <TooltipContent side="top">{m.disabledReason}</TooltipContent>
                            </Tooltip>
                          );
                        }
                        return btn;
                      })}
                    </div>
                  </TooltipProvider>
                </div>
              );
            })()}
            <Button
              onClick={handlePerMotoGenerate}
              disabled={perMotoGenerateMutation.isPending}
              className="w-full font-heading uppercase"
            >
              {perMotoGenerateMutation.isPending ? "Regenerating..." : "Regenerate Lineup"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Live Video Feed panel */}
      {showBroadcast && (
        <div className="border rounded-xl p-5 bg-card space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <Video size={16} className="text-red-500" />
            <h3 className="font-heading font-bold uppercase tracking-wider text-sm">Live Video Broadcast</h3>
          </div>
          <LiveBroadcast eventId={eventId} />
        </div>
      )}

      {/* Timing info banner — content varies by technology */}
      {(event as any)?.timingTechnology === "mylaps" ? (
        <div className="bg-blue-500/5 border border-blue-500/20 rounded-md px-4 py-3 flex items-start gap-3">
          <Zap size={18} className="text-blue-500 mt-0.5 shrink-0" />
          <div className="text-sm">
            <span className="font-bold text-blue-600">MyLaps Timing:</span>{" "}
            <span className="text-muted-foreground">
              Start a moto to begin receiving transponder data. MyLaps sends lap crossings to{" "}
              <code className="bg-muted px-1 rounded text-xs font-mono">POST /api/timing/crossing</code> with{" "}
              <code className="bg-muted px-1 rounded text-xs font-mono">{`{ rfidNumber, motoId }`}</code>.
              The leaderboard updates in real time via SSE.
            </span>
          </div>
        </div>
      ) : (
        <div className="bg-primary/5 border border-primary/20 rounded-md px-4 py-3 flex items-start gap-3">
          <Radio size={18} className="text-primary mt-0.5 shrink-0" />
          <div className="text-sm">
            <span className="font-bold text-primary">RFID Timing:</span>{" "}
            <span className="text-muted-foreground">
              Start a moto to activate live timing. Readers send tag crossings to{" "}
              <code className="bg-muted px-1 rounded text-xs font-mono">POST /api/timing/crossing</code> with{" "}
              <code className="bg-muted px-1 rounded text-xs font-mono">{`{ rfidNumber, motoId }`}</code>.
              The leaderboard updates in real time via SSE.
            </span>
          </div>
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={handleRiderDragStart} onDragEnd={handleRiderDragEnd}>
      <div className="flex gap-5 items-start">

        {/* ── Left: Rider Pool ─────────────────────────────────────────── */}
        <div className={`shrink-0 sticky top-4 transition-[width] duration-200 ${poolOpen ? "w-56 space-y-3" : "w-8"}`}>

          {/* Header — always visible */}
          <div className="flex items-center gap-1.5">
            {poolOpen && (
              <h3 className="font-heading font-bold uppercase tracking-wider text-sm flex items-center gap-1.5 flex-1 min-w-0">
                <Users size={13} /> Rider Pool
              </h3>
            )}
            <button
              onClick={() => setPoolOpen(v => !v)}
              className="flex items-center justify-center w-7 h-7 rounded border bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0 ml-auto"
              title={poolOpen ? "Collapse rider pool" : "Expand rider pool"}
            >
              {poolOpen ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
            </button>
          </div>

          {poolOpen ? (
            <>
              <p className="text-xs text-muted-foreground -mt-1">Drag riders onto motos · drag to trash to remove</p>
              {/* Search */}
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <Input
                  value={poolSearch}
                  onChange={e => setPoolSearch(e.target.value)}
                  placeholder="Name or bib…"
                  className="h-8 pl-7 text-xs"
                />
              </div>
              {(() => {
                const q = poolSearch.trim().toLowerCase();
                const byClass: Record<string, Array<{ riderId: number; riderName: string | null; bibNumber: string | null; raceClass: string | null }>> = {};
                for (const c of (checkins ?? [])) {
                  if (!c.checkedIn) continue;
                  if (q) {
                    const name = (c.riderName ?? "").toLowerCase();
                    const bib  = (c.bibNumber ?? "").toLowerCase();
                    if (!name.includes(q) && !bib.includes(q)) continue;
                  }
                  const cls = c.raceClass ?? "Unknown";
                  if (!byClass[cls]) byClass[cls] = [];
                  byClass[cls].push(c as any);
                }
                const classes = Object.entries(byClass).sort(([a], [b]) => a.localeCompare(b));
                if (!classes.length) return (
                  <Card><CardContent className="p-4 text-center text-xs text-muted-foreground">
                    {q ? "No riders match your search" : "No checked-in riders"}
                  </CardContent></Card>
                );
                return classes.map(([cls, riders]) => {
                  const sorted = [...riders].sort((a, b) =>
                    (a.riderName ?? "").localeCompare(b.riderName ?? "")
                  );
                  return (
                    <Card key={cls} className="overflow-hidden border-sidebar-border">
                      <div className="flex items-center justify-between px-3 py-2 bg-sidebar text-sidebar-foreground border-b">
                        <span className="font-heading font-bold text-xs uppercase tracking-wider truncate mr-2">{cls}</span>
                        <Badge variant="secondary" className="text-xs h-5 shrink-0 bg-sidebar-accent text-sidebar-foreground border-transparent">{sorted.length}</Badge>
                      </div>
                      <div className="divide-y max-h-80 overflow-y-auto">
                        {sorted.map(r => (
                          <DraggablePoolRider key={r.riderId} riderId={r.riderId} riderName={r.riderName ?? "Rider"} bibNumber={r.bibNumber} />
                        ))}
                      </div>
                    </Card>
                  );
                });
              })()}
            </>
          ) : (
            /* Collapsed: icon + total count */
            <div className="flex flex-col items-center gap-2 mt-2">
              <Users size={14} className="text-muted-foreground" />
              {(checkins ?? []).filter(c => c.checkedIn).length > 0 && (
                <Badge variant="secondary" className="text-[10px] h-5 px-1 font-mono tabular-nums">
                  {(checkins ?? []).filter(c => c.checkedIn).length}
                </Badge>
              )}
            </div>
          )}
        </div>

        {/* ── Right: motos grid / loading / empty state ─────────────── */}
        <div className="flex-1 min-w-0">

        {/* Class filter bar + view toggle */}
        {!isLoading && !!motos?.filter(m => m.type !== "practice").length && (() => {
          const uniqueClasses = [...new Set(
            (motos ?? []).filter(m => m.type !== "practice").map(m => m.raceClass).filter((c): c is string => !!c)
          )].sort();
          const pillCls = (active: boolean) =>
            `px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider border transition-colors ${
              active ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-border hover:bg-muted/80"
            }`;
          return (
            <div className="space-y-2 mb-4">
              {/* ── Round tabs — only when motos are grouped into multiple rounds ── */}
              {maxRounds > 1 && viewMode === "grid" && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground shrink-0 pr-1">Round</span>
                  <button onClick={() => setRoundFilter("all")} className={pillCls(roundFilter === "all")}>All</button>
                  {Array.from({ length: maxRounds }, (_, i) => i + 1).map(r => (
                    <button key={r} onClick={() => { setRoundFilter(r); setClassFilter("schedule"); }} className={pillCls(roundFilter === r)}>
                      {r}
                    </button>
                  ))}
                </div>
              )}
              {/* ── Class filter + view toggle ──────────────────────────────────── */}
              <div className="flex flex-wrap items-center gap-2">
                {viewMode === "grid" && (
                  <>
                    <button onClick={() => setClassFilter("schedule")} className={pillCls(classFilter === "schedule")}>
                      {roundFilter === "all" ? "Schedule" : "All Classes"}
                    </button>
                    {uniqueClasses.map(cls => (
                      <button key={cls} onClick={() => setClassFilter(cls)} className={pillCls(classFilter === cls)}>
                        {cls}
                      </button>
                    ))}
                  </>
                )}
                <div className="ml-auto flex items-center gap-1 border rounded-lg p-0.5 bg-muted/40">
                  <button
                    onClick={() => setViewMode("grid")}
                    title="Card grid view"
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wider transition-colors ${
                      viewMode === "grid" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <LayoutGrid size={13} />
                    <span className="hidden sm:inline">Grid</span>
                  </button>
                  <button
                    onClick={() => setViewMode("run-order")}
                    title="Run order list"
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wider transition-colors ${
                      viewMode === "run-order" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <LayoutList size={13} />
                    <span className="hidden sm:inline">Run Order</span>
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {viewMode === "run-order" && !isLoading && (() => {
          const runOrderMotos = [...(motos ?? [])].sort((a, b) =>
            localOrderIds
              ? localOrderIds.indexOf(a.id) - localOrderIds.indexOf(b.id)
              : (a.motoNumber ?? 0) - (b.motoNumber ?? 0)
          );
          if (!runOrderMotos.length) return null;
          const typeLabel = (type: string) =>
            type === "main" ? "Main Event" : type === "lcq" ? "LCQ" : type === "practice" ? "Practice" : isSupercrossFormat ? "Heat" : "Moto";
          return (
            <>
            <div id="heat-sheet-print" aria-hidden="true">
              <div className="heat-sheet-header">
                <div className="heat-sheet-event-name">{(event as any)?.name ?? "Event"}</div>
                <div className="heat-sheet-meta">
                  {(event as any)?.date ? new Date((event as any).date).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }) : ""}
                  {(event as any)?.location ? ` · ${(event as any).location}` : ""}
                  {(event as any)?.state ? `, ${(event as any).state}` : ""}
                </div>
                <div className="heat-sheet-title">Heat Sheet — Run Order</div>
                <div className="heat-sheet-generated">Generated {new Date().toLocaleString()}</div>
              </div>
              <div className="heat-sheet-motos">
                {runOrderMotos.map((moto) => {
                  const lineup: LineupEntry[] = Array.isArray(moto.lineup)
                    ? [...(moto.lineup as LineupEntry[])].sort((a, b) => a.position - b.position)
                    : [];
                  return (
                    <div key={moto.id} className="heat-sheet-moto">
                      <div className="heat-sheet-moto-header">
                        <span className="heat-sheet-moto-num">#{moto.motoNumber}</span>
                        <span className="heat-sheet-moto-name">{moto.name}</span>
                        <span className="heat-sheet-moto-class">{moto.raceClass}</span>
                        <span className="heat-sheet-moto-type">{typeLabel(moto.type ?? "heat")}</span>
                      </div>
                      {lineup.length > 0 ? (
                        <table className="heat-sheet-lineup-table">
                          <thead>
                            <tr>
                              <th>Gate Pick</th>
                              <th>Rider</th>
                              <th>#</th>
                            </tr>
                          </thead>
                          <tbody>
                            {lineup.map((entry, i) => (
                              <tr key={entry.riderId}>
                                <td className="heat-sheet-gate">{i + 1}</td>
                                <td className="heat-sheet-rider">{entry.riderName}</td>
                                <td className="heat-sheet-bib">{entry.bibNumber ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <div className="heat-sheet-no-riders">No riders assigned</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="border rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 bg-sidebar text-sidebar-foreground border-b">
                <LayoutList size={14} className="text-sidebar-foreground/60 shrink-0" />
                <h3 className="font-heading font-bold uppercase tracking-wider text-xs">Run Order</h3>
                <span className="text-[10px] text-sidebar-foreground/50 font-normal">— {runOrderMotos.length} motos, read-only</span>
                <button
                  onClick={() => window.print()}
                  className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded border border-border bg-background hover:bg-muted/60 text-xs font-bold uppercase tracking-wider text-foreground transition-colors no-print"
                  title="Print heat sheet"
                >
                  <Printer size={12} />
                  <span>Print</span>
                </button>
              </div>
              <Table>
                <TableHeader className="bg-muted/20">
                  <TableRow>
                    <TableHead className="w-12 text-center text-xs font-bold uppercase tracking-wider">#</TableHead>
                    <TableHead className="text-xs font-bold uppercase tracking-wider">Name</TableHead>
                    <TableHead className="text-xs font-bold uppercase tracking-wider hidden sm:table-cell">Class</TableHead>
                    <TableHead className="text-xs font-bold uppercase tracking-wider hidden md:table-cell">Type</TableHead>
                    <TableHead className="w-16 text-center text-xs font-bold uppercase tracking-wider">Riders</TableHead>
                    <TableHead className="w-24 text-right pr-4 text-xs font-bold uppercase tracking-wider">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runOrderMotos.map((moto, idx) => {
                    const riderCount = Array.isArray(moto.lineup) ? (moto.lineup as any[]).length : 0;
                    const isNext = moto.status === "scheduled" && runOrderMotos.slice(0, idx).every(m => m.status === "completed" || m.status === "in_progress");
                    return (
                      <TableRow
                        key={moto.id}
                        onClick={() => {
                          setViewMode("grid");
                          setClassFilter(moto.raceClass ?? "schedule");
                          setExpandedMotoId(moto.id);
                        }}
                        className={`h-11 cursor-pointer group ${
                          moto.status === "in_progress"
                            ? "bg-primary/5 border-l-2 border-l-primary hover:bg-primary/10"
                            : moto.status === "completed"
                            ? "opacity-60 hover:opacity-80 hover:bg-muted/40"
                            : isNext
                            ? "bg-amber-500/5 hover:bg-amber-500/10"
                            : "hover:bg-muted/40"
                        }`}
                      >
                        <TableCell className="text-center">
                          <div className={`w-7 h-7 rounded-full flex items-center justify-center font-heading font-bold text-sm mx-auto ${
                            moto.status === "in_progress"
                              ? "bg-primary text-primary-foreground"
                              : moto.status === "completed"
                              ? "bg-muted text-muted-foreground"
                              : isNext
                              ? "bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/30"
                              : "bg-muted/60 text-muted-foreground"
                          }`}>
                            {moto.motoNumber}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm truncate">{moto.name}</span>
                            {moto.status === "in_progress" && (
                              <span className="relative flex h-2 w-2 shrink-0">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                              </span>
                            )}
                            {isNext && moto.status === "scheduled" && (
                              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400 shrink-0">
                                Up next
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground sm:hidden">{moto.raceClass}</div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <span className="text-sm text-muted-foreground truncate">{moto.raceClass}</span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider border ${
                            moto.type === "main"
                              ? "bg-primary/10 text-primary border-primary/30"
                              : moto.type === "lcq"
                              ? "bg-orange-500/10 text-orange-600 border-orange-500/30"
                              : moto.type === "practice"
                              ? "bg-sky-500/10 text-sky-600 border-sky-500/30"
                              : "bg-muted text-muted-foreground border-border"
                          }`}>
                            {moto.type === "main" ? "Main" : moto.type === "lcq" ? "LCQ" : moto.type === "practice" ? "Practice" : isSupercrossFormat ? "Heat" : "Moto"}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          <span className="font-heading font-bold text-sm tabular-nums">{riderCount}</span>
                        </TableCell>
                        <TableCell className="text-right pr-4">
                          <div className="flex items-center justify-end gap-2">
                            <LayoutGrid size={13} className="text-muted-foreground/0 group-hover:text-muted-foreground/50 transition-colors shrink-0" aria-label="Open in grid" />
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${
                              moto.status === "in_progress"
                                ? "bg-primary/15 text-primary border-primary/30 animate-pulse"
                                : moto.status === "completed"
                                ? "bg-secondary/15 text-secondary border-secondary/30"
                                : "bg-muted text-muted-foreground border-transparent"
                            }`}>
                              {moto.status === "in_progress" && (
                                <span className="inline-block w-1.5 h-1.5 bg-primary rounded-full animate-ping shrink-0" />
                              )}
                              {moto.status.replace("_", " ")}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            </>
          );
        })()}

        {viewMode === "grid" && isLoading ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {[...Array(4)].map((_, i) => <Card key={i} className="h-64 animate-pulse" />)}
          </div>
        ) : viewMode === "grid" && motos?.length ? (
        <div className="space-y-0">
          {motos.filter(m => {
              // stagger order>1 motos are rendered inside the order=1 card
              if ((m as any).staggeredGroupId && (m as any).staggeredOrder > 1) return false;
              if (m.type === "practice") return classFilter === "schedule" && roundFilter === "all";
              if (classFilter !== "schedule" && m.raceClass !== classFilter) return false;
              if (roundFilter !== "all" && roundMap.get(m.id) !== roundFilter) return false;
              return true;
            }).sort((a, b) => {
              if (localOrderIds) {
                return localOrderIds.indexOf(a.id) - localOrderIds.indexOf(b.id);
              }
              const rank = (s: string) => s === "in_progress" ? 0 : s === "scheduled" ? 1 : s === "completed" ? 2 : 3;
              const rd = rank(a.status) - rank(b.status);
              if (rd !== 0) return rd;
              return (a.motoNumber || 0) - (b.motoNumber || 0);
            }).map((moto) => (
            <div key={moto.id} id={`moto-card-${moto.id}`}>
              <DroppableMotoSlot id={`moto-slot-${moto.id}`} active={!!activeMotoCardDrag && activeMotoCardDrag.motoId !== moto.id} />
            <Card className="flex flex-col h-full border-sidebar-border overflow-hidden">
              <CardHeader className="bg-sidebar text-sidebar-foreground py-3 border-b flex flex-row items-center gap-3 px-4">
                {/* Race number corner block */}
                <div className="shrink-0 self-stretch -my-3 -ml-4 mr-0 flex flex-col items-center justify-center bg-primary border-r border-primary/70 w-14">
                  <span className="text-[8px] font-bold uppercase tracking-widest text-white leading-none mb-0.5">RACE</span>
                  <span className="font-heading font-bold text-2xl leading-none tabular-nums text-white">{moto.motoNumber}</span>
                </div>

                <DraggableMotoGrip motoId={moto.id} disabled={classFilter !== "schedule" || moto.status === "in_progress" || moto.status === "completed"} />

                {/* Name + class + badges */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {(moto.raceClass || moto.type === "practice") && (
                      <span className="text-xs font-bold uppercase tracking-wider text-sidebar-foreground/60 shrink-0 truncate">
                        {moto.raceClass || "All Classes"}
                      </span>
                    )}
                    <span className="font-medium text-sm truncate">{moto.name}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {/* Type badge — same variants as Schedule page */}
                    <span className={`text-xs px-2 py-0.5 rounded border font-semibold uppercase tracking-wide ${
                      moto.type === "practice" ? "bg-blue-500/20 text-blue-300 border-blue-500/30" :
                      moto.type === "heat"     ? "bg-white/15 text-white border-white/25" :
                      moto.type === "lcq"      ? "bg-orange-500/20 text-orange-300 border-orange-500/30" :
                      moto.type === "main"     ? "bg-primary/20 text-primary border-primary/30" :
                      moto.type === "moto"     ? "bg-teal-500/20 text-teal-300 border-teal-500/30" :
                                                 "bg-muted text-muted-foreground border-border"
                    }`}>
                      {moto.type === "main" ? "Main" : moto.type === "practice" ? "Practice" : moto.type === "lcq" ? "LCQ" : moto.type === "moto" ? "Moto" : "Heat"}
                    </span>
                    {/* Status badge */}
                    <span className={`text-xs px-2 py-0.5 rounded border flex items-center gap-1 ${
                      moto.status === "in_progress" ? "bg-green-500/20 text-green-300 border-green-500/30 animate-pulse" :
                      moto.status === "completed"   ? "bg-white/10 text-white/60 border-white/15" :
                                                      "bg-white/10 text-white/75 border-white/20"
                    }`}>
                      {moto.status === "in_progress" && (
                        <span className="inline-block w-1.5 h-1.5 bg-green-400 rounded-full animate-ping shrink-0" />
                      )}
                      {moto.status === "in_progress" ? "In Progress" : moto.status === "completed" ? "Completed" : "Scheduled"}
                    </span>
                    {/* Rider count */}
                    <span className="text-xs text-sidebar-foreground/60 flex items-center gap-1">
                      <Flag size={11} /> {Array.isArray(moto.lineup) ? moto.lineup.length : 0} riders
                    </span>
                    {/* Staggered start badge */}
                    {(moto as any).staggeredOrder === 1 && (moto as any).staggeredGroupId && (
                      <span className="text-xs px-1.5 py-0.5 rounded border bg-primary/15 text-primary border-primary/30 flex items-center gap-1 font-semibold">
                        <Link2 size={9} /> Staggered
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions: primary status action + icon buttons */}
                <div className="flex items-center gap-1 shrink-0">
                  {/* Start/Finish/Restart — compact pill in header */}
                  {moto.status === "scheduled" && (
                    <Button size="sm" onClick={() => handleStartMoto(moto)} className="font-heading uppercase text-xs h-7 px-2.5 gap-1">
                      <Play size={12} /> {(moto as any).staggeredOrder === 1 && (moto as any).staggeredGroupId ? "Start Group" : "Start"}
                    </Button>
                  )}
                  {moto.status === "in_progress" && (
                    <Button size="sm" variant="outline" className="text-secondary border-secondary/50 font-heading uppercase text-xs h-7 px-2.5 gap-1" onClick={() => doFinishMoto(moto.id)}>
                      <CheckCircle size={12} /> {(moto as any).staggeredOrder === 1 && (moto as any).staggeredGroupId ? "Finish Group" : "Finish"}
                    </Button>
                  )}
                  {/* Icon buttons */}
                  <button
                    onClick={() => handleQuickAddHeat(moto)}
                    disabled={createMotoMutation.isPending}
                    className="text-sidebar-foreground/50 hover:text-green-400 transition-colors p-1 rounded hover:bg-white/10 disabled:opacity-40"
                    title={`Add another ${moto.type === "main" ? "main" : isSupercrossFormat ? "heat" : "heat"} for ${moto.raceClass}`}
                  >
                    <Plus size={14} />
                  </button>
                  {moto.type !== "practice" && moto.status !== "completed" && (
                    <button
                      onClick={() => {
                        setPerMotoDialog({ open: true, motoId: moto.id, motoName: moto.name, motoClass: moto.raceClass ?? "" });
                        setPerMotoGateMethod("random");
                      }}
                      className="text-sidebar-foreground/50 hover:text-violet-400 transition-colors p-1 rounded hover:bg-white/10"
                      title="Regenerate lineup"
                    >
                      <Wand2 size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => setExpandedMotoId(moto.id)}
                    className="text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors p-1 rounded hover:bg-white/10"
                    title="Expand view"
                  >
                    <Maximize2 size={14} />
                  </button>
                </div>
              </CardHeader>

              <CardContent className="p-0 flex-1 flex flex-col">
                {/* Lineup table — draggable for all moto types */}
                {(
                  <>
                  <LineupSortBar sort={getMotoSort(moto.id)} onChange={s => setMotoSort(moto.id, s)} />
                  <DroppableMotoLineup motoId={moto.id} locked={moto.status === "completed" || getMotoSort(moto.id) !== "gate"} disableDrop={!!activeMotoCardDrag || activeDragMotoId === moto.id}>
                    <Table className="table-fixed">
                      <TableHeader className="bg-muted/50 sticky top-0">
                        <TableRow>
                          <TableHead className="w-12 text-center text-xs font-bold uppercase tracking-wider">Gate Pick</TableHead>
                          <TableHead className="w-8 text-center text-xs" title={moto.status === "completed" ? "Lineup locked" : "Drag to move rider"}>
                            <GripVertical size={12} className={`mx-auto ${moto.status === "completed" || getMotoSort(moto.id) !== "gate" ? "text-muted-foreground/30" : "text-muted-foreground"}`} />
                          </TableHead>
                          <TableHead className="text-xs">Rider</TableHead>
                          <TableHead className="w-16 text-center text-xs">#</TableHead>
                          <TableHead className="w-20 text-center text-xs">RFID</TableHead>
                          {moto.status === "in_progress" && <TableHead className="w-24" />}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {getLineup(moto).length > 0 ? (
                          sortLineup(getLineup(moto), getMotoSort(moto.id)).flatMap((entry, idx, arr) => {
                            const isSorted = getMotoSort(moto.id) !== "gate";
                            const isSlotActive = !isSorted && activeDragMotoId === moto.id && moto.status !== "completed";
                            const slotColSpan = moto.status === "in_progress" ? 6 : 5;
                            return [
                              ...(!isSorted ? [<GateDropSlotRow key={`slot-${moto.id}-${idx}`} id={`gate-slot-${moto.id}-${idx}`} isActive={isSlotActive} colSpan={slotColSpan} />] : []),
                              <DraggableRiderRow
                                key={entry.riderId} entry={entry} motoId={moto.id} locked={moto.status === "completed" || isSorted}
                                onRecordLap={moto.status === "in_progress" ? () => handleManualLap(entry.riderId, moto.id) : undefined}
                                lapCooldown={manualLapCooldown.has(`${moto.id}-${entry.riderId}`)}
                                rowNum={entry.position}
                                hasShortLap={shortLapSet.has(`${moto.id}-${entry.riderId}`)}
                                onViewLaps={moto.status === "completed" ? () => setLapEditTarget({ riderId: entry.riderId, riderName: entry.riderName, motoId: moto.id, eventId, minLapTimeMs: minLapMs ?? null }) : undefined}
                              />,
                              ...(!isSorted && idx === arr.length - 1 ? [<GateDropSlotRow key={`slot-${moto.id}-${idx + 1}`} id={`gate-slot-${moto.id}-${idx + 1}`} isActive={isSlotActive} colSpan={slotColSpan} />] : []),
                            ];
                          })
                        ) : (
                          <TableRow>
                            <TableCell colSpan={moto.status === "in_progress" ? 5 : 4} className="text-center py-4 text-muted-foreground text-sm">
                              No lineup generated
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </DroppableMotoLineup>
                  </>
                )}

                {/* Stagger group lineups — shown on order=1 card for all group members */}
                {(moto as any).staggeredOrder === 1 && ((moto as any).staggeredGroupMembers as number[] | undefined)?.length && (() => {
                  const groupMemberIds: number[] = (moto as any).staggeredGroupMembers ?? [];
                  const partners = groupMemberIds
                    .filter(id => id !== moto.id)
                    .map(id => (motos ?? []).find(m => m.id === id))
                    .filter((m): m is typeof motos extends (infer T)[] | undefined ? NonNullable<T> : never => !!m);
                  if (partners.length === 0) return null;
                  return (
                    <>
                      {partners.map((partner, pIdx) => {
                        const startPos = (partner as any).staggeredOrder ?? (pIdx + 2);
                        const posSuffix = startPos === 2 ? "nd" : startPos === 3 ? "rd" : `${startPos}th`;
                  const partnerRunning = partner.status === "in_progress";
                  const isSorted = getMotoSort(partner.id) !== "gate";
                  const isSlotActive = !isSorted && activeDragMotoId === partner.id && partner.status !== "completed";
                  const slotColSpan = partnerRunning ? 6 : 5;
                  return (
                    <div key={partner.id} className="border-t-2 border-primary/20">
                      <div className="px-3 py-1.5 flex items-center gap-2 bg-primary/5 border-b border-primary/10">
                        <Link2 size={11} className="text-primary shrink-0" />
                        <span className="text-xs font-semibold text-primary flex-1 truncate">{partner.name} — starts {startPos}{posSuffix}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-bold uppercase ${
                          partner.status === "in_progress" ? "bg-green-500/20 text-green-300 border-green-500/30" :
                          partner.status === "completed"   ? "bg-muted text-muted-foreground border-border" :
                                                             "bg-zinc-900 text-white border-zinc-600"
                        }`}>
                          {partner.status === "in_progress" ? "Running" : partner.status === "completed" ? "Done" : "Waiting"}
                        </span>
                      </div>
                      <LineupSortBar sort={getMotoSort(partner.id)} onChange={s => setMotoSort(partner.id, s)} />
                      <DroppableMotoLineup motoId={partner.id} locked={partner.status === "completed" || getMotoSort(partner.id) !== "gate"} disableDrop={!!activeMotoCardDrag || activeDragMotoId === partner.id}>
                        <Table className="table-fixed">
                          <TableHeader className="bg-muted/50 sticky top-0">
                            <TableRow>
                              <TableHead className="w-12 text-center text-xs font-bold uppercase tracking-wider">Gate Pick</TableHead>
                              <TableHead className="w-8 text-center text-xs">
                                <GripVertical size={12} className={`mx-auto ${partner.status === "completed" || getMotoSort(partner.id) !== "gate" ? "text-muted-foreground/30" : "text-muted-foreground"}`} />
                              </TableHead>
                              <TableHead className="text-xs">Rider</TableHead>
                              <TableHead className="w-16 text-center text-xs">#</TableHead>
                              <TableHead className="w-20 text-center text-xs">RFID</TableHead>
                              {partnerRunning && <TableHead className="w-24" />}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {getLineup(partner).length > 0 ? (
                              sortLineup(getLineup(partner), getMotoSort(partner.id)).flatMap((entry, idx, arr) => [
                                ...(!isSorted ? [<GateDropSlotRow key={`slot-${partner.id}-${idx}`} id={`gate-slot-${partner.id}-${idx}`} isActive={isSlotActive} colSpan={slotColSpan} />] : []),
                                <DraggableRiderRow
                                  key={entry.riderId} entry={entry} motoId={partner.id} locked={partner.status === "completed" || isSorted}
                                  onRecordLap={partnerRunning ? () => handleManualLap(entry.riderId, partner.id) : undefined}
                                  lapCooldown={manualLapCooldown.has(`${partner.id}-${entry.riderId}`)}
                                  rowNum={entry.position}
                                  hasShortLap={partner.status !== "scheduled" && shortLapSet.has(`${partner.id}-${entry.riderId}`)}
                                  onViewLaps={partner.status === "completed" ? () => setLapEditTarget({ riderId: entry.riderId, riderName: entry.riderName, motoId: partner.id, eventId, minLapTimeMs: minLapMs ?? null }) : undefined}
                                />,
                                ...(!isSorted && idx === arr.length - 1 ? [<GateDropSlotRow key={`slot-${partner.id}-${idx + 1}`} id={`gate-slot-${partner.id}-${idx + 1}`} isActive={isSlotActive} colSpan={slotColSpan} />] : []),
                              ])
                            ) : (
                              <TableRow>
                                <TableCell colSpan={slotColSpan} className="text-center py-4 text-muted-foreground text-sm">No lineup assigned</TableCell>
                              </TableRow>
                            )}
                          </TableBody>
                        </Table>
                      </DroppableMotoLineup>
                    </div>
                  );
                })}
                  </>
                  );
                })()}

                {/* Practice time limit countdown — banner (shown only for practice motos) */}
                {moto.type === "practice" && moto.status === "in_progress" && expandedMotoId !== moto.id && (moto as any).timeLimitMs && (
                  <div className={`border-t flex items-center gap-3 px-4 py-2.5 transition-all ${
                    (() => {
                      const r = new Date((moto as any).startedAt ?? Date.now()).getTime() + (moto as any).timeLimitMs - Date.now();
                      return r <= 0 ? "bg-destructive/10 border-destructive/30" : r < 60000 ? "bg-destructive/10" : r < 120000 ? "bg-primary/10" : "bg-sky-500/5";
                    })()
                  }`}>
                    <Timer size={15} className="shrink-0 text-sky-500" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground leading-none mb-0.5">Practice Time Limit</div>
                    </div>
                    <PracticeTimeLimitCountdown
                      startedAt={(moto as any).startedAt ?? null}
                      timeLimitMs={(moto as any).timeLimitMs ?? null}
                      onExpire={() => handleStatusUpdate(moto.id, "completed")}
                    />
                  </div>
                )}
                {/* First place finish countdown — hidden when expanded dialog is open, not shown for practice */}
                {moto.type !== "practice" && moto.status === "in_progress" && expandedMotoId !== moto.id && (
                  <FirstPlaceCountdown motoId={moto.id} lapCount={(moto as any).lapCount} />
                )}

                {/* Live leaderboard + crossings — hidden when expanded dialog is open to prevent double pings */}
                {expandedMotoId !== moto.id && (() => {
                  const groupMemberIds: number[] = (moto as any).staggeredGroupMembers ?? [];
                  const staggerPartners = groupMemberIds
                    .filter(id => id !== moto.id)
                    .map(id => (motos ?? []).find(m => m.id === id))
                    .filter((m): m is NonNullable<typeof m> => !!m && m.status === "in_progress");
                  const showMoto1 = moto.status === "in_progress";
                  const showAny = showMoto1 || staggerPartners.length > 0;
                  if (!showAny) return null;
                  return (
                    <>
                      {showMoto1 && (
                        <div className="border-t">
                          {staggerPartners.length > 0 && (
                            <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-widest bg-muted/30 border-b text-muted-foreground">{moto.name}</div>
                          )}
                          <div className="grid grid-cols-2 divide-x">
                            <LiveLeaderboard motoId={moto.id} />
                            <LiveCrossingsFeed motoId={moto.id} minLapTimeMs={minLapMs ?? null} />
                          </div>
                        </div>
                      )}
                      {staggerPartners.map(partner => (
                        <div key={partner.id} className="border-t">
                          <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-widest bg-muted/30 border-b text-muted-foreground">{partner.name}</div>
                          <div className="grid grid-cols-2 divide-x">
                            <LiveLeaderboard motoId={partner.id} />
                            <LiveCrossingsFeed motoId={partner.id} minLapTimeMs={minLapMs ?? null} />
                          </div>
                        </div>
                      ))}
                    </>
                  );
                })()}

                {/* Action bar */}
                <div className="p-3 bg-muted/30 flex gap-2 items-center flex-wrap">
                  {moto.status === "in_progress" && (
                    <Button size="sm" variant="ghost" className="text-muted-foreground font-heading uppercase text-xs" onClick={() => setRestartDialog({ open: true, motoId: moto.id, motoName: moto.name })}>
                      <RefreshCw size={14} className="mr-1" /> Restart Moto
                    </Button>
                  )}

                  {moto.status === "in_progress" && (
                    <form
                      className="flex items-center gap-1"
                      onSubmit={e => { e.preventDefault(); handleBibEntry(moto.id, getLineup(moto)); }}
                    >
                      <div className="relative">
                        <Timer size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder="#"
                          value={bibInputs[moto.id] ?? ""}
                          onChange={e => setBibInputs(prev => ({ ...prev, [moto.id]: e.target.value }))}
                          className="h-7 w-20 pl-6 pr-2 rounded border border-border bg-background text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary placeholder:text-muted-foreground/60"
                        />
                      </div>
                    </form>
                  )}

                  {moto.type === "practice" && moto.status === "in_progress" && (moto as any).timeLimitMs ? (
                    <PracticeTimeLimitCountdown
                      startedAt={(moto as any).startedAt ?? null}
                      timeLimitMs={(moto as any).timeLimitMs ?? null}
                      onExpire={() => handleStatusUpdate(moto.id, "completed")}
                    />
                  ) : moto.type !== "practice" && moto.status === "in_progress" ? (
                    <FirstPlaceCountdown motoId={moto.id} lapCount={(moto as any).lapCount} variant="inline" />
                  ) : null}

                  <div className="ml-auto flex gap-1.5">
                    {/* Live timing link — always available */}
                    <a href={`/live/${moto.id}`} target="_blank" rel="noopener noreferrer">
                      <Button size="sm" variant="ghost" className={`font-heading uppercase text-xs gap-1 ${moto.status === "in_progress" ? "text-primary" : "text-muted-foreground"}`}>
                        <Radio size={13} /> Live
                        <ExternalLink size={11} />
                      </Button>
                    </a>
                    <Button size="sm" variant="ghost" className="text-muted-foreground px-2" onClick={() => copyLiveLink(moto.id)}>
                      {copiedId === moto.id ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive/60 hover:text-destructive hover:bg-destructive/10 px-2"
                      onClick={() => setConfirmDeleteId(moto.id)}
                      title="Delete heat"
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
            </div>
          ))}
          {classFilter === "schedule" && <DroppableMotoSlot id="moto-slot-end" active={!!activeMotoCardDrag} />}

          {/* Add New Race button */}
          <button
            onClick={() => setIsCreateOpen(true)}
            className="group w-full mt-4 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border py-8 text-muted-foreground transition-all duration-150 hover:border-green-500 hover:bg-green-500/10 hover:text-green-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-current transition-all duration-150 group-hover:bg-green-500 group-hover:border-green-500 group-hover:text-white">
              <Plus size={28} strokeWidth={2.5} />
            </span>
            <span className="text-sm font-bold uppercase tracking-widest">Add New Race</span>
          </button>
        </div>
        ) : viewMode === "grid" ? (
          <Card>
            <CardContent className="p-16 text-center">
              <Flag className="mx-auto text-muted-foreground opacity-20 mb-4" size={48} />
              <h3 className="text-xl font-heading font-bold mb-2">No Motos Generated</h3>
              <p className="text-muted-foreground mb-6">Use the Schedule tab to generate lineups for this event.</p>
            </CardContent>
          </Card>
        ) : null}
        </div>{/* right column */}
      </div>{/* flex row */}
      <DragOverlay dropAnimation={null}>
        {activeMotoCardDrag && (
          <div className="flex items-center gap-2 bg-sidebar text-sidebar-foreground border border-primary/40 shadow-xl rounded-md px-3 py-2.5 text-sm font-medium pointer-events-none opacity-90">
            <GripVertical size={14} className="text-sidebar-foreground/50 shrink-0" />
            <span className="font-heading uppercase text-sm">{activeMotoCardDrag.name}</span>
          </div>
        )}
        {activeDrag && (
          <div className="flex items-center gap-2 bg-card border border-primary/40 shadow-lg rounded-md px-3 py-2 text-sm font-medium pointer-events-none">
            <GripVertical size={14} className="text-muted-foreground shrink-0" />
            <span>{activeDrag.riderName}</span>
            {activeDrag.bibNumber && <span className="font-mono text-xs text-muted-foreground">#{activeDrag.bibNumber}</span>}
          </div>
        )}
      </DragOverlay>
      <DroppableTrashZone visible={!!activeDrag} />
      </DndContext>

      {/* Expanded moto dialog */}
      {(() => {
        const moto = expandedMotoId !== null ? (motos ?? []).find(m => m.id === expandedMotoId) : null;
        if (!moto) return null;
        return (
          <Dialog open={true} onOpenChange={open => { if (!open) setExpandedMotoId(null); }}>
            <DialogContent className="max-w-3xl w-full p-0 overflow-hidden gap-0 h-[95vh] flex flex-col">
              {/* Header */}
              <div className="bg-sidebar text-sidebar-foreground px-5 py-4 border-b flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                  <div className="bg-sidebar-accent text-white w-10 h-10 rounded-full flex items-center justify-center font-heading font-bold text-xl">
                    {moto.motoNumber}
                  </div>
                  <div>
                    <div className="font-heading uppercase text-xl font-bold text-white leading-tight">{moto.name}</div>
                    <div className="flex items-center gap-2 text-xs text-sidebar-foreground/70 uppercase tracking-widest mt-0.5">
                      <span>{moto.raceClass}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider border ${
                        moto.type === "main"
                          ? "bg-primary/30 text-primary border-primary/40"
                          : moto.type === "practice"
                          ? "bg-blue-500/20 text-blue-300 border-blue-500/30"
                          : "bg-white/10 text-sidebar-foreground/80 border-white/20"
                      }`}>
                        {moto.type === "main" ? "Main Event" : moto.type === "practice" ? "Practice" : isSupercrossFormat ? "Heat" : "Moto"}
                      </span>
                    </div>
                  </div>
                </div>
                <span className={`px-2.5 py-1 rounded text-xs font-bold uppercase tracking-wider border ${
                  moto.status === "in_progress" ? "bg-primary/20 text-primary border-primary/30 animate-pulse" :
                  moto.status === "completed" ? "bg-secondary/20 text-secondary border-secondary/30" :
                  "bg-sidebar-accent text-sidebar-foreground/80 border-transparent"
                }`}>
                  {moto.status === "in_progress" && (
                    <span className="inline-block w-1.5 h-1.5 bg-primary rounded-full mr-1 animate-ping" />
                  )}
                  {moto.status.replace("_", " ")}
                </span>
              </div>

              {/* Scrollable body */}
              <div className="flex-1 overflow-y-auto min-h-0">
                {/* Lineup table */}
                {moto.type === "heat" ? (
                  <>
                  <LineupSortBar sort={getMotoSort(moto.id)} onChange={s => setMotoSort(moto.id, s)} />
                  <DroppableMotoLineup motoId={moto.id} locked={moto.status === "completed" || getMotoSort(moto.id) !== "gate"} className="flex-1" disableDrop={activeDragMotoId === moto.id}>
                    <Table>
                      <TableHeader className="bg-muted/50 sticky top-0 z-10">
                        <TableRow>
                          <TableHead className="w-12 text-center text-xs font-bold uppercase tracking-wider">Gate Pick</TableHead>
                          <TableHead className="w-8 text-center text-xs" title={moto.status === "completed" ? "Lineup locked" : "Drag to move rider"}>
                            <GripVertical size={12} className={`mx-auto ${moto.status === "completed" || getMotoSort(moto.id) !== "gate" ? "text-muted-foreground/30" : "text-muted-foreground"}`} />
                          </TableHead>
                          <TableHead className="text-xs">Rider</TableHead>
                          <TableHead className="w-16 text-center text-xs">#</TableHead>
                          <TableHead className="w-20 text-center text-xs">RFID</TableHead>
                          {moto.status === "in_progress" && <TableHead className="w-28 text-xs text-right pr-3">Manual Lap</TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {getLineup(moto).length > 0 ? (
                          sortLineup(getLineup(moto), getMotoSort(moto.id)).flatMap((entry, idx, arr) => {
                            const isSorted = getMotoSort(moto.id) !== "gate";
                            const isSlotActive = !isSorted && activeDragMotoId === moto.id && moto.status !== "completed";
                            const slotColSpan = moto.status === "in_progress" ? 6 : 5;
                            return [
                              ...(!isSorted ? [<GateDropSlotRow key={`slot-${moto.id}-${idx}`} id={`gate-slot-${moto.id}-${idx}`} isActive={isSlotActive} colSpan={slotColSpan} />] : []),
                              <DraggableRiderRow
                                key={entry.riderId} entry={entry} motoId={moto.id} locked={moto.status === "completed" || isSorted}
                                onRecordLap={moto.status === "in_progress" ? () => handleManualLap(entry.riderId, moto.id) : undefined}
                                lapCooldown={manualLapCooldown.has(`${moto.id}-${entry.riderId}`)}
                                rowNum={entry.position}
                                hasShortLap={shortLapSet.has(`${moto.id}-${entry.riderId}`)}
                                onViewLaps={moto.status === "completed" ? () => setLapEditTarget({ riderId: entry.riderId, riderName: entry.riderName, motoId: moto.id, eventId, minLapTimeMs: minLapMs ?? null }) : undefined}
                              />,
                              ...(!isSorted && idx === arr.length - 1 ? [<GateDropSlotRow key={`slot-${moto.id}-${idx + 1}`} id={`gate-slot-${moto.id}-${idx + 1}`} isActive={isSlotActive} colSpan={slotColSpan} />] : []),
                            ];
                          })
                        ) : (
                          <TableRow>
                            <TableCell colSpan={moto.status === "in_progress" ? 5 : 4} className="text-center py-6 text-muted-foreground text-sm">No lineup generated</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </DroppableMotoLineup>
                  </>
                ) : (
                  <div className="flex-1 border-b">
                    <LineupSortBar sort={getMotoSort(moto.id)} onChange={s => setMotoSort(moto.id, s)} />
                    <Table>
                      <TableHeader className="bg-muted/50 sticky top-0 z-10">
                        <TableRow>
                          <TableHead className="w-12 text-center text-xs">Gate Pick</TableHead>
                          <TableHead className="text-xs">Rider</TableHead>
                          <TableHead className="w-16 text-center text-xs">#</TableHead>
                          <TableHead className="w-20 text-center text-xs">RFID</TableHead>
                          {moto.status === "in_progress" && <TableHead className="w-28 text-xs text-right pr-3">Manual Lap</TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {moto.lineup && moto.lineup.length > 0 ? (
                          sortLineup(moto.lineup as LineupEntry[], getMotoSort(moto.id)).map((entry) => {
                            const cooldown = manualLapCooldown.has(`${moto.id}-${entry.riderId}`);
                            const entryHasShortLap = shortLapSet.has(`${moto.id}-${entry.riderId}`);
                            return (
                              <TableRow key={entry.riderId} className="h-9">
                                <TableCell className="text-center font-heading font-bold">{entry.position}</TableCell>
                                <TableCell className={`font-medium ${entryHasShortLap ? "text-red-600 dark:text-red-400" : ""}`}>
                                  {moto.status === "completed" ? (
                                    <button onClick={() => setLapEditTarget({ riderId: entry.riderId, riderName: entry.riderName, motoId: moto.id, eventId, minLapTimeMs: minLapMs ?? null })} className={`flex items-center gap-1 transition-colors group ${entryHasShortLap ? "hover:text-red-700 dark:hover:text-red-300" : "hover:text-primary"}`}>
                                      {entry.riderName}
                                      <Clock size={11} className="opacity-0 group-hover:opacity-60 transition-opacity" />
                                    </button>
                                  ) : entry.riderName}
                                </TableCell>
                                <TableCell className="text-center font-mono text-xs">{entry.bibNumber || "—"}</TableCell>
                                <TableCell className="text-center">
                                  {entry.rfidNumber ? (
                                    <span className="inline-flex items-center gap-1 text-green-600">
                                      <Radio size={10} /> <span className="font-mono text-xs">{entry.rfidNumber}</span>
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground text-xs">—</span>
                                  )}
                                </TableCell>
                                {moto.status === "in_progress" && (
                                  <TableCell className="pr-3 text-right">
                                    <button
                                      onClick={() => handleManualLap(entry.riderId, moto.id)}
                                      disabled={cooldown}
                                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-heading font-bold uppercase tracking-wide transition-all border ${
                                        cooldown
                                          ? "bg-green-100 border-green-300 text-green-600 opacity-60 cursor-not-allowed"
                                          : "bg-background border-border text-muted-foreground hover:border-orange-400 hover:text-orange-600 hover:bg-orange-50"
                                      }`}
                                    >
                                      <Timer size={11} />
                                      {cooldown ? "Recorded" : "Record Lap"}
                                    </button>
                                  </TableCell>
                                )}
                              </TableRow>
                            );
                          })
                        ) : (
                          <TableRow>
                            <TableCell colSpan={moto.status === "in_progress" ? 5 : 4} className="text-center py-6 text-muted-foreground text-sm">No lineup generated</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {/* Stagger group lineups — expanded dialog, all group members */}
                {(moto as any).staggeredOrder === 1 && ((moto as any).staggeredGroupMembers as number[] | undefined)?.length && (() => {
                  const groupMemberIds: number[] = (moto as any).staggeredGroupMembers ?? [];
                  const expandedPartners = groupMemberIds
                    .filter(id => id !== moto.id)
                    .map(id => (motos ?? []).find(m => m.id === id))
                    .filter((m): m is NonNullable<typeof m> => !!m);
                  if (expandedPartners.length === 0) return null;
                  return (
                    <>
                      {expandedPartners.map((partner, pIdx) => {
                        const startPos = (partner as any).staggeredOrder ?? (pIdx + 2);
                        const posSuffix = startPos === 2 ? "nd" : startPos === 3 ? "rd" : `${startPos}th`;
                  const partnerRunning = partner.status === "in_progress";
                  const isSorted = getMotoSort(partner.id) !== "gate";
                  const isSlotActive = !isSorted && activeDragMotoId === partner.id && partner.status !== "completed";
                  const slotColSpan = partnerRunning ? 6 : 5;
                  return (
                    <div key={partner.id} className="border-t-2 border-primary/25">
                      <div className="px-5 py-3 flex items-center gap-2 bg-primary/5 border-b border-primary/15">
                        <Link2 size={13} className="text-primary shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-primary truncate">{partner.name} — starts {startPos}{posSuffix}</div>
                          <div className="text-xs text-muted-foreground">{partner.raceClass ?? ""}</div>
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded border font-bold uppercase ${
                          partner.status === "in_progress" ? "bg-green-500/20 text-green-300 border-green-500/30" :
                          partner.status === "completed"   ? "bg-muted text-muted-foreground border-border" :
                                                             "bg-zinc-900 text-white border-zinc-600"
                        }`}>
                          {partner.status === "in_progress" ? "Running" : partner.status === "completed" ? "Done" : "Waiting"}
                        </span>
                      </div>
                      <LineupSortBar sort={getMotoSort(partner.id)} onChange={s => setMotoSort(partner.id, s)} />
                      <DroppableMotoLineup motoId={partner.id} locked={partner.status === "completed" || getMotoSort(partner.id) !== "gate"} className="flex-1" disableDrop={activeDragMotoId === partner.id}>
                        <Table className="table-fixed">
                          <TableHeader className="bg-muted/50 sticky top-0">
                            <TableRow>
                              <TableHead className="w-12 text-center text-xs font-bold uppercase tracking-wider">Gate Pick</TableHead>
                              <TableHead className="w-8 text-center text-xs" title={partner.status === "completed" ? "Lineup locked" : "Drag to move rider"}>
                                <GripVertical size={12} className={`mx-auto ${partner.status === "completed" || getMotoSort(partner.id) !== "gate" ? "text-muted-foreground/30" : "text-muted-foreground"}`} />
                              </TableHead>
                              <TableHead className="text-xs">Rider</TableHead>
                              <TableHead className="w-16 text-center text-xs">#</TableHead>
                              <TableHead className="w-20 text-center text-xs">RFID</TableHead>
                              {partnerRunning && <TableHead className="w-24" />}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {getLineup(partner).length > 0 ? (
                              sortLineup(getLineup(partner), getMotoSort(partner.id)).flatMap((entry, idx, arr) => [
                                ...(!isSorted ? [<GateDropSlotRow key={`slot-${partner.id}-${idx}`} id={`gate-slot-${partner.id}-${idx}`} isActive={isSlotActive} colSpan={slotColSpan} />] : []),
                                <DraggableRiderRow
                                  key={entry.riderId} entry={entry} motoId={partner.id} locked={partner.status === "completed" || isSorted}
                                  onRecordLap={partnerRunning ? () => handleManualLap(entry.riderId, partner.id) : undefined}
                                  lapCooldown={manualLapCooldown.has(`${partner.id}-${entry.riderId}`)}
                                  rowNum={entry.position}
                                  hasShortLap={partner.status !== "scheduled" && shortLapSet.has(`${partner.id}-${entry.riderId}`)}
                                  onViewLaps={partner.status === "completed" ? () => setLapEditTarget({ riderId: entry.riderId, riderName: entry.riderName, motoId: partner.id, eventId, minLapTimeMs: minLapMs ?? null }) : undefined}
                                />,
                                ...(!isSorted && idx === arr.length - 1 ? [<GateDropSlotRow key={`slot-${partner.id}-${idx + 1}`} id={`gate-slot-${partner.id}-${idx + 1}`} isActive={isSlotActive} colSpan={slotColSpan} />] : []),
                              ])
                            ) : (
                              <TableRow>
                                <TableCell colSpan={slotColSpan} className="text-center py-4 text-muted-foreground text-sm">No lineup assigned</TableCell>
                              </TableRow>
                            )}
                          </TableBody>
                        </Table>
                      </DroppableMotoLineup>
                    </div>
                  );
                })}
                    </>
                  );
                })()}

                {/* First place finish countdown — not shown for practice motos */}
                {moto.type !== "practice" && moto.status === "in_progress" && (
                  <FirstPlaceCountdown motoId={moto.id} lapCount={(moto as any).lapCount} />
                )}

                {/* Practice time limit countdown — shown in expanded dialog when in progress */}
                {moto.type === "practice" && moto.status === "in_progress" && (moto as any).timeLimitMs && (
                  <div className="border-t flex items-center gap-3 px-4 py-2.5 bg-sky-500/5">
                    <Timer size={15} className="shrink-0 text-sky-500" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground leading-none mb-0.5">Practice Time Limit</div>
                    </div>
                    <PracticeTimeLimitCountdown
                      startedAt={(moto as any).startedAt ?? null}
                      timeLimitMs={(moto as any).timeLimitMs ?? null}
                      onExpire={() => { handleStatusUpdate(moto.id, "completed"); setExpandedMotoId(null); }}
                    />
                  </div>
                )}

                {/* Live leaderboard + crossing feed — shown in expanded view too */}
                {(() => {
                  const groupMemberIds: number[] = (moto as any).staggeredGroupMembers ?? [];
                  const runningPartners = groupMemberIds
                    .filter(id => id !== moto.id)
                    .map(id => (motos ?? []).find(m => m.id === id))
                    .filter((m): m is NonNullable<typeof m> => !!m && m.status === "in_progress");
                  const showMoto1 = moto.status === "in_progress";
                  const hasPartners = runningPartners.length > 0;
                  if (!showMoto1 && !hasPartners) return null;
                  return (
                    <>
                      {showMoto1 && (
                        <div className={hasPartners ? "border-t" : ""}>
                          {hasPartners && (
                            <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-widest bg-muted/30 border-b text-muted-foreground">{moto.name}</div>
                          )}
                          <div className="grid grid-cols-2 divide-x">
                            <LiveLeaderboard motoId={moto.id} />
                            <LiveCrossingsFeed motoId={moto.id} minLapTimeMs={minLapMs ?? null} />
                          </div>
                        </div>
                      )}
                      {runningPartners.map(partner => (
                        <div key={partner.id} className="border-t">
                          <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-widest bg-muted/30 border-b text-muted-foreground">{partner.name}</div>
                          <div className="grid grid-cols-2 divide-x">
                            <LiveLeaderboard motoId={partner.id} />
                            <LiveCrossingsFeed motoId={partner.id} minLapTimeMs={minLapMs ?? null} />
                          </div>
                        </div>
                      ))}
                    </>
                  );
                })()}
              </div>

              {/* Action bar */}
              <div className="p-3 bg-muted/30 border-t flex gap-2 items-center flex-wrap shrink-0">
                {moto.status === "scheduled" && (
                  <Button size="sm" onClick={() => handleStartMoto(moto)} className="font-heading uppercase text-xs">
                    <Play size={14} className="mr-1" /> {(moto as any).staggeredOrder === 1 && (moto as any).staggeredGroupId ? "Start Group" : moto.type === "practice" ? "Start Practice" : "Start Moto"}
                  </Button>
                )}
                {moto.status === "in_progress" && (
                  <Button size="sm" variant="outline" className="text-secondary border-secondary/50 font-heading uppercase text-xs" onClick={() => doFinishMoto(moto.id)}>
                    <CheckCircle size={14} className="mr-1" /> {(moto as any).staggeredOrder === 1 && (moto as any).staggeredGroupId ? "Finish Group" : moto.type === "practice" ? "Finish Practice" : "Finish Moto"}
                  </Button>
                )}
                {moto.status === "in_progress" && (
                  <Button size="sm" variant="ghost" className="text-muted-foreground font-heading uppercase text-xs" onClick={() => setRestartDialog({ open: true, motoId: moto.id, motoName: moto.name })}>
                    <RefreshCw size={14} className="mr-1" /> {moto.type === "practice" ? "Restart Practice" : "Restart Moto"}
                  </Button>
                )}

                {moto.status === "in_progress" && (
                  <form
                    className="flex items-center gap-1.5"
                    onSubmit={e => { e.preventDefault(); handleBibEntry(moto.id, getLineup(moto)); }}
                  >
                    <div className="relative">
                      <Timer size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="# + Enter"
                        value={bibInputs[moto.id] ?? ""}
                        onChange={e => setBibInputs(prev => ({ ...prev, [moto.id]: e.target.value }))}
                        className="h-8 w-36 pl-7 pr-2 rounded border border-border bg-background text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary placeholder:text-muted-foreground/50"
                      />
                    </div>
                  </form>
                )}

                {moto.type !== "practice" && moto.status === "in_progress" && (
                  <FirstPlaceCountdown motoId={moto.id} lapCount={(moto as any).lapCount} variant="inline" />
                )}
                {moto.type === "practice" && moto.status === "in_progress" && (moto as any).timeLimitMs && (
                  <PracticeTimeLimitCountdown
                    startedAt={(moto as any).startedAt ?? null}
                    timeLimitMs={(moto as any).timeLimitMs ?? null}
                    onExpire={() => { handleStatusUpdate(moto.id, "completed"); setExpandedMotoId(null); }}
                  />
                )}

                <div className="ml-auto flex gap-1.5">
                  <a href={`/live/${moto.id}`} target="_blank" rel="noopener noreferrer">
                    <Button size="sm" variant="ghost" className={`font-heading uppercase text-xs gap-1 ${moto.status === "in_progress" ? "text-primary" : "text-muted-foreground"}`}>
                      <Radio size={13} /> Live <ExternalLink size={11} />
                    </Button>
                  </a>
                  <Button size="sm" variant="ghost" className="text-muted-foreground px-2" onClick={() => copyLiveLink(moto.id)}>
                    {copiedId === moto.id ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        );
      })()}

      {/* Lap times editor */}
      {lapEditTarget && <LapTimesDialog target={lapEditTarget} onClose={() => setLapEditTarget(null)} />}

      {/* ── Start Practice Session settings ─────────────────────────────── */}
      <Dialog
        open={practiceStartDialog.open}
        onOpenChange={open => !open && setPracticeStartDialog({ open: false, moto: null, timeLimitMinutes: "" })}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-heading uppercase tracking-wider flex items-center gap-2">
              <Timer size={16} className="text-sky-500" />
              Start Practice Session
            </DialogTitle>
            {practiceStartDialog.moto && (
              <DialogDescription className="pt-1">
                <span className="font-semibold text-foreground">{practiceStartDialog.moto.name}</span>
                {practiceStartDialog.moto.raceClass ? ` · ${practiceStartDialog.moto.raceClass}` : ""}
              </DialogDescription>
            )}
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium flex items-center gap-1.5">
                Time Limit
                <span className="text-muted-foreground font-normal text-xs">(optional — minutes)</span>
              </label>
              <div className="relative">
                <Timer size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <Input
                  type="number"
                  min={1}
                  placeholder="e.g. 15"
                  value={practiceStartDialog.timeLimitMinutes}
                  onChange={e => setPracticeStartDialog(d => ({ ...d, timeLimitMinutes: e.target.value }))}
                  onKeyDown={e => { if (e.key === "Enter") doStartPractice(); }}
                  className="h-9 pl-8 w-36"
                  autoFocus
                />
              </div>
              {practiceStartDialog.timeLimitMinutes.trim() && parseFloat(practiceStartDialog.timeLimitMinutes) > 0 && (
                <p className="text-xs text-sky-600 font-medium">
                  Countdown timer: {practiceStartDialog.timeLimitMinutes} min — session auto-completes when time expires.
                </p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Leave blank to run without a timer. You can end the session manually at any time.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPracticeStartDialog({ open: false, moto: null, timeLimitMinutes: "" })}>
              Cancel
            </Button>
            <Button
              onClick={doStartPractice}
              disabled={updateMutation.isPending}
              className="font-heading uppercase tracking-wider bg-sky-600 hover:bg-sky-700 text-white"
            >
              <Play size={13} className="mr-1.5" />
              {updateMutation.isPending ? "Starting…" : "Start Practice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      {/* ── Restart Moto confirmation ───────────────────────────────────── */}
      <Dialog open={restartDialog.open} onOpenChange={open => !open && setRestartDialog({ open: false, motoId: null, motoName: "" })}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-heading uppercase tracking-wider text-destructive">
              {(() => {
                const m = (motos ?? []).find(x => x.id === restartDialog.motoId);
                return ((m as any)?.staggeredGroupMembers as number[] | undefined)?.length ? "Restart Group?" : "Restart Moto?";
              })()}
            </DialogTitle>
            <DialogDescription className="pt-1">
              {(() => {
                const m = (motos ?? []).find(x => x.id === restartDialog.motoId);
                const groupMemberIds: number[] = (m as any)?.staggeredGroupMembers ?? [];
                const groupPartners = groupMemberIds
                  .filter(id => id !== m?.id)
                  .map(id => (motos ?? []).find(x => x.id === id))
                  .filter(Boolean);
                return groupPartners.length > 0 ? (
                  <>This will clear all lap times and crossings for all {groupMemberIds.length} motos in this staggered group and restart their clocks from zero.</>
                ) : (
                  <>This will clear all lap times and crossings for <span className="font-semibold text-foreground">"{restartDialog.motoName}"</span> and restart the clock from zero.</>
                );
              })()}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">This cannot be undone. All recorded laps will be permanently deleted.</p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRestartDialog({ open: false, motoId: null, motoName: "" })}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRestartConfirm}
              className="font-heading uppercase tracking-wider"
            >
              Clear & Restart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Pool rider class mismatch confirmation ──────────────────────── */}
      <Dialog open={poolDropMismatch.open} onOpenChange={open => !open && setPoolDropMismatch(p => ({ ...p, open: false }))}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-heading uppercase tracking-wider">Class Mismatch</DialogTitle>
            <DialogDescription className="pt-1">
              <span className="font-semibold text-foreground">{poolDropMismatch.riderName}</span> is registered in{" "}
              <span className="font-semibold text-foreground">{poolDropMismatch.checkinClass}</span>, but this moto is for{" "}
              <span className="font-semibold text-foreground">{poolDropMismatch.motoClass}</span>.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Add them to this moto anyway?</p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPoolDropMismatch(p => ({ ...p, open: false }))}>
              Cancel
            </Button>
            <Button onClick={handlePoolDropMismatchConfirm} className="font-heading uppercase tracking-wider">
              Add Anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Conflict: moto or practice already in progress ──────────────── */}
      <Dialog open={conflictDialog.open} onOpenChange={open => !open && setConflictDialog({ open: false, existingMoto: null, pendingMotoId: null })}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-heading uppercase tracking-wider">
              {conflictDialog.existingMoto?.type === "practice" ? "Practice Session Running" : "Moto Already Running"}
            </DialogTitle>
            <DialogDescription className="pt-1">
              <span className="font-semibold text-foreground">"{conflictDialog.existingMoto?.name}"</span> is currently in progress.
              {" "}How would you like to start{" "}
              <span className="font-semibold text-foreground">
                "{motos?.find(m => m.id === conflictDialog.pendingMotoId)?.name ?? "new moto"}"
              </span>?
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-1">
            <button
              onClick={handleConflictStartWave}
              className="flex flex-col items-start gap-1 rounded-lg border border-primary/40 bg-primary/10 px-4 py-3 text-left hover:bg-primary/20 transition-colors"
            >
              <span className="font-heading uppercase tracking-wider text-sm text-primary">Start as New Wave</span>
              <span className="text-xs text-muted-foreground">Both motos run simultaneously. Use this for desert races and wave starts.</span>
            </button>
            <button
              onClick={handleConflictConfirm}
              disabled={updateMutation.isPending}
              className="flex flex-col items-start gap-1 rounded-lg border border-border px-4 py-3 text-left hover:bg-muted/50 transition-colors disabled:opacity-50"
            >
              <span className="font-heading uppercase tracking-wider text-sm">
                {updateMutation.isPending ? "Switching..." : conflictDialog.existingMoto?.type === "practice" ? "End Practice & Start" : "End Current & Start"}
              </span>
              <span className="text-xs text-muted-foreground">Finishes the current {conflictDialog.existingMoto?.type === "practice" ? "practice session" : "moto"} and starts the new one.</span>
            </button>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConflictDialog({ open: false, existingMoto: null, pendingMotoId: null })}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDeleteId !== null} onOpenChange={open => { if (!open) setConfirmDeleteId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading uppercase text-xl">Delete Moto?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            This will permanently remove the moto and its lineup. This cannot be undone.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => confirmDeleteId !== null && handleDelete(confirmDeleteId)}
              className="font-heading uppercase tracking-wider"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Moto"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
