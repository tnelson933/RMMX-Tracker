import { useState, useEffect, useMemo } from "react";
import { OfficialResultsBadge } from "@/components/OfficialResultsBadge";
import { Link, useLocation } from "wouter";
import {
  useListStates,
  useListRecentResults,
  useListUpcomingEvents,
  UpcomingEventItem,
  RecentResultItem,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Calendar, MapPin, Trophy, ChevronRight, Radio,
  Flag, Clock, Activity, CheckCircle, Bell, Timer,
  Download, Monitor, Apple, ChevronDown, Navigation,
  Search, X,
} from "lucide-react";
import { StoreButtons } from "@/components/AppStoreButtons";
import { format, parseISO } from "date-fns";
import { formatEventDatesFull } from "@/lib/eventDates";
import { useUserLocation } from "@/hooks/useUserLocation";
import { haversineDistance } from "@/lib/haversine";
import { STATE_CENTROIDS, normalizeState } from "@/lib/stateCentroids";

const FALLBACK_TAG = "desktop-v1.0.111";
const FALLBACK_BASE = `https://github.com/tnelson933/RMMX-Tracker/releases/download/${FALLBACK_TAG}`;
const CONNECTOR_FALLBACK_TAG = "connector-v1.0.16";
const CONNECTOR_FALLBACK_BASE = `https://github.com/tnelson933/RMMX-Tracker/releases/download/${CONNECTOR_FALLBACK_TAG}`;

function registrationBadge(status: string) {
  if (status === "registration_open") return { label: "REG. OPEN", className: "bg-green-600 text-white" };
  if (status === "registration_closed") return { label: "REG. CLOSED", className: "bg-yellow-600 text-white" };
  return { label: status.replace(/_/g, " ").toUpperCase(), className: "bg-muted text-muted-foreground" };
}

function TodayCard({ event }: { event: UpcomingEventItem }) {
  const [isLive, setIsLive] = useState(false);
  const [, navigate] = useLocation();
  useEffect(() => {
    const check = () =>
      fetch(`/api/video/status/${event.eventId}`)
        .then(r => r.json())
        .then(d => setIsLive(!!d.live))
        .catch(() => {});
    check();
    const id = setInterval(check, 15_000);
    return () => clearInterval(id);
  }, [event.eventId]);

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/results/${event.eventId}`)}
      onKeyDown={e => e.key === "Enter" && navigate(`/results/${event.eventId}`)}
      className="cursor-pointer h-full"
    >
      <Card className="hover-elevate transition-all h-full group border-red-500/40 shadow-md shadow-red-500/5 overflow-hidden">
        <CardContent className="p-0">
          <div className="bg-red-600 px-4 py-2.5 flex items-center justify-between">
            <span className="flex items-center gap-2 text-white text-sm font-bold uppercase tracking-wider">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
              </span>
              RACE DAY
            </span>
            {isLive && (
              <Link
                href={`/watch/${event.eventId}`}
                onClick={e => e.stopPropagation()}
                className="flex items-center gap-1.5 bg-white text-red-600 hover:bg-red-50 text-xs font-bold px-2 py-0.5 rounded-full transition-colors"
              >
                <Radio size={12} /> WATCH LIVE
              </Link>
            )}
          </div>
          <div className="p-4">
            <h3 className="font-heading font-bold text-lg leading-tight mb-3 group-hover:text-primary transition-colors">
              {event.name}
            </h3>
            <div className="space-y-1.5 text-sm text-muted-foreground mb-3">
              <div className="flex items-center gap-1.5">
                <Calendar size={13} className="flex-shrink-0 text-muted-foreground/60" />
                {formatEventDatesFull(event.date, (event as any).endDate)}
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
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider bg-muted px-2 py-0.5 rounded">{event.state}</span>
              <span className="text-primary text-sm font-heading font-bold flex items-center gap-1 group-hover:underline">
                View Live Standings <ChevronRight size={14} />
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function UpcomingCard({ event, distanceMi }: { event: UpcomingEventItem; distanceMi?: number | null }) {
  const { label, className } = registrationBadge(event.status);
  const regOpen = event.status === "registration_open";
  return (
    <Card className="hover-elevate hover:border-primary transition-all h-full overflow-hidden flex flex-col">
      <CardContent className="p-0 flex flex-col flex-1">
        <div className="bg-sidebar px-4 py-2.5 flex items-center justify-between">
          <span className={`text-xs font-bold uppercase tracking-widest px-2 py-0.5 rounded ${className}`}>
            {label}
          </span>
          {distanceMi != null && (
            <span className="flex items-center gap-1 text-muted-foreground text-xs font-semibold">
              <Navigation size={11} />
              ~{Math.round(distanceMi).toLocaleString()} mi
            </span>
          )}
        </div>
        <div className="p-4 flex flex-col flex-1">
          <Link href={`/results/${event.eventId}`}>
            <h3 className="font-heading font-bold text-lg leading-tight mb-3 hover:text-primary transition-colors cursor-pointer">
              {event.name}
            </h3>
          </Link>
          <div className="space-y-1.5 text-sm text-muted-foreground mb-4 flex-1">
            <div className="flex items-center gap-1.5">
              <Calendar size={13} className="flex-shrink-0 text-muted-foreground/60" />
              {formatEventDatesFull(event.date, (event as any).endDate)}
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
          <div className="flex items-center justify-between gap-2 mt-auto">
            <span className="text-xs font-bold uppercase tracking-wider bg-muted px-2 py-0.5 rounded">{event.state}</span>
            <div className="flex items-center gap-2">
              {regOpen && (
                <Link href={`/register/${event.eventId}`}>
                  <Button size="sm" className="font-heading uppercase tracking-wider text-xs h-7 px-3">
                    Register
                  </Button>
                </Link>
              )}
              <Link href={`/results/${event.eventId}`}>
                <span className="text-primary text-sm font-heading font-bold flex items-center gap-1 hover:underline">
                  Details <ChevronRight size={14} />
                </span>
              </Link>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PastCard({ result }: { result: RecentResultItem }) {
  return (
    <Link href={`/results/${result.eventId}`} className="block min-w-0">
      <Card className="hover-elevate cursor-pointer hover:border-primary transition-colors h-full group">
        <CardContent className="p-0">
          <div className="bg-muted p-4 border-b">
            <div className="flex justify-between items-start mb-2">
              <div className="font-heading font-bold text-lg leading-tight group-hover:text-primary transition-colors">
                {result.eventName}
              </div>
              <div className="bg-primary/10 text-primary px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider whitespace-nowrap ml-2">
                {result.state}
              </div>
            </div>
            <div className="flex flex-wrap items-center text-sm text-muted-foreground gap-x-4 gap-y-1 mt-2 min-w-0">
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                <Calendar size={13} />
                {format(parseISO(result.date.substring(0, 10)), "MMM d, yyyy")}
              </span>
              {(result.trackName || result.location) && (
                <span className="flex items-center gap-1.5 min-w-0 max-w-full">
                  <MapPin size={13} className="shrink-0" />
                  <span className="truncate">
                    {result.trackName
                      ? result.location
                        ? `${result.trackName}, ${result.location}`
                        : result.trackName
                      : result.location}
                  </span>
                </span>
              )}
              {result.clubName && (
                <span className="flex items-center gap-1.5 min-w-0 max-w-full">
                  <Trophy size={13} className="shrink-0" />
                  <span className="truncate">{result.clubName}</span>
                </span>
              )}
            </div>
          </div>
          <div className="p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1 font-semibold flex items-center gap-2 flex-wrap">
              Top Result · {result.raceClass}
              {result.official != null && <OfficialResultsBadge official={result.official} compact />}
            </div>
            <div className="flex items-center justify-between">
              <div className="font-bold text-base">{result.topRider}</div>
              <div className="text-primary font-heading font-bold flex items-center gap-1">
                {result.official != null ? "View results" : "Details"} <ChevronRight size={14} />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/** A section title with the brand's slanted red bar, and an optional link on the right. */
function SectionHeader({ id, title, count, action }: { id: string; title: string; count?: number; action?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 mb-5">
      <h2 id={id} className="flex items-center gap-3 font-heading font-extrabold uppercase text-[22px] sm:text-[30px] leading-none text-[#242424] min-w-0">
        <span className="w-[6px] h-[1.1em] bg-primary -skew-x-[18deg]" aria-hidden />
        {title}
        {count != null && count > 0 && (
          <span className="text-sm font-bold bg-[#F2F2F2] text-[#555] rounded-full px-2.5 py-1 leading-none">{count}</span>
        )}
      </h2>
      {action}
    </div>
  );
}

const chipClass = (selected: boolean) =>
  `shrink-0 min-h-[38px] px-[18px] rounded-full text-sm font-heading font-bold uppercase tracking-[0.5px] border-2 transition-colors ${
    selected
      ? "border-[#242424] bg-[#F2F2F2] text-[#242424]"
      : "border-[#8C8C8C] bg-white text-[#333] hover:bg-[#F2F2F2] hover:border-[#333]"
  }`;

const UPCOMING_PREVIEW = 6;
const RESULTS_PREVIEW = 6;

function CardSkeletons({ n }: { n: number }) {
  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4" role="status" aria-label="Loading">
      {[...Array(n)].map((_, i) => <div key={i} className="h-40 bg-muted rounded-md animate-pulse" />)}
    </div>
  );
}

function EmptyNote({ icon: Icon, title, children }: { icon: typeof Clock; title: string; children?: React.ReactNode }) {
  return (
    <div className="py-10 px-4 text-center bg-muted/40 rounded-lg border border-dashed">
      <Icon className="mx-auto mb-3 text-muted-foreground opacity-30" size={36} aria-hidden />
      <p className="font-heading font-bold uppercase text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function DownloadRow({ title, text, links }: { title: string; text: string; links: { macArm: string; macX64: string; windows: string } }) {
  const btn = "font-heading uppercase tracking-wider gap-1.5 h-9 px-4 text-xs";
  return (
    <div className="rounded-[12px] border-2 border-[#ECECEC] bg-white p-5 flex flex-col gap-3">
      <div>
        <h3 className="font-heading font-bold uppercase text-[17px] text-[#242424] flex items-center gap-2">
          <Download size={16} className="text-primary" aria-hidden /> {title}
        </h3>
        <p className="text-sm text-muted-foreground mt-1">{text}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm" className={btn}>
          <a href={links.macArm} title="macOS Apple Silicon (M1/M2/M3)"><Apple size={13} aria-hidden /> Mac (Apple Silicon)</a>
        </Button>
        <Button asChild variant="outline" size="sm" className={btn}>
          <a href={links.macX64} title="macOS Intel"><Apple size={13} aria-hidden /> Mac (Intel)</a>
        </Button>
        <Button asChild variant="outline" size="sm" className={btn}>
          <a href={links.windows} title="Windows 10/11"><Monitor size={13} aria-hidden /> Windows</a>
        </Button>
      </div>
    </div>
  );
}

export default function Home() {
  const [selectedState, setSelectedState] = useState("all");
  const [pastState, setPastState] = useState("all");
  const [nearMe, setNearMe] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [regFilter, setRegFilter] = useState<"all" | "registration_open" | "registration_closed">("all");
  const [showAllUpcoming, setShowAllUpcoming] = useState(false);
  const userLocation = useUserLocation();
  const [downloads, setDownloads] = useState({
    macArm:  `${FALLBACK_BASE}/RM-Tracker-arm64.dmg`,
    macX64:  `${FALLBACK_BASE}/RM-Tracker-x64.dmg`,
    windows: `${FALLBACK_BASE}/RM-Tracker-Setup.exe`,
  });
  const [connectorDownloads, setConnectorDownloads] = useState({
    macArm:  `${CONNECTOR_FALLBACK_BASE}/RM-Connect-arm64.dmg`,
    macX64:  `${CONNECTOR_FALLBACK_BASE}/RM-Connect-x64.dmg`,
    windows: `${CONNECTOR_FALLBACK_BASE}/RM-Connect-Setup.exe`,
  });

  useEffect(() => {
    fetch("/api/config/desktop-release")
      .then(r => r.ok ? r.json() : null)
      .then((data: { macArm: string; macX64: string; windows: string } | null) => {
        if (data?.macArm) setDownloads({ macArm: data.macArm, macX64: data.macX64, windows: data.windows });
      })
      .catch(() => {});
    fetch("/api/config/connector-release")
      .then(r => r.ok ? r.json() : null)
      .then((data: { macArm: string; macX64: string; windows: string } | null) => {
        if (data?.macArm) setConnectorDownloads({ macArm: data.macArm, macX64: data.macX64, windows: data.windows });
      })
      .catch(() => {});
  }, []);

  const { data: upcomingAll, isLoading: upcomingLoading } = useListUpcomingEvents({ query: { refetchInterval: 30_000 } as any });
  const { data: states } = useListStates();
  const { data: recentResults, isLoading: pastLoading } = useListRecentResults({
    state: pastState === "all" ? undefined : pastState,
    limit: 100,
  } as any);

  const todayStr = format(new Date(), "yyyy-MM-dd");
  // "Today" = racing today by the event's own local date (the server's `phase`, from
  // the track's time zone), so a race stays on Today all evening wherever the viewer is.
  const isToday = (e: NonNullable<typeof upcomingAll>[number]) => {
    if (e.phase) return e.phase === "today";
    const dateStr = e.date.substring(0, 10);
    const endStr = e.endDate ? String(e.endDate).substring(0, 10) : dateStr;
    return dateStr <= todayStr && endStr >= todayStr;
  };
  const todayEvents = upcomingAll?.filter(isToday) ?? [];
  const futureEvents = upcomingAll?.filter(e => !isToday(e)) ?? [];
  const futureStates = [...new Set(futureEvents.map(e => (e.state ?? "").trim()).filter(Boolean))].sort();
  const pastStates = states?.map(s => s.state) ?? [];

  // Search helper — matches name, location, trackName, state, clubName
  const matchesSearch = (fields: (string | null | undefined)[], q: string) => {
    if (!q.trim()) return true;
    const lower = q.toLowerCase();
    return fields.some(f => f?.toLowerCase().includes(lower));
  };

  // Attach distances to future events using state centroids
  const futureWithDistance = useMemo(() => {
    return futureEvents.map(e => {
      const centroid = STATE_CENTROIDS[normalizeState(e.state)];
      const distanceMi =
        userLocation.status === "granted" && centroid
          ? haversineDistance(
              (userLocation as { lat: number; lng: number }).lat,
              (userLocation as { lat: number; lng: number }).lng,
              centroid.lat,
              centroid.lng
            )
          : null;
      return { ...e, distanceMi };
    });
  }, [futureEvents, userLocation]);

  const filteredToday = useMemo(
    () => todayEvents.filter(e => matchesSearch([e.name, e.location, (e as any).trackName, e.state, e.clubName], searchQuery)),
    [todayEvents, searchQuery],
  );

  const filteredFuture = useMemo(() => {
    let result = nearMe
      ? futureWithDistance.filter(e => e.distanceMi !== null)
      : futureWithDistance;
    if (selectedState !== "all") result = result.filter(e => (e.state ?? "").trim() === selectedState);
    if (regFilter !== "all") result = result.filter(e => e.status === regFilter);
    if (searchQuery.trim()) {
      result = result.filter(e => matchesSearch([e.name, e.location, (e as any).trackName, e.state, e.clubName], searchQuery));
    }
    if (nearMe && userLocation.status === "granted") {
      result = [...result].sort((a, b) => (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity));
    }
    return result;
  }, [futureWithDistance, nearMe, selectedState, regFilter, searchQuery, userLocation.status]);

  const filteredPast = useMemo(() => {
    if (!recentResults) return [];
    if (!searchQuery.trim()) return recentResults;
    return recentResults.filter(r =>
      matchesSearch([r.eventName, r.location, r.trackName, r.state, r.clubName], searchQuery)
    );
  }, [recentResults, searchQuery]);

  const upcomingShown = showAllUpcoming ? filteredFuture : filteredFuture.slice(0, UPCOMING_PREVIEW);
  const searching = searchQuery.trim().length > 0;

  return (
    <div className="flex flex-col gap-12 sm:gap-14 pb-16">
      {/* Hero — brand charcoal with topo texture and red rule. Kept short on phones so races show above the fold. */}
      <section className="relative overflow-hidden bg-[#242424] text-white border-b-[3px] border-primary">
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.18] mix-blend-screen bg-cover bg-center"
          style={{ backgroundImage: `url(${import.meta.env.BASE_URL}brand/topo.jpg)` }}
        />
        <div className="container mx-auto px-4 relative z-10 py-7 sm:py-14">
          <div className="max-w-3xl">
            <div className="flex items-center gap-3 mb-3 sm:mb-5">
              <span className="w-[6px] self-stretch bg-primary -skew-x-[18deg]" aria-hidden />
              <span className="font-heading font-bold text-xs sm:text-sm uppercase tracking-[2px] text-[#BDBDBD]">
                Live timing &middot; Results &middot; Series points
              </span>
            </div>
            <h1 className="font-heading font-extrabold uppercase text-[30px] sm:text-[52px] leading-[1] tracking-normal mb-3 sm:mb-5">
              Precision timing.<br />
              <span className="inline-block bg-primary text-white px-3 mt-1.5 sm:mt-2 -skew-x-[8deg]"><span className="inline-block skew-x-[8deg]">Official results.</span></span>
            </h1>
            <p className="text-[15px] sm:text-lg leading-[1.6] text-white/80 mb-5 sm:mb-8 max-w-2xl">
              Find a race, register, follow it live and see the results the moment the moto ends.
            </p>
            <div className="grid grid-cols-2 sm:flex gap-3 sm:gap-4">
              <Link href="/results" className="sm:w-auto">
                <Button size="lg" className="w-full sm:w-auto min-h-[48px] sm:min-h-[52px] px-4 sm:px-10 text-sm sm:text-base">
                  Browse Results
                </Button>
              </Link>
              <Link href="/leaderboard" className="sm:w-auto">
                <Button size="lg" variant="outline" className="w-full sm:w-auto min-h-[48px] sm:min-h-[52px] px-4 sm:px-10 text-sm sm:text-base bg-transparent border-2 border-white/80 text-white hover:bg-white/10 hover:text-white">
                  Series Standings
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Search across today, upcoming and results */}
      <div className="container mx-auto px-4 -mb-4 sm:-mb-6">
        <div className="relative max-w-3xl">
          <Search size={20} className="absolute left-4 sm:left-5 top-1/2 -translate-y-1/2 text-[#333] pointer-events-none" aria-hidden />
          <input
            type="search"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search races, tracks, states"
            aria-label="Search races by name, track, city, state or club"
            className="w-full h-[52px] pl-11 sm:pl-12 pr-11 rounded-full border-2 border-[#8C8C8C] bg-white text-base text-[#333] placeholder:text-[#707070] focus:outline-none focus:border-[#242424] transition-colors [&::-webkit-search-cancel-button]:hidden"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* 1. Racing today */}
      {(todayEvents.length > 0 || (searching && filteredToday.length > 0)) && (
        <section className="container mx-auto px-4" aria-labelledby="home-today">
          <SectionHeader
            id="home-today"
            title="Racing today"
            count={filteredToday.length}
          />
          {filteredToday.length ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredToday.map(e => <TodayCard key={e.eventId} event={e} />)}
            </div>
          ) : (
            <EmptyNote icon={Radio} title={`No races today matching "${searchQuery}"`} />
          )}
        </section>
      )}

      {/* 2. Upcoming races, with Register */}
      <section className="container mx-auto px-4" aria-labelledby="home-upcoming">
        <SectionHeader id="home-upcoming" title="Upcoming races" count={futureEvents.length} />

        {futureEvents.length > 0 && (
          <div className="flex items-center gap-2 mb-5 overflow-x-auto hide-scrollbar sm:flex-wrap -mx-4 px-4 sm:mx-0 sm:px-0 pb-1">
            <button
              type="button"
              aria-pressed={nearMe}
              onClick={() => {
                if (!nearMe && userLocation.status === "denied") userLocation.retry();
                setNearMe(v => !v);
              }}
              className={`flex items-center gap-1.5 ${chipClass(nearMe)}`}
            >
              <Navigation size={13} aria-hidden />
              Near Me
            </button>
            {(["registration_open", "registration_closed"] as const).map(val => (
              <button
                key={val}
                type="button"
                aria-pressed={regFilter === val}
                onClick={() => setRegFilter(f => f === val ? "all" : val)}
                className={chipClass(regFilter === val)}
              >
                {val === "registration_open" ? "Reg. Open" : "Reg. Closed"}
              </button>
            ))}
            {futureStates.length > 1 && <span className="shrink-0 w-px h-6 bg-border mx-1" aria-hidden />}
            {futureStates.length > 1 && futureStates.map(s => (
              <button
                key={s}
                type="button"
                aria-pressed={selectedState === s}
                onClick={() => setSelectedState(sel => sel === s ? "all" : s)}
                className={chipClass(selectedState === s)}
              >
                {s}
              </button>
            ))}
            {nearMe && userLocation.status === "granted" && (
              <span className="shrink-0 text-xs text-muted-foreground flex items-center gap-1 ml-1">
                <Navigation size={11} aria-hidden /> Closest first
              </span>
            )}
            {nearMe && (userLocation.status === "denied" || userLocation.status === "unavailable") && (
              <span className="shrink-0 text-xs text-muted-foreground ml-1">Turn on location to sort by distance</span>
            )}
          </div>
        )}

        {upcomingLoading ? (
          <CardSkeletons n={3} />
        ) : upcomingShown.length ? (
          <>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {upcomingShown.map(e => (
                <UpcomingCard
                  key={e.eventId}
                  event={e}
                  distanceMi={nearMe && userLocation.status === "granted" ? (e as any).distanceMi : undefined}
                />
              ))}
            </div>
            {filteredFuture.length > UPCOMING_PREVIEW && (
              <div className="text-center mt-6">
                <Button variant="outline" className="font-heading uppercase tracking-wider" onClick={() => setShowAllUpcoming(v => !v)} aria-expanded={showAllUpcoming}>
                  {showAllUpcoming ? "Show fewer" : `Show all ${filteredFuture.length} upcoming races`}
                  <ChevronDown size={16} className={`ml-1 transition-transform ${showAllUpcoming ? "rotate-180" : ""}`} aria-hidden />
                </Button>
              </div>
            )}
          </>
        ) : (
          <EmptyNote icon={Clock} title={searching ? `No upcoming races matching "${searchQuery}"` : nearMe ? "No upcoming races near you" : "No upcoming races scheduled yet"}>
            {(selectedState !== "all" || nearMe || regFilter !== "all" || searching) && (
              <Button
                variant="link"
                className="mt-1 text-primary"
                onClick={() => { setNearMe(false); setSelectedState("all"); setRegFilter("all"); setSearchQuery(""); }}
              >
                Clear filters
              </Button>
            )}
          </EmptyNote>
        )}
      </section>

      {/* 3. Latest results */}
      <section className="container mx-auto px-4" aria-labelledby="home-results">
        <SectionHeader
          id="home-results"
          title="Latest results"
          action={
            <Link href="/results" className="shrink-0 text-primary text-sm font-heading font-bold uppercase tracking-[1px] flex items-center gap-1 hover:underline">
              All results <ChevronRight size={14} aria-hidden />
            </Link>
          }
        />
        {pastStates.length > 1 && (
          <div className="flex gap-2 mb-5 overflow-x-auto hide-scrollbar sm:flex-wrap -mx-4 px-4 sm:mx-0 sm:px-0 pb-1">
            <button type="button" aria-pressed={pastState === "all"} onClick={() => setPastState("all")} className={chipClass(pastState === "all")}>
              All States
            </button>
            {pastStates.map(s => (
              <button key={s} type="button" aria-pressed={pastState === s} onClick={() => setPastState(s)} className={chipClass(pastState === s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {pastLoading ? (
          <CardSkeletons n={3} />
        ) : filteredPast.length ? (
          <>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredPast.slice(0, RESULTS_PREVIEW).map((r, i) => <PastCard key={`${r.eventId}-${i}`} result={r} />)}
            </div>
            <div className="text-center mt-6">
              <Link href="/results">
                <Button variant="outline" className="font-heading uppercase tracking-wider">
                  View All Results <ChevronRight size={16} className="ml-1" aria-hidden />
                </Button>
              </Link>
            </div>
          </>
        ) : (
          <EmptyNote
            icon={Trophy}
            title={searching ? `No results matching "${searchQuery}"` : pastState !== "all" ? `No results yet for ${pastState}` : "No results yet"}
          >
            {(searching || pastState !== "all") && (
              <Button variant="link" className="mt-1 text-primary" onClick={() => { setSearchQuery(""); setPastState("all"); }}>
                Clear filters
              </Button>
            )}
          </EmptyNote>
        )}
      </section>

      {/* 4. The rider app */}
      <section className="container mx-auto px-4" aria-labelledby="home-app">
        <div className="relative overflow-hidden bg-[#242424] text-white rounded-[12px] border-b-[3px] border-primary p-6 sm:p-10 grid lg:grid-cols-[1fr_auto] gap-6 lg:gap-10 items-center">
          <div>
            <span className="font-heading font-bold text-xs sm:text-sm uppercase tracking-[2px] text-[#BDBDBD]">Free for iPhone and Android</span>
            <h2 id="home-app" className="font-heading font-extrabold uppercase text-[26px] sm:text-[34px] leading-tight mt-2 mb-3">Get the rider app</h2>
            <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-[15px] text-white/85 max-w-xl">
              {[
                [Timer, "Live timing and results"],
                [Bell, "Alerts when your race is up"],
                [CheckCircle, "Register and check in from your phone"],
                [Activity, "Follow riders and your series"],
              ].map(([Icon, text]) => {
                const I = Icon as typeof Timer;
                return (
                  <li key={text as string} className="flex items-center gap-2">
                    <I size={16} className="text-white/60 shrink-0" aria-hidden /> {text as string}
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="flex flex-col gap-3 lg:items-end">
            <StoreButtons />
            <Link href="/rider-app" className="inline-flex items-center gap-1 text-sm font-semibold text-white/80 hover:text-white">
              What the app does <ChevronRight size={14} aria-hidden />
            </Link>
          </div>
        </div>
      </section>

      {/* 5. For organizers: login and the race-day software downloads */}
      <section className="container mx-auto px-4" aria-labelledby="home-organizers">
        <SectionHeader id="home-organizers" title="For organizers" />
        <div className="grid lg:grid-cols-3 gap-4">
          <div className="rounded-[12px] bg-[#F2F2F2] p-5 flex flex-col gap-3">
            <div>
              <h3 className="font-heading font-bold uppercase text-[17px] text-[#242424] flex items-center gap-2">
                <Flag size={16} className="text-primary" aria-hidden /> Run your races on RM Roost
              </h3>
              <p className="text-sm text-muted-foreground mt-1">Events, registration, check-in, timing and results for your club.</p>
            </div>
            <Link href="/login" className="mt-auto">
              <Button className="w-full sm:w-auto min-h-[44px] px-8">Organizer Login</Button>
            </Link>
          </div>
          <DownloadRow
            title="Desktop Scoring App"
            text="Score races at the track, with or without internet."
            links={downloads}
          />
          <DownloadRow
            title="RM Connect"
            text="Connects your timing hardware to RM Roost."
            links={connectorDownloads}
          />
        </div>
      </section>
    </div>
  );
}
