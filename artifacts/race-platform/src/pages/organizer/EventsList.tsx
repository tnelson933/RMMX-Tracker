import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useListEvents, useCreateEvent, getListEventsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar, MapPin, Plus, ChevronRight } from "lucide-react";
import { format } from "date-fns";
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
  raceClasses: z.string().optional(), // Comma separated for simplicity in form
});

export default function EventsList() {
  const { user } = useAuth();
  const clubId = user?.clubId || 0;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [filter, setFilter] = useState("all");

  const { data: events, isLoading } = useListEvents(
    { clubId }, 
    { query: { enabled: !!clubId } as any }
  );
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
    }
  });

  const onSubmit = (data: z.infer<typeof createEventSchema>) => {
    createMutation.mutate({
      data: {
        clubId,
        name: data.name,
        date: new Date(data.date).toISOString(),
        state: data.state,
        location: data.location,
        trackName: data.trackName,
        raceClasses: data.raceClasses ? data.raceClasses.split(",").map(s => s.trim()) : [],
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEventsQueryKey({ clubId }) });
        setIsCreateOpen(false);
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
    if (filter === "completed") return e.status === "completed" || e.status === "results_published";
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
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-heading uppercase text-xl">Create New Event</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
                      <FormLabel>Date</FormLabel>
                      <FormControl><Input type="date" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
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
                      <span className="text-xs font-bold uppercase tracking-widest mb-1">{format(new Date(event.date), 'MMM')}</span>
                      <span className="text-3xl font-heading font-bold leading-none">{format(new Date(event.date), 'dd')}</span>
                    </div>
                    <div className="p-4 flex-1 flex items-center justify-between">
                      <div>
                        <h3 className="text-xl font-heading font-bold uppercase">{event.name}</h3>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1">
                          <span className="flex items-center gap-1"><MapPin size={14} /> {event.location || "TBA"}, {event.state}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-6">
                        <span className="bg-primary/10 text-primary border border-primary/20 px-2 py-1 rounded text-xs font-bold uppercase tracking-wider">
                          {event.status.replace('_', ' ')}
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
