import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useListUpcomingEvents } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, MapPin, Trophy, Navigation, CheckCircle, LocateFixed, ChevronRight } from "lucide-react";
import { format, parseISO } from "date-fns";
import { useUserLocation } from "@/hooks/useUserLocation";
import { haversineDistance } from "@/lib/haversine";
import { STATE_CENTROIDS } from "@/lib/stateCentroids";
import type { UpcomingEventItem } from "@workspace/api-client-react";

interface EventWithDistance extends UpcomingEventItem {
  distanceMi: number | null;
}

const RADIUS_OPTIONS = [
  { label: "50 mi", value: 50 },
  { label: "100 mi", value: 100 },
  { label: "200 mi", value: 200 },
  { label: "Any", value: null },
] as const;

type RadiusMi = 50 | 100 | 200 | null;

function NearMeCard({ event }: { event: EventWithDistance }) {
  return (
    <Link href={`/register/${event.eventId}`}>
      <Card className="hover-elevate cursor-pointer hover:border-primary transition-all h-full overflow-hidden flex flex-col group">
        <CardContent className="p-0 flex flex-col flex-1">
          <div className="bg-green-600 px-4 py-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-white text-xs font-bold uppercase tracking-widest">
              <CheckCircle size={12} />
              Registration Open
            </span>
            {event.distanceMi !== null && (
              <span className="flex items-center gap-1 text-white/90 text-xs font-semibold">
                <Navigation size={11} />
                ~{Math.round(event.distanceMi).toLocaleString()} mi away
              </span>
            )}
          </div>
          <div className="p-4 flex flex-col flex-1">
            <h3 className="font-heading font-bold text-base leading-tight mb-3 group-hover:text-primary transition-colors">
              {event.name}
            </h3>
            <div className="space-y-1.5 text-sm text-muted-foreground flex-1">
              <div className="flex items-center gap-1.5">
                <Calendar size={13} className="flex-shrink-0 text-muted-foreground/60" />
                {format(parseISO(event.date.substring(0, 10)), "EEE, MMM d, yyyy")}
              </div>
              {(event.location || event.trackName) && (
                <div className="flex items-center gap-1.5">
                  <MapPin size={13} className="flex-shrink-0 text-muted-foreground/60" />
                  {event.trackName ? `${event.trackName}, ${event.location}` : event.location}
                </div>
              )}
              {event.clubName && (
                <div className="flex items-center gap-1.5">
                  <Trophy size={13} className="flex-shrink-0 text-muted-foreground/60" />
                  {event.clubName}
                </div>
              )}
            </div>
            <div className="mt-3 pt-3 border-t flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider bg-muted px-2 py-0.5 rounded">
                {event.state}
              </span>
              <span className="text-primary text-xs font-heading font-bold uppercase tracking-wide group-hover:underline flex items-center gap-0.5">
                Register Now <ChevronRight size={12} />
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export function UpcomingNearMe() {
  const location = useUserLocation();
  const { data: allEvents, isLoading } = useListUpcomingEvents({ query: {} as any });
  const [radiusMi, setRadiusMi] = useState<RadiusMi>(100);
  const [selectedState, setSelectedState] = useState("all");

  const events = useMemo(
    () => allEvents?.filter((e) => e.status === "registration_open") ?? [],
    [allEvents]
  );

  // All states available in the open-registration events
  const availableStates = useMemo(
    () => [...new Set(events.map((e) => e.state))].sort(),
    [events]
  );

  const sorted = useMemo<EventWithDistance[]>(() => {
    if (!events) return [];
    const withDist: EventWithDistance[] = events.map((e) => {
      const centroid = STATE_CENTROIDS[e.state];
      const distanceMi =
        location.status === "granted" && centroid
          ? haversineDistance(
              (location as { lat: number; lng: number }).lat,
              (location as { lat: number; lng: number }).lng,
              centroid.lat,
              centroid.lng
            )
          : null;
      return { ...e, distanceMi };
    });

    if (location.status === "granted") {
      return withDist.sort((a, b) => (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity));
    }
    return withDist.sort((a, b) => a.date.localeCompare(b.date));
  }, [events, location]);

  const filtered = useMemo<EventWithDistance[]>(() => {
    let result = sorted;
    // radius filter (only when location is known)
    if (location.status === "granted" && radiusMi !== null) {
      result = result.filter((e) => e.distanceMi === null || e.distanceMi <= radiusMi);
    }
    // state filter
    if (selectedState !== "all") {
      result = result.filter((e) => e.state === selectedState);
    }
    return result;
  }, [sorted, radiusMi, location.status, selectedState]);

  const isPending = location.status === "pending" || isLoading;
  const locationGranted = !isPending && location.status === "granted";
  const locationDenied = !isPending && (location.status === "denied" || location.status === "unavailable");

  const emptyStateLabel =
    locationGranted && radiusMi !== null && selectedState === "all"
      ? `No races within ${radiusMi} miles with open registration`
      : selectedState !== "all"
      ? `No races in ${selectedState} with open registration right now`
      : "No races with open registration right now";

  return (
    <section className="container mx-auto px-4">
      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
        <div>
          <h2 className="text-2xl font-heading font-bold uppercase tracking-tight">
            Upcoming Races Near Me
          </h2>
          {locationGranted && (
            <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1">
              <Navigation size={12} /> Sorted by distance from your location.
            </p>
          )}
          {locationDenied && (
            <p className="text-sm text-muted-foreground mt-1">
              Showing events by date — enable location for distance sorting.
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {/* Allow Location button — shown when denied/unavailable */}
          {locationDenied && location.status === "denied" && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 font-heading uppercase tracking-wider text-xs border-primary/40 text-primary hover:bg-primary/5"
              onClick={() => location.retry()}
            >
              <LocateFixed size={13} />
              Allow Location
            </Button>
          )}
          <Badge
            variant="outline"
            className="text-green-600 border-green-600/40 bg-green-600/5 font-semibold self-start sm:self-auto"
          >
            Registration Open
          </Badge>
        </div>
      </div>

      {/* Controls row: radius pills (location) + state chips */}
      {!isPending && (locationGranted || availableStates.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mb-5">
          {/* Radius pills — only when location granted */}
          {locationGranted && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Within:
              </span>
              {RADIUS_OPTIONS.map((opt) => {
                const active = radiusMi === opt.value;
                return (
                  <button
                    key={opt.label}
                    onClick={() => setRadiusMi(opt.value as RadiusMi)}
                    className={`px-3 py-1 rounded-full text-xs font-bold border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:border-primary/60 hover:text-foreground"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}

          {/* State chips */}
          {availableStates.length > 1 && (
            <div className="flex items-center gap-2 flex-wrap">
              {locationGranted && <span className="text-muted-foreground/40 text-sm hidden sm:block">|</span>}
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                State:
              </span>
              <button
                onClick={() => setSelectedState("all")}
                className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide border transition-colors ${
                  selectedState === "all"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-muted-foreground border-border hover:border-primary/60 hover:text-foreground"
                }`}
              >
                All
              </button>
              {availableStates.map((s) => (
                <button
                  key={s}
                  onClick={() => setSelectedState(s)}
                  className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide border transition-colors ${
                    selectedState === s
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-muted-foreground border-border hover:border-primary/60 hover:text-foreground"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {isPending ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-44 bg-muted rounded-md animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-14 text-center bg-muted/40 rounded-lg border border-dashed">
          <CheckCircle className="mx-auto mb-3 text-muted-foreground opacity-30" size={40} />
          <p className="font-heading font-bold uppercase text-muted-foreground">
            {emptyStateLabel}
          </p>
          <div className="flex items-center justify-center gap-3 mt-3 flex-wrap">
            {locationGranted && radiusMi !== null && (
              <Button variant="outline" size="sm" className="text-xs" onClick={() => setRadiusMi(null)}>
                Show all distances
              </Button>
            )}
            {selectedState !== "all" && (
              <Button variant="outline" size="sm" className="text-xs" onClick={() => setSelectedState("all")}>
                Clear state filter
              </Button>
            )}
            {!locationGranted && (
              <p className="text-sm text-muted-foreground">Check back soon!</p>
            )}
          </div>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((e) => (
            <NearMeCard key={e.eventId} event={e} />
          ))}
        </div>
      )}
    </section>
  );
}
