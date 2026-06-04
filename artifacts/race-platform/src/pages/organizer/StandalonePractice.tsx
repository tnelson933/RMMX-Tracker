import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Play,
  Square,
  Plus,
  Timer,
  Trash2,
  Wifi,
  WifiOff,
  Trophy,
  Clock,
  Tag,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

function formatMs(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const dec = Math.floor((ms % 1000) / 10);
  return `${mins}:${String(secs).padStart(2, "0")}.${String(dec).padStart(2, "0")}`;
}

type PracticeSession = {
  id: number;
  name: string;
  status: "idle" | "active" | "ended";
  debounceMs: number;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
};

type PracticeRiderRow = {
  rfidNumber: string;
  riderId: number | null;
  riderName: string | null;
  bibNumber: string | null;
  lapCount: number;
  bestLapMs: number | null;
  lastLapMs: number | null;
  lastCrossingTime: string;
  laps: { lapNumber: number; lapTimeMs: number | null; crossingTime: string }[];
};

type LiveBoard = {
  session: PracticeSession;
  riders: PracticeRiderRow[];
};

export default function StandalonePractice() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [sessions, setSessions] = useState<PracticeSession[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [liveBoard, setLiveBoard] = useState<LiveBoard | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [expandedRfids, setExpandedRfids] = useState<Set<string>>(new Set());
  const esRef = useRef<EventSource | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/practice", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
        if (!selectedId && data.length > 0) {
          const active = data.find((s: PracticeSession) => s.status === "active");
          setSelectedId((active ?? data[0]).id);
        }
      }
    } catch { /* ignore */ }
  }, [selectedId]);

  useEffect(() => {
    loadSessions();
  }, []);

  // SSE connection for selected session
  useEffect(() => {
    esRef.current?.close();
    esRef.current = null;
    setSseConnected(false);
    setLiveBoard(null);

    if (!selectedId) return;

    const es = new EventSource(`/api/practice/${selectedId}/live`, { withCredentials: true });
    esRef.current = es;

    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);
    es.onmessage = (e) => {
      try {
        const data: LiveBoard = JSON.parse(e.data);
        setLiveBoard(data);
        setSseConnected(true);
        setSessions(prev =>
          prev.map(s => s.id === data.session.id ? data.session : s)
        );
      } catch { /* ignore */ }
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [selectedId]);

  async function createSession() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/practice", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (!res.ok) throw new Error();
      const session: PracticeSession = await res.json();
      setSessions(prev => [session, ...prev]);
      setSelectedId(session.id);
      setNewName("");
      setShowNewForm(false);
      toast({ title: "Practice session created" });
    } catch {
      toast({ title: "Failed to create session", variant: "destructive" });
    } finally {
      setCreating(false);
    }
  }

  async function patchSession(id: number, body: object) {
    const res = await fetch(`/api/practice/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error();
    const session: PracticeSession = await res.json();
    setSessions(prev => prev.map(s => s.id === id ? session : s));
    return session;
  }

  async function startSession(id: number) {
    try {
      await patchSession(id, { status: "active" });
      toast({ title: "Practice session started" });
    } catch {
      toast({ title: "Failed to start session", variant: "destructive" });
    }
  }

  async function endSession(id: number) {
    try {
      await patchSession(id, { status: "ended" });
      toast({ title: "Practice session ended" });
    } catch {
      toast({ title: "Failed to end session", variant: "destructive" });
    }
  }

  async function deleteSession(id: number) {
    try {
      const res = await fetch(`/api/practice/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error();
      setSessions(prev => prev.filter(s => s.id !== id));
      if (selectedId === id) {
        const remaining = sessions.filter(s => s.id !== id);
        setSelectedId(remaining[0]?.id ?? null);
      }
      toast({ title: "Session deleted" });
    } catch {
      toast({ title: "Failed to delete session", variant: "destructive" });
    }
  }

  function toggleExpand(rfid: string) {
    setExpandedRfids(prev => {
      const next = new Set(prev);
      if (next.has(rfid)) next.delete(rfid);
      else next.add(rfid);
      return next;
    });
  }

  const selectedSession = sessions.find(s => s.id === selectedId);
  const riders: PracticeRiderRow[] = liveBoard?.riders ?? [];

  function statusBadgeProps(status: string) {
    if (status === "active") return { className: "border-primary text-primary bg-primary/10", label: "LIVE" };
    if (status === "ended") return { className: "border-muted-foreground/30 text-muted-foreground", label: "Ended" };
    return { className: "border-muted-foreground/30 text-muted-foreground", label: "Ready" };
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel — session management */}
      <div className="w-72 shrink-0 border-r border-border bg-sidebar flex flex-col">
        <div className="px-4 py-4 border-b border-sidebar-border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Timer size={16} className="text-primary" />
              <span className="font-heading font-bold uppercase tracking-wider text-white text-sm">
                Practice Sessions
              </span>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-sidebar-foreground/60 hover:text-white hover:bg-sidebar-accent"
              onClick={() => setShowNewForm(v => !v)}
              title="New session"
            >
              <Plus size={14} />
            </Button>
          </div>

          {showNewForm && (
            <div className="mt-3 flex gap-2">
              <Input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") createSession(); if (e.key === "Escape") setShowNewForm(false); }}
                placeholder="Session name…"
                className="h-8 text-sm bg-sidebar-accent border-sidebar-border text-white placeholder:text-sidebar-foreground/40 flex-1"
                autoFocus
              />
              <Button
                size="sm"
                className="h-8 font-heading uppercase px-2 text-xs"
                onClick={createSession}
                disabled={creating || !newName.trim()}
              >
                Add
              </Button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 && (
            <div className="p-6 text-center text-sidebar-foreground/40 text-sm">
              No sessions yet.
              <br />
              <button
                className="text-primary mt-1 hover:underline text-xs"
                onClick={() => setShowNewForm(true)}
              >
                Create one
              </button>
            </div>
          )}
          {sessions.map(s => {
            const bp = statusBadgeProps(s.status);
            const isSelected = s.id === selectedId;
            return (
              <div
                key={s.id}
                className={`px-4 py-3 border-b border-sidebar-border/30 cursor-pointer group hover:bg-sidebar-accent/30 transition-colors ${
                  isSelected ? "bg-sidebar-accent/40 border-l-2 border-l-primary" : ""
                }`}
                onClick={() => setSelectedId(s.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-medium text-sm truncate ${isSelected ? "text-white" : "text-sidebar-foreground/80"}`}>
                    {s.name}
                  </span>
                  <Badge variant="outline" className={`text-xs shrink-0 font-bold ${bp.className}`}>
                    {bp.label}
                  </Badge>
                </div>
                <div className="text-xs text-sidebar-foreground/40 mt-0.5">
                  {s.startedAt
                    ? new Date(s.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                    : "Not started"}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right panel — live timing board */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Session header */}
        {selectedSession ? (
          <>
            <div className="bg-sidebar border-b border-sidebar-border px-6 py-3 flex items-center justify-between shrink-0">
              <div>
                <div className="flex items-center gap-3">
                  <span className="font-heading font-bold uppercase tracking-wider text-white text-lg">
                    {selectedSession.name}
                  </span>
                  {selectedSession.status === "active" && (
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                      <span className="text-xs text-primary font-bold uppercase tracking-widest">Live</span>
                      {sseConnected
                        ? <Wifi size={12} className="text-primary" />
                        : <WifiOff size={12} className="text-sidebar-foreground/40" />}
                    </div>
                  )}
                </div>
                {selectedSession.startedAt && (
                  <div className="text-xs text-sidebar-foreground/50 mt-0.5">
                    Started {new Date(selectedSession.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                {selectedSession.status === "idle" && (
                  <Button
                    size="sm"
                    onClick={() => startSession(selectedSession.id)}
                    className="font-heading uppercase tracking-wider h-9 bg-primary hover:bg-primary/90"
                  >
                    <Play size={14} className="mr-1.5" /> Start Session
                  </Button>
                )}
                {selectedSession.status === "active" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => endSession(selectedSession.id)}
                    className="font-heading uppercase tracking-wider border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-300 h-9"
                  >
                    <Square size={14} className="mr-1.5" /> End Session
                  </Button>
                )}
                {selectedSession.status !== "active" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-muted-foreground hover:text-destructive"
                    onClick={() => deleteSession(selectedSession.id)}
                    title="Delete session"
                  >
                    <Trash2 size={15} />
                  </Button>
                )}
              </div>
            </div>

            {/* Board */}
            <div className="flex-1 overflow-y-auto p-6">
              {riders.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
                  <div className="w-20 h-20 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <Tag size={32} className="text-primary/60" />
                  </div>
                  <div>
                    <div className="font-heading font-bold uppercase tracking-wider text-foreground text-xl mb-1">
                      {selectedSession.status === "idle"
                        ? "Session Not Started"
                        : selectedSession.status === "active"
                        ? "Waiting for Crossings…"
                        : "No Crossings Recorded"}
                    </div>
                    <div className="text-muted-foreground text-sm max-w-sm">
                      {selectedSession.status === "idle"
                        ? "Start the session and riders will appear automatically as they cross the timing gate. Names are matched from your RFID assignments and rider profiles."
                        : selectedSession.status === "active"
                        ? "Riders will appear here as they cross the timing gate. Make sure your RFID reader is powered on and the bridge is running."
                        : "No lap data was captured in this session."}
                    </div>
                  </div>
                </div>
              )}

              {riders.length > 0 && (
                <div className="space-y-3">
                  {/* Summary bar */}
                  <div className="flex items-center gap-4 mb-4 px-1">
                    <div className="text-sm text-muted-foreground">
                      <span className="font-bold text-foreground">{riders.length}</span> rider{riders.length !== 1 ? "s" : ""}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      <span className="font-bold text-foreground">
                        {riders.reduce((t, r) => t + r.lapCount, 0)}
                      </span> total laps
                    </div>
                    {riders[0]?.bestLapMs && (
                      <div className="text-sm text-muted-foreground">
                        Fastest: <span className="font-bold text-primary font-mono">{formatMs(riders[0].bestLapMs)}</span>
                      </div>
                    )}
                  </div>

                  {riders.map((rider, idx) => {
                    const isLeader = idx === 0;
                    const displayName = rider.riderName ?? rider.rfidNumber;
                    const isExpanded = expandedRfids.has(rider.rfidNumber);
                    const lapsWithTime = rider.laps.filter(l => l.lapTimeMs !== null);

                    return (
                      <div
                        key={rider.rfidNumber}
                        className={`rounded-xl border overflow-hidden transition-all ${
                          isLeader ? "border-primary/40 bg-primary/5" : "border-border bg-card"
                        }`}
                      >
                        {/* Rider row */}
                        <div className="flex items-center gap-4 px-5 py-4">
                          {/* Position */}
                          <div className="w-8 shrink-0 text-center">
                            {isLeader
                              ? <Trophy size={20} className="text-primary mx-auto" />
                              : <span className="font-heading font-bold text-muted-foreground text-xl">{idx + 1}</span>}
                          </div>

                          {/* Identity */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              {rider.bibNumber && (
                                <span className={`text-xs font-bold font-mono px-1.5 py-0.5 rounded ${
                                  isLeader ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
                                }`}>
                                  #{rider.bibNumber}
                                </span>
                              )}
                              <span className={`font-semibold text-base truncate ${isLeader ? "text-primary" : "text-foreground"}`}>
                                {displayName}
                              </span>
                              {!rider.riderName && (
                                <Badge variant="outline" className="text-xs border-muted-foreground/30 text-muted-foreground">
                                  Unknown transponder
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-1 mt-0.5">
                              <Tag size={11} className="text-muted-foreground/50 shrink-0" />
                              <span className="font-mono text-xs text-muted-foreground/50">{rider.rfidNumber}</span>
                            </div>
                          </div>

                          {/* Stats */}
                          <div className="flex items-center gap-6 shrink-0">
                            <div className="text-center">
                              <div className={`font-heading font-bold text-3xl leading-none ${isLeader ? "text-primary" : "text-foreground"}`}>
                                {rider.lapCount}
                              </div>
                              <div className="text-xs text-muted-foreground uppercase tracking-wider mt-0.5">Laps</div>
                            </div>
                            <div className="text-center hidden sm:block">
                              <div className={`font-mono font-bold text-lg leading-none ${isLeader ? "text-primary" : "text-foreground"}`}>
                                {formatMs(rider.bestLapMs)}
                              </div>
                              <div className="flex items-center gap-1 justify-center mt-0.5">
                                <Trophy size={10} className="text-muted-foreground/50" />
                                <div className="text-xs text-muted-foreground uppercase tracking-wider">Best</div>
                              </div>
                            </div>
                            <div className="text-center hidden sm:block">
                              <div className="font-mono text-lg leading-none text-muted-foreground">
                                {formatMs(rider.lastLapMs)}
                              </div>
                              <div className="flex items-center gap-1 justify-center mt-0.5">
                                <Clock size={10} className="text-muted-foreground/50" />
                                <div className="text-xs text-muted-foreground uppercase tracking-wider">Last</div>
                              </div>
                            </div>
                          </div>

                          {/* Expand toggle */}
                          {lapsWithTime.length > 0 && (
                            <button
                              onClick={() => toggleExpand(rider.rfidNumber)}
                              className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
                            >
                              {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                            </button>
                          )}
                        </div>

                        {/* Lap detail */}
                        {isExpanded && lapsWithTime.length > 0 && (
                          <div className="border-t border-border/50 bg-muted/30 px-5 py-3">
                            <div className="grid grid-cols-[3rem_6rem_6rem_1fr] gap-2 text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2 px-1">
                              <span>Lap</span>
                              <span>Time</span>
                              <span>Clock</span>
                              <span />
                            </div>
                            <div className="space-y-1">
                              {lapsWithTime.map(lap => {
                                const isBest = lap.lapTimeMs === rider.bestLapMs;
                                return (
                                  <div
                                    key={lap.lapNumber}
                                    className={`grid grid-cols-[3rem_6rem_6rem_1fr] gap-2 items-center px-1 py-1 rounded text-sm ${
                                      isBest ? "bg-primary/10 text-primary" : "text-foreground"
                                    }`}
                                  >
                                    <span className="font-mono font-bold text-muted-foreground">{lap.lapNumber}</span>
                                    <span className={`font-mono font-bold ${isBest ? "text-primary" : ""}`}>
                                      {formatMs(lap.lapTimeMs)}
                                    </span>
                                    <span className="text-xs text-muted-foreground/60 font-mono">
                                      {new Date(lap.crossingTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                                    </span>
                                    {isBest && (
                                      <span className="text-xs text-primary font-bold uppercase tracking-widest">Best</span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
            <div className="w-20 h-20 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Timer size={36} className="text-primary/60" />
            </div>
            <div>
              <div className="font-heading font-bold uppercase tracking-wider text-foreground text-xl mb-1">
                Open Practice Timing
              </div>
              <div className="text-muted-foreground text-sm max-w-sm">
                Create a practice session to start capturing lap times. Any RFID transponder crossing your reader will be automatically logged, with rider names looked up from your event history.
              </div>
            </div>
            <Button
              onClick={() => setShowNewForm(true)}
              className="font-heading uppercase tracking-wider mt-2"
            >
              <Plus size={16} className="mr-2" /> Create Practice Session
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
