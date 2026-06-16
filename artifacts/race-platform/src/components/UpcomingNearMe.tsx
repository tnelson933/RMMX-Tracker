import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useListUpcomingEvents } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Calendar, MapPin, Trophy, Navigation, CheckCircle } from "lucide-react";
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
              <span className="text-primary text-xs font-heading font-bold uppercase tracking-wide group-hover:underline">
                Register Now →
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

  const events = useMemo(
    () => allEvents?.filter((e) => e.status === "registration_open") ?? [],
    [allEvents]
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
    if (location.status !== "granted" || radiusMi === null) return sorted;
    return sorted.filter((e) => e.distanceMi === null || e.distanceMi <= radiusMi);
  }, [sorted, radiusMi, location.status]);

  const isPending = location.status === "pending" || isLoading;
  const locationGranted = !isPending && location.status === "granted";

  const emptyStateLabel =
    locationGranted && radiusMi !== null
      ? `No races within ${radiusMi} miles right now`
      : "No races with open registration right now";

  return (
    <section className="container mx-auto px-4">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 mb-6">
        <div>
          <h2 className="text-2xl font-heading font-bold uppercase tracking-tight">
            Upcoming Races Near Me
          </h2>
          {!isPending && location.status === "denied" && (
            <p className="text-sm text-muted-foreground mt-1">
              Location access not granted — showing events by date.
            </p>
          )}
          {!isPending && location.status === "unavailable" && (
            <p className="text-sm text-muted-foreground mt-1">
              Location unavailable — showing events by date.
            </p>
          )}
          {locationGranted && (
            <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1">
              <Navigation size={12} /> Sorted by distance from your location.
            </p>
          )}
        </div>
        <Badge variant="outline" className="self-start sm:self-auto text-green-600 border-green-600/40 bg-green-600/5 font-semibold">
          Registration Open
        </Badge>
      </div>

      {locationGranted && (
        <div className="flex items-center gap-2 mb-5">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mr-1">
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
          <p className="text-sm text-muted-foreground mt-1">
            {locationGranted && radiusMi !== null
              ? "Try a larger radius or check back soon!"
              : "Check back soon!"}
          </p>
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
