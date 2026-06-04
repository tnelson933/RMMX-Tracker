import { useState } from "react";
import { useRoute } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Trophy, Clock, Star, ChevronDown, ChevronUp,
  Flag, AlertTriangle, Calendar, MapPin, Hash, User, Timer,
  Wifi, Pencil, Check, X, Loader2, Radio, DoorOpen
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RiderLayout } from "@/components/layout/RiderLayout";
import {
  riderApi,
  type RiderHistoryResponse,
  type EventHistory,
  type MotoResult,
  type RiderPracticeResponse,
  type PracticeSessionHistory,
  type RiderScheduleResponse,
  type ScheduleEvent,
  type ScheduleMoto,
} from "@/lib/rider-api";

function positionBadge(pos: number) {
  if (pos === 1) return "bg-yellow-400/20 text-yellow-600 border-yellow-400/40";
  if (pos === 2) return "bg-slate-200/40 text-slate-600 border-slate-300/60";
  if (pos === 3) return "bg-amber-500/20 text-amber-700 border-amber-400/40";
  return "bg-muted text-muted-foreground border-border";
}

function formatMs(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const dec = Math.floor((ms % 1000) / 10);
  return `${mins}:${String(secs).padStart(2, "0")}.${String(dec).padStart(2, "0")}`;
}

// ─── RFID editor ────────────────────────────────────────────────────────────

function RfidEditor({ riderId, currentRfid }: { riderId: number; currentRfid: string | null }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentRfid ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    setValue(currentRfid ?? "");
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setError(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await riderApi.updateRfid(riderId, value.trim() || null);
      queryClient.invalidateQueries({ queryKey: ["rider-history", riderId] });
      queryClient.invalidateQueries({ queryKey: ["rider-profiles"] });
      queryClient.invalidateQueries({ queryKey: ["rider-practice", riderId] });
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1.5 mt-2">
        <div className="flex items-center gap-2">
          <Wifi size={13} className="text-muted-foreground shrink-0" />
          <Input
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="e.g. AB12CD34"
            className="h-8 text-sm font-mono w-48"
            autoFocus
            onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") cancel(); }}
          />
          <Button size="sm" className="h-8 px-2" onClick={save} disabled={saving}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          </Button>
          <Button size="sm" variant="ghost" className="h-8 px-2" onClick={cancel} disabled={saving}>
            <X size={13} />
          </Button>
        </div>
        {error && <p className="text-xs text-destructive ml-5">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 mt-1">
      <Wifi size={13} className="text-muted-foreground shrink-0" />
      {currentRfid ? (
        <span className="text-sm font-mono text-muted-foreground">{currentRfid}</span>
      ) : (
        <span className="text-sm text-muted-foreground italic">No transponder set</span>
      )}
      <button
        onClick={startEdit}
        className="ml-1 text-muted-foreground hover:text-primary transition-colors"
        title="Edit transponder number"
      >
        <Pencil size={11} />
      </button>
    </div>
  );
}

// ─── Race history components ────────────────────────────────────────────────

function MotoRow({ moto }: { moto: MotoResult }) {
  const [lapOpen, setLapOpen] = useState(false);
  const hasTimes = moto.lapTimes && moto.lapTimes.length > 0;

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3 bg-muted/30">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{moto.motoName}</span>
            <Badge variant="outline" className="text-xs capitalize">{moto.motoType}</Badge>
          </div>
        </div>

        <div className="flex items-center gap-4 text-sm flex-shrink-0">
          {moto.dnf ? (
            <Badge variant="destructive" className="text-xs font-bold">DNF</Badge>
          ) : moto.dns ? (
            <Badge variant="outline" className="text-xs text-muted-foreground">DNS</Badge>
          ) : (
            <Badge variant="outline" className={`text-xs font-heading font-bold border ${positionBadge(moto.position)}`}>
              P{moto.position}
            </Badge>
          )}

          {moto.points !== null && !moto.dnf && !moto.dns && (
            <span className="flex items-center gap-1 text-primary font-bold text-sm">
              <Star size={12} /> {moto.points}
            </span>
          )}

          {moto.totalTime && (
            <span className="flex items-center gap-1 text-muted-foreground font-mono text-xs">
              <Clock size={11} /> {moto.totalTime}
            </span>
          )}

          {hasTimes && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => setLapOpen((v) => !v)}
            >
              {lapOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              <span className="ml-1">{moto.lapTimes.length} laps</span>
            </Button>
          )}
        </div>
      </div>

      {lapOpen && hasTimes && (
        <div className="px-4 py-3 bg-background border-t">
          <div className="text-xs text-muted-foreground mb-2 font-heading uppercase tracking-wider">Lap Times</div>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
            {moto.lapTimes.map((t, i) => (
              <div key={i} className="bg-muted rounded px-2 py-1.5 text-center">
                <div className="text-xs text-muted-foreground">Lap {i + 1}</div>
                <div className="font-mono text-xs font-medium">{t}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EventCard({ event }: { event: EventHistory }) {
  const [open, setOpen] = useState(true);

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="font-heading font-bold text-lg uppercase tracking-tight">
              {event.eventName}
            </CardTitle>
            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <Calendar size={13} />
                {event.eventDate ? new Date(event.eventDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "—"}
              </span>
              {(event.eventLocation || event.eventState) && (
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  <MapPin size={13} />
                  {event.eventLocation ?? event.eventState}
                </span>
              )}
              <Badge variant="secondary" className="text-xs">{event.raceClass}</Badge>
              {event.timingTechnology && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Timer size={11} />
                  {event.timingTechnology === "mylaps" ? "Timed with MyLaps" : "Timed with RFID"}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4 flex-shrink-0">
            {event.bestPosition !== null && (
              <div className="text-center">
                <div className="text-xs text-muted-foreground mb-0.5">Best</div>
                <Badge variant="outline" className={`font-heading font-bold border ${positionBadge(event.bestPosition)}`}>
                  P{event.bestPosition}
                </Badge>
              </div>
            )}
            <div className="text-center">
              <div className="text-xs text-muted-foreground mb-0.5">Points</div>
              <div className="font-heading font-bold text-primary text-lg">{event.totalPoints}</div>
            </div>
            {open ? <ChevronUp size={16} className="text-muted-foreground" /> : <ChevronDown size={16} className="text-muted-foreground" />}
          </div>
        </div>
      </CardHeader>

      {open && (
        <CardContent className="pt-0 space-y-2">
          {event.motos.map((moto) => (
            <MotoRow key={moto.motoId} moto={moto} />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

// ─── Practice history components ─────────────────────────────────────────────

function PracticeSessionCard({ session }: { session: PracticeSessionHistory }) {
  const [open, setOpen] = useState(false);
  const lapsWithTime = session.laps.filter(l => l.lapTimeMs !== null && l.lapTimeMs > 0);

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none py-4"
        onClick={() => setOpen(v => !v)}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Timer size={15} className="text-primary shrink-0" />
              <CardTitle className="font-heading font-bold text-base uppercase tracking-tight truncate">
                {session.sessionName}
              </CardTitle>
            </div>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              {session.startedAt && (
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  <Calendar size={13} />
                  {new Date(session.startedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                </span>
              )}
              {session.startedAt && (
                <span className="text-xs text-muted-foreground">
                  {new Date(session.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-5 flex-shrink-0">
            <div className="text-center">
              <div className="text-xs text-muted-foreground mb-0.5">Laps</div>
              <div className="font-heading font-bold text-xl">{session.lapCount}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-muted-foreground mb-0.5">Best Lap</div>
              <div className="font-mono font-bold text-primary text-sm">
                {formatMs(session.bestLapMs)}
              </div>
            </div>
            {open ? <ChevronUp size={16} className="text-muted-foreground" /> : <ChevronDown size={16} className="text-muted-foreground" />}
          </div>
        </div>
      </CardHeader>

      {open && lapsWithTime.length > 0 && (
        <CardContent className="pt-0">
          <div className="border-t pt-3">
            <div className="text-xs text-muted-foreground mb-3 font-heading uppercase tracking-wider">
              Lap Times
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
              {lapsWithTime.map((lap) => {
                const isBest = lap.lapTimeMs === session.bestLapMs;
                return (
                  <div
                    key={lap.lapNumber}
                    className={`rounded px-2 py-2 text-center border ${
                      isBest
                        ? "bg-primary/10 border-primary/30"
                        : "bg-muted border-transparent"
                    }`}
                  >
                    <div className="text-xs text-muted-foreground">Lap {lap.lapNumber}</div>
                    <div className={`font-mono text-xs font-bold mt-0.5 ${isBest ? "text-primary" : ""}`}>
                      {formatMs(lap.lapTimeMs)}
                    </div>
                    {isBest && (
                      <div className="text-xs text-primary font-bold mt-0.5">Best</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </CardContent>
      )}

      {open && lapsWithTime.length === 0 && (
        <CardContent className="pt-0">
          <div className="border-t pt-3 text-center text-sm text-muted-foreground py-4">
            No timed laps recorded in this session
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ─── Schedule components ──────────────────────────────────────────────────────

function motoStatusBadge(status: string) {
  if (status === "in_progress") return "bg-green-500/20 text-green-700 border-green-400/50";
  if (status === "completed") return "bg-muted text-muted-foreground border-border";
  return "bg-muted/50 text-muted-foreground border-border/50";
}

function motoTypeLabel(type: string) {
  if (type === "heat") return "Heat";
  if (type === "main") return "Main Event";
  if (type === "lcq") return "LCQ";
  return type;
}

function ScheduleMotoCard({ moto, riderId }: { moto: ScheduleMoto; riderId: number }) {
  const [open, setOpen] = useState(false);
  const isLive = moto.status === "in_progress";
  const isDone = moto.status === "completed";

  if (!moto.isRiderInMoto) {
    // Greyed-out compact row
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-lg border bg-muted/30 opacity-50 select-none">
        <span className="font-mono text-sm text-muted-foreground w-6 text-center shrink-0">
          {moto.motoNumber}
        </span>
        <span className="text-sm text-muted-foreground flex-1 truncate">{moto.name}</span>
        <Badge variant="outline" className="text-xs shrink-0 capitalize">{motoTypeLabel(moto.type)}</Badge>
        <Badge variant="outline" className={`text-xs shrink-0 border ${motoStatusBadge(moto.status)}`}>
          {moto.status === "in_progress" ? "Live" : moto.status === "completed" ? "Done" : "Upcoming"}
        </Badge>
      </div>
    );
  }

  // Full-color card for rider's own motos
  return (
    <div className={`rounded-xl border-2 overflow-hidden ${
      isLive
        ? "border-green-500 shadow-lg shadow-green-500/10"
        : isDone
        ? "border-border"
        : "border-primary/60"
    }`}>
      {/* Header */}
      <div className={`px-4 py-3 flex items-center justify-between gap-3 ${
        isLive ? "bg-green-500 text-white" : isDone ? "bg-muted" : "bg-primary text-primary-foreground"
      }`}>
        <div className="flex items-center gap-2 min-w-0">
          {isLive && <Radio size={14} className="animate-pulse shrink-0" />}
          <span className="font-heading font-bold text-base uppercase tracking-tight truncate">
            {moto.name}
          </span>
          <Badge className={`text-xs shrink-0 font-bold ${
            isLive
              ? "bg-white/20 text-white border-white/30"
              : isDone
              ? "bg-muted-foreground/20 text-muted-foreground border-border"
              : "bg-white/20 text-white border-white/30"
          } border`}>
            {moto.status === "in_progress" ? "Live Now" : moto.status === "completed" ? "Finished" : "Upcoming"}
          </Badge>
        </div>
        <button
          onClick={() => setOpen(v => !v)}
          className="shrink-0 opacity-80 hover:opacity-100 transition-opacity"
          aria-label="Toggle lineup"
        >
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>

      {/* Gate highlight */}
      <div className="flex items-center gap-4 px-4 py-3 bg-background border-b">
        <div className="flex items-center gap-3">
          <div className="flex flex-col items-center justify-center w-16 h-16 rounded-xl bg-foreground text-background shrink-0">
            <DoorOpen size={18} className="mb-0.5 opacity-70" />
            <span className="font-heading font-black text-2xl leading-none">{moto.riderGate}</span>
            <span className="text-[9px] font-bold uppercase tracking-wider opacity-60 mt-0.5">Gate</span>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wider font-bold">Your Starting Gate</div>
            <div className="text-sm text-muted-foreground mt-0.5">
              {moto.raceClass && <span className="text-foreground font-semibold">{moto.raceClass}</span>}
              {" · "}
              {motoTypeLabel(moto.type)}
              {moto.lapCount && <span className="text-muted-foreground"> · {moto.lapCount} laps</span>}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {moto.lineup.length} rider{moto.lineup.length !== 1 ? "s" : ""} in this moto
            </div>
          </div>
        </div>
      </div>

      {/* Lineup (expandable) */}
      {open && moto.lineup.length > 0 && (
        <div className="bg-background">
          <div className="px-4 pt-3 pb-1 text-xs font-heading font-bold uppercase tracking-wider text-muted-foreground">
            Starting Order
          </div>
          <div className="divide-y">
            {moto.lineup.map(entry => {
              const isMe = entry.riderId === riderId;
              return (
                <div
                  key={entry.gate}
                  className={`flex items-center gap-3 px-4 py-2.5 ${
                    isMe ? "bg-foreground text-background" : ""
                  }`}
                >
                  <span className={`w-8 h-8 rounded-full flex items-center justify-center font-heading font-bold text-sm shrink-0 ${
                    isMe
                      ? "bg-background/20 text-background"
                      : "bg-muted text-muted-foreground"
                  }`}>
                    {entry.gate}
                  </span>
                  <span className={`flex-1 text-sm font-medium ${isMe ? "font-bold" : ""}`}>
                    {entry.riderName}
                    {isMe && <span className="ml-2 text-xs opacity-70 font-normal">(you)</span>}
                  </span>
                  {entry.bibNumber && (
                    <span className={`text-xs font-mono shrink-0 ${isMe ? "opacity-70" : "text-muted-foreground"}`}>
                      #{entry.bibNumber}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="w-full text-xs text-muted-foreground hover:text-foreground py-2 transition-colors text-center border-t"
        >
          Show all {moto.lineup.length} riders · tap to expand
        </button>
      )}
    </div>
  );
}

function ScheduleEventSection({ event, riderId }: { event: ScheduleEvent; riderId: number }) {
  const isRaceDay = event.status === "race_day";
  const hasLiveMotos = event.motos.some(m => m.status === "in_progress");
  const myMotos = event.motos.filter(m => m.isRiderInMoto);

  return (
    <div className="space-y-3">
      {/* Event header */}
      <div className={`flex items-start justify-between gap-3 p-4 rounded-xl border ${
        isRaceDay ? "bg-primary/5 border-primary/30" : "bg-muted/30 border-border"
      }`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-heading font-bold text-lg uppercase tracking-tight">{event.eventName}</h3>
            {hasLiveMotos && (
              <span className="flex items-center gap-1 text-xs font-bold text-green-600 bg-green-500/10 border border-green-500/30 rounded-full px-2 py-0.5">
                <Radio size={10} className="animate-pulse" /> Live
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 flex-wrap text-sm text-muted-foreground">
            {event.eventDate && (
              <span className="flex items-center gap-1">
                <Calendar size={12} />
                {new Date(event.eventDate).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              </span>
            )}
            {(event.eventLocation || event.eventState) && (
              <span className="flex items-center gap-1">
                <MapPin size={12} />
                {event.eventLocation ?? event.eventState}
              </span>
            )}
            {event.raceClass && (
              <Badge variant="secondary" className="text-xs">{event.raceClass}</Badge>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs text-muted-foreground">Your races</div>
          <div className="font-heading font-bold text-2xl text-primary">{myMotos.length}</div>
        </div>
      </div>

      {/* Motos */}
      <div className="space-y-2 pl-1">
        {event.motos.map(moto => (
          <ScheduleMotoCard key={moto.motoId} moto={moto} riderId={riderId} />
        ))}
        {event.motos.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No races scheduled yet — check back closer to race day.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function RiderHistory() {
  const [, params] = useRoute("/rider/portal/:riderId");
  const riderId = parseInt(params?.riderId ?? "0", 10);
  const [activeTab, setActiveTab] = useState<"today" | "races" | "practice">("today");

  const { data, isLoading, error } = useQuery<RiderHistoryResponse>({
    queryKey: ["rider-history", riderId],
    queryFn: () => riderApi.history(riderId),
    enabled: !!riderId,
  } as any);

  const { data: practiceData, isLoading: practiceLoading } = useQuery<RiderPracticeResponse>({
    queryKey: ["rider-practice", riderId],
    queryFn: () => riderApi.practice(riderId),
    enabled: !!riderId,
  } as any);

  const { data: scheduleData, isLoading: scheduleLoading } = useQuery<RiderScheduleResponse>({
    queryKey: ["rider-schedule", riderId],
    queryFn: () => riderApi.schedule(riderId),
    enabled: !!riderId,
    refetchInterval: 30_000,
  } as any);

  const rider = data?.rider;
  const history = data?.history ?? [];
  const practiceSessions = practiceData?.sessions ?? [];

  const totalPoints = history.reduce((s, e) => s + e.totalPoints, 0);
  const eventsRaced = history.length;
  const allFinishes = history.flatMap((e) => e.motos).filter((m) => !m.dnf && !m.dns);
  const bestPosition = allFinishes.length > 0 ? Math.min(...allFinishes.map((m) => m.position)) : null;

  const totalPracticeLaps = practiceSessions.reduce((s, sess) => s + sess.lapCount, 0);
  const allPracticeTimes = practiceSessions.flatMap(s => s.laps.filter(l => l.lapTimeMs !== null && l.lapTimeMs > 0).map(l => l.lapTimeMs!));
  const overallBestPracticeMs = allPracticeTimes.length > 0 ? Math.min(...allPracticeTimes) : null;

  return (
    <RiderLayout showBack backTo="/rider/portal" backLabel="My Profiles">
      {isLoading ? (
        <div className="space-y-4">
          <div className="h-24 bg-muted animate-pulse rounded-xl" />
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 bg-muted animate-pulse rounded-xl" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="p-12 text-center">
            <AlertTriangle size={40} className="mx-auto text-destructive/40 mb-3" />
            <p className="text-muted-foreground">{(error as Error).message}</p>
          </CardContent>
        </Card>
      ) : rider ? (
        <div className="space-y-6">
          {/* Rider header */}
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <User size={24} className="text-primary" />
            </div>
            <div className="flex-1">
              <h1 className="font-heading font-bold text-3xl uppercase tracking-tight">
                {rider.firstName} {rider.lastName}
              </h1>
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                {rider.bibNumber && (
                  <span className="flex items-center gap-1 text-muted-foreground text-sm">
                    <Hash size={13} /> #{rider.bibNumber}
                  </span>
                )}
                {rider.dateOfBirth && (
                  <span className="flex items-center gap-1 text-muted-foreground text-sm">
                    <Calendar size={13} /> Born {rider.dateOfBirth}
                  </span>
                )}
              </div>
              <RfidEditor riderId={rider.id} currentRfid={rider.rfidNumber ?? null} />
            </div>
          </div>

          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-3">
            <Card>
              <CardContent className="p-4 text-center">
                <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1.5">
                  <Calendar size={11} /> Events Raced
                </div>
                <div className="font-heading font-bold text-3xl">{eventsRaced}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1.5">
                  <Trophy size={11} /> Best Finish
                </div>
                <div className="font-heading font-bold text-3xl">
                  {bestPosition ? `P${bestPosition}` : "—"}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 text-center">
                <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1.5">
                  <Star size={11} /> Total Points
                </div>
                <div className="font-heading font-bold text-3xl text-primary">{totalPoints}</div>
              </CardContent>
            </Card>
          </div>

          {/* Tab switcher */}
          <div className="flex gap-1 border-b border-border overflow-x-auto">
            {/* Today tab */}
            {(() => {
              const scheduleEvents = scheduleData?.events ?? [];
              const hasLive = scheduleEvents.some(e => e.motos.some(m => m.status === "in_progress"));
              return (
                <button
                  onClick={() => setActiveTab("today")}
                  className={`flex items-center gap-2 px-4 py-2.5 text-sm font-heading font-bold uppercase tracking-wider transition-colors border-b-2 -mb-px shrink-0 ${
                    activeTab === "today"
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {hasLive ? <Radio size={14} className="animate-pulse text-green-500" /> : <Flag size={14} />}
                  Today
                  {scheduleEvents.length > 0 && (
                    <span className={`text-xs rounded-full px-1.5 py-0.5 font-mono ${
                      activeTab === "today"
                        ? hasLive ? "bg-green-500/10 text-green-600" : "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      {scheduleEvents.length}
                    </span>
                  )}
                </button>
              );
            })()}
            <button
              onClick={() => setActiveTab("races")}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-heading font-bold uppercase tracking-wider transition-colors border-b-2 -mb-px shrink-0 ${
                activeTab === "races"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Trophy size={14} />
              Race History
              {eventsRaced > 0 && (
                <span className={`text-xs rounded-full px-1.5 py-0.5 font-mono ${
                  activeTab === "races" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                }`}>
                  {eventsRaced}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab("practice")}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-heading font-bold uppercase tracking-wider transition-colors border-b-2 -mb-px shrink-0 ${
                activeTab === "practice"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Timer size={14} />
              Practice
              {practiceSessions.length > 0 && (
                <span className={`text-xs rounded-full px-1.5 py-0.5 font-mono ${
                  activeTab === "practice" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                }`}>
                  {practiceSessions.length}
                </span>
              )}
            </button>
          </div>

          {/* Today / Schedule tab */}
          {activeTab === "today" && (
            <div>
              {scheduleLoading ? (
                <div className="space-y-4">
                  {[1, 2].map(i => <div key={i} className="h-40 bg-muted animate-pulse rounded-xl" />)}
                </div>
              ) : !scheduleData?.events.length ? (
                <Card>
                  <CardContent className="p-12 text-center">
                    <Flag size={40} className="mx-auto text-muted-foreground/30 mb-3" />
                    <h3 className="font-heading font-bold text-lg uppercase mb-1">No Active Events</h3>
                    <p className="text-muted-foreground text-sm">
                      You're not registered for any upcoming events yet.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-8">
                  {scheduleData.events.map(event => (
                    <ScheduleEventSection key={event.eventId} event={event} riderId={riderId} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Race History tab */}
          {activeTab === "races" && (
            <div>
              {history.length === 0 ? (
                <Card>
                  <CardContent className="p-12 text-center">
                    <Flag size={40} className="mx-auto text-muted-foreground/30 mb-3" />
                    <p className="text-muted-foreground text-sm">No race results yet</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-3">
                  {history.map((event) => (
                    <EventCard key={event.eventId} event={event} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Practice tab */}
          {activeTab === "practice" && (
            <div>
              {practiceLoading ? (
                <div className="space-y-3">
                  {[1, 2].map(i => (
                    <div key={i} className="h-24 bg-muted animate-pulse rounded-xl" />
                  ))}
                </div>
              ) : practiceSessions.length === 0 ? (
                <Card>
                  <CardContent className="p-12 text-center">
                    <Timer size={40} className="mx-auto text-muted-foreground/30 mb-3" />
                    <p className="text-muted-foreground text-sm">No practice sessions recorded yet</p>
                    <p className="text-muted-foreground text-xs mt-1">
                      Practice lap times appear here when your RFID tag is captured during an open practice session.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-3">
                  {/* Practice summary bar */}
                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <Card>
                      <CardContent className="p-4 text-center">
                        <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1.5">
                          <Timer size={11} /> Sessions
                        </div>
                        <div className="font-heading font-bold text-3xl">{practiceSessions.length}</div>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="p-4 text-center">
                        <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1.5">
                          <Flag size={11} /> Total Laps
                        </div>
                        <div className="font-heading font-bold text-3xl">{totalPracticeLaps}</div>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="p-4 text-center">
                        <div className="flex items-center justify-center gap-1 text-muted-foreground text-xs mb-1.5">
                          <Clock size={11} /> Best Lap
                        </div>
                        <div className="font-heading font-bold text-xl text-primary font-mono">
                          {formatMs(overallBestPracticeMs)}
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  {practiceSessions.map((session) => (
                    <PracticeSessionCard key={session.sessionId} session={session} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}
    </RiderLayout>
  );
}
