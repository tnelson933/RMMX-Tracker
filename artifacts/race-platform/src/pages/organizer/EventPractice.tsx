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
import { Play, Square, Timer, Wifi, WifiOff, Users, Clock, Trophy, RefreshCw } from "lucide-react";

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
  const esRef = useRef<EventSource | null>(null);

  const checkedInRiders = (checkins as any[]).filter((c: any) => c.checkedIn);

  // Find the most recent practice moto (prefer in_progress, then most recent)
  const practiceMoots = motos.filter((m: any) => m.type === "practice");
  const activePractice = practiceMoots.find((m: any) => m.status === "in_progress")
    ?? practiceMoots[practiceMoots.length - 1];

  // SSE connection to live timing
  useEffect(() => {
    if (!activePractice || activePractice.status !== "in_progress") {
      esRef.current?.close();
      esRef.current = null;
      setSseConnected(false);
      return;
    }

    const es = new EventSource(`/api/timing/live/${activePractice.id}`);
    esRef.current = es;

    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);
    es.onmessage = (e) => {
      try {
        const snapshot = JSON.parse(e.data);
        setLiveData(snapshot);
        setSseConnected(true);
      } catch { /* ignore */ }
    };

    return () => {
      es.close();
      esRef.current = null;
      setSseConnected(false);
    };
  }, [activePractice?.id, activePractice?.status]);

  async function startPractice() {
    try {
      const moto = await new Promise<any>((resolve, reject) => {
        createMoto.mutate(
          { eventId, data: { name: "Practice Session", type: "practice", raceClass: "Open Practice", motoNumber: 0 } },
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
      toast({ title: "Practice session started" });
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

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel — checked-in riders */}
      <div className="w-72 shrink-0 border-r border-border bg-sidebar flex flex-col">
        <div className="px-4 py-4 border-b border-sidebar-border">
          <div className="flex items-center gap-2 mb-1">
            <Users size={16} className="text-primary" />
            <span className="font-heading font-bold uppercase tracking-wider text-white text-sm">
              Checked-In Riders
            </span>
          </div>
          <span className="text-xs text-sidebar-foreground/50 uppercase tracking-widest">
            {checkedInRiders.length} rider{checkedInRiders.length !== 1 ? "s" : ""} ready
          </span>
        </div>

        <div className="flex-1 overflow-y-auto">
          {checkedInRiders.length === 0 && (
            <div className="p-6 text-center text-sidebar-foreground/40 text-sm">
              No riders checked in yet
            </div>
          )}
          {checkedInRiders.map((rider: any) => (
            <div
              key={rider.riderId}
              className="flex items-center gap-3 px-4 py-3 border-b border-sidebar-border/30 hover:bg-sidebar-accent/20 transition-colors"
            >
              <div className="w-10 h-10 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                <span className="font-heading font-bold text-primary text-sm">
                  {rider.bibNumber ?? "—"}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-white text-sm leading-tight truncate">
                  {rider.riderName}
                </div>
                <div className="text-xs text-sidebar-foreground/50 truncate">{rider.raceClass}</div>
              </div>
              <div className="shrink-0">
                {rider.rfidNumber ? (
                  <div className="w-2 h-2 rounded-full bg-green-400" title="RFID assigned" />
                ) : (
                  <div className="w-2 h-2 rounded-full bg-sidebar-foreground/20" title="No RFID" />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel — live timing board */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header bar */}
        <div className="bg-sidebar border-b border-sidebar-border px-6 py-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <Timer size={18} className="text-primary" />
            <div>
              <span className="font-heading font-bold uppercase tracking-wider text-white">
                Practice Timing
              </span>
              {isActive && (
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                  <span className="text-xs text-primary font-medium uppercase tracking-widest">Live</span>
                  {sseConnected
                    ? <Wifi size={12} className="text-primary" />
                    : <WifiOff size={12} className="text-sidebar-foreground/40" />}
                </div>
              )}
              {isEnded && (
                <span className="block text-xs text-sidebar-foreground/50 uppercase tracking-widest mt-0.5">Session ended</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isActive && (
              <Button
                variant="outline"
                size="sm"
                onClick={endPractice}
                disabled={isLoading}
                className="font-heading uppercase tracking-wider border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-300 h-9"
              >
                <Square size={14} className="mr-1.5" /> End Session
              </Button>
            )}
            {!isActive && (
              <Button
                size="sm"
                onClick={startPractice}
                disabled={isLoading}
                className="font-heading uppercase tracking-wider h-9 bg-primary hover:bg-primary/90"
              >
                {isLoading
                  ? <RefreshCw size={14} className="mr-1.5 animate-spin" />
                  : <Play size={14} className="mr-1.5" />}
                Start Practice
              </Button>
            )}
          </div>
        </div>

        {/* Timing board */}
        <div className="flex-1 overflow-y-auto p-6">
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
                  Start a practice session to begin tracking lap times. Make sure your RFID reader is connected and crossings are flowing.
                </div>
              </div>
              <Button
                onClick={startPractice}
                disabled={isLoading}
                className="font-heading uppercase tracking-wider mt-2"
              >
                <Play size={16} className="mr-2" /> Start Practice Session
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
            </div>
          )}

          {riders.length > 0 && (
            <div className="space-y-2">
              {/* Column headers */}
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
                    {/* Position */}
                    <div className="text-center">
                      {isLeader ? (
                        <Trophy size={18} className="text-primary mx-auto" />
                      ) : (
                        <span className="font-heading font-bold text-muted-foreground text-lg">
                          {rider.position}
                        </span>
                      )}
                    </div>

                    {/* Rider info */}
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

                    {/* Lap count */}
                    <div className="text-center">
                      <span className={`font-heading font-bold text-2xl ${isLeader ? "text-primary" : "text-foreground"}`}>
                        {rider.laps}
                      </span>
                    </div>

                    {/* Best lap */}
                    <div className="text-center">
                      <div className="flex items-center justify-center gap-1">
                        {isLeader && <Clock size={12} className="text-primary shrink-0" />}
                        <span className={`font-mono text-sm font-bold ${isLeader ? "text-primary" : "text-foreground"}`}>
                          {formatMs(rider.bestLapMs)}
                        </span>
                      </div>
                    </div>

                    {/* Last lap */}
                    <div className="text-center">
                      <span className="font-mono text-sm text-muted-foreground">
                        {formatMs(rider.lastLapMs)}
                      </span>
                    </div>

                    {/* Gap to leader */}
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

          {/* Previous sessions */}
          {practiceMoots.length > 1 && (
            <div className="mt-8">
              <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
                Previous Sessions
              </div>
              <div className="space-y-2">
                {[...practiceMoots].reverse().slice(1).map((m: any) => (
                  <div key={m.id} className="flex items-center justify-between px-4 py-2 rounded-lg bg-card border border-border text-sm">
                    <span className="text-muted-foreground font-mono text-xs">{m.name}</span>
                    <Badge variant="outline" className="text-xs capitalize">{m.status}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
