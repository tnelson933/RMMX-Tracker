import { useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Trophy, Clock, Star, ChevronDown, ChevronUp,
  Flag, AlertTriangle, Calendar, MapPin, Hash, User, Timer
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RiderLayout } from "@/components/layout/RiderLayout";
import { riderApi, type RiderHistoryResponse, type EventHistory, type MotoResult } from "@/lib/rider-api";

function positionBadge(pos: number) {
  if (pos === 1) return "bg-yellow-400/20 text-yellow-600 border-yellow-400/40";
  if (pos === 2) return "bg-slate-200/40 text-slate-600 border-slate-300/60";
  if (pos === 3) return "bg-amber-500/20 text-amber-700 border-amber-400/40";
  return "bg-muted text-muted-foreground border-border";
}

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

export default function RiderHistory() {
  const [, params] = useRoute("/rider/portal/:riderId");
  const riderId = parseInt(params?.riderId ?? "0", 10);

  const { data, isLoading, error } = useQuery<RiderHistoryResponse>({
    queryKey: ["rider-history", riderId],
    queryFn: () => riderApi.history(riderId),
    enabled: !!riderId,
  } as any);

  const rider = data?.rider;
  const history = data?.history ?? [];

  const totalPoints = history.reduce((s, e) => s + e.totalPoints, 0);
  const eventsRaced = history.length;
  const allFinishes = history.flatMap((e) => e.motos).filter((m) => !m.dnf && !m.dns);
  const bestPosition = allFinishes.length > 0 ? Math.min(...allFinishes.map((m) => m.position)) : null;

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

          {/* Race history */}
          <div>
            <h2 className="font-heading font-bold text-lg uppercase tracking-wider mb-3 flex items-center gap-2">
              <Flag size={16} className="text-primary" /> Race History
            </h2>
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
        </div>
      ) : null}
    </RiderLayout>
  );
}
