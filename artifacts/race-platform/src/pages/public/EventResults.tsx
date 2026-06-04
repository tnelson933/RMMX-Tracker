import { useState, useEffect } from "react";
import { useParams, Link } from "wouter";
import {
  useGetEvent, useListResults, useListMotos, RaceResult, Moto,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Calendar, MapPin, Trophy, Flag, ChevronLeft, ChevronRight,
  Clock, Award, Radio, CheckCircle, AlertCircle, Activity,
  ChevronDown, ChevronUp, Users, Timer,
} from "lucide-react";
import { format, parseISO, isToday } from "date-fns";
import { Button } from "@/components/ui/button";

export default function EventResults() {
  const params = useParams();
  const eventId = parseInt(params.eventId || "0");

  const isLiveDay = (date: string, status: string) =>
    isToday(new Date(date)) || status === "race_day";

  const { data: event, isLoading: eventLoading } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });

  const liveMode = !!(event && isLiveDay(event.date, event.status));

  const { data: results, isLoading: resultsLoading } = useListResults(eventId, {
    query: {
      enabled: !!eventId,
      refetchInterval: liveMode ? 15_000 : false,
    } as any,
  });

  const { data: motos, isLoading: motosLoading } = useListMotos(eventId, {
    query: {
      enabled: !!eventId,
      refetchInterval: liveMode ? 15_000 : false,
    } as any,
  });

  const [activeClass, setActiveClass] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState(false);

  useEffect(() => {
    if (!eventId) return;
    const check = () =>
      fetch(`/api/video/status/${eventId}`)
        .then(r => r.json())
        .then(d => setIsStreaming(!!d.live))
        .catch(() => {});
    check();
    const id = setInterval(check, 10_000);
    return () => clearInterval(id);
  }, [eventId]);

  const activeMoto = motos?.find(m => m.status === "in_progress");

  if (event && !activeClass && event.raceClasses && event.raceClasses.length > 0) {
    setActiveClass(event.raceClasses[0]);
  }

  const classResults = results?.filter(r => r.raceClass === activeClass) || [];
  const motosByClass = Array.from(new Set(classResults.map(r => r.motoName))).filter(Boolean) as string[];

  // Group motos by class for schedule view
  const motosByRaceClass = (motos ?? []).reduce<Record<string, Moto[]>>((acc, m) => {
    const cls = m.raceClass ?? "Unknown";
    if (!acc[cls]) acc[cls] = [];
    acc[cls].push(m);
    return acc;
  }, {});

  const activeClassMoto = motos?.find(m => m.status === "in_progress" && m.raceClass === activeClass);

  if (eventLoading || resultsLoading) {
    return <div className="container mx-auto px-4 py-8 h-screen flex items-center justify-center">Loading…</div>;
  }
  if (!event) {
    return <div className="container mx-auto px-4 py-8">Event not found.</div>;
  }

  return (
    <div className="bg-muted/30 min-h-[calc(100vh-64px)] pb-12">

      {/* Watch Live banner — shown prominently at very top when streaming */}
      {isStreaming && (
        <div className="bg-red-600 text-white py-3 px-4">
          <div className="container mx-auto flex items-center justify-between gap-4">
            <span className="flex items-center gap-2 font-heading font-bold uppercase tracking-wider text-sm">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-white" />
              </span>
              Live Video Stream Active
            </span>
            <a href={`/watch/${eventId}`} target="_blank" rel="noopener noreferrer">
              <Button size="sm" className="bg-white text-red-600 hover:bg-white/90 font-heading uppercase tracking-wider font-bold h-8 px-4">
                <Radio size={14} className="mr-1.5" /> Watch Live
              </Button>
            </a>
          </div>
        </div>
      )}

      {/* Event Header */}
      <div className="bg-sidebar text-sidebar-foreground border-b border-sidebar-border pb-8 pt-8">
        <div className="container mx-auto px-4">
          <Link href="/" className="inline-flex items-center text-sm font-medium text-sidebar-foreground/60 hover:text-white transition-colors mb-6 uppercase tracking-wider">
            <ChevronLeft size={16} className="mr-1" /> Back
          </Link>

          <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
            <div>
              <div className="flex items-center gap-3 mb-3 flex-wrap">
                <Badge variant="outline" className="bg-primary/20 text-white border-primary/50 font-heading uppercase tracking-wider px-3 py-1 text-sm">
                  {event.state}
                </Badge>
                {liveMode && (
                  <Badge variant="outline" className="bg-red-600/80 text-white border-red-400/50 font-heading uppercase tracking-wider px-3 py-1 text-sm flex items-center gap-1.5">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
                    </span>
                    Race Day
                  </Badge>
                )}
                {event.status === "completed" && (
                  <Badge variant="outline" className="bg-secondary/20 text-white border-secondary/50 font-heading uppercase tracking-wider px-3 py-1 text-sm flex items-center gap-1.5">
                    <Flag size={14} /> Official Results
                  </Badge>
                )}
                {event.status === "registration_open" && (
                  <Badge variant="outline" className="bg-green-600/50 text-white border-green-400/50 font-heading uppercase tracking-wider px-3 py-1 text-sm">
                    Registration Open
                  </Badge>
                )}
                {event.timingTechnology && (
                  <Badge variant="outline" className="bg-white/10 text-white/80 border-white/20 font-heading uppercase tracking-wider px-3 py-1 text-sm flex items-center gap-1.5">
                    <Timer size={13} />
                    {event.timingTechnology === "mylaps" ? "Timed with MyLaps" : "Timed with RFID"}
                  </Badge>
                )}
              </div>
              <h1 className="text-4xl md:text-5xl font-heading font-bold uppercase tracking-tight leading-none mb-4 text-white">
                {event.name}
              </h1>
              <div className="flex flex-wrap gap-x-8 gap-y-3 text-sidebar-foreground/80">
                <div className="flex items-center gap-2">
                  <Calendar size={18} className="text-primary" />
                  <span className="font-medium">{format(parseISO(event.date.substring(0, 10)), "EEEE, MMMM d, yyyy")}</span>
                </div>
                {event.location && (
                  <div className="flex items-center gap-2">
                    <MapPin size={18} className="text-primary" />
                    <span className="font-medium">
                      {event.trackName ? `${event.trackName}, ${event.location}` : event.location}
                    </span>
                  </div>
                )}
                {event.clubName && (
                  <div className="flex items-center gap-2">
                    <Trophy size={18} className="text-primary" />
                    <span className="font-medium">{event.clubName}</span>
                  </div>
                )}
              </div>
              {((event as any).clubLogoUrl || (event as any).imageUrl) && (
                <div className="mt-4 flex items-center gap-5 flex-wrap">
                  {(event as any).clubLogoUrl && (
                    <img
                      src={(event as any).clubLogoUrl}
                      alt={event.clubName || "Club logo"}
                      className="h-14 w-auto object-contain opacity-90"
                    />
                  )}
                  {(event as any).imageUrl && (
                    <img
                      src={(event as any).imageUrl}
                      alt={event.name}
                      className="h-16 w-auto max-w-[180px] object-contain opacity-95 rounded"
                    />
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-col items-start md:items-end gap-3">
              {!isStreaming && liveMode && (
                <div className="text-sidebar-foreground/60 text-xs font-heading uppercase tracking-wider flex items-center gap-1.5">
                  <Activity size={13} /> Live standings update every 15s
                </div>
              )}
              <div className="bg-sidebar-accent/50 rounded-lg p-4 border border-sidebar-border backdrop-blur-sm min-w-40 text-center">
                <div className="text-sidebar-foreground/60 text-xs font-bold uppercase tracking-widest mb-1">Total Racers</div>
                <div className="text-4xl font-heading font-bold text-white">
                  {new Set(results?.map(r => r.riderId)).size || 0}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 -mt-4">
        {liveMode ? (
          /* LIVE MODE: schedule + standings tabs */
          <Tabs defaultValue="standings" className="w-full">
            <div className="bg-card rounded-t-lg border-x border-t p-2 overflow-x-auto hide-scrollbar">
              <TabsList className="inline-flex h-auto w-auto p-1 bg-muted/50 rounded-md">
                <TabsTrigger value="standings" className="font-heading uppercase text-base px-6 py-3 rounded-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md transition-all whitespace-nowrap">
                  <Activity size={15} className="mr-2" /> Live Standings
                </TabsTrigger>
                <TabsTrigger value="schedule" className="font-heading uppercase text-base px-6 py-3 rounded-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md transition-all whitespace-nowrap">
                  <Clock size={15} className="mr-2" /> Race Schedule
                  {activeMoto && (
                    <span className="ml-2 flex h-2 w-2 relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Live Standings tab */}
            <TabsContent value="standings" className="m-0 bg-card border rounded-b-lg shadow-sm">
              <div className="p-6 md:p-8">
                {event.raceClasses && event.raceClasses.length > 0 ? (
                  <>
                    {/* Class selector */}
                    <div className="flex flex-wrap gap-2 mb-6">
                      {event.raceClasses.map(cls => (
                        <button
                          key={cls}
                          onClick={() => setActiveClass(cls)}
                          className={`px-4 py-2 rounded-md font-heading font-bold uppercase tracking-wider text-sm transition-all ${
                            activeClass === cls
                              ? "bg-primary text-primary-foreground shadow"
                              : "bg-muted text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {cls}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
                      <h2 className="text-2xl font-heading font-bold uppercase flex items-center gap-3">
                        <Trophy className="text-primary" /> {activeClass}
                      </h2>
                    </div>

                    {classResults.length === 0 ? (
                      activeClassMoto ? (
                        <div className="text-center py-16 bg-red-50/40 dark:bg-red-950/20 rounded-lg border border-red-300/40 border-dashed">
                          <div className="flex items-center justify-center gap-2 mb-4">
                            <span className="relative flex h-3 w-3">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                              <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
                            </span>
                            <span className="text-red-500 font-heading font-bold uppercase tracking-wider text-sm">Moto In Progress</span>
                          </div>
                          <h3 className="text-xl font-heading font-bold mb-2">{activeClassMoto.name}</h3>
                          <p className="text-muted-foreground">Standings will appear here as results are entered. Page refreshes automatically every 15s.</p>
                        </div>
                      ) : (
                        <div className="text-center py-16 bg-muted/30 rounded-lg border border-dashed">
                          <Activity className="mx-auto text-muted-foreground opacity-30 mb-4" size={48} />
                          <h3 className="text-xl font-heading font-bold mb-2">Standing By</h3>
                          <p className="text-muted-foreground">Standings will appear here once a moto is underway.</p>
                        </div>
                      )
                    ) : (
                      <div className="space-y-12">
                        {motosByClass.length > 0 ? (
                          motosByClass.map(motoName => {
                            const motoResults = classResults
                              .filter(r => r.motoName === motoName)
                              .sort((a, b) => a.position - b.position);
                            return (
                              <div key={motoName} className="space-y-4">
                                <h3 className="text-xl font-heading font-bold uppercase px-2 py-1 bg-muted inline-block rounded">{motoName}</h3>
                                <ResultTable results={motoResults} />
                              </div>
                            );
                          })
                        ) : (
                          <ResultTable results={classResults.sort((a, b) => a.position - b.position)} />
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-center py-16 text-muted-foreground">
                    No race classes defined for this event yet.
                  </div>
                )}
              </div>
            </TabsContent>

            {/* Schedule tab */}
            <TabsContent value="schedule" className="m-0 bg-card border rounded-b-lg shadow-sm">
              <div className="p-6 md:p-8">
                <h2 className="text-2xl font-heading font-bold uppercase mb-6 flex items-center gap-3">
                  <Clock className="text-primary" /> Race Schedule
                </h2>

                {motosLoading ? (
                  <div className="space-y-3">
                    {[...Array(4)].map((_, i) => <div key={i} className="h-14 bg-muted rounded-md animate-pulse" />)}
                  </div>
                ) : !motos || motos.length === 0 ? (
                  <div className="text-center py-16 bg-muted/30 rounded-lg border border-dashed">
                    <Clock className="mx-auto text-muted-foreground opacity-30 mb-4" size={48} />
                    <h3 className="text-xl font-heading font-bold mb-2">Schedule Not Available</h3>
                    <p className="text-muted-foreground">The moto schedule will appear here once lineups are generated.</p>
                  </div>
                ) : (
                  <div className="space-y-8">
                    {Object.entries(motosByRaceClass).map(([cls, clsMotos]) => (
                      <div key={cls}>
                        <h3 className="text-base font-heading font-bold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                          <Trophy size={15} /> {cls}
                        </h3>
                        <div className="space-y-2">
                          {clsMotos
                            .sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0))
                            .map(moto => (
                              <MotoScheduleRow key={moto.id} moto={moto} />
                            ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>
        ) : (
          /* RESULTS MODE (completed / upcoming non-live) */
          (event.raceClasses && event.raceClasses.length > 0) || (motos && motos.length > 0) ? (
            <Tabs value={activeClass} onValueChange={setActiveClass} className="w-full">
              <div className="bg-card rounded-t-lg border-x border-t p-2 overflow-x-auto hide-scrollbar">
                <TabsList className="inline-flex h-auto w-auto p-1 bg-muted/50 rounded-md">
                  {(event.raceClasses ?? []).map(cls => (
                    <TabsTrigger
                      key={cls}
                      value={cls}
                      className="font-heading uppercase text-base px-6 py-3 rounded-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md transition-all whitespace-nowrap"
                    >
                      {cls}
                    </TabsTrigger>
                  ))}
                  {motos && motos.length > 0 && (
                    <TabsTrigger
                      value="__schedule__"
                      className="font-heading uppercase text-base px-6 py-3 rounded-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md transition-all whitespace-nowrap"
                    >
                      <Clock size={14} className="mr-2" /> Race Schedule
                    </TabsTrigger>
                  )}
                </TabsList>
              </div>

              {/* One TabsContent per race class */}
              {(event.raceClasses ?? []).map(cls => {
                const clsResults = results?.filter(r => r.raceClass === cls) || [];
                const clsMotoNames = Array.from(new Set(clsResults.map(r => r.motoName))).filter(Boolean) as string[];
                return (
                  <TabsContent key={cls} value={cls} className="m-0 bg-card border rounded-b-lg shadow-sm">
                    <div className="p-6 md:p-8">
                      <div className="flex items-center justify-between mb-8">
                        <h2 className="text-2xl font-heading font-bold uppercase flex items-center gap-3">
                          <Trophy className="text-primary" /> {cls} Results
                        </h2>
                      </div>
                      {clsResults.length === 0 ? (
                        <div className="text-center py-16 bg-muted/30 rounded-lg border border-dashed">
                          <Flag className="mx-auto text-muted-foreground opacity-30 mb-4" size={48} />
                          <h3 className="text-xl font-heading font-bold mb-2">No Results Available</h3>
                          <p className="text-muted-foreground">Results for this class have not been published yet.</p>
                        </div>
                      ) : (
                        <div className="space-y-12">
                          {clsMotoNames.length > 0 ? (
                            clsMotoNames.map(motoName => {
                              const motoResults = clsResults
                                .filter(r => r.motoName === motoName)
                                .sort((a, b) => a.position - b.position);
                              return (
                                <div key={motoName} className="space-y-4">
                                  <h3 className="text-xl font-heading font-bold uppercase px-2 py-1 bg-muted inline-block rounded">{motoName}</h3>
                                  <ResultTable results={motoResults} />
                                </div>
                              );
                            })
                          ) : (
                            <ResultTable results={clsResults.sort((a, b) => a.position - b.position)} />
                          )}
                        </div>
                      )}
                    </div>
                  </TabsContent>
                );
              })}

              {/* Race Schedule tab */}
              {motos && motos.length > 0 && (
                <TabsContent value="__schedule__" className="m-0 bg-card border rounded-b-lg shadow-sm">
                  <div className="p-6 md:p-8">
                    <h2 className="text-2xl font-heading font-bold uppercase mb-6 flex items-center gap-3">
                      <Clock className="text-primary" /> Race Schedule
                    </h2>
                    <div className="space-y-8">
                      {Object.entries(motosByRaceClass).map(([cls, clsMotos]) => (
                        <div key={cls}>
                          <h3 className="text-base font-heading font-bold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-2">
                            <Trophy size={15} /> {cls}
                          </h3>
                          <div className="space-y-2">
                            {clsMotos
                              .sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0))
                              .map(moto => <MotoScheduleRow key={moto.id} moto={moto} />)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </TabsContent>
              )}
            </Tabs>
          ) : (
            /* Upcoming event — no classes or motos yet */
            <Card>
              <CardContent className="p-12 text-center space-y-4">
                <Calendar className="mx-auto text-primary/50" size={48} />
                <h3 className="text-2xl font-heading font-bold uppercase">
                  {event.status === "registration_open" ? "Registration Is Open" : "Event Coming Soon"}
                </h3>
                <p className="text-muted-foreground max-w-md mx-auto">
                  Race classes and results will appear here once the event is underway.
                </p>
                {event.status === "registration_open" && (
                  <Link href={`/register/${eventId}`}>
                    <Button className="font-heading uppercase tracking-wider mt-2">Register Now</Button>
                  </Link>
                )}
              </CardContent>
            </Card>
          )
        )}
      </div>
    </div>
  );
}

function MotoScheduleRow({ moto }: { moto: Moto }) {
  const [expanded, setExpanded] = useState(false);
  const lineup = moto.lineup ?? [];
  const hasLineup = lineup.length > 0;

  const statusMap: Record<string, { icon: React.ReactNode; label: string; cls: string }> = {
    scheduled: { icon: <Clock size={15} className="text-muted-foreground" />, label: "Scheduled", cls: "text-muted-foreground" },
    in_progress: { icon: <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75"/><span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"/></span>, label: "IN PROGRESS", cls: "text-red-500 font-bold" },
    completed: { icon: <CheckCircle size={15} className="text-green-500" />, label: "Completed", cls: "text-green-600" },
  };
  const statusConfig = statusMap[moto.status] ?? { icon: <AlertCircle size={15} />, label: moto.status, cls: "text-muted-foreground" };

  return (
    <div className={`rounded-lg border overflow-hidden ${moto.status === "in_progress" ? "border-red-400/50 bg-red-50/30 dark:bg-red-950/20" : "border-border bg-muted/20"}`}>
      {/* Header row — clickable when lineup exists */}
      <div
        className={`flex items-center justify-between px-4 py-3 ${hasLineup ? "cursor-pointer hover:bg-muted/40 transition-colors" : ""}`}
        onClick={() => hasLineup && setExpanded(v => !v)}
      >
        <div className="flex items-center gap-3">
          {statusConfig.icon}
          <div>
            <div className={`font-heading font-bold uppercase tracking-wide text-sm ${moto.status === "in_progress" ? "text-foreground" : ""}`}>
              {moto.name}
            </div>
            <div className="text-xs text-muted-foreground flex items-center gap-1.5">
              {moto.type.charAt(0).toUpperCase() + moto.type.slice(1)}
              {hasLineup && (
                <>
                  <span>·</span>
                  <Users size={11} />
                  {lineup.length} riders
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {moto.scheduledTime && (
            <span className="text-sm text-muted-foreground font-mono">{moto.scheduledTime}</span>
          )}
          <span className={`text-xs uppercase tracking-wider ${statusConfig.cls}`}>{statusConfig.label}</span>
          {hasLineup && (
            <span className="text-muted-foreground ml-1">
              {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </span>
          )}
        </div>
      </div>

      {/* Expanded rider list */}
      {expanded && hasLineup && (
        <div className="px-4 pb-4 pt-1 border-t bg-background">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-1.5 pt-2">
            {[...lineup]
              .sort((a, b) => a.position - b.position)
              .map(entry => (
                <div
                  key={entry.riderId}
                  className="flex items-center gap-2 bg-muted/60 rounded px-2.5 py-1.5 border border-border/50"
                >
                  <span className="font-mono font-bold text-xs text-muted-foreground min-w-5 text-center shrink-0">
                    #{entry.bibNumber ?? "—"}
                  </span>
                  <span className="text-sm font-medium truncate">{entry.riderName}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ResultTable({ results }: { results: RaceResult[] }) {
  return (
    <div className="border rounded-md overflow-hidden bg-card">
      <Table>
        <TableHeader className="bg-sidebar text-sidebar-foreground">
          <TableRow className="hover:bg-sidebar">
            <TableHead className="w-16 text-center text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Pos</TableHead>
            <TableHead className="w-24 text-center text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Bib</TableHead>
            <TableHead className="text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Rider</TableHead>
            <TableHead className="text-right text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">
              <span className="flex items-center justify-end gap-1"><Clock size={14} /> Time</span>
            </TableHead>
            <TableHead className="text-right text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">
              <span className="flex items-center justify-end gap-1"><Award size={14} /> Pts</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.map(result => (
            <TableRow key={result.id} className="hover:bg-muted/50 transition-colors">
              <TableCell className="text-center font-heading font-bold text-xl">
                {result.dnf ? (
                  <span className="text-destructive text-sm uppercase">DNF</span>
                ) : result.dns ? (
                  <span className="text-muted-foreground text-sm uppercase">DNS</span>
                ) : (
                  <span className={result.position === 1 ? "text-primary" : ""}>{result.position}</span>
                )}
              </TableCell>
              <TableCell className="text-center">
                <span className="inline-block bg-muted px-2 py-1 rounded font-mono font-bold text-sm border">
                  {result.bibNumber || "-"}
                </span>
              </TableCell>
              <TableCell className="font-bold text-lg">{result.riderName}</TableCell>
              <TableCell className="text-right font-mono font-medium text-muted-foreground">{result.totalTime || "-"}</TableCell>
              <TableCell className="text-right font-heading font-bold text-xl text-primary">
                {result.points !== null && result.points !== undefined ? result.points : "-"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
