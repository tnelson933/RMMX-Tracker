import { useState, useRef, useEffect } from "react";
import { useParams } from "wouter";
import { useGetEvent, useListCheckins, useGetRaceDaySummary, useCheckinRider, useAssignRfid } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Search, CheckCircle, Tag, X } from "lucide-react";
import { getListCheckinsQueryKey, getGetRaceDaySummaryQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

function RfidInput({ riderId, eventId, onDone }: { riderId: number; eventId: number; onDone: () => void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const assignMutation = useAssignRfid();

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = () => {
    const tag = value.trim();
    if (!tag) return;
    assignMutation.mutate({ data: { riderId, rfidNumber: tag, eventId } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCheckinsQueryKey(eventId) });
        queryClient.invalidateQueries({ queryKey: getGetRaceDaySummaryQueryKey(eventId) });
        toast({ title: "RFID tag assigned" });
        onDone();
      },
      onError: (err) => {
        toast({ title: "Failed to assign RFID", description: err.message, variant: "destructive" });
      }
    });
  };

  return (
    <div className="mt-3 flex items-center gap-2 border-t pt-3">
      <Tag size={16} className="text-muted-foreground flex-shrink-0" />
      <Input
        ref={inputRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") submit(); if (e.key === "Escape") onDone(); }}
        placeholder="Scan or type RFID tag…"
        className="h-9 text-sm font-mono flex-1"
        disabled={assignMutation.isPending}
      />
      <Button size="sm" className="h-9 font-heading uppercase px-3" onClick={submit} disabled={!value.trim() || assignMutation.isPending}>
        Assign
      </Button>
      <Button size="icon" variant="ghost" className="h-9 w-9 text-muted-foreground" onClick={onDone}>
        <X size={16} />
      </Button>
    </div>
  );
}

export default function Checkin() {
  const params = useParams();
  const eventId = parseInt(params.eventId || "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [rfidInputOpenId, setRfidInputOpenId] = useState<number | null>(null);

  const { data: event, isLoading: eventLoading } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const { data: checkins, isLoading: checkinsLoading } = useListCheckins(eventId, {
    query: { enabled: !!eventId, refetchInterval: 30000 } as any
  });
  const { data: summary } = useGetRaceDaySummary(eventId, {
    query: { enabled: !!eventId, refetchInterval: 30000 } as any
  });

  const checkinMutation = useCheckinRider();

  const handleCheckin = (riderId: number, currentRfid?: string | null) => {
    checkinMutation.mutate({ eventId, data: { riderId, rfidNumber: currentRfid || undefined } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCheckinsQueryKey(eventId) });
        queryClient.invalidateQueries({ queryKey: getGetRaceDaySummaryQueryKey(eventId) });
        toast({ title: "Check-in successful" });
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
            {[
              { key: "all", label: "All" },
              { key: "not_checked_in", label: "Pending" },
              { key: "checked_in", label: "Checked In" },
              { key: "no_rfid", label: "No RFID" },
            ].map(({ key, label }) => (
              <Button
                key={key}
                variant={filter === key ? "default" : "outline"}
                className="h-14 px-6 text-lg font-heading uppercase"
                onClick={() => setFilter(key)}
              >
                {label}
              </Button>
            ))}
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
                          <span className="flex items-center gap-1 text-sidebar-primary/80">
                            <Tag size={14} /> RFID Linked
                          </span>
                        ) : (
                          <button
                            onClick={() => setRfidInputOpenId(rfidInputOpenId === checkin.id ? null : checkin.id)}
                            className="flex items-center gap-1 text-amber-600 hover:text-amber-700 transition-colors underline-offset-2 hover:underline"
                            title="Click to assign RFID tag"
                          >
                            <Tag size={14} /> No RFID — Assign
                          </button>
                        )}
                      </div>

                      {/* Inline RFID assignment */}
                      {rfidInputOpenId === checkin.id && !checkin.rfidLinked && (
                        <RfidInput
                          riderId={checkin.riderId}
                          eventId={eventId}
                          onDone={() => setRfidInputOpenId(null)}
                        />
                      )}
                    </div>

                    <Button
                      className={`h-16 w-full text-xl font-heading uppercase tracking-widest mt-3 ${checkin.checkedIn ? 'bg-muted text-muted-foreground hover:bg-muted/80' : 'bg-primary hover:bg-primary/90'}`}
                      onClick={() => handleCheckin(checkin.riderId, checkin.rfidNumber)}
                      disabled={checkinMutation.isPending}
                    >
                      {checkin.checkedIn ? (
                        <span className="flex items-center gap-2"><CheckCircle size={24} /> Checked In</span>
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
