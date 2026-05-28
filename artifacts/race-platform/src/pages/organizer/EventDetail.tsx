import { useState } from "react";
import { useRoute } from "wouter";
import { useGetEvent, useUpdateEvent, useGetRaceDaySummary, getGetEventQueryKey } from "@workspace/api-client-react";
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
import { Calendar, MapPin, Flag, Save, Users, CheckCircle, Link2, Copy, Check, DollarSign, Clock, Plus, Trash2, Info } from "lucide-react";
import { format } from "date-fns";

const updateEventSchema = z.object({
  name: z.string().min(1, "Name is required"),
  date: z.string().min(1, "Date is required"),
  state: z.string().min(1, "State is required"),
  location: z.string().optional(),
  trackName: z.string().optional(),
  status: z.string(),
  raceClasses: z.array(z.object({
    name: z.string().min(1, "Class name is required"),
    maxRiders: z.coerce.number().int().min(1).optional().or(z.literal("")),
  })),
  paymentEnabled: z.boolean().default(false),
  entryFee: z.string().optional(),
  maxRiders: z.coerce.number().int().positive().optional().or(z.literal("")),
  registrationOpen: z.string().optional(),
  registrationClose: z.string().optional(),
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
  const updateMutation = useUpdateEvent();

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
      raceClasses: [],
      paymentEnabled: false,
      entryFee: "",
      maxRiders: "",
      registrationOpen: "",
      registrationClose: "",
    }
  });

  const watchPaymentEnabled = form.watch("paymentEnabled");

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "raceClasses",
  });

  // Init form once event loads
  if (event && !isEditing && form.getValues("name") === "") {
    const limits = (event.raceClassLimits ?? {}) as Record<string, number | null>;
    form.reset({
      name: event.name,
      date: format(new Date(event.date), "yyyy-MM-dd"),
      state: event.state,
      location: event.location || "",
      trackName: event.trackName || "",
      status: event.status,
      raceClasses: (event.raceClasses ?? []).map((cls) => ({
        name: cls,
        maxRiders: limits[cls] ?? "",
      })),
      paymentEnabled: event.entryFee != null,
      entryFee: event.entryFee != null ? String(event.entryFee) : "",
      maxRiders: event.maxRiders != null ? event.maxRiders : "",
      registrationOpen: event.registrationOpen ? format(new Date(event.registrationOpen), "yyyy-MM-dd") : "",
      registrationClose: event.registrationClose ? format(new Date(event.registrationClose), "yyyy-MM-dd") : "",
    });
  }

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
        date: new Date(data.date).toISOString(),
        state: data.state,
        location: data.location,
        trackName: data.trackName,
        status: data.status,
        raceClasses: classNames,
        raceClassLimits: classLimits,
        entryFee: data.paymentEnabled && data.entryFee ? Number(data.entryFee) : undefined,
        maxRiders: data.maxRiders !== "" && data.maxRiders != null ? Number(data.maxRiders) : undefined,
        registrationOpen: data.registrationOpen ? new Date(data.registrationOpen).toISOString() : undefined,
        registrationClose: data.registrationClose ? new Date(data.registrationClose).toISOString() : undefined,
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetEventQueryKey(eventId) });
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
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b">
              <CardTitle className="font-heading uppercase text-xl">Event Information</CardTitle>
              {!isEditing && (
                <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>Edit</Button>
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
                      <FormField
                        control={form.control}
                        name="maxRiders"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Max Riders (total)</FormLabel>
                            <FormControl>
                              <Input
                                {...field}
                                value={field.value ?? ""}
                                type="number"
                                min="1"
                                placeholder="Unlimited"
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
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
                              <FormControl><Input type="date" {...field} /></FormControl>
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
                              <FormControl><Input type="date" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>

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
                      <div className="font-medium flex items-center gap-2"><Calendar size={16} className="text-primary"/> {format(new Date(event.date), 'MMMM d, yyyy')}</div>
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
                  </div>

                  <div className="grid grid-cols-2 gap-y-6 pt-2">
                    <div>
                      <div className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Registration Opens</div>
                      <div className="font-medium flex items-center gap-2">
                        <Clock size={16} className="text-primary" />
                        {event.registrationOpen
                          ? format(new Date(event.registrationOpen), "MMM d, yyyy")
                          : <span className="text-muted-foreground italic text-sm">Not set</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm font-bold text-muted-foreground uppercase tracking-widest mb-1">Registration Closes</div>
                      <div className="font-medium flex items-center gap-2">
                        <Clock size={16} className="text-primary" />
                        {event.registrationClose
                          ? format(new Date(event.registrationClose), "MMM d, yyyy")
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
                          <span>{format(new Date(event.registrationOpen), "MMM d, yyyy")}</span>
                        </div>
                      )}
                      {event.registrationClose && (
                        <div className="flex items-center justify-between">
                          <span className="font-bold uppercase tracking-wider">Closes</span>
                          <span>{format(new Date(event.registrationClose), "MMM d, yyyy")}</span>
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
