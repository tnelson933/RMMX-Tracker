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
import { Checkbox } from "@/components/ui/checkbox";
import { Calendar, MapPin, Flag, CheckCircle2, AlertCircle, ChevronLeft, CreditCard, Loader2, ExternalLink, DollarSign, Mail } from "lucide-react";
import { format, parseISO } from "date-fns";

const BIKE_BRANDS = [
  { name: "KTM",       color: "#FF6600", text: "#ffffff" },
  { name: "Honda",     color: "#CC0000", text: "#ffffff" },
  { name: "Gas Gas",   color: "#E30613", text: "#ffffff" },
  { name: "Husqvarna", color: "#F5C222", text: "#000000" },
  { name: "Yamaha",    color: "#003087", text: "#ffffff" },
  { name: "Kawasaki",  color: "#3D9B35", text: "#ffffff" },
  { name: "Suzuki",    color: "#FFDE00", text: "#000000" },
  { name: "Beta",      color: "#E8220D", text: "#ffffff" },
] as const;

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
  amaNumber: z.string().optional(),
  bikeBrand: z.string().optional(),
  sponsors: z.string().optional(),
  statsEmailOptIn: z.boolean().default(false),
  rentTransponder: z.boolean().default(false),
  myLapsTransponderNumber: z.string().optional(),
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
  paymentEnabled: boolean;
  requireAma: boolean;
  clubName: string | null;
  clubLogoUrl: string | null;
  registrationOpen: string | null;
  registrationClose: string | null;
  timingTechnology: string;
  transponderRentalEnabled: boolean;
  transponderRentalFee: number | null;
}

interface SuccessData {
  registrationId: number;
  riderName: string;
  raceClass: string;
  eventName: string;
  amountPaid?: number | null;
}

interface PendingPayment {
  checkoutUrl: string;
  registrationId: number;
  sessionId: string | null;
  riderName: string;
  raceClass: string;
  eventName: string;
  entryFee: number;
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
  const [pendingPayment, setPendingPayment] = useState<PendingPayment | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [paymentCancelled, setPaymentCancelled] = useState(false);
  const [lookupState, setLookupState] = useState<"idle" | "loading" | "found" | "not_found">("idle");
  const [lookedUpName, setLookedUpName] = useState<string>("");

  const form = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      firstName: "", lastName: "", email: "", phone: "",
      dateOfBirth: "", emergencyContact: "", emergencyPhone: "",
      raceClass: "", bibNumber: "", amaNumber: "", bikeBrand: "", sponsors: "", statsEmailOptIn: false, rentTransponder: false, myLapsTransponderNumber: "",
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

  // Handle return from Stripe — payment_success=1 or payment_cancelled=1 in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const regId = params.get("reg_id");
    const sessionId = params.get("session_id");
    const isSuccess = params.get("payment_success") === "1";
    const isCancelled = params.get("payment_cancelled") === "1";

    // Clean URL params
    if (isSuccess || isCancelled) {
      window.history.replaceState({}, "", window.location.pathname);
    }

    if (isCancelled) {
      setPaymentCancelled(true);
      return;
    }

    if (isSuccess && regId && sessionId) {
      // Auto-verify payment on return from Stripe
      setVerifying(true);
      fetch(`/api/public/registrations/${regId}/verify-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.registrationId) {
            setSuccess(data);
          } else {
            // Payment may still be processing — show pending state
            setPendingPayment({
              checkoutUrl: "",
              registrationId: Number(regId),
              sessionId,
              riderName: "",
              raceClass: "",
              eventName: "",
              entryFee: 0,
            });
          }
        })
        .catch(() => {
          setSubmitError("Could not verify your payment. Please contact the event organizer with your confirmation number.");
        })
        .finally(() => setVerifying(false));
    }
  }, []);

  const verifyPayment = async (regId: number, sessionId: string | null, silent = false) => {
    if (!sessionId) return;
    if (!silent) setVerifying(true);
    try {
      const res = await fetch(`/api/public/registrations/${regId}/verify-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      if (res.ok && data.registrationId) {
        setSuccess(data);
        setPendingPayment(null);
        setSubmitError(null);
      } else if (!silent && res.status === 402) {
        setSubmitError("Payment hasn't completed yet. Finish the payment in the Stripe tab.");
      } else if (!silent && !res.ok) {
        setSubmitError(data.error || "Could not verify payment. Please try again.");
      }
    } catch {
      if (!silent) setSubmitError("Something went wrong. Please try again.");
    } finally {
      if (!silent) setVerifying(false);
    }
  };

  // Auto-poll for payment confirmation every 4 seconds while on the pending screen
  useEffect(() => {
    if (!pendingPayment?.sessionId || success) return;
    const id = setInterval(() => {
      verifyPayment(pendingPayment.registrationId, pendingPayment.sessionId, true);
    }, 4000);
    return () => clearInterval(id);
  }, [pendingPayment?.sessionId, pendingPayment?.registrationId, !!success]);

  const lookupByEmail = async (email: string) => {
    const trimmed = email.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmed)) return;
    setLookupState("loading");
    setLookedUpName("");
    try {
      const res = await fetch(`/api/public/riders/lookup?email=${encodeURIComponent(trimmed)}`);
      const data = await res.json();
      if (data.found) {
        form.setValue("firstName", data.firstName, { shouldDirty: false });
        form.setValue("lastName", data.lastName, { shouldDirty: false });
        form.setValue("phone", data.phone, { shouldDirty: false });
        form.setValue("dateOfBirth", data.dateOfBirth, { shouldDirty: false });
        form.setValue("emergencyContact", data.emergencyContact, { shouldDirty: false });
        form.setValue("emergencyPhone", data.emergencyPhone, { shouldDirty: false });
        if (data.amaNumber) form.setValue("amaNumber", data.amaNumber, { shouldDirty: false });
        if (data.bikeBrand) form.setValue("bikeBrand", data.bikeBrand, { shouldDirty: false });
        if (data.bibNumber) form.setValue("bibNumber", data.bibNumber, { shouldDirty: false });
        if (data.sponsors) form.setValue("sponsors", data.sponsors, { shouldDirty: false });
        setLookedUpName(`${data.firstName} ${data.lastName}`);
        setLookupState("found");
      } else {
        setLookupState("not_found");
      }
    } catch {
      setLookupState("not_found");
    }
  };

  const onSubmit = async (data: RegisterForm) => {
    // MyLaps events require either a transponder number or a rental
    if (event?.timingTechnology === "mylaps") {
      const hasNumber = !!data.myLapsTransponderNumber?.trim();
      const hasRental = !!data.rentTransponder;
      if (!hasNumber && !hasRental) {
        form.setError("myLapsTransponderNumber", {
          message: "Enter your MyLaps transponder number, or select a rental below.",
        });
        return;
      }
    }
    setSubmitting(true);
    setSubmitError(null);
    setPaymentCancelled(false);
    try {
      const res = await fetch(`/api/public/events/${eventId}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Registration failed");

      if (json.requiresPayment && json.checkoutUrl) {
        setPendingPayment({
          checkoutUrl: json.checkoutUrl,
          registrationId: json.registrationId,
          sessionId: json.sessionId ?? null,
          riderName: json.riderName,
          raceClass: json.raceClass,
          eventName: json.eventName,
          entryFee: json.entryFee,
        });
        // Open Stripe Checkout in a new tab
        window.open(json.checkoutUrl, "_blank");
      } else {
        setSuccess(json);
      }
    } catch (e: any) {
      setSubmitError(e.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || verifying) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="font-heading text-xl uppercase tracking-widest text-muted-foreground animate-pulse">
          {verifying ? "Verifying payment..." : "Loading Event..."}
        </div>
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
              {success.amountPaid != null && success.amountPaid > 0 && (
                <div className="flex justify-between border-t pt-3 mt-1">
                  <span className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Paid</span>
                  <span className="font-heading font-bold text-green-600">${success.amountPaid.toFixed(2)}</span>
                </div>
              )}
            </CardContent>
          </Card>
          <Link href="/"><Button variant="outline" className="w-full font-heading uppercase">Back to Home</Button></Link>
        </div>
      </div>
    );
  }

  // Payment pending screen — shown after form submit when payment is required
  if (pendingPayment && pendingPayment.checkoutUrl) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="max-w-md w-full space-y-6">
          <div className="text-center space-y-3">
            <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
              <CreditCard size={36} className="text-primary" />
            </div>
            <h2 className="text-3xl font-heading font-bold uppercase tracking-tight">Complete Payment</h2>
            <p className="text-muted-foreground">
              Your spot is reserved. Finish paying in the Stripe window — this page will update automatically once payment goes through.
            </p>
          </div>

          <Card>
            <CardContent className="p-6 space-y-3">
              {pendingPayment.riderName && (
                <div className="flex justify-between">
                  <span className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Rider</span>
                  <span className="font-heading font-bold">{pendingPayment.riderName}</span>
                </div>
              )}
              {pendingPayment.raceClass && (
                <div className="flex justify-between">
                  <span className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Class</span>
                  <span className="font-heading font-bold text-primary">{pendingPayment.raceClass}</span>
                </div>
              )}
              {pendingPayment.eventName && (
                <div className="flex justify-between">
                  <span className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Event</span>
                  <span className="font-medium text-right text-sm">{pendingPayment.eventName}</span>
                </div>
              )}
              {(pendingPayment as any).rentalFee > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Transponder Rental</span>
                  <span className="font-medium">${((pendingPayment as any).rentalFee as number).toFixed(2)}</span>
                </div>
              )}
              {pendingPayment.entryFee > 0 && (
                <div className="flex justify-between border-t pt-3 mt-1">
                  <span className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Amount Due</span>
                  <span className="font-heading font-bold text-lg">${pendingPayment.entryFee.toFixed(2)}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Auto-poll status indicator */}
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            Waiting for payment confirmation…
          </div>

          {submitError && (
            <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-md px-4 py-3 text-sm flex items-center gap-2">
              <AlertCircle size={16} className="shrink-0" />
              {submitError}
            </div>
          )}

          <div className="space-y-3">
            <Button
              className="w-full font-heading uppercase tracking-wider text-base h-12"
              onClick={() => window.open(pendingPayment.checkoutUrl, "_blank")}
            >
              <ExternalLink size={18} className="mr-2" />
              Reopen Stripe Checkout
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              onClick={() => verifyPayment(pendingPayment.registrationId, pendingPayment.sessionId)}
              disabled={verifying}
            >
              {verifying ? (
                <><Loader2 size={14} className="mr-1.5 animate-spin" /> Checking…</>
              ) : (
                "Check now"
              )}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const now = new Date();
  const openDate = event.registrationOpen ? new Date(event.registrationOpen) : null;
  const closeDate = event.registrationClose ? new Date(event.registrationClose) : null;
  const notYetOpen = openDate && now < openDate;
  const pastClose = closeDate && now > closeDate;
  const isOpen = event.status === "registration_open" && !notYetOpen && !pastClose;

  return (
    <div className="min-h-screen bg-background">
      {/* Event header */}
      <div className="bg-sidebar text-sidebar-foreground pb-10 pt-8 px-4">
        <div className="max-w-3xl mx-auto">
          <Link href="/" className="inline-flex items-center gap-1 text-white/60 hover:text-white text-sm mb-8 transition-colors">
            <ChevronLeft size={16} /> Back to Home
          </Link>

          {/* Logo / event image banner */}
          {(event.clubLogoUrl || (event as any).imageUrl) && (
            <div className="flex items-center justify-center gap-6 mb-6 flex-wrap">
              {event.clubLogoUrl && (
                <img
                  src={event.clubLogoUrl}
                  alt={event.clubName || "Club logo"}
                  className="h-56 w-auto max-w-sm object-contain drop-shadow-lg"
                />
              )}
              {(event as any).imageUrl && (
                <img
                  src={(event as any).imageUrl}
                  alt={event.name}
                  className="h-56 w-auto max-w-sm object-contain drop-shadow-lg rounded"
                />
              )}
            </div>
          )}

          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className="text-white/50 text-sm font-bold uppercase tracking-widest mb-2">{event.clubName}</p>
              <h1 className="text-4xl md:text-5xl font-heading font-bold uppercase tracking-tight leading-none">{event.name}</h1>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-4 text-white/70 text-sm">
                <span className="flex items-center gap-1.5"><Calendar size={14} /> {format(parseISO(event.date.substring(0, 10)), 'EEEE, MMMM d, yyyy')}</span>
                {event.location && <span className="flex items-center gap-1.5"><MapPin size={14} /> {event.location}, {event.state}</span>}
                {event.trackName && <span className="flex items-center gap-1.5"><Flag size={14} /> {event.trackName}</span>}
              </div>
            </div>
            {event.entryFee && (
              <div className="bg-primary rounded-md px-5 py-3 text-center shrink-0">
                <div className="text-white/70 text-xs font-bold uppercase tracking-widest">Entry Fee</div>
                <div className="text-white text-3xl font-heading font-bold">${event.entryFee}</div>
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
              <h2 className="text-2xl font-heading font-bold uppercase">
                {notYetOpen ? "Registration Not Yet Open" :
                 pastClose ? "Registration Closed" :
                 event.status === "completed" || event.status === "race_day" ? "Registration Closed" :
                 "Registration Not Yet Open"}
              </h2>
              <p className="text-muted-foreground">
                {notYetOpen && openDate && (
                  <>Registration opens <strong>{format(openDate, "EEEE, MMMM d, yyyy")}</strong>. Check back then to secure your spot.</>
                )}
                {pastClose && closeDate && !notYetOpen && (
                  <>Registration closed on <strong>{format(closeDate, "MMMM d, yyyy")}</strong>.</>
                )}
                {!notYetOpen && !pastClose && event.status === "draft" && "Registration for this event hasn't opened yet. Check back soon."}
                {!notYetOpen && !pastClose && event.status === "registration_closed" && "Registration for this event is now closed."}
                {!notYetOpen && !pastClose && (event.status === "race_day" || event.status === "completed") && "This event has already taken place."}
              </p>
              <Link href="/results"><Button variant="outline" className="font-heading uppercase">View Race Results</Button></Link>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            <div>
              <h2 className="text-2xl font-heading font-bold uppercase">Rider Registration</h2>
              <p className="text-muted-foreground mt-1">
                Fill out the form below to secure your spot.
                {event.paymentEnabled && event.entryFee && (
                  <> You'll be redirected to Stripe to pay the <strong>${event.entryFee} entry fee</strong> after submitting.</>
                )}
              </p>
            </div>

            {paymentCancelled && (
              <div className="bg-amber-500/10 border border-amber-500/30 text-amber-700 rounded-md px-4 py-3 text-sm flex items-center gap-2">
                <AlertCircle size={16} className="shrink-0" />
                Payment was cancelled. Your registration was not confirmed. Fill out the form again to try again.
              </div>
            )}

            {submitError && (
              <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-md px-4 py-3 text-sm flex items-center gap-2">
                <AlertCircle size={16} className="shrink-0" />
                {submitError}
              </div>
            )}

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                {/* Email — first question, drives rider lookup */}
                <Card>
                  <CardHeader className="pb-2 border-b">
                    <h3 className="font-heading font-bold uppercase tracking-wide text-sm text-muted-foreground">Your Email</h3>
                  </CardHeader>
                  <CardContent className="p-6 space-y-3">
                    <FormField control={form.control} name="email" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email Address <span className="text-destructive">*</span></FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            placeholder="rider@example.com"
                            {...field}
                            onBlur={e => { field.onBlur(); lookupByEmail(e.target.value); }}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    {lookupState === "loading" && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 size={14} className="animate-spin" />
                        Looking up your rider profile...
                      </div>
                    )}
                    {lookupState === "found" && (
                      <div className="flex items-center gap-2 rounded-md bg-green-50 border border-green-200 text-green-800 px-4 py-3 text-sm">
                        <CheckCircle2 size={16} className="shrink-0 text-green-600" />
                        <span>Welcome back, <strong>{lookedUpName}</strong>! Your info has been pre-filled — review and update anything that's changed.</span>
                      </div>
                    )}
                    {lookupState === "not_found" && (
                      <p className="text-xs text-muted-foreground">No existing profile found — fill in your details below and we'll create one for you.</p>
                    )}
                  </CardContent>
                </Card>

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

                {event.timingTechnology === "mylaps" && (
                  <Card className="border-primary/30 bg-primary/[0.03]">
                    <CardHeader className="pb-2 border-b">
                      <h3 className="font-heading font-bold uppercase tracking-wide text-sm text-muted-foreground">MyLaps Transponder</h3>
                    </CardHeader>
                    <CardContent className="p-6 space-y-4">
                      {/* Own transponder number */}
                      <FormField
                        control={form.control}
                        name="myLapsTransponderNumber"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>My Transponder Number</FormLabel>
                            <FormControl>
                              <Input
                                {...field}
                                placeholder="e.g. 123456789"
                                disabled={form.watch("rentTransponder")}
                                onChange={e => {
                                  field.onChange(e);
                                  if (e.target.value.trim()) {
                                    form.setValue("rentTransponder", false);
                                  }
                                }}
                              />
                            </FormControl>
                            <p className="text-xs text-muted-foreground">Enter the number printed on your personal MyLaps transponder.</p>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {/* Rental option — only when the event offers it */}
                      {event.transponderRentalEnabled && event.transponderRentalFee != null && (
                        <>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            <div className="h-px flex-1 bg-border" />
                            <span className="uppercase tracking-widest font-semibold">or</span>
                            <div className="h-px flex-1 bg-border" />
                          </div>
                          <FormField
                            control={form.control}
                            name="rentTransponder"
                            render={({ field }) => (
                              <FormItem>
                                <div className="flex items-start gap-3 rounded-lg border bg-background px-4 py-3.5">
                                  <FormControl>
                                    <Checkbox
                                      id="rent-transponder"
                                      checked={field.value}
                                      disabled={!!form.watch("myLapsTransponderNumber")?.trim()}
                                      onCheckedChange={val => {
                                        field.onChange(val);
                                        if (val) form.setValue("myLapsTransponderNumber", "");
                                      }}
                                      className="mt-0.5"
                                    />
                                  </FormControl>
                                  <div className="space-y-0.5 leading-none">
                                    <label htmlFor="rent-transponder" className="text-sm font-semibold cursor-pointer">
                                      Rent a MyLaps transponder — <span className="text-primary">${Number(event.transponderRentalFee).toFixed(2)}</span>
                                    </label>
                                    <p className="text-xs text-muted-foreground">
                                      Don't have your own? Add a rental — the transponder will be ready for you at the gate.
                                    </p>
                                  </div>
                                </div>
                              </FormItem>
                            )}
                          />
                        </>
                      )}
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader className="pb-2 border-b">
                    <h3 className="font-heading font-bold uppercase tracking-wide text-sm text-muted-foreground">Bike</h3>
                  </CardHeader>
                  <CardContent className="p-6">
                    <FormField
                      control={form.control}
                      name="bikeBrand"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Manufacturer</FormLabel>
                          <div className="grid grid-cols-4 gap-2 mt-1">
                            {BIKE_BRANDS.map(brand => {
                              const selected = field.value === brand.name;
                              return (
                                <button
                                  key={brand.name}
                                  type="button"
                                  onClick={() => field.onChange(selected ? "" : brand.name)}
                                  className="rounded-md px-2 py-3 text-sm font-bold font-heading uppercase tracking-wide transition-all border-2"
                                  style={selected
                                    ? { backgroundColor: brand.color, color: brand.text, borderColor: brand.color }
                                    : { backgroundColor: "transparent", color: "inherit", borderColor: brand.color + "60" }
                                  }
                                >
                                  {brand.name}
                                </button>
                              );
                            })}
                          </div>
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
                    {event.requireAma && (
                      <FormField control={form.control} name="amaNumber" render={({ field }) => (
                        <FormItem>
                          <FormLabel>AMA # <span className="text-destructive">*</span></FormLabel>
                          <FormControl><Input placeholder="123456" {...field} /></FormControl>
                          <p className="text-xs text-muted-foreground">Your AMA membership number is required for this event.</p>
                          <FormMessage />
                        </FormItem>
                      )} />
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2 border-b">
                    <h3 className="font-heading font-bold uppercase tracking-wide text-sm text-muted-foreground">Sponsors</h3>
                  </CardHeader>
                  <CardContent className="p-6">
                    <FormField control={form.control} name="sponsors" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Sponsors <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                        <FormControl>
                          <Input placeholder="KTM, FMF, Alpinestars" {...field} />
                        </FormControl>
                        <p className="text-xs text-muted-foreground mt-1">Separate multiple sponsors with a comma.</p>
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

                <FormField
                  control={form.control}
                  name="statsEmailOptIn"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex items-start gap-3 rounded-lg border bg-muted/40 px-4 py-3.5">
                        <FormControl>
                          <Checkbox
                            id="stats-optin"
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            className="mt-0.5"
                          />
                        </FormControl>
                        <div className="space-y-0.5 leading-none">
                          <label
                            htmlFor="stats-optin"
                            className="text-sm font-semibold cursor-pointer flex items-center gap-1.5"
                          >
                            <Mail size={14} className="text-primary shrink-0" />
                            Send me my race day stats
                          </label>
                          <p className="text-xs text-muted-foreground">
                            We'll email your results — finish position, lap times, and points — to <strong>{form.watch("email") || "your email"}</strong> once the event is complete.
                          </p>
                        </div>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button
                  type="submit"
                  disabled={submitting}
                  className="w-full font-heading uppercase tracking-wider text-base h-12"
                >
                  {submitting ? (
                    <><Loader2 size={18} className="mr-2 animate-spin" /> Processing...</>
                  ) : event.paymentEnabled && event.entryFee ? (
                    <><CreditCard size={18} className="mr-2" /> Register & Pay ${event.entryFee} →</>
                  ) : (
                    "Complete Registration →"
                  )}
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
