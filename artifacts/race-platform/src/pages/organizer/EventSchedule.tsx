import { useState, useCallback } from "react";
import { useParams, Link } from "wouter";
import {
  useListMotos,
  useReorderMotos,
  useUpdateMoto,
  useCreateMoto,
  getListMotosQueryKey,
  type Moto,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  GripVertical,
  Plus,
  Clock,
  LayoutList,
  LayoutGrid,
  Zap,
  Flag,
  ExternalLink,
} from "lucide-react";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const nh = Math.floor(total / 60) % 24;
  const nm = total % 60;
  return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
}

function estimateDurationMin(moto: Moto): number {
  if (moto.type === "practice") return 15;
  return (moto.lapCount ?? 5) * 2;
}

// ── Sortable moto card ────────────────────────────────────────────────────────

interface MotoCardProps {
  moto: Moto;
  index: number;
  eventId: number;
  onTimeBlur: (motoId: number, value: string) => void;
  timeValue: string;
  onTimeChange: (motoId: number, value: string) => void;
}

function SortableMotoCard({ moto, index, eventId, onTimeBlur, timeValue, onTimeChange }: MotoCardProps) {
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
      className="flex items-center gap-3 bg-card border border-border rounded-lg px-4 py-3 group hover:border-primary/40 transition-colors"
    >
      {/* Run-order index */}
      <span className="text-xs text-muted-foreground w-6 shrink-0 text-center font-mono">{index + 1}</span>

      {/* Drag handle */}
      <button
        className="touch-none cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground shrink-0"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
      >
        <GripVertical size={18} />
      </button>

      {/* Class + type */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {moto.raceClass && (
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{moto.raceClass}</span>
          )}
          <p className="font-medium text-sm truncate">{moto.name}</p>
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

      {/* Scheduled time input */}
      <div className="flex items-center gap-2 shrink-0">
        <Clock size={14} className="text-muted-foreground" />
        <Input
          type="time"
          value={timeValue}
          onChange={e => onTimeChange(moto.id, e.target.value)}
          onBlur={e => onTimeBlur(moto.id, e.target.value)}
          className="h-7 w-28 text-xs bg-background border-border"
        />
      </div>

      {/* Deep-link to this moto in Motos & Lineups */}
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

// ── Static card (by-class view, no DnD) ────────────────────────────────────────

function StaticMotoCard({ moto, eventId, onTimeBlur, timeValue, onTimeChange }: Omit<MotoCardProps, "index"> & { index?: number }) {
  const riderCount = Array.isArray(moto.lineup) ? moto.lineup.length : 0;

  return (
    <div className="flex items-center gap-3 bg-card border border-border rounded-lg px-4 py-3 hover:border-primary/40 transition-colors">
      <div className="w-1 self-stretch rounded-full shrink-0" style={{ background: "hsl(var(--primary) / 0.3)" }} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {moto.raceClass && (
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{moto.raceClass}</span>
          )}
          <p className="font-medium text-sm truncate">{moto.name}</p>
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

      <div className="flex items-center gap-2 shrink-0">
        <Clock size={14} className="text-muted-foreground" />
        <Input
          type="time"
          value={timeValue}
          onChange={e => onTimeChange(moto.id, e.target.value)}
          onBlur={e => onTimeBlur(moto.id, e.target.value)}
          className="h-7 w-28 text-xs bg-background border-border"
        />
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

// ── Main page ────────────────────────────────────────────────────────────────

type ViewMode = "run-order" | "by-class";

const MOTO_TYPES = ["practice", "heat", "lcq", "main"] as const;

export default function EventSchedule() {
  const params = useParams();
  const eventId = parseInt(params.eventId || "0");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ── Data ──
  const { data: rawMotos = [], isLoading } = useListMotos(eventId, {
    query: { enabled: !!eventId } as any,
  });

  // ── Local state ──
  const [viewMode, setViewMode] = useState<ViewMode>("run-order");
  const [localOrder, setLocalOrder] = useState<number[] | null>(null);
  const [timeEdits, setTimeEdits] = useState<Record<number, string>>({});
  const [startTime, setStartTime] = useState("08:00");
  const [gapMin, setGapMin] = useState("5");
  const [showAddDialog, setShowAddDialog] = useState(false);

  // Add moto form
  const [addForm, setAddForm] = useState({
    name: "",
    raceClass: "",
    type: "heat" as typeof MOTO_TYPES[number],
    lapCount: "5",
    scheduledTime: "",
  });

  // ── Mutations ──
  const reorderMutation = useReorderMotos();
  const updateMutation = useUpdateMoto();
  const createMutation = useCreateMoto();

  // ── Derived sorted list ──
  const sortedMotos: Moto[] = (() => {
    const motos = [...rawMotos].sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));
    if (!localOrder) return motos;
    const map = new Map(motos.map(m => [m.id, m]));
    return localOrder.map(id => map.get(id)).filter(Boolean) as Moto[];
  })();

  // ── DnD ──
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const ids = sortedMotos.map(m => m.id);
    const oldIndex = ids.indexOf(active.id as number);
    const newIndex = ids.indexOf(over.id as number);
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
  }, [sortedMotos, eventId, reorderMutation, queryClient, toast]);

  // ── Scheduled time helpers ──
  function getTimeValue(moto: Moto): string {
    if (timeEdits[moto.id] !== undefined) return timeEdits[moto.id];
    return moto.scheduledTime ?? "";
  }

  function handleTimeChange(motoId: number, value: string) {
    setTimeEdits(prev => ({ ...prev, [motoId]: value }));
  }

  function handleTimeBlur(motoId: number, value: string) {
    updateMutation.mutate(
      { motoId, data: { scheduledTime: value || undefined } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setTimeEdits(prev => {
            const next = { ...prev };
            delete next[motoId];
            return next;
          });
        },
        onError: () => {
          toast({ title: "Failed to save time", variant: "destructive" });
        },
      }
    );
  }

  // ── Auto-fill times ──
  function handleAutoFill() {
    if (!startTime) {
      toast({ title: "Set a start time first", variant: "destructive" });
      return;
    }
    const gap = parseInt(gapMin) || 5;
    let current = startTime;
    const updates: Array<{ motoId: number; scheduledTime: string }> = [];

    for (const moto of sortedMotos) {
      updates.push({ motoId: moto.id, scheduledTime: current });
      const dur = estimateDurationMin(moto);
      current = addMinutes(current, dur + gap);
    }

    setTimeEdits(Object.fromEntries(updates.map(u => [u.motoId, u.scheduledTime])));

    Promise.all(
      updates.map(u =>
        updateMutation.mutateAsync({ motoId: u.motoId, data: { scheduledTime: u.scheduledTime } })
      )
    ).then(() => {
      queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
      setTimeEdits({});
      toast({ title: "Scheduled times updated" });
    }).catch(() => {
      toast({ title: "Some times failed to save", variant: "destructive" });
    });
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
          scheduledTime: addForm.scheduledTime || undefined,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setShowAddDialog(false);
          setAddForm({ name: "", raceClass: "", type: "heat", lapCount: "5", scheduledTime: "" });
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

  // ── Type section grouping for run-order view ──
  // We render them flat in run-order but add visual section separators
  const TYPE_ORDER = ["practice", "heat", "lcq", "main"];
  function sectionLabel(type: string): string {
    switch (type) {
      case "practice": return "Practice Sessions";
      case "heat":     return "Heat Races";
      case "lcq":      return "Last Chance Qualifier";
      case "main":     return "Main Events";
      default:         return type;
    }
  }

  if (isLoading) return <div className="p-8 text-muted-foreground">Loading schedule…</div>;

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      {/* ── Header toolbar ── */}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h2 className="text-xl font-heading font-bold uppercase tracking-tight">Event Schedule</h2>
          <p className="text-sm text-muted-foreground mt-0.5">{sortedMotos.length} sessions in run order</p>
        </div>

        <div className="flex-1" />

        {/* View toggle */}
        <div className="flex bg-muted rounded-md p-0.5 border border-border">
          <button
            onClick={() => setViewMode("run-order")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
              viewMode === "run-order" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <LayoutList size={14} /> Run Order
          </button>
          <button
            onClick={() => setViewMode("by-class")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
              viewMode === "by-class" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
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

      {/* ── Auto-fill toolbar ── */}
      <div className="flex flex-wrap items-center gap-3 p-4 bg-muted/40 border border-border rounded-lg">
        <Clock size={16} className="text-muted-foreground shrink-0" />
        <div className="flex items-center gap-2">
          <Label htmlFor="start-time" className="text-sm whitespace-nowrap">Event start</Label>
          <Input
            id="start-time"
            type="time"
            value={startTime}
            onChange={e => setStartTime(e.target.value)}
            className="h-8 w-28 text-sm bg-background"
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="gap-min" className="text-sm whitespace-nowrap">Gap between sessions</Label>
          <Input
            id="gap-min"
            type="number"
            min={0}
            max={30}
            value={gapMin}
            onChange={e => setGapMin(e.target.value)}
            className="h-8 w-16 text-sm bg-background"
          />
          <span className="text-sm text-muted-foreground">min</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleAutoFill}
          disabled={sortedMotos.length === 0}
          className="ml-auto"
        >
          <Zap size={14} className="mr-1" /> Auto-fill times
        </Button>
      </div>

      {/* ── Empty state ── */}
      {sortedMotos.length === 0 && (
        <div className="text-center py-16 text-muted-foreground border border-dashed border-border rounded-lg">
          <Flag size={40} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium">No motos yet</p>
          <p className="text-sm mt-1">Generate lineups in Motos & Lineups, or add one manually.</p>
        </div>
      )}

      {/* ── Run-order view ── */}
      {viewMode === "run-order" && sortedMotos.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
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
                        timeValue={getTimeValue(moto)}
                        onTimeChange={handleTimeChange}
                        onTimeBlur={handleTimeBlur}
                      />
                    </div>
                  );
                });
              })()}
            </div>
          </SortableContext>
        </DndContext>
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
                    timeValue={getTimeValue(moto)}
                    onTimeChange={handleTimeChange}
                    onTimeBlur={handleTimeBlur}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

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

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Lap Count</Label>
                <Input
                  type="number"
                  min={1}
                  value={addForm.lapCount}
                  onChange={e => setAddForm(f => ({ ...f, lapCount: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Scheduled Time <span className="text-muted-foreground">(optional)</span></Label>
                <Input
                  type="time"
                  value={addForm.scheduledTime}
                  onChange={e => setAddForm(f => ({ ...f, scheduledTime: e.target.value }))}
                />
              </div>
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
    </div>
  );
}
