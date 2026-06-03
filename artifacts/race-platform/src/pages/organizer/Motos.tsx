import { useState, useEffect, useRef, useMemo } from "react";
import { useRoute, Link } from "wouter";
import {
  useListMotos, useGenerateLineups, useUpdateMoto, useDeleteMoto,
  useGetEvent, useListCheckins, useCreateMoto, useListPointsTables, useAdvanceToMain,
  getListMotosQueryKey, getListCheckinsQueryKey, Moto,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Settings, Play, CheckCircle, Flag, RefreshCw, Radio, ExternalLink, Copy, Check, Trash2, Video, PlusCircle, Users, Zap, GripVertical, Maximize2, Timer, Search } from "lucide-react";
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

function LiveCrossingsFeed({ motoId }: { motoId: number }) {
  const [crossings, setCrossings] = useState<RawCrossing[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
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
              {crossings.map((c, idx) => (
                <TableRow key={c.id} className={`h-7 ${idx === 0 ? "bg-primary/5" : ""}`}>
                  <TableCell className="py-1 px-3 text-xs font-medium">
                    {c.riderName ?? (
                      <span className="text-muted-foreground font-mono">{c.rfidNumber}</span>
                    )}
                  </TableCell>
                  <TableCell className="py-1 text-center text-xs font-heading font-bold">{c.lapNumber}</TableCell>
                  <TableCell className="py-1 text-center text-xs font-mono">
                    {c.lapTime ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="py-1 pr-3 text-right text-xs text-muted-foreground tabular-nums">
                    {format(new Date(c.crossingTime), "h:mm:ss")}
                  </TableCell>
                  <TableCell className="py-1 pr-1 text-right">
                    <button
                      onClick={() => handleDeleteCrossing(c.id)}
                      disabled={deletingId === c.id}
                      className="text-muted-foreground/40 hover:text-destructive transition-colors disabled:opacity-40 p-0.5 rounded"
                      title="Delete crossing"
                    >
                      <Trash2 size={12} />
                    </button>
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

function DraggableRiderRow({ entry, motoId, locked, onRecordLap, lapCooldown, rowNum }: {
  entry: LineupEntry; motoId: number; locked?: boolean;
  onRecordLap?: () => void; lapCooldown?: boolean; rowNum?: number;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `rider-${motoId}-${entry.riderId}`,
    disabled: locked,
  });
  return (
    <TableRow ref={setNodeRef} className={`h-8 select-none ${isDragging ? "opacity-25" : ""}`}>
      <TableCell className="w-6 text-center text-xs text-muted-foreground font-mono select-none">{rowNum ?? ""}</TableCell>
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
      <TableCell className="font-medium">{entry.riderName}</TableCell>
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

function DroppableMotoLineup({ motoId, children, locked, className }: { motoId: number; children: React.ReactNode; locked?: boolean; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `drop-${motoId}`, disabled: locked });
  return (
    <div
      ref={setNodeRef}
      className={`border-b transition-colors ${isOver && !locked ? "bg-primary/5 ring-2 ring-inset ring-primary/30" : ""} ${className ?? "flex-1 overflow-y-auto max-h-52"}`}
    >
      {children}
    </div>
  );
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
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [expandedMotoId, setExpandedMotoId] = useState<number | null>(null);
  const [poolSearch, setPoolSearch] = useState("");
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [manualLapCooldown, setManualLapCooldown] = useState<Set<string>>(new Set());
  const [bibInputs, setBibInputs] = useState<Record<number, string>>({});

  // Drag-and-drop state
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [lineupDrafts, setLineupDrafts] = useState<Record<number, LineupEntry[]>>({});
  const [activeDrag, setActiveDrag] = useState<{ riderName: string; bibNumber?: string | null } | null>(null);

  // Manual create moto state
  const [newMotoName, setNewMotoName] = useState("");
  const [newMotoType, setNewMotoType] = useState<"heat" | "lcq" | "main" | "practice">("heat");
  const [newMotoClass, setNewMotoClass] = useState("");
  const [selectedRiderIds, setSelectedRiderIds] = useState<Set<number>>(new Set());

  const { data: event } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const { data: motos, isLoading } = useListMotos(eventId, { query: { enabled: !!eventId } as any });
  const { data: checkins } = useListCheckins(eventId, { query: { enabled: !!eventId } as any });

  const generateMutation = useGenerateLineups();
  const createMotoMutation = useCreateMoto();
  const updateMutation = useUpdateMoto();
  const deleteMutation = useDeleteMoto();
  const advanceToMainMutation = useAdvanceToMain();

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

  const handleRiderDragStart = (event: DragStartEvent) => {
    const parts = String(event.active.id).split("-");
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
    setActiveDrag(null);
    const { active, over } = event;
    if (!over) return;
    const parts = String(active.id).split("-");

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

    createMotoMutation.mutate(
      { eventId, data: { name: newMotoName.trim(), type: newMotoType, raceClass: newMotoClass, motoNumber: nextMotoNumber, lineup: lineup as any } },
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
    generateMutation.mutate(
      { eventId, data: { raceFormat: format, classes: event.raceClasses, ridersPerHeat: perHeat } },
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
                        <SelectItem value="practice">Practice</SelectItem>
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
              <Button onClick={handleGenerate} disabled={generateMutation.isPending} className="w-full font-heading uppercase">
                {generateMutation.isPending ? "Generating..." : "Generate Lineups"}
              </Button>
            </div>
          </DialogContent>
          </Dialog>
        </div>
      </div>

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

      {/* Advance to Main panel — Supercross format only */}
      {isSupercrossFormat && (motos ?? []).some(m => m.type === "main") && (
        <div className="border rounded-xl p-5 bg-card space-y-4">
          <div className="flex items-center gap-2">
            <Flag size={16} className="text-primary" />
            <h3 className="font-heading font-bold uppercase tracking-wider text-sm">Advance to Main Event</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Select how many top finishers from each heat advance to the Main Event. Auto-set to ~30% of heat size — adjust per class as needed.
          </p>
          <div className="space-y-2">
            {[...new Set((motos ?? []).filter(m => m.type === "main").map(m => m.raceClass).filter((c): c is string => !!c))].map(cls => {
              const heats = (motos ?? []).filter(m => m.type === "heat" && m.raceClass === cls);
              const completedHeats = heats.filter(m => m.status === "completed");
              const allHeatsComplete = heats.length > 0 && completedHeats.length === heats.length;
              const totalInHeats = heats.reduce((s, h) => s + ((h.lineup as any[])?.length ?? 0), 0);
              const currentVal = topPerHeatByClass[cls] ?? defaultTopPerHeat[cls] ?? 1;
              return (
                <div key={cls} className={`rounded-lg border px-4 py-3 ${allHeatsComplete ? "bg-muted/30" : "bg-muted/10 opacity-75"}`}>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-heading font-semibold text-sm uppercase tracking-wide">{cls}</div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                        <span>{completedHeats.length}/{heats.length} heat{heats.length !== 1 ? "s" : ""} complete</span>
                        <span>·</span>
                        <span>{totalInHeats} riders</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-xs text-muted-foreground whitespace-nowrap">Top</span>
                      <div className="flex items-center border rounded-md overflow-hidden bg-background">
                        <button
                          type="button"
                          className="px-2 py-1.5 text-sm font-bold hover:bg-muted transition-colors disabled:opacity-40"
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
                          className="w-10 text-center text-sm font-mono font-bold bg-transparent border-x py-1.5 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          type="button"
                          className="px-2 py-1.5 text-sm font-bold hover:bg-muted transition-colors"
                          onClick={() => setTopPerHeatByClass(p => ({ ...p, [cls]: currentVal + 1 }))}
                        >+</button>
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">per heat</span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="font-heading uppercase tracking-wider gap-1.5 shrink-0"
                      disabled={!allHeatsComplete || advanceToMainMutation.isPending}
                      title={!allHeatsComplete ? `${heats.length - completedHeats.length} heat${heats.length - completedHeats.length !== 1 ? "s" : ""} still need to be completed` : undefined}
                      onClick={() => handleAdvanceToMain(cls)}
                    >
                      <Flag size={13} />
                      Advance
                    </Button>
                  </div>
                  {!allHeatsComplete && (
                    <div className="mt-2 text-xs text-amber-600 flex items-center gap-1.5">
                      <span>⏳</span>
                      <span>
                        {heats.length - completedHeats.length} heat{heats.length - completedHeats.length !== 1 ? "s" : ""} must be completed before advancing
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
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
        {isLoading ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {[...Array(4)].map((_, i) => <Card key={i} className="h-64 animate-pulse" />)}
          </div>
        ) : motos?.length ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {motos.sort((a, b) => (a.motoNumber || 0) - (b.motoNumber || 0)).map((moto) => (
            <Card key={moto.id} className="flex flex-col h-full border-sidebar-border overflow-hidden">
              <CardHeader className="bg-sidebar text-sidebar-foreground py-3 border-b flex flex-row items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="bg-sidebar-accent text-white w-8 h-8 rounded-full flex items-center justify-center font-heading font-bold text-lg">
                    {moto.motoNumber}
                  </div>
                  <div>
                    <CardTitle className="font-heading uppercase text-lg text-white leading-tight">{moto.name}</CardTitle>
                    <div className="flex items-center gap-2 text-xs text-sidebar-foreground/70 uppercase tracking-widest">
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
                <div className="flex items-center gap-2">
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
                  <DroppableMotoLineup motoId={moto.id} locked={moto.status === "completed"}>
                    <Table>
                      <TableHeader className="bg-muted/50 sticky top-0">
                        <TableRow>
                          <TableHead className="w-6 text-center text-xs text-muted-foreground">#</TableHead>
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
                                <TableCell className="font-medium">{entry.riderName}</TableCell>
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

                {/* Live crossing feed — shown only while moto is in progress */}
                {moto.status === "in_progress" && (
                  <LiveCrossingsFeed motoId={moto.id} />
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
          ))}
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
                          <TableHead className="w-6 text-center text-xs text-muted-foreground">#</TableHead>
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
                                <TableCell className="font-medium">{entry.riderName}</TableCell>
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

                {/* Live crossing feed */}
                {moto.status === "in_progress" && (
                  <LiveCrossingsFeed motoId={moto.id} />
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
