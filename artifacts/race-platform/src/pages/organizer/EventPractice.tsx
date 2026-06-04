import { useState, useEffect, useRef } from "react";
import { useParams } from "wouter";
import {
  useListCheckins,
  useListMotos,
  useCreateMoto,
  useUpdateMoto,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListMotosQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Play, Square, Timer, Wifi, WifiOff, Users,
  Clock, Trophy, RefreshCw, ChevronDown, ChevronRight, History,
  Flag,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

const ALL_CLASSES = "All Classes";

function formatMs(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const dec = Math.floor((ms % 1000) / 10);
  return `${mins}:${String(secs).padStart(2, "0")}.${String(dec).padStart(2, "0")}`;
}

type LiveRider = {
  position: number;
  riderName: string;
  bibNumber?: string | null;
  laps: number;
  bestLapMs?: number | null;
  lastLapMs?: number | null;
  gapToLeaderMs?: number | null;
};

type LiveSnapshot = {
  motoId: number;
  status: string;
  riders: LiveRider[];
};

type Checkin = {
  riderId: number;
  riderName: string;
  raceClass: string;
  bibNumber?: string | null;
  checkedIn: boolean;
  rfidNumber?: string | null;
};

type Crossing = {
  id: number;
  rfidNumber: string;
  riderName: string | null;
  lapNumber: number;
  lapTime: string | null;
  lapTimeMs: number | null;
  crossingTime: string;
};

// ── Session history: expandable card per past session ────────────────────────

function SessionHistoryCard({ moto }: { moto: any }) {
  const [expanded, setExpanded] = useState(false);
  const [crossings, setCrossings] = useState<Crossing[] | null>(null);
  const [loading, setLoading] = useState(false);

  const handleExpand = async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (crossings !== null) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/timing/crossings/${moto.id}`);
      if (res.ok) {
        const data: Crossing[] = await res.json();
        setCrossings(Array.isArray(data) ? data : []);
      } else {
        setCrossings([]);
      }
    } catch {
      setCrossings([]);
    } finally {
      setLoading(false);
    }
  };

  // Summarise crossings into per-rider best/laps
  const riderSummary = (() => {
    if (!crossings || crossings.length === 0) return [];
    const map = new Map<string, { name: string; laps: number; bestMs: number | null }>();
    for (const c of crossings) {
      const key = c.riderName ?? c.rfidNumber;
      const prev = map.get(key);
      const bestMs = (prev?.bestMs ?? null) === null
        ? (c.lapTimeMs ?? null)
        : c.lapTimeMs != null && c.lapTimeMs > 0
          ? Math.min(prev!.bestMs!, c.lapTimeMs)
          : prev!.bestMs;
      map.set(key, {
        name: c.riderName ?? c.rfidNumber,
        laps: Math.max(prev?.laps ?? 0, c.lapNumber),
        bestMs: bestMs,
      });
    }
    return [...map.values()].sort((a, b) => {
      if (a.bestMs == null && b.bestMs == null) return 0;
      if (a.bestMs == null) return 1;
      if (b.bestMs == null) return -1;
      return a.bestMs - b.bestMs;
    });
  })();

  const statusColor = moto.status === "in_progress"
    ? "bg-primary/20 text-primary border-primary/30"
    : moto.status === "completed"
    ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
    : "bg-muted text-muted-foreground border-transparent";

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 bg-card hover:bg-muted/40 transition-colors text-left"
        onClick={handleExpand}
      >
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider border ${statusColor}`}>
            {moto.status === "in_progress" && (
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-ping inline-block" />
            )}
            {moto.status === "completed" ? "Done" : moto.status.replace("_", " ")}
          </span>
          <span className="font-medium text-sm text-foreground">{moto.name}</span>
          {moto.raceClass && moto.raceClass !== ALL_CLASSES && (
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{moto.raceClass}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {crossings && (
            <span className="text-xs text-muted-foreground">{riderSummary.length} rider{riderSummary.length !== 1 ? "s" : ""}</span>
          )}
          {expanded
            ? <ChevronDown size={14} className="text-muted-foreground" />
            : <ChevronRight size={14} className="text-muted-foreground" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border bg-muted/20">
          {loading && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground animate-pulse">
              Loading session data…
            </div>
          )}
          {!loading && crossings !== null && riderSummary.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No lap data recorded for this session.
            </div>
          )}
          {!loading && riderSummary.length > 0 && (
            <div className="divide-y divide-border/50">
              <div className="grid grid-cols-[2rem_1fr_4rem_5rem] gap-3 px-4 py-2 bg-muted/40">
                <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground text-center">#</div>
                <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Rider</div>
                <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground text-center">Laps</div>
                <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground text-center">Best Lap</div>
              </div>
              {riderSummary.map((r, i) => (
                <div key={r.name} className={`grid grid-cols-[2rem_1fr_4rem_5rem] gap-3 items-center px-4 py-2.5 ${i === 0 ? "bg-primary/5" : ""}`}>
                  <div className="text-center">
                    {i === 0
                      ? <Trophy size={14} className="text-primary mx-auto" />
                      : <span className="text-xs font-mono text-muted-foreground">{i + 1}</span>}
                  </div>
                  <span className={`text-sm font-medium truncate ${i === 0 ? "text-primary" : "text-foreground"}`}>{r.name}</span>
                  <span className="text-center text-sm font-heading font-bold text-foreground">{r.laps}</span>
                  <span className={`text-center font-mono text-sm font-bold ${i === 0 ? "text-primary" : "text-foreground"}`}>
                    {formatMs(r.bestMs)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Session history tab: all practice sessions for the event ─────────────────

function SessionHistoryPanel({ motos }: { motos: any[] }) {
  const practiceMotos = [...motos]
    .filter((m: any) => m.type === "practice")
    .sort((a: any, b: any) => b.id - a.id);

  if (practiceMotos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
        <div className="w-20 h-20 rounded-full bg-muted/50 border border-border flex items-center justify-center">
          <History size={36} className="text-muted-foreground/40" />
        </div>
        <div>
          <div className="font-heading font-bold uppercase tracking-wider text-foreground text-lg mb-1">
            No Sessions Yet
          </div>
          <div className="text-muted-foreground text-sm max-w-xs">
            Session history will appear here after you start and end a practice session.
          </div>
        </div>
      </div>
    );
  }

  // Group by class
  const byClass = new Map<string, any[]>();
  for (const m of practiceMotos) {
    const cls = m.raceClass ?? ALL_CLASSES;
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls)!.push(m);
  }

  return (
    <div className="p-6 space-y-8 overflow-y-auto h-full">
      {[...byClass.entries()].map(([cls, sessions]) => (
        <div key={cls}>
          <div className="flex items-center gap-2 mb-3">
            <Flag size={13} className="text-primary shrink-0" />
            <h3 className="font-heading font-bold uppercase tracking-wider text-sm text-foreground">
              {cls === ALL_CLASSES ? "All Classes" : cls}
            </h3>
            <span className="text-xs text-muted-foreground">
              {sessions.length} session{sessions.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="space-y-2">
            {sessions.map((m: any) => (
              <SessionHistoryCard key={m.id} moto={m} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function EventPractice() {
  const { eventId: eventIdStr } = useParams<{ eventId: string }>();
  const eventId = parseInt(eventIdStr ?? "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: checkinsRaw = [] } = useListCheckins(eventId, { query: { enabled: !!eventId } as any });
  const checkins: Checkin[] = checkinsRaw as any;

  const { data: motosRaw = [] } = useListMotos(eventId, { query: { enabled: !!eventId } as any });
  const motos: any[] = motosRaw as any;

  const createMoto = useCreateMoto();
  const updateMoto = useUpdateMoto();

  const [liveData, setLiveData] = useState<LiveSnapshot | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [selectedClass, setSelectedClass] = useState<string>(ALL_CLASSES);
  const esRef = useRef<EventSource | null>(null);

  const checkedInRiders = (checkins as any[]).filter((c: any) => c.checkedIn);

  const availableClasses: string[] = Array.from(
    new Set(checkedInRiders.map((r: any) => r.raceClass as string))
  ).sort();

  useEffect(() => {
    if (selectedClass !== ALL_CLASSES && !availableClasses.includes(selectedClass)) {
      setSelectedClass(ALL_CLASSES);
    }
  }, [availableClasses.join(",")]);

  const visibleRiders = selectedClass === ALL_CLASSES
    ? checkedInRiders
    : checkedInRiders.filter((r: any) => r.raceClass === selectedClass);

  const practiceMotos = motos.filter((m: any) => m.type === "practice");
  const sessionKey = selectedClass;
  const classMotos = practiceMotos.filter((m: any) => m.raceClass === sessionKey);
  const activePractice = classMotos.find((m: any) => m.status === "in_progress")
    ?? classMotos[classMotos.length - 1] ?? null;

  useEffect(() => {
    esRef.current?.close();
    esRef.current = null;
    setSseConnected(false);
    setLiveData(null);

    if (!activePractice || activePractice.status !== "in_progress") return;

    const es = new EventSource(`/api/timing/live/${activePractice.id}`);
    esRef.current = es;

    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);
    es.onmessage = (e) => {
      try {
        const snapshot = JSON.parse(e.data);
        setLiveData(snapshot);
        setSseConnected(true);
      } catch { }
    };

    return () => {
      es.close();
      esRef.current = null;
      setSseConnected(false);
    };
  }, [activePractice?.id, activePractice?.status]);

  useEffect(() => {
    setLiveData(null);
  }, [selectedClass]);

  async function startPractice() {
    const sessionName = selectedClass === ALL_CLASSES
      ? "Practice – All Classes"
      : `Practice – ${selectedClass}`;

    try {
      const moto = await new Promise<any>((resolve, reject) => {
        createMoto.mutate(
          {
            eventId,
            data: {
              name: sessionName,
              type: "practice",
              raceClass: sessionKey,
              motoNumber: 0,
            },
          },
          { onSuccess: resolve, onError: reject }
        );
      });
      await new Promise<void>((resolve, reject) => {
        updateMoto.mutate(
          { motoId: moto.id, data: { status: "in_progress" } },
          {
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
              resolve();
            },
            onError: reject,
          }
        );
      });
      toast({ title: `Practice started — ${sessionName}` });
    } catch {
      toast({ title: "Failed to start practice", variant: "destructive" });
    }
  }

  function endPractice() {
    if (!activePractice) return;
    updateMoto.mutate(
      { motoId: activePractice.id, data: { status: "completed" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMotosQueryKey(eventId) });
          setLiveData(null);
          toast({ title: "Practice session ended" });
        },
        onError: () => toast({ title: "Failed to end practice", variant: "destructive" }),
      }
    );
  }

  const isLoading = createMoto.isPending || updateMoto.isPending;
  const isActive = activePractice?.status === "in_progress";
  const isEnded = activePractice?.status === "completed";
  const riders: LiveRider[] = liveData?.riders ?? [];
  const historyCount = practiceMotos.filter((m: any) => m.status === "completed").length;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel — checked-in riders */}
      <div className="w-72 shrink-0 border-r border-border bg-sidebar flex flex-col">
        <div className="px-4 py-4 border-b border-sidebar-border">
          <div className="flex items-center gap-2 mb-3">
            <Users size={16} className="text-primary" />
            <span className="font-heading font-bold uppercase tracking-wider text-white text-sm">
              Checked-In Riders
            </span>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-sidebar-accent/40 border border-sidebar-border text-sm text-white hover:bg-sidebar-accent/60 transition-colors">
                <span className="truncate font-medium">{selectedClass}</span>
                <ChevronDown size={14} className="shrink-0 text-sidebar-foreground/50" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem
                onClick={() => setSelectedClass(ALL_CLASSES)}
                className={selectedClass === ALL_CLASSES ? "font-bold text-primary" : ""}
              >
                All Classes
                <span className="ml-auto text-xs text-muted-foreground">{checkedInRiders.length}</span>
              </DropdownMenuItem>
              {availableClasses.map(cls => (
                <DropdownMenuItem
                  key={cls}
                  onClick={() => setSelectedClass(cls)}
                  className={selectedClass === cls ? "font-bold text-primary" : ""}
                >
                  {cls}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {checkedInRiders.filter((r: any) => r.raceClass === cls).length}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="mt-2 text-xs text-sidebar-foreground/50 uppercase tracking-widest">
            {visibleRiders.length} rider{visibleRiders.length !== 1 ? "s" : ""} in session
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {visibleRiders.length === 0 && (
            <div className="p-6 text-center text-sidebar-foreground/40 text-sm">
              {checkedInRiders.length === 0
                ? "No riders checked in yet"
                : `No ${selectedClass} riders checked in`}
            </div>
          )}
          {visibleRiders.map((rider: any) => (
            <div
              key={rider.riderId}
              className="flex items-center gap-3 px-4 py-3 border-b border-sidebar-border/30 hover:bg-sidebar-accent/20 transition-colors"
            >
              <div className="w-10 h-10 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                <span className="font-heading font-bold text-primary text-sm">{rider.bibNumber ?? "—"}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-white text-sm leading-tight truncate">{rider.riderName}</div>
                <div className="text-xs text-sidebar-foreground/50 truncate">
                  {selectedClass === ALL_CLASSES ? rider.raceClass : ""}
                </div>
              </div>
              <div className="shrink-0">
                {rider.rfidNumber
                  ? <div className="w-2 h-2 rounded-full bg-green-400" title="RFID assigned" />
                  : <div className="w-2 h-2 rounded-full bg-sidebar-foreground/20" title="No RFID" />}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel — tabs */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <Tabs defaultValue="live" className="flex flex-col flex-1 overflow-hidden">
          {/* Tab bar + live controls */}
          <div className="bg-sidebar border-b border-sidebar-border px-4 py-2 flex items-center justify-between shrink-0">
            <TabsList className="bg-sidebar-accent/30 h-9">
              <TabsTrigger value="live" className="data-[state=active]:bg-primary data-[state=active]:text-white font-heading uppercase tracking-wider text-xs h-7 px-4 gap-1.5">
                <Timer size={13} />
                Live Timing
                {isActive && (
                  <span className="w-2 h-2 rounded-full bg-white animate-pulse ml-0.5" />
                )}
              </TabsTrigger>
              <TabsTrigger value="history" className="data-[state=active]:bg-primary data-[state=active]:text-white font-heading uppercase tracking-wider text-xs h-7 px-4 gap-1.5">
                <History size={13} />
                Session History
                {historyCount > 0 && (
                  <span className="ml-0.5 bg-primary/30 text-primary-foreground text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                    {historyCount}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            <div className="flex items-center gap-2">
              {isActive && (
                <div className="flex items-center gap-1.5 mr-2">
                  <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                  <span className="text-xs text-primary font-medium uppercase tracking-widest">Live</span>
                  {sseConnected
                    ? <Wifi size={12} className="text-primary" />
                    : <WifiOff size={12} className="text-sidebar-foreground/40" />}
                </div>
              )}
              {isActive && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={endPractice}
                  disabled={isLoading}
                  className="font-heading uppercase tracking-wider border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-300 h-8 text-xs"
                >
                  <Square size={13} className="mr-1.5" /> End Session
                </Button>
              )}
              {!isActive && (
                <Button
                  size="sm"
                  onClick={startPractice}
                  disabled={isLoading || visibleRiders.length === 0}
                  className="font-heading uppercase tracking-wider h-8 text-xs bg-primary hover:bg-primary/90"
                  title={visibleRiders.length === 0 ? "No riders in this class are checked in" : undefined}
                >
                  {isLoading
                    ? <RefreshCw size={13} className="mr-1.5 animate-spin" />
                    : <Play size={13} className="mr-1.5" />}
                  Start Practice
                </Button>
              )}
            </div>
          </div>

          {/* Live Timing tab */}
          <TabsContent value="live" className="flex-1 overflow-y-auto mt-0 p-6 data-[state=inactive]:hidden">
            {!activePractice && (
              <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
                <div className="w-20 h-20 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Timer size={36} className="text-primary/60" />
                </div>
                <div>
                  <div className="font-heading font-bold uppercase tracking-wider text-foreground text-xl mb-1">
                    No Active Practice
                  </div>
                  <div className="text-muted-foreground text-sm max-w-xs">
                    {selectedClass === ALL_CLASSES
                      ? "Select a class or start an all-class session."
                      : `Start a practice session for ${selectedClass}.`}
                    {" "}Make sure your RFID reader is connected.
                  </div>
                </div>
                <Button
                  onClick={startPractice}
                  disabled={isLoading || visibleRiders.length === 0}
                  className="font-heading uppercase tracking-wider mt-2"
                  title={visibleRiders.length === 0 ? "No riders in this class are checked in" : undefined}
                >
                  <Play size={16} className="mr-2" />
                  Start{selectedClass !== ALL_CLASSES ? ` ${selectedClass}` : ""} Practice
                </Button>
              </div>
            )}

            {activePractice && riders.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Timer size={28} className="text-primary/60 animate-pulse" />
                </div>
                <div className="font-heading font-bold uppercase tracking-wider text-foreground text-lg">
                  {isActive ? "Waiting for crossings…" : "No crossings recorded"}
                </div>
                <div className="text-muted-foreground text-sm max-w-xs">
                  {isActive
                    ? "Riders will appear here as they cross the timing gate."
                    : "No lap data was captured in this session."}
                </div>
                {isEnded && (
                  <p className="text-xs text-muted-foreground mt-2">
                    View session details in the <span className="font-bold">Session History</span> tab.
                  </p>
                )}
              </div>
            )}

            {riders.length > 0 && (
              <div className="space-y-2">
                <div className="grid grid-cols-[2.5rem_1fr_4.5rem_5rem_5rem_5rem] gap-3 px-4 pb-1 border-b border-border">
                  <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground text-center">#</div>
                  <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Rider</div>
                  <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground text-center">Laps</div>
                  <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground text-center">Best</div>
                  <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground text-center">Last</div>
                  <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground text-center">Gap</div>
                </div>

                {riders.map((rider, idx) => {
                  const isLeader = idx === 0;
                  return (
                    <div
                      key={`${rider.riderName}-${idx}`}
                      className={`grid grid-cols-[2.5rem_1fr_4.5rem_5rem_5rem_5rem] gap-3 items-center px-4 py-3 rounded-lg border transition-colors ${
                        isLeader
                          ? "bg-primary/10 border-primary/30"
                          : "bg-card border-border hover:border-border/80"
                      }`}
                    >
                      <div className="text-center">
                        {isLeader ? (
                          <Trophy size={18} className="text-primary mx-auto" />
                        ) : (
                          <span className="font-heading font-bold text-muted-foreground text-lg">{rider.position}</span>
                        )}
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {rider.bibNumber && (
                            <span className={`text-xs font-bold font-mono px-1.5 py-0.5 rounded ${
                              isLeader ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
                            }`}>
                              #{rider.bibNumber}
                            </span>
                          )}
                          <span className={`font-semibold truncate text-sm ${isLeader ? "text-primary" : "text-foreground"}`}>
                            {rider.riderName}
                          </span>
                        </div>
                      </div>

                      <div className="text-center">
                        <span className={`font-heading font-bold text-2xl ${isLeader ? "text-primary" : "text-foreground"}`}>
                          {rider.laps}
                        </span>
                      </div>

                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          {isLeader && <Clock size={12} className="text-primary shrink-0" />}
                          <span className={`font-mono text-sm font-bold ${isLeader ? "text-primary" : "text-foreground"}`}>
                            {formatMs(rider.bestLapMs)}
                          </span>
                        </div>
                      </div>

                      <div className="text-center">
                        <span className="font-mono text-sm text-muted-foreground">{formatMs(rider.lastLapMs)}</span>
                      </div>

                      <div className="text-center">
                        {isLeader ? (
                          <span className="text-xs text-primary font-bold uppercase tracking-wider">Leader</span>
                        ) : (
                          <span className="font-mono text-sm text-muted-foreground">
                            {rider.gapToLeaderMs && rider.gapToLeaderMs > 0
                              ? `+${formatMs(rider.gapToLeaderMs)}`
                              : "—"}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* Session History tab */}
          <TabsContent value="history" className="flex-1 overflow-hidden mt-0 data-[state=inactive]:hidden">
            <SessionHistoryPanel motos={motos} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
