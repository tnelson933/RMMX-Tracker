import { useState, useEffect } from "react";
import { useParams, Link } from "wouter";
import { useGetEvent, useListResults, RaceResult } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Calendar, MapPin, Trophy, Flag, ChevronLeft, ChevronRight, Clock, Award, Radio } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";

export default function EventResults() {
  const params = useParams();
  const eventId = parseInt(params.eventId || "0");
  
  const { data: event, isLoading: eventLoading } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const { data: results, isLoading: resultsLoading } = useListResults(eventId, { query: { enabled: !!eventId } as any });
  
  const [activeClass, setActiveClass] = useState<string>("");
  const [isLive, setIsLive] = useState(false);

  // Poll for live video status every 10s
  useEffect(() => {
    if (!eventId) return;
    const check = () =>
      fetch(`/api/video/status/${eventId}`)
        .then(r => r.json())
        .then(d => setIsLive(!!d.live))
        .catch(() => {});
    check();
    const id = setInterval(check, 10_000);
    return () => clearInterval(id);
  }, [eventId]);

  // Initialize active class once event data is loaded
  if (event && !activeClass && event.raceClasses && event.raceClasses.length > 0) {
    setActiveClass(event.raceClasses[0]);
  }

  // Filter results by active class
  const classResults = results?.filter(r => r.raceClass === activeClass) || [];
  
  // Group results by moto for the active class
  const motosByClass = Array.from(new Set(classResults.map(r => r.motoName))).filter(Boolean) as string[];

  if (eventLoading || resultsLoading) {
    return <div className="container mx-auto px-4 py-8 h-screen flex items-center justify-center">Loading...</div>;
  }

  if (!event) {
    return <div className="container mx-auto px-4 py-8">Event not found.</div>;
  }

  return (
    <div className="bg-muted/30 min-h-[calc(100vh-64px)] pb-12">
      {/* Event Header */}
      <div className="bg-sidebar text-sidebar-foreground border-b border-sidebar-border pb-8 pt-8">
        <div className="container mx-auto px-4">
          <Link href="/results" className="inline-flex items-center text-sm font-medium text-sidebar-foreground/60 hover:text-white transition-colors mb-6 uppercase tracking-wider">
            <ChevronLeft size={16} className="mr-1" /> Back to Results
          </Link>
          
          <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
            <div>
              <div className="flex items-center gap-3 mb-3">
                <Badge variant="outline" className="bg-primary/20 text-white border-primary/50 font-heading uppercase tracking-wider px-3 py-1 text-sm">
                  {event.state}
                </Badge>
                {event.status === 'results_published' && (
                  <Badge variant="outline" className="bg-secondary/20 text-white border-secondary/50 font-heading uppercase tracking-wider px-3 py-1 text-sm flex items-center gap-1.5">
                    <Flag size={14} /> Official Results
                  </Badge>
                )}
              </div>
              <h1 className="text-4xl md:text-6xl font-heading font-bold uppercase tracking-tight leading-none mb-4 text-white">
                {event.name}
              </h1>
              
              <div className="flex flex-wrap gap-x-8 gap-y-3 text-sidebar-foreground/80">
                <div className="flex items-center gap-2">
                  <Calendar size={18} className="text-primary" />
                  <span className="font-medium">{format(new Date(event.date), 'EEEE, MMMM d, yyyy')}</span>
                </div>
                {event.location && (
                  <div className="flex items-center gap-2">
                    <MapPin size={18} className="text-primary" />
                    <span className="font-medium">{event.trackName ? `${event.trackName}, ${event.location}` : event.location}</span>
                  </div>
                )}
                {event.clubName && (
                  <div className="flex items-center gap-2">
                    <Trophy size={18} className="text-primary" />
                    <span className="font-medium">{event.clubName}</span>
                  </div>
                )}
              </div>
            </div>
            
            <div className="flex flex-col items-end gap-3">
              {isLive && (
                <a href={`/watch/${eventId}`} target="_blank" rel="noopener noreferrer">
                  <Button className="bg-red-600 hover:bg-red-700 text-white font-heading uppercase tracking-wider gap-2 shadow-lg">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
                    </span>
                    <Radio size={15} /> Watch Live
                  </Button>
                </a>
              )}
              <div className="bg-sidebar-accent/50 rounded-lg p-4 border border-sidebar-border backdrop-blur-sm min-w-48 text-center">
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
        {event.raceClasses && event.raceClasses.length > 0 ? (
          <Tabs value={activeClass} onValueChange={setActiveClass} className="w-full">
            <div className="bg-card rounded-t-lg border-x border-t p-2 overflow-x-auto hide-scrollbar">
              <TabsList className="inline-flex h-auto w-auto p-1 bg-muted/50 rounded-md">
                {event.raceClasses.map(cls => (
                  <TabsTrigger 
                    key={cls} 
                    value={cls}
                    className="font-heading uppercase text-base px-6 py-3 rounded-sm data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-md transition-all whitespace-nowrap"
                  >
                    {cls}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            
            <TabsContent value={activeClass} className="m-0 bg-card border rounded-b-lg shadow-sm">
              <div className="p-6 md:p-8">
                <div className="flex items-center justify-between mb-8">
                  <h2 className="text-2xl font-heading font-bold uppercase flex items-center gap-3">
                    <Trophy className="text-primary" /> {activeClass} Results
                  </h2>
                </div>

                {classResults.length === 0 ? (
                  <div className="text-center py-16 bg-muted/30 rounded-lg border border-dashed">
                    <Flag className="mx-auto text-muted-foreground opacity-30 mb-4" size={48} />
                    <h3 className="text-xl font-heading font-bold mb-2">No Results Available</h3>
                    <p className="text-muted-foreground">Results for this class have not been published yet.</p>
                  </div>
                ) : (
                  <div className="space-y-12">
                    {/* Overall/Main results if we have multiple motos, otherwise just show the one set */}
                    {motosByClass.length > 0 ? (
                      motosByClass.map(motoName => {
                        const motoResults = classResults.filter(r => r.motoName === motoName).sort((a, b) => a.position - b.position);
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
              </div>
            </TabsContent>
          </Tabs>
        ) : (
          <Card>
            <CardContent className="p-12 text-center">
              <p className="text-muted-foreground text-lg">No race classes found for this event.</p>
            </CardContent>
          </Card>
        )}
      </div>
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
            <TableHead className="text-right text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4"><span className="flex items-center justify-end gap-1"><Clock size={14}/> Total Time</span></TableHead>
            <TableHead className="text-right text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4"><span className="flex items-center justify-end gap-1"><Award size={14}/> Points</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.map((result) => (
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
              <TableCell className="text-right font-mono font-medium text-muted-foreground">
                {result.totalTime || "-"}
              </TableCell>
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
