import { useState, useEffect } from "react";
import { useRoute, Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar, MapPin, Flag, CheckCircle2, AlertCircle, ChevronLeft } from "lucide-react";
import { format } from "date-fns";

const registerSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Valid email is required"),
  phone: z.string().optional(),
  dateOfBirth: z.string().optional(),
  emergencyContact: z.string().optional(),
  emergencyPhone: z.string().optional(),
  raceClass: z.string().min(1, "Race class is required"),
  bibNumber: z.string().optional(),
});

type RegisterForm = z.infer<typeof registerSchema>;

interface EventInfo {
  id: number;
  name: string;
  date: string;
  state: string;
  location: string | null;
  trackName: string | null;
  raceClasses: string[];
  status: string;
  entryFee: number | null;
  clubName: string | null;
}

interface SuccessData {
  registrationId: number;
  riderName: string;
  raceClass: string;
  eventName: string;
}

export default function Register() {
  const [, params] = useRoute("/register/:eventId");
  const eventId = params?.eventId;

  const [event, setEvent] = useState<EventInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<SuccessData | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      firstName: "", lastName: "", email: "", phone: "",
      dateOfBirth: "", emergencyContact: "", emergencyPhone: "",
      raceClass: "", bibNumber: "",
    },
  });

  useEffect(() => {
    if (!eventId) return;
    fetch(`/api/public/events/${eventId}/register-info`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(setEvent)
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [eventId]);

  const onSubmit = async (data: RegisterForm) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/public/events/${eventId}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Registration failed");
      setSuccess(json);
    } catch (e: any) {
      setSubmitError(e.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="font-heading text-xl uppercase tracking-widest text-muted-foreground animate-pulse">Loading Event...</div>
      </div>
    );
  }

  if (notFound || !event) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <AlertCircle size={48} className="text-muted-foreground mx-auto" />
          <h2 className="text-2xl font-heading font-bold uppercase">Event Not Found</h2>
          <p className="text-muted-foreground">This registration link is invalid or the event no longer exists.</p>
          <Link href="/"><Button variant="outline">Back to Home</Button></Link>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center mx-auto">
            <CheckCircle2 size={40} className="text-green-600" />
          </div>
          <div>
            <h2 className="text-3xl font-heading font-bold uppercase tracking-tight">You're Registered!</h2>
            <p className="text-muted-foreground mt-2">Your spot is confirmed. See you at the track.</p>
          </div>
          <Card>
            <CardContent className="p-6 space-y-3 text-left">
              <div className="flex justify-between">
                <span className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Rider</span>
                <span className="font-heading font-bold">{success.riderName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Class</span>
                <span className="font-heading font-bold text-primary">{success.raceClass}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Event</span>
                <span className="font-medium text-right">{success.eventName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Confirmation #</span>
                <span className="font-mono text-sm">REG-{success.registrationId.toString().padStart(5, '0')}</span>
              </div>
            </CardContent>
          </Card>
          <Link href="/"><Button variant="outline" className="w-full font-heading uppercase">Back to Home</Button></Link>
        </div>
      </div>
    );
  }

  const isOpen = event.status === "registration_open";

  return (
    <div className="min-h-screen bg-background">
      {/* Event header */}
      <div className="bg-sidebar text-sidebar-foreground py-10 px-4">
        <div className="max-w-2xl mx-auto">
          <Link href="/" className="inline-flex items-center gap-1 text-white/60 hover:text-white text-sm mb-6 transition-colors">
            <ChevronLeft size={16} /> Back to Home
          </Link>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className="text-white/50 text-sm font-bold uppercase tracking-widest mb-1">{event.clubName}</p>
              <h1 className="text-4xl font-heading font-bold uppercase tracking-tight leading-none">{event.name}</h1>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3 text-white/70 text-sm">
                <span className="flex items-center gap-1.5"><Calendar size={14} /> {format(new Date(event.date), 'EEEE, MMMM d, yyyy')}</span>
                {event.location && <span className="flex items-center gap-1.5"><MapPin size={14} /> {event.location}, {event.state}</span>}
                {event.trackName && <span className="flex items-center gap-1.5"><Flag size={14} /> {event.trackName}</span>}
              </div>
            </div>
            {event.entryFee && (
              <div className="bg-primary rounded-md px-4 py-2 text-center shrink-0">
                <div className="text-white/70 text-xs font-bold uppercase tracking-widest">Entry Fee</div>
                <div className="text-white text-2xl font-heading font-bold">${event.entryFee}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-10">
        {!isOpen ? (
          <Card>
            <CardContent className="p-10 text-center space-y-4">
              <AlertCircle size={40} className="text-muted-foreground mx-auto" />
              <h2 className="text-2xl font-heading font-bold uppercase">Registration {event.status === "completed" || event.status === "race_day" ? "Closed" : "Not Yet Open"}</h2>
              <p className="text-muted-foreground">
                {event.status === "draft" && "Registration for this event hasn't opened yet. Check back soon."}
                {event.status === "registration_closed" && "Registration for this event is now closed."}
                {(event.status === "race_day" || event.status === "completed") && "This event has already taken place."}
              </p>
              <Link href="/results"><Button variant="outline" className="font-heading uppercase">View Race Results</Button></Link>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            <div>
              <h2 className="text-2xl font-heading font-bold uppercase">Rider Registration</h2>
              <p className="text-muted-foreground mt-1">Fill out the form below to secure your spot. A confirmation will be shown when complete.</p>
            </div>

            {submitError && (
              <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-md px-4 py-3 text-sm flex items-center gap-2">
                <AlertCircle size={16} className="shrink-0" />
                {submitError}
              </div>
            )}

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <Card>
                  <CardHeader className="pb-2 border-b">
                    <h3 className="font-heading font-bold uppercase tracking-wide text-sm text-muted-foreground">Race Class</h3>
                  </CardHeader>
                  <CardContent className="p-6">
                    <FormField
                      control={form.control}
                      name="raceClass"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Select Your Class <span className="text-destructive">*</span></FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Choose a race class" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {event.raceClasses.map(cls => (
                                <SelectItem key={cls} value={cls}>{cls}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2 border-b">
                    <h3 className="font-heading font-bold uppercase tracking-wide text-sm text-muted-foreground">Rider Info</h3>
                  </CardHeader>
                  <CardContent className="p-6 space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={form.control} name="firstName" render={({ field }) => (
                        <FormItem>
                          <FormLabel>First Name <span className="text-destructive">*</span></FormLabel>
                          <FormControl><Input placeholder="Jake" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="lastName" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Last Name <span className="text-destructive">*</span></FormLabel>
                          <FormControl><Input placeholder="Morrison" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <FormField control={form.control} name="email" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email <span className="text-destructive">*</span></FormLabel>
                        <FormControl><Input type="email" placeholder="rider@example.com" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={form.control} name="phone" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Phone</FormLabel>
                          <FormControl><Input placeholder="602-555-0100" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="dateOfBirth" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Date of Birth</FormLabel>
                          <FormControl><Input type="date" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <FormField control={form.control} name="bibNumber" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Preferred Bib Number</FormLabel>
                        <FormControl><Input placeholder="101" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2 border-b">
                    <h3 className="font-heading font-bold uppercase tracking-wide text-sm text-muted-foreground">Emergency Contact</h3>
                  </CardHeader>
                  <CardContent className="p-6 space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={form.control} name="emergencyContact" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Contact Name</FormLabel>
                          <FormControl><Input placeholder="Jane Morrison" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="emergencyPhone" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Contact Phone</FormLabel>
                          <FormControl><Input placeholder="602-555-0200" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                  </CardContent>
                </Card>

                <Button type="submit" disabled={submitting} className="w-full font-heading uppercase tracking-wider text-base h-12">
                  {submitting ? "Submitting..." : "Complete Registration →"}
                </Button>
                <p className="text-center text-xs text-muted-foreground">By registering you agree to the event's waiver and rules.</p>
              </form>
            </Form>
          </div>
        )}
      </div>
    </div>
  );
}
