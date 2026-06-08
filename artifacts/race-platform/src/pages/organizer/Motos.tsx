import { useState, useEffect, useRef, useMemo } from "react";
import { useRoute, Link } from "wouter";
import {
  useListMotos, useGenerateLineups, useUpdateMoto, useDeleteMoto,
  useGetEvent, useListCheckins, useCreateMoto, useListPointsTables, useAdvanceToMain,
  useUpdateEvent, useUpdateResultLaps,
  getListMotosQueryKey, getListCheckinsQueryKey, Moto,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Settings, Play, CheckCircle, Flag, RefreshCw, Radio, ExternalLink, Copy, Check, Trash2, Video, PlusCircle, Plus, Users, Zap, GripVertical, Maximize2, Timer, Search, Clock } from "lucide-react";
import {
  DndContext, DragOverlay, useDraggable, useDroppable,
  PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { useToast } from "@/hooks/use-toast";
import { LiveBroadcast } from "./LiveBroadcast";
import { format } from "date-fns";

type RawCrossing = {
  id: number;
  rfidNumber: string;
  riderName: string | null;
  lapNumber: number;
  lapTime: string | null;
  lapTimeMs: number | null;
  crossingTime: string;
  readerId: string | null;
};

const POLL_INTERVAL_MS = 3000;

function playRfidPing(count: number) {
  try {
    const ctx = new AudioContext();
    const pings = Math.min(count, 4);
    let lastOsc: OscillatorNode | null = null;
    for (let i = 0; i < pings; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = 1046;
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.start(t);
      osc.stop(t + 0.25);
      lastOsc = osc;
    }
    if (lastOsc) lastOsc.onended = () => ctx.close();
  } catch {
    // AudioContext may be blocked; ignore
  }
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
          playRfidPing(newOnes.length);
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
    <div className={`border-t transition-all duration-150 ${flash ? "ring-2 ring-primary ring-offset-0" : ""}`}>
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
                const isFlagged = minLapTimeMs != null && c.lapTimeMs != null && c.lapTimeMs < minLapTimeMs;
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

  // Find the leader: rider with highest lapNumber, tie-broken by most-recent crossingTime
  const byRider = new Map<string, RawCrossing[]>();
  for (const c of allCrossings) {
    const key = c.riderName ?? c.rfidNumber;
    if (!byRider.has(key)) byRider.set(key, []);
    byRider.get(key)!.push(c);
  }

  let leaderName = "";
  let leaderMaxLap = 0;
  let leaderLastCrossing: RawCrossing | null = null;
  let leaderLapTimes: number[] = [];

  for (const [name, crossings] of byRider) {
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
      leaderName = name;
      leaderLastCrossing = latest;
      leaderLapTimes = crossings.map(c => c.lapTimeMs).filter((v): v is number => v != null && v > 0);
    }
  }

  if (!leaderLastCrossing || leaderLapTimes.length < 2) return null;

  const avgLapMs = leaderLapTimes.reduce((a, b) => a + b, 0) / leaderLapTimes.length;
  const lastCrossingMs = new Date(leaderLastCrossing.crossingTime).getTime();

  // If lapCount known: project to finish; otherwise project to next crossing
  const remainingLaps = lapCount != null ? lapCount - leaderMaxLap : 1;
  const projectedMs = lastCrossingMs + remainingLaps * avgLapMs;
  const msUntil = projectedMs - now;
  const isOverdue = msUntil < 0;
  const isFinish = lapCount != null;
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

type LapEditTarget = { riderId: number; riderName: string; motoId: number; eventId: number };

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
              {laps.map((lap, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-8 text-xs text-muted-foreground text-right font-mono shrink-0">L{i + 1}</span>
                  <Input
                    value={lap}
                    onChange={e => setLaps(prev => { const n = [...prev]; n[i] = e.target.value; return n; })}
                    className="font-mono text-sm h-8"
                    placeholder="0:00.00"
                  />
                  <button
                    onClick={() => setLaps(prev => prev.filter((_, j) => j !== i))}
                    className="text-muted-foreground/40 hover:text-destructive transition-colors shrink-0 p-0.5"
                    title="Remove lap"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
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

function DraggableRiderRow({ entry, motoId, locked, onRecordLap, lapCooldown, rowNum, onViewLaps }: {
  entry: LineupEntry; motoId: number; locked?: boolean;
  onRecordLap?: () => void; lapCooldown?: boolean; rowNum?: number;
  onViewLaps?: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `rider-${motoId}-${entry.riderId}`,
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
      <TableCell className="font-medium">
        {onViewLaps ? (
          <button onClick={onViewLaps} className="flex items-center gap-1 hover:text-primary transition-colors group">
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
      className={`fixed right-6 top-1/2 -translate-y-1/2 z-50 flex flex-col items-center justify-center gap-2 w-20 h-20 rounded-2xl border-2 transition-all duration-150 pointer-events-auto ${
        visible ? "opacity-100 scale-100" : "opacity-0 scale-75 pointer-events-none"
      } ${
        isOver
          ? "bg-destructive border-destructive text-white shadow-xl shadow-destructive/40 scale-110"
          : "bg-background border-destructive/40 text-destructive/60 shadow-lg"
      }`}
    >
      <Trash2 size={isOver ? 28 : 22} className="transition-all" />
      <span className="text-[10px] font-heading font-bold uppercase tracking-wider leading-none">
        {isOver ? "Drop to Remove" : "Remove"}
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
  const [topPerHeatByClass, setTopPerHeatByClass] = useState<Record<string, number>>({});
  const [format, setFormat] = useState<"one_moto" | "two_moto" | "three_moto">("two_moto");
  const [ridersPerHeat, setRidersPerHeat] = useState<string>("");
  const [usePracticeSeeding, setUsePracticeSeeding] = useState(false);
  const [selectedGateConfigId, setSelectedGateConfigId] = useState<string>("");
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [expandedMotoId, setExpandedMotoId] = useState<number | null>(null);
  const [lapEditTarget, setLapEditTarget] = useState<LapEditTarget | null>(null);
  const [poolSearch, setPoolSearch] = useState("");
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [classFilter, setClassFilter] = useState<string>("schedule");
  const [manualLapCooldown, setManualLapCooldown] = useState<Set<string>>(new Set());
  const [bibInputs, setBibInputs] = useState<Record<number, string>>({});

  // Drag-and-drop state
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [lineupDrafts, setLineupDrafts] = useState<Record<number, LineupEntry[]>>({});
  const [activeDrag, setActiveDrag] = useState<{ riderName: string; bibNumber?: string | null } | null>(null);
  const [activeMotoCardDrag, setActiveMotoCardDrag] = useState<{ motoId: number; name: string } | null>(null);

  // Manual create moto state
  const [newMotoName, setNewMotoName] = useState("");
  const [newMotoType, setNewMotoType] = useState<"heat" | "lcq" | "main" | "practice">("heat");
  const [newMotoClass, setNewMotoClass] = useState("");
  const [newMotoLapCount, setNewMotoLapCount] = useState("");
  const [selectedRiderIds, setSelectedRiderIds] = useState<Set<number>>(new Set());

  // Min lap times per class
  const [minLapInputs, setMinLapInputs] = useState<Record<string, string>>({});
  const [minLapSavedClass, setMinLapSavedClass] = useState<string | null>(null);
  // Tracks which eventId the inputs have been seeded for — prevents the seed effect
  // from overwriting user input when the event query refetches after a save.
  const seededForEventIdRef = useRef<number | null>(null);
  // Single global debounce timer — one timer for ALL classes eliminates the per-class
  // concurrent-partial-payload race condition.
  const minLapDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Always-current snapshot of minLapInputs so the unmount-flush can read it synchronously.
  const minLapInputsRef = useRef(minLapInputs);
  minLapInputsRef.current = minLapInputs;
  // Set before a blur-normalization setState so the debounce effect skips the cycle
  // triggered by that state change (the blur already flushed the save immediately).
  const isBlurFlushingRef = useRef(false);
  // True while a mutation is in-flight — prevents concurrent overlapping saves.
  const isSavingRef = useRef(false);
  // Holds the latest snapshot queued while a save is in-flight; flushed when it settles.
  const pendingSaveRef = useRef<{ inputs: Record<string, string>; triggerClass: string | null } | null>(null);
  // Last snapshot successfully committed to the server. Used for change-detection instead
  // of event.minLapTimes, which may be stale before the invalidated query refetches.
  const lastCommittedRef = useRef<Record<string, number>>({});
  // Always-current eventId — used in async callbacks to detect stale cross-event saves.
  const currentEventIdRef = useRef(eventId);
  currentEventIdRef.current = eventId;

  const { data: event } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const { data: motos, isLoading } = useListMotos(eventId, { query: { enabled: !!eventId } as any });
  const { data: checkins } = useListCheckins(eventId, { query: { enabled: !!eventId } as any });
  const { data: gateConfigsData } = useQuery({
    queryKey: ["gateConfigs"],
    queryFn: async () => {
      const res = await fetch("/api/clubs/gate-settings", { credentials: "include" });
      if (!res.ok) return { gateConfigs: [] };
      return res.json() as Promise<{ gateConfigs: Array<{ id: string; name: string; gateCount: number; gatePriorities: number[] }> }>;
    },
  });
  const gateConfigs = gateConfigsData?.gateConfigs ?? [];

  const generateMutation = useGenerateLineups();
  const createMotoMutation = useCreateMoto();
  const updateMutation = useUpdateMoto();
  const deleteMutation = useDeleteMoto();
  const advanceToMainMutation = useAdvanceToMain();
  const updateEventMutation = useUpdateEvent();

  // Reset local state when the organizer navigates between events so stale values
  // from Event A never bleed into Event B's inputs.
  useEffect(() => {
    setMinLapInputs({});
    seededForEventIdRef.current = null;
    lastCommittedRef.current = {};
    pendingSaveRef.current = null;
    isSavingRef.current = false;
  }, [eventId]);

  // Seed min-lap inputs from saved event data exactly once per eventId.
  // Ref guard: fires on initial load only — not on refetches triggered by a successful
  // save — so user input still in the debounce window is never overwritten.
  useEffect(() => {
    if (!event) return;
    const currentEventId = (event as any).id as number;
    if (seededForEventIdRef.current === currentEventId) return;
    seededForEventIdRef.current = currentEventId;
    const saved = (event as any)?.minLapTimes as Record<string, number> | undefined;
    if (!saved) return;
    // Sync the committed baseline so change-detection works from day one.
    lastCommittedRef.current = { ...saved };
    setMinLapInputs(() => {
      const next: Record<string, string> = {};
      for (const [cls, ms] of Object.entries(saved)) {
        next[cls] = formatMinLapTime(ms as number);
      }
      return next;
    });
  }, [event]);

  // Always-current save function stored in a ref so timer/unmount callbacks call the
  // latest version regardless of when they fire — eliminates stale-closure risk.
  // Payload is built from ALL current inputs (never a partial per-class merge), and
  // an isUnchanged check avoids unnecessary round-trips.
  const saveMinLapRef = useRef<(inputs: Record<string, string>, triggerClass: string | null) => void>(() => {});
  saveMinLapRef.current = (inputs: Record<string, string>, triggerClass: string | null): void => {
    const newMinLapTimes: Record<string, number> = {};
    for (const [cls, raw] of Object.entries(inputs)) {
      const ms = parseMinLapTime(raw);
      if (ms != null) newMinLapTimes[cls] = ms;
    }
    // Compare against the locally-tracked committed baseline, not the query cache —
    // event.minLapTimes may still be stale before the invalidated query refetches.
    const committed = lastCommittedRef.current;
    const hasChange =
      Object.keys(newMinLapTimes).length !== Object.keys(committed).length ||
      Object.entries(newMinLapTimes).some(([cls, ms]) => committed[cls] !== ms);
    if (!hasChange) return;
    // Serialise: if a mutation is already in-flight, queue the latest snapshot and
    // return — the onSuccess/onError handler will flush it once the current one settles.
    if (isSavingRef.current) {
      pendingSaveRef.current = { inputs, triggerClass };
      return;
    }
    isSavingRef.current = true;
    // Capture the event this mutation belongs to — used in callbacks to discard
    // stale results if the organizer navigated to a different event before it settled.
    const saveEventId = eventId;
    const displayClass = triggerClass ?? Object.keys(inputs)[0] ?? null;
    const flushPending = () => {
      isSavingRef.current = false;
      if (pendingSaveRef.current) {
        const pending = pendingSaveRef.current;
        pendingSaveRef.current = null;
        saveMinLapRef.current(pending.inputs, pending.triggerClass);
      }
    };
    updateEventMutation.mutate(
      { eventId, data: { minLapTimes: newMinLapTimes } },
      {
        onSuccess: () => {
          // Guard: if the user navigated to a different event before this settled,
          // discard all side-effects (refs already reset by the eventId change effect).
          if (saveEventId !== currentEventIdRef.current) return;
          lastCommittedRef.current = { ...newMinLapTimes };
          queryClient.invalidateQueries({ queryKey: ["getEvent", eventId] as any });
          if (displayClass) {
            setMinLapSavedClass(displayClass);
            setTimeout(() => setMinLapSavedClass(null), 2000);
          }
          flushPending();
        },
        onError: () => {
          if (saveEventId !== currentEventIdRef.current) return;
          flushPending();
        },
      }
    );
  };

  // On blur: normalize display, cancel debounce, flush save immediately.
  // Using isBlurFlushingRef to signal the debounce effect so the re-render caused
  // by the normalization setState doesn't re-arm a second timer (no double-send).
  const handleMinLapBlur = (cls: string) => {
    const raw = minLapInputs[cls] ?? "";
    const ms = parseMinLapTime(raw);
    const formatted = ms != null ? formatMinLapTime(ms) : raw;
    const normalizedInputs = { ...minLapInputs, [cls]: formatted };
    // Only update state if the string actually changes (avoids a spurious debounce
    // cycle when the display value is already in normalized form).
    if (formatted !== raw) {
      isBlurFlushingRef.current = true;
      setMinLapInputs(normalizedInputs);
    }
    if (minLapDebounceTimer.current) {
      clearTimeout(minLapDebounceTimer.current);
      minLapDebounceTimer.current = null;
    }
    saveMinLapRef.current(normalizedInputs, cls);
  };

  // Debounced save-on-change — single global timer reset on every keystroke.
  // Fires 600 ms after the user stops typing, persisting values even when the
  // organizer navigates away without touching blur.
  useEffect(() => {
    // Skip the cycle triggered by blur-normalization setState — blur already flushed.
    if (isBlurFlushingRef.current) {
      isBlurFlushingRef.current = false;
      return;
    }
    if (minLapDebounceTimer.current) clearTimeout(minLapDebounceTimer.current);
    const snapInputs = { ...minLapInputs }; // stable snapshot for this timer window
    minLapDebounceTimer.current = setTimeout(() => {
      saveMinLapRef.current(snapInputs, null);
    }, 600);
    return () => {
      if (minLapDebounceTimer.current) clearTimeout(minLapDebounceTimer.current);
    };
  }, [minLapInputs]);

  // On unmount (navigate away): cancel any pending timer and flush immediately so
  // values typed without blur are never lost.
  useEffect(() => {
    return () => {
      if (minLapDebounceTimer.current) {
        clearTimeout(minLapDebounceTimer.current);
        minLapDebounceTimer.current = null;
      }
      saveMinLapRef.current(minLapInputsRef.current, null);
    };
  }, []); // empty deps — cleanup runs only on unmount

  const { data: pointsTables } = useListPointsTables({ query: {} as any });
  const eventScoringTable = (pointsTables ?? []).find(t => t.id === (event as any)?.scoringTableId);
  const isSupercrossFormat = eventScoringTable?.mainEventOnly === true;

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
    const typeLabel = sourceMoto.type === "heat" ? (isSupercrossFormat ? "Heat" : "Division")
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
      const typeLabel = type === "heat" ? (isSupercrossFormat ? "Heat" : "Division")
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
      queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
      toast({ title: "✅ Order updated" });
    } catch {
      toast({ title: "Failed to reorder", variant: "destructive" });
    }
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
      return;
    }
    if (parts[0] !== "rider") return;
    const motoId = parseInt(parts[1]);
    const riderId = parseInt(parts[2]);
    const moto = motos?.find(m => m.id === motoId);
    if (!moto) return;
    const entry = getLineup(moto).find(e => e.riderId === riderId);
    setActiveDrag(entry ? { riderName: entry.riderName, bibNumber: entry.bibNumber } : null);
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

    if (parts[0] !== "rider") return;
    const sourceMotoId = parseInt(parts[1]);
    const riderId = parseInt(parts[2]);

    // ── Trash drop: remove rider from lineup ──────────────────────────────────
    if (String(over.id) === "drop-trash") {
      const sourceMoto = motos?.find(m => m.id === sourceMotoId);
      if (!sourceMoto || sourceMoto.status === "completed") return;
      const srcLineup = getLineup(sourceMoto);
      const riderEntry = srcLineup.find(e => e.riderId === riderId);
      if (!riderEntry) return;
      const newLineup = srcLineup
        .filter(e => e.riderId !== riderId)
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
    const riderEntry = srcLineup.find(e => e.riderId === riderId);
    if (!riderEntry) return;
    const newSrc = srcLineup
      .filter(e => e.riderId !== riderId)
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
    setSelectedRiderIds(new Set());
  };

  const handleCreateMoto = () => {
    if (!newMotoName.trim() || !newMotoClass) return;
    const nextMotoNumber = motos?.length ? Math.max(...motos.map(m => m.motoNumber ?? 0)) + 1 : 1;
    const lineup = classCheckins
      .filter(c => selectedRiderIds.has(c.riderId))
      .map((c, i) => ({
        position: i + 1,
        riderId: c.riderId,
        riderName: c.riderName,
        bibNumber: c.bibNumber || c.registrationBib || null,
        rfidNumber: c.rfidNumber || null,
      }));

    const lapCountNum = newMotoLapCount.trim() ? parseInt(newMotoLapCount.trim(), 10) : undefined;
    createMotoMutation.mutate(
      { eventId, data: { name: newMotoName.trim(), type: newMotoType, raceClass: newMotoClass, motoNumber: nextMotoNumber, lineup: lineup as any, lapCount: lapCountNum } },
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
    const perHeat = ridersPerHeat.trim() ? parseInt(ridersPerHeat, 10) : undefined;
    const gateConfigId = usePracticeSeeding && selectedGateConfigId ? selectedGateConfigId : undefined;
    generateMutation.mutate(
      { eventId, data: { raceFormat: format, classes: event.raceClasses, ridersPerHeat: perHeat, usePracticeSeeding, gateConfigId } as any },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setIsGenerateOpen(false);
          toast({ title: "Lineups generated" });
        },
        onError: (err) => {
          toast({ title: "Failed to generate", description: err.message, variant: "destructive" });
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

  // Auto-seed topPerHeatByClass from motos data: 30% of avg heat lineup size per class
  const defaultTopPerHeat = useMemo(() => {
    const result: Record<string, number> = {};
    const mainClasses = [...new Set((motos ?? []).filter(m => m.type === "main").map(m => m.raceClass).filter((c): c is string => !!c))];
    for (const cls of mainClasses) {
      const heats = (motos ?? []).filter(m => m.type === "heat" && m.raceClass === cls);
      const totalRiders = heats.reduce((sum, h) => sum + ((h.lineup as any[])?.length ?? 0), 0);
      const avg = heats.length > 0 ? totalRiders / heats.length : 0;
      result[cls] = Math.max(1, Math.round(avg * 0.3));
    }
    return result;
  }, [motos]);

  useEffect(() => {
    setTopPerHeatByClass(prev => {
      const next = { ...prev };
      for (const [cls, val] of Object.entries(defaultTopPerHeat)) {
        if (next[cls] === undefined) next[cls] = val;
      }
      return next;
    });
  }, [defaultTopPerHeat]);

  const handleAdvanceToMain = (raceClass: string) => {
    const topPerHeat = topPerHeatByClass[raceClass] ?? defaultTopPerHeat[raceClass] ?? 3;
    advanceToMainMutation.mutate(
      { eventId, data: { raceClass, topPerHeat } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          toast({ title: `✅ Riders advanced to ${raceClass} Main Event` });
        },
        onError: (err) => {
          toast({ title: "Failed to advance riders", description: err.message, variant: "destructive" });
        },
      }
    );
  };

  const handleStatusUpdate = (motoId: number, status: string) => {
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

  const handleStartMoto = (moto: Moto) => {
    updateMutation.mutate(
      { motoId: moto.id, data: { status: "in_progress" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          toast({ title: `🏁 Moto started — ${(event as any)?.timingTechnology === "mylaps" ? "MyLaps" : "RFID"} timing active` });
        },
      }
    );
  };

  const copyLiveLink = (motoId: number) => {
    const url = `${window.location.origin}/live/${motoId}`;
    navigator.clipboard.writeText(url);
    setCopiedId(motoId);
    setTimeout(() => setCopiedId(null), 2000);
    toast({ title: "Live timing link copied" });
  };

  const handleManualLap = async (riderId: number, motoId: number) => {
    const key = `${motoId}-${riderId}`;
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
      toast({ title: `Bib #${raw} not found in this lineup`, variant: "destructive" });
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
                    <Select value={newMotoType} onValueChange={(v: any) => setNewMotoType(v)}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="heat">Heat</SelectItem>
                        <SelectItem value="lcq">LCQ</SelectItem>
                        <SelectItem value="main">Main</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Race Class</label>
                    <Select
                      value={newMotoClass}
                      onValueChange={v => { setNewMotoClass(v); setSelectedRiderIds(new Set()); }}
                    >
                      <SelectTrigger className="h-9"><SelectValue placeholder="Select class" /></SelectTrigger>
                      <SelectContent>
                        {(event?.raceClasses ?? []).map(cls => (
                          <SelectItem key={cls} value={cls}>{cls}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Lap count */}
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

                {/* Rider picker */}
                <div className="space-y-2">
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
                </div>
              </div>

              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => { setIsCreateOpen(false); resetCreateDialog(); }}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreateMoto}
                  disabled={createMotoMutation.isPending || !newMotoName.trim() || !newMotoClass}
                  className="font-heading uppercase tracking-wider"
                >
                  {createMotoMutation.isPending ? "Creating..." : "Create Moto"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Auto generate */}
          <Dialog open={isGenerateOpen} onOpenChange={setIsGenerateOpen}>
            <DialogTrigger asChild>
              <Button className="font-heading uppercase tracking-wider">
                <Settings size={16} className="mr-2" /> Generate Lineups
              </Button>
            </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-heading uppercase text-xl">Generate Lineups</DialogTitle>
            </DialogHeader>
            <div className="space-y-6 py-4">
              {isSupercrossFormat ? (
                <p className="text-sm text-muted-foreground">
                  <span className="font-semibold text-foreground">Supercross format:</span> Heat motos and an empty Main Event will be created per class. Use <span className="font-semibold">Advance to Main</span> after heats to populate the Main Event lineup.
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Generates Division motos based on checked-in riders for all classes.
                  </p>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Divisions per Class</label>
                    <Select value={format} onValueChange={(v: any) => setFormat(v)}>
                      <SelectTrigger><SelectValue placeholder="Select Format" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="one_moto">1 Division</SelectItem>
                        <SelectItem value="two_moto">2 Divisions</SelectItem>
                        <SelectItem value="three_moto">3 Divisions</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  {isSupercrossFormat ? "Max Riders per Heat" : "Group Size (optional)"}
                </label>
                <Input
                  type="number"
                  min={1}
                  value={ridersPerHeat}
                  onChange={e => setRidersPerHeat(e.target.value)}
                  placeholder="No limit (all in one group)"
                  className="h-9"
                />
                <p className="text-xs text-muted-foreground">
                  {isSupercrossFormat
                    ? "If a class exceeds this number, additional heats are created automatically."
                    : "If a class exceeds this number, riders are split into separate groups."}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 px-4 py-3 space-y-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={usePracticeSeeding}
                    onChange={e => {
                      setUsePracticeSeeding(e.target.checked);
                      if (!e.target.checked) setSelectedGateConfigId("");
                      else if (gateConfigs.length > 0 && !selectedGateConfigId) setSelectedGateConfigId(gateConfigs[0].id);
                    }}
                    className="h-4 w-4 rounded accent-primary"
                  />
                  <span className="text-sm font-medium">Use practice lap seeding</span>
                </label>
                <p className="text-xs text-muted-foreground pl-7">
                  Distributes riders into groups by best practice lap time (serpentine seeding) and assigns starting gates in order of speed. Requires gate settings to be configured.
                </p>
                {usePracticeSeeding && gateConfigs.length === 0 && (
                  <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5 ml-7">
                    No gate configs found — set them up on the Gate Assignments page first.
                  </p>
                )}
                {usePracticeSeeding && gateConfigs.length > 1 && (
                  <div className="pl-7 space-y-1">
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Gate Config</label>
                    <Select
                      value={selectedGateConfigId || gateConfigs[0]?.id || ""}
                      onValueChange={setSelectedGateConfigId}
                    >
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue placeholder="Select gate config…" />
                      </SelectTrigger>
                      <SelectContent>
                        {gateConfigs.map(cfg => (
                          <SelectItem key={cfg.id} value={cfg.id}>
                            {cfg.name} <span className="text-muted-foreground ml-1">({cfg.gateCount} gates)</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {usePracticeSeeding && gateConfigs.length === 1 && (
                  <p className="text-xs text-muted-foreground pl-7">
                    Using: <span className="font-medium">{gateConfigs[0].name}</span> ({gateConfigs[0].gateCount} gates)
                  </p>
                )}
              </div>
              <Button onClick={handleGenerate} disabled={generateMutation.isPending} className="w-full font-heading uppercase">
                {generateMutation.isPending ? "Generating..." : "Generate Lineups"}
              </Button>
            </div>
          </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Settings row — Minimum Lap Times + Advance to Main side by side */}
      {(((event as any)?.raceClasses as string[] | undefined)?.length || (isSupercrossFormat && (motos ?? []).some(m => m.type === "main"))) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">

          {/* Minimum Lap Times — compact */}
          {((event as any)?.raceClasses as string[] | undefined)?.length ? (
            <div className="border rounded-lg bg-card overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
                <Timer size={13} className="text-muted-foreground shrink-0" />
                <h3 className="font-heading font-bold uppercase tracking-wider text-xs">Minimum Lap Times</h3>
                <span className="text-[10px] text-muted-foreground font-normal hidden sm:inline">— flags short laps red</span>
              </div>
              <div className="px-3 py-2 grid grid-cols-2 gap-2">
                {((event as any)?.raceClasses as string[]).map(cls => {
                  const saved = ((event as any)?.minLapTimes as Record<string, number> | undefined)?.[cls];
                  const isSaved = minLapSavedClass === cls;
                  return (
                    <div key={cls} className="space-y-1">
                      <label className="text-[10px] font-medium text-muted-foreground truncate block" title={cls}>{cls}</label>
                      <div className="relative">
                        <Input
                          value={minLapInputs[cls] ?? ""}
                          onChange={e => setMinLapInputs(prev => ({ ...prev, [cls]: e.target.value }))}
                          onBlur={() => handleMinLapBlur(cls)}
                          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          placeholder={saved ? formatMinLapTime(saved) : "m:ss"}
                          className="h-7 text-xs font-mono pr-7"
                        />
                        <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
                          {isSaved ? (
                            <Check size={11} className="text-green-500" />
                          ) : (minLapInputs[cls] ?? "").trim() === "" && !saved ? null : (
                            <span className="text-[9px] text-muted-foreground">m:ss</span>
                          )}
                        </div>
                      </div>
                      {saved && (
                        <div className="text-[9px] text-muted-foreground">✓ {formatMinLapTime(saved)}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : <div />}

          {/* Advance to Main — compact, Supercross only */}
          {isSupercrossFormat && (motos ?? []).some(m => m.type === "main") ? (
            <div className="border rounded-lg bg-card overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
                <Flag size={13} className="text-primary shrink-0" />
                <h3 className="font-heading font-bold uppercase tracking-wider text-xs">Advance to Main Event</h3>
              </div>
              <div className="px-3 py-2 space-y-1.5">
                {[...new Set((motos ?? []).filter(m => m.type === "main").map(m => m.raceClass).filter((c): c is string => !!c))].map(cls => {
                  const heats = (motos ?? []).filter(m => m.type === "heat" && m.raceClass === cls);
                  const completedHeats = heats.filter(m => m.status === "completed");
                  const allHeatsComplete = heats.length > 0 && completedHeats.length === heats.length;
                  const totalInHeats = heats.reduce((s, h) => s + ((h.lineup as any[])?.length ?? 0), 0);
                  const currentVal = topPerHeatByClass[cls] ?? defaultTopPerHeat[cls] ?? 1;
                  return (
                    <div key={cls} className={`rounded-md border px-2.5 py-2 ${allHeatsComplete ? "bg-muted/30" : "bg-muted/10 opacity-75"}`}>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-heading font-semibold text-xs uppercase tracking-wide truncate">{cls}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {completedHeats.length}/{heats.length} heats · {totalInHeats} riders
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-[10px] text-muted-foreground">Top</span>
                          <div className="flex items-center border rounded overflow-hidden bg-background">
                            <button
                              type="button"
                              className="px-1.5 py-1 text-xs font-bold hover:bg-muted transition-colors disabled:opacity-40"
                              disabled={currentVal <= 1}
                              onClick={() => setTopPerHeatByClass(p => ({ ...p, [cls]: Math.max(1, currentVal - 1) }))}
                            >−</button>
                            <input
                              type="number"
                              min={1}
                              max={totalInHeats || 99}
                              value={currentVal}
                              onChange={e => {
                                const v = parseInt(e.target.value, 10);
                                if (!isNaN(v) && v >= 1) setTopPerHeatByClass(p => ({ ...p, [cls]: v }));
                              }}
                              className="w-8 text-center text-xs font-mono font-bold bg-transparent border-x py-1 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            />
                            <button
                              type="button"
                              className="px-1.5 py-1 text-xs font-bold hover:bg-muted transition-colors"
                              onClick={() => setTopPerHeatByClass(p => ({ ...p, [cls]: currentVal + 1 }))}
                            >+</button>
                          </div>
                          <span className="text-[10px] text-muted-foreground">/ heat</span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="font-heading uppercase tracking-wider gap-1 shrink-0 h-7 text-xs px-2"
                          disabled={!allHeatsComplete || advanceToMainMutation.isPending}
                          title={!allHeatsComplete ? `${heats.length - completedHeats.length} heat(s) must be completed first` : undefined}
                          onClick={() => handleAdvanceToMain(cls)}
                        >
                          <Flag size={11} />
                          Go
                        </Button>
                      </div>
                      {!allHeatsComplete && (
                        <div className="mt-1 text-[10px] text-amber-600 flex items-center gap-1">
                          <span>⏳</span>
                          <span>{heats.length - completedHeats.length} heat(s) must finish first</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : <div />}

        </div>
      )}

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

      <DndContext sensors={sensors} onDragStart={handleRiderDragStart} onDragEnd={handleRiderDragEnd}>
      <div className="flex gap-5 items-start">

        {/* ── Left: Rider Pool ─────────────────────────────────────────── */}
        <div className="w-60 shrink-0 space-y-3 sticky top-4">
          <div>
            <h3 className="font-heading font-bold uppercase tracking-wider text-sm flex items-center gap-1.5">
              <Users size={13} /> Rider Pool
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">Drag to trash to remove from check-in</p>
          </div>
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
                <Card key={cls} className="overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 bg-muted/50 border-b">
                    <span className="font-heading font-bold text-xs uppercase tracking-wider truncate mr-2">{cls}</span>
                    <Badge variant="secondary" className="text-xs h-5 shrink-0">{sorted.length}</Badge>
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
        </div>

        {/* ── Right: motos grid / loading / empty state ─────────────── */}
        <div className="flex-1 min-w-0">

        {/* Class filter bar */}
        {!isLoading && !!motos?.filter(m => m.type !== "practice").length && (() => {
          const uniqueClasses = [...new Set(
            (motos ?? []).filter(m => m.type !== "practice").map(m => m.raceClass).filter((c): c is string => !!c)
          )].sort();
          return (
            <div className="flex flex-wrap gap-2 mb-4">
              <button
                onClick={() => setClassFilter("schedule")}
                className={`px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider border transition-colors ${
                  classFilter === "schedule"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted text-muted-foreground border-border hover:bg-muted/80"
                }`}
              >
                Schedule
              </button>
              {uniqueClasses.map(cls => (
                <button
                  key={cls}
                  onClick={() => setClassFilter(cls)}
                  className={`px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider border transition-colors ${
                    classFilter === cls
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted text-muted-foreground border-border hover:bg-muted/80"
                  }`}
                >
                  {cls}
                </button>
              ))}
            </div>
          );
        })()}

        {isLoading ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {[...Array(4)].map((_, i) => <Card key={i} className="h-64 animate-pulse" />)}
          </div>
        ) : motos?.filter(m => m.type !== "practice").length ? (
        <div className="space-y-0">
          {motos.filter(m => m.type !== "practice" && (classFilter === "schedule" || m.raceClass === classFilter)).sort((a, b) => (a.motoNumber || 0) - (b.motoNumber || 0)).map((moto) => (
            <div key={moto.id}>
              <DroppableMotoSlot id={`moto-slot-${moto.id}`} active={!!activeMotoCardDrag && activeMotoCardDrag.motoId !== moto.id} />
            <Card className="flex flex-col h-full border-sidebar-border overflow-hidden">
              <CardHeader className="bg-sidebar text-sidebar-foreground py-3 border-b flex flex-row items-center justify-between gap-2">
                <DraggableMotoGrip motoId={moto.id} disabled={classFilter !== "schedule" || moto.status === "in_progress" || moto.status === "completed"} />
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="bg-sidebar-accent text-white w-8 h-8 rounded-full flex items-center justify-center font-heading font-bold text-lg shrink-0">
                    {moto.motoNumber}
                  </div>
                  <div className="min-w-0">
                    <CardTitle className="font-heading uppercase text-lg text-white leading-tight truncate">{moto.name}</CardTitle>
                    <div className="flex items-center gap-2 text-xs text-sidebar-foreground/70 uppercase tracking-widest">
                      <span className="truncate">{moto.raceClass}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider border shrink-0 ${
                        moto.type === "main"
                          ? "bg-primary/30 text-primary border-primary/40"
                          : "bg-white/10 text-sidebar-foreground/80 border-white/20"
                      }`}>
                        {moto.type === "main" ? "Main Event" : isSupercrossFormat ? "Heat" : "Division"}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className={`px-2 py-1 rounded text-xs font-bold uppercase tracking-wider border ${
                    moto.status === "in_progress" ? "bg-primary/20 text-primary border-primary/30 animate-pulse" :
                    moto.status === "completed" ? "bg-secondary/20 text-secondary border-secondary/30" :
                    "bg-sidebar-accent text-sidebar-foreground/80 border-transparent"
                  }`}>
                    {moto.status === "in_progress" && (
                      <span className="inline-block w-1.5 h-1.5 bg-primary rounded-full mr-1 animate-ping" />
                    )}
                    {moto.status.replace("_", " ")}
                  </span>
                  <button
                    onClick={() => handleQuickAddHeat(moto)}
                    disabled={createMotoMutation.isPending}
                    className="text-sidebar-foreground/50 hover:text-green-400 transition-colors p-1 rounded hover:bg-white/10 disabled:opacity-40"
                    title={`Add another ${moto.type === "main" ? "main" : isSupercrossFormat ? "heat" : "division"} for ${moto.raceClass}`}
                  >
                    <Plus size={14} />
                  </button>
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
                {/* Lineup table */}
                {moto.type === "heat" ? (
                  <DroppableMotoLineup motoId={moto.id} locked={moto.status === "completed"} disableDrop={!!activeMotoCardDrag}>
                    <Table>
                      <TableHeader className="bg-muted/50 sticky top-0">
                        <TableRow>
                          <TableHead className="w-12 text-center text-xs font-bold uppercase tracking-wider">Gate</TableHead>
                          <TableHead className="w-8 text-center text-xs" title={moto.status === "completed" ? "Lineup locked" : "Drag to move rider"}>
                            <GripVertical size={12} className={`mx-auto ${moto.status === "completed" ? "text-muted-foreground/30" : "text-muted-foreground"}`} />
                          </TableHead>
                          <TableHead className="text-xs">Rider</TableHead>
                          <TableHead className="w-16 text-center text-xs">Bib</TableHead>
                          <TableHead className="w-20 text-center text-xs">RFID</TableHead>
                          {moto.status === "in_progress" && <TableHead className="w-24" />}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {getLineup(moto).length > 0 ? (
                          getLineup(moto).map((entry, idx) => (
                            <DraggableRiderRow
                              key={entry.riderId} entry={entry} motoId={moto.id} locked={moto.status === "completed"}
                              onRecordLap={moto.status === "in_progress" ? () => handleManualLap(entry.riderId, moto.id) : undefined}
                              lapCooldown={manualLapCooldown.has(`${moto.id}-${entry.riderId}`)}
                              rowNum={idx + 1}
                              onViewLaps={moto.status === "completed" ? () => setLapEditTarget({ riderId: entry.riderId, riderName: entry.riderName, motoId: moto.id, eventId }) : undefined}
                            />
                          ))
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
                ) : (
                  <div className="flex-1 overflow-y-auto max-h-52 border-b">
                    <Table>
                      <TableHeader className="bg-muted/50 sticky top-0">
                        <TableRow>
                          <TableHead className="w-12 text-center text-xs">Gate</TableHead>
                          <TableHead className="text-xs">Rider</TableHead>
                          <TableHead className="w-16 text-center text-xs">Bib</TableHead>
                          <TableHead className="w-20 text-center text-xs">RFID</TableHead>
                          {moto.status === "in_progress" && <TableHead className="w-24" />}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {moto.lineup && moto.lineup.length > 0 ? (
                          (moto.lineup as LineupEntry[]).map((entry) => {
                            const cooldown = manualLapCooldown.has(`${moto.id}-${entry.riderId}`);
                            return (
                              <TableRow key={entry.riderId} className="h-8">
                                <TableCell className="text-center font-heading font-bold">{entry.position}</TableCell>
                                <TableCell className="font-medium">
                                  {moto.status === "completed" ? (
                                    <button onClick={() => setLapEditTarget({ riderId: entry.riderId, riderName: entry.riderName, motoId: moto.id, eventId })} className="flex items-center gap-1 hover:text-primary transition-colors group">
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
                                  <TableCell className="pr-2 text-right">
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
                                      {cooldown ? "Recorded" : "Lap"}
                                    </button>
                                  </TableCell>
                                )}
                              </TableRow>
                            );
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
                  </div>
                )}

                {/* First place finish countdown — hidden when expanded dialog is open (dialog has its own instance) */}
                {moto.status === "in_progress" && expandedMotoId !== moto.id && (
                  <FirstPlaceCountdown motoId={moto.id} lapCount={(moto as any).lapCount} />
                )}

                {/* Live crossing feed — hidden when expanded dialog is open to prevent double pings */}
                {moto.status === "in_progress" && expandedMotoId !== moto.id && (
                  <LiveCrossingsFeed
                    motoId={moto.id}
                    minLapTimeMs={moto.raceClass ? ((event as any)?.minLapTimes as Record<string, number> | undefined)?.[moto.raceClass] ?? null : null}
                  />
                )}

                {/* Action bar */}
                <div className="p-3 bg-muted/30 flex gap-2 items-center flex-wrap">
                  {moto.status === "scheduled" && (
                    <Button size="sm" onClick={() => handleStartMoto(moto)} className="font-heading uppercase text-xs">
                      <Play size={14} className="mr-1" /> Start Moto
                    </Button>
                  )}
                  {moto.status === "in_progress" && (
                    <Button size="sm" variant="outline" className="text-secondary border-secondary/50 font-heading uppercase text-xs" onClick={() => handleStatusUpdate(moto.id, "completed")}>
                      <CheckCircle size={14} className="mr-1" /> Finish Moto
                    </Button>
                  )}
                  {moto.status === "completed" && (
                    <Button size="sm" variant="ghost" className="text-muted-foreground font-heading uppercase text-xs" onClick={() => handleStatusUpdate(moto.id, "in_progress")}>
                      <RefreshCw size={14} className="mr-1" /> Reopen
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
                          placeholder="Bib #"
                          value={bibInputs[moto.id] ?? ""}
                          onChange={e => setBibInputs(prev => ({ ...prev, [moto.id]: e.target.value }))}
                          className="h-7 w-20 pl-6 pr-2 rounded border border-border bg-background text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary placeholder:text-muted-foreground/60"
                        />
                      </div>
                    </form>
                  )}

                  {moto.status === "in_progress" && (
                    <FirstPlaceCountdown motoId={moto.id} lapCount={(moto as any).lapCount} variant="inline" />
                  )}

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
        ) : (
          <Card>
            <CardContent className="p-16 text-center">
              <Flag className="mx-auto text-muted-foreground opacity-20 mb-4" size={48} />
              <h3 className="text-xl font-heading font-bold mb-2">No Motos Generated</h3>
              <p className="text-muted-foreground mb-6">Generate lineups to create heats and main events for this race.</p>
              <Button onClick={() => setIsGenerateOpen(true)} className="font-heading uppercase tracking-wider">
                Generate Lineups
              </Button>
            </CardContent>
          </Card>
        )}
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
                          : "bg-white/10 text-sidebar-foreground/80 border-white/20"
                      }`}>
                        {moto.type === "main" ? "Main Event" : isSupercrossFormat ? "Heat" : "Division"}
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
                  <DroppableMotoLineup motoId={moto.id} locked={moto.status === "completed"} className="flex-1">
                    <Table>
                      <TableHeader className="bg-muted/50 sticky top-0 z-10">
                        <TableRow>
                          <TableHead className="w-12 text-center text-xs font-bold uppercase tracking-wider">Gate</TableHead>
                          <TableHead className="w-8 text-center text-xs" title={moto.status === "completed" ? "Lineup locked" : "Drag to move rider"}>
                            <GripVertical size={12} className={`mx-auto ${moto.status === "completed" ? "text-muted-foreground/30" : "text-muted-foreground"}`} />
                          </TableHead>
                          <TableHead className="text-xs">Rider</TableHead>
                          <TableHead className="w-16 text-center text-xs">Bib</TableHead>
                          <TableHead className="w-20 text-center text-xs">RFID</TableHead>
                          {moto.status === "in_progress" && <TableHead className="w-28 text-xs text-right pr-3">Manual Lap</TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {getLineup(moto).length > 0 ? (
                          getLineup(moto).map((entry, idx) => (
                            <DraggableRiderRow
                              key={entry.riderId} entry={entry} motoId={moto.id} locked={moto.status === "completed"}
                              onRecordLap={moto.status === "in_progress" ? () => handleManualLap(entry.riderId, moto.id) : undefined}
                              lapCooldown={manualLapCooldown.has(`${moto.id}-${entry.riderId}`)}
                              rowNum={idx + 1}
                              onViewLaps={moto.status === "completed" ? () => setLapEditTarget({ riderId: entry.riderId, riderName: entry.riderName, motoId: moto.id, eventId }) : undefined}
                            />
                          ))
                        ) : (
                          <TableRow>
                            <TableCell colSpan={moto.status === "in_progress" ? 5 : 4} className="text-center py-6 text-muted-foreground text-sm">No lineup generated</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </DroppableMotoLineup>
                ) : (
                  <div className="flex-1 border-b">
                    <Table>
                      <TableHeader className="bg-muted/50 sticky top-0 z-10">
                        <TableRow>
                          <TableHead className="w-12 text-center text-xs">Gate</TableHead>
                          <TableHead className="text-xs">Rider</TableHead>
                          <TableHead className="w-16 text-center text-xs">Bib</TableHead>
                          <TableHead className="w-20 text-center text-xs">RFID</TableHead>
                          {moto.status === "in_progress" && <TableHead className="w-28 text-xs text-right pr-3">Manual Lap</TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {moto.lineup && moto.lineup.length > 0 ? (
                          (moto.lineup as LineupEntry[]).map((entry) => {
                            const cooldown = manualLapCooldown.has(`${moto.id}-${entry.riderId}`);
                            return (
                              <TableRow key={entry.riderId} className="h-9">
                                <TableCell className="text-center font-heading font-bold">{entry.position}</TableCell>
                                <TableCell className="font-medium">
                                  {moto.status === "completed" ? (
                                    <button onClick={() => setLapEditTarget({ riderId: entry.riderId, riderName: entry.riderName, motoId: moto.id, eventId })} className="flex items-center gap-1 hover:text-primary transition-colors group">
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

                {/* First place finish countdown */}
                {moto.status === "in_progress" && (
                  <FirstPlaceCountdown motoId={moto.id} lapCount={(moto as any).lapCount} />
                )}

                {/* Live crossing feed */}
                {moto.status === "in_progress" && (
                  <LiveCrossingsFeed
                    motoId={moto.id}
                    minLapTimeMs={moto.raceClass ? ((event as any)?.minLapTimes as Record<string, number> | undefined)?.[moto.raceClass] ?? null : null}
                  />
                )}
              </div>

              {/* Action bar */}
              <div className="p-3 bg-muted/30 border-t flex gap-2 items-center flex-wrap shrink-0">
                {moto.status === "scheduled" && (
                  <Button size="sm" onClick={() => handleStartMoto(moto)} className="font-heading uppercase text-xs">
                    <Play size={14} className="mr-1" /> Start Moto
                  </Button>
                )}
                {moto.status === "in_progress" && (
                  <Button size="sm" variant="outline" className="text-secondary border-secondary/50 font-heading uppercase text-xs" onClick={() => handleStatusUpdate(moto.id, "completed")}>
                    <CheckCircle size={14} className="mr-1" /> Finish Moto
                  </Button>
                )}
                {moto.status === "completed" && (
                  <Button size="sm" variant="ghost" className="text-muted-foreground font-heading uppercase text-xs" onClick={() => handleStatusUpdate(moto.id, "in_progress")}>
                    <RefreshCw size={14} className="mr-1" /> Reopen
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
                        placeholder="Bib # + Enter"
                        value={bibInputs[moto.id] ?? ""}
                        onChange={e => setBibInputs(prev => ({ ...prev, [moto.id]: e.target.value }))}
                        className="h-8 w-36 pl-7 pr-2 rounded border border-border bg-background text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary placeholder:text-muted-foreground/50"
                      />
                    </div>
                  </form>
                )}

                {moto.status === "in_progress" && (
                  <FirstPlaceCountdown motoId={moto.id} lapCount={(moto as any).lapCount} variant="inline" />
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

      {/* Delete confirmation dialog */}
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
