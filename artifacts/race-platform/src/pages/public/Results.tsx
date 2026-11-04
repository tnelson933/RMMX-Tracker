import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useListRecentResults, useListStates } from "@workspace/api-client-react";
import { defaultSide, nextScheduled, splitLivePast } from "@workspace/rider-insights/liveRaces";
import { OfficialResultsBadge } from "@/components/OfficialResultsBadge";
import { TitleBand } from "@/components/TitleBand";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MapPin, Trophy, Flag, ChevronRight, Search, Radio, Calendar } from "lucide-react";
import { format, parseISO } from "date-fns";
import { formatEventDates, localDateString } from "@/lib/eventDates";

interface ListEvent {
  id: number;
  name: string;
  state: string;
  date: string;
  endDate: string | null;
  location: string | null;
  trackName: string | null;
  clubName: string | null;
  status: string;
  official?: boolean | null;
}

/** Race-day and finished events (same list the rider app's Results tab uses). */
async function fetchBrowse(): Promise<ListEvent[]> {
  const res = await fetch("/api/public/events/browse");
  if (!res.ok) throw new Error("Could not load races");
  const rows = await res.json() as Array<Record<string, any>>;
  return rows.map(r => ({
    id: Number(r.eventId ?? r.id), name: r.name, state: r.state, date: r.date, endDate: r.endDate ?? null,
    location: r.location ?? null, trackName: r.trackName ?? null, clubName: r.clubName ?? null, status: r.status,
  }));
}

async function fetchUpcoming(): Promise<ListEvent[]> {
  const res = await fetch("/api/public/upcoming");
  if (!res.ok) throw new Error("Could not load upcoming races");
  const rows = await res.json() as Array<Record<string, any>>;
  return rows.map(r => ({
    id: Number(r.id ?? r.eventId), name: r.name, state: r.state, date: r.date, endDate: r.endDate ?? null,
    location: r.location ?? null, trackName: r.trackName ?? null, clubName: r.clubName ?? null, status: r.status,
  }));
}

type Side = "live" | "past";

export default function Results() {
  const searchParams = new URLSearchParams(window.location.search);
  const initialState = searchParams.get("state") || "all";

  const [stateFilter, setStateFilter] = useState(initialState);
  const [pickedSide, setPickedSide] = useState<Side | null>(null);

  const { data: states, isLoading: statesLoading } = useListStates();

  // Finished events, newest first, each with whether its results are official yet.
  const { data: eventsRaw, isLoading: eventsLoading } = useListRecentResults({
    state: stateFilter === "all" ? undefined : stateFilter,
    limit: 200,
  } as any);

  const { data: browse = [], isLoading: browseLoading } = useQuery({ queryKey: ["public-events-browse"], queryFn: fetchBrowse, refetchInterval: 30_000 });
  const { data: upcoming = [] } = useQuery({ queryKey: ["public-upcoming"], queryFn: fetchUpcoming });

  const today = localDateString();
  const inState = (e: ListEvent) => stateFilter === "all" || e.state === stateFilter;
  const live = splitLivePast(browse, today).live.filter(inState);
  const liveIds = new Set(live.map(e => e.id));
  const side: Side = pickedSide ?? defaultSide(live.length);
  const comingUp = nextScheduled(upcoming.filter(inState), today, 4);

  const past: ListEvent[] = (eventsRaw ?? [])
    .filter(r => !liveIds.has(r.eventId))
    .map(r => ({
      id: r.eventId,
      name: r.eventName,
      state: r.state,
      date: r.date,
      endDate: r.endDate ?? null,
      location: r.location ?? null,
      trackName: r.trackName ?? null,
      clubName: r.clubName ?? null,
      status: "completed",
      official: r.official,
    }));

  return (
    <div>
      <TitleBand
        containerClassName="max-w-5xl"
        eyebrow="Race results"
        title="Race Results"
        subtitle="Follow races live on race day, or browse finished events. Results are marked unofficial until the organizer finalizes them."
      >
        <div className="w-full md:w-64">
          <Select value={stateFilter} onValueChange={setStateFilter}>
            <SelectTrigger className="h-[52px] rounded-full border-2 border-[#8C8C8C] bg-white text-[#333] px-5 text-base">
              <SelectValue placeholder="Filter by State" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All States</SelectItem>
              {!statesLoading && states?.map(state => (
                <SelectItem key={state.state} value={state.state}>
                  {state.state} ({state.eventCount})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </TitleBand>

      <div className="container mx-auto px-4 py-8 max-w-5xl">
        <div role="tablist" aria-label="Live or past races" className="mb-6 flex gap-2 max-w-sm">
          {(["live", "past"] as Side[]).map(k => {
            const active = side === k;
            return (
              <button
                key={k}
                role="tab"
                aria-selected={active}
                onClick={() => setPickedSide(k)}
                className={`flex-1 inline-flex items-center justify-center gap-2 rounded-full border-2 py-2 font-heading font-bold uppercase tracking-[1px] text-[15px] transition-colors ${
                  active ? "border-[#242424] bg-[#242424] text-white" : "border-[#8C8C8C] bg-white text-[#333] hover:border-[#242424]"
                }`}
              >
                {k === "live" && <span className={`inline-block h-2 w-2 rounded-full ${live.length > 0 ? "bg-[#EF4444]" : "bg-[#8C8C8C]"}`} />}
                {k === "live" ? "Live" : "Past"}
                {k === "live" && live.length > 0 && (
                  <span aria-label={`${live.length} running`} className="min-w-[20px] rounded-full bg-[#D32F2F] px-1.5 text-[12px] leading-5 text-white font-sans">{live.length}</span>
                )}
              </button>
            );
          })}
        </div>

        {side === "live" ? (
          live.length > 0 ? (
            <div className="flex flex-col gap-4">
              {live.map(event => <EventRow key={event.id} event={event} live />)}
            </div>
          ) : (
            <div className="space-y-6">
              <Card>
                <CardContent className="flex flex-col items-center justify-center p-12 text-center">
                  <Radio className="text-muted-foreground opacity-30 mb-4" size={48} />
                  <h3 className="text-2xl font-heading font-bold mb-2">No races live right now</h3>
                  <p className="text-muted-foreground max-w-md">Races show up here on race day while they're running.</p>
                </CardContent>
              </Card>
              {comingUp.length > 0 && (
                <div>
                  <h4 className="mb-3 flex items-center gap-2 font-heading font-bold uppercase tracking-[1px] text-[15px] text-[#B30000]">
                    <Calendar size={16} /> Coming up
                  </h4>
                  <div className="flex flex-col gap-4">
                    {comingUp.map(event => <EventRow key={event.id} event={event} upcoming />)}
                  </div>
                </div>
              )}
            </div>
          )
        ) : eventsLoading || (browseLoading && pickedSide === null) ? (
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-6 h-28 bg-muted/50 rounded-md"></CardContent>
              </Card>
            ))}
          </div>
        ) : past.length ? (
          <div className="flex flex-col gap-4">
            {past.map(event => <EventRow key={event.id} event={event} />)}
          </div>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center p-16 text-center">
              <Search className="text-muted-foreground opacity-20 mb-6" size={64} />
              <h3 className="text-2xl font-heading font-bold mb-2">No Results Found</h3>
              <p className="text-muted-foreground max-w-md">
                {stateFilter !== "all"
                  ? `There are currently no results for events in ${stateFilter}.`
                  : "There are currently no results available."}
              </p>
              {stateFilter !== "all" && (
                <Button
                  variant="outline"
                  className="mt-6 font-heading uppercase"
                  onClick={() => setStateFilter("all")}
                >
                  Clear Filters
                </Button>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function EventRow({ event, live = false, upcoming = false }: { event: ListEvent; live?: boolean; upcoming?: boolean }) {
  const href = upcoming ? `/register/${event.id}` : `/results/${event.id}`;
  return (
    <Link href={href}>
      <Card className="hover-elevate cursor-pointer hover:border-primary transition-all group overflow-hidden">
        <CardContent className="p-0 flex flex-col sm:flex-row">
          <div className="bg-[#242424] p-6 flex flex-col justify-center items-center text-white sm:w-48 shrink-0 relative overflow-hidden border-b-[3px] sm:border-b-0 sm:border-r-[3px] border-primary">
            <div className="absolute inset-0 bg-primary/20 opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <div className="relative z-10 flex flex-col items-center text-center">
              <span className="text-sm font-bold text-sidebar-foreground/70 uppercase tracking-widest mb-1">
                {format(parseISO(event.date.substring(0, 10)), "MMM yyyy")}
              </span>
              {event.endDate ? (
                <span className="text-3xl font-heading font-bold leading-none">
                  {format(parseISO(event.date.substring(0, 10)), "d")}–{format(parseISO(event.endDate.substring(0, 10)), "d")}
                </span>
              ) : (
                <span className="text-5xl font-heading font-bold leading-none">
                  {format(parseISO(event.date.substring(0, 10)), "dd")}
                </span>
              )}
              <span className="text-xs text-sidebar-foreground/60 mt-1 font-medium">{formatEventDates(event.date, event.endDate)}</span>
            </div>
          </div>

          <div className="p-6 flex-1 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="bg-[#FDEAEA] text-primary px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-[0.5px]">
                  {event.state}
                </span>
                {live ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-[#D32F2F] px-2.5 py-1 text-xs font-bold uppercase tracking-[0.5px] text-white">
                    <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" /> Live
                  </span>
                ) : upcoming ? null : event.official != null ? (
                  <OfficialResultsBadge official={event.official} compact />
                ) : (
                  <span className="text-xs text-muted-foreground uppercase font-semibold tracking-wider flex items-center gap-1">
                    <Flag size={12} /> No results posted
                  </span>
                )}
              </div>
              <h3 className="text-2xl font-heading font-bold group-hover:text-primary transition-colors leading-tight mb-2">
                {event.name}
              </h3>
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
                {(event.location || event.trackName) && (
                  <div className="flex items-center gap-1.5">
                    <MapPin size={16} className="text-muted-foreground/70" />
                    {[event.trackName, event.location].filter(Boolean).join(", ")}
                  </div>
                )}
                {event.clubName && (
                  <div className="flex items-center gap-1.5">
                    <Trophy size={16} className="text-muted-foreground/70" />
                    {event.clubName}
                  </div>
                )}
              </div>
            </div>

            <div className="sm:text-right shrink-0">
              <Button variant="outline" className="border-2 border-[#8C8C8C] text-[#333] bg-white group-hover:bg-[#242424] group-hover:border-[#242424] group-hover:text-white transition-all">
                {live ? "Follow live" : upcoming ? "Event details" : "View Results"} <ChevronRight size={18} className="ml-1" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
