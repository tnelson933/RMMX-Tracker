import { useState, useEffect } from "react";
import { useRoute } from "wouter";
import { EmbedWidgetCard } from "@/components/organizer/EmbedWidgetCard";
import { useGetEvent, useUpdateEvent, useGetRaceDaySummary, useListSeries, useUpdateSeries, useListPointsTables, getGetEventQueryKey } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { Calendar, MapPin, Flag, Save, Users, CheckCircle, Link2, Copy, Check, DollarSign, Clock, Plus, Trash2, Info, Upload, ImageIcon, X, Loader2, Sparkles, Ticket } from "lucide-react";
import { format, parseISO } from "date-fns";

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

function toLocalDatetimeString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

const updateEventSchema = z.object({
  name: z.string().min(1, "Name is required"),
  date: z.string().min(1, "Date is required"),
  state: z.string().min(1, "State is required"),
  location: z.string().optional(),
  trackName: z.string().optional(),
  status: z.string(),
  timingTechnology: z.enum(["rfid", "mylaps"]).default("rfid"),
  raceClasses: z.array(z.object({
    name: z.string().min(1, "Class name is required"),
    maxRiders: z.coerce.number().int().min(1).optional().or(z.literal("")),
  })),
  paymentEnabled: z.boolean().default(false),
  requireAma: z.boolean().default(false),
  entryFee: z.string().optional(),
  registrationOpen: z.string().optional(),
  registrationClose: z.string().optional(),
  transponderRentalEnabled: z.boolean().default(false),
  transponderRentalFee: z.string().optional(),
  noDuplicateBibs: z.boolean().default(false),
  requireClubId: z.boolean().default(false),
  scoringTableId: z.number().optional(),
  purchaseOptions: z.array(z.object({
    name: z.string().min(1, "Name required"),
    amount: z.string().min(1, "Amount required"),
  })).default([]),
  amaEventId: z.string().optional(),
});

type FormValues = z.infer<typeof updateEventSchema>;

export default function EventDetail() {
  const [match, params] = useRoute("/events/:eventId");
  const eventId = parseInt(params?.eventId || "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";

  const { data: event, isLoading } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const { data: summary } = useGetRaceDaySummary(eventId, { query: { enabled: !!eventId } as any });
  const { data: seriesList } = useListSeries({ query: {} as any });
  const updateMutation = useUpdateEvent();
  const updateSeriesMutation = useUpdateSeries();
  const { data: pointsTables } = useListPointsTables({ query: {} as any });

  const [editSeriesId, setEditSeriesId] = useState<string>("none");

  const { data: stripeStatus } = useQuery({
    queryKey: ["stripe-connect-status"],
    queryFn: async () => {
      const res = await fetch("/api/stripe/connect/status", { credentials: "include" });
      if (!res.ok) return { connected: false, onboardingComplete: false };
      return res.json() as Promise<{ connected: boolean; onboardingComplete: boolean }>;
    },
    enabled: !isSuperAdmin,
  });
  const stripeReady = !isSuperAdmin && (stripeStatus?.connected ?? false);

  const [isEditing, setIsEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [imgUploadState, setImgUploadState] = useState<"idle" | "processing" | "uploading" | "done" | "error">("idle");
  const [removeBg, setRemoveBg] = useState(false);

  const [compAmount, setCompAmount] = useState("");
  const [compCount, setCompCount] = useState("1");
  const [compGenerating, setCompGenerating] = useState(false);
  const [generatedCodes, setGeneratedCodes] = useState<string[]>([]);
  const [generatedAmount, setGeneratedAmount] = useState(0);
  const [existingCodes, setExistingCodes] = useState<Array<{ code: string; amount: number; usesCount: number; maxUses: number }>>([]);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const handleImageUpload = async (file: File) => {
    if (!file || !eventId) return;
    setImgUploadState("processing");
    let blob: Blob = file;
    if (removeBg) {
      try {
        const { removeBackground } = await import("@imgly/background-removal");
        blob = await removeBackground(file);
      } catch {
        blob = file;
      }
    }
    setImgUploadState("uploading");
    try {
      const uploadRes = await fetch("/api/storage/uploads/file", {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          "x-file-name": `event-${eventId}-image.png`,
          "x-content-type": "image/png",
        },
        credentials: "include",
        body: blob,
      });
      if (!uploadRes.ok) throw new Error("Upload failed");
      const { objectPath } = await uploadRes.json() as { objectPath: string };
      await fetch(`/api/events/${eventId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ imageUrl: `/api/storage${objectPath}` }),
      });
      queryClient.invalidateQueries({ queryKey: getGetEventQueryKey(eventId) });
      setImgUploadState("done");
      setTimeout(() => setImgUploadState("idle"), 2500);
    } catch {
      setImgUploadState("error");
      setTimeout(() => setImgUploadState("idle"), 3000);
    }
  };

  const handleImageRemove = async () => {
    await fetch(`/api/events/${eventId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ imageUrl: null }),
    });
    queryClient.invalidateQueries({ queryKey: getGetEventQueryKey(eventId) });
  };

  const loadExistingCodes = async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/comp-codes`, { credentials: "include" });
      if (res.ok) setExistingCodes(await res.json());
    } catch {}
  };

  useEffect(() => { if (eventId) loadExistingCodes(); }, [eventId]);

  const handleGenerateCompCodes = async () => {
    const amount = parseFloat(compAmount);
    const count = parseInt(compCount, 10);
    if (!amount || amount <= 0 || !count || count <= 0) return;
    setCompGenerating(true);
    try {
      const res = await fetch(`/api/events/${eventId}/comp-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ amount, count }),
      });
      if (res.ok) {
        const data = await res.json();
        setGeneratedCodes(data.codes);
        setGeneratedAmount(amount);
        await loadExistingCodes();
      }
    } finally {
      setCompGenerating(false);
    }
  };

  const registrationUrl = `${window.location.origin}/register/${eventId}`;

  const copyLink = () => {
    navigator.clipboard.writeText(registrationUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: "Link copied to clipboard" });
  };

  const form = useForm<FormValues>({
    resolver: zodResolver(updateEventSchema),
    defaultValues: {
      name: "",
      date: "",
      state: "",
      location: "",
      trackName: "",
      status: "draft",
      timingTechnology: "rfid",
      raceClasses: [],
      paymentEnabled: false,
      requireAma: false,
      entryFee: "",
      registrationOpen: "",
      registrationClose: "",
      transponderRentalEnabled: false,
      transponderRentalFee: "",
      noDuplicateBibs: false,
      requireClubId: false,
      scoringTableId: undefined,
      purchaseOptions: [],
      amaEventId: "",
    }
  });

  const watchPaymentEnabled = form.watch("paymentEnabled");
  const watchTimingTechnology = form.watch("timingTechnology");
  const watchTransponderRentalEnabled = form.watch("transponderRentalEnabled");

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "raceClasses",
  });
  const { fields: purchaseOptionFields, append: appendPurchaseOption, remove: removePurchaseOption } = useFieldArray({ control: form.control, name: "purchaseOptions" });

  const clubSeriesList = (seriesList ?? []).filter(s => s.clubId === event?.clubId);
  const watchScoringTableId = form.watch("scoringTableId");
  const filteredSeriesList = clubSeriesList.filter(s =>
    !s.scoringTableId || !watchScoringTableId || s.scoringTableId === watchScoringTableId
  );

  const resetFormFromEvent = (evt: typeof event) => {
    if (!evt) return;
    const limits = (evt.raceClassLimits ?? {}) as Record<string, number | null>;
    form.reset({
      name: evt.name,
      date: evt.date.substring(0, 10),
      state: evt.state,
      location: evt.location || "",
      trackName: evt.trackName || "",
      status: evt.status,
      timingTechnology: ((evt as any).timingTechnology ?? "rfid") as "rfid" | "mylaps",
      raceClasses: (evt.raceClasses ?? []).map((cls) => ({
        name: cls,
        maxRiders: limits[cls] ?? "",
      })),
      paymentEnabled: evt.entryFee != null,
      requireAma: evt.requireAma ?? false,
      entryFee: evt.entryFee != null ? String(evt.entryFee) : "",
      registrationOpen: evt.registrationOpen ? toLocalDatetimeString(new Date(evt.registrationOpen)) : "",
      registrationClose: evt.registrationClose ? toLocalDatetimeString(new Date(evt.registrationClose)) : "",
      transponderRentalEnabled: (evt as any).transponderRentalEnabled ?? false,
      transponderRentalFee: (evt as any).transponderRentalFee != null ? String((evt as any).transponderRentalFee) : "",
      noDuplicateBibs: (evt as any).noDuplicateBibs ?? false,
      requireClubId: (evt as any).requireClubId ?? false,
      scoringTableId: (evt as any).scoringTableId ?? undefined,
      purchaseOptions: ((evt as any).purchaseOptions ?? []).map((o: { id: string; name: string; amount: number }) => ({ name: o.name, amount: String(o.amount) })),
      amaEventId: (evt as any).amaEventId ?? "",
    });
    const currentSeries = (seriesList ?? []).find(s => (s.eventIds as number[] ?? []).includes(evt.id));
    setEditSeriesId(currentSeries ? String(currentSeries.id) : "none");
  };

  const onSubmit = (data: FormValues) => {
    const classNames = data.raceClasses.map((r) => r.name.trim()).filter(Boolean);
    const classLimits: Record<string, number | null> = {};
    data.raceClasses.forEach((r) => {
      const key = r.name.trim();
      if (!key) return;
      classLimits[key] = r.maxRiders !== "" && r.maxRiders != null ? Number(r.maxRiders) : null;
    });

    updateMutation.mutate({
      eventId,
      data: {
        name: data.name,
        date: data.date,
        state: data.state,
        location: data.location,
        trackName: data.trackName,
        status: data.status,
        timingTechnology: data.timingTechnology,
        raceClasses: classNames,
        raceClassLimits: classLimits,
        paymentEnabled: data.paymentEnabled,
        requireAma: data.requireAma,
        noDuplicateBibs: data.noDuplicateBibs,
        requireClubId: data.requireClubId,
        scoringTableId: data.scoringTableId ?? null,
        entryFee: data.paymentEnabled && data.entryFee ? Number(data.entryFee) : undefined,
        registrationOpen: data.registrationOpen ? new Date(data.registrationOpen).toISOString() : undefined,
        registrationClose: data.registrationClose ? new Date(data.registrationClose).toISOString() : undefined,
        transponderRentalEnabled: data.timingTechnology === "mylaps" && data.paymentEnabled ? data.transponderRentalEnabled : false,
        transponderRentalFee: data.timingTechnology === "mylaps" && data.paymentEnabled && data.transponderRentalEnabled && data.transponderRentalFee ? Number(data.transponderRentalFee) : undefined,
        purchaseOptions: data.purchaseOptions.map(o => ({ id: crypto.randomUUID(), name: o.name.trim(), amount: Number(o.amount) })),
        amaEventId: data.amaEventId || undefined,
      } as any
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetEventQueryKey(eventId) });
        // Handle series linking changes
        const prevSeries = (seriesList ?? []).find(s => (s.eventIds as number[] ?? []).includes(eventId));
        const newSeriesId = editSeriesId !== "none" ? Number(editSeriesId) : null;
        const prevSeriesId = prevSeries?.id ?? null;
        if (prevSeriesId !== newSeriesId) {
          // Remove from old series
          if (prevSeries) {
            const ids = (prevSeries.eventIds as number[]).filter(id => id !== eventId);
            updateSeriesMutation.mutate({ seriesId: prevSeries.id, data: { eventIds: ids } });
          }
          // Add to new series
          if (newSeriesId) {
            const target = (seriesList ?? []).find(s => s.id === newSeriesId);
            if (target) {
              const ids = [...((target.eventIds as number[]) ?? []), eventId];
              updateSeriesMutation.mutate({ seriesId: target.id, data: { eventIds: ids } });
            }
          }
        }
        setIsEditing(false);
        toast({ title: "Event updated" });
      },
      onError: (err) => {
        toast({ title: "Update failed", description: err.message, variant: "destructive" });
      }
    });
  };

  if (isLoading) return <div className="p-8">Loading...</div>;
  if (!event) return <div className="p-8">Event not found</div>;

  const limits = (event.raceClassLimits ?? {}) as Record<string, number | null>;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

        <div className="lg:col-span-2 space-y-6">

          {/* Event Image upload card */}
          <Card>
            <CardHeader className="pb-3 border-b">
              <CardTitle className="font-heading uppercase text-base flex items-center gap-2">
                <ImageIcon size={16} className="text-primary" /> Event Image
              </CardTitle>
            </CardHeader>
            {(event as any).imageUrl ? (
              <>
                <div className="px-6 pt-5">
                  <img
                    src={(event as any).imageUrl}
                    alt={event.name}
                    className="w-full max-h-48 object-contain rounded-md bg-muted/30"
                  />
                </div>
                <CardContent className="p-5 flex flex-wrap items-center gap-3">
                  <input
                    id="event-img-upload"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) { e.target.value = ""; handleImageUpload(f); } }}
                  />
                  <label htmlFor="event-img-upload" className="cursor-pointer">
                    <Button asChild variant="outline" disabled={imgUploadState === "processing" || imgUploadState === "uploading"} className="font-heading uppercase tracking-wider">
                      <span>
                        {imgUploadState === "processing" ? <><Sparkles size={14} className="mr-2 animate-pulse" /> Removing background…</>
                          : imgUploadState === "uploading" ? <><Loader2 size={14} className="mr-2 animate-spin" /> Uploading…</>
                          : <><Upload size={14} className="mr-2" /> Replace Image</>}
                      </span>
                    </Button>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-muted-foreground">
                    <Checkbox checked={removeBg} onCheckedChange={v => setRemoveBg(!!v)} disabled={imgUploadState === "processing" || imgUploadState === "uploading"} />
                    Remove background
                  </label>
                  <Button variant="ghost" onClick={handleImageRemove} disabled={imgUploadState === "processing" || imgUploadState === "uploading"} className="text-muted-foreground hover:text-destructive font-heading uppercase tracking-wider">
                    <X size={14} className="mr-1.5" /> Remove
                  </Button>
                  {imgUploadState === "done" && <span className="text-sm text-green-600 font-medium flex items-center gap-1.5"><CheckCircle size={14} /> Saved</span>}
                  {imgUploadState === "error" && <span className="text-sm text-destructive font-medium">Upload failed — try again</span>}
                </CardContent>
              </>
            ) : (
              <CardContent className="p-6 flex flex-col sm:flex-row items-center gap-6">
                <div className="w-24 h-24 rounded-xl border-2 border-dashed border-muted-foreground/25 bg-muted/20 flex items-center justify-center shrink-0">
                  <ImageIcon size={32} className="text-muted-foreground/30" />
                </div>
                <div className="space-y-3 text-center sm:text-left">
                  <div>
                    <h3 className="font-heading font-bold uppercase tracking-tight text-lg">No Event Image</h3>
                    <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                      Upload a race-specific flyer or photo. It will appear alongside the club logo on the public registration and race info/live standings pages.
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">PNG, JPG or WebP</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 justify-center sm:justify-start">
                    <input
                      id="event-img-upload"
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={e => { const f = e.target.files?.[0]; if (f) { e.target.value = ""; handleImageUpload(f); } }}
                    />
                    <label htmlFor="event-img-upload" className="cursor-pointer">
                      <Button asChild disabled={imgUploadState === "processing" || imgUploadState === "uploading"} className="font-heading uppercase tracking-wider">
                        <span>
                          {imgUploadState === "processing" ? <><Sparkles size={14} className="mr-2 animate-pulse" /> Removing background…</>
                            : imgUploadState === "uploading" ? <><Loader2 size={14} className="mr-2 animate-spin" /> Uploading…</>
                            : <><Upload size={14} className="mr-2" /> Upload Event Image</>}
                        </span>
                      </Button>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-muted-foreground">
                      <Checkbox checked={removeBg} onCheckedChange={v => setRemoveBg(!!v)} disabled={imgUploadState === "processing" || imgUploadState === "uploading"} />
                      Remove background
                    </label>
                  </div>
                  {imgUploadState === "done" && <p className="text-sm text-green-600 font-medium flex items-center gap-1.5"><CheckCircle size={14} /> Saved</p>}
                  {imgUploadState === "error" && <p className="text-sm text-destructive font-medium">Upload failed — try again</p>}
                </div>
              </CardContent>
            )}
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b">
              <CardTitle className="font-heading uppercase text-xl">Event Information</CardTitle>
              {!isEditing && (
                <Button variant="outline" size="sm" onClick={() => { resetFormFromEvent(event); setIsEditing(true); }}>Edit</Button>
              )}
            </CardHeader>
            <CardContent className="p-6">
              {isEditing ? (
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                    <FormField
                      control={form.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Event Name</FormLabel>
                          <FormControl><Input {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="date"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Date</FormLabel>
                            <FormControl><Input type="date" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="status"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Status</FormLabel>
                            <Select value={field.value} onValueChange={field.onChange}>
                              <FormControl>
                                <SelectTrigger><SelectValue placeholder="Select Status" /></SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="draft">Draft</SelectItem>
                                <SelectItem value="registration_open">Registration Open</SelectItem>
                                <SelectItem value="registration_closed">Registration Closed</SelectItem>
                                <SelectItem value="race_day">Race Day</SelectItem>
                                <SelectItem value="completed">Completed</SelectItem>
                                <SelectItem value="results_published">Results Published</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="state"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>State</FormLabel>
                            <FormControl><Input {...field} /></FormControl>
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
                            <FormControl><Input {...field} /></FormControl>
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
                          <FormControl><Input {...field} /></FormControl>
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
                              className="h-9 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 mt-0"
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

                    <div className="space-y-3">
                      {/* Require AMA# checkbox */}
                      <div className="flex items-center gap-2">
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
                      </div>

                      {/* No Duplicate Bibs checkbox */}
                      <div className="flex items-center gap-2">
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
                              <FormLabel className="cursor-pointer font-normal">Do not allow duplicate bib numbers</FormLabel>
                            </FormItem>
                          )}
                        />
                      </div>

                      {/* Require Club ID# checkbox */}
                      <div className="flex items-center gap-2">
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
                              <FormLabel className="cursor-pointer font-normal">Require club ID #</FormLabel>
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

                      {/* Collect Payments toggle */}
                      {!isSuperAdmin && (
                        <div className="flex items-center gap-2">
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
                              <TooltipContent side="right" className="max-w-56">
                                Set up Stripe Connect under <strong>Payments</strong> in the sidebar to collect entry fees.
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="entryFee"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Entry Fee ($)</FormLabel>
                            <FormControl>
                              <div className="relative">
                                <DollarSign size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                  {...field}
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  placeholder="0.00"
                                  className="pl-8"
                                  disabled={!watchPaymentEnabled}
                                />
                              </div>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    {/* Transponder rental — only shown for MyLaps events with payments */}
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

                    <div className="border-t pt-4">
                      <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-1.5"><Clock size={12} /> Registration Window</p>
                      <div className="grid grid-cols-2 gap-4">
                        <FormField
                          control={form.control}
                          name="registrationOpen"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Opens</FormLabel>
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
                              <FormLabel>Closes</FormLabel>
                              <FormControl>
                                <DateTimePicker value={field.value ?? ""} onChange={field.onChange} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>

                    {filteredSeriesList.length > 0 && (
                      <div className="border-t pt-4 space-y-1.5">
                        <label className="text-sm font-medium">Series</label>
                        <Select value={editSeriesId} onValueChange={setEditSeriesId}>
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

                    <div className="pt-4 flex justify-end gap-2">
                      <Button variant="ghost" type="button" onClick={() => setIsEditing(false)}>Cancel</Button>
                      <Button type="submit" disabled={updateMutation.isPending} className="font-heading uppercase">
                        <Save size={16} className="mr-2" /> Save Changes
                      </Button>
                    </div>
                  </form>
                </Form>
              ) : (
                <div className="space-y-6">
                  <div className="grid grid-cols-2 gap-y-6">
                    <div>
                      <div className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Date</div>
                      <div className="font-medium flex items-center gap-2"><Calendar size={16} className="text-primary"/> {format(parseISO(event.date.substring(0, 10)), 'MMMM d, yyyy')}</div>
                    </div>
                    <div>
                      <div className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Status</div>
                      <div className="font-medium inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider bg-primary/10 text-primary border border-primary/20">
                        {event.status.replace(/_/g, ' ')}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Location</div>
                      <div className="font-medium flex items-center gap-2"><MapPin size={16} className="text-primary"/> {event.location || "TBA"}, {event.state}</div>
                    </div>
                    <div>
                      <div className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Track</div>
                      <div className="font-medium flex items-center gap-2"><Flag size={16} className="text-primary"/> {event.trackName || "TBA"}</div>
                    </div>
                    <div>
                      <div className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Timing Technology</div>
                      <div className="font-medium">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider bg-muted text-muted-foreground border border-border">
                          {((event as any).timingTechnology ?? "rfid") === "mylaps" ? "MyLaps" : "RFID"}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-y-6 pt-2">
                    <div>
                      <div className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Entry Fee</div>
                      <div className="font-heading font-bold text-xl flex items-center gap-1">
                        {event.entryFee != null
                          ? <><span className="text-primary"><DollarSign size={18} className="inline -mt-0.5" /></span>{Number(event.entryFee).toFixed(2)}</>
                          : <span className="text-muted-foreground text-sm font-normal italic">Not set</span>
                        }
                      </div>
                    </div>
                    {(event as any).transponderRentalEnabled && (
                      <div>
                        <div className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Transponder Rental</div>
                        <div className="font-heading font-bold text-xl flex items-center gap-1">
                          <span className="text-primary"><DollarSign size={18} className="inline -mt-0.5" /></span>
                          {(event as any).transponderRentalFee != null ? Number((event as any).transponderRentalFee).toFixed(2) : "—"}
                          <span className="text-xs font-normal text-muted-foreground ml-1">/ rider</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-y-6 pt-2">
                    <div>
                      <div className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Registration Opens</div>
                      <div className="font-medium flex items-center gap-2">
                        <Clock size={16} className="text-primary" />
                        {event.registrationOpen
                          ? format(new Date(event.registrationOpen), "MMM d, yyyy 'at' h:mm a")
                          : <span className="text-muted-foreground italic text-sm">Not set</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Registration Closes</div>
                      <div className="font-medium flex items-center gap-2">
                        <Clock size={16} className="text-primary" />
                        {event.registrationClose
                          ? format(new Date(event.registrationClose), "MMM d, yyyy 'at' h:mm a")
                          : <span className="text-muted-foreground italic text-sm">Not set</span>}
                      </div>
                    </div>
                  </div>

                  <div className="pt-4 border-t">
                    <div className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-3">Race Classes</div>
                    {event.raceClasses?.length ? (
                      <div className="border rounded-sm overflow-hidden">
                        <div className="grid grid-cols-[1fr_120px] text-xs font-bold uppercase tracking-wider text-muted-foreground bg-muted/50 px-3 py-2 border-b">
                          <span>Class</span>
                          <span className="text-right">Max Riders</span>
                        </div>
                        {event.raceClasses.map((cls) => (
                          <div key={cls} className="grid grid-cols-[1fr_120px] px-3 py-2.5 border-b last:border-0 items-center">
                            <span className="font-medium">{cls}</span>
                            <span className="text-right text-sm">
                              {limits[cls] != null
                                ? <span className="font-heading font-bold">{limits[cls]}</span>
                                : <span className="text-muted-foreground italic">Unlimited</span>
                              }
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground italic text-sm">None defined</span>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Embed Widget Card */}
          <EmbedWidgetCard eventId={eventId} />

        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center gap-2 pb-3 border-b">
              <Link2 size={18} className="text-primary" />
              <CardTitle className="font-heading uppercase text-base">Registration Link</CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              {event.status === "registration_open" ? (
                <>
                  <p className="text-xs text-muted-foreground">Share this link with riders so they can register online.</p>
                  <div className="bg-muted rounded-md px-3 py-2 text-xs font-mono break-all text-muted-foreground select-all">
                    {registrationUrl}
                  </div>
                  <Button onClick={copyLink} className="w-full font-heading uppercase tracking-wider" size="sm">
                    {copied ? <><Check size={14} className="mr-2" /> Copied!</> : <><Copy size={14} className="mr-2" /> Copy Link</>}
                  </Button>
                  {(event.registrationOpen || event.registrationClose) && (
                    <div className="border-t pt-3 space-y-1.5 text-xs text-muted-foreground">
                      {event.registrationOpen && (
                        <div className="flex items-center justify-between">
                          <span className="font-bold uppercase tracking-wider">Opens</span>
                          <span>{format(new Date(event.registrationOpen), "MMM d 'at' h:mm a")}</span>
                        </div>
                      )}
                      {event.registrationClose && (
                        <div className="flex items-center justify-between">
                          <span className="font-bold uppercase tracking-wider">Closes</span>
                          <span>{format(new Date(event.registrationClose), "MMM d 'at' h:mm a")}</span>
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Set the event status to <strong>Registration Open</strong> to activate the rider registration link.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Comp Code Generator */}
          <Card>
            <CardHeader className="flex flex-row items-center gap-2 pb-3 border-b">
              <Ticket size={18} className="text-primary" />
              <CardTitle className="font-heading uppercase text-base">Comp Codes</CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              <p className="text-xs text-muted-foreground">Generate codes to give riders a complimentary or discounted entry.</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-1">$ Amount</label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={compAmount}
                    onChange={e => setCompAmount(e.target.value)}
                    placeholder="45.00"
                    className="h-9 text-sm"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-1"># Codes</label>
                  <Input
                    type="number"
                    min="1"
                    max="100"
                    value={compCount}
                    onChange={e => setCompCount(e.target.value)}
                    className="h-9 text-sm"
                  />
                </div>
              </div>
              <Button
                onClick={handleGenerateCompCodes}
                disabled={compGenerating || !compAmount || parseFloat(compAmount) <= 0}
                className="w-full font-heading uppercase tracking-wider"
                size="sm"
              >
                {compGenerating
                  ? <><Loader2 size={14} className="mr-2 animate-spin" /> Generating...</>
                  : <><Plus size={14} className="mr-2" /> Generate Codes</>}
              </Button>

              {generatedCodes.length > 0 && (
                <div className="border-t pt-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      New — ${generatedAmount.toFixed(2)} each
                    </p>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(generatedCodes.join("\n"));
                        setCopiedCode("__all__");
                        setTimeout(() => setCopiedCode(null), 2000);
                      }}
                      className="text-xs text-primary hover:underline"
                    >
                      {copiedCode === "__all__" ? "Copied!" : "Copy all"}
                    </button>
                  </div>
                  <div className="space-y-1">
                    {generatedCodes.map(code => (
                      <div key={code} className="flex items-center justify-between bg-muted rounded px-2.5 py-1.5">
                        <span className="font-mono text-sm font-bold tracking-widest">{code}</span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(code);
                            setCopiedCode(code);
                            setTimeout(() => setCopiedCode(null), 2000);
                          }}
                          className="text-muted-foreground hover:text-foreground transition-colors ml-2"
                        >
                          {copiedCode === code ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {existingCodes.length > 0 && (
                <div className="border-t pt-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">All Codes</p>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {existingCodes.map(c => (
                      <div key={c.code} className="flex items-center justify-between text-xs py-1.5 border-b last:border-0">
                        <span className="font-mono font-bold tracking-widest">{c.code}</span>
                        <div className="flex items-center gap-3 text-muted-foreground">
                          <span>${c.amount.toFixed(2)}</span>
                          <span className={c.usesCount >= c.maxUses ? "text-red-500 font-medium" : "text-green-600 font-medium"}>
                            {c.usesCount >= c.maxUses ? "Used" : "Available"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="bg-sidebar text-sidebar-foreground border-b rounded-t-lg pb-4">
              <CardTitle className="font-heading uppercase text-xl text-white">Race Day Summary</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                <div className="p-4 flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <Users className="text-muted-foreground" size={20} />
                    <span className="font-medium">Total Registered</span>
                  </div>
                  <span className="text-xl font-heading font-bold">{summary?.totalRegistered || 0}</span>
                </div>
                <div className="p-4 flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <CheckCircle className="text-secondary" size={20} />
                    <span className="font-medium">Checked In</span>
                  </div>
                  <span className="text-xl font-heading font-bold text-secondary">{summary?.checkedIn || 0}</span>
                </div>
                <div className="p-4 flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <Flag className="text-primary" size={20} />
                    <span className="font-medium">Motos Scheduled</span>
                  </div>
                  <span className="text-xl font-heading font-bold">{summary?.motosScheduled || 0}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
