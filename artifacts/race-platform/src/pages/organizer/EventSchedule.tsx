import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useParams, Link } from "wouter";
import {
  useListMotos, useReorderMotos, useUpdateMoto, useCreateMoto,
  useListCheckins, useGenerateLineups, useGetEvent, useListPointsTables,
  useUpdateEvent, useAdvanceToMain,
  getListMotosQueryKey, getListCheckinsQueryKey, type Moto,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import {
  DndContext, DragOverlay, closestCenter,
  PointerSensor, useSensor, useSensors,
  useDraggable,
  type DragEndEvent, type DragStartEvent, type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  GripVertical, Plus, Clock, LayoutList, LayoutGrid, Flag, ExternalLink,
  Users, Search, Settings, ChevronLeft, ChevronRight, Pencil, Timer, Check, X,
} from "lucide-react";

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function typeBadgeVariant(type: string): string {
  switch (type) {
    case "practice": return "bg-blue-500/20 text-blue-300 border-blue-500/30";
    case "heat":     return "bg-yellow-500/20 text-yellow-300 border-yellow-500/30";
    case "lcq":      return "bg-orange-500/20 text-orange-300 border-orange-500/30";
    case "main":     return "bg-primary/20 text-primary border-primary/30";
    default:         return "bg-muted text-muted-foreground";
  }
}

function statusBadgeVariant(status: string): string {
  switch (status) {
    case "in_progress": return "bg-green-500/20 text-green-300 border-green-500/30";
    case "completed":   return "bg-muted text-muted-foreground border-border";
    case "cancelled":   return "bg-red-500/20 text-red-300 border-red-500/30";
    default:            return "bg-slate-500/20 text-slate-300 border-slate-500/30";
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case "practice": return "Practice";
    case "heat":     return "Heat";
    case "lcq":      return "LCQ";
    case "main":     return "Main";
    default:         return type;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "in_progress": return "In Progress";
    case "completed":   return "Completed";
    case "cancelled":   return "Cancelled";
    default:            return "Scheduled";
  }
}

function sectionLabel(type: string): string {
  switch (type) {
    case "practice": return "Practice Sessions";
    case "heat":     return "Heat Races";
    case "lcq":      return "Last Chance Qualifier";
    case "main":     return "Main Events";
    default:         return type;
  }
}

// ── Draggable pool rider ──────────────────────────────────────────────────────

function DraggablePoolRider({
  riderId, riderName, bibNumber,
}: { riderId: number; riderName: string; bibNumber?: string | null }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `pool-${riderId}`,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`flex items-center gap-2 px-3 py-2 cursor-grab active:cursor-grabbing select-none hover:bg-muted/60 transition-opacity touch-none ${isDragging ? "opacity-20" : ""}`}
    >
      <GripVertical size={12} className="text-muted-foreground/50 shrink-0" />
      {bibNumber && (
        <span className="font-mono text-xs text-muted-foreground w-9 shrink-0">#{bibNumber}</span>
      )}
      <span className="text-sm truncate">{riderName}</span>
    </div>
  );
}

// ── Rider pool sidebar ────────────────────────────────────────────────────────

interface RiderPoolProps {
  checkins: Array<{
    riderId: number;
    riderName: string | null;
    bibNumber: string | null;
    raceClass: string | null;
    checkedIn: boolean;
  }>;
  poolOpen: boolean;
  setPoolOpen: (v: boolean) => void;
}

function RiderPool({ checkins, poolOpen, setPoolOpen }: RiderPoolProps) {
  const [search, setSearch] = useState("");

  const byClass: Record<string, Array<{ riderId: number; riderName: string; bibNumber: string | null; raceClass: string }>> = {};
  for (const c of checkins) {
    if (!c.checkedIn) continue;
    const q = search.trim().toLowerCase();
    if (q) {
      const name = (c.riderName ?? "").toLowerCase();
      const bib = (c.bibNumber ?? "").toLowerCase();
      if (!name.includes(q) && !bib.includes(q)) continue;
    }
    const cls = c.raceClass ?? "Unknown";
    if (!byClass[cls]) byClass[cls] = [];
    byClass[cls].push({
      riderId: c.riderId,
      riderName: c.riderName ?? "Rider",
      bibNumber: c.bibNumber,
      raceClass: cls,
    });
  }
  const classes = Object.entries(byClass).sort(([a], [b]) => a.localeCompare(b));
  const totalCheckedIn = checkins.filter(c => c.checkedIn).length;

  return (
    <div
      className={`shrink-0 border-r border-border bg-card/50 flex flex-col gap-3 p-3 transition-all duration-200 ${
        poolOpen ? "w-64" : "w-12"
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5">
        {poolOpen && (
          <h3 className="font-heading font-bold uppercase tracking-wider text-sm flex items-center gap-1.5 flex-1 min-w-0">
            <Users size={13} /> Rider Pool
          </h3>
        )}
        <button
          onClick={() => setPoolOpen(!poolOpen)}
          className="flex items-center justify-center w-7 h-7 rounded border bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0 ml-auto"
          title={poolOpen ? "Collapse rider pool" : "Expand rider pool"}
        >
          {poolOpen ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
        </button>
      </div>

      {poolOpen ? (
        <>
          <p className="text-xs text-muted-foreground -mt-1">
            Drag riders onto motos to add them to the lineup
          </p>

          {/* Search */}
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Name or bib…"
              className="h-8 pl-7 text-xs"
            />
          </div>

          {/* By class */}
          <div className="flex-1 overflow-y-auto space-y-3 min-h-0">
            {classes.length === 0 ? (
              <Card>
                <CardContent className="p-4 text-center text-xs text-muted-foreground">
                  {search.trim() ? "No riders match your search" : "No checked-in riders"}
                </CardContent>
              </Card>
            ) : (
              classes.map(([cls, riders]) => {
                const sorted = [...riders].sort((a, b) =>
                  a.riderName.localeCompare(b.riderName)
                );
                return (
                  <Card key={cls} className="overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 bg-muted/50 border-b">
                      <span className="font-heading font-bold text-xs uppercase tracking-wider truncate mr-2">
                        {cls}
                      </span>
                      <Badge variant="secondary" className="text-xs h-5 shrink-0">
                        {sorted.length}
                      </Badge>
                    </div>
                    <div className="divide-y">
                      {sorted.map(r => (
                        <DraggablePoolRider
                          key={r.riderId}
                          riderId={r.riderId}
                          riderName={r.riderName}
                          bibNumber={r.bibNumber}
                        />
                      ))}
                    </div>
                  </Card>
                );
              })
            )}
          </div>
        </>
      ) : (
        /* Collapsed: icon + count */
        <div className="flex flex-col items-center gap-2 mt-1">
          <Users size={14} className="text-muted-foreground" />
          {totalCheckedIn > 0 && (
            <Badge variant="secondary" className="text-[10px] h-5 px-1 font-mono tabular-nums">
              {totalCheckedIn}
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}

// ── Inline name editor ────────────────────────────────────────────────────────

interface InlineNameProps {
  motoId: number;
  name: string;
  isEditing: boolean;
  editValue: string;
  onEditStart: () => void;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function InlineName({ motoId, name, isEditing, editValue, onEditStart, onChange, onSave, onCancel }: InlineNameProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  if (isEditing) {
    return (
      <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
        <Input
          ref={inputRef}
          value={editValue}
          onChange={e => onChange(e.target.value)}
          onBlur={onSave}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); onSave(); }
            if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          }}
          className="h-6 text-sm font-medium py-0 px-1 w-48 bg-background border-primary"
        />
        <button onClick={onSave} className="text-green-400 hover:text-green-300 shrink-0">
          <Check size={14} />
        </button>
        <button onClick={onCancel} className="text-muted-foreground hover:text-foreground shrink-0">
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={onEditStart}
      className="group/name flex items-center gap-1.5 text-left hover:text-primary transition-colors"
      title="Click to rename"
    >
      <span className="font-medium text-sm">{name}</span>
      <Pencil size={11} className="opacity-0 group-hover/name:opacity-60 text-muted-foreground shrink-0 transition-opacity" />
    </button>
  );
}

// ── Sortable moto card ────────────────────────────────────────────────────────

interface MotoCardProps {
  moto: Moto;
  index: number;
  eventId: number;
  isPoolDropTarget: boolean;
  isEditing: boolean;
  editValue: string;
  onEditStart: () => void;
  onEditChange: (v: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
}

function SortableMotoCard({
  moto, index, eventId, isPoolDropTarget,
  isEditing, editValue, onEditStart, onEditChange, onEditSave, onEditCancel,
}: MotoCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: moto.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  const riderCount = Array.isArray(moto.lineup) ? moto.lineup.length : 0;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 bg-card border rounded-lg px-4 py-3 group transition-colors ${
        isPoolDropTarget
          ? "border-primary/60 bg-primary/5 ring-2 ring-inset ring-primary/20"
          : "border-border hover:border-primary/40"
      }`}
    >
      <span className="text-xs text-muted-foreground w-6 shrink-0 text-center font-mono">
        {index + 1}
      </span>

      <button
        className="touch-none cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground shrink-0"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
      >
        <GripVertical size={18} />
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {moto.raceClass && (
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground shrink-0">
              {moto.raceClass}
            </span>
          )}
          <InlineName
            motoId={moto.id}
            name={moto.name}
            isEditing={isEditing}
            editValue={editValue}
            onEditStart={onEditStart}
            onChange={onEditChange}
            onSave={onEditSave}
            onCancel={onEditCancel}
          />
        </div>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <span className={`text-xs px-2 py-0.5 rounded border font-semibold uppercase tracking-wide ${typeBadgeVariant(moto.type)}`}>
            {typeLabel(moto.type)}
          </span>
          <span className={`text-xs px-2 py-0.5 rounded border ${statusBadgeVariant(moto.status)}`}>
            {statusLabel(moto.status)}
          </span>
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Flag size={11} /> {riderCount} riders
          </span>
          {moto.lapCount != null && (
            <span className="text-xs text-muted-foreground">{moto.lapCount} laps</span>
          )}
        </div>
      </div>

      <Link
        href={`/events/${eventId}/motos?motoId=${moto.id}`}
        className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
        title="Open in Motos & Lineups"
      >
        <ExternalLink size={15} />
      </Link>
    </div>
  );
}

// ── Static card (by-class view) ───────────────────────────────────────────────

function StaticMotoCard({
  moto, eventId, isPoolDropTarget,
  isEditing, editValue, onEditStart, onEditChange, onEditSave, onEditCancel,
}: Omit<MotoCardProps, "index">) {
  const riderCount = Array.isArray(moto.lineup) ? moto.lineup.length : 0;

  return (
    <div
      className={`flex items-center gap-3 bg-card border rounded-lg px-4 py-3 transition-colors ${
        isPoolDropTarget
          ? "border-primary/60 bg-primary/5 ring-2 ring-inset ring-primary/20"
          : "border-border hover:border-primary/40"
      }`}
    >
      <div className="w-1 self-stretch rounded-full shrink-0" style={{ background: "hsl(var(--primary) / 0.3)" }} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {moto.raceClass && (
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground shrink-0">
              {moto.raceClass}
            </span>
          )}
          <InlineName
            motoId={moto.id}
            name={moto.name}
            isEditing={isEditing}
            editValue={editValue}
            onEditStart={onEditStart}
            onChange={onEditChange}
            onSave={onEditSave}
            onCancel={onEditCancel}
          />
        </div>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <span className={`text-xs px-2 py-0.5 rounded border font-semibold uppercase tracking-wide ${typeBadgeVariant(moto.type)}`}>
            {typeLabel(moto.type)}
          </span>
          <span className={`text-xs px-2 py-0.5 rounded border ${statusBadgeVariant(moto.status)}`}>
            {statusLabel(moto.status)}
          </span>
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Flag size={11} /> {riderCount} riders
          </span>
          {moto.lapCount != null && (
            <span className="text-xs text-muted-foreground">{moto.lapCount} laps</span>
          )}
        </div>
      </div>

      <Link
        href={`/events/${eventId}/motos?motoId=${moto.id}`}
        className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
        title="Open in Motos & Lineups"
      >
        <ExternalLink size={15} />
      </Link>
    </div>
  );
}

// ── Droppable moto zone (wraps a card for pool-rider drop) ────────────────────

// We detect "pool rider is over this moto" via the DndContext's onDragOver
// and pass isPoolDropTarget down as a prop. No separate useDroppable needed
// since useSortable already makes each card a droppable zone.

// ── Main page ─────────────────────────────────────────────────────────────────

type ViewMode = "run-order" | "by-class";
const MOTO_TYPES = ["practice", "heat", "lcq", "main"] as const;

type LineupEntry = {
  position: number;
  riderId: number;
  riderName: string;
  bibNumber: string | null;
  rfidNumber: string | null;
};

function getLineup(moto: Moto): LineupEntry[] {
  const raw = moto.lineup;
  if (!Array.isArray(raw)) return [];
  return raw as LineupEntry[];
}

export default function EventSchedule() {
  const params = useParams();
  const eventId = parseInt(params.eventId || "0");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ── Data ──
  const { data: rawMotos = [], isLoading } = useListMotos(eventId, {
    query: { enabled: !!eventId } as any,
  });
  const { data: checkins = [] } = useListCheckins(eventId, {
    query: { enabled: !!eventId } as any,
  });
  const { data: event } = useGetEvent(eventId, {
    query: { enabled: !!eventId } as any,
  });
  const { data: pointsTables } = useListPointsTables({ query: {} as any });

  // Gate configs for generate dialog
  const { data: gateConfigsData } = useQuery({
    queryKey: ["gateConfigs"],
    queryFn: async () => {
      const res = await fetch("/api/clubs/gate-settings", { credentials: "include" });
      if (!res.ok) return { gateConfigs: [] };
      return res.json() as Promise<{
        gateConfigs: Array<{ id: string; name: string; gateCount: number; gatePriorities: number[] }>;
      }>;
    },
  });
  const gateConfigs = gateConfigsData?.gateConfigs ?? [];

  const eventScoringTable = (pointsTables ?? []).find(
    pt => pt.id === (event as any)?.pointsTableId
  );
  const isSupercrossFormat = (eventScoringTable as any)?.mainEventOnly === true;

  // ── Local state ──
  const [viewMode, setViewMode] = useState<ViewMode>("run-order");
  const [localOrder, setLocalOrder] = useState<number[] | null>(null);

  // Inline name editing
  const [editingNameId, setEditingNameId] = useState<number | null>(null);
  const [nameEditValue, setNameEditValue] = useState("");

  // Rider pool
  const [poolOpen, setPoolOpen] = useState(true);
  const [activePoolOverMotoId, setActivePoolOverMotoId] = useState<number | null>(null);
  const [activeDrag, setActiveDrag] = useState<{ riderName: string; bibNumber?: string | null } | null>(null);

  // Generate dialog
  const [isGenerateOpen, setIsGenerateOpen] = useState(false);
  const [generateFormat, setGenerateFormat] = useState<"one_moto" | "two_moto" | "three_moto">("two_moto");
  const [ridersPerHeat, setRidersPerHeat] = useState("");
  const [usePracticeSeeding, setUsePracticeSeeding] = useState(false);
  const [selectedGateConfigId, setSelectedGateConfigId] = useState("");

  // Add moto dialog
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addForm, setAddForm] = useState({
    name: "",
    raceClass: "",
    type: "heat" as typeof MOTO_TYPES[number],
    lapCount: "5",
  });

  // ── Event rules data ──
  // Already computed above as isSupercrossFormat

  // ── Minimum lap time state ──
  const [minLapInput, setMinLapInput] = useState("");
  const [minLapSaveStatus, setMinLapSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const minLapSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seededForEventIdRef = useRef<number | null>(null);
  const minLapDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minLapInputRef = useRef(minLapInput);
  minLapInputRef.current = minLapInput;
  const isBlurFlushingRef = useRef(false);
  const isSavingRef = useRef(false);
  const pendingSaveRef = useRef<{ input: string } | null>(null);
  const lastCommittedRef = useRef<number | null>(null);
  const currentEventIdRef = useRef(eventId);
  currentEventIdRef.current = eventId;

  // ── Advance to Main state ──
  const [topPerHeatByClass, setTopPerHeatByClass] = useState<Record<string, number>>({});

  // ── Mutations ──
  const reorderMutation = useReorderMotos();
  const updateMutation = useUpdateMoto();
  const createMutation = useCreateMoto();
  const generateMutation = useGenerateLineups();
  const updateEventMutation = useUpdateEvent();
  const advanceToMainMutation = useAdvanceToMain();

  // ── defaultTopPerHeat (Advance to Main) ──
  const defaultTopPerHeat = useMemo(() => {
    const result: Record<string, number> = {};
    const mainClasses = [...new Set(rawMotos.filter(m => m.type === "main").map(m => m.raceClass).filter((c): c is string => !!c))];
    for (const cls of mainClasses) {
      const heats = rawMotos.filter(m => m.type === "heat" && m.raceClass === cls);
      const totalRiders = heats.reduce((sum, h) => sum + ((h.lineup as any[])?.length ?? 0), 0);
      const avg = heats.length > 0 ? totalRiders / heats.length : 0;
      result[cls] = Math.max(1, Math.round(avg * 0.3));
    }
    return result;
  }, [rawMotos]);

  useEffect(() => {
    setTopPerHeatByClass(prev => {
      const next = { ...prev };
      for (const [cls, val] of Object.entries(defaultTopPerHeat)) {
        if (next[cls] === undefined) next[cls] = val;
      }
      return next;
    });
  }, [defaultTopPerHeat]);

  // ── Reset min-lap state when navigating between events ──
  useEffect(() => {
    setMinLapInput("");
    seededForEventIdRef.current = null;
    lastCommittedRef.current = null;
    pendingSaveRef.current = null;
    isSavingRef.current = false;
  }, [eventId]);

  // ── Seed min-lap input from saved event data exactly once per eventId ──
  useEffect(() => {
    if (!event) return;
    const currentEventId = (event as any).id as number;
    if (seededForEventIdRef.current === currentEventId) return;
    seededForEventIdRef.current = currentEventId;
    const saved = (event as any)?.minLapMs as number | null | undefined;
    lastCommittedRef.current = saved ?? null;
    setMinLapInput(saved != null ? formatMinLapTime(saved) : "");
  }, [event]);

  // ── Always-current save function stored in a ref ──
  const saveMinLapRef = useRef<(input: string) => void>(() => {});
  saveMinLapRef.current = (input: string): void => {
    const newMs = parseMinLapTime(input) ?? null;
    if (newMs === lastCommittedRef.current) return;
    if (isSavingRef.current) {
      pendingSaveRef.current = { input };
      return;
    }
    isSavingRef.current = true;
    if (minLapSavedTimer.current) {
      clearTimeout(minLapSavedTimer.current);
      minLapSavedTimer.current = null;
    }
    setMinLapSaveStatus('saving');
    const saveEventId = eventId;
    const flushPending = () => {
      isSavingRef.current = false;
      if (pendingSaveRef.current) {
        const pending = pendingSaveRef.current;
        pendingSaveRef.current = null;
        saveMinLapRef.current(pending.input);
      }
    };
    updateEventMutation.mutate(
      { eventId, data: { minLapMs: newMs } as any },
      {
        onSuccess: () => {
          if (saveEventId !== currentEventIdRef.current) return;
          lastCommittedRef.current = newMs;
          queryClient.invalidateQueries({ queryKey: ["getEvent", eventId] as any });
          setMinLapSaveStatus('saved');
          minLapSavedTimer.current = setTimeout(() => {
            setMinLapSaveStatus('idle');
            minLapSavedTimer.current = null;
          }, 2500);
          flushPending();
        },
        onError: () => {
          if (saveEventId !== currentEventIdRef.current) return;
          setMinLapSaveStatus('error');
          flushPending();
        },
      }
    );
  };

  // ── On blur: normalize, cancel debounce, flush save ──
  const handleMinLapBlur = () => {
    const ms = parseMinLapTime(minLapInput);
    const formatted = ms != null ? formatMinLapTime(ms) : minLapInput;
    if (formatted !== minLapInput) {
      isBlurFlushingRef.current = true;
      setMinLapInput(formatted);
    }
    if (minLapDebounceTimer.current) {
      clearTimeout(minLapDebounceTimer.current);
      minLapDebounceTimer.current = null;
    }
    saveMinLapRef.current(formatted);
  };

  // ── Debounced save-on-change ──
  useEffect(() => {
    if (isBlurFlushingRef.current) {
      isBlurFlushingRef.current = false;
      return;
    }
    if (minLapDebounceTimer.current) clearTimeout(minLapDebounceTimer.current);
    const snap = minLapInput;
    minLapDebounceTimer.current = setTimeout(() => {
      saveMinLapRef.current(snap);
    }, 300);
    return () => {
      if (minLapDebounceTimer.current) clearTimeout(minLapDebounceTimer.current);
    };
  }, [minLapInput]);

  // ── Unmount flush ──
  useEffect(() => {
    return () => {
      if (minLapDebounceTimer.current) {
        clearTimeout(minLapDebounceTimer.current);
        minLapDebounceTimer.current = null;
      }
      const raw = minLapInputRef.current;
      const eid = currentEventIdRef.current;
      if (!eid) return;
      const newMs = parseMinLapTime(raw) ?? null;
      if (newMs === lastCommittedRef.current) return;
      fetch(`/api/events/${eid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minLapMs: newMs }),
        credentials: "include",
      }).catch(() => {});
    };
  }, []);

  // ── Advance to Main handler ──
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

  // ── Derived sorted list ──
  const sortedMotos: Moto[] = (() => {
    const motos = [...rawMotos].sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));
    if (!localOrder) return motos;
    const map = new Map(motos.map(m => [m.id, m]));
    return localOrder.map(id => map.get(id)).filter(Boolean) as Moto[];
  })();

  // ── DnD sensors ──
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  // ── DnD: drag start ──
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const idStr = String(event.active.id);
    if (idStr.startsWith("pool-")) {
      const riderId = parseInt(idStr.replace("pool-", ""));
      const c = checkins.find(c => c.riderId === riderId);
      setActiveDrag(c ? { riderName: c.riderName ?? "Rider", bibNumber: c.bibNumber } : null);
    }
  }, [checkins]);

  // ── DnD: drag over (track which moto a pool rider hovers) ──
  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    const idStr = String(active.id);
    if (!idStr.startsWith("pool-")) {
      setActivePoolOverMotoId(null);
      return;
    }
    if (over && typeof over.id === "number") {
      setActivePoolOverMotoId(over.id as number);
    } else {
      setActivePoolOverMotoId(null);
    }
  }, []);

  // ── DnD: drag end ──
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDrag(null);
    setActivePoolOverMotoId(null);

    if (!over) return;

    const idStr = String(active.id);

    // Pool rider dropped onto a moto card
    if (idStr.startsWith("pool-")) {
      if (typeof over.id !== "number") return;
      const riderId = parseInt(idStr.replace("pool-", ""));
      const targetMotoId = over.id as number;
      const targetMoto = rawMotos.find(m => m.id === targetMotoId);
      const checkin = checkins.find(c => c.riderId === riderId);
      if (!targetMoto || !checkin || targetMoto.status === "completed") return;

      const lineup = getLineup(targetMoto);
      if (lineup.find(e => e.riderId === riderId)) {
        toast({ title: `${checkin.riderName ?? "Rider"} is already in this moto` });
        return;
      }

      const newEntry: LineupEntry = {
        position: lineup.length + 1,
        riderId,
        riderName: checkin.riderName ?? "",
        bibNumber: (checkin as any).bibNumber || (checkin as any).registrationBib || null,
        rfidNumber: (checkin as any).rfidNumber || null,
      };
      const newLineup = [...lineup, newEntry];

      updateMutation.mutate(
        { motoId: targetMotoId, data: { lineup: newLineup as any } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) as any });
            toast({ title: `${checkin.riderName ?? "Rider"} added to ${targetMoto.name}` });
          },
          onError: () => {
            toast({ title: "Failed to add rider", variant: "destructive" });
          },
        }
      );
      return;
    }

    // Moto reorder
    if (active.id === over.id) return;
    const ids = sortedMotos.map(m => m.id);
    const oldIndex = ids.indexOf(active.id as number);
    const newIndex = ids.indexOf(over.id as number);
    if (oldIndex === -1 || newIndex === -1) return;
    const newIds = arrayMove(ids, oldIndex, newIndex);
    setLocalOrder(newIds);

    reorderMutation.mutate(
      { eventId, data: { motoIds: newIds } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setLocalOrder(null);
        },
        onError: () => {
          setLocalOrder(null);
          toast({ title: "Failed to save order", variant: "destructive" });
        },
      }
    );
  }, [rawMotos, sortedMotos, checkins, eventId, updateMutation, reorderMutation, queryClient, toast]);

  // ── Inline name editing ──
  function startEditName(moto: Moto) {
    setEditingNameId(moto.id);
    setNameEditValue(moto.name);
  }

  function saveName(motoId: number) {
    const trimmed = nameEditValue.trim();
    const moto = rawMotos.find(m => m.id === motoId);
    if (!trimmed || !moto || trimmed === moto.name) {
      setEditingNameId(null);
      return;
    }
    updateMutation.mutate(
      { motoId, data: { name: trimmed } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setEditingNameId(null);
          toast({ title: "Name updated" });
        },
        onError: () => {
          toast({ title: "Failed to save name", variant: "destructive" });
          setEditingNameId(null);
        },
      }
    );
  }

  function cancelEditName() {
    setEditingNameId(null);
    setNameEditValue("");
  }

  // ── Generate lineups ──
  function handleGenerate() {
    const allClasses: string[] = (event?.raceClasses as string[] | undefined) ?? [];
    const lockedClasses = allClasses.filter(cls =>
      rawMotos.some(m => m.raceClass === cls && m.status === "completed")
    );
    const gateConfigId = usePracticeSeeding && selectedGateConfigId ? selectedGateConfigId : undefined;

    generateMutation.mutate(
      {
        eventId,
        data: {
          raceFormat: generateFormat,
          classes: allClasses,
          ridersPerHeat: ridersPerHeat.trim() ? parseInt(ridersPerHeat, 10) : undefined,
          usePracticeSeeding,
          gateConfigId,
        } as any,
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          queryClient.invalidateQueries({ queryKey: getListCheckinsQueryKey(eventId) as any });
          setIsGenerateOpen(false);
          if (lockedClasses.length > 0) {
            toast({
              title: "Lineups generated",
              description: `Skipped ${lockedClasses.length} class${lockedClasses.length > 1 ? "es" : ""} with completed motos: ${lockedClasses.join(", ")}`,
            });
          } else {
            toast({ title: "Lineups generated" });
          }
        },
        onError: (err) => {
          toast({ title: "Failed to generate", description: (err as Error).message, variant: "destructive" });
        },
      }
    );
  }

  // ── Add moto ──
  function handleAddMoto() {
    const motoNumber = (rawMotos.length > 0
      ? Math.max(...rawMotos.map(m => m.motoNumber ?? 0))
      : 0) + 1;

    createMutation.mutate(
      {
        eventId,
        data: {
          name: addForm.name || `${addForm.raceClass} ${typeLabel(addForm.type)}`,
          type: addForm.type,
          raceClass: addForm.raceClass,
          motoNumber,
          lapCount: addForm.lapCount ? parseInt(addForm.lapCount) : undefined,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setShowAddDialog(false);
          setAddForm({ name: "", raceClass: "", type: "heat", lapCount: "5" });
          toast({ title: "Moto added" });
        },
        onError: () => {
          toast({ title: "Failed to add moto", variant: "destructive" });
        },
      }
    );
  }

  // ── By-class grouping ──
  const byClass = (() => {
    const map = new Map<string, Moto[]>();
    for (const m of sortedMotos) {
      const cls = m.raceClass || "(No Class)";
      if (!map.has(cls)) map.set(cls, []);
      map.get(cls)!.push(m);
    }
    return map;
  })();

  // ── Event start time display ──
  const eventStartDisplay = (() => {
    const raw = (event as any)?.startDate as string | undefined;
    if (!raw) return null;
    try {
      return new Date(raw).toLocaleDateString(undefined, {
        weekday: "long", month: "short", day: "numeric", year: "numeric",
      });
    } catch {
      return null;
    }
  })();

  if (isLoading) return <div className="p-8 text-muted-foreground">Loading schedule…</div>;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-full min-h-0">
        {/* ── Rider Pool sidebar ── */}
        <RiderPool
          checkins={checkins as any}
          poolOpen={poolOpen}
          setPoolOpen={setPoolOpen}
        />

        {/* ── Main content ── */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          <div className="p-6 space-y-5 max-w-4xl">

            {/* ── Header toolbar ── */}
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <h2 className="text-xl font-heading font-bold uppercase tracking-tight">Event Schedule</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {sortedMotos.length} sessions in run order
                  {eventStartDisplay && (
                    <span className="ml-2 text-muted-foreground/60">· {eventStartDisplay}</span>
                  )}
                </p>
              </div>

              <div className="flex-1" />

              {/* Generate Lineups */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsGenerateOpen(true)}
              >
                <Settings size={14} className="mr-1.5" /> Generate Lineups
              </Button>

              {/* View toggle */}
              <div className="flex bg-muted rounded-md p-0.5 border border-border">
                <button
                  onClick={() => setViewMode("run-order")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                    viewMode === "run-order"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <LayoutList size={14} /> Run Order
                </button>
                <button
                  onClick={() => setViewMode("by-class")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                    viewMode === "by-class"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <LayoutGrid size={14} /> By Class
                </button>
              </div>

              {/* Add moto */}
              <Button size="sm" onClick={() => setShowAddDialog(true)}>
                <Plus size={15} className="mr-1" /> Add Moto
              </Button>
            </div>

            {/* ── Event Rules cards ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">

              {/* Minimum Lap Time */}
              <div className="border rounded-lg bg-card overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
                  <Timer size={13} className="text-muted-foreground shrink-0" />
                  <h3 className="font-heading font-bold uppercase tracking-wider text-xs">Minimum Lap Time</h3>
                  <span className="text-[10px] text-muted-foreground font-normal hidden sm:inline">— flags short laps red</span>
                  <div className="ml-auto shrink-0">
                    {minLapSaveStatus === 'saving' && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground animate-pulse">
                        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 inline-block" />
                        Saving…
                      </span>
                    )}
                    {minLapSaveStatus === 'saved' && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-green-600 dark:text-green-400">
                        <Check size={10} />
                        Saved
                      </span>
                    )}
                    {minLapSaveStatus === 'error' && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-destructive">
                        <span>!</span>
                        Error — retry?
                      </span>
                    )}
                  </div>
                </div>
                <div className="px-3 py-2.5 flex items-center gap-3">
                  <div className="relative">
                    <input
                      value={minLapInput}
                      onChange={e => setMinLapInput(e.target.value)}
                      onBlur={() => handleMinLapBlur()}
                      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      placeholder="m:ss"
                      className="h-7 text-xs font-mono w-20 pr-6 rounded-md border border-input bg-background px-3 py-1 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
                      {minLapSaveStatus === 'saved' ? (
                        <Check size={11} className="text-green-500" />
                      ) : minLapInput.trim() ? (
                        <span className="text-[9px] text-muted-foreground">m:ss</span>
                      ) : null}
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    Applies to all classes.<br />Leave blank to disable.
                  </p>
                </div>
              </div>

              {/* Advance to Main — Supercross only */}
              {isSupercrossFormat && rawMotos.some(m => m.type === "main") ? (
                <div className="border rounded-lg bg-card overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
                    <Flag size={13} className="text-primary shrink-0" />
                    <h3 className="font-heading font-bold uppercase tracking-wider text-xs">Advance to Main Event</h3>
                  </div>
                  <div className="px-3 py-2 space-y-1.5">
                    {[...new Set(rawMotos.filter(m => m.type === "main").map(m => m.raceClass).filter((c): c is string => !!c))].map(cls => {
                      const heats = rawMotos.filter(m => m.type === "heat" && m.raceClass === cls);
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

            {/* ── Empty state ── */}
            {sortedMotos.length === 0 && (
              <div className="text-center py-16 text-muted-foreground border border-dashed border-border rounded-lg">
                <Flag size={40} className="mx-auto mb-3 opacity-30" />
                <p className="font-medium">No motos yet</p>
                <p className="text-sm mt-1">
                  Use <strong>Generate Lineups</strong> to auto-create motos from checked-in riders, or add one manually.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => setIsGenerateOpen(true)}
                >
                  <Settings size={14} className="mr-1.5" /> Generate Lineups
                </Button>
              </div>
            )}

            {/* ── Run-order view ── */}
            {viewMode === "run-order" && sortedMotos.length > 0 && (
              <SortableContext items={sortedMotos.map(m => m.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {(() => {
                    let lastType: string | null = null;
                    return sortedMotos.map((moto, index) => {
                      const showSection = moto.type !== lastType;
                      lastType = moto.type;
                      return (
                        <div key={moto.id}>
                          {showSection && (
                            <div className="flex items-center gap-2 mt-4 mb-2 first:mt-0">
                              <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                                {sectionLabel(moto.type)}
                              </span>
                              <div className="flex-1 h-px bg-border" />
                            </div>
                          )}
                          <SortableMotoCard
                            moto={moto}
                            index={index}
                            eventId={eventId}
                            isPoolDropTarget={activePoolOverMotoId === moto.id}
                            isEditing={editingNameId === moto.id}
                            editValue={nameEditValue}
                            onEditStart={() => startEditName(moto)}
                            onEditChange={setNameEditValue}
                            onEditSave={() => saveName(moto.id)}
                            onEditCancel={cancelEditName}
                          />
                        </div>
                      );
                    });
                  })()}
                </div>
              </SortableContext>
            )}

            {/* ── By-class view ── */}
            {viewMode === "by-class" && sortedMotos.length > 0 && (
              <div className="space-y-6">
                {Array.from(byClass.entries()).map(([cls, motos]) => (
                  <div key={cls}>
                    <div className="flex items-center gap-2 mb-3">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-foreground">{cls}</h3>
                      <div className="flex-1 h-px bg-border" />
                      <span className="text-xs text-muted-foreground">{motos.length} sessions</span>
                    </div>
                    <div className="space-y-2">
                      {motos.map(moto => (
                        <StaticMotoCard
                          key={moto.id}
                          moto={moto}
                          eventId={eventId}
                          isPoolDropTarget={activePoolOverMotoId === moto.id}
                          isEditing={editingNameId === moto.id}
                          editValue={nameEditValue}
                          onEditStart={() => startEditName(moto)}
                          onEditChange={setNameEditValue}
                          onEditSave={() => saveName(moto.id)}
                          onEditCancel={cancelEditName}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

          </div>
        </div>
      </div>

      {/* ── DragOverlay: rider chip ── */}
      <DragOverlay>
        {activeDrag ? (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-card border border-primary/40 rounded-lg shadow-lg text-sm opacity-95">
            <GripVertical size={12} className="text-muted-foreground/50" />
            {activeDrag.bibNumber && (
              <span className="font-mono text-xs text-muted-foreground">#{activeDrag.bibNumber}</span>
            )}
            <span className="font-medium">{activeDrag.riderName}</span>
          </div>
        ) : null}
      </DragOverlay>

      {/* ── Generate Lineups dialog ── */}
      <Dialog open={isGenerateOpen} onOpenChange={setIsGenerateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-heading uppercase text-xl">Generate Lineups</DialogTitle>
            <DialogDescription>
              Auto-create motos from checked-in riders for all race classes.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Locked classes warning */}
            {(() => {
              const allClasses: string[] = (event?.raceClasses as string[] | undefined) ?? [];
              const lockedClasses = allClasses.filter(cls =>
                rawMotos.some(m => m.raceClass === cls && m.status === "completed")
              );
              const regenerableClasses = allClasses.filter(cls => !lockedClasses.includes(cls));
              if (lockedClasses.length === 0) return null;
              return (
                <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-3 py-2.5 space-y-1.5">
                  <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                    <span>⚠️</span> Some classes have completed motos
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Completed motos and their results are never overwritten.
                  </p>
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    <span className="text-[11px] font-medium text-amber-800 dark:text-amber-300 uppercase tracking-wider w-full">Skipped:</span>
                    {lockedClasses.map(cls => (
                      <span key={cls} className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-700">
                        {cls}
                      </span>
                    ))}
                  </div>
                  {regenerableClasses.length === 0 && (
                    <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">All classes are locked — nothing to regenerate.</p>
                  )}
                </div>
              );
            })()}

            {/* Format */}
            {isSupercrossFormat ? (
              <p className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">Supercross format:</span> Heat motos and an empty Main Event will be created per class.
              </p>
            ) : (
              <div className="space-y-2">
                <Label>Motos per Class</Label>
                <Select value={generateFormat} onValueChange={(v: any) => setGenerateFormat(v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select Format" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="one_moto">1 Moto</SelectItem>
                    <SelectItem value="two_moto">2 Motos</SelectItem>
                    <SelectItem value="three_moto">3 Motos</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Riders per heat */}
            <div className="space-y-2">
              <Label>
                {isSupercrossFormat ? "Max Riders per Heat" : "Group Size"}{" "}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
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

            {/* Practice seeding */}
            <div className="rounded-lg border bg-muted/30 px-4 py-3 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={usePracticeSeeding}
                  onChange={e => {
                    setUsePracticeSeeding(e.target.checked);
                    if (!e.target.checked) setSelectedGateConfigId("");
                    else if (gateConfigs.length > 0 && !selectedGateConfigId) {
                      setSelectedGateConfigId(gateConfigs[0].id);
                    }
                  }}
                  className="h-4 w-4 rounded accent-primary"
                />
                <span className="text-sm font-medium">Use practice lap seeding</span>
              </label>
              <p className="text-xs text-muted-foreground pl-7">
                Distributes riders by best practice lap time (serpentine seeding) and assigns starting gates.
              </p>
              {usePracticeSeeding && gateConfigs.length === 0 && (
                <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5 ml-7">
                  No gate configs found — set them up on the Gate Assignments page first.
                </p>
              )}
              {usePracticeSeeding && gateConfigs.length > 1 && (
                <div className="pl-7 space-y-1">
                  <Label className="text-xs text-muted-foreground uppercase tracking-wider">Gate Config</Label>
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
                          {cfg.name}{" "}
                          <span className="text-muted-foreground ml-1">({cfg.gateCount} gates)</span>
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

            <Button
              onClick={handleGenerate}
              disabled={
                generateMutation.isPending ||
                (() => {
                  const allClasses: string[] = (event?.raceClasses as string[] | undefined) ?? [];
                  return allClasses.length > 0 && allClasses.every(cls =>
                    rawMotos.some(m => m.raceClass === cls && m.status === "completed")
                  );
                })()
              }
              className="w-full font-heading uppercase"
            >
              {generateMutation.isPending ? "Generating…" : "Generate Lineups"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Add Moto dialog ── */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Moto</DialogTitle>
            <DialogDescription>Create a new moto and append it to the end of the run order.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Class Name</Label>
              <Input
                placeholder="e.g. 250 Amateur"
                value={addForm.raceClass}
                onChange={e => setAddForm(f => ({ ...f, raceClass: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={addForm.type}
                onValueChange={v => setAddForm(f => ({ ...f, type: v as typeof MOTO_TYPES[number] }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MOTO_TYPES.map(t => (
                    <SelectItem key={t} value={t}>{typeLabel(t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Custom Name <span className="text-muted-foreground">(optional)</span></Label>
              <Input
                placeholder="Auto-generated from class + type if empty"
                value={addForm.name}
                onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Lap Count</Label>
              <Input
                type="number"
                min={1}
                value={addForm.lapCount}
                onChange={e => setAddForm(f => ({ ...f, lapCount: e.target.value }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>Cancel</Button>
            <Button
              onClick={handleAddMoto}
              disabled={!addForm.raceClass || createMutation.isPending}
            >
              {createMutation.isPending ? "Adding…" : "Add Moto"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DndContext>
  );
}
