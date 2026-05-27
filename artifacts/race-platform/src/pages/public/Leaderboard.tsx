import { useState } from "react";
import { useListSeries, useGetSeriesLeaderboard } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Trophy, Medal, Award, ChevronRight } from "lucide-react";

export default function Leaderboard() {
  const { data: seriesList, isLoading: seriesLoading } = useListSeries();
  
  // Default to first series if available
  const defaultSeriesId = seriesList?.[0]?.id?.toString() || "";
  const [selectedSeriesId, setSelectedSeriesId] = useState<string>("");
  
  // Initialize selection when series load
  if (seriesList?.length && !selectedSeriesId) {
    setSelectedSeriesId(seriesList[0].id.toString());
  }

  const seriesId = parseInt(selectedSeriesId || defaultSeriesId);
  const { data: standings, isLoading: standingsLoading } = useGetSeriesLeaderboard(seriesId, { 
    query: { enabled: !!seriesId } as any
  });

  const selectedSeries = seriesList?.find(s => s.id === seriesId);

  // Group standings by class
  const standingsByClass = standings?.reduce((acc, standing) => {
    if (!acc[standing.raceClass]) acc[standing.raceClass] = [];
    acc[standing.raceClass].push(standing);
    return acc;
  }, {} as Record<string, typeof standings>) || {};

  const classes = Object.keys(standingsByClass).sort();

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8 border-b pb-6">
        <div>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
            <Trophy className="text-primary" size={36} /> 
            Series Leaderboard
          </h1>
          <p className="text-muted-foreground mt-2">Current championship standings and points.</p>
        </div>
        
        <div className="w-full md:w-72">
          {seriesLoading ? (
            <div className="h-10 bg-muted animate-pulse rounded-md"></div>
          ) : seriesList?.length ? (
            <Select value={selectedSeriesId} onValueChange={setSelectedSeriesId}>
              <SelectTrigger className="font-heading font-bold text-lg h-12 uppercase tracking-wide">
                <SelectValue placeholder="Select Series" />
              </SelectTrigger>
              <SelectContent>
                {seriesList.map(series => (
                  <SelectItem key={series.id} value={series.id.toString()} className="font-heading font-semibold uppercase tracking-wider text-base">
                    {series.name} - {series.season}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="text-sm text-muted-foreground text-right">No active series.</div>
          )}
        </div>
      </div>

      {seriesId ? (
        standingsLoading ? (
          <div className="space-y-8">
            <div className="h-8 w-48 bg-muted animate-pulse rounded-md mb-4"></div>
            <Card className="animate-pulse h-64"></Card>
          </div>
        ) : classes.length > 0 ? (
          <div className="space-y-12">
            {classes.map(raceClass => (
              <div key={raceClass}>
                <div className="flex items-center gap-3 mb-4">
                  <h2 className="text-2xl font-heading font-bold uppercase bg-primary text-primary-foreground px-4 py-2 rounded-md shadow-sm">
                    {raceClass}
                  </h2>
                </div>
                
                <Card className="overflow-hidden border-sidebar-border">
                  <Table>
                    <TableHeader className="bg-sidebar text-sidebar-foreground">
                      <TableRow className="hover:bg-sidebar">
                        <TableHead className="w-20 text-center text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Pos</TableHead>
                        <TableHead className="text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Rider</TableHead>
                        <TableHead className="text-center text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Events</TableHead>
                        <TableHead className="text-right text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4"><span className="flex items-center justify-end gap-1.5"><Award size={16}/> Total Points</span></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {standingsByClass[raceClass].sort((a, b) => a.position - b.position).map((standing) => (
                        <TableRow key={`${standing.riderId}-${standing.raceClass}`} className="hover:bg-muted/50 transition-colors">
                          <TableCell className="text-center">
                            {standing.position === 1 ? (
                              <div className="flex justify-center"><Medal className="text-yellow-500 fill-yellow-500/20" size={28} /></div>
                            ) : standing.position === 2 ? (
                              <div className="flex justify-center"><Medal className="text-gray-400 fill-gray-400/20" size={28} /></div>
                            ) : standing.position === 3 ? (
                              <div className="flex justify-center"><Medal className="text-amber-700 fill-amber-700/20" size={28} /></div>
                            ) : (
                              <span className="font-heading font-bold text-xl">{standing.position}</span>
                            )}
                          </TableCell>
                          <TableCell className="font-bold text-lg">{standing.riderName}</TableCell>
                          <TableCell className="text-center font-mono font-medium text-muted-foreground">{standing.eventsEntered || 0}</TableCell>
                          <TableCell className="text-right font-heading font-bold text-2xl text-primary">{standing.totalPoints}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              </div>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="p-16 text-center">
              <Trophy className="mx-auto text-muted-foreground opacity-20 mb-6" size={64} />
              <h3 className="text-2xl font-heading font-bold mb-2">No Standings Yet</h3>
              <p className="text-muted-foreground max-w-md mx-auto">
                No results have been recorded for {selectedSeries?.name} yet. Check back after the first event is completed.
              </p>
            </CardContent>
          </Card>
        )
      ) : null}
    </div>
  );
}
