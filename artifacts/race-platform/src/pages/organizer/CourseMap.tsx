import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, Link } from "wouter";
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor, KeyboardSensor, useSensor, useSensors,
  useDraggable, useDroppable, pointerWithin, rectIntersection,
  type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useGetEvent, useListMotos, useListReaders, useGetConnectorStatus, useListEnduroTimeChecks,
  useListEventReaderAssignments, useSetEventReaderAssignments, getListEventReaderAssignmentsQueryKey,
  getGetEventQueryKey,
} from "@workspace/api-client-react";
import { Flag, GripVertical, Plus, Radio, X, AlertTriangle, Save, Loader2, ArrowRight, Timer, MapPin, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { responseErrorMessage } from "@/lib/friendlyErrors";

// The course map places an event's readers along the course.
//   Motocross / supercross: one finish-line reader decides laps and placings;
//   ordered split readers between finish passes add sector times only.
//   Enduro: each special test (section) has a start and an end reader, plus
//   optional time-check readers.
// Everything here saves as the event's reader assignments.
//
// The finish line and splits normally come from the event's Track Library
// track (set up once per track; see TrackCourseMap below). Changing them here
// customizes this event only; "Reset to track" follows the track again.

/** A Track Library track with its course map, as GET /api/tracks returns it. */
export interface LibraryTrack {
  id: number;
  name: string;
  course?: Array<{ readerId: number; role: "finish" | "split"; sequence: number | null; label: string | null }>;
}

export function useLibraryTracks(enabled = true) {
  return useQuery<LibraryTrack[]>({
    queryKey: ["/api/tracks"],
    enabled,
    queryFn: async () => {
      const res = await fetch("/api/tracks", { credentials: "include" });
      if (!res.ok) throw new Error(responseErrorMessage(res.status));
      return res.json();
    },
  });
}

type Split = { key: string; readerId: number | null; label: string };
type Gate = { start: number | null; end: number | null; sameGate: boolean };

interface CourseState {
  finish: number | null;
  splits: Split[];
  gates: Record<number, Gate>;
  timeChecks: Record<number, number | null>;
  /**
   * Antenna of each saved row (set on the old Schedule card), keyed by
   * place + reader, so saving the map keeps antenna-specific gates.
   */
  antennas: Record<string, number | null>;
}

const EMPTY: CourseState = { finish: null, splits: [], gates: {}, timeChecks: {}, antennas: {} };
const antennaKey = (role: string, readerId: number, place: number | string = "") => `${role}:${place}:${readerId}`;
// One shared empty list: a fresh [] default on every render would re-run the
// effect that loads the saved course, which sets state, which renders again.
const NONE: any[] = [];
// Drop where the pointer is; only fall back to overlap (keyboard drags). A
// drop back on the tray lands nowhere instead of in the nearest slot.
const pointerFirst: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : rectIntersection(args);
};
let keySeq = 0;
const newKey = () => `split-${Date.now()}-${keySeq++}`;

function fromAssignments(rows: any[]): CourseState {
  const state: CourseState = { finish: null, splits: [], gates: {}, timeChecks: {}, antennas: {} };
  for (const a of rows) {
    if (a.antennaId != null) state.antennas[antennaKey(a.role, a.readerId, a.motoId ?? a.timeCheckId ?? "")] = a.antennaId;
    if (a.motoId == null && a.role === "finish") state.finish = a.readerId;
    else if (a.motoId == null && a.role === "split") state.splits.push({ key: newKey(), readerId: a.readerId, label: a.label ?? "", seq: a.sequence ?? 0 } as Split & { seq: number });
    else if (a.motoId != null && (a.role === "start" || a.role === "finish")) {
      const gate = state.gates[a.motoId] ?? { start: null, end: null, sameGate: false };
      if (a.role === "start") gate.start = a.readerId; else gate.end = a.readerId;
      state.gates[a.motoId] = gate;
    } else if (a.role === "time_check" && a.timeCheckId) state.timeChecks[a.timeCheckId] = a.readerId;
  }
  state.splits = (state.splits as Array<Split & { seq: number }>).sort((a, b) => a.seq - b.seq).map(({ key, readerId, label }) => ({ key, readerId, label }));
  // One reader is a "same gate" only when start and end also share the antenna.
  for (const [motoId, gate] of Object.entries(state.gates)) {
    gate.sameGate = gate.start != null && gate.start === gate.end
      && (state.antennas[antennaKey("start", gate.start, motoId)] ?? null) === (state.antennas[antennaKey("finish", gate.start, motoId)] ?? null);
  }
  return state;
}

function toAssignments(state: CourseState, isEnduro: boolean) {
  const out: Array<{ readerId: number; antennaId: number | null; role: string; motoId: number | null; timeCheckId: number | null; sequence?: number | null; label?: string | null }> = [];
  const antenna = (role: string, readerId: number, place: number | string = "") => state.antennas[antennaKey(role, readerId, place)] ?? null;
  if (!isEnduro) {
    if (state.finish) out.push({ readerId: state.finish, antennaId: antenna("finish", state.finish), role: "finish", motoId: null, timeCheckId: null });
    state.splits.forEach((s, i) => {
      if (s.readerId) out.push({ readerId: s.readerId, antennaId: antenna("split", s.readerId), role: "split", motoId: null, timeCheckId: null, sequence: i + 1, label: s.label.trim() || `Split ${i + 1}` });
    });
  } else {
    for (const [motoId, gate] of Object.entries(state.gates)) {
      const end = gate.sameGate ? gate.start : gate.end;
      if (gate.start) out.push({ readerId: gate.start, antennaId: antenna("start", gate.start, motoId), role: "start", motoId: Number(motoId), timeCheckId: null });
      if (end) out.push({ readerId: end, antennaId: gate.sameGate ? antenna("start", end, motoId) : antenna("finish", end, motoId), role: "finish", motoId: Number(motoId), timeCheckId: null });
    }
  }
  for (const [tcId, readerId] of Object.entries(state.timeChecks)) {
    if (readerId) out.push({ readerId, antennaId: antenna("time_check", readerId, tcId), role: "time_check", motoId: null, timeCheckId: Number(tcId) });
  }
  return out;
}

// ── Readers (draggable chips) ────────────────────────────────────────────────

type ReaderInfo = { id: number; name: string; type: string; ready: boolean; online: boolean };

function statusDot(r: ReaderInfo | undefined) {
  if (!r) return "bg-muted-foreground/40";
  return r.ready ? "bg-green-500" : r.online ? "bg-amber-500" : "bg-muted-foreground/40";
}

function ReaderChip({ reader, dragging }: { reader: ReaderInfo; dragging?: boolean }) {
  return (
    <div className={`inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm shadow-sm ${dragging ? "ring-2 ring-primary" : ""}`}>
      <span className={`w-2 h-2 rounded-full ${statusDot(reader)}`} />
      <span className="font-medium truncate max-w-[10rem]">{reader.name}</span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{reader.type === "active_transponder" ? "RM TrackR" : "RFID"}</span>
    </div>
  );
}

function DraggableReader({ reader }: { reader: ReaderInfo }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `reader:${reader.id}`, data: { readerId: reader.id } });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={`cursor-grab active:cursor-grabbing touch-none ${isDragging ? "opacity-40" : ""}`}>
      <ReaderChip reader={reader} />
    </div>
  );
}

// ── Slots (drop targets with a picker fallback) ──────────────────────────────

function Slot({ id, title, readerId, readers, onPick, children, accent, hint }: {
  id: string;
  title: ReactNode;
  readerId: number | null;
  readers: ReaderInfo[];
  onPick: (readerId: number | null) => void;
  children?: ReactNode;
  accent?: boolean;
  hint?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const reader = readers.find(r => r.id === readerId);
  return (
    <div
      ref={setNodeRef}
      className={`rounded-xl border-2 p-3 space-y-2 min-w-[11rem] transition-colors ${
        isOver ? "border-primary bg-primary/10" : accent ? "border-primary/50 bg-primary/5" : reader ? "border-border bg-card" : "border-dashed border-border bg-muted/20"
      }`}
    >
      <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">{title}</div>
      {children}
      <Select value={readerId ? String(readerId) : "none"} onValueChange={v => onPick(v === "none" ? null : Number(v))}>
        <SelectTrigger className="h-8 text-xs bg-background">
          <span className="flex items-center gap-2 truncate">
            {reader && <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot(reader)}`} />}
            <SelectValue placeholder="Drop a reader here" />
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No reader</SelectItem>
          {readers.map(r => <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>)}
        </SelectContent>
      </Select>
      {hint && !reader && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SortableSplit({ split, index, readers, onPick, onLabel, onRemove }: {
  split: Split; index: number; readers: ReaderInfo[];
  onPick: (readerId: number | null) => void; onLabel: (label: string) => void; onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: split.key });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`flex items-center gap-2 ${isDragging ? "opacity-60 z-10" : ""}`}>
      <ArrowRight size={16} className="text-muted-foreground shrink-0" />
      <Slot
        id={`slot:split:${split.key}`}
        readerId={split.readerId}
        readers={readers}
        onPick={onPick}
        title={
          <>
            <button {...listeners} {...attributes} className="cursor-grab touch-none -ml-1 p-0.5 rounded hover:bg-muted" title="Drag to reorder" aria-label={`Reorder split ${index + 1}`}>
              <GripVertical size={13} />
            </button>
            Split {index + 1}
            <span className="flex-1" />
            <button onClick={onRemove} className="p-0.5 rounded hover:bg-muted hover:text-destructive" title="Remove split" aria-label={`Remove split ${index + 1}`}><X size={13} /></button>
          </>
        }
      >
        <Input value={split.label} onChange={e => onLabel(e.target.value)} placeholder={`e.g. Whoops`} className="h-8 text-sm" maxLength={60} />
      </Slot>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function CourseMap() {
  const params = useParams();
  return <CourseMapEditor eventId={Number(params.eventId)} />;
}

/** The Track Library version: a track's standard finish line and splits. */
export function TrackCourseMap({ track, onSaved }: { track: LibraryTrack; onSaved?: () => void }) {
  return <CourseMapEditor eventId={0} track={track} onSaved={onSaved} />;
}

function CourseMapEditor({ eventId, track, onSaved }: { eventId: number; track?: LibraryTrack; onSaved?: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const trackMode = !!track;

  const { data: event, isError: eventFailed, refetch: refetchEvent } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const isEnduro = !trackMode && (event as any)?.raceStyle === "enduro";
  const { data: libraryTracks = NONE } = useLibraryTracks(!trackMode);
  const eventTrack = (libraryTracks as LibraryTrack[]).find(t => t.id === (event as any)?.trackId);
  const [resetting, setResetting] = useState(false);
  const { data: motos = NONE } = useListMotos(eventId, { query: { enabled: !!eventId } as any });
  const { data: timeChecksData } = useListEnduroTimeChecks(eventId, { query: { enabled: !!eventId && isEnduro } as any });
  const { data: clubReaders = NONE } = useListReaders();
  const { data: connectorStatuses = NONE } = useGetConnectorStatus({ query: { refetchInterval: 10_000 } as any });
  const { data: eventSaved = NONE, isLoading: eventLoading, isError: assignmentsFailed, refetch: refetchAssignments } = useListEventReaderAssignments(eventId, { query: { enabled: !!eventId } as any });
  // In track mode the "saved" rows are the track's course points.
  const trackSaved = useMemo(
    () => (track?.course ?? []).map(p => ({ ...p, motoId: null, timeCheckId: null, antennaId: null })),
    [track],
  );
  const saved = trackMode ? trackSaved : eventSaved;
  const isLoading = !trackMode && eventLoading;
  const saveMutation = useSetEventReaderAssignments();

  const [state, setState] = useState<CourseState>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [draggingReader, setDraggingReader] = useState<number | null>(null);
  // Latest state, so a save can tell whether anything changed while it ran.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!dirty) setState(fromAssignments(saved as any[]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const update = (fn: (s: CourseState) => CourseState) => { setState(fn); setDirty(true); };

  const readers: ReaderInfo[] = useMemo(() => (clubReaders as any[]).map(r => {
    const c = (connectorStatuses as any[]).find(s => s.readerId === r.id);
    return { id: r.id, name: r.name, type: r.type, online: !!c?.hardware?.connected, ready: !!c?.hardware?.connected && (c.hardware.ready ?? r.type !== "active_transponder") };
  }), [clubReaders, connectorStatuses]);

  const testMotos = useMemo(() => (motos as any[]).filter(m => m.type === "enduro_test").sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0)), [motos]);
  const timeChecks = (timeChecksData as any[] | undefined) ?? [];

  const placedOnCourse = new Set<number>([state.finish, ...state.splits.map(s => s.readerId)].filter((v): v is number => v != null));
  const trayReaders = isEnduro ? readers : readers.filter(r => !placedOnCourse.has(r.id));

  // A motocross reader can only be in one place: placing it moves it.
  const placeOnCourse = (s: CourseState, readerId: number | null, target: { finish?: true; splitKey?: string }): CourseState => {
    const clear = (id: number | null) => (id != null && id === readerId ? null : id);
    let next: CourseState = { ...s, finish: clear(s.finish), splits: s.splits.map(sp => ({ ...sp, readerId: clear(sp.readerId) })) };
    if (target.finish) next = { ...next, finish: readerId };
    if (target.splitKey) next = { ...next, splits: next.splits.map(sp => (sp.key === target.splitKey ? { ...sp, readerId } : sp)) };
    return next;
  };

  const setGate = (motoId: number, patch: Partial<Gate>) => update(s => ({
    ...s,
    gates: { ...s.gates, [motoId]: { ...(s.gates[motoId] ?? { start: null, end: null, sameGate: false }), ...patch } },
  }));

  const addSplit = (readerId: number | null = null) => update(s => {
    const key = newKey();
    const withSplit = { ...s, splits: [...s.splits, { key, readerId: null, label: "" }] };
    return readerId ? placeOnCourse(withSplit, readerId, { splitKey: key }) : withSplit;
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const onDragStart = (e: DragStartEvent) => setDraggingReader((e.active.data.current as any)?.readerId ?? null);
  const onDragEnd = (e: DragEndEvent) => {
    setDraggingReader(null);
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;
    // Reordering splits.
    if (!activeId.startsWith("reader:")) {
      const from = state.splits.findIndex(s => s.key === activeId);
      const toKey = overId.startsWith("slot:split:") ? overId.slice("slot:split:".length) : overId;
      const to = state.splits.findIndex(s => s.key === toKey);
      if (from >= 0 && to >= 0 && from !== to) update(s => ({ ...s, splits: arrayMove(s.splits, from, to) }));
      return;
    }
    const readerId = Number(activeId.slice("reader:".length));
    // The sortable wrapper around a split shares its edge; treat it as the split's slot.
    if (state.splits.some(s => s.key === overId)) {
      update(s => placeOnCourse(s, readerId, { splitKey: overId }));
      return;
    }
    if (overId === "slot:finish") update(s => placeOnCourse(s, readerId, { finish: true }));
    else if (overId === "slot:new-split") addSplit(readerId);
    else if (overId.startsWith("slot:split:")) update(s => placeOnCourse(s, readerId, { splitKey: overId.slice("slot:split:".length) }));
    else if (overId.startsWith("slot:start:")) setGate(Number(overId.slice(11)), { start: readerId });
    else if (overId.startsWith("slot:end:")) setGate(Number(overId.slice(9)), { end: readerId });
    else if (overId.startsWith("slot:tc:")) update(s => ({ ...s, timeChecks: { ...s.timeChecks, [Number(overId.slice(8))]: readerId } }));
  };

  async function save() {
    const sent = state;
    if (trackMode) {
      try {
        const res = await fetch(`/api/tracks/${track!.id}/course`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ points: toAssignments(sent, false).map(({ readerId, role, sequence, label }) => ({ readerId, role, sequence, label })) }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(responseErrorMessage(res.status, body));
        if (stateRef.current === sent) setDirty(false);
        await queryClient.invalidateQueries({ queryKey: ["/api/tracks"] });
        toast({
          title: "Track course saved",
          description: body.eventsUpdated
            ? `Updated ${body.eventsUpdated} upcoming event${body.eventsUpdated === 1 ? "" : "s"} at ${track!.name}. Practices here use it from their next session.`
            : `Races and practices at ${track!.name} use it from now on.`,
        });
        onSaved?.();
      } catch (err: any) {
        toast({ title: "Couldn't save", description: String(err?.message ?? err), variant: "destructive" });
      }
      return;
    }
    try {
      await saveMutation.mutateAsync({ eventId, data: { assignments: toAssignments(sent, isEnduro) } as any });
      // Edits made while saving stay marked unsaved (and aren't replaced by the refetch).
      const unchanged = stateRef.current === sent;
      if (unchanged) setDirty(false);
      await queryClient.invalidateQueries({ queryKey: getListEventReaderAssignmentsQueryKey(eventId) });
      await queryClient.invalidateQueries({ queryKey: getGetEventQueryKey(eventId) });
      toast({ title: "Course map saved", description: "Readers start routing to these places right away." });
    } catch (err: any) {
      const message = err?.response?.data?.error ?? err?.data?.error ?? err?.message ?? "Couldn't save the course map";
      toast({ title: "Couldn't save", description: String(message), variant: "destructive" });
    }
  }

  // Warnings the organizer can act on before race day.
  const warnings: string[] = [];
  if (!isEnduro) {
    if (state.splits.length > 0 && !state.finish) warnings.push("Add the finish-line reader. It decides laps and placings; segment times need it too.");
    if (state.splits.some(s => !s.readerId)) warnings.push("Every split needs a reader (or remove the empty split).");
  } else {
    for (const m of testMotos) {
      const g = state.gates[m.id];
      if (g && (g.start || g.end) && !(g.start && (g.sameGate || g.end))) warnings.push(`${m.name ?? "A section"} needs both a start and an end reader.`);
    }
  }
  const placedIds = isEnduro
    ? [...Object.values(state.gates).flatMap(g => [g.start, g.sameGate ? null : g.end]), ...Object.values(state.timeChecks)]
    : [state.finish, ...state.splits.map(s => s.readerId)];
  const offline = readers.filter(r => placedIds.includes(r.id) && !r.online);
  if (offline.length) warnings.push(`Not connected right now: ${offline.map(r => r.name).join(", ")}. Start RM Connect on the laptop for ${offline.length === 1 ? "that reader" : "those readers"}.`);

  const sectorNames = useMemo(() => {
    const points = ["Finish", ...state.splits.map((s, i) => s.label.trim() || `Split ${i + 1}`), "Finish"];
    return points.slice(1).map((to, i) => `${points[i]} → ${to}`);
  }, [state.splits]);

  async function resetToTrack() {
    setResetting(true);
    try {
      const res = await fetch(`/api/events/${eventId}/course/reset`, { method: "POST", credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(responseErrorMessage(res.status, body));
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: getListEventReaderAssignmentsQueryKey(eventId) });
      await queryClient.invalidateQueries({ queryKey: getGetEventQueryKey(eventId) });
      toast({ title: "Using the track's course", description: eventTrack ? `Course map copied from ${eventTrack.name}.` : undefined });
    } catch (err: any) {
      toast({ title: "Couldn't reset", description: String(err?.message ?? err), variant: "destructive" });
    } finally {
      setResetting(false);
    }
  }

  // A failed load must not show an empty map: saving it would erase the event's readers.
  if (!trackMode && (eventFailed || assignmentsFailed)) {
    return (
      <div className="p-8 space-y-3">
        <p className="font-semibold">Couldn't load the course map.</p>
        <p className="text-sm text-muted-foreground">Check your connection and try again. Nothing was changed.</p>
        <Button variant="outline" onClick={() => { void refetchEvent(); void refetchAssignments(); }}>Try again</Button>
      </div>
    );
  }
  if (!trackMode && (isLoading || !event)) return <div className="p-8">Loading course map…</div>;
  const courseSource = (event as any)?.courseSource as "track" | "custom" | undefined;

  return (
    <DndContext sensors={sensors} collisionDetection={pointerFirst} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className={trackMode ? "space-y-6" : "p-6 md:p-8 max-w-5xl mx-auto space-y-6"}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            {!trackMode && <h2 className="text-2xl font-heading font-bold uppercase tracking-tight">Course Map</h2>}
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              {trackMode
                ? "Set this track's finish-line reader and split readers once. Every race and practice here uses them, so split times show up without setting anything up per event."
                : isEnduro
                ? "Drag a reader onto the start and end of each section. Time checks are optional."
                : "Drag your finish-line reader onto the flag. Add split readers around the track for segment times; drag splits to put them in course order. Only the finish line decides laps and placings."}
            </p>
          </div>
          <Button onClick={save} disabled={!dirty || saveMutation.isPending} className="gap-2">
            {saveMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {dirty ? "Save course map" : "Saved"}
          </Button>
        </div>

        {/* Where this event's finish line and splits come from */}
        {!trackMode && !isEnduro && (
          <div className="rounded-lg border bg-muted/20 p-3 flex items-center gap-3 flex-wrap text-sm">
            <MapPin size={16} className="text-primary shrink-0" />
            {!eventTrack ? (
              <p className="flex-1 min-w-48 text-muted-foreground">
                This event isn't linked to a Track Library track. Pick the track from the library on the Overview tab
                (or add it under Team → Track Library) to set its course up once for every race and practice there.
              </p>
            ) : courseSource === "custom" ? (
              <>
                <p className="flex-1 min-w-48"><strong>Customized for this event.</strong> {eventTrack.name}'s standard course isn't used here.</p>
                <Button variant="outline" size="sm" onClick={resetToTrack} disabled={resetting} className="gap-1.5">
                  {resetting ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Reset to track
                </Button>
              </>
            ) : (
              <p className="flex-1 min-w-48">
                <strong>From the track: {eventTrack.name}.</strong>{" "}
                {(eventTrack.course?.length ?? 0) > 0
                  ? "Edit it in Team → Track Library to change it for every event here, or change it below for this event only."
                  : "That track has no course map yet: set it up in Team → Track Library, or place readers below for this event only."}
              </p>
            )}
          </div>
        )}

        {/* Reader tray */}
        <section className="rounded-xl border bg-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Radio size={16} className="text-primary" />
            <p className="font-heading font-bold uppercase tracking-wider text-sm">Your readers</p>
            <span className="text-xs text-muted-foreground">Drag onto the course, or pick from a slot's list.</span>
          </div>
          {readers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No readers yet. Add them with <strong>Find readers</strong> in RM Connect (see <Link href="/rfid/setup" className="underline">Reader Setup</Link>).
            </p>
          ) : trayReaders.length === 0 ? (
            <p className="text-sm text-muted-foreground">Every reader is on the course.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {trayReaders.map(r => <DraggableReader key={r.id} reader={r} />)}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            Not sure which box is which? Use <strong>Identify</strong> in RM Connect and pass a tag by a reader. Green = ready · amber = connected, starting up · grey = RM Connect not running for it.
          </p>
        </section>

        {warnings.length > 0 && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-1">
            {warnings.map(w => (
              <p key={w} className="text-sm text-amber-800 dark:text-amber-300 flex gap-2"><AlertTriangle size={15} className="shrink-0 mt-0.5" />{w}</p>
            ))}
          </div>
        )}

        {!isEnduro ? (
          <section className="space-y-4">
            <div className="rounded-xl border bg-muted/10 p-4 overflow-x-auto">
              <div className="flex items-stretch gap-2 min-w-max">
                <Slot
                  id="slot:finish"
                  accent
                  readerId={state.finish}
                  readers={readers}
                  onPick={id => update(s => placeOnCourse(s, id, { finish: true }))}
                  title={<><Flag size={13} className="text-primary" /> Finish line · scores laps</>}
                  hint="Required. Laps and placings come from this reader."
                />
                <SortableContext items={state.splits.map(s => s.key)} strategy={horizontalListSortingStrategy}>
                  {state.splits.map((split, i) => (
                    <SortableSplit
                      key={split.key}
                      split={split}
                      index={i}
                      readers={readers}
                      onPick={id => update(s => placeOnCourse(s, id, { splitKey: split.key }))}
                      onLabel={label => update(s => ({ ...s, splits: s.splits.map(sp => (sp.key === split.key ? { ...sp, label } : sp)) }))}
                      onRemove={() => update(s => ({ ...s, splits: s.splits.filter(sp => sp.key !== split.key) }))}
                    />
                  ))}
                </SortableContext>
                <div className="flex items-center gap-2">
                  <ArrowRight size={16} className="text-muted-foreground shrink-0" />
                  <NewSplitSlot onAdd={() => addSplit()} />
                  <ArrowRight size={16} className="text-muted-foreground shrink-0" />
                  <div className="rounded-xl border-2 border-dashed border-primary/30 px-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    <Flag size={13} className="text-primary" /> Back to finish
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border bg-card p-4">
              <p className="font-heading font-bold uppercase tracking-wider text-sm flex items-center gap-2"><Timer size={15} className="text-primary" /> Segments</p>
              {state.splits.length === 0 ? (
                <p className="text-sm text-muted-foreground mt-1">Add a split to time segments. With one split at the halfway point, riders see Finish → Halfway and Halfway → Finish times on the leaderboard, results and the app.</p>
              ) : (
                <ol className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  {sectorNames.map((name, i) => (
                    <li key={name + i} className="text-sm flex gap-2"><span className="font-mono text-xs text-muted-foreground w-12">Seg {i + 1}</span>{name}</li>
                  ))}
                </ol>
              )}
            </div>
          </section>
        ) : (
          <section className="space-y-4">
            {testMotos.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                No sections yet. Add special tests on the <Link href={`/events/${eventId}/schedule`} className="underline">Schedule</Link> tab, then place their readers here.
              </div>
            ) : (
              <div className="space-y-3">
                {testMotos.map((m, i) => {
                  const gate = state.gates[m.id] ?? { start: null, end: null, sameGate: false };
                  return (
                    <div key={m.id} className="rounded-xl border bg-card p-4 space-y-3">
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="font-mono text-xs font-bold bg-primary text-primary-foreground rounded px-2 py-0.5">Section {i + 1}</span>
                        <p className="font-semibold">{m.name ?? `Test ${m.motoNumber ?? m.id}`}</p>
                        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                          <input type="checkbox" className="accent-primary" checked={gate.sameGate} onChange={e => setGate(m.id, { sameGate: e.target.checked })} />
                          Starts and ends at the same reader
                        </label>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Slot id={`slot:start:${m.id}`} readerId={gate.start} readers={readers} onPick={id => setGate(m.id, { start: id })}
                          title={gate.sameGate ? "Start / end" : "Start"} />
                        {!gate.sameGate && (
                          <>
                            <ArrowRight size={16} className="text-muted-foreground" />
                            <Slot id={`slot:end:${m.id}`} readerId={gate.end} readers={readers} onPick={id => setGate(m.id, { end: id })} title="End" />
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
                <p className="text-xs text-muted-foreground">Add, rename or reorder sections on the <Link href={`/events/${eventId}/schedule`} className="underline">Schedule</Link> tab.</p>
              </div>
            )}

            {timeChecks.length > 0 && (
              <div className="rounded-xl border bg-card p-4 space-y-3">
                <p className="font-heading font-bold uppercase tracking-wider text-sm">Time checks</p>
                <div className="flex flex-wrap gap-3">
                  {timeChecks.map((tc: any) => (
                    <Slot key={tc.id} id={`slot:tc:${tc.id}`} readerId={state.timeChecks[tc.id] ?? null} readers={readers}
                      onPick={id => update(s => ({ ...s, timeChecks: { ...s.timeChecks, [tc.id]: id } }))}
                      title={tc.name || `TC ${tc.checkNumber}`} />
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {!isEnduro && (state.finish || state.splits.length > 0) && (
          <p className="text-xs text-muted-foreground">
            Readers not on the course keep timing laps the usual way. Sector times appear once a moto runs with the splits in place.
          </p>
        )}
      </div>

      <DragOverlay>
        {draggingReader != null && readers.find(r => r.id === draggingReader)
          ? <ReaderChip reader={readers.find(r => r.id === draggingReader)!} dragging />
          : null}
      </DragOverlay>
    </DndContext>
  );
}

function NewSplitSlot({ onAdd }: { onAdd: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: "slot:new-split" });
  return (
    <button
      ref={setNodeRef}
      onClick={onAdd}
      className={`rounded-xl border-2 border-dashed px-4 py-6 min-w-[9rem] flex flex-col items-center justify-center gap-1 text-sm transition-colors ${
        isOver ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
      }`}
    >
      <Plus size={18} />
      Add split
      <span className="text-[11px]">or drop a reader</span>
    </button>
  );
}
