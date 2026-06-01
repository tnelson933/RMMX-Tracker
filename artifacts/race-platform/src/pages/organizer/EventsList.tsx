import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useListEvents, useCreateEvent, useListClubs, useListSeries, useUpdateSeries, getListEventsQueryKey } from "@workspace/api-client-react";
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
import { Calendar, MapPin, Plus, ChevronRight, Info } from "lucide-react";
import { format, parseISO } from "date-fns";
import { Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";

const createEventSchema = z.object({
  name: z.string().min(1, "Name is required"),
  date: z.string().min(1, "Date is required"),
  state: z.string().min(1, "State is required"),
  location: z.string().optional(),
  trackName: z.string().optional(),
  raceClasses: z.string().optional(),
  clubId: z.number({ invalid_type_error: "Club is required" }).min(1, "Club is required"),
  registrationOpen: z.string().optional(),
  registrationClose: z.string().optional(),
  paymentEnabled: z.boolean().default(false),
  entryFee: z.string().optional(),
});

export default function EventsList() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const sessionClubId = user?.clubId ?? null;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [createSeriesId, setCreateSeriesId] = useState<string>("none");

  // Super admin sees all events; club organizer sees only their club's events
  const eventsQuery = isSuperAdmin
    ? useListEvents({})
    : useListEvents({ clubId: sessionClubId ?? undefined }, { query: { enabled: !!sessionClubId } as any });
  const { data: events, isLoading } = eventsQuery;

  // Clubs list for the super_admin club selector
  const { data: clubs } = useListClubs({ query: { enabled: isSuperAdmin } as any });

  // Check Stripe Connect status
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

  const form = useForm<z.infer<typeof createEventSchema>>({
    resolver: zodResolver(createEventSchema),
    defaultValues: {
      name: "",
      date: format(new Date(), "yyyy-MM-dd"),
      state: "",
      location: "",
      trackName: "",
      raceClasses: "250 Pro,450 Pro,Vet A",
      clubId: sessionClubId ?? undefined,
      registrationOpen: "",
      registrationClose: "",
      paymentEnabled: false,
      entryFee: "",
    }
  });

  const watchPaymentEnabled = form.watch("paymentEnabled");

  const onSubmit = (data: z.infer<typeof createEventSchema>) => {
    createMutation.mutate({
      data: {
        clubId: data.clubId,
        name: data.name,
        date: data.date,
        state: data.state,
        location: data.location,
        trackName: data.trackName,
        raceClasses: data.raceClasses ? data.raceClasses.split(",").map(s => s.trim()) : [],
        registrationOpen: data.registrationOpen || undefined,
        registrationClose: data.registrationClose || undefined,
        paymentEnabled: data.paymentEnabled,
        entryFee: data.paymentEnabled && data.entryFee ? Number(data.entryFee) : undefined,
      }
    }, {
      onSuccess: (newEvent) => {
        queryClient.invalidateQueries({ queryKey: getListEventsQueryKey({}) });
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
        setIsCreateOpen(false);
        setCreateSeriesId("none");
        form.reset();
        toast({ title: "Event created successfully" });
      },
      onError: (err) => {
        toast({ title: "Failed to create event", description: err.message, variant: "destructive" });
      }
    });
  };

  const filteredEvents = events?.filter(e => {
    if (filter === "all") return true;
    if (filter === "draft") return e.status === "draft";
    if (filter === "registration_open") return e.status === "registration_open";
    if (filter === "race_day") return e.status === "race_day";
    if (filter === "completed") return e.status === "completed";
    return true;
  }) || [];

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight">Events</h1>
          <p className="text-muted-foreground mt-1">Manage your club's race events.</p>
        </div>
        
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="font-heading uppercase tracking-wider">
              <Plus size={16} className="mr-2" /> Create Event
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
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

                {/* Registration window + Collect Payments */}
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <FormField
                      control={form.control}
                      name="registrationOpen"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Registration Opens</FormLabel>
                          <FormControl><Input type="datetime-local" {...field} /></FormControl>
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
                          <FormControl><Input type="datetime-local" {...field} /></FormControl>
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
                          <TooltipContent side="right" className="max-w-56">
                            Set up Stripe Connect under <strong>Payments</strong> in the sidebar to collect entry fees.
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  )}

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

                <FormField
                  control={form.control}
                  name="raceClasses"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Race Classes (comma separated)</FormLabel>
                      <FormControl><Input placeholder="250 A, 450 B, Vet 30+" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {clubSeriesList.length > 0 && (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Series</label>
                    <Select value={createSeriesId} onValueChange={setCreateSeriesId}>
                      <SelectTrigger>
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {clubSeriesList.map(s => (
                          <SelectItem key={s.id} value={String(s.id)}>{s.name} ({s.season})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="pt-4 flex justify-end">
                  <Button type="submit" disabled={createMutation.isPending} className="font-heading uppercase tracking-wider">
                    {createMutation.isPending ? "Creating..." : "Create Event"}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Tabs value={filter} onValueChange={setFilter} className="w-full">
        <TabsList className="bg-muted">
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
                      <div className="flex items-center gap-6">
                        <span className="bg-primary/10 text-primary border border-primary/20 px-2 py-1 rounded text-xs font-bold uppercase tracking-wider">
                          {event.status.replace(/_/g, ' ')}
                        </span>
                        <ChevronRight className="text-muted-foreground" />
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
