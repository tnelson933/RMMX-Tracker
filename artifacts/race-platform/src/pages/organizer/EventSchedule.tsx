import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useParams, Link } from "wouter";
import {
  useListMotos, useReorderMotos, useUpdateMoto, useCreateMoto, useDeleteMoto, useDeleteAllMotos,
  useListCheckins, useGenerateLineups, useGetEvent, useListPointsTables, useListSeries,
  useUpdateEvent, useAdvanceToMain, useLinkStagger, useUnlinkStagger,
  useListEnduroTimeChecks, useSetEnduroTimeChecks, useGetEnduroPenaltySummary,
  useListCheckpointArrivals, useRecordCheckpointArrival, useDeleteCheckpointArrival,
  useListReaders, useListEventReaderAssignments, useSetEventReaderAssignments,
  getListMotosQueryKey, getListCheckinsQueryKey, getListEnduroTimeChecksQueryKey,
  getListReadersQueryKey, getListEventReaderAssignmentsQueryKey, getListCheckpointArrivalsQueryKey,
  getGetEnduroPenaltySummaryQueryKey,
  type Moto,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import {
  DndContext, DragOverlay, pointerWithin,
  PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable, useDndContext,
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
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  GripVertical, Plus, Clock, LayoutList, LayoutGrid, Flag, ExternalLink,
  Users, Search, Settings, ChevronLeft, ChevronRight, Pencil, Timer, Check, X, ChevronDown, Trash2, Link2, Unlink2, Info,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

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
    case "practice": return "bg-blue-500/25 text-blue-300 border-blue-400/70";
    case "heat":     return "bg-yellow-400/25 text-yellow-300 border-yellow-400/80";
    case "lcq":      return "bg-orange-500/30 text-orange-300 border-orange-400/70";
    case "main":     return "bg-primary/30 text-primary border-primary/60";
    case "moto":     return "bg-teal-500/25 text-teal-300 border-teal-400/70";
    default:         return "bg-muted text-muted-foreground";
  }
}

function statusBadgeVariant(status: string): string {
  switch (status) {
    case "in_progress": return "bg-green-500/30 text-green-300 border-green-400/70";
    case "completed":   return "bg-muted text-muted-foreground border-border";
    case "cancelled":   return "bg-red-500/30 text-red-300 border-red-400/70";
    default:            return "bg-slate-600/50 text-slate-200 border-slate-400/80";
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case "practice":    return "Practice";
    case "heat":        return "Heat";
    case "lcq":         return "LCQ";
    case "main":        return "Main";
    case "moto":        return "Moto";
    case "enduro_test": return "Test";
    default:            return type;
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
  isRiderDragging?: boolean;
}

function RiderPool({ checkins, poolOpen, setPoolOpen, isRiderDragging }: RiderPoolProps) {
  const { setNodeRef: setPoolDropRef, isOver: isOverPool } = useDroppable({ id: "pool-drop-zone" });
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

  const showDropHint = isRiderDragging;
  const activeDropStyle = showDropHint && isOverPool;

  return (
    <div
      ref={setPoolDropRef}
      className={`shrink-0 border-r flex flex-col gap-3 p-3 transition-all duration-200 ${
        poolOpen ? "w-64" : "w-12"
      } ${activeDropStyle
        ? "bg-destructive/10 border-destructive/50"
        : showDropHint
        ? "bg-amber-500/5 border-amber-500/40"
        : "border-border bg-card/50"
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
          {/* Drop-to-remove hint banner */}
          {showDropHint ? (
            <div className={`-mt-1 rounded-md border px-2.5 py-2 text-xs text-center font-medium transition-all ${
              activeDropStyle
                ? "bg-destructive/20 border-destructive/50 text-destructive"
                : "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400"
            }`}>
              {activeDropStyle ? "↩ Release to remove from moto" : "Drop here to remove from moto"}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground -mt-1">
              Drag riders onto motos to add them to the lineup
            </p>
          )}

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
                  <Card key={cls} className="overflow-hidden border-sidebar-border">
                    <div className="flex items-center justify-between px-3 py-2 bg-sidebar text-sidebar-foreground border-b">
                      <span className="font-heading font-bold text-xs uppercase tracking-wider truncate mr-2">
                        {cls}
                      </span>
                      <Badge variant="secondary" className="text-xs h-5 shrink-0 bg-sidebar-accent text-sidebar-foreground border-transparent">
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
        /* Collapsed: icon + count, plus visual when dragging */
        <div className="flex flex-col items-center gap-2 mt-1">
          {activeDropStyle ? (
            <X size={14} className="text-destructive" />
          ) : (
            <Users size={14} className={showDropHint ? "text-amber-500" : "text-muted-foreground"} />
          )}
          {totalCheckedIn > 0 && !showDropHint && (
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
          className="h-6 text-sm font-medium py-0 px-1 w-48 bg-background border-primary text-foreground"
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

// ── Practice countdown timer ──────────────────────────────────────────────────

interface PracticeCountdownTimerProps {
  motoId: number;
  startedAt: string | null;
  countdownSeconds: number;
  onExpire: () => void;
}

function PracticeCountdownTimer({ motoId, startedAt, countdownSeconds, onExpire }: PracticeCountdownTimerProps) {
  const [remaining, setRemaining] = useState<number>(() => {
    if (!startedAt) return countdownSeconds;
    const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
    return Math.max(0, countdownSeconds - elapsed);
  });
  const expiredRef = useRef(false);
  // Keep onExpire in a ref so the interval never needs it as a dep — inline
  // arrow functions passed from the parent would otherwise restart the timer
  // on every render, causing an infinite setState → re-render loop.
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    expiredRef.current = false;
    const tick = () => {
      if (!startedAt) return;
      const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
      const rem = Math.max(0, countdownSeconds - elapsed);
      setRemaining(rem);
      if (rem === 0 && !expiredRef.current) {
        expiredRef.current = true;
        fetch(`/api/motos/${motoId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ status: "completed" }),
        }).then(() => onExpireRef.current()).catch(() => {});
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [motoId, startedAt, countdownSeconds]);

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const display = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  const isExpired = remaining === 0;
  const isLow = remaining > 0 && remaining <= 60;

  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-sm font-bold tabular-nums ${
        isExpired
          ? "text-muted-foreground"
          : isLow
          ? "text-red-400"
          : "text-green-400"
      }`}
    >
      <Timer size={13} className="shrink-0" />
      {display}
    </span>
  );
}

// ── Sortable lineup row (within an expanded moto) ──────────────────────────────

// LineupEntry is forward-referenced from below — TS hoists type aliases
interface LineupRowProps {
  entry: { position: number; riderId: number; riderName: string; bibNumber: string | null; checkedIn?: boolean };
  motoId: number;
  isCompleted: boolean;
  onRemove: () => void;
  allIds: string[];
}

function SortableLineupRow({ entry, motoId, isCompleted, onRemove, allIds }: LineupRowProps) {
  const myId = `lrider-${motoId}-${entry.riderId}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: myId,
    disabled: isCompleted,
  });
  const { active, over } = useDndContext();

  // Compute drop-indicator position
  let showLineAbove = false;
  let showLineBelow = false;
  const isOverMe = over?.id === myId;
  const activeId = String(active?.id ?? "");
  const draggingWithinSameMoto = activeId.startsWith(`lrider-${motoId}-`);
  if (isOverMe && draggingWithinSameMoto && activeId !== myId) {
    const activeIdx = allIds.indexOf(activeId);
    const myIdx = allIds.indexOf(myId);
    if (activeIdx > myIdx) showLineAbove = true;  // coming from below → lands above me
    else showLineBelow = true;                      // coming from above → lands below me
  }

  return (
    <div className="relative">
      {showLineAbove && (
        <div className="absolute -top-px left-2 right-2 h-0.5 bg-primary rounded-full z-10 pointer-events-none" />
      )}
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.25 : 1 }}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md group/lr hover:bg-muted/40 transition-colors select-none"
      >
        {!isCompleted ? (
          <button
            className="touch-none cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground shrink-0"
            {...attributes}
            {...listeners}
            aria-label="Drag to reorder gate"
          >
            <GripVertical size={12} />
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}
        <span className="text-[11px] font-mono text-muted-foreground w-14 shrink-0 tabular-nums">
          Gate {entry.position}
        </span>
        {entry.bibNumber && (
          <span className="font-mono text-[11px] text-muted-foreground w-9 shrink-0">#{entry.bibNumber}</span>
        )}
        <span className={`text-xs flex-1 truncate font-medium ${entry.checkedIn === false ? "text-muted-foreground/60" : ""}`}>{entry.riderName}</span>
        {entry.checkedIn === false && (
          <span className="text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400 shrink-0 bg-amber-500/10 border border-amber-500/30 rounded px-1 py-0.5">
            Pending
          </span>
        )}
        {!isCompleted && (
          <button
            onClick={onRemove}
            className="opacity-0 group-hover/lr:opacity-100 text-muted-foreground hover:text-destructive transition-all shrink-0 p-0.5 rounded"
            title="Remove from moto"
          >
            <X size={11} />
          </button>
        )}
      </div>
      {showLineBelow && (
        <div className="absolute -bottom-px left-2 right-2 h-0.5 bg-primary rounded-full z-10 pointer-events-none" />
      )}
    </div>
  );
}

// ── Stagger drop zone (inside a card when another moto is being dragged) ──────

function StaggerDropZone({ motoId }: { motoId: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `stagger-${motoId}` });
  return (
    <div
      ref={setNodeRef}
      className={`absolute inset-x-3 top-[18%] bottom-[18%] z-20 flex items-center justify-center rounded-lg border-2 border-dashed pointer-events-auto transition-all ${
        isOver ? "border-primary bg-primary/20" : "border-primary/50 bg-primary/5"
      }`}
    >
      <div className="flex items-center gap-1.5 text-primary text-xs font-semibold select-none">
        <Link2 size={13} />
        <span>{isOver ? "Release to stagger" : "Drop here to stagger"}</span>
      </div>
    </div>
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
  isExpanded: boolean;
  onToggleExpand: () => void;
  onRemoveRider: (riderId: number) => void;
  onCountdownExpire?: () => void;
  onDelete?: () => void;
  isMotoCardDragging?: boolean;
  staggerGroup?: Moto[];
  onUnstaggerMoto?: (motoId: number) => void;
  onEditStagger?: (orderedMotoIds: number[]) => void;
  isStaggerSelectMode?: boolean;
  isStaggerSelected?: boolean;
  onStaggerToggle?: () => void;
}

function SortableMotoCard({
  moto, index, eventId, isPoolDropTarget,
  isEditing, editValue, onEditStart, onEditChange, onEditSave, onEditCancel,
  isExpanded, onToggleExpand, onRemoveRider, onCountdownExpire, onDelete,
  isMotoCardDragging, staggerGroup, onUnstaggerMoto, onEditStagger,
  isStaggerSelectMode, isStaggerSelected, onStaggerToggle,
}: MotoCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: moto.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  const lineup = Array.isArray(moto.lineup) ? (moto.lineup as Array<{ position: number; riderId: number; riderName: string; bibNumber: string | null }>) : [];
  const riderCount = lineup.length;
  const isCompleted = moto.status === "completed";
  const isCountdownMode = moto.type === "practice" && (moto as any).practiceMode === "countdown";
  const countdownSeconds = (moto as any).countdownSeconds as number | null;
  const isCountdownActive = isCountdownMode && moto.status === "in_progress" && countdownSeconds != null;
  const isCountdownComplete = isCountdownMode && isCompleted && (moto as any).startedAt != null;

  const isAlreadyStaggered = !!(moto as any).staggeredGroupId;
  const staggerOrder: number = (moto as any).staggeredOrder ?? 0;
  const groupMembers = staggerGroup ?? [];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative bg-card border rounded-lg group transition-colors ${
        isCountdownComplete
          ? "border-muted bg-muted/10"
          : isPoolDropTarget
          ? "border-primary/60 bg-primary/5 ring-2 ring-inset ring-primary/20"
          : groupMembers.length > 0
          ? "border-primary/40 ring-1 ring-primary/20"
          : "border-sidebar-border hover:border-primary/40"
      }`}
    >
      {/* ── Stagger drop zone (shown when another moto card is being dragged, only outside select mode) ── */}
      {!isStaggerSelectMode && isMotoCardDragging && !isDragging && !isAlreadyStaggered && (
        <StaggerDropZone motoId={moto.id} />
      )}

      {/* ── Stagger group banner ── */}
      {groupMembers.length > 0 && (
        <div className="px-4 py-1.5 bg-primary/5 border-b border-primary/20 rounded-t-lg">
          <div className="flex items-center gap-2 flex-wrap">
            <Link2 size={12} className="text-primary shrink-0" />
            <span className="text-xs font-semibold text-primary">
              Staggered Group — {groupMembers.length} motos
            </span>
            <span className="text-[10px] text-muted-foreground">starts {staggerOrder === 1 ? "1st" : `${staggerOrder}${staggerOrder === 2 ? "nd" : staggerOrder === 3 ? "rd" : "th"}`}</span>
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={() => onEditStagger?.(groupMembers.map(m => m.id))}
                className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border border-border hover:border-primary/60 hover:text-primary text-muted-foreground transition-colors"
                title="Edit staggered start order"
              >
                <Pencil size={9} />
                Edit order
              </button>
              {groupMembers.map(gm => (
                <button
                  key={gm.id}
                  onClick={() => onUnstaggerMoto?.(gm.id)}
                  className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border border-border hover:border-destructive/60 hover:text-destructive text-muted-foreground transition-colors"
                  title={`Remove ${gm.name} from group`}
                >
                  <X size={9} />
                  {gm.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Countdown complete banner ── */}
      {isCountdownComplete && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-muted/30 border-b border-border/60 rounded-t-lg">
          <Check size={13} className="text-muted-foreground shrink-0" />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Practice Complete</span>
        </div>
      )}

      {/* ── Header row ── */}
      <div className="flex items-center gap-3 px-4 py-3 bg-sidebar text-sidebar-foreground border-b">
        {isStaggerSelectMode ? (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onStaggerToggle?.(); }}
            className={`shrink-0 h-4 w-4 rounded border-2 flex items-center justify-center transition-colors ${
              isStaggerSelected
                ? "bg-primary border-primary text-primary-foreground"
                : "border-sidebar-foreground/40 hover:border-primary"
            }`}
            aria-label="Select for stagger group"
          >
            {isStaggerSelected && <Check size={10} />}
          </button>
        ) : (
          <span className="text-xs text-sidebar-foreground/50 w-6 shrink-0 text-center font-mono">
            {index + 1}
          </span>
        )}

        <button
          className="touch-none cursor-grab active:cursor-grabbing text-sidebar-foreground/40 hover:text-sidebar-foreground shrink-0"
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder"
        >
          <GripVertical size={18} />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {moto.raceClass && !(moto as any).raceClasses && (
              <span className="text-xs font-bold uppercase tracking-wider text-sidebar-foreground/60 shrink-0">
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
          {Array.isArray((moto as any).raceClasses) && (moto as any).raceClasses.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {((moto as any).raceClasses as string[]).map((cls: string) => (
                <span key={cls} className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 font-medium">
                  {cls}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded border font-semibold uppercase tracking-wide ${typeBadgeVariant(moto.type)}`}>
              {typeLabel(moto.type)}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded border ${statusBadgeVariant(moto.status)}`}>
              {statusLabel(moto.status)}
            </span>
            <button
              onClick={onToggleExpand}
              className="text-xs text-sidebar-foreground/50 flex items-center gap-1 hover:text-sidebar-foreground transition-colors"
            >
              <Flag size={11} /> {riderCount} riders
              <ChevronDown size={11} className={`transition-transform duration-150 ${isExpanded ? "rotate-180" : ""}`} />
            </button>
            {moto.lapCount != null && !isCountdownMode && (
              <span className="text-xs text-sidebar-foreground/60">{moto.lapCount} laps</span>
            )}
            {isCountdownActive && onCountdownExpire && (
              <PracticeCountdownTimer
                motoId={moto.id}
                startedAt={(moto as any).startedAt as string | null}
                countdownSeconds={countdownSeconds!}
                onExpire={onCountdownExpire}
              />
            )}
            {isCountdownMode && !isCountdownActive && countdownSeconds != null && !isCompleted && (
              <span className="text-xs text-sidebar-foreground/60 flex items-center gap-1">
                <Timer size={11} /> {Math.floor(countdownSeconds / 60)}m countdown
              </span>
            )}
          </div>
        </div>

        {!isCompleted && onDelete && (
          <button
            onClick={onDelete}
            className="shrink-0 text-sidebar-foreground/50 hover:text-destructive transition-colors p-0.5 rounded"
            title="Delete moto"
          >
            <Trash2 size={14} />
          </button>
        )}
        <Link
          href={`/events/${eventId}/motos?motoId=${moto.id}`}
          className="shrink-0 text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors"
          title="Open in Motos & Lineups"
        >
          <ExternalLink size={15} />
        </Link>
      </div>

      {/* ── Inline lineup (expanded) ── */}
      {isExpanded && (
        <div className="border-t border-border/60 px-4 py-2">
          {lineup.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-2">
              No riders assigned — drag from the Rider Pool to add
            </p>
          ) : (
            <SortableContext
              items={lineup.map(e => `lrider-${moto.id}-${e.riderId}`)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-0.5">
                {lineup.map(entry => (
                  <SortableLineupRow
                    key={entry.riderId}
                    entry={entry}
                    motoId={moto.id}
                    isCompleted={isCompleted}
                    onRemove={() => onRemoveRider(entry.riderId)}
                    allIds={lineup.map(e => `lrider-${moto.id}-${e.riderId}`)}
                  />
                ))}
              </div>
            </SortableContext>
          )}
        </div>
      )}

      {/* ── Group member lineups (order=1 card shows all other members' riders) ── */}
      {staggerOrder === 1 && groupMembers.length > 1 && isExpanded && (() => {
        const others = groupMembers.filter(gm => gm.id !== moto.id);
        return (
          <>
            {others.map((partner, pIdx) => {
              const partnerLineup = Array.isArray(partner.lineup)
                ? (partner.lineup as LineupEntry[])
                : [];
              const startPos = (partner as any).staggeredOrder ?? (pIdx + 2);
              const posSuffix = startPos === 2 ? "nd" : startPos === 3 ? "rd" : "th";
              return (
          <div key={partner.id} className="border-t-2 border-primary/30 px-4 py-2">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Link2 size={10} className="text-primary" />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">
                {partner.name} — starts {startPos}{posSuffix}
              </span>
            </div>
            {partnerLineup.length === 0 ? (
              <p className="text-xs text-muted-foreground py-1">No riders in this moto yet</p>
            ) : (
              <div className="space-y-0.5 opacity-80">
                {partnerLineup.map((entry, i) => (
                  <div key={entry.riderId} className="flex items-center gap-2 text-xs py-0.5">
                    <span className="w-4 text-muted-foreground font-mono text-center text-[10px]">{i + 1}</span>
                    <span className="font-medium">{entry.riderName}</span>
                    {entry.bibNumber && (
                      <span className="text-muted-foreground font-mono">#{entry.bibNumber}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
})()}
    </div>
  );
}

// ── Static card (by-class view) ───────────────────────────────────────────────

function StaticMotoCard({
  moto, eventId, isPoolDropTarget,
  isEditing, editValue, onEditStart, onEditChange, onEditSave, onEditCancel,
  isExpanded, onToggleExpand, onRemoveRider, onCountdownExpire, onDelete,
}: Omit<MotoCardProps, "index">) {
  const { setNodeRef, isOver } = useDroppable({ id: moto.id });
  const lineup = Array.isArray(moto.lineup) ? (moto.lineup as Array<{ position: number; riderId: number; riderName: string; bibNumber: string | null }>) : [];
  const riderCount = lineup.length;
  const isCompleted = moto.status === "completed";
  const isCountdownMode = moto.type === "practice" && (moto as any).practiceMode === "countdown";
  const countdownSeconds = (moto as any).countdownSeconds as number | null;
  const isCountdownActive = isCountdownMode && moto.status === "in_progress" && countdownSeconds != null;
  const isCountdownComplete = isCountdownMode && isCompleted && (moto as any).startedAt != null;
  const showDropHighlight = isPoolDropTarget || isOver;

  return (
    <div
      ref={setNodeRef}
      className={`bg-card border rounded-lg transition-colors ${
        isCountdownComplete
          ? "border-muted bg-muted/10"
          : showDropHighlight
          ? "border-primary/60 bg-primary/5 ring-2 ring-inset ring-primary/20"
          : "border-sidebar-border hover:border-primary/40"
      }`}
    >
      {/* ── Countdown complete banner ── */}
      {isCountdownComplete && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-muted/30 border-b border-border/60 rounded-t-lg">
          <Check size={13} className="text-muted-foreground shrink-0" />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Practice Complete</span>
        </div>
      )}

      {/* ── Header row ── */}
      <div className="flex items-center gap-3 px-4 py-3 bg-sidebar text-sidebar-foreground border-b">
        <div className="w-1 self-stretch rounded-full shrink-0" style={{ background: "hsl(var(--primary) / 0.5)" }} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {moto.raceClass && !(moto as any).raceClasses && (
              <span className="text-xs font-bold uppercase tracking-wider text-sidebar-foreground/60 shrink-0">
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
          {Array.isArray((moto as any).raceClasses) && (moto as any).raceClasses.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {((moto as any).raceClasses as string[]).map((cls: string) => (
                <span key={cls} className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 font-medium">
                  {cls}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded border font-semibold uppercase tracking-wide ${typeBadgeVariant(moto.type)}`}>
              {typeLabel(moto.type)}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded border ${statusBadgeVariant(moto.status)}`}>
              {statusLabel(moto.status)}
            </span>
            <button
              onClick={onToggleExpand}
              className="text-xs text-sidebar-foreground/50 flex items-center gap-1 hover:text-sidebar-foreground transition-colors"
            >
              <Flag size={11} /> {riderCount} riders
              <ChevronDown size={11} className={`transition-transform duration-150 ${isExpanded ? "rotate-180" : ""}`} />
            </button>
            {moto.lapCount != null && !isCountdownMode && (
              <span className="text-xs text-sidebar-foreground/60">{moto.lapCount} laps</span>
            )}
            {isCountdownActive && onCountdownExpire && (
              <PracticeCountdownTimer
                motoId={moto.id}
                startedAt={(moto as any).startedAt as string | null}
                countdownSeconds={countdownSeconds!}
                onExpire={onCountdownExpire}
              />
            )}
            {isCountdownMode && !isCountdownActive && countdownSeconds != null && !isCompleted && (
              <span className="text-xs text-sidebar-foreground/60 flex items-center gap-1">
                <Timer size={11} /> {Math.floor(countdownSeconds / 60)}m countdown
              </span>
            )}
          </div>
        </div>

        {!isCompleted && onDelete && (
          <button
            onClick={onDelete}
            className="shrink-0 text-sidebar-foreground/50 hover:text-destructive transition-colors p-0.5 rounded"
            title="Delete moto"
          >
            <Trash2 size={14} />
          </button>
        )}
        <Link
          href={`/events/${eventId}/motos?motoId=${moto.id}`}
          className="shrink-0 text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors"
          title="Open in Motos & Lineups"
        >
          <ExternalLink size={15} />
        </Link>
      </div>

      {/* ── Inline lineup (expanded) ── */}
      {isExpanded && (
        <div className="border-t border-border/60 px-4 py-2">
          {lineup.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-2">
              No riders assigned — drag from the Rider Pool to add
            </p>
          ) : (
            <SortableContext
              items={lineup.map(e => `lrider-${moto.id}-${e.riderId}`)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-0.5">
                {lineup.map(entry => (
                  <SortableLineupRow
                    key={entry.riderId}
                    entry={entry}
                    motoId={moto.id}
                    isCompleted={isCompleted}
                    onRemove={() => onRemoveRider(entry.riderId)}
                    allIds={lineup.map(e => `lrider-${moto.id}-${e.riderId}`)}
                  />
                ))}
              </div>
            </SortableContext>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type ViewMode = "run-order" | "by-class";
const MOTO_TYPES = ["practice", "heat", "lcq", "main", "moto", "enduro_test"] as const;

// Time-check durations are entered as "h:mm" or plain minutes; stored as ms.
function hmToMs(text: string): number | null {
  const s = (text ?? "").trim();
  if (!s) return null;
  if (s.includes(":")) {
    const [h, m] = s.split(":");
    const hours = parseInt(h, 10);
    const mins = parseInt(m, 10);
    if (Number.isNaN(hours) || Number.isNaN(mins)) return null;
    return (hours * 60 + mins) * 60_000;
  }
  const mins = parseInt(s, 10);
  if (Number.isNaN(mins)) return null;
  return mins * 60_000;
}

function msToHm(ms: number): string {
  if (!ms || ms <= 0) return "";
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

// Parse "H:MM" or "HH:MM" (24-hr) start-of-day time → minutes since midnight, or null.
function parseStartTime(text: string): number | null {
  const s = (text ?? "").trim();
  if (!s) return null;
  const [h, m] = s.split(":");
  const hours = parseInt(h, 10);
  const mins = parseInt(m ?? "0", 10);
  if (Number.isNaN(hours) || Number.isNaN(mins)) return null;
  return hours * 60 + mins;
}

// Format minutes-since-midnight as "h:mm AM/PM".
function formatClockTime(totalMins: number): string {
  const h24 = Math.floor(totalMins / 60) % 24;
  const m = totalMins % 60;
  const ampm = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// Compute wall-clock arrival at a checkpoint given a class start time ("H:MM" 24-hr)
// and a duration from start ("h:mm" or plain minutes). Returns null if either is empty.
function computeArrival(startStr: string, durationStr: string): string | null {
  const startMins = parseStartTime(startStr);
  const durationMs = hmToMs(durationStr);
  if (startMins == null || !durationMs) return null;
  return formatClockTime(startMins + Math.round(durationMs / 60_000));
}

type LineupEntry = {
  position: number;
  riderId: number;
  riderName: string;
  bibNumber: string | null;
  rfidNumber: string | null;
  checkedIn?: boolean;
};

function getLineup(moto: Moto): LineupEntry[] {
  const raw = moto.lineup;
  if (!Array.isArray(raw)) return [];
  return raw as LineupEntry[];
}

// ── Multi-class conflict panel ─────────────────────────────────────────────────

type ConflictEntry = {
  riderId: number;
  riderName: string;
  pairs: { motoA: string; motoB: string; gap: number }[];
  worstGap: number;
};

function useScheduleConflicts(rawMotos: Moto[]): ConflictEntry[] {
  return useMemo(() => {
    const raceMotos = [...rawMotos]
      .filter(m => m.type !== "practice")
      .sort((a, b) => ((a as any).motoNumber ?? 0) - ((b as any).motoNumber ?? 0));

    const riderMap = new Map<number, { riderName: string; appearances: { pos: number; name: string }[] }>();
    raceMotos.forEach((moto, pos) => {
      const lineup = Array.isArray(moto.lineup) ? (moto.lineup as LineupEntry[]) : [];
      for (const entry of lineup) {
        if (!riderMap.has(entry.riderId)) {
          riderMap.set(entry.riderId, { riderName: entry.riderName, appearances: [] });
        }
        riderMap.get(entry.riderId)!.appearances.push({
          pos,
          name: (moto.name ?? `Moto #${(moto as any).motoNumber}`),
        });
      }
    });

    const conflicts: ConflictEntry[] = [];
    for (const [riderId, { riderName, appearances }] of riderMap) {
      if (appearances.length < 2) continue;
      const sorted = [...appearances].sort((a, b) => a.pos - b.pos);
      const pairs: { motoA: string; motoB: string; gap: number }[] = [];
      let worstGap = Infinity;
      for (let i = 0; i < sorted.length - 1; i++) {
        const gap = sorted[i + 1].pos - sorted[i].pos - 1;
        if (gap <= 2) {
          pairs.push({ motoA: sorted[i].name, motoB: sorted[i + 1].name, gap });
          worstGap = Math.min(worstGap, gap);
        }
      }
      if (pairs.length > 0) {
        conflicts.push({ riderId, riderName, pairs, worstGap });
      }
    }
    return conflicts.sort((a, b) => a.worstGap - b.worstGap);
  }, [rawMotos]);
}

function conflictColor(gap: number): { dot: string; text: string; bg: string; border: string; label: string } {
  if (gap === 0) return { dot: "bg-red-500", text: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/30", label: "Back-to-back" };
  if (gap === 1) return { dot: "bg-orange-500", text: "text-orange-400", bg: "bg-orange-500/10", border: "border-orange-500/30", label: "1 race between" };
  return { dot: "bg-yellow-500", text: "text-yellow-400", bg: "bg-yellow-500/10", border: "border-yellow-500/30", label: "2 races between" };
}

function ScheduleConflictPanel({ conflicts }: { conflicts: ConflictEntry[] }) {
  const [open, setOpen] = useState(true);
  if (conflicts.length === 0) return null;

  const worstOverall = conflicts[0].worstGap;
  const headerColor = conflictColor(worstOverall);

  return (
    <div className={`rounded-lg border ${headerColor.border} ${headerColor.bg} text-sm`}>
      <button
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
        onClick={() => setOpen(v => !v)}
      >
        <span className={`inline-block w-2 h-2 rounded-full ${headerColor.dot} shrink-0`} />
        <span className={`font-semibold text-xs uppercase tracking-wide ${headerColor.text}`}>
          Multi-class conflicts — {conflicts.length} rider{conflicts.length !== 1 ? "s" : ""}
        </span>
        <ChevronDown size={13} className={`ml-auto ${headerColor.text} transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-inherit px-3 pb-3 pt-2 space-y-2">
          {conflicts.map(c => (
            <div key={c.riderId} className="space-y-0.5">
              <p className="font-semibold text-foreground text-xs">{c.riderName}</p>
              {c.pairs.map((p, i) => {
                const col = conflictColor(p.gap);
                return (
                  <div key={i} className="flex items-start gap-2">
                    <span className={`mt-1 inline-block w-1.5 h-1.5 rounded-full ${col.dot} shrink-0`} />
                    <span className={`text-xs ${col.text}`}>
                      {p.motoA} → {p.motoB}
                      <span className="text-muted-foreground font-normal ml-1">({col.label})</span>
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sortable row for class run order panel ────────────────────────────────────
function SortableClassRow({ id, index }: { id: string; index: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-border bg-background select-none touch-none"
    >
      <button
        className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground shrink-0 touch-none"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder class"
      >
        <GripVertical size={13} />
      </button>
      <span className="text-[10px] font-mono text-muted-foreground/60 w-4 shrink-0 text-right">{index + 1}</span>
      <span className="text-xs font-medium truncate flex-1">{id}</span>
    </div>
  );
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
  const { data: seriesList = [] } = useListSeries({ query: {} as any });
  const eventSeries = seriesList.find(s => (s.eventIds as number[])?.includes(eventId));


  const eventScoringTable = (pointsTables ?? []).find(
    pt => pt.id === (event as any)?.pointsTableId
  );
  const isSupercrossFormat = (eventScoringTable as any)?.mainEventOnly === true;
  const raceStyle: "motocross" | "enduro" | "cross_country" = (event as any)?.raceStyle ?? "motocross";
  const isEnduro = raceStyle === "enduro";
  const isCrossCountry = raceStyle === "cross_country";
  const isMylaps = ((event as any)?.timingTechnology ?? "rfid") === "mylaps";
  const timingLabel = isMylaps ? "MyLaps" : "RFID";

  // ── Local state ──
  const [viewMode, setViewMode] = useState<ViewMode>("run-order");
  const [localOrder, setLocalOrder] = useState<number[] | null>(null);
  const [roundFilter, setRoundFilter] = useState<"all" | "practice" | number>("all");

  // Inline name editing
  const [editingNameId, setEditingNameId] = useState<number | null>(null);
  const [nameEditValue, setNameEditValue] = useState("");

  // Rider pool
  const [poolOpen, setPoolOpen] = useState(true);
  const [activePoolOverMotoId, setActivePoolOverMotoId] = useState<number | null>(null);
  const [activeDrag, setActiveDrag] = useState<{ riderName: string; bibNumber?: string | null; source: "pool" | "lineup" | "moto"; motoId?: number } | null>(null);

  // Expanded moto state
  const [expandedMotos, setExpandedMotos] = useState<Set<number>>(new Set());

  // Generate dialog
  const [isGenerateOpen, setIsGenerateOpen] = useState(false);
  const [generateFormat, setGenerateFormat] = useState<"one_moto" | "two_moto" | "three_moto">("two_moto");
  const [ridersPerHeat, setRidersPerHeat] = useState("");
  const [generateLapCount, setGenerateLapCount] = useState("");
  const [generateTimeLimitMins, setGenerateTimeLimitMins] = useState("");
  const [generatePlusLaps, setGeneratePlusLaps] = useState("1");
  const [generateGateMethod, setGenerateGateMethod] = useState<"random" | "practice" | "prior_round_finish" | "first_registered" | "series_points">("random");
  const [generateSelectedRounds, setGenerateSelectedRounds] = useState<number[]>([]);
  const [generateMinRacesBetween, setGenerateMinRacesBetween] = useState<number>(0);
  const [generateClass, setGenerateClass] = useState<string>("all");
  const noneCheckedIn = (checkins as any[]).filter((c: any) => c.checkedIn).length === 0;

  // Enduro "Generate Tests" dialog
  const [genTestCount, setGenTestCount] = useState("3");
  const [genTestPrefix, setGenTestPrefix] = useState("Test");
  const [genTestNames, setGenTestNames] = useState<string[]>(["", "", ""]);
  const [genTestLaps, setGenTestLaps] = useState("1");
  const [genTestRfidStart, setGenTestRfidStart] = useState(true);

  // Enduro time checks: event-wide checkpoints, each with a per-class expected
  // duration from race start (text "h:mm" or "mm", parsed to ms on save).
  const [genTimeChecksEnabled, setGenTimeChecksEnabled] = useState(false);
  const [genTimeCheckCount, setGenTimeCheckCount] = useState("1");
  const [genTimeChecks, setGenTimeChecks] = useState<
    Array<{ name: string; durations: Record<string, string> }>
  >([{ name: "", durations: {} }]);
  // Per-class start times ("H:MM" 24-hr) used to compute expected checkpoint arrival times.
  const [classStartTimes, setClassStartTimes] = useState<Record<string, string>>({});
  // IANA timezone used for arrival-time comparisons — defaults to this device's timezone.
  const [classTimezone, setClassTimezone] = useState<string>(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "America/Denver",
  );

  // Penalty config state (for Generate Tests dialog)
  const [penaltyEnabled, setPenaltyEnabled] = useState(false);
  const [penaltyEarlySecPerMin, setPenaltyEarlySecPerMin] = useState("0");
  const [penaltyLateSecPerMin, setPenaltyLateSecPerMin] = useState("0");
  const [penaltyEarlyDqMin, setPenaltyEarlyDqMin] = useState("");
  const [penaltyLateDqMin, setPenaltyLateDqMin] = useState("");

  // Checkpoint arrivals management state
  const [arrivalPanelCheckId, setArrivalPanelCheckId] = useState<number | null>(null);
  const [arrivalRiderId, setArrivalRiderId] = useState("");
  const [arrivalTime, setArrivalTime] = useState("");
  const [arrivalSaving, setArrivalSaving] = useState(false);

  // Keep the time-check list sized to the requested count, preserving entries.
  function setGenTimeCheckCountAndResize(value: string) {
    setGenTimeCheckCount(value);
    const n = Math.max(0, Math.min(20, parseInt(value, 10) || 0));
    setGenTimeChecks(prev => {
      const next = prev.slice(0, n);
      while (next.length < n) next.push({ name: "", durations: {} });
      return next;
    });
  }

  // Keep the per-test name list in sync with the requested count, preserving
  // any names the organizer already typed.
  function setGenTestCountAndResize(value: string) {
    setGenTestCount(value);
    const n = Math.max(0, Math.min(50, parseInt(value, 10) || 0));
    setGenTestNames(prev => {
      const next = prev.slice(0, n);
      while (next.length < n) next.push("");
      return next;
    });
  }

  // Add moto dialog
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addForm, setAddForm] = useState({
    name: "",
    raceClass: "",
    type: "heat" as typeof MOTO_TYPES[number],
    lapCount: "",
    enduroHasRfidStart: false,
  });
  const [addSelectedRiders, setAddSelectedRiders] = useState<number[]>([]);

  // Add practice dialog
  const [showPracticeDialog, setShowPracticeDialog] = useState(false);
  const [practiceForm, setPracticeForm] = useState({
    name: "",
    selectedClasses: [] as string[],
    mode: "lap_count" as "lap_count" | "countdown",
    lapCount: "3",
    countdownMinutes: "15",
    maxRidersPerSession: "",
  });

  // ── Event rules data ──
  // Already computed above as isSupercrossFormat

  // ── Class run order state ──
  const [classOrderState, setClassOrderState] = useState<string[]>([]);
  const [classOrderSaveStatus, setClassOrderSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const classOrderSeededRef = useRef<number | null>(null);
  const classOrderSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // ── Delete confirm state ──
  const [deleteConfirmMotoId, setDeleteConfirmMotoId] = useState<number | null>(null);
  const [deleteAllConfirmOpen, setDeleteAllConfirmOpen] = useState(false);
  const [staggerPendingGroup, setStaggerPendingGroup] = useState<{ orderedMotoIds: number[] } | null>(null);
  const [staggerSelectMode, setStaggerSelectMode] = useState(false);
  const [staggerSelected, setStaggerSelected] = useState<number[]>([]);

  // ── Mutations ──
  const reorderMutation = useReorderMotos();
  const updateMutation = useUpdateMoto();
  const createMutation = useCreateMoto();
  const generateMutation = useGenerateLineups();
  const updateEventMutation = useUpdateEvent();
  const advanceToMainMutation = useAdvanceToMain();
  const deleteMutation = useDeleteMoto();
  const deleteAllMutation = useDeleteAllMotos();
  const linkStaggerMutation = useLinkStagger();
  const unlinkStaggerMutation = useUnlinkStagger();
  const setTimeChecksMutation = useSetEnduroTimeChecks();

  // Existing time checks (used to pre-fill the dialog when reopened)
  const { data: existingTimeChecks } = useListEnduroTimeChecks(eventId, {
    query: { enabled: !!eventId } as any,
  });

  // Penalty summary (enduro only — fetched when time checks exist)
  const hasTimeChecks = ((existingTimeChecks as any[] | undefined) ?? []).length > 0;
  const hasPenaltyConfig = !!(event as any)?.enduroPenaltyConfig;
  const { data: penaltySummary = [] } = useGetEnduroPenaltySummary(eventId, {
    query: { enabled: isEnduro && hasTimeChecks && hasPenaltyConfig } as any,
  });

  // Checkpoint arrivals (for the selected time check in the arrivals panel)
  const { data: checkpointArrivals = [] } = useListCheckpointArrivals(
    eventId,
    arrivalPanelCheckId ?? 0,
    { query: { enabled: isEnduro && !!arrivalPanelCheckId } as any },
  );
  const recordArrivalMutation = useRecordCheckpointArrival();
  const deleteArrivalMutation = useDeleteCheckpointArrival();

  async function handleRecordArrival() {
    if (!arrivalPanelCheckId || !arrivalRiderId.trim() || !arrivalTime.trim()) return;
    setArrivalSaving(true);
    try {
      // Build a full ISO timestamp: use today's date + the entered HH:MM time
      const today = new Date().toISOString().slice(0, 10);
      const iso = `${today}T${arrivalTime}:00`;
      await recordArrivalMutation.mutateAsync({
        eventId,
        checkId: arrivalPanelCheckId,
        data: { riderId: Number(arrivalRiderId), arrivalTime: iso } as any,
      });
      queryClient.invalidateQueries({ queryKey: getListCheckpointArrivalsQueryKey(eventId, arrivalPanelCheckId) });
      queryClient.invalidateQueries({ queryKey: getGetEnduroPenaltySummaryQueryKey(eventId) });
      setArrivalRiderId("");
      setArrivalTime("");
    } finally {
      setArrivalSaving(false);
    }
  }

  async function handleDeleteArrival(checkId: number, riderId: number) {
    await deleteArrivalMutation.mutateAsync({ eventId, checkId, riderId });
    queryClient.invalidateQueries({ queryKey: getListCheckpointArrivalsQueryKey(eventId, checkId) });
    queryClient.invalidateQueries({ queryKey: getGetEnduroPenaltySummaryQueryKey(eventId) });
  }

  // Pre-fill the time-checks section from saved data when the dialog opens.
  useEffect(() => {
    if (!isGenerateOpen) return;
    const checks = (existingTimeChecks as any[] | undefined) ?? [];
    if (checks.length === 0) return;
    setGenTimeChecksEnabled(true);
    setGenTimeCheckCount(String(checks.length));
    setGenTimeChecks(
      checks.map((c: any) => {
        const durations: Record<string, string> = {};
        for (const t of (c.targets as any[] | undefined) ?? []) {
          if (t?.raceClass) durations[t.raceClass] = msToHm(Number(t.durationMs) || 0);
        }
        return { name: typeof c.name === "string" ? c.name : "", durations };
      }),
    );
    // Restore per-class start times from the first checkpoint's targets.
    const firstTargets: any[] = (checks[0]?.targets as any[] | undefined) ?? [];
    const starts: Record<string, string> = {};
    for (const t of firstTargets) {
      if (t?.raceClass && typeof t.startTimeOfDay === "string" && t.startTimeOfDay.trim()) {
        starts[t.raceClass] = t.startTimeOfDay.trim();
      }
    }
    if (Object.keys(starts).length > 0) setClassStartTimes(starts);
    // Pre-fill penalty config from the saved event data
    const penaltyCfg = (event as any)?.enduroPenaltyConfig;
    if (penaltyCfg) {
      setPenaltyEnabled(true);
      setPenaltyEarlySecPerMin(String(penaltyCfg.earlySecPerMin ?? 0));
      setPenaltyLateSecPerMin(String(penaltyCfg.lateSecPerMin ?? 0));
      setPenaltyEarlyDqMin(penaltyCfg.earlyDqMinutes != null ? String(penaltyCfg.earlyDqMinutes) : "");
      setPenaltyLateDqMin(penaltyCfg.lateDqMinutes != null ? String(penaltyCfg.lateDqMinutes) : "");
      if (penaltyCfg.timezone) setClassTimezone(penaltyCfg.timezone);
    }
    // Only re-run when the dialog opens, not on every data refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGenerateOpen]);

  // ── Checkpoint reader assignments (enduro only) ──
  // Local state: motoId → { startReaderId, startAntennaId, finishReaderId, finishAntennaId }
  //              timeCheckId → { readerId, antennaId }
  const [motoRdrs, setMotoRdrs] = useState<Record<number, { startReaderId: string; startAntennaId: string; finishReaderId: string; finishAntennaId: string }>>({});
  const [tcRdrs, setTcRdrs] = useState<Record<number, { readerId: string; antennaId: string }>>({});
  // Per-moto: true when the test starts and finishes at the same location (single reader for both roles)
  const [motoSameReader, setMotoSameReader] = useState<Record<number, boolean>>({});

  const { data: clubReaders = [] } = useListReaders({ query: { enabled: isEnduro } as any });
  const { data: existingAssignments = [] } = useListEventReaderAssignments(eventId, {
    query: { enabled: isEnduro && !!eventId } as any,
  });
  const setAssignmentsMutation = useSetEventReaderAssignments();

  // Sync saved assignments → local state whenever they load
  useEffect(() => {
    const assignments = (existingAssignments as any[]);
    if (!assignments?.length) return;
    const newMoto: typeof motoRdrs = {};
    const newTc: typeof tcRdrs = {};
    for (const a of assignments) {
      if (a.role === "start" && a.motoId) {
        newMoto[a.motoId] = { ...newMoto[a.motoId], startReaderId: String(a.readerId), startAntennaId: a.antennaId != null ? String(a.antennaId) : "", finishReaderId: newMoto[a.motoId]?.finishReaderId ?? "", finishAntennaId: newMoto[a.motoId]?.finishAntennaId ?? "" };
      } else if (a.role === "finish" && a.motoId) {
        newMoto[a.motoId] = { ...newMoto[a.motoId], finishReaderId: String(a.readerId), finishAntennaId: a.antennaId != null ? String(a.antennaId) : "", startReaderId: newMoto[a.motoId]?.startReaderId ?? "", startAntennaId: newMoto[a.motoId]?.startAntennaId ?? "" };
      } else if (a.role === "time_check" && a.timeCheckId) {
        newTc[a.timeCheckId] = { readerId: String(a.readerId), antennaId: a.antennaId != null ? String(a.antennaId) : "" };
      }
    }
    // Auto-detect same-gate: if start and finish readerId match for a moto, check the box
    const newSameReader: Record<number, boolean> = {};
    for (const [motoIdStr, cfg] of Object.entries(newMoto)) {
      if (cfg.startReaderId && cfg.startReaderId === cfg.finishReaderId) {
        newSameReader[Number(motoIdStr)] = true;
      }
    }
    setMotoRdrs(newMoto);
    setTcRdrs(newTc);
    setMotoSameReader(newSameReader);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingAssignments]);

  async function saveReaderAssignments() {
    const assignments: Array<{ readerId: number; antennaId: number | null; role: string; motoId: number | null; timeCheckId: number | null }> = [];
    for (const [motoIdStr, cfg] of Object.entries(motoRdrs)) {
      const motoId = Number(motoIdStr);
      const sameGate = motoSameReader[motoId] ?? false;
      // When same-gate is on, use startReaderId for both roles so the backend detects the pair
      const effectiveFinishReaderId = sameGate ? cfg.startReaderId : cfg.finishReaderId;
      const effectiveFinishAntennaId = sameGate ? cfg.startAntennaId : cfg.finishAntennaId;
      if (cfg.startReaderId) assignments.push({ readerId: Number(cfg.startReaderId), antennaId: cfg.startAntennaId ? Number(cfg.startAntennaId) : null, role: "start", motoId, timeCheckId: null });
      if (effectiveFinishReaderId) assignments.push({ readerId: Number(effectiveFinishReaderId), antennaId: effectiveFinishAntennaId ? Number(effectiveFinishAntennaId) : null, role: "finish", motoId, timeCheckId: null });
    }
    for (const [tcIdStr, cfg] of Object.entries(tcRdrs)) {
      if (cfg.readerId) assignments.push({ readerId: Number(cfg.readerId), antennaId: cfg.antennaId ? Number(cfg.antennaId) : null, role: "time_check", motoId: null, timeCheckId: Number(tcIdStr) });
    }
    try {
      await setAssignmentsMutation.mutateAsync({ eventId, data: { assignments } as any });
      queryClient.invalidateQueries({ queryKey: getListEventReaderAssignmentsQueryKey(eventId) });
      toast({ title: "Reader assignments saved" });
    } catch {
      toast({ title: "Failed to save reader assignments", variant: "destructive" });
    }
  }

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

  // ── Reset min-lap + class-order state when navigating between events ──
  useEffect(() => {
    setMinLapInput("");
    seededForEventIdRef.current = null;
    lastCommittedRef.current = null;
    pendingSaveRef.current = null;
    isSavingRef.current = false;
    setClassOrderState([]);
    classOrderSeededRef.current = null;
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

  // ── Seed classOrder from event data exactly once per eventId ──
  useEffect(() => {
    if (!event) return;
    const currentEventId = (event as any).id as number;
    if (classOrderSeededRef.current === currentEventId) return;
    classOrderSeededRef.current = currentEventId;
    const savedOrder: string[] | null | undefined = (event as any)?.classOrder;
    const allClasses: string[] = (event?.raceClasses as string[] | undefined) ?? [];
    if (savedOrder && savedOrder.length > 0) {
      const ordered = savedOrder.filter((c: string) => allClasses.includes(c));
      const remaining = allClasses.filter(c => !ordered.includes(c));
      setClassOrderState([...ordered, ...remaining]);
    } else {
      setClassOrderState([...allClasses]);
    }
  }, [event]);

  function saveClassOrder(order: string[]) {
    if (classOrderSavedTimerRef.current) clearTimeout(classOrderSavedTimerRef.current);
    setClassOrderSaveStatus('saving');
    updateEventMutation.mutate(
      { eventId, data: { classOrder: order } as any },
      {
        onSuccess: () => {
          setClassOrderSaveStatus('saved');
          classOrderSavedTimerRef.current = setTimeout(() => setClassOrderSaveStatus('idle'), 2000);
        },
        onError: () => {
          setClassOrderSaveStatus('error');
          // Auto-clear after 8 s so the badge doesn't stick around permanently
          classOrderSavedTimerRef.current = setTimeout(() => setClassOrderSaveStatus('idle'), 8000);
        },
      },
    );
  }

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
    const motos = [...rawMotos];
    if (isCrossCountry) {
      // For cross-country / hare-and-hound: sort by (group primary's moto_number, staggered_order)
      // so the entire A-wave sorts before B-wave even when individual moto_numbers are out of order.
      const groupPrimaryNum = new Map<number, number>();
      for (const m of motos) {
        if ((m as any).staggeredGroupId && (m as any).staggeredOrder === 1) {
          groupPrimaryNum.set((m as any).staggeredGroupId, m.motoNumber ?? 0);
        }
      }
      motos.sort((a, b) => {
        const aGid = (a as any).staggeredGroupId as number | null;
        const bGid = (b as any).staggeredGroupId as number | null;
        const aKey = aGid ? (groupPrimaryNum.get(aGid) ?? a.motoNumber ?? 0) : (a.motoNumber ?? 0);
        const bKey = bGid ? (groupPrimaryNum.get(bGid) ?? b.motoNumber ?? 0) : (b.motoNumber ?? 0);
        if (aKey !== bKey) return aKey - bKey;
        return ((a as any).staggeredOrder ?? 0) - ((b as any).staggeredOrder ?? 0);
      });
    } else {
      motos.sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));
    }
    if (!localOrder) return motos;
    const map = new Map(motos.map(m => [m.id, m]));
    return localOrder.map(id => map.get(id)).filter(Boolean) as Moto[];
  })();

  // ── Multi-class conflict detection ──
  const scheduleConflicts = useScheduleConflicts(rawMotos);

  // ── Round derivation ──
  // Round number comes from the moto name ("Moto N" → N) rather than sequential
  // position within a class, so Div 1 Moto 1 and Div 2 Moto 1 both map to round 1.
  const { roundMap, maxRounds } = useMemo(() => {
    const raceMotos = rawMotos.filter(m => m.type !== "practice");
    const map = new Map<number, number>();
    for (const m of raceMotos) {
      const nameMatch = (m.name ?? "").match(/\bMoto\s+(\d+)\b/i);
      const round = nameMatch ? parseInt(nameMatch[1]) : (m.type === "main" ? 2 : 1);
      map.set(m.id, round);
    }
    const max = map.size ? Math.max(...map.values()) : 0;
    return { roundMap: map, maxRounds: max };
  }, [rawMotos]);

  // ── Filtered motos (by round) ──
  const hasPracticeMotos = rawMotos.some(m => m.type === "practice");
  const filteredMotos: Moto[] = roundFilter === "all"
    ? sortedMotos
    : roundFilter === "practice"
      ? sortedMotos.filter(m => m.type === "practice")
      : sortedMotos.filter(m => m.type !== "practice" && roundMap.get(m.id) === roundFilter);

  // ── Stable global race-number map ──
  // Compute each moto's position in the full day's run order (excluding stagger-2 motos),
  // so the number shown on each card never changes when a filter pill is active.
  const globalMotoIndexMap = useMemo(() => {
    // Cross-country: all motos are individually listed in run order (no stagger collapsing)
    const allVisible = isCrossCountry
      ? sortedMotos
      : sortedMotos.filter(m => {
          const gid = (m as any).staggeredGroupId;
          const ord = (m as any).staggeredOrder;
          return !(gid && ord > 1);
        });
    return new Map(allVisible.map((m, i) => [m.id, i]));
  }, [sortedMotos, isCrossCountry]);

  // ── DnD sensors ──
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  // ── Toggle moto expand/collapse ──
  const toggleMotoExpand = useCallback((motoId: number) => {
    setExpandedMotos(prev => {
      const next = new Set(prev);
      if (next.has(motoId)) next.delete(motoId); else next.add(motoId);
      return next;
    });
  }, []);

  // ── Remove rider from moto lineup ──
  const handleRemoveRider = useCallback((motoId: number, riderId: number) => {
    const moto = rawMotos.find(m => m.id === motoId);
    if (!moto) return;
    const lineup = (Array.isArray(moto.lineup) ? [...moto.lineup as LineupEntry[]] : [])
      .filter(e => e.riderId !== riderId)
      .map((e, i) => ({ ...e, position: i + 1 }));
    updateMutation.mutate(
      { motoId, data: { lineup: lineup as any } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) as any });
          toast({ title: "Rider removed" });
        },
        onError: () => toast({ title: "Failed to remove rider", variant: "destructive" }),
      }
    );
  }, [rawMotos, updateMutation, queryClient, eventId, toast]);

  // ── Move rider between motos ──
  const moveRiderBetweenMotos = useCallback((
    sourceMotoId: number, targetMotoId: number, riderId: number, beforeRiderId?: number
  ) => {
    const sourceMoto = rawMotos.find(m => m.id === sourceMotoId);
    const targetMoto = rawMotos.find(m => m.id === targetMotoId);
    if (!sourceMoto || !targetMoto) return;
    if (targetMoto.status === "completed" || sourceMoto.status === "completed") {
      toast({ title: "Cannot move riders in completed motos", variant: "destructive" });
      return;
    }
    const sourceLineup = Array.isArray(sourceMoto.lineup) ? [...sourceMoto.lineup as LineupEntry[]] : [];
    const entry = sourceLineup.find(e => e.riderId === riderId);
    if (!entry) return;
    const newSourceLineup = sourceLineup
      .filter(e => e.riderId !== riderId)
      .map((e, i) => ({ ...e, position: i + 1 }));
    const targetLineup = Array.isArray(targetMoto.lineup) ? [...targetMoto.lineup as LineupEntry[]] : [];
    let newTargetLineup: LineupEntry[];
    if (beforeRiderId !== undefined) {
      const insertIdx = targetLineup.findIndex(e => e.riderId === beforeRiderId);
      const idx = insertIdx === -1 ? targetLineup.length : insertIdx;
      newTargetLineup = [
        ...targetLineup.slice(0, idx),
        { ...entry, position: idx + 1 },
        ...targetLineup.slice(idx),
      ].map((e, i) => ({ ...e, position: i + 1 }));
    } else {
      newTargetLineup = [...targetLineup, { ...entry, position: targetLineup.length + 1 }];
    }
    updateMutation.mutate(
      { motoId: sourceMotoId, data: { lineup: newSourceLineup as any } },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) as any }) }
    );
    updateMutation.mutate(
      { motoId: targetMotoId, data: { lineup: newTargetLineup as any } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) as any });
          toast({ title: `Rider moved to ${targetMoto.name}` });
        },
        onError: () => toast({ title: "Failed to move rider", variant: "destructive" }),
      }
    );
  }, [rawMotos, updateMutation, queryClient, eventId, toast]);

  // ── DnD: drag start ──
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const idStr = String(event.active.id);
    if (idStr.startsWith("pool-")) {
      const riderId = parseInt(idStr.replace("pool-", ""));
      const c = checkins.find(c => c.riderId === riderId);
      setActiveDrag(c ? { riderName: c.riderName ?? "Rider", bibNumber: c.bibNumber, source: "pool" } : null);
      return;
    }
    if (idStr.startsWith("lrider-")) {
      const parts = idStr.split("-");
      const motoId = parseInt(parts[1]);
      const riderId = parseInt(parts[2]);
      const moto = rawMotos.find(m => m.id === motoId);
      if (moto) {
        const lu = Array.isArray(moto.lineup) ? moto.lineup as LineupEntry[] : [];
        const e = lu.find(x => x.riderId === riderId);
        if (e) setActiveDrag({ riderName: e.riderName, bibNumber: e.bibNumber, source: "lineup" });
      }
      return;
    }
    // Moto card drag (numeric id)
    const numId = Number(event.active.id);
    if (!isNaN(numId)) {
      setActiveDrag({ riderName: "", source: "moto", motoId: numId });
    }
  }, [checkins, rawMotos]);

  // ── DnD: drag over (track which moto a pool/lineup rider hovers) ──
  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    const idStr = String(active.id);
    if (!idStr.startsWith("pool-") && !idStr.startsWith("lrider-")) {
      setActivePoolOverMotoId(null);
      return;
    }
    if (!over) { setActivePoolOverMotoId(null); return; }
    if (typeof over.id === "number") {
      setActivePoolOverMotoId(over.id as number);
    } else if (String(over.id).startsWith("lrider-")) {
      // Hovering over a lineup row inside a moto — highlight that moto card
      const motoId = parseInt(String(over.id).split("-")[1]);
      setActivePoolOverMotoId(isNaN(motoId) ? null : motoId);
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

    // ── Lineup rider: within-moto reorder, cross-moto move, or return to pool ──
    if (idStr.startsWith("lrider-")) {
      const parts = idStr.split("-");
      const sourceMotoId = parseInt(parts[1]);
      const riderId = parseInt(parts[2]);
      const overStr = String(over.id);

      // Dropped on pool → remove from moto
      if (overStr === "pool-drop-zone") {
        handleRemoveRider(sourceMotoId, riderId);
        return;
      }

      if (overStr.startsWith("lrider-")) {
        const targetMotoId = parseInt(overStr.split("-")[1]);
        const targetRiderId = parseInt(overStr.split("-")[2]);
        if (sourceMotoId === targetMotoId) {
          // Reorder within moto → gates update automatically by position
          const moto = rawMotos.find(m => m.id === sourceMotoId);
          if (!moto) return;
          const lineup = Array.isArray(moto.lineup) ? [...moto.lineup as LineupEntry[]] : [];
          const fromIdx = lineup.findIndex(e => e.riderId === riderId);
          const toIdx = lineup.findIndex(e => e.riderId === targetRiderId);
          if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
          const newLineup = arrayMove(lineup, fromIdx, toIdx).map((e, i) => ({ ...e, position: i + 1 }));
          updateMutation.mutate(
            { motoId: sourceMotoId, data: { lineup: newLineup as any } },
            { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) as any }) }
          );
        } else {
          moveRiderBetweenMotos(sourceMotoId, targetMotoId, riderId, targetRiderId);
        }
      } else if (typeof over.id === "number") {
        const targetMotoId = over.id as number;
        if (sourceMotoId !== targetMotoId) {
          moveRiderBetweenMotos(sourceMotoId, targetMotoId, riderId);
        }
      }
      return;
    }

    // Pool rider dropped onto a moto card (or a lineup row inside it)
    if (idStr.startsWith("pool-")) {
      const riderId = parseInt(idStr.replace("pool-", ""));
      // Resolve target moto id: direct card drop (numeric) or hover over lineup row (lrider-{motoId}-...)
      let targetMotoId: number;
      if (typeof over.id === "number") {
        targetMotoId = over.id;
      } else if (String(over.id).startsWith("lrider-")) {
        targetMotoId = parseInt(String(over.id).split("-")[1]);
        if (isNaN(targetMotoId)) return;
      } else {
        return;
      }
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

    // Stagger drop — moto dragged onto another moto's stagger zone
    const overStr2 = String(over.id);
    if (overStr2.startsWith("stagger-") && typeof active.id === "number") {
      const targetMotoId = parseInt(overStr2.replace("stagger-", ""));
      if (!isNaN(targetMotoId) && active.id !== targetMotoId) {
        const draggedMoto = rawMotos.find(m => m.id === (active.id as number));
        const targetMoto = rawMotos.find(m => m.id === targetMotoId);
        // If either is already in a group, seed dialog with that group + the new moto
        const existingGroupMembers: number[] =
          (draggedMoto as any)?.staggeredGroupMembers ||
          (targetMoto as any)?.staggeredGroupMembers || [];
        let seedIds: number[];
        if (existingGroupMembers.length > 0) {
          const extra = [active.id as number, targetMotoId].find(id => !existingGroupMembers.includes(id));
          seedIds = extra ? [...existingGroupMembers, extra] : existingGroupMembers;
        } else {
          seedIds = [active.id as number, targetMotoId];
        }
        setStaggerPendingGroup({ orderedMotoIds: seedIds });
        return;
      }
    }

    // Moto reorder — round-filter-aware
    if (active.id === over.id) return;
    const filteredIds = filteredMotos.map(m => m.id);
    const oldIndex = filteredIds.indexOf(active.id as number);
    const newIndex = filteredIds.indexOf(over.id as number);
    if (oldIndex === -1 || newIndex === -1) return;
    const newFilteredIds = arrayMove(filteredIds, oldIndex, newIndex);

    // Merge new filtered order back into full sorted order, preserving hidden moto positions
    const filteredSet = new Set(filteredIds);
    let filteredCursor = 0;
    const newFullOrder = sortedMotos.map(m =>
      filteredSet.has(m.id) ? newFilteredIds[filteredCursor++] : m.id
    );

    setLocalOrder(newFullOrder);

    reorderMutation.mutate(
      { eventId, data: { motoIds: newFullOrder } },
      {
        onSuccess: () => {
          queryClient.refetchQueries({ queryKey: getListMotosQueryKey(eventId) as any }).then(() => {
            setLocalOrder(null);
          });
        },
        onError: () => {
          setLocalOrder(null);
          toast({ title: "Failed to save order", variant: "destructive" });
        },
      }
    );
  }, [rawMotos, filteredMotos, sortedMotos, checkins, eventId, updateMutation, reorderMutation, queryClient, toast, moveRiderBetweenMotos, handleRemoveRider]);

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
    // Guard: block generation after the race date has passed.
    const eventRaceDate = ((event as any)?.endDate ?? (event as any)?.date) as string | undefined;
    if (eventRaceDate) {
      const effectiveDate = eventRaceDate.substring(0, 10);
      const todayStr = new Date().toISOString().substring(0, 10);
      if (effectiveDate < todayStr) {
        toast({
          title: "Race date has passed",
          description: "Change the event's race date to a future date before generating motos.",
          variant: "destructive",
        });
        return;
      }
    }

    const allClasses: string[] = (event?.raceClasses as string[] | undefined) ?? [];
    // Apply saved class run order when generating all classes
    const orderedAllClasses = classOrderState.length > 0
      ? [...classOrderState.filter(c => allClasses.includes(c)), ...allClasses.filter(c => !classOrderState.includes(c))]
      : allClasses;
    const classesToUse = generateClass === "all" ? orderedAllClasses : [generateClass];
    const lockedClasses = generateGateMethod === "prior_round_finish"
      ? []
      : classesToUse.filter(cls => rawMotos.some(m => m.raceClass === cls && m.status === "completed"));
    const ridersPerHeatVal = ridersPerHeat.trim() ? parseInt(ridersPerHeat, 10) : undefined;
    const lapCountVal = generateLapCount.trim() ? parseInt(generateLapCount, 10) : undefined;
    const timeLimitMsVal = generateTimeLimitMins.trim() ? Math.round(parseFloat(generateTimeLimitMins) * 60 * 1000) : undefined;
    const plusLapsVal = timeLimitMsVal != null ? (generatePlusLaps.trim() ? parseInt(generatePlusLaps, 10) : 1) : undefined;
    const divCount = generateFormat === "three_moto" ? 3 : generateFormat === "two_moto" ? 2 : 1;
    const roundsToSend = generateSelectedRounds.length > 0 && generateSelectedRounds.length < divCount
      ? generateSelectedRounds
      : undefined;

    generateMutation.mutate(
      {
        eventId,
        data: {
          raceFormat: generateFormat,
          classes: classesToUse,
          ridersPerHeat: ridersPerHeatVal,
          lapCount: lapCountVal,
          ...(timeLimitMsVal != null ? { timeLimitMs: timeLimitMsVal, plusLaps: plusLapsVal } : {}),
          gatePickMethod: generateGateMethod,
          rounds: roundsToSend,
          ...(generateMinRacesBetween > 0 ? { minRacesBetween: generateMinRacesBetween } : {}),
          ...(noneCheckedIn ? { useRegistrations: true } : {}),
        } as any,
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          queryClient.invalidateQueries({ queryKey: getListCheckinsQueryKey(eventId) as any });
          setIsGenerateOpen(false);
          if (generateGateMethod === "prior_round_finish") {
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
          toast({ title: "Failed to generate", description: (err as Error).message, variant: "destructive" });
        },
      }
    );
  }

  // ── Generate enduro tests ──
  async function handleGenerateTests() {
    const count = Math.max(1, Math.min(50, parseInt(genTestCount, 10) || 1));
    const prefix = genTestPrefix.trim() || "Test";
    const laps = genTestLaps.trim() ? parseInt(genTestLaps, 10) : undefined;
    const allClasses: string[] = (event?.raceClasses as string[] | undefined) ?? [];

    // Enduro sends every checked-in rider through each test (one at a time, not in waves).
    const lineup = (checkins as any[])
      .filter((c: any) => c.checkedIn)
      .map((c: any, i: number) => ({
        position: i + 1,
        riderId: c.riderId,
        riderName: c.riderName ?? "",
        bibNumber: c.bibNumber ?? null,
        rfidNumber: c.rfidNumber ?? null,
      }));

    if (lineup.length === 0) {
      toast({ title: "No checked-in riders", description: "Check in riders before generating tests.", variant: "destructive" });
      return;
    }

    const existingTests = rawMotos.filter(m => m.type === "enduro_test").length;
    const baseNumber = rawMotos.length > 0 ? Math.max(...rawMotos.map(m => m.motoNumber ?? 0)) : 0;

    // Create sequentially so moto numbering stays ordered and a mid-batch
    // failure reports how many tests were actually created.
    let created = 0;
    try {
      for (let idx = 0; idx < count; idx++) {
        const testNo = existingTests + idx + 1;
        const customName = (genTestNames[idx] ?? "").trim();
        await createMutation.mutateAsync({
          eventId,
          data: {
            name: customName || `${prefix} ${testNo}`,
            type: "enduro_test" as typeof MOTO_TYPES[number],
            raceClass: "All Classes",
            raceClasses: allClasses.length > 0 ? allClasses : undefined,
            motoNumber: baseNumber + idx + 1,
            lapCount: laps,
            lineup: lineup as any,
            enduroHasRfidStart: genTestRfidStart,
          } as any,
        });
        created++;
      }
      // Persist event-wide time checks (replace-all) when enabled.
      if (genTimeChecksEnabled) {
        const timeChecks = genTimeChecks.map((tc, i) => ({
          checkNumber: i + 1,
          name: tc.name.trim() || `Time Check ${i + 1}`,
          targets: allClasses
            .map(rc => ({
              raceClass: rc,
              durationMs: hmToMs(tc.durations[rc] ?? ""),
              startTimeOfDay: classStartTimes[rc]?.trim() || null,
            }))
            .filter((t): t is { raceClass: string; durationMs: number; startTimeOfDay: string | null } => t.durationMs !== null && t.durationMs > 0),
        }));
        const penaltyConfig = penaltyEnabled ? {
          earlySecPerMin: Number(penaltyEarlySecPerMin) || 0,
          lateSecPerMin: Number(penaltyLateSecPerMin) || 0,
          earlyDqMinutes: penaltyEarlyDqMin.trim() ? Number(penaltyEarlyDqMin) : null,
          lateDqMinutes: penaltyLateDqMin.trim() ? Number(penaltyLateDqMin) : null,
          timezone: classTimezone || null,
        } : null;
        await setTimeChecksMutation.mutateAsync({ eventId, data: { timeChecks, penaltyConfig } as any });
        queryClient.invalidateQueries({ queryKey: getListEnduroTimeChecksQueryKey(eventId) });
      } else if ((existingTimeChecks as any[] | undefined)?.length) {
        // Organizer turned time checks off — clear any previously saved ones.
        await setTimeChecksMutation.mutateAsync({ eventId, data: { timeChecks: [], penaltyConfig: null } as any });
        queryClient.invalidateQueries({ queryKey: getListEnduroTimeChecksQueryKey(eventId) });
      }
      queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
      setIsGenerateOpen(false);
      toast({ title: `${count} test${count > 1 ? "s" : ""} created` });
    } catch (err) {
      queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
      toast({
        title: created > 0 ? `Created ${created} of ${count} tests` : "Failed to generate tests",
        description: (err as Error).message,
        variant: "destructive",
      });
    }
  }

  // ── Add moto ──
  function handleAddMoto() {
    const motoNumber = (rawMotos.length > 0
      ? Math.max(...rawMotos.map(m => m.motoNumber ?? 0))
      : 0) + 1;

    const selectedCheckins = (checkins as any[]).filter((c: any) => addSelectedRiders.includes(c.riderId));
    const lineup = selectedCheckins.map((c: any, i: number) => ({
      position: i + 1,
      riderId: c.riderId,
      riderName: c.riderName ?? "",
      bibNumber: c.bibNumber ?? null,
      rfidNumber: c.rfidNumber ?? null,
    }));

    const effectiveType = isEnduro ? "enduro_test" : addForm.type;
    createMutation.mutate(
      {
        eventId,
        data: {
          name: addForm.name || `${addForm.raceClass} ${typeLabel(effectiveType)}`,
          type: effectiveType as typeof MOTO_TYPES[number],
          raceClass: addForm.raceClass,
          motoNumber,
          lapCount: addForm.lapCount ? parseInt(addForm.lapCount) : undefined,
          lineup: lineup.length > 0 ? (lineup as any) : undefined,
          enduroHasRfidStart: isEnduro ? addForm.enduroHasRfidStart : undefined,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setShowAddDialog(false);
          setAddForm({ name: "", raceClass: "", type: "heat", lapCount: "", enduroHasRfidStart: false });
          setAddSelectedRiders([]);
          toast({ title: isEnduro ? "Test added" : "Moto added" });
        },
        onError: () => {
          toast({ title: isEnduro ? "Failed to add test" : "Failed to add moto", variant: "destructive" });
        },
      }
    );
  }

  // ── Add practice ──
  function openPracticeDialog() {
    const practiceCount = rawMotos.filter(m => m.type === "practice").length;
    setPracticeForm({
      name: `Practice ${practiceCount + 1}`,
      selectedClasses: [],
      mode: "lap_count",
      lapCount: "3",
      countdownMinutes: "15",
      maxRidersPerSession: "",
    });
    setShowPracticeDialog(true);
  }

  function handleAddPractice() {
    const { name, selectedClasses, mode, lapCount, countdownMinutes, maxRidersPerSession } = practiceForm;
    if (selectedClasses.length === 0) {
      toast({ title: "Select at least one class", variant: "destructive" });
      return;
    }
    if (mode === "countdown") {
      const mins = parseInt(countdownMinutes, 10);
      if (!mins || mins < 1 || mins > 120) {
        toast({ title: "Duration must be between 1 and 120 minutes", variant: "destructive" });
        return;
      }
    }

    const autoName = name.trim() || `Practice ${rawMotos.filter(m => m.type === "practice").length + 1}`;
    const countdownSecs = mode === "countdown" ? parseInt(countdownMinutes, 10) * 60 : undefined;
    const lapCountNum = mode === "lap_count" && lapCount ? parseInt(lapCount, 10) : undefined;

    // ── Auto-assign mode: call generate-practice-sessions ────────────────────
    const maxNum = maxRidersPerSession ? parseInt(maxRidersPerSession, 10) : NaN;
    if (maxRidersPerSession && !isNaN(maxNum) && maxNum >= 1) {
      fetch(`/api/events/${eventId}/generate-practice-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raceClasses: selectedClasses,
          maxRidersPerSession: maxNum,
          name: autoName,
          practiceMode: mode,
          lapCount: lapCountNum,
          countdownSeconds: countdownSecs,
        }),
      })
        .then(async (r) => {
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error((err as any).error ?? "Failed to generate practice sessions");
          }
          return r.json() as Promise<unknown[]>;
        })
        .then((created) => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setShowPracticeDialog(false);
          const n = (created as unknown[]).length;
          toast({ title: n === 1 ? "Practice created with riders assigned" : `${n} practice groups created` });
        })
        .catch((err: Error) => {
          toast({ title: err.message, variant: "destructive" });
        });
      return;
    }

    // ── Manual mode: create empty practice ───────────────────────────────────
    const motoNumber = (rawMotos.length > 0
      ? Math.max(...rawMotos.map(m => m.motoNumber ?? 0))
      : 0) + 1;

    createMutation.mutate(
      {
        eventId,
        data: {
          name: autoName,
          type: "practice",
          raceClass: selectedClasses[0],
          raceClasses: selectedClasses,
          motoNumber,
          lapCount: lapCountNum,
          practiceMode: mode,
          countdownSeconds: countdownSecs,
        } as any,
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setShowPracticeDialog(false);
          toast({ title: "Practice added" });
        },
        onError: () => {
          toast({ title: "Failed to add practice", variant: "destructive" });
        },
      }
    );
  }

  // ── By-class grouping (on filtered set) ──
  const byClass = (() => {
    const map = new Map<string, Moto[]>();
    for (const m of filteredMotos) {
      const cls = m.raceClass || "(No Class)";
      if (!map.has(cls)) map.set(cls, []);
      map.get(cls)!.push(m);
    }
    return map;
  })();

  // ── Event start date display ──
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
      collisionDetection={pointerWithin}
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
          isRiderDragging={activeDrag?.source === "lineup"}
        />

        {/* ── Main content ── */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          <div className="p-6 flex gap-5 items-start">
          <div className="flex-1 min-w-0 space-y-5 min-w-0">

            {/* ── Header toolbar ── */}
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <h2 className="text-xl font-heading font-bold uppercase tracking-tight">
                  {isEnduro ? "Enduro Tests" : isCrossCountry ? "Cross Country Schedule" : "Event Schedule"}
                </h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {roundFilter === "all"
                    ? (
                      <>
                        {sortedMotos.length} {isEnduro ? "tests" : "sessions"} in run order
                        {eventStartDisplay && (
                          <span className="ml-2 text-muted-foreground/60">· {eventStartDisplay}</span>
                        )}
                      </>
                    ) : roundFilter === "practice"
                      ? `${filteredMotos.length} practice session${filteredMotos.length !== 1 ? "s" : ""}`
                      : `${sortedMotos.length} sessions · Moto ${roundFilter} (${filteredMotos.length} sessions)`
                    }
                </p>
              </div>

              <div className="flex-1" />

              {/* Stagger motos toggle (run-order only, non-enduro) */}
              {viewMode === "run-order" && !isEnduro && (
                <Button
                  variant={staggerSelectMode ? "secondary" : "outline"}
                  size="sm"
                  onClick={() => { setStaggerSelectMode(v => !v); setStaggerSelected([]); }}
                >
                  <Link2 size={14} className="mr-1.5" />
                  {staggerSelectMode ? "Cancel" : "Stagger Motos"}
                </Button>
              )}

              {/* Delete All (run-order only, only when there are non-completed motos) */}
              {viewMode === "run-order" && sortedMotos.some(m => m.status !== "completed") && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setDeleteAllConfirmOpen(true)}
                >
                  <Trash2 size={14} className="mr-1.5" /> Delete All
                </Button>
              )}

              {/* Generate Lineups (motocross) / Generate Tests (enduro) */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsGenerateOpen(true)}
              >
                <Settings size={14} className="mr-1.5" /> {isEnduro ? "Generate Tests" : "Generate Lineups"}
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

              {/* Add practice (not applicable to enduro) */}
              {!isEnduro && (
                <Button size="sm" variant="outline" onClick={openPracticeDialog}>
                  <Plus size={15} className="mr-1" /> Add Practice
                </Button>
              )}

              {/* Add moto / Add Test */}
              <Button size="sm" onClick={() => {
                if (isEnduro) {
                  setAddForm(f => ({ ...f, type: "enduro_test" as typeof MOTO_TYPES[number] }));
                }
                setShowAddDialog(true);
              }}>
                <Plus size={15} className="mr-1" /> {isEnduro ? "Add Test" : "Add Moto"}
              </Button>
            </div>

            {/* ── Stagger tip / action bar (motocross/supercross only) ── */}
            {!isEnduro && staggerSelectMode && staggerSelected.length >= 2 && (
              <div className="flex items-center gap-3 rounded-lg bg-primary/10 border border-primary/30 px-4 py-2.5">
                <Link2 size={15} className="text-primary shrink-0" />
                <span className="text-sm font-medium">{staggerSelected.length} motos selected</span>
                <div className="ml-auto">
                  <Button size="sm" onClick={() => {
                    setStaggerPendingGroup({ orderedMotoIds: staggerSelected });
                    setStaggerSelectMode(false);
                    setStaggerSelected([]);
                  }}>
                    Create Stagger Group
                  </Button>
                </div>
              </div>
            )}
            {!isEnduro && staggerSelectMode && staggerSelected.length < 2 && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground bg-primary/5 border border-primary/20 rounded-md px-3 py-2">
                <Link2 size={12} className="shrink-0 text-primary/70" />
                <span>Select 2 or more motos below, then click <strong>Create Stagger Group</strong>.</span>
              </div>
            )}

            {/* ── Cross Country info banner ── */}
            {isCrossCountry && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground bg-blue-500/10 border border-blue-500/30 rounded-md px-3 py-2">
                <Clock size={12} className="shrink-0 text-blue-400" />
                <span>Cross Country / Desert — riders are ranked by <strong>total elapsed time</strong> from session start. Lap count is not used for scoring.</span>
              </div>
            )}

            {/* ── Enduro info banner ── */}
            {isEnduro && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground bg-green-500/10 border border-green-500/30 rounded-md px-3 py-2">
                <Clock size={12} className="shrink-0 text-green-400" />
                <span>Enduro — each test is timed individually. Riders are ranked by total accumulated test time across all tests.</span>
              </div>
            )}

            {/* ── Round filter pills ── */}
            {(maxRounds > 1 || hasPracticeMotos) && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setRoundFilter("all")}
                  className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                    roundFilter === "all"
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-foreground/40"
                  }`}
                >
                  All
                </button>
                {hasPracticeMotos && (
                  <button
                    onClick={() => setRoundFilter("practice")}
                    className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                      roundFilter === "practice"
                        ? "bg-blue-500 text-white border-blue-500"
                        : "bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-foreground/40"
                    }`}
                  >
                    Practice Sessions
                  </button>
                )}
                {Array.from({ length: maxRounds }, (_, i) => i + 1).map(round => (
                  <button
                    key={round}
                    onClick={() => setRoundFilter(round)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                      roundFilter === round
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-transparent text-muted-foreground border-border hover:text-foreground hover:border-foreground/40"
                    }`}
                  >
                    Moto {round}
                  </button>
                ))}
              </div>
            )}
            {/* ── Event Rules cards ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">

              {/* Minimum Lap Time — not applicable to enduro (riders run individually against the clock) */}
              {!isEnduro && (
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
              )}

              {/* Class Run Order — drag to set the schedule order for moto generation */}
              {!isEnduro && classOrderState.length > 0 && (
                <div className="border rounded-lg bg-card overflow-hidden sm:col-span-1">
                  <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
                    <LayoutList size={13} className="text-muted-foreground shrink-0" />
                    <h3 className="font-heading font-bold uppercase tracking-wider text-xs">Class Run Order</h3>
                    <div className="ml-auto shrink-0">
                      {classOrderSaveStatus === 'saving' && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground animate-pulse">
                          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 inline-block" />
                          Saving…
                        </span>
                      )}
                      {classOrderSaveStatus === 'saved' && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-green-600 dark:text-green-400">
                          <Check size={10} />
                          Saved
                        </span>
                      )}
                      {classOrderSaveStatus === 'error' && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-destructive">
                          <span>!</span> Error —{" "}
                          <button
                            type="button"
                            className="underline underline-offset-2 hover:opacity-70"
                            onClick={() => saveClassOrder(classOrderState)}
                          >
                            retry
                          </button>
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="px-2.5 py-2.5 space-y-1.5">
                    <DndContext
                      sensors={sensors}
                      onDragEnd={(e: DragEndEvent) => {
                        const { active, over } = e;
                        if (!over || active.id === over.id) return;
                        const oldIdx = classOrderState.indexOf(String(active.id));
                        const newIdx = classOrderState.indexOf(String(over.id));
                        if (oldIdx < 0 || newIdx < 0) return;
                        const next = arrayMove(classOrderState, oldIdx, newIdx);
                        setClassOrderState(next);
                        saveClassOrder(next);
                      }}
                    >
                      <SortableContext items={classOrderState} strategy={verticalListSortingStrategy}>
                        {classOrderState.map((cls, i) => (
                          <SortableClassRow key={cls} id={cls} index={i} />
                        ))}
                      </SortableContext>
                    </DndContext>
                    <p className="text-[10px] text-muted-foreground pt-1 leading-snug">
                      Drag to set the run order. Generate Lineups will create motos in this order.
                    </p>
                  </div>
                </div>
              )}

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
            {viewMode === "run-order" && filteredMotos.length > 0 && (() => {
              // For motocross: stagger order>1 motos are rendered inside the order=1 card; exclude them.
              // For cross-country: all motos are individual start waves — show each one as its own card.
              const visibleMotos = isCrossCountry
                ? filteredMotos
                : filteredMotos.filter(m => {
                    const gid = (m as any).staggeredGroupId;
                    const ord = (m as any).staggeredOrder;
                    return !(gid && ord > 1);
                  });
              const isMotoBeingDragged = activeDrag?.source === "moto";
              return (
                <SortableContext items={visibleMotos.map(m => m.id)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-2">
                    {(() => {
                      let lastType: string | null = null;
                      return visibleMotos.map((moto, index) => {
                        const showSection = moto.type !== lastType;
                        lastType = moto.type;
                        const groupMemberIds: number[] = (moto as any).staggeredGroupMembers ?? [];
                        // Cross-country: each moto is its own card — don't nest stagger members inside
                        const staggerGroup: Moto[] = isCrossCountry
                          ? []
                          : groupMemberIds
                              .map(id => rawMotos.find(m => m.id === id))
                              .filter((m): m is Moto => !!m);
                        const globalIndex = globalMotoIndexMap.get(moto.id) ?? index;
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
                              index={globalIndex}
                              eventId={eventId}
                              isPoolDropTarget={activePoolOverMotoId === moto.id}
                              isEditing={editingNameId === moto.id}
                              editValue={nameEditValue}
                              onEditStart={() => startEditName(moto)}
                              onEditChange={setNameEditValue}
                              onEditSave={() => saveName(moto.id)}
                              onEditCancel={cancelEditName}
                              isExpanded={expandedMotos.has(moto.id)}
                              onToggleExpand={() => toggleMotoExpand(moto.id)}
                              onRemoveRider={(riderId) => handleRemoveRider(moto.id, riderId)}
                              onCountdownExpire={() => queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) })}
                              onDelete={() => setDeleteConfirmMotoId(moto.id)}
                              isMotoCardDragging={isMotoBeingDragged && activeDrag?.motoId !== moto.id}
                              staggerGroup={staggerGroup.length > 0 ? staggerGroup : undefined}
                              onUnstaggerMoto={staggerGroup.length > 0 ? (motoId: number) => {
                                unlinkStaggerMutation.mutate(
                                  { motoId },
                                  { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) as any }) }
                                );
                              } : undefined}
                              onEditStagger={staggerGroup.length > 0 ? (ids: number[]) => {
                                setStaggerPendingGroup({ orderedMotoIds: ids });
                              } : undefined}
                              isStaggerSelectMode={staggerSelectMode}
                              isStaggerSelected={staggerSelected.includes(moto.id)}
                              onStaggerToggle={() => setStaggerSelected(prev =>
                                prev.includes(moto.id) ? prev.filter(id => id !== moto.id) : [...prev, moto.id]
                              )}
                            />
                          </div>
                        );
                      });
                    })()}
                  </div>
                </SortableContext>
              );
            })()}

            {/* ── By-class view ── */}
            {viewMode === "by-class" && filteredMotos.length > 0 && (
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
                          isExpanded={expandedMotos.has(moto.id)}
                          onToggleExpand={() => toggleMotoExpand(moto.id)}
                          onRemoveRider={(riderId) => handleRemoveRider(moto.id, riderId)}
                          onCountdownExpire={() => queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) })}
                          onDelete={() => setDeleteConfirmMotoId(moto.id)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Penalty summary (enduro only, when config + time checks exist) ── */}
            {isEnduro && hasTimeChecks && hasPenaltyConfig && (penaltySummary as any[]).length > 0 && (
              <div className="mt-2 rounded-lg border bg-card">
                <div className="flex items-center justify-between px-4 py-3 border-b">
                  <div>
                    <p className="font-semibold text-sm">Checkpoint Penalty Summary</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Per-rider penalty totals based on checkpoint arrival times.</p>
                  </div>
                </div>
                <div className="p-3 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground uppercase tracking-wide">
                        <th className="text-left py-1 pr-3">Rider</th>
                        <th className="text-left py-1 pr-3">Class</th>
                        <th className="text-right py-1 pr-3">Penalty</th>
                        <th className="text-center py-1">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(penaltySummary as any[]).map((entry: any) => (
                        <tr key={entry.riderId} className="border-t border-border/50">
                          <td className="py-1.5 pr-3 font-medium">{entry.riderName}</td>
                          <td className="py-1.5 pr-3 text-muted-foreground">{entry.raceClass ?? "—"}</td>
                          <td className="py-1.5 pr-3 text-right font-mono">
                            {entry.disqualified ? "—" : entry.totalPenaltySeconds > 0 ? `+${entry.totalPenaltySeconds}s` : "0s"}
                          </td>
                          <td className="py-1.5 text-center">
                            {entry.disqualified ? (
                              <span className="inline-block rounded px-1.5 py-0.5 bg-destructive/10 text-destructive font-semibold">DQ</span>
                            ) : entry.totalPenaltySeconds > 0 ? (
                              <span className="inline-block rounded px-1.5 py-0.5 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Penalty</span>
                            ) : (
                              <span className="inline-block rounded px-1.5 py-0.5 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">Clean</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── Checkpoint arrivals management (enduro + time checks only) ── */}
            {isEnduro && hasTimeChecks && (
              <div className="mt-2 rounded-lg border bg-card">
                <div className="px-4 py-3 border-b">
                  <p className="font-semibold text-sm">Checkpoint Arrivals</p>
                  <p className="text-xs text-muted-foreground mt-0.5">View and manually record or correct rider arrival times at each time check.</p>
                </div>
                <div className="p-3 space-y-2">
                  {((existingTimeChecks as any[] | undefined) ?? []).map((tc: any) => {
                    const isOpen = arrivalPanelCheckId === tc.id;
                    return (
                      <div key={tc.id} className="rounded-md border">
                        <button
                          type="button"
                          className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted/40 transition-colors"
                          onClick={() => setArrivalPanelCheckId(isOpen ? null : tc.id)}
                        >
                          <span className="text-sm font-medium">{tc.name || `TC ${tc.checkNumber}`}</span>
                          <ChevronDown size={14} className={`text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
                        </button>
                        {isOpen && (
                          <div className="border-t p-3 space-y-3">
                            {/* Existing arrivals */}
                            {(checkpointArrivals as any[]).length > 0 ? (
                              <div className="space-y-1">
                                {(checkpointArrivals as any[]).map((a: any) => (
                                  <div key={a.id ?? a.riderId} className="flex items-center gap-2 text-xs">
                                    <span className="flex-1 font-medium truncate">{a.riderName || `Rider #${a.riderId}`}</span>
                                    <span className="font-mono text-muted-foreground">
                                      {a.arrivalTime ? new Date(a.arrivalTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground/60 uppercase">{a.recordedBy}</span>
                                    <button
                                      type="button"
                                      className="ml-1 p-0.5 text-destructive/60 hover:text-destructive rounded"
                                      onClick={() => handleDeleteArrival(tc.id, a.riderId)}
                                      title="Delete arrival"
                                    >
                                      <X size={12} />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-muted-foreground italic">No arrivals recorded yet.</p>
                            )}
                            {/* Record arrival form */}
                            <div className="space-y-2 pt-1 border-t">
                              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Record arrival</p>
                              <div className="flex gap-2 flex-wrap">
                                <Select
                                  value={arrivalRiderId || "none"}
                                  onValueChange={v => setArrivalRiderId(v === "none" ? "" : v)}
                                >
                                  <SelectTrigger className="h-7 text-xs flex-1 min-w-36">
                                    <SelectValue placeholder="Select rider…" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="none">— Select rider —</SelectItem>
                                    {(checkins as any[]).filter((c: any) => c.checkedIn).map((c: any) => (
                                      <SelectItem key={c.riderId} value={String(c.riderId)}>
                                        {c.riderName ?? `Rider #${c.riderId}`}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <Input
                                  type="time"
                                  value={arrivalTime}
                                  onChange={e => setArrivalTime(e.target.value)}
                                  className="h-7 text-xs w-28"
                                />
                                <Button
                                  size="sm"
                                  className="h-7 text-xs"
                                  disabled={!arrivalRiderId || !arrivalTime || arrivalSaving}
                                  onClick={handleRecordArrival}
                                >
                                  {arrivalSaving ? "Saving…" : "Record"}
                                </Button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Checkpoint reader assignments (enduro only) ── */}
            {isEnduro && (() => {
              const testMotos = sortedMotos.filter(m => m.type === "enduro_test");
              const timeChecks = (existingTimeChecks as any[] | undefined) ?? [];
              const readers = (clubReaders as any[]);
              if (testMotos.length === 0 && timeChecks.length === 0) return null;
              return (
                <div className="mt-2 rounded-lg border bg-card">
                  <div className="flex items-center justify-between px-4 py-3 border-b">
                    <div>
                      <p className="font-semibold text-sm">Checkpoint Readers</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Assign a registered reader to each start gate, finish line, and time check.</p>
                    </div>
                    <Button size="sm" onClick={saveReaderAssignments} disabled={setAssignmentsMutation.isPending}>
                      {setAssignmentsMutation.isPending ? "Saving…" : "Save"}
                    </Button>
                  </div>
                  <div className="p-4 space-y-4">
                    {readers.length === 0 && (
                      <p className="text-xs text-muted-foreground italic">No readers registered for this club yet. Go to <strong>RFID Setup → Registered Readers</strong> to add one.</p>
                    )}
                    {testMotos.length > 0 && (
                      <div className="space-y-3">
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Test Motos — Gates</p>
                        {testMotos.map(moto => {
                          const cfg = motoRdrs[moto.id] ?? { startReaderId: "", startAntennaId: "", finishReaderId: "", finishAntennaId: "" };
                          const sameGate = motoSameReader[moto.id] ?? false;
                          const readerSelect = (value: string, onChange: (v: string) => void) => (
                            <Select value={value || "none"} onValueChange={v => onChange(v === "none" ? "" : v)}>
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue placeholder="None" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">None</SelectItem>
                                {readers.map((r: any) => (
                                  <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          );
                          return (
                            <div key={moto.id} className="rounded-md border p-3 space-y-2">
                              <p className="text-sm font-medium">{moto.name ?? `Test ${moto.id}`}</p>
                              <div className={`grid gap-3 ${sameGate ? "grid-cols-1" : "grid-cols-2"}`}>
                                <div className="space-y-1">
                                  <Label className="text-xs text-muted-foreground">
                                    {sameGate ? "Start / Finish Reader" : "Start Reader"}
                                  </Label>
                                  {readerSelect(cfg.startReaderId, v => setMotoRdrs(prev => ({ ...prev, [moto.id]: { ...cfg, startReaderId: v } })))}
                                </div>
                                {!sameGate && (
                                  <div className="space-y-1">
                                    <Label className="text-xs text-muted-foreground">Finish Reader</Label>
                                    {readerSelect(cfg.finishReaderId, v => setMotoRdrs(prev => ({ ...prev, [moto.id]: { ...cfg, finishReaderId: v } })))}
                                  </div>
                                )}
                              </div>
                              <label className="flex items-center gap-2 cursor-pointer select-none mt-1">
                                <input
                                  type="checkbox"
                                  checked={sameGate}
                                  onChange={e => setMotoSameReader(prev => ({ ...prev, [moto.id]: e.target.checked }))}
                                  className="rounded border-border accent-primary"
                                />
                                <span className="text-xs text-muted-foreground">Start and finish are at the same location (one reader for both)</span>
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {timeChecks.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Time Checks</p>
                        {timeChecks.map((tc: any) => {
                          const cfg = tcRdrs[tc.id] ?? { readerId: "", antennaId: "" };
                          return (
                            <div key={tc.id} className="flex items-center gap-3">
                              <span className="text-sm flex-1 truncate">{tc.name || `TC ${tc.checkNumber}`}</span>
                              <Select
                                value={cfg.readerId || "none"}
                                onValueChange={v => setTcRdrs(prev => ({ ...prev, [tc.id]: { ...cfg, readerId: v === "none" ? "" : v } }))}
                              >
                                <SelectTrigger className="h-8 text-xs w-44">
                                  <SelectValue placeholder="None" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">None</SelectItem>
                                  {readers.map((r: any) => (
                                    <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

          </div>
          {/* ── Multi-class conflict panel (sticky top-right) — not applicable to enduro ── */}
          {!isEnduro && scheduleConflicts.length > 0 && (
            <div className="w-72 shrink-0 sticky top-6 self-start">
              <ScheduleConflictPanel conflicts={scheduleConflicts} />
            </div>
          )}
          </div>
        </div>
      </div>

      {/* ── DragOverlay: rider chip only (not for moto-card drags) ── */}
      {/* Lineup-within-moto reorders don't use an overlay — the sortable placeholder
          is visible at 0.25 opacity in place, leaving the drop-indicator line unobstructed. */}
      <DragOverlay>
        {activeDrag && activeDrag.source !== "lineup" && activeDrag.source !== "moto" ? (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-card border border-primary/40 rounded-lg shadow-lg text-sm opacity-95">
            <GripVertical size={12} className="text-muted-foreground/50" />
            {activeDrag.bibNumber && (
              <span className="font-mono text-xs text-muted-foreground">#{activeDrag.bibNumber}</span>
            )}
            <span className="font-medium">{activeDrag.riderName}</span>
          </div>
        ) : null}
      </DragOverlay>

      {/* ── Stagger group dialog ── */}
      {staggerPendingGroup && (() => {
        const orderedIds = staggerPendingGroup.orderedMotoIds;
        const orderedMotos = orderedIds.map(id => rawMotos.find(m => m.id === id)).filter((m): m is Moto => !!m);
        const moveMoto = (fromIdx: number, toIdx: number) => {
          setStaggerPendingGroup(prev => {
            if (!prev) return null;
            const ids = [...prev.orderedMotoIds];
            [ids[fromIdx], ids[toIdx]] = [ids[toIdx], ids[fromIdx]];
            return { orderedMotoIds: ids };
          });
        };
        const removeMoto = (motoId: number) => {
          setStaggerPendingGroup(prev => {
            if (!prev) return null;
            const ids = prev.orderedMotoIds.filter(id => id !== motoId);
            return ids.length >= 2 ? { orderedMotoIds: ids } : null;
          });
        };
        const addMoto = (motoId: number) => {
          setStaggerPendingGroup(prev => {
            if (!prev || prev.orderedMotoIds.includes(motoId)) return prev;
            return { orderedMotoIds: [...prev.orderedMotoIds, motoId] };
          });
        };
        const availableToAdd = rawMotos.filter(m =>
          !orderedIds.includes(m.id) &&
          m.type !== "practice" &&
          m.status !== "completed" &&
          !(m as any).staggeredGroupId  // exclude motos already in a different group
        );
        const ordSuffix = (n: number) => n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
        return (
          <Dialog open onOpenChange={open => { if (!open) setStaggerPendingGroup(null); }}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 font-heading uppercase tracking-wider">
                  <Link2 size={16} className="text-primary" />
                  Link Staggered Start Group
                </DialogTitle>
                <DialogDescription>
                  Set the start order. All motos run simultaneously but are scored independently.
                  Drag motos to reorder, or use the arrows.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5 py-1">
                {orderedMotos.map((m, idx) => (
                  <div key={m.id} className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-border bg-card">
                    <span className="w-7 text-center text-xs font-bold text-primary font-mono shrink-0">
                      {ordSuffix(idx + 1)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm truncate">{m.name}</div>
                      <div className="text-xs text-muted-foreground">{m.raceClass} · {typeLabel(m.type)}</div>
                    </div>
                    <div className="flex flex-col gap-0.5 shrink-0">
                      <button
                        disabled={idx === 0}
                        onClick={() => moveMoto(idx, idx - 1)}
                        className="p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        title="Move up"
                      >
                        <ChevronLeft size={13} className="rotate-90" />
                      </button>
                      <button
                        disabled={idx === orderedMotos.length - 1}
                        onClick={() => moveMoto(idx, idx + 1)}
                        className="p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        title="Move down"
                      >
                        <ChevronRight size={13} className="rotate-90" />
                      </button>
                    </div>
                    {orderedMotos.length > 2 && (
                      <button
                        onClick={() => removeMoto(m.id)}
                        className="p-1 rounded text-muted-foreground hover:text-destructive transition-colors shrink-0"
                        title="Remove from group"
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                ))}
                {availableToAdd.length > 0 && (
                  <Select onValueChange={v => addMoto(Number(v))}>
                    <SelectTrigger className="h-9 text-muted-foreground border-dashed">
                      <Plus size={13} className="mr-1.5 shrink-0" />
                      <SelectValue placeholder="Add another moto to group…" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableToAdd.map(m => (
                        <SelectItem key={m.id} value={String(m.id)}>
                          {m.name} {m.raceClass ? `(${m.raceClass})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setStaggerPendingGroup(null)}>Cancel</Button>
                <Button
                  disabled={orderedMotos.length < 2 || linkStaggerMutation.isPending}
                  onClick={() => {
                    linkStaggerMutation.mutate(
                      { eventId, data: { orderedMotoIds: orderedIds } as any },
                      {
                        onSuccess: () => {
                          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) as any });
                          toast({ title: `🔗 Stagger group linked — ${orderedIds.length} motos` });
                        },
                        onError: () => toast({ title: "Failed to link stagger", variant: "destructive" }),
                      }
                    );
                    setStaggerPendingGroup(null);
                  }}
                  className="font-heading uppercase tracking-wider gap-1.5"
                >
                  <Link2 size={13} />
                  {linkStaggerMutation.isPending ? "Linking…" : `Link Group (${orderedIds.length})`}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        );
      })()}

      {/* ── Delete moto confirmation ── */}
      <AlertDialog open={deleteConfirmMotoId !== null} onOpenChange={open => { if (!open) setDeleteConfirmMotoId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete moto?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the moto and all its lineup assignments. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteConfirmMotoId == null) return;
                const id = deleteConfirmMotoId;
                setDeleteConfirmMotoId(null);
                deleteMutation.mutate(
                  { motoId: id } as any,
                  {
                    onSuccess: () => {
                      // Compact motoNumber values so race day management stays in sync
                      const remaining = [...rawMotos]
                        .filter(m => m.id !== id)
                        .sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0))
                        .map(m => m.id);
                      if (remaining.length > 0) {
                        reorderMutation.mutate(
                          { eventId, data: { motoIds: remaining } } as any,
                          { onSettled: () => queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) }) }
                        );
                      } else {
                        queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
                      }
                      toast({ title: "Moto deleted" });
                    },
                    onError: () => toast({ title: "Failed to delete moto", variant: "destructive" }),
                  }
                );
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete ALL motos confirmation ── */}
      <AlertDialog open={deleteAllConfirmOpen} onOpenChange={setDeleteAllConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all motos?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete every non-completed moto and all their lineup assignments.
              Completed motos will not be affected. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setDeleteAllConfirmOpen(false);
                deleteAllMutation.mutate(
                  { eventId } as any,
                  {
                    onSuccess: () => {
                      queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
                      toast({ title: "All motos deleted" });
                    },
                    onError: () => toast({ title: "Failed to delete motos", variant: "destructive" }),
                  }
                );
              }}
            >
              Delete All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Generate Lineups dialog ── */}
      <Dialog open={isGenerateOpen} onOpenChange={open => { setIsGenerateOpen(open); if (open) { setGenerateClass("all"); setGenerateSelectedRounds([]); } }}>
        <DialogContent className="sm:max-w-md flex flex-col max-h-[90vh]">
          <DialogHeader className="shrink-0">
            <DialogTitle className="font-heading uppercase text-xl">{isEnduro ? "Generate Tests" : "Generate Lineups"}</DialogTitle>
            <DialogDescription>
              {isEnduro
                ? "Create timed enduro tests. Every checked-in rider runs each test one at a time."
                : "Auto-create motos from checked-in riders for all race classes."}
            </DialogDescription>
          </DialogHeader>

          {isEnduro ? (
            <div className="space-y-5 py-2 overflow-y-auto flex-1 min-h-0 pr-1">
              {/* Number of tests */}
              <div className="space-y-2">
                <Label>Number of Tests</Label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={genTestCount}
                  onChange={e => setGenTestCountAndResize(e.target.value)}
                  placeholder="e.g. 3"
                  className="h-9"
                />
                <p className="text-xs text-muted-foreground">
                  How many timed test sections to create. Name each one individually below.
                </p>
              </div>

              {/* Default name prefix */}
              <div className="space-y-2">
                <Label>Default Name Prefix</Label>
                <div className="flex gap-2">
                  <Input
                    value={genTestPrefix}
                    onChange={e => setGenTestPrefix(e.target.value)}
                    placeholder="Test"
                    className="h-9"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 shrink-0"
                    onClick={() => {
                      const p = genTestPrefix.trim() || "Test";
                      setGenTestNames(prev => prev.map((_, i) => `${p} ${i + 1}`));
                    }}
                  >
                    Apply to all
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Used as the placeholder for each test. Click <strong>Apply to all</strong> to fill every name as <strong>{(genTestPrefix.trim() || "Test")} 1</strong>, <strong>{(genTestPrefix.trim() || "Test")} 2</strong>…
                </p>
              </div>

              {/* Per-test names */}
              {genTestNames.length > 0 && (
                <div className="space-y-2">
                  <Label>Test Names</Label>
                  <div className="space-y-2 rounded-lg border p-3 max-h-56 overflow-y-auto">
                    {genTestNames.map((name, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-6 shrink-0 text-right">{i + 1}.</span>
                        <Input
                          value={name}
                          onChange={e => {
                            const v = e.target.value;
                            setGenTestNames(prev => prev.map((n, idx) => idx === i ? v : n));
                          }}
                          placeholder={`${genTestPrefix.trim() || "Test"} ${i + 1}`}
                          className="h-9"
                        />
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Give each test its own name. Leave a field blank to use the default (<strong>{genTestPrefix.trim() || "Test"} #</strong>).
                  </p>
                </div>
              )}

              {/* Laps per test */}
              <div className="space-y-2">
                <Label>Laps per Test</Label>
                <Input
                  type="number"
                  min={1}
                  value={genTestLaps}
                  onChange={e => setGenTestLaps(e.target.value)}
                  placeholder="1"
                  className="h-9"
                />
                <p className="text-xs text-muted-foreground">
                  How many laps of each test a rider completes. Most enduros use 1; some allow multiple.
                </p>
              </div>

              {/* RFID start mode */}
              <div className="space-y-2">
                <Label>Timing Mode</Label>
                <div className="rounded-lg border divide-y overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setGenTestRfidStart(true)}
                    className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors ${genTestRfidStart ? "bg-primary/5" : "hover:bg-muted/40"}`}
                  >
                    <div className={`mt-0.5 h-4 w-4 rounded-full border-2 flex items-center justify-center shrink-0 ${genTestRfidStart ? "border-primary" : "border-muted-foreground/40"}`}>
                      {genTestRfidStart && <div className="h-2 w-2 rounded-full bg-primary" />}
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{timingLabel} at start &amp; finish</p>
                      <p className="text-xs text-muted-foreground">Rider's transponder starts the clock at the test entrance and stops it at the finish — fully automatic.</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setGenTestRfidStart(false)}
                    className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors ${!genTestRfidStart ? "bg-primary/5" : "hover:bg-muted/40"}`}
                  >
                    <div className={`mt-0.5 h-4 w-4 rounded-full border-2 flex items-center justify-center shrink-0 ${!genTestRfidStart ? "border-primary" : "border-muted-foreground/40"}`}>
                      {!genTestRfidStart && <div className="h-2 w-2 rounded-full bg-primary" />}
                    </div>
                    <div>
                      <p className="text-sm font-semibold">Manual start, {timingLabel} finish</p>
                      <p className="text-xs text-muted-foreground">Enter the rider's number at the start to kick off their time; the finish transponder stops it automatically.</p>
                    </div>
                  </button>
                </div>
              </div>

              {/* Time checks */}
              {(() => {
                const allClasses: string[] = (event?.raceClasses as string[] | undefined) ?? [];
                return (
                  <div className="space-y-3 rounded-lg border p-3">
                    <button
                      type="button"
                      onClick={() => setGenTimeChecksEnabled(v => !v)}
                      className="w-full flex items-start gap-3 text-left"
                    >
                      <div className={`mt-0.5 h-4 w-4 rounded border flex items-center justify-center shrink-0 ${genTimeChecksEnabled ? "bg-primary border-primary" : "border-muted-foreground/40"}`}>
                        {genTimeChecksEnabled && <Check size={12} className="text-primary-foreground" />}
                      </div>
                      <div>
                        <p className="text-sm font-semibold">Add time checks</p>
                        <p className="text-xs text-muted-foreground">
                          Checkpoints where each class must arrive by a set time from their start.
                        </p>
                      </div>
                    </button>

                    {genTimeChecksEnabled && (
                      <div className="space-y-4 pt-1">
                        <p className="text-xs text-muted-foreground rounded-md bg-muted/50 px-3 py-2">
                          All checkpoint times are measured <strong>from the start of the race</strong> for each class — not from the previous checkpoint. If the 250 class starts at 9:00 AM and Time Check 1 is at 1:30, riders should arrive by <strong>10:30 AM</strong>. If Time Check 2 is at 2:45, they should arrive by <strong>11:45 AM</strong>.
                        </p>

                        {allClasses.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            Add race classes to this event to set per-class start times and durations.
                          </p>
                        ) : (
                          <>
                            {/* Per-class start times */}
                            <div className="space-y-2 rounded-md border p-3">
                              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Class start times</p>
                              <p className="text-xs text-muted-foreground">Enter when each class departs the start line (24-hr or plain, e.g. <strong>9:00</strong>). Used to compute expected checkpoint arrival times.</p>

                              {/* Timezone selector */}
                              <div className="flex items-center gap-2 pt-0.5">
                                <span className="text-xs text-muted-foreground shrink-0">Times are in</span>
                                <select
                                  value={classTimezone}
                                  onChange={e => setClassTimezone(e.target.value)}
                                  className="h-7 flex-1 min-w-0 rounded-md border border-input bg-background px-2 text-xs ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                                >
                                  <option value="America/New_York">Eastern (ET)</option>
                                  <option value="America/Chicago">Central (CT)</option>
                                  <option value="America/Denver">Mountain (MT)</option>
                                  <option value="America/Phoenix">Arizona (no DST)</option>
                                  <option value="America/Los_Angeles">Pacific (PT)</option>
                                  <option value="America/Anchorage">Alaska (AKT)</option>
                                  <option value="America/Honolulu">Hawaii (HT)</option>
                                </select>
                              </div>

                              <div className="space-y-1.5 pt-1">
                                {allClasses.map(cls => (
                                  <div key={cls} className="flex items-center gap-2">
                                    <span className="text-xs flex-1 truncate">{cls}</span>
                                    <Input
                                      value={classStartTimes[cls] ?? ""}
                                      onChange={e => {
                                        const v = e.target.value;
                                        setClassStartTimes(prev => ({ ...prev, [cls]: v }));
                                      }}
                                      placeholder="H:MM"
                                      className="h-8 w-24"
                                    />
                                  </div>
                                ))}
                              </div>
                            </div>

                            {/* Number of checkpoints */}
                            <div className="space-y-2">
                              <Label>How many time checks?</Label>
                              <Input
                                type="number"
                                min={1}
                                max={20}
                                value={genTimeCheckCount}
                                onChange={e => setGenTimeCheckCountAndResize(e.target.value)}
                                className="h-9"
                              />
                            </div>

                            {/* Per-checkpoint config */}
                            {genTimeChecks.map((tc, ci) => (
                              <div key={ci} className="space-y-2 rounded-md border p-3">
                                <Input
                                  value={tc.name}
                                  onChange={e => {
                                    const v = e.target.value;
                                    setGenTimeChecks(prev => prev.map((c, idx) => idx === ci ? { ...c, name: v } : c));
                                  }}
                                  placeholder={`Time Check ${ci + 1}`}
                                  className="h-8 font-semibold"
                                />
                                <div className="space-y-1.5">
                                  {allClasses.map(cls => {
                                    const arrival = computeArrival(classStartTimes[cls] ?? "", tc.durations[cls] ?? "");
                                    return (
                                      <div key={cls} className="flex items-center gap-2">
                                        <span className="text-xs flex-1 truncate">{cls}</span>
                                        <Input
                                          value={tc.durations[cls] ?? ""}
                                          onChange={e => {
                                            const v = e.target.value;
                                            setGenTimeChecks(prev => prev.map((c, idx) =>
                                              idx === ci ? { ...c, durations: { ...c.durations, [cls]: v } } : c));
                                          }}
                                          placeholder="h:mm from start"
                                          className="h-8 w-32"
                                        />
                                        {arrival && (
                                          <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">→ {arrival}</span>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </>
                        )}
                        <p className="text-xs text-muted-foreground">
                          Enter each class's expected time from the race start as <strong>h:mm</strong> (e.g. <strong>1:30</strong>) or plain minutes. Leave blank to skip a class.
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Penalty config — only shown when time checks are enabled */}
              {genTimeChecksEnabled && (
                <div className="space-y-3 rounded-lg border p-3">
                  <button
                    type="button"
                    onClick={() => setPenaltyEnabled(v => !v)}
                    className="w-full flex items-start gap-3 text-left"
                  >
                    <div className={`mt-0.5 h-4 w-4 rounded border flex items-center justify-center shrink-0 ${penaltyEnabled ? "bg-primary border-primary" : "border-muted-foreground/40"}`}>
                      {penaltyEnabled && <Check size={12} className="text-primary-foreground" />}
                    </div>
                    <div>
                      <p className="text-sm font-semibold">Time-check penalties</p>
                      <p className="text-xs text-muted-foreground">
                        Add time to a rider's overall score when they arrive early or late.
                      </p>
                    </div>
                  </button>

                  {penaltyEnabled && (
                    <div className="space-y-3 pt-1">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Sec per min early</Label>
                          <Input
                            type="number"
                            min={0}
                            step={1}
                            value={penaltyEarlySecPerMin}
                            onChange={e => setPenaltyEarlySecPerMin(e.target.value)}
                            className="h-8"
                            placeholder="0"
                          />
                          <p className="text-xs text-muted-foreground">0 = no early penalty</p>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Sec per min late</Label>
                          <Input
                            type="number"
                            min={0}
                            step={1}
                            value={penaltyLateSecPerMin}
                            onChange={e => setPenaltyLateSecPerMin(e.target.value)}
                            className="h-8"
                            placeholder="0"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs">DQ if early &gt; (min)</Label>
                          <Input
                            type="number"
                            min={0}
                            step={1}
                            value={penaltyEarlyDqMin}
                            onChange={e => setPenaltyEarlyDqMin(e.target.value)}
                            className="h-8"
                            placeholder="Disabled"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">DQ if late &gt; (min)</Label>
                          <Input
                            type="number"
                            min={0}
                            step={1}
                            value={penaltyLateDqMin}
                            onChange={e => setPenaltyLateDqMin(e.target.value)}
                            className="h-8"
                            placeholder="Disabled"
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Penalties are whole-minute based — a rider 1:59 late is charged for 1 minute. Leave DQ blank to disable disqualification.
                      </p>
                    </div>
                  )}
                </div>
              )}

              <Button
                onClick={handleGenerateTests}
                disabled={createMutation.isPending || setTimeChecksMutation.isPending}
                className="w-full font-heading uppercase"
              >
                {createMutation.isPending || setTimeChecksMutation.isPending ? "Generating…" : "Generate Tests"}
              </Button>
            </div>
          ) : (
          <div className="space-y-5 py-2 overflow-y-auto flex-1 min-h-0 pr-1">
            {/* Class selector */}
            {(() => {
              const allClasses: string[] = (event?.raceClasses as string[] | undefined) ?? [];
              return (
                <div className="space-y-2">
                  <Label>Class</Label>
                  <Select
                    value={generateClass}
                    onValueChange={v => { setGenerateClass(v); setGenerateSelectedRounds([]); }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select class" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Classes</SelectItem>
                      {allClasses.map(cls => (
                        <SelectItem key={cls} value={cls}>{cls}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })()}

            {/* Locked classes warning */}
            {(() => {
              const allClasses: string[] = (event?.raceClasses as string[] | undefined) ?? [];
              const classesToCheck = generateClass === "all" ? allClasses : [generateClass];
              const lockedClasses = classesToCheck.filter(cls =>
                rawMotos.some(m => m.raceClass === cls && m.status === "completed")
              );
              const regenerableClasses = classesToCheck.filter(cls => !lockedClasses.includes(cls));
              if (lockedClasses.length === 0) return null;
              return (
                <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-3 py-2.5 space-y-1.5">
                  <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                    <span>⚠️</span> {lockedClasses.length === 1 ? "This class has" : "Some classes have"} completed motos
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
                    <p className="text-xs text-amber-700 dark:text-amber-400 font-medium">
                      {generateClass === "all" ? "All classes are locked" : "This class is locked"} — nothing to regenerate.
                    </p>
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
              <>
                <div className="space-y-2">
                  <Label>Motos per Class</Label>
                  <Select value={generateFormat} onValueChange={(v: any) => { setGenerateFormat(v); setGenerateSelectedRounds([]); }}>
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
                {/* Round selection — only shown for multi-round formats */}
                {(() => {
                  const divCount = generateFormat === "three_moto" ? 3 : generateFormat === "two_moto" ? 2 : 1;
                  if (divCount <= 1) return null;
                  const allClasses: string[] = (event?.raceClasses as string[] | undefined) ?? [];
                  const isRoundDone = (r: number) => allClasses.length > 0 && allClasses.every(cls =>
                    rawMotos.some(m =>
                      m.raceClass === cls && m.type !== "practice" &&
                      m.status === "completed" && roundMap.get(m.id) === r
                    )
                  );
                  return (
                    <div className="space-y-2">
                      <Label>Generate Moto(s)</Label>
                      <div className="flex gap-2 flex-wrap">
                        {Array.from({ length: divCount }, (_, i) => i + 1).map(r => {
                          const done = isRoundDone(r);
                          const checked = generateSelectedRounds.length === 0 ? true : generateSelectedRounds.includes(r);
                          return (
                            <button key={r} type="button"
                              onClick={() => {
                                if (generateSelectedRounds.length === 0) {
                                  setGenerateSelectedRounds(Array.from({ length: divCount }, (_, i) => i + 1).filter(x => x !== r));
                                } else {
                                  setGenerateSelectedRounds(prev =>
                                    checked ? prev.filter(x => x !== r) : [...prev, r].sort((a, b) => a - b)
                                  );
                                }
                              }}
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
                              Moto {r}
                              {done && <span className="text-[10px] font-normal text-muted-foreground ml-1">done</span>}
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-xs text-muted-foreground">Uncheck a moto to leave its existing sessions untouched.</p>
                    </div>
                  );
                })()}
              </>
            )}

            {/* Riders per heat */}
            <div className="space-y-2">
              <Label>
                Max Riders per Moto{" "}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
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

            {/* Time + Laps */}
            <div className="space-y-2">
              <Label>
                Time + Laps{" "}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  value={generateTimeLimitMins}
                  onChange={e => setGenerateTimeLimitMins(e.target.value)}
                  placeholder="Minutes"
                  className="h-9 flex-1"
                />
                <span className="text-sm text-muted-foreground shrink-0">min +</span>
                <Input
                  type="number"
                  min={0}
                  value={generatePlusLaps}
                  onChange={e => setGeneratePlusLaps(e.target.value)}
                  placeholder="1"
                  className="h-9 w-20 shrink-0"
                />
                <span className="text-sm text-muted-foreground shrink-0">lap(s)</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Classic timed format — race runs for the set minutes, then riders complete the remaining lap(s). Leave minutes blank to skip.
              </p>
            </div>

            {/* Lap count */}
            <div className="space-y-2">
              <Label>
                Laps per Race{" "}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                type="number"
                min={1}
                value={generateLapCount}
                onChange={e => setGenerateLapCount(e.target.value)}
                placeholder="e.g. 6"
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                For laps-based races. Sets the target lap count on every moto — shown to the timer and displayed on the race card.
              </p>
            </div>

            {/* Multi-class spacing */}
            <div className="space-y-2">
              <Label>Required Races Between Motos</Label>
              <p className="text-xs text-muted-foreground">
                For riders signed up in multiple classes, the scheduler will try to insert this many races between their back-to-back motos.
              </p>
              <div className="flex gap-2">
                {([0, 1, 2, 3] as const).map(n => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setGenerateMinRacesBetween(n)}
                    className={`flex-1 py-2 rounded-lg border text-sm font-semibold transition-colors ${
                      generateMinRacesBetween === n
                        ? "bg-primary/10 border-primary text-primary"
                        : "bg-muted/30 border-border text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    {n === 0 ? "None" : n}
                  </button>
                ))}
              </div>
              {generateMinRacesBetween > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  The scheduler will do its best — if the class count is too small to satisfy this constraint, remaining conflicts will appear in the schedule panel above.
                </p>
              )}
            </div>

            {/* Gate Pick Method */}
            {(() => {
              const hasCompletedRaceMotos = rawMotos.some(m => m.status === "completed" && m.type !== "practice");
              const methods: { value: "random" | "practice" | "prior_round_finish" | "first_registered" | "series_points"; label: string; description: string; disabled?: boolean; disabledReason?: string }[] = [
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
                {
                  value: "series_points",
                  label: "Series Points",
                  description: eventSeries
                    ? `Riders with the most ${eventSeries.name} points get first gate pick. Riders with zero points are placed randomly below.`
                    : "Riders are seeded by current series championship points — most points gets first gate pick.",
                  disabled: !eventSeries,
                  disabledReason: "This event is not part of a series.",
                },
              ];
              return (
                <div className="space-y-2">
                  <Label>Gate Pick Method</Label>
                  <TooltipProvider>
                    <div className="rounded-lg border divide-y overflow-hidden">
                      {methods.map((m) => {
                        const isSelected = generateGateMethod === m.value;
                        const btn = (
                          <button key={m.value} type="button" disabled={m.disabled}
                            onClick={() => { if (!m.disabled) setGenerateGateMethod(m.value); }}
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

            {/* Auto info: no check-ins yet */}
            {noneCheckedIn && (
              <div className="flex items-start gap-2 text-xs text-blue-300 bg-blue-500/10 border border-blue-500/30 rounded-md px-3 py-2.5">
                <Info size={13} className="shrink-0 mt-0.5 text-blue-400" />
                <span>No riders have checked in yet — lineups will be built from registrations. Riders will appear as <strong>Pending</strong> and automatically confirm when they check in on race day.</span>
              </div>
            )}

            <Button
              onClick={handleGenerate}
              disabled={
                generateMutation.isPending ||
                (() => {
                  if (generateGateMethod === "prior_round_finish") return false;
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
          )}
        </DialogContent>
      </Dialog>

      {/* ── Add Practice dialog ── */}
      <Dialog open={showPracticeDialog} onOpenChange={setShowPracticeDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-heading uppercase text-xl">Add Practice</DialogTitle>
            <DialogDescription>
              Create a multi-class practice session. Select the classes that will ride together.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Name */}
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={practiceForm.name}
                onChange={e => setPracticeForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Practice 1"
              />
            </div>

            {/* Class checkboxes */}
            <div className="space-y-2">
              <Label>Classes</Label>
              {(() => {
                const eventClasses: string[] = (event?.raceClasses as string[] | undefined) ?? [];
                if (eventClasses.length === 0) {
                  return (
                    <p className="text-xs text-muted-foreground">
                      No classes defined on this event yet.
                    </p>
                  );
                }
                return (
                  <div className="rounded-md border divide-y max-h-52 overflow-y-auto">
                    {eventClasses.map(cls => {
                      const checked = practiceForm.selectedClasses.includes(cls);
                      return (
                        <label
                          key={cls}
                          className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/50 transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setPracticeForm(f => ({
                                ...f,
                                selectedClasses: checked
                                  ? f.selectedClasses.filter(c => c !== cls)
                                  : [...f.selectedClasses, cls],
                              }));
                            }}
                            className="h-4 w-4 rounded accent-primary"
                          />
                          <span className="text-sm font-medium">{cls}</span>
                        </label>
                      );
                    })}
                  </div>
                );
              })()}
              {practiceForm.selectedClasses.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {practiceForm.selectedClasses.length} class{practiceForm.selectedClasses.length > 1 ? "es" : ""} selected
                </p>
              )}
            </div>

            {/* Mode toggle */}
            <div className="space-y-1.5">
              <Label>Mode</Label>
              <div className="flex rounded-md border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setPracticeForm(f => ({ ...f, mode: "lap_count" }))}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${
                    practiceForm.mode === "lap_count"
                      ? "bg-primary text-primary-foreground"
                      : "bg-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Flag size={13} /> Lap Count
                </button>
                <button
                  type="button"
                  onClick={() => setPracticeForm(f => ({ ...f, mode: "countdown" }))}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors border-l ${
                    practiceForm.mode === "countdown"
                      ? "bg-primary text-primary-foreground"
                      : "bg-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Timer size={13} /> Countdown
                </button>
              </div>
            </div>

            {/* Lap count (shown only in lap_count mode) */}
            {practiceForm.mode === "lap_count" && (
              <div className="space-y-1.5">
                <Label>Lap Count</Label>
                <Input
                  type="number"
                  min={1}
                  value={practiceForm.lapCount}
                  onChange={e => setPracticeForm(f => ({ ...f, lapCount: e.target.value }))}
                  className="h-9"
                />
              </div>
            )}

            {/* Countdown duration (shown only in countdown mode) */}
            {practiceForm.mode === "countdown" && (
              <div className="space-y-1.5">
                <Label>Duration (minutes)</Label>
                <Input
                  type="number"
                  min={1}
                  max={120}
                  value={practiceForm.countdownMinutes}
                  onChange={e => setPracticeForm(f => ({ ...f, countdownMinutes: e.target.value }))}
                  className="h-9"
                  placeholder="e.g. 15"
                />
                <p className="text-xs text-muted-foreground">
                  Timer starts when the moto is set to In Progress and auto-completes at zero.
                </p>
              </div>
            )}

            {/* Max riders per session */}
            <div className="space-y-1.5 pt-1 border-t">
              <div className="flex items-center justify-between">
                <Label>Max Riders Per Session</Label>
                <span className="text-xs text-muted-foreground">Optional</span>
              </div>
              <Input
                type="number"
                min={1}
                value={practiceForm.maxRidersPerSession}
                onChange={e => setPracticeForm(f => ({ ...f, maxRidersPerSession: e.target.value }))}
                className="h-9"
                placeholder="e.g. 25"
              />
              {practiceForm.maxRidersPerSession && !isNaN(parseInt(practiceForm.maxRidersPerSession, 10)) ? (() => {
                const max = parseInt(practiceForm.maxRidersPerSession, 10);
                const checkedInForClasses = (checkins as any[]).filter((c: any) =>
                  c.checkedIn && practiceForm.selectedClasses.includes(c.raceClass)
                ).length;
                const groups = checkedInForClasses > 0 ? Math.ceil(checkedInForClasses / max) : 0;
                return (
                  <p className="text-xs text-primary font-medium">
                    {checkedInForClasses} checked-in rider{checkedInForClasses !== 1 ? "s" : ""} → {groups > 1 ? `${groups} practice groups` : groups === 1 ? "1 practice" : "0 riders found"} will be created
                  </p>
                );
              })() : (
                <p className="text-xs text-muted-foreground">
                  When set, checked-in riders for the selected classes are auto-assigned. If more riders than the limit, multiple groups are created automatically.
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPracticeDialog(false)}>Cancel</Button>
            <Button
              onClick={handleAddPractice}
              disabled={practiceForm.selectedClasses.length === 0 || createMutation.isPending}
            >
              {createMutation.isPending ? "Adding…" : "Add Practice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add Moto dialog ── */}
      <Dialog open={showAddDialog} onOpenChange={open => {
        setShowAddDialog(open);
        if (!open) { setAddForm({ name: "", raceClass: "", type: "heat", lapCount: "", enduroHasRfidStart: false }); setAddSelectedRiders([]); }
      }}>
        <DialogContent className="sm:max-w-lg flex flex-col max-h-[90vh]">
          <DialogHeader className="shrink-0">
            <DialogTitle>{isEnduro ? "Add Enduro Test" : "Add Moto"}</DialogTitle>
            <DialogDescription>
              {isEnduro
                ? "Create a new timed test and append it to the run order."
                : "Create a new moto and append it to the end of the run order."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1">
            {/* ── Class ── */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Class</Label>
                {(() => {
                  const eventClasses: string[] = Array.isArray((event as any)?.raceClasses) ? (event as any).raceClasses : [];
                  const checkinClasses = Array.from(new Set((checkins as any[]).map((c: any) => c.raceClass).filter(Boolean)));
                  const allClasses = Array.from(new Set([...eventClasses, ...checkinClasses])).sort();
                  return allClasses.length > 0 ? (
                    <Select
                      value={addForm.raceClass}
                      onValueChange={v => {
                        setAddForm(f => ({ ...f, raceClass: v }));
                        // Pre-select checked-in riders for this class
                        const checkedIn = (checkins as any[]).filter((c: any) => c.raceClass === v && c.checkedIn).map((c: any) => c.riderId);
                        setAddSelectedRiders(checkedIn);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Pick a class…" />
                      </SelectTrigger>
                      <SelectContent>
                        {allClasses.map(cls => (
                          <SelectItem key={cls} value={cls}>{cls}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      placeholder="e.g. 250 Amateur"
                      value={addForm.raceClass}
                      onChange={e => setAddForm(f => ({ ...f, raceClass: e.target.value }))}
                    />
                  );
                })()}
              </div>

              {!isEnduro && (
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
                      {MOTO_TYPES.filter(t => t !== "enduro_test").map(t => (
                        <SelectItem key={t} value={t}>{typeLabel(t)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Custom Name <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input
                  placeholder="Auto-generated if empty"
                  value={addForm.name}
                  onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Lap Count <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input
                  type="number"
                  min={1}
                  placeholder="e.g. 5"
                  value={addForm.lapCount}
                  onChange={e => setAddForm(f => ({ ...f, lapCount: e.target.value }))}
                />
              </div>
            </div>

            {/* ── Enduro start mode ── */}
            {isEnduro && (
              <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2.5">
                <input
                  type="checkbox"
                  id="enduroRfidStart"
                  checked={addForm.enduroHasRfidStart}
                  onChange={e => setAddForm(f => ({ ...f, enduroHasRfidStart: e.target.checked }))}
                  className="h-4 w-4 rounded border-border accent-primary"
                />
                <div>
                  <label htmlFor="enduroRfidStart" className="text-sm font-medium cursor-pointer">
                    {timingLabel} start gate
                  </label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    When checked, the start transponder crossing triggers the timer. Otherwise riders are started manually by bib number.
                  </p>
                </div>
              </div>
            )}

            {/* ── Rider picker ── */}
            {addForm.raceClass && (() => {
              const classRiders = (checkins as any[])
                .filter((c: any) => c.raceClass === addForm.raceClass)
                .sort((a: any, b: any) => {
                  // Checked-in first, then by name
                  if (a.checkedIn !== b.checkedIn) return a.checkedIn ? -1 : 1;
                  return (a.riderName ?? "").localeCompare(b.riderName ?? "");
                });
              if (classRiders.length === 0) return (
                <div className="border border-dashed border-border rounded-lg px-4 py-6 text-center text-sm text-muted-foreground">
                  No registered riders found for {addForm.raceClass}
                </div>
              );
              const checkedInCount = classRiders.filter((c: any) => c.checkedIn).length;
              const toggleAll = () => {
                const allIds = classRiders.map((c: any) => c.riderId);
                const allSelected = allIds.every((id: number) => addSelectedRiders.includes(id));
                setAddSelectedRiders(allSelected ? [] : allIds);
              };
              const toggleCheckedIn = () => {
                const checkedInIds = classRiders.filter((c: any) => c.checkedIn).map((c: any) => c.riderId);
                const allCheckedInSelected = checkedInIds.every((id: number) => addSelectedRiders.includes(id));
                setAddSelectedRiders(prev =>
                  allCheckedInSelected
                    ? prev.filter(id => !checkedInIds.includes(id))
                    : Array.from(new Set([...prev, ...checkedInIds]))
                );
              };
              return (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="flex items-center gap-1.5">
                      <Users size={12} />
                      Riders in {addForm.raceClass}
                      <span className="text-muted-foreground font-normal">
                        ({classRiders.length} registered, {checkedInCount} checked in)
                      </span>
                    </Label>
                    <div className="flex gap-2 text-[11px]">
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={toggleCheckedIn}
                      >
                        {classRiders.filter((c: any) => c.checkedIn).every((c: any) => addSelectedRiders.includes(c.riderId))
                          ? "Deselect checked-in"
                          : "Select checked-in"}
                      </button>
                      <span className="text-muted-foreground">·</span>
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={toggleAll}
                      >
                        {classRiders.every((c: any) => addSelectedRiders.includes(c.riderId)) ? "Deselect all" : "Select all"}
                      </button>
                    </div>
                  </div>
                  <div className="border border-border rounded-lg divide-y divide-border max-h-52 overflow-y-auto">
                    {classRiders.map((c: any) => {
                      const isSelected = addSelectedRiders.includes(c.riderId);
                      return (
                        <button
                          key={c.riderId}
                          type="button"
                          onClick={() => setAddSelectedRiders(prev =>
                            isSelected ? prev.filter(id => id !== c.riderId) : [...prev, c.riderId]
                          )}
                          className={`w-full flex items-center gap-3 px-3 py-2 text-sm text-left transition-colors ${
                            isSelected ? "bg-primary/8 hover:bg-primary/12" : "hover:bg-muted/50"
                          }`}
                        >
                          <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                            isSelected ? "bg-primary border-primary" : "border-border"
                          }`}>
                            {isSelected && <Check size={10} className="text-primary-foreground" />}
                          </div>
                          {c.bibNumber && (
                            <span className="font-mono text-xs text-muted-foreground w-10 shrink-0">#{c.bibNumber}</span>
                          )}
                          <span className="flex-1 font-medium">{c.riderName ?? "Unknown"}</span>
                          {c.checkedIn ? (
                            <span className="text-[10px] text-green-600 dark:text-green-400 font-medium shrink-0">✓ Checked in</span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground shrink-0">Not checked in</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {addSelectedRiders.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {addSelectedRiders.length} rider{addSelectedRiders.length !== 1 ? "s" : ""} will be added to this moto's lineup
                    </p>
                  )}
                </div>
              );
            })()}
          </div>

          <DialogFooter className="shrink-0 pt-2 border-t border-border">
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>Cancel</Button>
            <Button
              onClick={handleAddMoto}
              disabled={!addForm.raceClass || createMutation.isPending}
            >
              {createMutation.isPending ? "Adding…" : `Add Moto${addSelectedRiders.length > 0 ? ` (${addSelectedRiders.length} riders)` : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DndContext>
  );
}
