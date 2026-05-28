import { Link } from "wouter";
import { useListStates, useListRecentResults, useListUpcomingEvents, UpcomingEventItem } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar, MapPin, Trophy, ChevronRight, Activity, Radio, Flag, Clock } from "lucide-react";
import rmLogo from "@assets/rm-logo.png";
import { format, isToday, isFuture, isPast } from "date-fns";

function statusLabel(event: UpcomingEventItem): { label: string; className: string } {
  const date = new Date(event.date);
  const today = isToday(date);
  const past = isPast(date) && !today;

  if (event.status === "race_day" || today) {
    return { label: "LIVE TODAY", className: "bg-red-600 text-white animate-pulse" };
  }
  if (event.status === "registration_open") {
    return { label: "REGISTRATION OPEN", className: "bg-green-600/90 text-white" };
  }
  if (event.status === "registration_closed") {
    return past
      ? { label: "RACE DAY", className: "bg-orange-500 text-white" }
      : { label: "REG. CLOSED", className: "bg-yellow-600 text-white" };
  }
  return { label: "UPCOMING", className: "bg-muted text-muted-foreground" };
}

export default function Home() {
  const { data: states, isLoading: statesLoading } = useListStates();
  const { data: recentResults, isLoading: resultsLoading } = useListRecentResults({ limit: 10 });
  const { data: upcomingEvents, isLoading: upcomingLoading } = useListUpcomingEvents({ query: {} as any });

  return (
    <div className="flex flex-col gap-12 pb-16">
      {/* Hero Section */}
      <section className="bg-sidebar text-sidebar-foreground py-20 relative overflow-hidden">
        <div className="absolute inset-0 bg-primary/10" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'60\' height=\'60\' viewBox=\'0 0 60 60\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cg fill=\'none\' fill-rule=\'evenodd\'%3E%3Cg fill=\'%23cc0000\' fill-opacity=\'0.1\'%3E%3Cpath d=\'M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z\'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")' }}></div>
        <div className="container mx-auto px-4 relative z-10">
          <div className="max-w-3xl mx-auto text-center">
            <img src={rmLogo} alt="Rocky Mountain" className="w-24 h-24 mx-auto mb-6 drop-shadow-2xl" />
            <h1 className="text-5xl md:text-7xl font-heading font-bold text-white mb-6 uppercase tracking-tight leading-tight">
              Precision Timing.<br/>
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

      {/* Upcoming & Live Events */}
      <section className="container mx-auto px-4">
        <div className="flex items-center gap-3 mb-8">
          <Radio className="text-red-500" size={28} />
          <h2 className="text-3xl font-heading font-bold uppercase m-0">Upcoming &amp; Live Events</h2>
        </div>

        {upcomingLoading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-36 bg-muted rounded-md animate-pulse" />
            ))}
          </div>
        ) : upcomingEvents?.length ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {upcomingEvents.map(event => {
              const { label, className } = statusLabel(event);
              const date = new Date(event.date);
              const liveToday = isToday(date) || event.status === "race_day";
              return (
                <Link key={event.eventId} href={`/results/${event.eventId}`}>
                  <Card className={`hover-elevate cursor-pointer transition-all h-full group overflow-hidden ${liveToday ? "border-red-500/50 shadow-red-500/10 shadow-lg" : "hover:border-primary"}`}>
                    <CardContent className="p-0">
                      <div className={`px-4 py-2 flex items-center justify-between ${liveToday ? "bg-red-600" : "bg-sidebar"}`}>
                        <span className={`text-xs font-bold uppercase tracking-widest px-2 py-0.5 rounded ${liveToday ? "text-white" : className}`}>
                          {label}
                        </span>
                        {liveToday && (
                          <span className="flex items-center gap-1 text-white text-xs font-bold">
                            <span className="relative flex h-2 w-2">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
                            </span>
                            LIVE
                          </span>
                        )}
                      </div>
                      <div className="p-4">
                        <h3 className={`font-heading font-bold text-lg leading-tight mb-2 group-hover:text-primary transition-colors ${liveToday ? "text-foreground" : ""}`}>
                          {event.name}
                        </h3>
                        <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1.5">
                            <Calendar size={13} className="text-muted-foreground/60 flex-shrink-0" />
                            {format(date, "EEEE, MMM d, yyyy")}
                          </span>
                          {(event.location || event.trackName) && (
                            <span className="flex items-center gap-1.5">
                              <MapPin size={13} className="text-muted-foreground/60 flex-shrink-0" />
                              {event.trackName ? `${event.trackName}, ${event.location}` : event.location}
                            </span>
                          )}
                          {event.clubName && (
                            <span className="flex items-center gap-1.5">
                              <Trophy size={13} className="text-muted-foreground/60 flex-shrink-0" />
                              {event.clubName}
                            </span>
                          )}
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground bg-muted px-2 py-0.5 rounded">
                            {event.state}
                          </span>
                          <span className="text-primary text-sm font-heading font-bold flex items-center gap-1 group-hover:underline">
                            {liveToday ? "View Live" : "View Event"} <ChevronRight size={14} />
                          </span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="p-8 text-center bg-muted rounded-md text-muted-foreground">
            <Clock className="mx-auto mb-3 opacity-40" size={40} />
            <p className="font-heading font-bold uppercase">No upcoming events scheduled</p>
            <p className="text-sm mt-1">Check back soon or browse past results below.</p>
          </div>
        )}
      </section>

      {/* Find Results by State */}
      <section className="container mx-auto px-4">
        <div className="flex items-center gap-3 mb-8">
          <MapPin className="text-primary" size={28} />
          <h2 className="text-3xl font-heading font-bold uppercase m-0">Past Results By State</h2>
        </div>
        
        {statesLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-24 bg-muted rounded-md animate-pulse"></div>
            ))}
          </div>
        ) : states?.length ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {states.map(state => (
              <Link key={state.state} href={`/results?state=${state.state}`}>
                <Card className="hover-elevate cursor-pointer hover:border-primary transition-colors h-full">
                  <CardContent className="p-6 flex flex-col items-center justify-center text-center h-full gap-2">
                    <span className="text-3xl font-heading font-bold text-foreground">{state.state}</span>
                    <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider bg-muted px-2 py-1 rounded">
                      {state.eventCount} {state.eventCount === 1 ? "Event" : "Events"}
                    </span>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        ) : (
          <div className="p-8 text-center bg-muted rounded-md text-muted-foreground">
            No completed events found.
          </div>
        )}
      </section>

      {/* Recent Results */}
      <section className="container mx-auto px-4">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Activity className="text-primary" size={28} />
            <h2 className="text-3xl font-heading font-bold uppercase m-0">Recent Results</h2>
          </div>
          <Link href="/results">
            <Button variant="ghost" className="font-heading uppercase text-primary hover:text-primary/80">
              View All <ChevronRight size={16} className="ml-1" />
            </Button>
          </Link>
        </div>

        {resultsLoading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-48 bg-muted rounded-md animate-pulse"></div>
            ))}
          </div>
        ) : recentResults?.length ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {recentResults.map((result, i) => (
              <Link key={`${result.eventId}-${i}`} href={`/results/${result.eventId}`}>
                <Card className="hover-elevate cursor-pointer hover:border-primary transition-colors h-full group">
                  <CardContent className="p-0">
                    <div className="bg-muted p-4 border-b">
                      <div className="flex justify-between items-start mb-2">
                        <div className="font-heading font-bold text-xl leading-tight group-hover:text-primary transition-colors">
                          {result.eventName}
                        </div>
                        <div className="bg-primary/10 text-primary px-2 py-1 rounded text-xs font-bold uppercase tracking-wider whitespace-nowrap">
                          {result.state}
                        </div>
                      </div>
                      <div className="flex items-center text-sm text-muted-foreground gap-4 mt-2">
                        <span className="flex items-center gap-1.5">
                          <Calendar size={14} />
                          {format(new Date(result.date), 'MMM d, yyyy')}
                        </span>
                        {result.clubName && (
                          <span className="flex items-center gap-1.5 truncate">
                            <Trophy size={14} />
                            <span className="truncate">{result.clubName}</span>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1 font-semibold">Top Result • {result.raceClass}</div>
                      <div className="flex items-center justify-between">
                        <div className="font-bold text-lg">{result.topRider}</div>
                        <div className="text-primary font-heading font-bold flex items-center gap-1">
                          View Details <ChevronRight size={16} />
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        ) : (
          <div className="p-12 text-center bg-muted rounded-md">
            <Trophy className="mx-auto text-muted-foreground mb-4 opacity-50" size={48} />
            <h3 className="text-xl font-heading font-bold mb-2">No Recent Results</h3>
            <p className="text-muted-foreground">Results will appear here once races are completed.</p>
          </div>
        )}
      </section>

      {/* CTA Section */}
      <section className="container mx-auto px-4 mt-8">
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
