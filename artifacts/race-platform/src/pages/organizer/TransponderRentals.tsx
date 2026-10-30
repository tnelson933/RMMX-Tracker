import { useState, useCallback } from "react";
import { useRoute } from "wouter";
import { useGetEvent } from "@workspace/api-client-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Search, CheckCircle2, Clock, RefreshCw, Radio, Bell } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { RemindAllPanel, RenterDialog, ReminderMark, type ReminderStatus } from "@/components/organizer/RentalReminders";

interface RentalRow {
  registrationId: number;
  riderId: number;
  riderName: string;
  bibNumber: string | null;
  transponderNumber: string | null;
  transponderReturned: boolean;
  raceClass: string;
  hasPushToken: boolean;
  // Not sent by the desktop app's offline server.
  notifyBlockedReason?: string | null;
  reminderStatus?: ReminderStatus | null;
  reminderMessage?: string | null;
}

export default function TransponderRentals() {
  const [, params] = useRoute("/events/:eventId/transponder-rentals");
  const eventId = parseInt(params?.eventId || "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  // The rental whose renter panel is open.
  const [openRental, setOpenRental] = useState<number | null>(null);

  const { data: event } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });

  const queryKey = ["transponder-rentals", eventId];

  const { data: rentals = [], isLoading, refetch, isFetching } = useQuery<RentalRow[]>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/transponder-rentals`);
      if (!res.ok) throw new Error("Couldn't load transponder rentals");
      return res.json();
    },
    enabled: !!eventId,
    staleTime: 10_000,
  });

  const returnMutation = useMutation({
    mutationFn: async ({ regId, returned }: { regId: number; returned: boolean }) => {
      const res = await fetch(`/api/events/${eventId}/registrations/${regId}/transponder-returned`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returned }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Update failed");
      }
      return res.json();
    },
    onMutate: async ({ regId, returned }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<RentalRow[]>(queryKey);
      queryClient.setQueryData<RentalRow[]>(queryKey, old =>
        old?.map(r => r.registrationId === regId ? { ...r, transponderReturned: returned } : r) ?? []
      );
      return { previous };
    },
    onError: (err: any, _vars, ctx) => {
      queryClient.setQueryData(queryKey, ctx?.previous);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
    onSuccess: (_data, { returned, regId }) => {
      const row = rentals.find(r => r.registrationId === regId);
      toast({
        title: returned ? "Transponder returned" : "Marked as not returned",
        description: row?.riderName ?? "",
      });
    },
  });

  const q = search.trim().toLowerCase();
  const filtered = rentals.filter(r => {
    if (!q) return true;
    return (
      r.riderName.toLowerCase().includes(q) ||
      (r.bibNumber ?? "").toLowerCase().includes(q) ||
      (r.transponderNumber ?? "").toLowerCase().includes(q)
    );
  });

  const totalRented = rentals.length;
  const totalReturned = rentals.filter(r => r.transponderReturned).length;
  const totalOut = totalRented - totalReturned;
  // Riders holding a transponder: a unit was handed out and not returned.
  const holdingCount = rentals.filter(r => !r.transponderReturned && r.transponderNumber).length;

  const handleToggle = useCallback((row: RentalRow) => {
    returnMutation.mutate({ regId: row.registrationId, returned: !row.transponderReturned });
  }, [returnMutation]);

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">Loading...</div>;

  return (
    <div className="bg-gray-50 min-h-full">
      {/* Header */}
      <div className="bg-white border-b px-4 md:px-8 py-4 md:py-5 flex flex-col md:flex-row md:items-center gap-3">
        <div className="flex-1">
          <h2 className="text-lg md:text-xl font-heading font-bold uppercase tracking-tight">
            Transponder Rentals
          </h2>
          {event?.transponderRentalFee && (
            <p className="text-sm text-muted-foreground mt-0.5">
              ${Number(event.transponderRentalFee).toFixed(2)} / rental — track who still needs to return their transponder
            </p>
          )}
        </div>

        {/* Summary pills + actions */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 bg-blue-50 border border-blue-200 text-blue-700 px-3 py-1.5 rounded-full text-xs font-semibold">
            <Radio size={13} /> {totalRented} Rented
          </div>
          <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 text-amber-700 px-3 py-1.5 rounded-full text-xs font-semibold">
            <Clock size={13} /> {totalOut} Still Out
          </div>
          <div className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 text-emerald-700 px-3 py-1.5 rounded-full text-xs font-semibold">
            <CheckCircle2 size={13} /> {totalReturned} Returned
          </div>

          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="p-1.5 rounded hover:bg-gray-100 text-muted-foreground transition-colors"
            title="Refresh"
          >
            <RefreshCw size={15} className={isFetching ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      <div className="px-4 md:px-8 py-4 md:py-6 max-w-4xl mx-auto">
        {/* Remind everyone still holding a transponder; shows who was reached */}
        {totalRented > 0 && (
          <div className="mb-4">
            <RemindAllPanel
              url={`/api/events/${eventId}/transponder-rentals/remind-all`}
              outCount={holdingCount}
              onDone={() => refetch()}
              onOpenRenter={r => setOpenRental(r.registrationId)}
            />
          </div>
        )}

        {/* Search */}
        <div className="relative mb-4">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search by name, bib #, or transponder #…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {totalRented === 0 ? (
          <div className="py-16 text-center text-muted-foreground">
            <Radio size={40} className="mx-auto mb-3 opacity-20" />
            <p className="font-medium">No transponder rentals yet</p>
            <p className="text-sm mt-1 opacity-70">Rentals collected during registration or check-in will appear here.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            <Search size={36} className="mx-auto mb-2 opacity-20" />
            <p className="font-medium">No riders match your search</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[1fr_80px_120px_100px_44px] gap-3 px-4 py-2.5 bg-gray-50 border-b text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <span>Rider</span>
              <span className="text-center">Bib</span>
              <span className="text-center">Transponder #</span>
              <span className="text-center">Returned</span>
              <span className="text-center" title="Push notification sent">
                <Bell size={12} className="mx-auto" />
              </span>
            </div>

            {filtered.map((row, i) => (
              <div
                key={row.registrationId}
                className={`grid grid-cols-[1fr_80px_120px_100px_44px] gap-3 items-center px-4 py-3 ${
                  i < filtered.length - 1 ? "border-b" : ""
                } ${row.transponderReturned ? "bg-emerald-50/40" : "hover:bg-gray-50"} transition-colors`}
              >
                {/* Rider name + class */}
                <div className="min-w-0">
                  <button
                    onClick={() => setOpenRental(row.registrationId)}
                    className="block max-w-full font-semibold text-sm truncate text-left text-primary underline-offset-2 hover:underline"
                    title="Contact info and return reminder"
                  >
                    {row.riderName}
                  </button>
                  <p className="text-xs text-muted-foreground truncate">{row.raceClass}</p>
                </div>

                {/* Bib */}
                <div className="text-center">
                  {row.bibNumber ? (
                    <span className="inline-block bg-primary/10 text-primary px-2 py-0.5 rounded text-xs font-bold">
                      #{row.bibNumber}
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </div>

                {/* Transponder # */}
                <div className="text-center">
                  {row.transponderNumber ? (
                    <span className="font-mono text-sm font-medium">{row.transponderNumber}</span>
                  ) : (
                    <span className="text-muted-foreground text-xs">Not assigned</span>
                  )}
                </div>

                {/* Returned checkbox */}
                <div className="flex justify-center">
                  <button
                    onClick={() => handleToggle(row)}
                    disabled={returnMutation.isPending}
                    title={row.transponderReturned ? "Mark as not returned" : "Mark as returned"}
                    className={`w-8 h-8 rounded-full border-2 flex items-center justify-center transition-all ${
                      row.transponderReturned
                        ? "bg-emerald-500 border-emerald-500 text-white"
                        : "border-gray-300 hover:border-emerald-400 bg-white"
                    }`}
                  >
                    {row.transponderReturned && <CheckCircle2 size={16} />}
                  </button>
                </div>

                {/* Last reminder: check mark sent, red X not sent */}
                <div className="flex justify-center">
                  <ReminderMark status={row.reminderStatus ?? null} message={row.reminderMessage ?? null} />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Progress bar */}
        {totalRented > 0 && (
          <div className="mt-4">
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>{totalReturned} of {totalRented} returned</span>
              <span>{totalRented > 0 ? Math.round((totalReturned / totalRented) * 100) : 0}%</span>
            </div>
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                style={{ width: `${totalRented > 0 ? (totalReturned / totalRented) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}
      </div>

      <RenterDialog
        eventId={openRental != null ? eventId : null}
        registrationId={openRental}
        onClose={() => setOpenRental(null)}
        onReminded={() => refetch()}
      />
    </div>
  );
}
