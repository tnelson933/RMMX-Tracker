import { useState, useRef, useEffect } from "react";
import { useParams } from "wouter";
import { useGetEvent, useListCheckins, useGetRaceDaySummary, useCheckinRider, useAssignRfid, useUpdateRegistration } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Search, CheckCircle, Tag, X } from "lucide-react";
import { getListCheckinsQueryKey, getGetRaceDaySummaryQueryKey, getListRegistrationsQueryKey } from "@workspace/api-client-react";
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

type CheckinRow = { checkedIn: boolean; riderId: number; rfidNumber?: string | null };

function CheckinButton({
  checkin,
  pending,
  isPending,
  isBibDuplicate,
  onCheckin,
}: {
  checkin: CheckinRow;
  pending: string | undefined;
  isPending: boolean;
  isBibDuplicate: (riderId: number, value: string) => boolean;
  onCheckin: (bibToSave?: string) => void;
}) {
  const hasDuplicate = pending !== undefined && isBibDuplicate(checkin.riderId, pending);
  const bibToSave = pending && !hasDuplicate ? pending : undefined;
  return (
    <Button
      className={`h-16 w-full text-xl font-heading uppercase tracking-widest mt-3 ${
        checkin.checkedIn
          ? "bg-muted text-muted-foreground hover:bg-muted/80"
          : hasDuplicate
          ? "bg-red-500/80 text-white cursor-not-allowed"
          : "bg-primary hover:bg-primary/90"
      }`}
      onClick={() => !hasDuplicate && onCheckin(bibToSave)}
      disabled={isPending || hasDuplicate}
    >
      {checkin.checkedIn ? (
        <span className="flex items-center gap-2">
          <CheckCircle size={24} /> Checked In
        </span>
      ) : (
        "Check In"
      )}
    </Button>
  );
}

export default function Checkin() {
  const params = useParams();
  const eventId = parseInt(params.eventId || "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [rfidInputOpenId, setRfidInputOpenId] = useState<number | null>(null);
  const [bibEditId, setBibEditId] = useState<number | null>(null);
  const [bibEdits, setBibEdits] = useState<Map<number, string>>(new Map());

  // Close any open RFID panel when the search changes so it can't steal focus
  const handleSearchChange = (value: string) => {
    setSearch(value);
    setRfidInputOpenId(null);
  };

  const { data: event, isLoading: eventLoading } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const { data: checkins, isLoading: checkinsLoading } = useListCheckins(eventId, {
    query: { enabled: !!eventId, refetchInterval: 30000 } as any
  });
  const { data: summary } = useGetRaceDaySummary(eventId, {
    query: { enabled: !!eventId, refetchInterval: 30000 } as any
  });

  const checkinMutation = useCheckinRider();
  const saveBibMutation = useUpdateRegistration();

  const handleSaveBib = (registrationId: number | null | undefined, bib: string) => {
    if (!registrationId || !bib.trim()) return;
    saveBibMutation.mutate({ registrationId, data: { bibNumber: bib.trim() } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListRegistrationsQueryKey(eventId) });
        queryClient.invalidateQueries({ queryKey: getListCheckinsQueryKey(eventId) });
      },
    });
  };

  const handleCheckin = (riderId: number, currentRfid?: string | null, bibOverride?: string) => {
    checkinMutation.mutate({ eventId, data: { riderId, rfidNumber: currentRfid || undefined, bibNumber: bibOverride || undefined } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCheckinsQueryKey(eventId) });
        queryClient.invalidateQueries({ queryKey: getGetRaceDaySummaryQueryKey(eventId) });
        queryClient.invalidateQueries({ queryKey: getListRegistrationsQueryKey(eventId) });
        toast({ title: "Check-in successful" });
      },
      onError: (err) => {
        toast({ title: "Check-in failed", description: err.message, variant: "destructive" });
      }
    });
  };

  // Mirror the same suggestion logic as Registrations page
  const bibSuggestions = (() => {
    const all = checkins ?? [];
    const confirmedBibs = new Set<number>(
      all.map(c => c.bibNumber ? parseInt(c.bibNumber, 10) : NaN).filter(n => !isNaN(n))
    );
    const suggestions = new Map<number, string>();
    const used = new Set(confirmedBibs);
    for (const c of all) {
      if (!c.bibNumber) {
        let candidate = 1;
        while (used.has(candidate)) candidate++;
        suggestions.set(c.riderId, String(candidate));
        used.add(candidate);
      }
    }
    return suggestions;
  })();

  const allCheckins = checkins ?? [];

  const filterCounts = {
    all: allCheckins.length,
    not_checked_in: allCheckins.filter(c => !c.checkedIn).length,
    checked_in: allCheckins.filter(c => c.checkedIn === true).length,
    no_rfid: allCheckins.filter(c => !c.rfidLinked).length,
  };

  const q = search.trim().toLowerCase();

  const statusFiltered = allCheckins.filter(c => {
    if (statusFilter === "checked_in") return c.checkedIn === true;
    if (statusFilter === "not_checked_in") return c.checkedIn !== true;
    if (statusFilter === "no_rfid") return c.rfidLinked !== true;
    return true;
  });

  const searchFiltered = q
    ? statusFiltered.filter(c => {
        const name = c.riderName.toLowerCase();
        const bib = c.bibNumber ?? "";
        return name.includes(q) || bib.includes(q);
      })
    : statusFiltered;

  const filteredCheckins = q
    ? [...searchFiltered].sort((a, b) => {
        const rank = (c: typeof a) => {
          const name = c.riderName.toLowerCase();
          const bib = c.bibNumber ?? "";
          if (name === q) return 0;
          if (bib === q) return 1;
          if (name.startsWith(q)) return 2;
          if (name.split(/\s+/).some(w => w.startsWith(q))) return 3;
          if (name.includes(q)) return 4;
          return 5;
        };
        return rank(a) - rank(b);
      })
    : searchFiltered;

  // Only bibs confirmed in the REGISTRATION table count as truly taken
  const isBibDuplicate = (riderId: number, value: string) => {
    const v = value.trim();
    if (!v) return false;
    return allCheckins.some(c => c.riderId !== riderId && c.registrationBib != null && String(c.registrationBib) === v);
  };

  if (eventLoading || checkinsLoading) return <div className="p-8">Loading...</div>;

  return (
    <div className="flex flex-col min-h-0 h-full bg-gray-50">
      <div className="bg-sidebar text-sidebar-foreground p-6 flex flex-col md:flex-row justify-between items-center gap-4 flex-shrink-0">
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

      <div className="p-6 flex-1 flex flex-col gap-6 min-h-0">
        <div className="bg-white p-4 rounded-lg shadow-sm border flex flex-col md:flex-row gap-4 sticky top-0 z-10 flex-shrink-0">
          <div className="relative flex-1">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" size={24} />
            <Input
              value={search}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder="Search by rider name or bib #..."
              className="pl-12 pr-12 h-14 text-xl font-medium bg-muted/30"
            />
            {search && (
              <button
                onClick={() => handleSearchChange("")}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={22} />
              </button>
            )}
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
                variant={statusFilter === key ? "default" : "outline"}
                className="h-14 px-5 text-base font-heading uppercase flex flex-col gap-0 leading-none"
                onClick={() => setStatusFilter(key)}
              >
                <span>{label}</span>
                <span className={`text-xs font-mono font-bold mt-0.5 ${statusFilter === key ? "opacity-70" : "opacity-50"}`}>
                  {filterCounts[key as keyof typeof filterCounts]}
                </span>
              </Button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredCheckins.map(checkin => (
              <Card key={checkin.riderId} className={`overflow-hidden transition-all ${checkin.checkedIn ? 'border-secondary bg-secondary/5' : 'hover:border-primary/50'}`}>
                <CardContent className="p-0 flex h-full">
                  {(() => {
                    // confirmed = bib locked in the REGISTRATION table (solid, non-editable)
                    // bibNumber = merged display value (registration ?? checkin fallback)
                    const confirmed = checkin.registrationBib;
                    const pending = bibEdits.get(checkin.riderId);
                    const suggested = bibSuggestions.get(checkin.riderId) ?? checkin.bibNumber ?? undefined;
                    const isEditing = bibEditId === checkin.riderId;
                    const editVal = pending ?? "";
                    const duplicate = pending !== undefined ? isBibDuplicate(checkin.riderId, pending) : false;

                    // What number to display when not editing
                    const displayNum = confirmed ?? (pending !== undefined ? pending : null) ?? suggested ?? "?";

                    // Text color when not editing
                    const numColor = checkin.checkedIn
                      ? "text-white"
                      : confirmed
                        ? "text-foreground"
                        : pending !== undefined
                          ? duplicate ? "text-red-500" : "text-foreground"
                          : "text-foreground/35";

                    const canEdit = !confirmed && !checkin.checkedIn;

                    return (
                      <div
                        className={`w-16 flex-shrink-0 flex flex-col items-center justify-center gap-0.5 ${checkin.checkedIn ? 'bg-secondary' : 'bg-muted'} ${canEdit ? 'cursor-pointer hover:brightness-95 transition-all' : ''}`}
                        onClick={() => {
                          if (!canEdit || isEditing) return;
                          setBibEditId(checkin.riderId);
                          setBibEdits(prev => {
                            const next = new Map(prev);
                            if (!next.has(checkin.riderId)) next.set(checkin.riderId, suggested ?? "");
                            return next;
                          });
                        }}
                        title={canEdit ? "Click to set bib number" : undefined}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            value={editVal}
                            onChange={e => {
                              const v = e.target.value.replace(/\D/g, "").slice(0, 4);
                              setBibEdits(prev => { const n = new Map(prev); n.set(checkin.riderId, v); return n; });
                            }}
                            onKeyDown={e => {
                              if (e.key === "Enter") {
                                setBibEditId(null);
                                const v = editVal.trim();
                                if (v && !duplicate) handleSaveBib(checkin.registrationId, v);
                              }
                              if (e.key === "Escape") {
                                setBibEditId(null);
                                setBibEdits(prev => { const n = new Map(prev); n.delete(checkin.riderId); return n; });
                              }
                            }}
                            onBlur={() => {
                              setBibEditId(null);
                              const v = editVal.trim();
                              if (v && !duplicate) handleSaveBib(checkin.registrationId, v);
                            }}
                            className={`w-12 bg-transparent text-center font-heading font-black text-xl leading-none outline-none border-b-2 ${duplicate ? 'text-red-500 border-red-400' : 'text-foreground border-primary'}`}
                            style={{ appearance: "none" }}
                            inputMode="numeric"
                            placeholder="—"
                          />
                        ) : (
                          <>
                            <span className={`font-heading font-black text-2xl leading-none ${numColor}`}>
                              {displayNum}
                            </span>
                            {(confirmed || checkin.checkedIn) && (
                              <span className={`text-[9px] font-bold uppercase tracking-widest ${checkin.checkedIn ? 'text-white/70' : 'text-foreground/40'}`}>
                                BIB
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })()}

                  <div className="p-4 flex-1 flex flex-col justify-between">
                    <div>
                      <div className="flex justify-between items-start mb-2">
                        <h3 className="font-heading font-bold text-2xl uppercase">{checkin.riderName}</h3>
                      </div>
                      <div className="flex items-center gap-2 text-sm font-medium mb-4">
                        <span className="bg-primary/10 text-primary px-2 py-0.5 rounded uppercase tracking-wider">{checkin.raceClass}</span>
                        {checkin.rfidLinked ? (
                          <span className="flex items-center gap-1 text-sidebar-primary/80">
                            <Tag size={14} /> RFID Linked
                          </span>
                        ) : (
                          <button
                            onClick={() => setRfidInputOpenId(rfidInputOpenId === checkin.riderId ? null : checkin.riderId)}
                            className="flex items-center gap-1 text-amber-600 hover:text-amber-700 transition-colors underline-offset-2 hover:underline"
                            title="Click to assign RFID tag"
                          >
                            <Tag size={14} /> No RFID — Assign
                          </button>
                        )}
                      </div>

                      {/* Inline RFID assignment */}
                      {rfidInputOpenId === checkin.riderId && !checkin.rfidLinked && (
                        <RfidInput
                          riderId={checkin.riderId}
                          eventId={eventId}
                          onDone={() => setRfidInputOpenId(null)}
                        />
                      )}
                    </div>

                    <CheckinButton
                      checkin={checkin}
                      pending={bibEdits.get(checkin.riderId)}
                      isPending={checkinMutation.isPending}
                      isBibDuplicate={isBibDuplicate}
                      onCheckin={(bibToSave) => handleCheckin(checkin.riderId, checkin.rfidNumber, bibToSave)}
                    />
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
