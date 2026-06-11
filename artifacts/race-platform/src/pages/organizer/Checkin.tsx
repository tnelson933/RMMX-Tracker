import { useState, useRef, useEffect } from "react";
import { useParams } from "wouter";
import { useGetEvent, useListCheckins, useGetRaceDaySummary, useCheckinRider, useAssignRfid, useUpdateRegistration } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Search, CheckCircle, Tag, X, AlertCircle, Clock, RefreshCw } from "lucide-react";
import { useOfflineAwareQuery } from "@/hooks/useOfflineAwareQuery";
import { useOfflineStatus } from "@/hooks/useOfflineStatus";
import { useSyncQueue } from "@/hooks/useSyncQueue";
import { CacheStatusBadge } from "@/components/CacheStatusBadge";

// MyLaps transponder numbers: purely numeric, 1–9 digits.
function isInvalidTransponder(val: string | null | undefined): boolean {
  if (!val || !val.trim()) return false;
  return !/^\d{1,9}$/.test(val.trim());
}

// RFID tags: alphanumeric + dashes, 1–32 characters.
function isInvalidRfid(val: string | null | undefined): boolean {
  if (!val || !val.trim()) return false;
  return !/^[A-Za-z0-9\-]{1,32}$/.test(val.trim());
}
import { getListCheckinsQueryKey, getGetRaceDaySummaryQueryKey, getListRegistrationsQueryKey, getListRidersQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

function RfidInput({ riderId, eventId, onDone, isMylaps, currentTag }: { riderId: number; eventId: number; onDone: () => void; isMylaps?: boolean; currentTag?: string }) {
  const [value, setValue] = useState(currentTag ?? "");
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
        queryClient.invalidateQueries({ queryKey: getListRidersQueryKey() });
        toast({ title: isMylaps ? "Transponder assigned" : "RFID tag assigned" });
        onDone();
      },
      onError: (err) => {
        toast({ title: isMylaps ? "Failed to assign transponder" : "Failed to assign RFID", description: err.message, variant: "destructive" });
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
        placeholder={isMylaps ? "Enter transponder number…" : "Scan or type RFID tag…"}
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
  isPendingSync,
  isBibDuplicate,
  onCheckin,
}: {
  checkin: CheckinRow;
  pending: string | undefined;
  isPending: boolean;
  isPendingSync: boolean;
  isBibDuplicate: (riderId: number, value: string) => boolean;
  onCheckin: (bibToSave?: string) => void;
}) {
  const hasDuplicate = pending !== undefined && isBibDuplicate(checkin.riderId, pending);
  const bibToSave = pending && !hasDuplicate ? pending : undefined;

  if (checkin.checkedIn) {
    return (
      <Button
        className="h-10 md:h-16 w-full text-sm md:text-xl font-heading uppercase tracking-widest mt-2 bg-muted text-muted-foreground hover:bg-muted/80"
        disabled
      >
        <span className="flex items-center gap-2">
          <CheckCircle size={24} /> Checked In
        </span>
      </Button>
    );
  }

  if (isPendingSync) {
    return (
      <Button
        className="h-10 md:h-16 w-full text-sm md:text-xl font-heading uppercase tracking-widest mt-2 bg-amber-500/80 text-white cursor-default hover:bg-amber-500/80"
        disabled
      >
        <span className="flex items-center gap-2">
          <Clock size={18} /> Pending Sync
        </span>
      </Button>
    );
  }

  return (
    <Button
      className={`h-10 md:h-16 w-full text-sm md:text-xl font-heading uppercase tracking-widest mt-2 ${
        hasDuplicate
          ? "bg-red-500/80 text-white cursor-not-allowed"
          : "bg-primary hover:bg-primary/90"
      }`}
      onClick={() => !hasDuplicate && onCheckin(bibToSave)}
      disabled={isPending || hasDuplicate}
    >
      Check In
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
  const isMylaps = ((event as any)?.timingTechnology ?? "rfid") === "mylaps";
  const { data: rawCheckins, isLoading: checkinsLoading, isError: checkinsError } = useListCheckins(eventId, {
    query: { enabled: !!eventId, refetchInterval: 30000 } as any
  });
  const { data: checkins, isLoading: checkinsOfflineLoading, isFromCache: checkinsFromCache, cachedAt: checkinsCachedAt } =
    useOfflineAwareQuery(`checkins/${eventId}`, rawCheckins, checkinsLoading, checkinsError);
  const { data: summary } = useGetRaceDaySummary(eventId, {
    query: { enabled: !!eventId, refetchInterval: 30000 } as any
  });

  const { isOffline } = useOfflineStatus();
  const { pendingRiderIds, pendingCount, isSyncing, syncError, queueCheckin } = useSyncQueue(eventId);

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
    if (isOffline) {
      if (pendingRiderIds.has(riderId)) return; // guard double-tap before async refresh completes
      void queueCheckin(riderId, currentRfid ?? null, bibOverride || null);
      toast({ title: "Check-in saved offline", description: "Will sync automatically when connection returns." });
      return;
    }
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
        const bib = (c.bibNumber ?? "").toLowerCase();
        const email = (c.email ?? "").toLowerCase();
        const phone = (c.phone ?? "").replace(/\D/g, "");
        const transponder = (c.myLapsTransponderNumber ?? "").toLowerCase();
        const rfid = (c.rfidNumber ?? "").toLowerCase();
        const qDigits = q.replace(/\D/g, "");
        return (
          name.includes(q) ||
          bib.includes(q) ||
          email.includes(q) ||
          (qDigits.length >= 3 && phone.includes(qDigits)) ||
          transponder.includes(q) ||
          rfid.includes(q)
        );
      })
    : statusFiltered;

  const filteredCheckins = q
    ? [...searchFiltered].sort((a, b) => {
        const rank = (c: typeof a) => {
          const name = c.riderName.toLowerCase();
          const bib = (c.bibNumber ?? "").toLowerCase();
          const email = (c.email ?? "").toLowerCase();
          const transponder = (c.myLapsTransponderNumber ?? "").toLowerCase();
          const rfid = (c.rfidNumber ?? "").toLowerCase();
          if (name === q) return 0;
          if (bib === q) return 1;
          if (name.startsWith(q)) return 2;
          if (name.split(/\s+/).some(w => w.startsWith(q))) return 3;
          if (name.includes(q)) return 4;
          if (bib.includes(q) || rfid.includes(q) || transponder.includes(q)) return 5;
          if (email.includes(q)) return 6;
          return 7;
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

  if (eventLoading || checkinsOfflineLoading) return <div className="p-8">Loading...</div>;

  return (
    <div className="bg-gray-50 min-h-full">
      <div className="bg-sidebar text-sidebar-foreground px-4 py-4 md:p-6 flex flex-col gap-3">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-xl md:text-3xl font-heading font-bold uppercase tracking-tight text-white leading-tight">{event?.name} — Check-In</h1>
            {checkinsFromCache && checkinsCachedAt && (
              <CacheStatusBadge cachedAt={checkinsCachedAt} />
            )}
          </div>
          <div className="flex gap-3 w-full md:w-auto">
            <div className="bg-sidebar-accent/50 rounded-lg px-3 py-2 border border-sidebar-border text-center flex-1 md:flex-none md:min-w-32">
              <div className="text-sidebar-foreground/60 text-[10px] font-bold uppercase tracking-widest mb-0.5">Checked In</div>
              <div className="text-xl md:text-2xl font-heading font-bold text-secondary">{summary?.checkedIn || 0} / {summary?.totalRegistered || 0}</div>
            </div>
            <div className="bg-sidebar-accent/50 rounded-lg px-3 py-2 border border-sidebar-border text-center flex-1 md:flex-none md:min-w-32">
              <div className="text-sidebar-foreground/60 text-[10px] font-bold uppercase tracking-widest mb-0.5">{isMylaps ? "Transponder" : "RFID Linked"}</div>
              <div className="text-xl md:text-2xl font-heading font-bold text-white">{summary?.rfidLinked || 0}</div>
            </div>
            {(pendingCount > 0 || isSyncing) && (
              <div className="bg-amber-500/10 rounded-lg px-3 py-2 border border-amber-500/30 text-center flex-1 md:flex-none md:min-w-32">
                <div className="text-amber-400 text-[10px] font-bold uppercase tracking-widest mb-0.5">Pending Sync</div>
                <div className="text-xl md:text-2xl font-heading font-bold text-amber-400 flex items-center justify-center gap-1.5">
                  {isSyncing ? <RefreshCw size={18} className="animate-spin" /> : <Clock size={18} />}
                  {pendingCount}
                </div>
              </div>
            )}
          </div>
        </div>
        {syncError && (
          <div className="text-xs text-red-400 flex items-center gap-1.5">
            <AlertCircle size={12} /> {syncError}
          </div>
        )}
      </div>

      <div className="p-3 md:p-6 flex flex-col gap-4">
        <div className="bg-white p-3 rounded-lg shadow-sm border flex flex-col md:flex-row gap-3 sticky top-0 z-10">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
            <Input
              value={search}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder="Search by rider name or number #..."
              className="pl-9 pr-9 h-10 text-base font-medium bg-muted/30"
            />
            {search && (
              <button
                onClick={() => handleSearchChange("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={18} />
              </button>
            )}
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-0.5 md:pb-0">
            {[
              { key: "all", label: "All" },
              { key: "not_checked_in", label: "Pending" },
              { key: "checked_in", label: "Done" },
              { key: "no_rfid", label: isMylaps ? "No Transponder" : "No RFID" },
            ].map(({ key, label }) => (
              <Button
                key={key}
                variant={statusFilter === key ? "default" : "outline"}
                size="sm"
                className="h-10 px-3 text-xs md:text-sm font-heading uppercase flex flex-col gap-0 leading-none shrink-0"
                onClick={() => setStatusFilter(key)}
              >
                <span>{label}</span>
                <span className={`text-[10px] font-mono font-bold ${statusFilter === key ? "opacity-70" : "opacity-50"}`}>
                  {filterCounts[key as keyof typeof filterCounts]}
                </span>
              </Button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredCheckins.map(checkin => {
              const tagVal = isMylaps
                ? (checkin as any).myLapsTransponderNumber as string | null
                : checkin.rfidNumber ?? null;
              const isTagInvalid = isMylaps
                ? isInvalidTransponder(tagVal)
                : isInvalidRfid(tagVal);
              return (
              <Card key={checkin.riderId} className={`overflow-hidden transition-all ${checkin.checkedIn ? 'border-secondary bg-secondary/5' : pendingRiderIds.has(checkin.riderId) ? 'border-amber-500 bg-amber-500/5' : 'hover:border-primary/50'}`}>
                <CardContent className="p-0 flex h-full">
                  {(() => {
                    // Bib is "locked" (solid, non-editable) ONLY once the rider is checked in.
                    // A registrationBib set from the Registrations tab is a pre-filled suggestion
                    // — still editable here until Check In is pressed.
                    const confirmed = checkin.checkedIn;
                    const pending = bibEdits.get(checkin.riderId);
                    // Pre-fill edit value from registration bib first, then auto-suggestion
                    const suggested = checkin.registrationBib ?? bibSuggestions.get(checkin.riderId) ?? undefined;
                    const isEditing = bibEditId === checkin.riderId;
                    const editVal = pending ?? "";
                    const duplicate = pending !== undefined ? isBibDuplicate(checkin.riderId, pending) : false;

                    // What number to display when not editing
                    const displayNum = checkin.checkedIn
                      ? (checkin.bibNumber ?? "?")
                      : (pending !== undefined ? pending : null) ?? checkin.registrationBib ?? suggested ?? "?";

                    // Text color when not editing
                    const numColor = checkin.checkedIn
                      ? "text-white"
                      : pending !== undefined
                        ? (duplicate ? "text-red-500" : "text-foreground")
                        : checkin.registrationBib
                          ? "text-foreground"     // registration bib confirmed — solid but editable
                          : "text-foreground/35"; // no bib yet — faded

                    const canEdit = !confirmed; // editable any time before check-in

                    return (
                      <div
                        className={`w-16 flex-shrink-0 flex flex-col items-center justify-center gap-0.5 ${checkin.checkedIn ? 'bg-secondary' : 'bg-muted'} ${canEdit ? 'cursor-pointer hover:brightness-95 transition-all' : ''}`}
                        onClick={() => {
                          if (!canEdit || isEditing) return;
                          setBibEditId(checkin.riderId);
                          setBibEdits(prev => {
                            const next = new Map(prev);
                            // Pre-fill with registration bib first, then auto-suggestion
                            if (!next.has(checkin.riderId)) next.set(checkin.riderId, checkin.registrationBib ?? suggested ?? "");
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
                            {(checkin.checkedIn || !!checkin.registrationBib) && (
                              <span className={`text-[9px] font-bold uppercase tracking-widest ${checkin.checkedIn ? 'text-white/70' : 'text-foreground/40'}`}>
                                BIB
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })()}

                  <div className="p-3 flex-1 flex flex-col justify-between">
                    <div>
                      <div className="flex justify-between items-start mb-1.5">
                        <h3 className="font-heading font-bold text-base md:text-2xl uppercase leading-tight">{checkin.riderName}</h3>
                      </div>
                      <div className="flex items-center gap-2 text-xs md:text-sm font-medium mb-3 flex-wrap">
                        <span className="bg-primary/10 text-primary px-2 py-0.5 rounded uppercase tracking-wider">{checkin.raceClass}</span>
                        {isTagInvalid ? (
                          <button
                            onClick={() => setRfidInputOpenId(rfidInputOpenId === checkin.riderId ? null : checkin.riderId)}
                            className="flex items-center gap-1 text-destructive hover:text-destructive/80 transition-colors"
                            title={`${isMylaps ? "Transponder" : "RFID"} number is invalid — click to fix`}
                          >
                            <AlertCircle size={14} />
                            <span className="font-mono">{tagVal}</span>
                            <span className="font-bold">— {isMylaps ? "Transponder" : "RFID"} invalid</span>
                          </button>
                        ) : checkin.rfidLinked ? (
                          <button
                            onClick={() => setRfidInputOpenId(rfidInputOpenId === checkin.riderId ? null : checkin.riderId)}
                            className="flex items-center gap-1 text-sidebar-primary/80 hover:text-primary transition-colors underline-offset-2 hover:underline"
                            title={isMylaps ? "Click to change transponder" : "Click to change RFID tag"}
                          >
                            <Tag size={14} />
                            <span className="font-mono">{tagVal}</span>
                          </button>
                        ) : (
                          <button
                            onClick={() => setRfidInputOpenId(rfidInputOpenId === checkin.riderId ? null : checkin.riderId)}
                            className="flex items-center gap-1 text-amber-600 hover:text-amber-700 transition-colors underline-offset-2 hover:underline"
                            title={isMylaps ? "Click to assign transponder" : "Click to assign RFID tag"}
                          >
                            <Tag size={14} /> {isMylaps ? "No Transponder — Assign" : "No RFID — Assign"}
                          </button>
                        )}
                      </div>

                      {/* Inline RFID assignment — available whether or not one is already linked */}
                      {rfidInputOpenId === checkin.riderId && (
                        <RfidInput
                          riderId={checkin.riderId}
                          eventId={eventId}
                          onDone={() => setRfidInputOpenId(null)}
                          isMylaps={isMylaps}
                          currentTag={checkin.rfidNumber ?? undefined}
                        />
                      )}
                    </div>

                    <CheckinButton
                      checkin={checkin}
                      pending={bibEdits.get(checkin.riderId)}
                      isPending={checkinMutation.isPending}
                      isPendingSync={pendingRiderIds.has(checkin.riderId)}
                      isBibDuplicate={isBibDuplicate}
                      onCheckin={(bibToSave) => {
                        if (isTagInvalid) {
                          toast({
                            title: isMylaps ? "Transponder invalid" : "RFID invalid",
                            description: `Please assign a valid ${isMylaps ? "transponder" : "RFID"} number before checking in.`,
                            variant: "destructive",
                          });
                          setRfidInputOpenId(checkin.riderId);
                          return;
                        }
                        handleCheckin(checkin.riderId, checkin.rfidNumber, bibToSave);
                      }}
                    />
                  </div>
                </CardContent>
              </Card>
              );
            })}

            {filteredCheckins.length === 0 && (
              <div className="col-span-full py-12 text-center text-muted-foreground">
                <Search size={40} className="mx-auto mb-3 opacity-20" />
                <p className="text-base font-medium">No riders found matching criteria.</p>
              </div>
            )}
          </div>
        </div>
    </div>
  );
}
