import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useListEvents, useListMotos } from "@workspace/api-client-react";
import type { Moto, Event } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Flag, Timer, CheckCircle2, Clock, Users, ChevronRight } from "lucide-react";

function statusPill(status: string) {
  if (status === "in_progress") {
    return (
      <Badge className="bg-green-600 text-white text-xs font-bold uppercase tracking-wider gap-1.5">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
        </span>
        In Progress
      </Badge>
    );
  }
  if (status === "completed") {
    return (
      <Badge variant="secondary" className="text-xs uppercase tracking-wider">
        <CheckCircle2 size={11} className="mr-1" />
        Complete
      </Badge>
    );
  }
  if (status === "cancelled") {
    return <Badge variant="destructive" className="text-xs uppercase tracking-wider">Cancelled</Badge>;
  }
  return (
    <Badge variant="outline" className="text-xs uppercase tracking-wider">
      <Clock size={11} className="mr-1" />
      Upcoming
    </Badge>
  );
}

interface LineupEntry {
  position: number;
  riderId: number;
  riderName: string;
  bibNumber?: string | null;
  gateNumber?: number | null;
}

function MotoCard({ moto, index }: { moto: Moto; index: number }) {
  const lineup: LineupEntry[] = Array.isArray(moto.lineup) ? (moto.lineup as LineupEntry[]) : [];
  const sortedLineup = [...lineup].sort((a, b) => a.position - b.position);

  const isInProgress = moto.status === "in_progress";
  const isComplete = moto.status === "completed";

  return (
    <div className={`rounded-2xl border-2 p-5 transition-all ${
      isInProgress
        ? "border-green-500 bg-green-50 shadow-lg shadow-green-100"
        : isComplete
        ? "border-muted bg-muted/30 opacity-60"
        : "border-border bg-card"
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-heading font-bold text-xs uppercase tracking-widest text-muted-foreground">
              Moto {moto.motoNumber ?? index + 1}
            </span>
            {moto.type && moto.type !== "main" && (
              <Badge variant="outline" className="text-xs capitalize">{moto.type}</Badge>
            )}
          </div>
          <h2 className="font-heading font-bold text-xl uppercase tracking-wide mt-0.5">{moto.name}</h2>
          <p className="text-sm text-muted-foreground font-semibold">
            {moto.raceClasses?.length ? moto.raceClasses.join(" · ") : moto.raceClass ?? ""}
          </p>
        </div>
        <div className="shrink-0">{statusPill(moto.status)}</div>
      </div>

      {/* Rider lineup */}
      {sortedLineup.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
            <Users size={12} />
            Gate Order
          </div>
          {sortedLineup.map((entry, i) => (
            <div
              key={entry.riderId}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${
                i === 0 && !isComplete
                  ? "bg-primary/10 border border-primary/20"
                  : "bg-background/60 border border-border/40"
              }`}
            >
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
                i === 0 && !isComplete
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}>
                {i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-base leading-tight truncate">{entry.riderName}</p>
                {entry.bibNumber && (
                  <p className="text-xs text-muted-foreground">#{entry.bibNumber}</p>
                )}
              </div>
              {i === 0 && !isComplete && (
                <span className="text-xs font-bold text-primary uppercase tracking-wider shrink-0">
                  First Pick
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground italic">No riders assigned yet</p>
      )}

      {/* Scheduled time */}
      {moto.scheduledTime && (
        <div className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground">
          <Timer size={11} />
          {new Date(moto.scheduledTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      )}
    </div>
  );
}

export default function GateSchedulePage() {
  const { user } = useAuth();
  const clubId = user?.clubId;

  const { data: events = [] } = useListEvents(
    { clubId: clubId ?? undefined, status: "race_day" } as any,
    { query: { enabled: !!clubId, refetchInterval: 30_000 } as any }
  );

  const raceDayEvents = events as Event[];
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);

  const activeEventId = selectedEventId ?? (raceDayEvents[0]?.id ?? null);

  const { data: motos = [] } = useListMotos(
    activeEventId!,
    { query: { enabled: !!activeEventId, refetchInterval: 5_000 } as any }
  );

  const sortedMotos = [...(motos as Moto[])].sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));
  const upcomingAndActive = sortedMotos.filter((m) => m.status !== "completed" && m.status !== "cancelled");
  const completed = sortedMotos.filter((m) => m.status === "completed" || m.status === "cancelled");

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-sidebar text-sidebar-foreground px-4 py-4 sticky top-0 z-10 shadow-md">
        <div className="max-w-lg mx-auto">
          <div className="flex items-center gap-2 mb-3">
            <Flag size={18} className="text-primary" />
            <h1 className="font-heading font-bold text-lg uppercase tracking-widest">Gate Schedule</h1>
            <span className="ml-auto text-xs text-sidebar-foreground/50 uppercase tracking-wider animate-pulse">Live</span>
          </div>

          {raceDayEvents.length > 1 && (
            <Select
              value={activeEventId?.toString() ?? ""}
              onValueChange={(v) => setSelectedEventId(Number(v))}
            >
              <SelectTrigger className="bg-sidebar-accent border-sidebar-border text-sidebar-foreground text-sm">
                <SelectValue placeholder="Select event" />
              </SelectTrigger>
              <SelectContent>
                {raceDayEvents.map((ev) => (
                  <SelectItem key={ev.id} value={ev.id.toString()}>
                    {ev.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {raceDayEvents[0] && raceDayEvents.length === 1 && (
            <p className="text-sm text-sidebar-foreground/70 font-medium">{raceDayEvents[0].name}</p>
          )}
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-4 space-y-4">
        {!activeEventId ? (
          <div className="text-center py-20">
            <Flag size={40} className="mx-auto mb-3 text-muted-foreground/30" />
            <p className="font-heading font-semibold text-lg mb-1">No active race event</p>
            <p className="text-sm text-muted-foreground">Gate schedule is only available during race day.</p>
          </div>
        ) : sortedMotos.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground">
            <p>No motos scheduled yet.</p>
          </div>
        ) : (
          <>
            {upcomingAndActive.length > 0 && (
              <div className="space-y-3">
                {upcomingAndActive.map((moto, i) => (
                  <MotoCard key={moto.id} moto={moto} index={i} />
                ))}
              </div>
            )}

            {completed.length > 0 && (
              <details className="mt-4">
                <summary className="flex items-center gap-2 cursor-pointer text-sm font-semibold text-muted-foreground uppercase tracking-wider py-2 select-none">
                  <ChevronRight size={14} className="transition-transform details-open:rotate-90" />
                  Completed ({completed.length})
                </summary>
                <div className="space-y-3 mt-2">
                  {completed.map((moto, i) => (
                    <MotoCard key={moto.id} moto={moto} index={i} />
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
