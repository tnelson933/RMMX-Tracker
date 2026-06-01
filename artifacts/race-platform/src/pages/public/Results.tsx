import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useListEvents, useListStates } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar, MapPin, Trophy, Flag, ChevronRight, Search } from "lucide-react";
import { format, parseISO, subMonths } from "date-fns";

export default function Results() {
  const [location] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const initialState = searchParams.get("state") || "all";
  
  const [stateFilter, setStateFilter] = useState(initialState);
  
  const { data: states, isLoading: statesLoading } = useListStates();
  
  const { data: eventsRaw, isLoading: eventsLoading } = useListEvents({
    state: stateFilter === "all" ? undefined : stateFilter,
    status: 'completed'
  });

  const cutoff = subMonths(new Date(), 3);
  const events = eventsRaw?.filter(e => parseISO(e.date.substring(0, 10)) >= cutoff);

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8 border-b pb-6">
        <div>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight">Race Results</h1>
          <p className="text-muted-foreground mt-2">Browse completed events and official race results.</p>
        </div>
        
        <div className="w-full md:w-64">
          <Select value={stateFilter} onValueChange={setStateFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by State" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All States</SelectItem>
              {!statesLoading && states?.map(state => (
                <SelectItem key={state.state} value={state.state}>
                  {state.state} ({state.eventCount})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {eventsLoading ? (
        <div className="space-y-4">
          {[...Array(5)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6 h-28 bg-muted/50 rounded-md"></CardContent>
            </Card>
          ))}
        </div>
      ) : events?.length ? (
        <div className="space-y-4">
          {events.map(event => (
            <Link key={event.id} href={`/results/${event.id}`}>
              <Card className="hover-elevate cursor-pointer hover:border-primary transition-all group overflow-hidden">
                <CardContent className="p-0 flex flex-col sm:flex-row">
                  <div className="bg-sidebar p-6 flex flex-col justify-center items-center text-sidebar-foreground sm:w-48 shrink-0 relative overflow-hidden">
                    <div className="absolute inset-0 bg-primary/20 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                    <div className="relative z-10 flex flex-col items-center">
                      <span className="text-sm font-bold text-sidebar-foreground/70 uppercase tracking-widest mb-1">
                        {format(parseISO(event.date.substring(0, 10)), 'MMM yyyy')}
                      </span>
                      <span className="text-5xl font-heading font-bold leading-none">
                        {format(parseISO(event.date.substring(0, 10)), 'dd')}
                      </span>
                    </div>
                  </div>
                  
                  <div className="p-6 flex-1 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="bg-primary/10 text-primary px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider">
                          {event.state}
                        </span>
                        <span className="text-xs text-muted-foreground uppercase font-semibold tracking-wider flex items-center gap-1">
                          <Flag size={12} /> Results Official
                        </span>
                      </div>
                      <h3 className="text-2xl font-heading font-bold group-hover:text-primary transition-colors leading-tight mb-2">
                        {event.name}
                      </h3>
                      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
                        {event.location && (
                          <div className="flex items-center gap-1.5">
                            <MapPin size={16} className="text-muted-foreground/70" />
                            {event.location}
                          </div>
                        )}
                        {event.clubName && (
                          <div className="flex items-center gap-1.5">
                            <Trophy size={16} className="text-muted-foreground/70" />
                            {event.clubName}
                          </div>
                        )}
                      </div>
                    </div>
                    
                    <div className="sm:text-right shrink-0">
                      <Button variant="ghost" className="font-heading uppercase text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-all">
                        View Results <ChevronRight size={18} className="ml-1" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center p-16 text-center">
            <Search className="text-muted-foreground opacity-20 mb-6" size={64} />
            <h3 className="text-2xl font-heading font-bold mb-2">No Results Found</h3>
            <p className="text-muted-foreground max-w-md">
              {stateFilter !== "all" 
                ? `There are currently no published results for events in ${stateFilter}.` 
                : "There are currently no published results available."}
            </p>
            {stateFilter !== "all" && (
              <Button 
                variant="outline" 
                className="mt-6 font-heading uppercase"
                onClick={() => setStateFilter("all")}
              >
                Clear Filters
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
