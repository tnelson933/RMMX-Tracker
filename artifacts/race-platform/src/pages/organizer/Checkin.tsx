import { useState } from "react";
import { useParams, Link } from "wouter";
import { useGetEvent, useListCheckins, useGetRaceDaySummary, useCheckinRider } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search, CheckCircle, XCircle, Tag, RefreshCw } from "lucide-react";
import { getListCheckinsQueryKey, getGetRaceDaySummaryQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

export default function Checkin() {
  const params = useParams();
  const eventId = parseInt(params.eventId || "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");

  const { data: event, isLoading: eventLoading } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const { data: checkins, isLoading: checkinsLoading } = useListCheckins(eventId, { 
    query: { enabled: !!eventId, refetchInterval: 30000 } as any
  });
  const { data: summary } = useGetRaceDaySummary(eventId, {
    query: { enabled: !!eventId, refetchInterval: 30000 } as any
  });

  const checkinMutation = useCheckinRider();

  const handleCheckin = (riderId: number, currentRfid?: string | null) => {
    // In a real app we might prompt for RFID if not present, but for touch-friendly fast POS:
    // Just toggle checkin status
    checkinMutation.mutate({
      eventId,
      data: {
        riderId,
        rfidNumber: currentRfid || undefined
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCheckinsQueryKey(eventId) });
        queryClient.invalidateQueries({ queryKey: getGetRaceDaySummaryQueryKey(eventId) });
        toast({ title: "Check-in successful", variant: "default" });
      },
      onError: (err) => {
        toast({ title: "Check-in failed", description: err.message, variant: "destructive" });
      }
    });
  };

  const filteredCheckins = checkins?.filter(c => {
    const matchesSearch = c.riderName.toLowerCase().includes(search.toLowerCase()) || 
                          (c.bibNumber && c.bibNumber.includes(search));
    
    if (!matchesSearch) return false;
    
    if (filter === "checked_in") return c.checkedIn;
    if (filter === "not_checked_in") return !c.checkedIn;
    if (filter === "no_rfid") return !c.rfidLinked;
    
    return true;
  }) || [];

  if (eventLoading || checkinsLoading) return <div className="p-8">Loading...</div>;

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="bg-sidebar text-sidebar-foreground p-6 flex flex-col md:flex-row justify-between items-center gap-4">
        <div>
          <h1 className="text-3xl font-heading font-bold uppercase tracking-tight text-white">{event?.name} - Check-In</h1>
        </div>
        
        <div className="flex gap-4 w-full md:w-auto">
          <div className="bg-sidebar-accent/50 rounded-lg p-3 border border-sidebar-border backdrop-blur-sm min-w-32 text-center">
            <div className="text-sidebar-foreground/60 text-xs font-bold uppercase tracking-widest mb-1">Checked In</div>
            <div className="text-2xl font-heading font-bold text-secondary">{summary?.checkedIn || 0} / {summary?.totalRegistered || 0}</div>
          </div>
          <div className="bg-sidebar-accent/50 rounded-lg p-3 border border-sidebar-border backdrop-blur-sm min-w-32 text-center">
            <div className="text-sidebar-foreground/60 text-xs font-bold uppercase tracking-widest mb-1">RFID Linked</div>
            <div className="text-2xl font-heading font-bold text-white">{summary?.rfidLinked || 0}</div>
          </div>
        </div>
      </div>

      <div className="p-6 flex-1 flex flex-col gap-6">
        <div className="bg-white p-4 rounded-lg shadow-sm border flex flex-col md:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" size={24} />
            <Input 
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by rider name or bib #..." 
              className="pl-12 h-14 text-xl font-medium bg-muted/30"
            />
          </div>
          <div className="flex gap-2 overflow-x-auto pb-2 md:pb-0">
            <Button 
              variant={filter === "all" ? "default" : "outline"} 
              className="h-14 px-6 text-lg font-heading uppercase"
              onClick={() => setFilter("all")}
            >
              All
            </Button>
            <Button 
              variant={filter === "not_checked_in" ? "default" : "outline"} 
              className="h-14 px-6 text-lg font-heading uppercase"
              onClick={() => setFilter("not_checked_in")}
            >
              Pending
            </Button>
            <Button 
              variant={filter === "checked_in" ? "default" : "outline"} 
              className="h-14 px-6 text-lg font-heading uppercase"
              onClick={() => setFilter("checked_in")}
            >
              Checked In
            </Button>
            <Button 
              variant={filter === "no_rfid" ? "default" : "outline"} 
              className="h-14 px-6 text-lg font-heading uppercase"
              onClick={() => setFilter("no_rfid")}
            >
              No RFID
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredCheckins.map(checkin => (
              <Card key={checkin.id} className={`overflow-hidden transition-all ${checkin.checkedIn ? 'border-secondary bg-secondary/5' : 'hover:border-primary/50'}`}>
                <CardContent className="p-0 flex h-full">
                  <div className={`w-3 flex-shrink-0 ${checkin.checkedIn ? 'bg-secondary' : 'bg-muted'}`} />
                  
                  <div className="p-4 flex-1 flex flex-col justify-between">
                    <div>
                      <div className="flex justify-between items-start mb-2">
                        <h3 className="font-heading font-bold text-2xl uppercase">{checkin.riderName}</h3>
                        <span className="font-mono font-bold text-xl bg-muted px-2 py-1 rounded">
                          {checkin.bibNumber || "-"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-sm font-medium mb-4">
                        <span className="bg-primary/10 text-primary px-2 py-0.5 rounded uppercase tracking-wider">{checkin.raceClass}</span>
                        {checkin.rfidLinked ? (
                          <span className="flex items-center gap-1 text-sidebar-primary/80"><Tag size={14}/> RFID Linked</span>
                        ) : (
                          <span className="flex items-center gap-1 text-destructive"><Tag size={14}/> No RFID</span>
                        )}
                      </div>
                    </div>
                    
                    <Button 
                      className={`h-16 w-full text-xl font-heading uppercase tracking-widest ${checkin.checkedIn ? 'bg-muted text-muted-foreground hover:bg-muted/80' : 'bg-primary hover:bg-primary/90'}`}
                      onClick={() => handleCheckin(checkin.riderId, checkin.rfidNumber)}
                      disabled={checkinMutation.isPending}
                    >
                      {checkin.checkedIn ? (
                        <span className="flex items-center gap-2"><CheckCircle size={24}/> Checked In</span>
                      ) : (
                        "Check In"
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            
            {filteredCheckins.length === 0 && (
              <div className="col-span-full py-16 text-center text-muted-foreground">
                <Search size={48} className="mx-auto mb-4 opacity-20" />
                <p className="text-xl font-medium">No riders found matching criteria.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
