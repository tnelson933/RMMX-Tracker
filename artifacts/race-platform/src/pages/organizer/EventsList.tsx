import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useListEvents, useCreateEvent, useListClubs, useListSeries, useUpdateSeries, useListPointsTables, getListEventsQueryKey, useListDiscountCategories } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Calendar, MapPin, Plus, ChevronRight, Info, Flag, Trash2, Upload, ImageIcon, Loader2, Sparkles, X, RefreshCw } from "lucide-react";
import { format, parseISO } from "date-fns";
import { Link, useLocation, useSearch } from "wouter";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";

const TIME_OPTIONS: string[] = [];
for (let h = 0; h < 24; h++) {
  for (let m = 0; m < 60; m += 15) {
    TIME_OPTIONS.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
}

function formatHour(t: string) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}

function DateTimePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const datePart = value ? value.split("T")[0] : "";
  const timePart = value ? (value.split("T")[1] ?? "").substring(0, 5) : "";
  const nearestTime = (() => {
    if (!timePart) return "";
    const [h, m] = timePart.split(":").map(Number);
    const rounded = Math.round((h * 60 + m) / 15) * 15;
    const rh = Math.floor(rounded / 60) % 24;
    const rm = rounded % 60;
    return `${String(rh).padStart(2, "0")}:${String(rm).padStart(2, "0")}`;
  })();

  const handleDate = (d: string) => {
    const t = nearestTime || "08:00";
    onChange(d ? `${d}T${t}` : "");
  };
  const handleTime = (t: string) => {
    onChange(datePart ? `${datePart}T${t}` : "");
  };

  return (
    <div className="flex gap-2">
      <input
        type="date"
        value={datePart}
        onChange={e => handleDate(e.target.value)}
        className="flex h-9 flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <select
        value={nearestTime || ""}
        onChange={e => handleTime(e.target.value)}
        disabled={!datePart}
        className="flex h-9 w-32 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
      >
        <option value="">Time</option>
        {TIME_OPTIONS.map(t => (
          <option key={t} value={t}>{formatHour(t)}</option>
        ))}
      </select>
    </div>
  );
}

const createEventSchema = z.object({
  name: z.string().min(1, "Name is required"),
  date: z.string().min(1, "Date is required"),
  multiDay: z.boolean().default(false),
  endDate: z.string().optional(),
  state: z.string().min(1, "State is required"),
  location: z.string().optional(),
  trackName: z.string().optional(),
  timingTechnology: z.enum(["rfid", "mylaps"]).default("rfid"),
  raceClasses: z.array(z.object({
    name: z.string().min(1, "Class name is required"),
    maxRiders: z.coerce.number().int().min(1).optional().or(z.literal("")),
  })),
  clubId: z.number({ invalid_type_error: "Club is required" }).min(1, "Club is required"),
  registrationOpen: z.string().optional(),
  registrationClose: z.string().optional(),
  paymentEnabled: z.boolean().default(false),
  requireAma: z.boolean().default(false),
  requireClubId: z.boolean().default(false),
  noDuplicateBibs: z.boolean().default(false),
  scoringTableId: z.number().optional(),
  entryFee: z.string().optional(),
  transponderRentalEnabled: z.boolean().default(false),
  transponderRentalFee: z.string().optional(),
  purchaseOptions: z.array(z.object({
    name: z.string().min(1, "Name required"),
    amount: z.string().min(1, "Amount required"),
    categoryId: z.number().nullable().optional(),
  })).default([]),
  amaEventId: z.string().optional(),
}).refine(
  (data) => !data.multiDay || !data.endDate || data.endDate >= data.date,
  { message: "End date must be on or after start date", path: ["endDate"] },
);

export default function EventsList() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const sessionClubId = user?.clubId ?? null;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [filter, setFilter] = useState("upcoming");
  const [createSeriesId, setCreateSeriesId] = useState<string>("none");
  const [pendingImageFile, setPendingImageFile] = useState<File | null>(null);
  const [createImgState, setCreateImgState] = useState<"idle" | "processing" | "uploading" | "done">("idle");
  const [removeBgOnCreate, setRemoveBgOnCreate] = useState(false);

  // Super admin sees all events; club organizer sees only their club's events
  const eventsQuery = isSuperAdmin
    ? useListEvents({})
    : useListEvents({ clubId: sessionClubId ?? undefined }, { query: { enabled: !!sessionClubId } as any });
  const { data: events, isLoading } = eventsQuery;

  // Clubs list for the super_admin club selector
  const { data: clubs } = useListClubs({ query: { enabled: isSuperAdmin } as any });

  const isDesktop = typeof (window as any).electronAPI !== "undefined";
  const [isSyncing, setIsSyncing] = useState(false);
  const [, setLocation] = useLocation();

  async function handleSyncFromCloud() {
    setIsSyncing(true);
    try {
      const api = (window as any).electronAPI;
      if (isDesktop && api?.sync?.flush) {
        // Desktop: trigger the real SyncEngine pull (cloud → local SQLite).
        // The broken /api/admin/sync/pull endpoint always returns 503 on desktop
        // because AUTO_SYNC_ENABLED=false (CLUB_ID is never passed to the local
        // server process — that would create two competing sync loops).
        const syncState = await api.sync.getState?.();
        if (syncState && !syncState.cloudUrl) {
          throw new Error("Cloud sync not configured. Open Cloud Sync Settings from the app menu.");
        }
        await api.sync.flush();
        // Invalidate everything — a full pull refreshes events, registrations, riders, motos, etc.
        queryClient.invalidateQueries();
        toast({ title: "Synced from cloud", description: "All data pulled from your cloud account." });
      } else {
        const res = await fetch("/api/admin/sync/pull", {
          method: "POST",
          credentials: "include",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Sync failed");
        queryClient.invalidateQueries({ queryKey: getListEventsQueryKey() });
        queryClient.invalidateQueries({ queryKey: ["stripe-connect-status"] });
        toast({ title: "Synced from cloud", description: "Events and data are up to date." });
      }
    } catch (err: any) {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    } finally {
      setIsSyncing(false);
    }
  }

  const search = useSearch();

  // Auto-open create dialog when navigated here with ?create=true.
  // Depends on `search` so it re-fires even when the component is already mounted
  // (e.g. clicking "New Event" from Dashboard while already on the Events page).
  useEffect(() => {
    if (new URLSearchParams(search).get("create") === "true") {
      setIsCreateOpen(true);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [search]);

  // Check Stripe Connect status — works on both cloud and local server
  const { data: stripeStatus } = useQuery({
    queryKey: ["stripe-connect-status"],
    queryFn: async () => {
      const res = await fetch("/api/stripe/connect/status", { credentials: "include" });
      if (!res.ok) return { connected: false, onboardingComplete: false, accountId: null };
      return res.json() as Promise<{ connected: boolean; onboardingComplete: boolean; accountId: string | null }>;
    },
    enabled: !isSuperAdmin,
  });

  const stripeReady = !isSuperAdmin && (stripeStatus?.connected ?? false);

  const { data: seriesList } = useListSeries({ query: {} as any });
  const updateSeriesMutation = useUpdateSeries();
  const clubSeriesList = seriesList?.filter(s => s.clubId === (sessionClubId ?? 0)) ?? [];

  const createMutation = useCreateEvent();
  const { data: pointsTables } = useListPointsTables({ query: {} as any });
  const { data: discountCategories = [] } = useListDiscountCategories({ query: {} as any });


  const form = useForm<z.infer<typeof createEventSchema>>({
    resolver: zodResolver(createEventSchema),
    defaultValues: {
      name: "",
      date: format(new Date(), "yyyy-MM-dd"),
      multiDay: false,
      endDate: "",
      state: "",
      location: "",
      trackName: "",
      timingTechnology: "rfid",
      raceClasses: [],
      clubId: sessionClubId ?? undefined,
      registrationOpen: "",
      registrationClose: "",
      paymentEnabled: false,
      requireAma: false,
      requireClubId: false,
      noDuplicateBibs: false,
      scoringTableId: undefined,
      entryFee: "",
      transponderRentalEnabled: false,
      transponderRentalFee: "",
      purchaseOptions: [],
      amaEventId: "",
    }
  });

  const watchMultiDay = form.watch("multiDay");

  const { fields, append, remove } = useFieldArray({ control: form.control, name: "raceClasses" });
  const { fields: purchaseOptionFields, append: appendPurchaseOption, remove: removePurchaseOption } = useFieldArray({ control: form.control, name: "purchaseOptions" });

  const watchPaymentEnabled = form.watch("paymentEnabled");
  const watchTimingTechnology = form.watch("timingTechnology");
  const watchTransponderRentalEnabled = form.watch("transponderRentalEnabled");
  const watchScoringTableId = form.watch("scoringTableId");
  const filteredSeriesList = clubSeriesList.filter(s =>
    !s.scoringTableId || !watchScoringTableId || s.scoringTableId === watchScoringTableId
  );

  const onSubmit = async (data: z.infer<typeof createEventSchema>) => {
    let newEvent: Awaited<ReturnType<typeof createMutation.mutateAsync>>;
    try {
      newEvent = await createMutation.mutateAsync({
        data: {
          clubId: data.clubId,
          name: data.name,
          date: data.date,
          endDate: data.multiDay && data.endDate ? data.endDate : null,
          state: data.state,
          location: data.location,
          trackName: data.trackName,
          timingTechnology: data.timingTechnology,
          raceClasses: data.raceClasses.map(r => r.name.trim()).filter(Boolean),
          registrationOpen: data.registrationOpen ? new Date(data.registrationOpen).toISOString() : undefined,
          registrationClose: data.registrationClose ? new Date(data.registrationClose).toISOString() : undefined,
          paymentEnabled: data.paymentEnabled,
          requireAma: data.requireAma,
          requireClubId: data.requireClubId,
          noDuplicateBibs: data.noDuplicateBibs,
          scoringTableId: data.scoringTableId ?? null,
          entryFee: data.paymentEnabled && data.entryFee ? Number(data.entryFee) : undefined,
          transponderRentalEnabled: data.timingTechnology === "mylaps" && data.paymentEnabled ? data.transponderRentalEnabled : false,
          transponderRentalFee: data.timingTechnology === "mylaps" && data.paymentEnabled && data.transponderRentalEnabled && data.transponderRentalFee ? Number(data.transponderRentalFee) : undefined,
          purchaseOptions: data.purchaseOptions.map(o => ({ id: crypto.randomUUID(), name: o.name.trim(), amount: Number(o.amount), categoryId: o.categoryId ?? null })),
          amaEventId: data.amaEventId || undefined,
        },
      } as any);
    } catch (err: any) {
      toast({ title: "Failed to create event", description: err.message, variant: "destructive" });
      return;
    }

    // Link to series if selected
    if (createSeriesId !== "none") {
      const targetSeries = seriesList?.find(s => s.id === Number(createSeriesId));
      if (targetSeries) {
        const currentIds = (targetSeries.eventIds as number[]) ?? [];
        updateSeriesMutation.mutate({
          seriesId: targetSeries.id,
          data: { eventIds: [...currentIds, newEvent.id] },
        });
      }
    }

    // Upload image if one was selected
    if (pendingImageFile) {
      try {
        setCreateImgState("processing");
        let cleanBlob: Blob = pendingImageFile;
        if (removeBgOnCreate) {
          const { removeBackground } = await import("@imgly/background-removal");
          cleanBlob = await removeBackground(pendingImageFile);
        }
        setCreateImgState("uploading");
        if (isDesktop) {
          // Desktop: direct binary upload (local server saves to .uploads/, syncs to cloud on next cycle)
          const uploadRes = await fetch("/api/storage/uploads/file", {
            method: "POST",
            headers: {
              "Content-Type": "image/png",
              "x-file-name": `event-${newEvent.id}-image.png`,
              "x-content-type": "image/png",
            },
            credentials: "include",
            body: cleanBlob,
          });
          if (!uploadRes.ok) throw new Error("Upload failed");
          const { objectPath } = await uploadRes.json() as { objectPath: string };
          await fetch(`/api/events/${newEvent.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ imageUrl: `/api/storage${objectPath}` }),
          });
        } else {
          // Cloud: presigned URL flow via object storage
          const ext = "png";
          const uploadRes = await fetch("/api/storage/uploads/request-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: `event-${newEvent.id}-image.${ext}`, size: cleanBlob.size, contentType: "image/png" }),
          });
          if (!uploadRes.ok) throw new Error("Failed to get upload URL");
          const { uploadURL, objectPath } = await uploadRes.json() as { uploadURL: string; objectPath: string };
          await fetch(uploadURL, { method: "PUT", body: cleanBlob, headers: { "Content-Type": "image/png" } });
          const imageUrl = `/api/storage${objectPath}`;
          await fetch(`/api/events/${newEvent.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ imageUrl }),
          });
        }
        setCreateImgState("done");
      } catch {
        toast({ title: "Event created, but image upload failed", variant: "destructive" });
      }
    }

    queryClient.invalidateQueries({ queryKey: getListEventsQueryKey() });
    setIsCreateOpen(false);
    setCreateSeriesId("none");
    setPendingImageFile(null);
    setCreateImgState("idle");
    setRemoveBgOnCreate(false);
    form.reset();
    toast({ title: "Event created successfully" });
    setLocation(`/events/${newEvent.id}`);
  };

  const todayStr = format(new Date(), "yyyy-MM-dd");
  const filteredEvents = (() => {
    const all = events ?? [];
    if (filter === "upcoming") {
      return [...all]
        .filter(e => e.status !== "completed")
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, 10);
    }
    return all.filter(e => {
      if (filter === "all") return true;
      if (filter === "draft") return e.status === "draft";
      if (filter === "registration_open") return e.status === "registration_open";
      if (filter === "race_day") return e.status === "race_day" || e.date.substring(0, 10) === todayStr;
      if (filter === "completed") return e.status === "completed";
      return true;
    });
  })();

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight">Events</h1>
          <p className="text-muted-foreground mt-1">Manage your club's race events.</p>
        </div>
        
        <div className="flex items-center gap-2">
          {isDesktop && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleSyncFromCloud}
              disabled={isSyncing}
              className="font-heading uppercase tracking-wider"
            >
              {isSyncing ? (
                <><Loader2 size={14} className="mr-1.5 animate-spin" /> Syncing...</>
              ) : (
                <><RefreshCw size={14} className="mr-1.5" /> Sync from Cloud</>
              )}
            </Button>
          )}
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="font-heading uppercase tracking-wider">
              <Plus size={16} className="mr-2" /> Create Event
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="font-heading uppercase text-xl">Create New Event</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">

                {isSuperAdmin && (
                  <FormField
                    control={form.control}
                    name="clubId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Club</FormLabel>
                        <Select
                          onValueChange={(v) => field.onChange(Number(v))}
                          value={field.value ? String(field.value) : ""}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select a club" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {clubs?.map(c => (
                              <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Event Name</FormLabel>
                      <FormControl><Input placeholder="Spring Classic" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Race Date</FormLabel>
                      <FormControl><Input type="date" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Multi-day toggle + end date */}
                <FormField
                  control={form.control}
                  name="multiDay"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2 space-y-0">
                      <FormControl>
                        <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                      <FormLabel className="cursor-pointer font-normal">Multi-day event</FormLabel>
                    </FormItem>
                  )}
                />
                {watchMultiDay && (
                  <FormField
                    control={form.control}
                    name="endDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>End Date</FormLabel>
                        <FormControl><Input type="date" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}

                {/* Registration window + Collect Payments */}
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FormField
                      control={form.control}
                      name="registrationOpen"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Registration Opens</FormLabel>
                          <FormControl>
                            <DateTimePicker value={field.value ?? ""} onChange={field.onChange} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="registrationClose"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Registration Closes</FormLabel>
                          <FormControl>
                            <DateTimePicker value={field.value ?? ""} onChange={field.onChange} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  {/* Collect Payments checkbox */}
                  {!isSuperAdmin && (
                    <div className="flex items-center gap-2 pt-1">
                      {stripeReady ? (
                        <FormField
                          control={form.control}
                          name="paymentEnabled"
                          render={({ field }) => (
                            <FormItem className="flex items-center gap-2 space-y-0">
                              <FormControl>
                                <Checkbox
                                  checked={field.value}
                                  onCheckedChange={field.onChange}
                                />
                              </FormControl>
                              <FormLabel className="cursor-pointer font-normal">Collect Payments</FormLabel>
                            </FormItem>
                          )}
                        />
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center gap-2 cursor-default">
                              <Checkbox disabled checked={false} />
                              <span className="text-sm text-muted-foreground">Collect Payments</span>
                              <Info size={14} className="text-muted-foreground" />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-64">
                            {isDesktop
                              ? "Connect Stripe in the cloud portal, then sync your data to enable payments here."
                              : <>Set up Stripe Connect under <strong>Payments</strong> in the sidebar to collect entry fees.</>}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  )}

                  {/* Registration requirement checkboxes */}
                  <div className="space-y-2 pt-1">
                    <FormField
                      control={form.control}
                      name="requireAma"
                      render={({ field }) => (
                        <FormItem className="flex items-center gap-2 space-y-0">
                          <FormControl>
                            <Checkbox
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                          <FormLabel className="cursor-pointer font-normal">Require AMA #</FormLabel>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="requireClubId"
                      render={({ field }) => (
                        <FormItem className="flex items-center gap-2 space-y-0">
                          <FormControl>
                            <Checkbox
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                          <FormLabel className="cursor-pointer font-normal">Require Club ID #</FormLabel>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="noDuplicateBibs"
                      render={({ field }) => (
                        <FormItem className="flex items-center gap-2 space-y-0">
                          <FormControl>
                            <Checkbox
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                          <FormLabel className="cursor-pointer font-normal">Do not allow duplicate race numbers</FormLabel>
                        </FormItem>
                      )}
                    />
                  </div>

                  {/* Scoring Format dropdown */}
                  <FormField
                    control={form.control}
                    name="scoringTableId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Scoring Format</FormLabel>
                        <Select
                          value={field.value != null ? String(field.value) : "none"}
                          onValueChange={(v) => field.onChange(v === "none" ? undefined : Number(v))}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select scoring format (optional)" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="none">None</SelectItem>
                            {(pointsTables ?? []).map(t => (
                              <SelectItem key={t.id} value={String(t.id)}>
                                {t.name}{t.isSystemDefault ? " ★" : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          Supercross formats generate Heats + Main Event. AMA/Olympic generate Motos.
                        </p>
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="amaEventId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>AMA Event ID</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. 12345" {...field} />
                        </FormControl>
                        <p className="text-xs text-muted-foreground">Optional — used for AMA report export.</p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />


                  {/* Entry fee input (only when payment enabled) */}
                  {stripeReady && watchPaymentEnabled && (
                    <FormField
                      control={form.control}
                      name="entryFee"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Entry Fee ($)</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="45.00"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}

                  {/* Transponder rental (MyLaps + payment only) */}
                  {stripeReady && watchPaymentEnabled && watchTimingTechnology === "mylaps" && (
                    <div className="space-y-2 pl-0.5">
                      <FormField
                        control={form.control}
                        name="transponderRentalEnabled"
                        render={({ field }) => (
                          <FormItem className="flex items-center gap-2 space-y-0">
                            <FormControl>
                              <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                            </FormControl>
                            <FormLabel className="cursor-pointer font-normal">Offer transponder rentals to riders</FormLabel>
                          </FormItem>
                        )}
                      />
                      {watchTransponderRentalEnabled && (
                        <FormField
                          control={form.control}
                          name="transponderRentalFee"
                          render={({ field }) => (
                            <FormItem className="ml-6">
                              <FormLabel>Rental Fee per Transponder ($)</FormLabel>
                              <FormControl>
                                <Input type="number" min="0" step="0.01" placeholder="15.00" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      )}
                    </div>
                  )}

                  {/* Purchase Options */}
                  <div className="space-y-2 pt-1">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-foreground">Purchase Options</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => appendPurchaseOption({ name: "", amount: "" })}
                      >
                        <Plus size={13} className="mr-1" /> Add Purchase Option
                      </Button>
                    </div>
                    {purchaseOptionFields.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        Add optional items riders can purchase at registration — gate fees, pit passes, etc.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {purchaseOptionFields.map((optField, idx) => (
                          <div key={optField.id} className="flex gap-2 items-start">
                            <FormField
                              control={form.control}
                              name={`purchaseOptions.${idx}.name`}
                              render={({ field }) => (
                                <FormItem className="flex-1">
                                  <FormControl>
                                    <Input placeholder="Gate fee, pit pass…" {...field} />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={form.control}
                              name={`purchaseOptions.${idx}.amount`}
                              render={({ field }) => (
                                <FormItem className="w-28">
                                  <FormControl>
                                    <div className="relative">
                                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                                      <Input type="number" min="0" step="0.01" placeholder="0.00" className="pl-6" {...field} />
                                    </div>
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              control={form.control}
                              name={`purchaseOptions.${idx}.categoryId`}
                              render={({ field }) => (
                                <FormItem className="w-36">
                                  <Select
                                    value={field.value != null ? String(field.value) : "none"}
                                    onValueChange={(v) => field.onChange(v === "none" ? null : Number(v))}
                                  >
                                    <FormControl>
                                      <SelectTrigger>
                                        <SelectValue placeholder="Category" />
                                      </SelectTrigger>
                                    </FormControl>
                                    <SelectContent>
                                      <SelectItem value="none">No category</SelectItem>
                                      {discountCategories.map((cat) => (
                                        <SelectItem key={cat.id} value={String(cat.id)}>{cat.name}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="mt-0.5 shrink-0 text-muted-foreground hover:text-destructive"
                              onClick={() => removePurchaseOption(idx)}
                            >
                              <X size={14} />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="state"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>State</FormLabel>
                        <FormControl><Input placeholder="CO" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="location"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>City</FormLabel>
                        <FormControl><Input placeholder="Denver" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="trackName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Track Name</FormLabel>
                      <FormControl><Input placeholder="Thunder Valley MX" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Timing Technology */}
                <FormField
                  control={form.control}
                  name="timingTechnology"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Timing Technology</FormLabel>
                      <FormControl>
                        <div className="grid grid-cols-2 gap-2">
                          {[
                            { value: "rfid", label: "RFID Stickers", desc: "Passive RFID tags" },
                            { value: "mylaps", label: "MyLaps Transponders", desc: "AMB / MyLaps units" },
                          ].map(opt => (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => field.onChange(opt.value)}
                              className={`flex flex-col items-start px-4 py-3 rounded-md border text-left transition-all ${
                                field.value === opt.value
                                  ? "border-primary bg-primary/5 text-foreground"
                                  : "border-input bg-transparent text-muted-foreground hover:border-primary/50"
                              }`}
                            >
                              <span className={`text-sm font-semibold ${field.value === opt.value ? "text-primary" : ""}`}>{opt.label}</span>
                              <span className="text-xs mt-0.5">{opt.desc}</span>
                            </button>
                          ))}
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Race Classes */}
                <div className="border-t pt-4">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                      <Flag size={12} /> Race Classes
                    </p>
                  </div>
                  <div className="space-y-2">
                    {fields.length > 0 && (
                      <div className="grid grid-cols-[1fr_140px_32px] gap-2 mb-1">
                        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground px-1">Class Name</span>
                        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground px-1">Max Riders</span>
                        <span />
                      </div>
                    )}
                    {fields.map((field, index) => (
                      <div key={field.id} className="grid grid-cols-[1fr_140px_32px] gap-2 items-start">
                        <FormField
                          control={form.control}
                          name={`raceClasses.${index}.name`}
                          render={({ field }) => (
                            <FormItem>
                              <FormControl>
                                <Input placeholder="e.g. 450 Pro" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name={`raceClasses.${index}.maxRiders`}
                          render={({ field }) => (
                            <FormItem>
                              <FormControl>
                                <Input
                                  type="number"
                                  min="1"
                                  placeholder="Unlimited"
                                  {...field}
                                  value={field.value ?? ""}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          onClick={() => remove(index)}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full gap-2 border-dashed font-heading uppercase tracking-wider text-muted-foreground hover:text-foreground mt-1"
                      onClick={() => append({ name: "", maxRiders: "" })}
                    >
                      <Plus size={14} /> Add Class
                    </Button>
                  </div>
                </div>

                {filteredSeriesList.length > 0 && (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Series</label>
                    <Select value={createSeriesId} onValueChange={setCreateSeriesId}>
                      <SelectTrigger>
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {filteredSeriesList.map(s => (
                          <SelectItem key={s.id} value={String(s.id)}>{s.name} ({s.season})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {clubSeriesList.length > filteredSeriesList.length && (
                      <p className="text-xs text-muted-foreground">Only series with a matching scoring format are shown.</p>
                    )}
                  </div>
                )}

                {/* Event Image */}
                <div className="space-y-1.5 pt-2">
                  <label className="text-sm font-medium flex items-center gap-1.5">
                    <ImageIcon size={14} className="text-primary" /> Event Image <span className="text-muted-foreground font-normal">(optional)</span>
                  </label>
                  <input
                    id="create-event-img"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) { e.target.value = ""; setPendingImageFile(f); } }}
                  />
                  {pendingImageFile ? (
                    <div className="flex flex-wrap items-center gap-3 p-3 rounded-md border bg-muted/40">
                      <ImageIcon size={16} className="text-primary shrink-0" />
                      <span className="text-sm flex-1 truncate min-w-0">{pendingImageFile.name}</span>
                      <label className="flex items-center gap-1.5 cursor-pointer select-none text-xs text-muted-foreground shrink-0">
                        <Checkbox checked={removeBgOnCreate} onCheckedChange={v => setRemoveBgOnCreate(!!v)} />
                        Remove background
                      </label>
                      <button type="button" onClick={() => setPendingImageFile(null)} className="text-muted-foreground hover:text-destructive shrink-0">
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <label htmlFor="create-event-img" className="flex items-center justify-center gap-2 p-3 rounded-md border border-dashed text-sm text-muted-foreground hover:text-foreground hover:border-primary cursor-pointer transition-colors">
                      <Upload size={14} /> Choose image
                    </label>
                  )}
                </div>

                <div className="pt-4 flex justify-end">
                  <Button type="submit" disabled={createMutation.isPending || createImgState === "processing" || createImgState === "uploading"} className="font-heading uppercase tracking-wider">
                    {createMutation.isPending ? "Creating..." : createImgState === "processing" ? <><Loader2 size={14} className="mr-2 animate-spin" /> Removing background…</> : createImgState === "uploading" ? <><Loader2 size={14} className="mr-2 animate-spin" /> Uploading image…</> : "Create Event"}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <Tabs value={filter} onValueChange={setFilter} className="w-full">
        <TabsList className="bg-muted">
          <TabsTrigger value="upcoming" className="font-heading uppercase">Upcoming</TabsTrigger>
          <TabsTrigger value="all" className="font-heading uppercase">All</TabsTrigger>
          <TabsTrigger value="draft" className="font-heading uppercase">Draft</TabsTrigger>
          <TabsTrigger value="registration_open" className="font-heading uppercase">Reg Open</TabsTrigger>
          <TabsTrigger value="race_day" className="font-heading uppercase">Race Day</TabsTrigger>
          <TabsTrigger value="completed" className="font-heading uppercase">Completed</TabsTrigger>
        </TabsList>
        
        <TabsContent value={filter} className="mt-6 space-y-4">
          {isLoading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => <Card key={i} className="h-24 animate-pulse"></Card>)}
            </div>
          ) : filteredEvents.length > 0 ? (
            filteredEvents.map(event => (
              <Link key={event.id} href={`/events/${event.id}`}>
                <Card className="hover-elevate cursor-pointer hover:border-primary transition-all">
                  <CardContent className="p-0 flex items-center">
                    <div className="bg-sidebar p-4 flex flex-col justify-center items-center text-sidebar-foreground w-24 shrink-0 rounded-l-md border-r">
                      <span className="text-xs font-bold uppercase tracking-widest mb-1">{format(parseISO(event.date.substring(0, 10)), 'MMM')}</span>
                      <span className="text-3xl font-heading font-bold leading-none">{format(parseISO(event.date.substring(0, 10)), 'dd')}</span>
                    </div>
                    <div className="p-4 flex-1 flex items-center justify-between">
                      <div>
                        <h3 className="text-xl font-heading font-bold uppercase">{event.name}</h3>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1">
                          <span className="flex items-center gap-1"><MapPin size={14} /> {event.location || "TBA"}, {event.state}</span>
                          {isSuperAdmin && event.clubName && (
                            <span className="text-xs bg-muted px-2 py-0.5 rounded">{event.clubName}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {(event as any).timingTechnology && (
                          <span className="bg-muted text-muted-foreground border border-border px-2 py-1 rounded text-xs font-bold uppercase tracking-wider">
                            {(event as any).timingTechnology === "mylaps" ? "MyLaps" : "RFID"}
                          </span>
                        )}
                        {(() => {
                          const isToday = event.date.substring(0, 10) === todayStr;
                          const showRaceDay = isToday && event.status !== "completed" && event.status !== "draft";
                          return (
                            <span className={`px-2 py-1 rounded text-xs font-bold uppercase tracking-wider ${
                              showRaceDay
                                ? "bg-red-600 text-white border border-red-500"
                                : "bg-primary/10 text-primary border border-primary/20"
                            }`}>
                              {showRaceDay ? "Race Day" : event.status.replace(/_/g, ' ')}
                            </span>
                          );
                        })()}
                        <ChevronRight className="text-muted-foreground ml-4" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))
          ) : (
            <div className="text-center p-12 bg-muted/50 rounded-lg">
              <p className="text-muted-foreground font-medium">No events found matching this status.</p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
