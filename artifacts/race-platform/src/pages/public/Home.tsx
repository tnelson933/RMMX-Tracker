import { useState, useEffect } from "react";
import { Link } from "wouter";
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
} from "lucide-react";
import rmLogo from "@assets/rm-logo.png";
import { format, isToday, isFuture, isPast } from "date-fns";

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
    <Link href={`/results/${event.eventId}`}>
      <Card className="hover-elevate cursor-pointer transition-all h-full group border-red-500/40 shadow-md shadow-red-500/5 overflow-hidden">
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
              <span className="flex items-center gap-1.5 bg-white/20 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                <Radio size={12} /> LIVE STREAM
              </span>
            )}
          </div>
          <div className="p-4">
            <h3 className="font-heading font-bold text-lg leading-tight mb-3 group-hover:text-primary transition-colors">
              {event.name}
            </h3>
            <div className="space-y-1.5 text-sm text-muted-foreground mb-3">
              <div className="flex items-center gap-1.5">
                <Calendar size={13} className="flex-shrink-0 text-muted-foreground/60" />
                {format(new Date(event.date), "EEEE, MMMM d, yyyy")}
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
    </Link>
  );
}

function UpcomingCard({ event }: { event: UpcomingEventItem }) {
  const { label, className } = registrationBadge(event.status);
  return (
    <Link href={`/results/${event.eventId}`}>
      <Card className="hover-elevate cursor-pointer hover:border-primary transition-all h-full group overflow-hidden">
        <CardContent className="p-0">
          <div className="bg-sidebar px-4 py-2.5">
            <span className={`text-xs font-bold uppercase tracking-widest px-2 py-0.5 rounded ${className}`}>
              {label}
            </span>
          </div>
          <div className="p-4">
            <h3 className="font-heading font-bold text-lg leading-tight mb-3 group-hover:text-primary transition-colors">
              {event.name}
            </h3>
            <div className="space-y-1.5 text-sm text-muted-foreground mb-3">
              <div className="flex items-center gap-1.5">
                <Calendar size={13} className="flex-shrink-0 text-muted-foreground/60" />
                {format(new Date(event.date), "EEEE, MMMM d, yyyy")}
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
                Event Info <ChevronRight size={14} />
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
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
                {format(new Date(result.date), "MMM d, yyyy")}
              </span>
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
  const [selectedState, setSelectedState] = useState("all");

  const { data: upcomingAll, isLoading: upcomingLoading } = useListUpcomingEvents({ query: {} as any });
  const { data: states, isLoading: statesLoading } = useListStates();
  const { data: recentResults, isLoading: pastLoading } = useListRecentResults({
    state: selectedState === "all" ? undefined : selectedState,
    limit: 24,
  } as any);

  const todayEvents = upcomingAll?.filter(e => isToday(new Date(e.date)) || e.status === "race_day") ?? [];
  const futureEvents = upcomingAll?.filter(e => {
    const d = new Date(e.date);
    return isFuture(d) && !isToday(d) && e.status !== "race_day";
  }) ?? [];

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

  // Reset state filter when switching tabs
  const switchTab = (t: Tab) => {
    setActiveTab(t);
    setSelectedState("all");
  };

  const filteredToday = selectedState === "all" ? todayEvents : todayEvents.filter(e => e.state === selectedState);
  const filteredFuture = selectedState === "all" ? futureEvents : futureEvents.filter(e => e.state === selectedState);

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
            <img src={rmLogo} alt="Rocky Mountain" className="w-24 h-24 mx-auto mb-6 drop-shadow-2xl" />
            <h1 className="text-5xl md:text-7xl font-heading font-bold text-white mb-6 uppercase tracking-tight leading-tight">
              Precision Timing.<br />
              <span className="text-primary">Ultimate Performance.</span>
            </h1>
            <p className="text-xl text-sidebar-foreground/80 mb-10 max-w-2xl mx-auto">
              The high-stakes race operations platform for club organizers and riders. Live tracking, automated lineups, and instant results.
            </p>
            <div className="flex items-center justify-center gap-4">
              <Link href="/results">
                <Button size="lg" className="h-14 px-8 text-lg font-heading uppercase tracking-wider">
                  Browse Results
                </Button>
              </Link>
              <Link href="/leaderboard">
                <Button size="lg" variant="outline" className="h-14 px-8 text-lg font-heading uppercase tracking-wider bg-transparent border-sidebar-foreground/20 text-white hover:bg-sidebar-accent hover:text-white">
                  Series Standings
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Events Section — tabbed */}
      <section className="container mx-auto px-4">

        {/* Tab bar */}
        <div className="flex items-end gap-0 border-b mb-6">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => switchTab(tab.key)}
              className={`relative px-6 py-3 font-heading font-bold uppercase tracking-wider text-sm transition-colors flex items-center gap-2 ${
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

        {/* State chips */}
        {activeTab === "today" && (
          <StateChips states={todayStates} selected={selectedState} onSelect={setSelectedState} />
        )}
        {activeTab === "upcoming" && (
          <StateChips states={futureStates} selected={selectedState} onSelect={setSelectedState} />
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
              <p className="font-heading font-bold uppercase text-muted-foreground">No events today</p>
              <p className="text-sm text-muted-foreground mt-1">
                {selectedState !== "all" ? `No events in ${selectedState} today. ` : ""}Check the upcoming tab for what's next.
              </p>
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
              {filteredFuture.map(e => <UpcomingCard key={e.eventId} event={e} />)}
            </div>
          ) : (
            <div className="py-16 text-center bg-muted/40 rounded-lg border border-dashed">
              <Clock className="mx-auto mb-3 text-muted-foreground opacity-30" size={44} />
              <p className="font-heading font-bold uppercase text-muted-foreground">No upcoming events scheduled</p>
              {selectedState !== "all" && (
                <Button variant="link" className="mt-2 text-primary" onClick={() => setSelectedState("all")}>
                  Clear state filter
                </Button>
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
          ) : recentResults?.length ? (
            <>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {recentResults.map((r, i) => <PastCard key={`${r.eventId}-${i}`} result={r} />)}
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
                {selectedState !== "all" ? `No results found for ${selectedState}` : "No results yet"}
              </p>
              {selectedState !== "all" && (
                <Button variant="link" className="mt-2 text-primary" onClick={() => setSelectedState("all")}>
                  Clear state filter
                </Button>
              )}
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
      </section>
    </div>
  );
}
