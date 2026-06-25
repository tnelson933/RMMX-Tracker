import { useState, useEffect, useMemo } from "react";
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
  Flag, Clock, Activity, AlertCircle, CheckCircle,
  Download, Monitor, Apple, ChevronDown, Navigation, LocateFixed,
  Search, X,
} from "lucide-react";
import rmLogo from "@assets/rm-logo.png";
import { format, parseISO } from "date-fns";
import { formatEventDatesFull } from "@/lib/eventDates";
import { useUserLocation } from "@/hooks/useUserLocation";
import { haversineDistance } from "@/lib/haversine";
import { STATE_CENTROIDS } from "@/lib/stateCentroids";

const FALLBACK_TAG = "desktop-v1.0.87";
const FALLBACK_BASE = `https://github.com/tnelson933/RMMX-Tracker/releases/download/${FALLBACK_TAG}`;

type Tab = "today" | "upcoming" | "past";

function registrationBadge(status: string) {
  if (status === "registration_open") return { label: "REG. OPEN", className: "bg-green-600 text-white" };
  if (status === "registration_closed") return { label: "REG. CLOSED", className: "bg-yellow-600 text-white" };
  return { label: status.replace(/_/g, " ").toUpperCase(), className: "bg-muted text-muted-foreground" };
}

function StateChips({
  states,
  selected,
  onSelect,
}: {
  states: string[];
  selected: string;
  onSelect: (s: string) => void;
}) {
  if (!states.length) return null;
  return (
    <div className="flex flex-wrap gap-2 mb-6">
      <button
        onClick={() => onSelect("all")}
        className={`px-3 py-1 rounded-full text-sm font-heading font-bold uppercase tracking-wider border transition-colors ${
          selected === "all"
            ? "bg-primary text-primary-foreground border-primary"
            : "border-border text-muted-foreground hover:border-primary hover:text-primary"
        }`}
      >
        All States
      </button>
      {states.map(s => (
        <button
          key={s}
          onClick={() => onSelect(s)}
          className={`px-3 py-1 rounded-full text-sm font-heading font-bold uppercase tracking-wider border transition-colors ${
            selected === s
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border text-muted-foreground hover:border-primary hover:text-primary"
          }`}
        >
          {s}
        </button>
      ))}
    </div>
  );
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
    <Link href={`/results/${result.eventId}`}>
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
            <div className="flex items-center text-sm text-muted-foreground gap-4 mt-2">
              <span className="flex items-center gap-1.5">
                <Calendar size={13} />
                {format(parseISO(result.date.substring(0, 10)), "MMM d, yyyy")}
              </span>
              {(result.trackName || result.location) && (
                <span className="flex items-center gap-1.5 truncate">
                  <MapPin size={13} />
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
                <span className="flex items-center gap-1.5 truncate">
                  <Trophy size={13} />
                  <span className="truncate">{result.clubName}</span>
                </span>
              )}
            </div>
          </div>
          <div className="p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1 font-semibold">
              Top Result · {result.raceClass}
            </div>
            <div className="flex items-center justify-between">
              <div className="font-bold text-base">{result.topRider}</div>
              <div className="text-primary font-heading font-bold flex items-center gap-1">
                View Results <ChevronRight size={14} />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>("today");
  const [showDownloads, setShowDownloads] = useState(false);
  const [selectedState, setSelectedState] = useState("all");
  const [nearMe, setNearMe] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [regFilter, setRegFilter] = useState<"all" | "registration_open" | "registration_closed">("all");
  const userLocation = useUserLocation();
  const [downloads, setDownloads] = useState({
    macArm:  `${FALLBACK_BASE}/RM-Tracker-arm64.dmg`,
    macX64:  `${FALLBACK_BASE}/RM-Tracker-x64.dmg`,
    windows: `${FALLBACK_BASE}/RM-Tracker-Setup.exe`,
  });

  useEffect(() => {
    fetch("/api/config/desktop-release")
      .then(r => r.ok ? r.json() : null)
      .then((data: { macArm: string; macX64: string; windows: string } | null) => {
        if (data?.macArm) setDownloads({ macArm: data.macArm, macX64: data.macX64, windows: data.windows });
      })
      .catch(() => {});
  }, []);

  const { data: upcomingAll, isLoading: upcomingLoading } = useListUpcomingEvents({ query: { refetchInterval: 30_000 } as any });
  const { data: states, isLoading: statesLoading } = useListStates();
  const { data: recentResults, isLoading: pastLoading } = useListRecentResults({
    state: selectedState === "all" ? undefined : selectedState,
    limit: 100,
  } as any);

  const todayStr = format(new Date(), "yyyy-MM-dd");
  // "Today" = today falls within the event's date range (start ≤ today ≤ end).
  // Using date range instead of `status === "race_day"` prevents stale events
  // whose race day has passed but haven't been finalized from staying on screen.
  const todayEvents = upcomingAll?.filter(e => {
    const dateStr = e.date.substring(0, 10);
    const endStr  = e.endDate ? String(e.endDate).substring(0, 10) : dateStr;
    return dateStr <= todayStr && endStr >= todayStr;
  }) ?? [];
  const futureEvents = upcomingAll?.filter(e =>
    e.date.substring(0, 10) > todayStr
  ) ?? [];

  const todayStates = [...new Set(todayEvents.map(e => e.state))].sort();
  const futureStates = [...new Set(futureEvents.map(e => e.state))].sort();
  const pastStates = states?.map(s => s.state) ?? [];

  // Auto-select today tab if there are events today, else upcoming or past
  useEffect(() => {
    if (!upcomingAll) return;
    if (todayEvents.length > 0) setActiveTab("today");
    else if (futureEvents.length > 0) setActiveTab("upcoming");
    else setActiveTab("past");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcomingAll]);

  // Reset filters when switching tabs (keep search query across tabs)
  const switchTab = (t: Tab) => {
    setActiveTab(t);
    setSelectedState("all");
    setRegFilter("all");
    setNearMe(false);
  };

  // Search helper — matches name, location, trackName, state, clubName
  const matchesSearch = (fields: (string | null | undefined)[], q: string) => {
    if (!q.trim()) return true;
    const lower = q.toLowerCase();
    return fields.some(f => f?.toLowerCase().includes(lower));
  };

  // Attach distances to future events using state centroids
  const futureWithDistance = useMemo(() => {
    return futureEvents.map(e => {
      const centroid = STATE_CENTROIDS[e.state];
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

  const filteredToday = useMemo(() => {
    let result = selectedState === "all" ? todayEvents : todayEvents.filter(e => e.state === selectedState);
    if (searchQuery.trim()) {
      result = result.filter(e => matchesSearch([e.name, e.location, (e as any).trackName, e.state, e.clubName], searchQuery));
    }
    return result;
  }, [todayEvents, selectedState, searchQuery]);

  const filteredFuture = useMemo(() => {
    let result = nearMe
      ? futureWithDistance.filter(e => e.distanceMi !== null)
      : futureWithDistance;
    if (selectedState !== "all") result = result.filter(e => e.state === selectedState);
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

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "today", label: "Today", count: todayEvents.length },
    { key: "upcoming", label: "Upcoming", count: futureEvents.length },
    { key: "past", label: "Past Results" },
  ];

  return (
    <div className="flex flex-col gap-12 pb-16">
      {/* Hero */}
      <section className="bg-sidebar text-sidebar-foreground py-20 relative overflow-hidden">
        <div
          className="absolute inset-0 bg-primary/10"
          style={{
            backgroundImage:
              'url("data:image/svg+xml,%3Csvg width=\'60\' height=\'60\' viewBox=\'0 0 60 60\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cg fill=\'none\' fill-rule=\'evenodd\'%3E%3Cg fill=\'%23cc0000\' fill-opacity=\'0.1\'%3E%3Cpath d=\'M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z\'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")',
          }}
        />
        <div className="container mx-auto px-4 relative z-10">
          <div className="max-w-3xl mx-auto text-center">
            <img src={rmLogo} alt="RM Tracker" className="w-20 h-20 sm:w-24 sm:h-24 mx-auto mb-6 drop-shadow-2xl" />
            <h1 className="text-4xl sm:text-5xl md:text-7xl font-heading font-bold text-white mb-4 sm:mb-6 uppercase tracking-tight leading-tight">
              Precision Timing.<br />
              <span style={{ color: '#cf152d' }}>Ultimate Performance.</span>
            </h1>
            <p className="text-base sm:text-xl text-sidebar-foreground/80 mb-8 sm:mb-10 max-w-2xl mx-auto px-2">
              The high-stakes race operations platform for club organizers and riders. Live tracking, automated lineups, and instant results.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 px-4 sm:px-0">
              <Link href="/results" className="w-full sm:w-auto">
                <Button size="lg" className="w-full sm:w-auto h-12 sm:h-14 px-8 text-base sm:text-lg font-heading uppercase tracking-wider" style={{ backgroundColor: '#cf152d', borderColor: '#cf152d' }}>
                  Browse Results
                </Button>
              </Link>
              <Link href="/leaderboard" className="w-full sm:w-auto">
                <Button size="lg" variant="outline" className="w-full sm:w-auto h-12 sm:h-14 px-8 text-base sm:text-lg font-heading uppercase tracking-wider bg-transparent border-sidebar-foreground/20 text-white hover:bg-sidebar-accent hover:text-white">
                  Series Standings
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Events Section — tabbed */}
      <section className="container mx-auto px-4">

        {/* Search bar */}
        <div className="relative mb-5">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search by race name, track, city or state…"
            className="w-full pl-9 pr-9 py-2.5 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X size={15} />
            </button>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex items-end gap-0 border-b mb-6 overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => switchTab(tab.key)}
              className={`relative shrink-0 px-4 sm:px-6 py-3 font-heading font-bold uppercase tracking-wider text-sm transition-colors flex items-center gap-2 ${
                activeTab === tab.key
                  ? "text-primary border-b-2 border-primary -mb-px bg-transparent"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.key === "today" && (
                <span className="relative flex h-2 w-2">
                  {todayEvents.length > 0 && (
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                  )}
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${todayEvents.length > 0 ? "bg-red-500" : "bg-muted-foreground/30"}`} />
                </span>
              )}
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                  activeTab === tab.key ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                }`}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* State chips + Near Me button */}
        {activeTab === "today" && (
          <StateChips states={todayStates} selected={selectedState} onSelect={setSelectedState} />
        )}
        {activeTab === "upcoming" && (
          <div className="flex flex-wrap items-center gap-3 mb-6">
            {/* Near Me toggle */}
            <button
              onClick={() => {
                if (!nearMe && userLocation.status === "denied") userLocation.retry();
                setNearMe(v => !v);
              }}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-heading font-bold uppercase tracking-wider border transition-colors ${
                nearMe
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:border-primary hover:text-primary"
              }`}
            >
              <Navigation size={13} />
              Near Me
            </button>
            {/* Divider */}
            {futureStates.length > 0 && <span className="text-border hidden sm:block">|</span>}
            {/* State chips inline */}
            {futureStates.map(s => (
              <button
                key={s}
                onClick={() => setSelectedState(sel => sel === s ? "all" : s)}
                className={`px-3 py-1 rounded-full text-sm font-heading font-bold uppercase tracking-wider border transition-colors ${
                  selectedState === s
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:border-primary hover:text-primary"
                }`}
              >
                {s}
              </button>
            ))}
            {selectedState !== "all" && (
              <button
                onClick={() => setSelectedState("all")}
                className="px-3 py-1 rounded-full text-sm font-heading font-bold uppercase tracking-wider border border-border text-muted-foreground hover:border-primary hover:text-primary transition-colors"
              >
                All States
              </button>
            )}
            {/* Divider */}
            {<span className="text-border hidden sm:block">|</span>}
            {/* Registration status filter */}
            {(["all", "registration_open", "registration_closed"] as const).map(val => (
              <button
                key={val}
                onClick={() => setRegFilter(val)}
                className={`px-3 py-1 rounded-full text-sm font-heading font-bold uppercase tracking-wider border transition-colors ${
                  regFilter === val
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:border-primary hover:text-primary"
                }`}
              >
                {val === "all" ? "All" : val === "registration_open" ? "Reg. Open" : "Reg. Closed"}
              </button>
            ))}
            {/* Location status hint */}
            {nearMe && userLocation.status === "granted" && (
              <span className="text-xs text-muted-foreground flex items-center gap-1 ml-1">
                <Navigation size={11} /> Sorted closest first
              </span>
            )}
            {nearMe && (userLocation.status === "denied" || userLocation.status === "unavailable") && (
              <span className="text-xs text-muted-foreground ml-1">Enable location for distance sorting</span>
            )}
          </div>
        )}
        {activeTab === "past" && (
          <StateChips states={pastStates} selected={selectedState} onSelect={setSelectedState} />
        )}

        {/* TODAY content */}
        {activeTab === "today" && (
          upcomingLoading ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[...Array(3)].map((_, i) => <div key={i} className="h-40 bg-muted rounded-md animate-pulse" />)}
            </div>
          ) : filteredToday.length ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredToday.map(e => <TodayCard key={e.eventId} event={e} />)}
            </div>
          ) : (
            <div className="py-16 text-center bg-muted/40 rounded-lg border border-dashed">
              <Radio className="mx-auto mb-3 text-muted-foreground opacity-30" size={44} />
              <p className="font-heading font-bold uppercase text-muted-foreground">
                {searchQuery.trim() ? `No events today matching "${searchQuery}"` : "No events today"}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {selectedState !== "all" ? `No events in ${selectedState} today. ` : ""}Check the upcoming tab for what's next.
              </p>
              {searchQuery.trim() && (
                <Button variant="link" className="mt-1 text-primary" onClick={() => setSearchQuery("")}>Clear search</Button>
              )}
            </div>
          )
        )}

        {/* UPCOMING content */}
        {activeTab === "upcoming" && (
          upcomingLoading ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[...Array(3)].map((_, i) => <div key={i} className="h-40 bg-muted rounded-md animate-pulse" />)}
            </div>
          ) : filteredFuture.length ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredFuture.map(e => (
                <UpcomingCard
                  key={e.eventId}
                  event={e}
                  distanceMi={nearMe && userLocation.status === "granted" ? (e as any).distanceMi : undefined}
                />
              ))}
            </div>
          ) : (
            <div className="py-16 text-center bg-muted/40 rounded-lg border border-dashed">
              <Clock className="mx-auto mb-3 text-muted-foreground opacity-30" size={44} />
              <p className="font-heading font-bold uppercase text-muted-foreground">
                {nearMe ? "No upcoming events near you" : "No upcoming events scheduled"}
              </p>
              {(selectedState !== "all" || nearMe) && (
                <div className="flex items-center justify-center gap-3 mt-2">
                  {nearMe && (
                    <Button variant="link" className="text-primary" onClick={() => setNearMe(false)}>
                      Show all locations
                    </Button>
                  )}
                  {selectedState !== "all" && (
                    <Button variant="link" className="text-primary" onClick={() => setSelectedState("all")}>
                      Clear state filter
                    </Button>
                  )}
                </div>
              )}
            </div>
          )
        )}

        {/* PAST content */}
        {activeTab === "past" && (
          pastLoading || statesLoading ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[...Array(6)].map((_, i) => <div key={i} className="h-40 bg-muted rounded-md animate-pulse" />)}
            </div>
          ) : filteredPast.length ? (
            <>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredPast.map((r, i) => <PastCard key={`${r.eventId}-${i}`} result={r} />)}
              </div>
              <div className="text-center mt-6">
                <Link href="/results">
                  <Button variant="outline" className="font-heading uppercase tracking-wider">
                    View All Results <ChevronRight size={16} className="ml-1" />
                  </Button>
                </Link>
              </div>
            </>
          ) : (
            <div className="py-16 text-center bg-muted/40 rounded-lg border border-dashed">
              <Trophy className="mx-auto mb-3 text-muted-foreground opacity-30" size={44} />
              <p className="font-heading font-bold uppercase text-muted-foreground">
                {searchQuery.trim() ? `No results matching "${searchQuery}"` : selectedState !== "all" ? `No results found for ${selectedState}` : "No results yet"}
              </p>
              <div className="flex items-center justify-center gap-3 mt-2 flex-wrap">
                {searchQuery.trim() && (
                  <Button variant="link" className="text-primary" onClick={() => setSearchQuery("")}>
                    Clear search
                  </Button>
                )}
                {selectedState !== "all" && (
                  <Button variant="link" className="text-primary" onClick={() => setSelectedState("all")}>
                    Clear state filter
                  </Button>
                )}
              </div>
            </div>
          )
        )}
      </section>

      {/* CTA */}
      <section className="container mx-auto px-4 mt-4">
        <div className="bg-sidebar rounded-lg p-10 flex flex-col md:flex-row items-center justify-between gap-8">
          <div className="text-sidebar-foreground text-center md:text-left">
            <h2 className="text-3xl font-heading font-bold uppercase mb-2">Are you a club organizer?</h2>
            <p className="text-sidebar-foreground/70 max-w-xl">
              Access the operations portal to manage your events, riders, check-ins, and live scoring.
            </p>
          </div>
          <Link href="/login">
            <Button size="lg" className="h-14 px-8 text-lg font-heading uppercase tracking-wider whitespace-nowrap">
              Organizer Login
            </Button>
          </Link>
        </div>

        {/* Subtle desktop app download */}
        <div className="mt-3 flex flex-col items-center gap-3">
          <button
            onClick={() => setShowDownloads(v => !v)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Download size={12} />
            Download Desktop Scoring App
            <ChevronDown size={12} className={`transition-transform duration-200 ${showDownloads ? "rotate-180" : ""}`} />
          </button>
          {showDownloads && (
            <div className="flex flex-wrap justify-center gap-2">
              <a href={downloads.macArm} title="macOS Apple Silicon (M1/M2/M3)">
                <Button variant="outline" size="sm" className="font-heading uppercase tracking-wider gap-1.5 h-8 px-4 text-xs">
                  <Apple size={13} />
                  Mac (Apple Silicon)
                </Button>
              </a>
              <a href={downloads.macX64} title="macOS Intel">
                <Button variant="outline" size="sm" className="font-heading uppercase tracking-wider gap-1.5 h-8 px-4 text-xs">
                  <Apple size={13} />
                  Mac (Intel)
                </Button>
              </a>
              <a href={downloads.windows} title="Windows 10/11">
                <Button variant="outline" size="sm" className="font-heading uppercase tracking-wider gap-1.5 h-8 px-4 text-xs">
                  <Monitor size={13} />
                  Windows
                </Button>
              </a>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
