import { useState } from "react";
import { useListSeriesStates, useListPublicSeries, useGetSeriesLeaderboard } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trophy, Medal, Award, MapPin, ChevronRight } from "lucide-react";

const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

function stateName(code: string) {
  return US_STATE_NAMES[code.toUpperCase()] ?? code;
}

function PositionBadge({ pos }: { pos: number }) {
  if (pos === 1) return <div className="flex justify-center"><Medal className="text-yellow-500 fill-yellow-500/20" size={26} /></div>;
  if (pos === 2) return <div className="flex justify-center"><Medal className="text-gray-400 fill-gray-400/20" size={26} /></div>;
  if (pos === 3) return <div className="flex justify-center"><Medal className="text-amber-700 fill-amber-700/20" size={26} /></div>;
  return <span className="font-heading font-bold text-lg">{pos}</span>;
}

export default function Leaderboard() {
  const [selectedState, setSelectedState] = useState<string>("");
  const [selectedSeriesId, setSelectedSeriesId] = useState<string>("");

  const { data: states, isLoading: statesLoading } = useListSeriesStates();

  const { data: seriesList, isLoading: seriesLoading } = useListPublicSeries(
    selectedState ? { state: selectedState } : undefined,
    { query: { enabled: true } as any },
  );

  const seriesId = parseInt(selectedSeriesId);
  const { data: standings, isLoading: standingsLoading } = useGetSeriesLeaderboard(seriesId, {
    query: { enabled: !!seriesId } as any,
  });

  const selectedSeries = seriesList?.find(s => s.id === seriesId);

  const handleStateChange = (state: string) => {
    setSelectedState(state);
    setSelectedSeriesId("");
  };

  const standingsByClass = standings?.reduce((acc, standing) => {
    if (!acc[standing.raceClass]) acc[standing.raceClass] = [];
    acc[standing.raceClass].push(standing);
    return acc;
  }, {} as Record<string, typeof standings>) ?? {};

  const classes = Object.keys(standingsByClass).sort();

  return (
    <div className="container mx-auto px-4 py-6 sm:py-8 max-w-6xl">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 sm:mb-8 border-b pb-6">
        <div>
          <h1 className="text-3xl sm:text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
            <Trophy className="text-primary shrink-0" size={32} />
            Series Leaderboard
          </h1>
          <p className="text-muted-foreground mt-1.5">Championship standings from clubs across the platform.</p>
        </div>
      </div>

      {/* Step 1 — State picker */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold shrink-0">1</span>
          <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
            <MapPin size={12} /> Select State
          </label>
        </div>
        {statesLoading ? (
          <div className="h-11 w-64 bg-muted animate-pulse rounded-md" />
        ) : !states?.length ? (
          <p className="text-sm text-muted-foreground">No series available yet.</p>
        ) : (
          <Select value={selectedState} onValueChange={handleStateChange}>
            <SelectTrigger className="w-full sm:w-72 h-11 font-semibold">
              <SelectValue placeholder="Choose a state…" />
            </SelectTrigger>
            <SelectContent>
              {states.map(code => (
                <SelectItem key={code} value={code} className="font-medium">
                  {stateName(code)} ({code})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Step 2 — Series picker */}
      {selectedState && (
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-2">
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold shrink-0">2</span>
            <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
              <ChevronRight size={12} /> Select Series
            </label>
          </div>
          {seriesLoading ? (
            <div className="h-11 w-72 bg-muted animate-pulse rounded-md" />
          ) : !seriesList?.length ? (
            <p className="text-sm text-muted-foreground">No series found in {stateName(selectedState)}.</p>
          ) : (
            <Select value={selectedSeriesId} onValueChange={setSelectedSeriesId}>
              <SelectTrigger className="w-full sm:w-96 h-11 font-heading font-bold uppercase tracking-wide">
                <SelectValue placeholder="Choose a series…" />
              </SelectTrigger>
              <SelectContent>
                {seriesList.map(s => (
                  <SelectItem key={s.id} value={s.id.toString()} className="font-heading font-semibold uppercase tracking-wider">
                    <div className="flex flex-col">
                      <span>{s.name} — {s.season}</span>
                      <span className="text-xs text-muted-foreground font-normal normal-case tracking-normal">{s.clubName}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {/* Standings */}
      {seriesId ? (
        standingsLoading ? (
          <div className="space-y-8">
            <div className="h-8 w-48 bg-muted animate-pulse rounded-md mb-4" />
            <Card className="animate-pulse h-64" />
          </div>
        ) : classes.length > 0 ? (
          <>
            <div className="mb-6 flex items-baseline gap-3">
              <h2 className="text-2xl font-heading font-bold uppercase tracking-tight">{selectedSeries?.name}</h2>
              <span className="text-muted-foreground text-sm">{selectedSeries?.season} season · {selectedSeries?.clubName}</span>
            </div>
            <div className="space-y-10">
              {classes.map(raceClass => {
                const rows = standingsByClass[raceClass].sort((a, b) => a.position - b.position);
                return (
                  <div key={raceClass}>
                    <h3 className="inline-block text-xl sm:text-2xl font-heading font-bold uppercase bg-primary text-primary-foreground px-4 py-2 rounded-md shadow-sm mb-4">
                      {raceClass}
                    </h3>

                    {/* Desktop table */}
                    <Card className="hidden sm:block overflow-hidden border-sidebar-border">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-sidebar text-sidebar-foreground">
                            <tr>
                              <th className="w-20 text-center text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4 px-4">Pos</th>
                              <th className="text-left text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4 px-4">Rider</th>
                              <th className="text-center text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4 px-4 whitespace-nowrap">Events</th>
                              <th className="text-right text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4 px-4 whitespace-nowrap">
                                <span className="flex items-center justify-end gap-1.5"><Award size={15} /> Total Points</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map(standing => (
                              <tr key={`${standing.riderId}-${standing.raceClass}`} className="border-t hover:bg-muted/50 transition-colors">
                                <td className="text-center py-4 px-4"><PositionBadge pos={standing.position} /></td>
                                <td className="py-4 px-4 font-bold text-base">{standing.riderName}</td>
                                <td className="text-center py-4 px-4 font-mono font-medium text-muted-foreground">{standing.eventsEntered || 0}</td>
                                <td className="text-right py-4 px-4 font-heading font-bold text-2xl text-primary">{standing.totalScore}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Card>

                    {/* Mobile card list */}
                    <div className="sm:hidden space-y-2">
                      {rows.map(standing => (
                        <Card key={`${standing.riderId}-${standing.raceClass}`} className="overflow-hidden">
                          <CardContent className="p-0 flex items-center">
                            <div className="bg-sidebar w-14 shrink-0 self-stretch flex items-center justify-center">
                              <PositionBadge pos={standing.position} />
                            </div>
                            <div className="px-4 py-3 flex-1 min-w-0">
                              <div className="font-bold text-base leading-tight truncate">{standing.riderName}</div>
                              <div className="text-xs text-muted-foreground mt-0.5">
                                {standing.eventsEntered || 0} {standing.eventsEntered === 1 ? "event" : "events"}
                              </div>
                            </div>
                            <div className="pr-4 text-right shrink-0">
                              <div className="font-heading font-bold text-2xl text-primary leading-none">{standing.totalScore}</div>
                              <div className="text-xs text-muted-foreground mt-0.5">pts</div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <Card>
            <CardContent className="p-12 sm:p-16 text-center">
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
