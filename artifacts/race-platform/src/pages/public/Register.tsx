import { useState, useEffect, useRef, useCallback } from "react";
import { useRoute, Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Calendar, MapPin, Flag, CheckCircle2, AlertCircle, ChevronLeft, CreditCard, Loader2, ExternalLink, DollarSign, Mail, Tag, X as XIcon, FileText, ShieldCheck, Users, ZoomIn, HelpCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { format, parseISO } from "date-fns";
import { formatEventDatesFull } from "@/lib/eventDates";

// ─── PDF Scroll Viewer ───────────────────────────────────────────────────────
// Renders each PDF page as a canvas inside a scrollable div so scroll-to-bottom
// tracking works the same way as the plain-text waiver modal.

function PdfScrollViewer({ url, onScrolledToBottom }: { url: string; onScrolledToBottom: () => void }) {
  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pdfDocRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  // Phase 1 — load the PDF document and get page count
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNumPages(0);
    pdfDocRef.current = null;
    canvasRefs.current = [];
    (async () => {
      try {
        const pdfjsLib: any = await import("pdfjs-dist");
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
          // Use a CDN-hosted worker that is guaranteed to be loadable as a
          // standalone module worker regardless of Vite bundling config.
          pdfjsLib.GlobalWorkerOptions.workerSrc =
            `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
        }
        // Pre-fetch as ArrayBuffer so pdfjs never has to issue its own XHR
        // (avoids range-request issues behind the Replit proxy).
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.arrayBuffer();
        if (cancelled) return;
        const doc = await pdfjsLib.getDocument({ data }).promise;
        if (cancelled) return;
        pdfDocRef.current = doc;
        setNumPages(doc.numPages);
        setLoading(false);
      } catch (err) {
        console.error("[PdfScrollViewer] load error:", err);
        if (!cancelled) { setError("Could not load the PDF. Please try again."); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  // Phase 2 — render each page onto its canvas once they are mounted
  useEffect(() => {
    if (!pdfDocRef.current || numPages === 0) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < numPages; i++) {
        if (cancelled) break;
        const canvas = canvasRefs.current[i];
        if (!canvas) continue;
        try {
          const page = await pdfDocRef.current.getPage(i + 1);
          const vp = page.getViewport({ scale: 1.5 });
          canvas.width = vp.width;
          canvas.height = vp.height;
          await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
        } catch { /* skip broken page */ }
      }
      // check if all pages fit without scrolling
      if (!cancelled) {
        const el = containerRef.current;
        if (el && el.scrollHeight <= el.clientHeight + 40) onScrolledToBottom();
      }
    })();
    return () => { cancelled = true; };
  }, [numPages, onScrolledToBottom]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop <= el.clientHeight + 40) onScrolledToBottom();
  };

  return (
    <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-6 py-4 space-y-3" style={{ minHeight: 0 }}>
      {loading && (
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          <Loader2 size={18} className="animate-spin mr-2" /> Loading document…
        </div>
      )}
      {error && <div className="py-8 text-center text-sm text-destructive">{error}</div>}
      {!loading && !error && Array.from({ length: numPages }, (_, i) => (
        <canvas
          key={i}
          ref={el => { canvasRefs.current[i] = el; }}
          className="w-full block rounded border border-border shadow-sm"
        />
      ))}
    </div>
  );
}


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
  streetAddress: z.string().optional(),
  city: z.string().optional(),
  homeState: z.string().optional(),
  zip: z.string().optional(),
  selectedClasses: z.array(z.string()).min(1, "Select at least one class"),
  bibNumber: z.string().optional(),
  amaNumber: z.string().optional(),
  clubIdNumber: z.string().optional(),
  bikeBrand: z.string().optional(),
  bikeModel: z.string().optional(),
  bikeYear: z.string().optional(),
  sponsors: z.string().optional(),
  statsEmailOptIn: z.boolean().default(false),
  rentTransponder: z.boolean().default(false),
  purchaseRfidSticker: z.boolean().default(false),
  myLapsTransponderNumber: z.string().optional(),
  selectedPurchaseOptions: z.array(z.string()).default([]),
});

type RegisterForm = z.infer<typeof registerSchema>;

interface EventInfo {
  id: number;
  name: string;
  date: string;
  endDate?: string | null;
  state: string;
  location: string | null;
  trackName: string | null;
  raceClasses: string[];
  classDetails?: Record<string, string>;
  status: string;
  entryFee: number | null;
  earlyBirdFee?: number | null;
  earlyBirdEndsAt?: string | null;
  paymentEnabled: boolean;
  requireAma: boolean;
  requireClubId: boolean;
  requireWaiver: boolean;
  requireTransponder: boolean;
  waiverText: string | null;
  waiverPdfUrl?: string | null;
  clubName: string | null;
  clubLogoUrl: string | null;
  registrationOpen: string | null;
  registrationClose: string | null;
  timingTechnology: string;
  transponderRentalEnabled: boolean;
  transponderRentalFee: number | null;
  rfidStickerFee: number | null;
  noDuplicateBibs: boolean;
  purchaseOptions?: Array<{ id: string; name: string; amount: number }>;
}

interface SuccessData {
  registrationId: number;
  riderName: string;
  raceClasses: string[];
  eventName: string;
  amountPaid?: number | null;
}

interface PendingPayment {
  checkoutUrl: string;
  registrationId: number;
  sessionId: string | null;
  riderName: string;
  raceClasses: string[];
  eventName: string;
  entryFee: number;
}

interface RiderOption {
  id: number;
  firstName: string;
  lastName: string;
  phone: string;
  dateOfBirth: string;
  emergencyContact: string;
  emergencyPhone: string;
  streetAddress: string;
  city: string;
  homeState: string;
  zip: string;
  amaNumber: string;
  clubIdNumber: string;
  bikeBrand: string;
  bikeModel: string;
  bikeYear: string;
  bibNumber: string;
  sponsors: string;
}

const DESKTOP_CLOUD_URL = import.meta.env.VITE_CLOUD_URL as string | undefined;

export default function Register() {
  const [, params] = useRoute("/register/:eventId");
  const eventId = params?.eventId;

  // When running inside the desktop app (VITE_CLOUD_URL is baked in) and this
  // page was opened on the local server (127.0.0.1), immediately redirect the
  // visitor to the cloud registration page so they can actually sign up.
  useEffect(() => {
    if (!DESKTOP_CLOUD_URL || !eventId) return;
    try {
      const cloudOrigin = new URL(DESKTOP_CLOUD_URL).origin;
      if (window.location.origin !== cloudOrigin) {
        window.location.replace(`${cloudOrigin}/register/${eventId}`);
      }
    } catch {
      // malformed VITE_CLOUD_URL — ignore and render normally
    }
  }, [eventId]);

  const [event, setEvent] = useState<EventInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<SuccessData | null>(null);
  const [imageLightboxOpen, setImageLightboxOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingPayment, setPendingPayment] = useState<PendingPayment | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [paymentCancelled, setPaymentCancelled] = useState(false);
  const [lookupState, setLookupState] = useState<"idle" | "loading" | "found" | "not_found" | "pick">("idle");
  const [lookedUpName, setLookedUpName] = useState<string>("");
  const [riderOptions, setRiderOptions] = useState<RiderOption[] | null>(null);
  const autoLookupFiredRef = useRef(false);
  const [alreadyRegisteredClasses, setAlreadyRegisteredClasses] = useState<Set<string>>(new Set());

  const [compCodeInput, setCompCodeInput] = useState("");
  const [appliedComp, setAppliedComp] = useState<{ code: string; amount: number; discountType: "fixed" | "percentage" } | null>(null);
  const [compApplying, setCompApplying] = useState(false);
  const [compError, setCompError] = useState<string | null>(null);

  const [bibCheckState, setBibCheckState] = useState<"idle" | "checking" | "taken" | "available">("idle");
  const [selectedRiderId, setSelectedRiderId] = useState<number | null>(null);

  // Waiver state
  const [waiverModalOpen, setWaiverModalOpen] = useState(false);
  const [pdfWaiverModalOpen, setPdfWaiverModalOpen] = useState(false);
  const [pdfWaiverChecked, setPdfWaiverChecked] = useState(false);
  const [pdfScrolledToBottom, setPdfScrolledToBottom] = useState(false);
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const [waiverScrolledToBottom, setWaiverScrolledToBottom] = useState(false);
  const [waiverTimestamp, setWaiverTimestamp] = useState<string | null>(null);
  const waiverScrollRef = useRef<HTMLDivElement>(null);

  const handleWaiverScroll = useCallback(() => {
    const el = waiverScrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 40;
    if (atBottom) setWaiverScrolledToBottom(true);
  }, []);

  // If the waiver text is short enough that no scrolling is needed, unlock immediately
  const checkWaiverScrollable = useCallback(() => {
    const el = waiverScrollRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 40) setWaiverScrolledToBottom(true);
  }, []);

  // Auto-unlock when the modal opens if the content fits without scrolling
  useEffect(() => {
    if (!waiverModalOpen) return;
    // Give the dialog one frame to render before measuring
    const id = requestAnimationFrame(() => checkWaiverScrollable());
    return () => cancelAnimationFrame(id);
  }, [waiverModalOpen, checkWaiverScrollable]);

  const handleAcceptWaiver = () => {
    const ts = new Date().toISOString();
    setWaiverTimestamp(ts);
    setWaiverAccepted(true);
    setWaiverModalOpen(false);
    setPdfWaiverModalOpen(false);
    setPdfWaiverChecked(false);
    setPdfScrolledToBottom(false);
  };

  const handleApplyComp = async () => {
    const code = compCodeInput.trim().toUpperCase();
    if (!code) return;
    setCompApplying(true);
    setCompError(null);
    try {
      const res = await fetch(`/api/public/events/${eventId}/validate-comp-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const json = await res.json();
      if (!res.ok || !json.valid) {
        setCompError(json.error || "Invalid discount code");
        setAppliedComp(null);
      } else {
        setAppliedComp({ code, amount: json.amount, discountType: json.discountType ?? "fixed" });
        setCompError(null);
      }
    } catch {
      setCompError("Could not validate code. Please try again.");
    } finally {
      setCompApplying(false);
    }
  };

  const form = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      firstName: "", lastName: "", email: "", phone: "",
      dateOfBirth: "", emergencyContact: "", emergencyPhone: "",
      streetAddress: "", city: "", homeState: "", zip: "",
      selectedClasses: [], bibNumber: "", amaNumber: "", clubIdNumber: "", bikeBrand: "", bikeModel: "", bikeYear: "", sponsors: "", statsEmailOptIn: false, rentTransponder: false, purchaseRfidSticker: false, myLapsTransponderNumber: "", selectedPurchaseOptions: [],
    },
  });

  // Auto-populate form when arriving from the rider app or web portal with ?email=
  useEffect(() => {
    if (autoLookupFiredRef.current || loading || !event) return;
    const urlParams = new URLSearchParams(window.location.search);
    const prefillEmail = urlParams.get("email");
    if (!prefillEmail) return;
    autoLookupFiredRef.current = true;
    form.setValue("email", prefillEmail);
    void lookupByEmail(prefillEmail);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, event]);

  useEffect(() => {
    if (!eventId) return;
    fetch(`/api/public/events/${eventId}/register-info`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((json: any) => setEvent({
        ...json,
        entryFee: json.entryFee != null ? Number(json.entryFee) : null,
        earlyBirdFee: json.earlyBirdFee != null ? Number(json.earlyBirdFee) : null,
        earlyBirdEndsAt: json.earlyBirdEndsAt ?? null,
        waiverPdfUrl: json.waiverPdfUrl ?? null,
        transponderRentalFee: json.transponderRentalFee != null ? Number(json.transponderRentalFee) : null,
        rfidStickerFee: json.rfidStickerFee != null ? Number(json.rfidStickerFee) : null,
        purchaseOptions: (json.purchaseOptions ?? []).map((o: any) => ({ ...o, amount: Number(o.amount) })),
      }))
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [eventId]);

  const watchedBib = form.watch("bibNumber");
  const watchedPurchaseOptions = form.watch("selectedPurchaseOptions");
  const watchedRentTransponder = form.watch("rentTransponder");
  const watchedPurchaseRfidSticker = form.watch("purchaseRfidSticker");
  const watchedSelectedClasses = form.watch("selectedClasses");
  const numSelectedClasses = (watchedSelectedClasses ?? []).length;
  const selectedPurchasesTotal = (event?.purchaseOptions ?? [])
    .filter(o => (watchedPurchaseOptions ?? []).includes(o.id))
    .reduce((sum, o) => sum + Number(o.amount), 0);
  const rentalTotal = (watchedRentTransponder && event?.transponderRentalEnabled && event?.transponderRentalFee != null)
    ? Number(event.transponderRentalFee)
    : 0;
  const rfidStickerTotal = (watchedPurchaseRfidSticker && event?.timingTechnology === "rfid" && event?.rfidStickerFee != null)
    ? Number(event.rfidStickerFee)
    : 0;
  const today = new Date().toISOString().substring(0, 10);
  const earlyBirdActive = !!(event?.earlyBirdEndsAt && today <= event.earlyBirdEndsAt && event?.earlyBirdFee != null);
  const effectiveEntryFee = earlyBirdActive ? (event?.earlyBirdFee ?? null) : (event?.entryFee ?? null);
  const totalEntryFees = (effectiveEntryFee ?? 0) * Math.max(1, numSelectedClasses);
  const compDiscountDollars = appliedComp && effectiveEntryFee
    ? (appliedComp.discountType === "percentage"
      ? totalEntryFees * appliedComp.amount / 100
      : appliedComp.amount)
    : 0;
  const totalDue = event?.paymentEnabled && effectiveEntryFee
    ? Math.max(0, (effectiveEntryFee * Math.max(1, numSelectedClasses)) + selectedPurchasesTotal + rentalTotal + rfidStickerTotal - compDiscountDollars)
    : 0;

  useEffect(() => {
    if (!event?.noDuplicateBibs) { setBibCheckState("idle"); return; }
    const bib = (watchedBib ?? "").trim();
    if (!bib) { setBibCheckState("idle"); return; }
    setBibCheckState("checking");
    const timer = setTimeout(() => {
      fetch(`/api/public/events/${eventId}/check-bib?bib=${encodeURIComponent(bib)}`)
        .then(r => r.json())
        .then(data => setBibCheckState(data.taken ? "taken" : "available"))
        .catch(() => setBibCheckState("idle"));
    }, 400);
    return () => clearTimeout(timer);
  }, [watchedBib, eventId, event?.noDuplicateBibs]);

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
              raceClasses: [],
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

  const populateFromRider = (rider: RiderOption) => {
    setSelectedRiderId(rider.id ?? null);
    form.setValue("firstName", rider.firstName, { shouldDirty: false });
    form.setValue("lastName", rider.lastName, { shouldDirty: false });
    form.setValue("phone", rider.phone, { shouldDirty: false });
    form.setValue("dateOfBirth", rider.dateOfBirth, { shouldDirty: false });
    form.setValue("emergencyContact", rider.emergencyContact, { shouldDirty: false });
    form.setValue("emergencyPhone", rider.emergencyPhone, { shouldDirty: false });
    if (rider.streetAddress) form.setValue("streetAddress", rider.streetAddress, { shouldDirty: false });
    if (rider.city) form.setValue("city", rider.city, { shouldDirty: false });
    if (rider.homeState) form.setValue("homeState", rider.homeState, { shouldDirty: false });
    if (rider.zip) form.setValue("zip", rider.zip, { shouldDirty: false });
    if (rider.amaNumber) form.setValue("amaNumber", rider.amaNumber, { shouldDirty: false });
    if (rider.clubIdNumber) form.setValue("clubIdNumber", rider.clubIdNumber, { shouldDirty: false });
    if (rider.bikeBrand) form.setValue("bikeBrand", rider.bikeBrand, { shouldDirty: false });
    if (rider.bikeModel) form.setValue("bikeModel", rider.bikeModel, { shouldDirty: false });
    if (rider.bikeYear) form.setValue("bikeYear", rider.bikeYear, { shouldDirty: false });
    if (rider.bibNumber) form.setValue("bibNumber", rider.bibNumber, { shouldDirty: false });
    if (rider.sponsors) form.setValue("sponsors", rider.sponsors, { shouldDirty: false });
    setLookedUpName(`${rider.firstName} ${rider.lastName}`);
    setLookupState("found");
    setRiderOptions(null);
    // Fetch which classes this rider is already registered for at this event
    if (eventId && rider.id) {
      fetch(`/api/public/events/${eventId}/rider-classes?riderId=${rider.id}`)
        .then(r => r.json())
        .then((d: { registeredClasses?: string[] }) => {
          if (d.registeredClasses?.length) {
            setAlreadyRegisteredClasses(new Set(d.registeredClasses));
          }
        })
        .catch(() => {});
    }
  };

  const lookupByEmail = async (email: string) => {
    const trimmed = email.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmed)) return;
    setLookupState("loading");
    setLookedUpName("");
    setRiderOptions(null);
    try {
      const res = await fetch(`/api/public/riders/lookup?email=${encodeURIComponent(trimmed)}`);
      const data = await res.json();
      if (!data.found) {
        setLookupState("not_found");
        return;
      }
      if (data.count === 1) {
        populateFromRider(data.riders[0]);
      } else {
        setRiderOptions(data.riders);
        setLookupState("pick");
      }
    } catch {
      setLookupState("not_found");
    }
  };

  const onSubmit = async (data: RegisterForm) => {
    // Client-side enforcement of event-level required fields
    if (event?.requireAma && !data.amaNumber?.trim()) {
      form.setError("amaNumber", { message: "AMA # is required for this event" });
      return;
    }
    if (event?.requireClubId && !data.clubIdNumber?.trim()) {
      form.setError("clubIdNumber", { message: "Club ID # is required for this event" });
      return;
    }
    if (event?.requireWaiver && !waiverAccepted) {
      setSubmitError("You must read and accept the club waiver before registering.");
      return;
    }
    // MyLaps events: require transponder number or rental only when requireTransponder is true
    if (event?.timingTechnology === "mylaps" && event.requireTransponder) {
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
      const { selectedClasses, ...rest } = data;
      const res = await fetch(`/api/public/events/${eventId}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...rest,
          raceClasses: selectedClasses,
          selectedPurchaseOptions: (event?.purchaseOptions ?? []).filter(o => data.selectedPurchaseOptions.includes(o.id)),
          compCode: appliedComp?.code ?? null,
          waiverAcknowledgedAt: waiverAccepted ? waiverTimestamp : null,
          waiverSnapshot: waiverAccepted ? (event?.waiverText ?? null) : null,
          ...(selectedRiderId ? { riderId: selectedRiderId } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Registration failed");

      if (json.requiresPayment && json.checkoutUrl) {
        setPendingPayment({
          checkoutUrl: json.checkoutUrl,
          registrationId: json.registrationId,
          sessionId: json.sessionId ?? null,
          riderName: json.riderName,
          raceClasses: json.raceClasses ?? (json.raceClass ? [json.raceClass] : []),
          eventName: json.eventName,
          entryFee: Number(json.entryFee),
        });
        // Open Stripe Checkout in a new tab
        window.open(json.checkoutUrl, "_blank");
      } else {
        setSuccess({ ...json, amountPaid: json.amountPaid != null ? Number(json.amountPaid) : null });
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
                <span className="text-sm font-bold text-muted-foreground uppercase tracking-widest">
                  {(success.raceClasses?.length ?? 1) > 1 ? "Classes" : "Class"}
                </span>
                <span className="font-heading font-bold text-primary text-right">
                  {(success.raceClasses ?? []).join(", ")}
                </span>
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
              {(pendingPayment.raceClasses?.length ?? 0) > 0 && (
                <div className="flex justify-between">
                  <span className="text-sm font-bold text-muted-foreground uppercase tracking-widest">
                    {(pendingPayment.raceClasses?.length ?? 1) > 1 ? "Classes" : "Class"}
                  </span>
                  <span className="font-heading font-bold text-primary text-right">
                    {(pendingPayment.raceClasses ?? []).join(", ")}
                  </span>
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
                <button
                  type="button"
                  onClick={() => setImageLightboxOpen(true)}
                  className="relative group cursor-zoom-in focus:outline-none"
                  aria-label="Enlarge event image"
                >
                  <img
                    src={(event as any).imageUrl}
                    alt={event.name}
                    className="h-56 w-auto max-w-sm object-contain drop-shadow-lg rounded transition-opacity group-hover:opacity-80"
                  />
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="bg-black/70 text-white text-xs font-medium px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-lg">
                      <ZoomIn size={13} /> Click to enlarge
                    </div>
                  </div>
                </button>
              )}
            </div>
          )}

          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className="text-white/50 text-sm font-bold uppercase tracking-widest mb-2">{event.clubName}</p>
              <h1 className="text-4xl md:text-5xl font-heading font-bold uppercase tracking-tight leading-none">{event.name}</h1>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-4 text-white/70 text-sm">
                <span className="flex items-center gap-1.5"><Calendar size={14} /> {formatEventDatesFull(event.date, event.endDate)}</span>
                {event.location && <span className="flex items-center gap-1.5"><MapPin size={14} /> {event.location}, {event.state}</span>}
                {event.trackName && <span className="flex items-center gap-1.5"><Flag size={14} /> {event.trackName}</span>}
              </div>
            </div>
            {effectiveEntryFee != null && (
              <div className="bg-primary rounded-md px-5 py-3 text-center shrink-0">
                {earlyBirdActive && (
                  <div className="text-yellow-300 text-[10px] font-bold uppercase tracking-widest mb-0.5">🐦 Early Bird</div>
                )}
                <div className="text-white/70 text-xs font-bold uppercase tracking-widest">Entry Fee</div>
                <div className="text-white text-3xl font-heading font-bold">${effectiveEntryFee}</div>
                {earlyBirdActive && event?.entryFee && (
                  <div className="text-white/60 text-[10px] mt-0.5 line-through">${event.entryFee} after {event.earlyBirdEndsAt}</div>
                )}
                {event.raceClasses.length > 1 && (
                  <div className="text-white/60 text-xs mt-0.5">per class</div>
                )}
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
                {event.paymentEnabled && effectiveEntryFee && (
                  <> You'll be redirected to Stripe to pay the <strong>${effectiveEntryFee} entry fee</strong> after submitting.</>
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
                    {lookupState === "pick" && riderOptions && (
                      <div className="rounded-md border border-primary/30 bg-primary/5 p-4 space-y-3">
                        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                          <Users size={15} className="text-primary shrink-0" />
                          Multiple rider profiles found — select yours:
                        </div>
                        <div className="space-y-2">
                          {riderOptions.map(rider => (
                            <button
                              key={rider.id}
                              type="button"
                              onClick={() => populateFromRider(rider)}
                              className="w-full text-left rounded-lg border border-border bg-background px-4 py-3 hover:border-primary hover:bg-primary/5 transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
                            >
                              <div className="font-semibold text-sm">{rider.firstName} {rider.lastName}</div>
                              {(rider.city || rider.homeState) && (
                                <div className="text-xs text-muted-foreground mt-0.5">
                                  {[rider.city, rider.homeState].filter(Boolean).join(", ")}
                                  {rider.bibNumber ? ` · #${rider.bibNumber}` : ""}
                                </div>
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {lookupState === "not_found" && (
                      <p className="text-xs text-muted-foreground">No existing profile found — fill in your details below and we'll create one for you.</p>
                    )}
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
                          <FormControl><Input type="text" inputMode="numeric" placeholder="MM/DD/YYYY" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <FormField control={form.control} name="streetAddress" render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center justify-between">
                          <FormLabel>Street Address</FormLabel>
                          <span className="text-[10px] text-muted-foreground">Saved to your profile for next time</span>
                        </div>
                        <FormControl><Input placeholder="123 Dirt Track Rd" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="grid grid-cols-3 gap-4">
                      <FormField control={form.control} name="city" render={({ field }) => (
                        <FormItem className="col-span-1">
                          <FormLabel>City</FormLabel>
                          <FormControl><Input placeholder="Tucson" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="homeState" render={({ field }) => (
                        <FormItem>
                          <FormLabel>State</FormLabel>
                          <FormControl><Input placeholder="AZ" maxLength={2} {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="zip" render={({ field }) => (
                        <FormItem>
                          <FormLabel>ZIP</FormLabel>
                          <FormControl><Input placeholder="85701" maxLength={10} {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <FormField control={form.control} name="bibNumber" render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Preferred #
                          {event?.noDuplicateBibs && <span className="text-destructive ml-1">*</span>}
                        </FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Input placeholder="101" {...field} className={bibCheckState === "taken" ? "border-destructive pr-8" : bibCheckState === "available" ? "border-green-500 pr-8" : ""} />
                            {bibCheckState === "checking" && <Loader2 size={14} className="absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground" />}
                            {bibCheckState === "taken" && <AlertCircle size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-destructive" />}
                            {bibCheckState === "available" && <CheckCircle2 size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500" />}
                          </div>
                        </FormControl>
                        {bibCheckState === "taken" && <p className="text-xs text-destructive">#{field.value} is already taken for this event</p>}
                        {bibCheckState === "available" && <p className="text-xs text-green-600">#{field.value} is available</p>}
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
                    {event.requireClubId && (
                      <FormField control={form.control} name="clubIdNumber" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Club ID # <span className="text-destructive">*</span></FormLabel>
                          <FormControl><Input placeholder="Club membership number" {...field} /></FormControl>
                          <p className="text-xs text-muted-foreground">Your club membership ID is required for this event.</p>
                          <FormMessage />
                        </FormItem>
                      )} />
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
                      name="selectedClasses"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            {event.raceClasses.length > 1 ? "Select Your Class(es)" : "Select Your Class"}
                            {" "}<span className="text-destructive">*</span>
                          </FormLabel>
                          {event.raceClasses.length > 1 && (
                            <p className="text-xs text-muted-foreground mt-0.5 mb-2">You can enter multiple classes — each costs one entry fee.</p>
                          )}
                          <div className="space-y-2 mt-1">
                            {event.raceClasses.map(cls => {
                              const alreadyIn = alreadyRegisteredClasses.has(cls);
                              return (
                              <div key={cls} className={`flex items-center gap-3 rounded-lg border px-4 py-3.5 ${alreadyIn ? "bg-muted/60 opacity-60 cursor-not-allowed" : "bg-background"}`}>
                                <FormControl>
                                  <Checkbox
                                    id={`class-${cls}`}
                                    checked={alreadyIn || (field.value ?? []).includes(cls)}
                                    disabled={alreadyIn}
                                    onCheckedChange={checked => {
                                      if (alreadyIn) return;
                                      const current = field.value ?? [];
                                      if (checked) {
                                        field.onChange([...current, cls]);
                                      } else {
                                        field.onChange(current.filter((c: string) => c !== cls));
                                      }
                                    }}
                                    className="mt-0.5"
                                  />
                                </FormControl>
                                <label htmlFor={`class-${cls}`} className={`text-sm font-semibold flex items-center justify-between flex-1 ${alreadyIn ? "cursor-not-allowed" : "cursor-pointer"}`}>
                                  <span className="flex items-center gap-1.5">
                                    {cls}
                                    {event.classDetails?.[cls] && (
                                      <TooltipProvider>
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <span onClick={e => e.preventDefault()} className="cursor-help">
                                              <HelpCircle className="h-3.5 w-3.5 text-muted-foreground hover:text-primary transition-colors" />
                                            </span>
                                          </TooltipTrigger>
                                          <TooltipContent className="max-w-xs text-sm whitespace-pre-wrap" side="right">
                                            {event.classDetails[cls]}
                                          </TooltipContent>
                                        </Tooltip>
                                      </TooltipProvider>
                                    )}
                                  </span>
                                  {alreadyIn ? (
                                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Already registered</span>
                                  ) : event.paymentEnabled && effectiveEntryFee ? (
                                    <span className="flex items-center gap-1.5">
                                      {earlyBirdActive && event.entryFee && (
                                        <span className="text-muted-foreground line-through text-sm">${event.entryFee.toFixed(2)}</span>
                                      )}
                                      <span className="text-primary font-bold">${effectiveEntryFee.toFixed(2)}</span>
                                    </span>
                                  ) : null}
                                </label>
                              </div>
                              );
                            })}
                          </div>
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

                {/* RFID Sticker */}
                {event.timingTechnology === "rfid" && event.rfidStickerFee != null && (
                  <Card className="border-primary/30 bg-primary/[0.03]">
                    <CardHeader className="pb-2 border-b">
                      <h3 className="font-heading font-bold uppercase tracking-wide text-sm text-muted-foreground">RFID Sticker</h3>
                    </CardHeader>
                    <CardContent className="p-6">
                      <FormField
                        control={form.control}
                        name="purchaseRfidSticker"
                        render={({ field }) => (
                          <FormItem>
                            <div className="flex items-start gap-3 rounded-lg border bg-background px-4 py-3.5">
                              <FormControl>
                                <Checkbox
                                  id="purchase-rfid-sticker"
                                  checked={field.value}
                                  onCheckedChange={field.onChange}
                                  className="mt-0.5"
                                />
                              </FormControl>
                              <div className="space-y-0.5 leading-none">
                                <label htmlFor="purchase-rfid-sticker" className="text-sm font-semibold cursor-pointer">
                                  I need an RFID sticker — <span className="text-primary">${Number(event.rfidStickerFee).toFixed(2)}</span>
                                </label>
                                <p className="text-xs text-muted-foreground">
                                  Required to be timed during the event. Add one if you don't already have an RFID sticker from this club.
                                </p>
                              </div>
                            </div>
                          </FormItem>
                        )}
                      />
                    </CardContent>
                  </Card>
                )}

                {/* Purchase Options */}
                {(event.purchaseOptions ?? []).length > 0 && (
                  <Card>
                    <CardHeader className="pb-2 border-b">
                      <h3 className="font-heading font-bold uppercase tracking-wide text-sm text-muted-foreground">Add-ons</h3>
                    </CardHeader>
                    <CardContent className="p-6 space-y-3">
                      {(event.purchaseOptions ?? []).map(opt => (
                        <FormField
                          key={opt.id}
                          control={form.control}
                          name="selectedPurchaseOptions"
                          render={({ field }) => (
                            <FormItem>
                              <div className="flex items-start gap-3 rounded-lg border bg-background px-4 py-3.5">
                                <FormControl>
                                  <Checkbox
                                    id={`opt-${opt.id}`}
                                    checked={field.value.includes(opt.id)}
                                    onCheckedChange={checked => {
                                      if (checked) {
                                        field.onChange([...field.value, opt.id]);
                                      } else {
                                        field.onChange(field.value.filter((id: string) => id !== opt.id));
                                      }
                                    }}
                                    className="mt-0.5"
                                  />
                                </FormControl>
                                <div className="space-y-0.5 leading-none flex-1">
                                  <label htmlFor={`opt-${opt.id}`} className="text-sm font-semibold cursor-pointer flex items-center justify-between">
                                    <span>{opt.name}</span>
                                    <span className="text-primary">${Number(opt.amount).toFixed(2)}</span>
                                  </label>
                                </div>
                              </div>
                            </FormItem>
                          )}
                        />
                      ))}
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
                          <input
                            type="text"
                            placeholder="Other brand (e.g. Sherco, TM, Rieju…)"
                            value={BIKE_BRANDS.some(b => b.name === field.value) ? "" : (field.value ?? "")}
                            onChange={e => field.onChange(e.target.value)}
                            className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="grid grid-cols-2 gap-3 mt-4">
                      <FormField control={form.control} name="bikeModel" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Model</FormLabel>
                          <FormControl><Input placeholder="450 SX-F, CRF450R…" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="bikeYear" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Year</FormLabel>
                          <FormControl><Input placeholder="2024" maxLength={4} {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
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

                {/* Discount Code */}
                {event.paymentEnabled && event.entryFee && (
                  <div className="rounded-lg border bg-muted/40 px-4 py-3.5 space-y-2">
                    <p className="text-sm font-semibold flex items-center gap-1.5">
                      <Tag size={14} className="text-primary shrink-0" />
                      Have a discount code?
                    </p>
                    {appliedComp ? (
                      <div className="flex items-center justify-between rounded bg-green-50 border border-green-200 px-3 py-2">
                        <div className="text-sm text-green-700">
                          <span className="font-mono font-bold tracking-widest">{appliedComp.code}</span>
                          <span className="ml-2">— {appliedComp.discountType === "percentage" ? `${appliedComp.amount.toFixed(0)}% off` : `$${appliedComp.amount.toFixed(2)} off`}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => { setAppliedComp(null); setCompCodeInput(""); }}
                          className="text-green-600 hover:text-green-800 transition-colors ml-2"
                        >
                          <XIcon size={16} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <Input
                          value={compCodeInput}
                          onChange={e => { setCompCodeInput(e.target.value.toUpperCase()); setCompError(null); }}
                          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleApplyComp(); } }}
                          placeholder="Enter discount code…"
                          className="h-9 text-sm font-mono tracking-widest flex-1"
                          disabled={compApplying}
                        />
                        <Button
                          type="button"
                          size="sm"
                          className="h-9 font-heading uppercase px-4"
                          onClick={handleApplyComp}
                          disabled={compApplying || !compCodeInput.trim()}
                        >
                          {compApplying ? <Loader2 size={14} className="animate-spin" /> : "Apply"}
                        </Button>
                      </div>
                    )}
                    {compError && <p className="text-xs text-red-500">{compError}</p>}
                    {(selectedPurchasesTotal > 0 || rentalTotal > 0 || rfidStickerTotal > 0 || appliedComp || numSelectedClasses > 1) && effectiveEntryFee && (
                      <div className="border-t pt-2 mt-1 space-y-1.5">
                        <div className="text-xs text-muted-foreground flex justify-between">
                          <span>
                            {numSelectedClasses > 1
                              ? `Entry fee (${numSelectedClasses} classes × $${effectiveEntryFee.toFixed(2)})${earlyBirdActive ? " 🐦" : ""}`
                              : earlyBirdActive ? "Entry fee (early bird)" : "Entry fee"}
                          </span>
                          <span>${(effectiveEntryFee * Math.max(1, numSelectedClasses)).toFixed(2)}</span>
                        </div>
                        {(event.purchaseOptions ?? []).filter(o => (watchedPurchaseOptions ?? []).includes(o.id)).map(o => (
                          <div key={o.id} className="text-xs text-muted-foreground flex justify-between">
                            <span>{o.name}</span><span>${Number(o.amount).toFixed(2)}</span>
                          </div>
                        ))}
                        {rentalTotal > 0 && (
                          <div className="text-xs text-muted-foreground flex justify-between">
                            <span>Transponder rental</span><span>${rentalTotal.toFixed(2)}</span>
                          </div>
                        )}
                        {rfidStickerTotal > 0 && (
                          <div className="text-xs text-muted-foreground flex justify-between">
                            <span>RFID sticker</span><span>${rfidStickerTotal.toFixed(2)}</span>
                          </div>
                        )}
                        {appliedComp && (
                          <div className="text-xs text-green-700 flex justify-between">
                            <span>Discount code ({appliedComp.code})</span>
                            <span>−{appliedComp.discountType === "percentage"
                              ? `${appliedComp.amount.toFixed(0)}% ($${compDiscountDollars.toFixed(2)})`
                              : `$${compDiscountDollars.toFixed(2)}`
                            }</span>
                          </div>
                        )}
                        <div className="text-sm font-bold flex justify-between border-t pt-1.5">
                          <span>Total due</span>
                          <span>{totalDue === 0 ? "FREE" : `$${totalDue.toFixed(2)}`}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Waiver acknowledgment */}
                {event.requireWaiver && (event.waiverText || event.waiverPdfUrl) && (
                  <div className={`rounded-lg border px-4 py-4 space-y-3 transition-colors ${waiverAccepted ? "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800" : "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-700"}`}>
                    <div className="flex items-start gap-3">
                      <FileText size={18} className={`mt-0.5 shrink-0 ${waiverAccepted ? "text-green-600" : "text-amber-600"}`} />
                      <div className="flex-1 space-y-1">
                        <p className="text-sm font-semibold">
                          {waiverAccepted ? "Waiver Accepted" : "Club Waiver Required"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {waiverAccepted
                            ? `Accepted on ${waiverTimestamp ? format(new Date(waiverTimestamp), "MMM d, yyyy 'at' h:mm a") : "—"}`
                            : "You must read and acknowledge the club waiver before registering."}
                        </p>
                      </div>
                      {waiverAccepted && <ShieldCheck size={18} className="text-green-600 shrink-0 mt-0.5" />}
                    </div>

                    {/* PDF waiver path */}
                    {event.waiverPdfUrl && !waiverAccepted && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full font-heading uppercase tracking-wider border-amber-400 text-amber-700 hover:bg-amber-100"
                        onClick={() => { setPdfWaiverChecked(false); setPdfWaiverModalOpen(true); }}
                      >
                        <FileText size={14} className="mr-2" />
                        Read &amp; Acknowledge Waiver PDF
                      </Button>
                    )}

                    {/* Text waiver path (no PDF) */}
                    {!event.waiverPdfUrl && !waiverAccepted && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full font-heading uppercase tracking-wider border-amber-400 text-amber-700 hover:bg-amber-100"
                        onClick={() => { setWaiverScrolledToBottom(false); setWaiverModalOpen(true); }}
                      >
                        <FileText size={14} className="mr-2" />
                        Read &amp; Acknowledge Waiver
                      </Button>
                    )}

                    {/* View links after accepted */}
                    {waiverAccepted && event.waiverPdfUrl && (
                      <button
                        type="button"
                        onClick={() => { setPdfWaiverChecked(false); setPdfWaiverModalOpen(true); }}
                        className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-primary w-full"
                      >
                        <FileText size={12} /> View PDF
                      </button>
                    )}
                    {waiverAccepted && !event.waiverPdfUrl && event.waiverText && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full text-xs text-muted-foreground"
                        onClick={() => { setWaiverScrolledToBottom(false); setWaiverModalOpen(true); }}
                      >
                        View waiver text
                      </Button>
                    )}
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={submitting || bibCheckState === "taken" || bibCheckState === "checking" || (event.requireWaiver && !waiverAccepted)}
                  className="w-full font-heading uppercase tracking-wider text-base h-12"
                >
                  {submitting ? (
                    <><Loader2 size={18} className="mr-2 animate-spin" /> Processing...</>
                  ) : event.paymentEnabled && totalDue > 0 ? (
                    <><CreditCard size={18} className="mr-2" /> Register & Pay ${totalDue.toFixed(2)} →</>
                  ) : (
                    "Complete Registration →"
                  )}
                </Button>
                <p className="text-center text-xs text-muted-foreground">By registering you agree to the event's waiver and rules.</p>
              </form>
            </Form>

            {/* PDF Waiver modal */}
            <Dialog open={pdfWaiverModalOpen} onOpenChange={(open) => {
              setPdfWaiverModalOpen(open);
              if (!open) { setPdfWaiverChecked(false); setPdfScrolledToBottom(false); }
            }}>
              <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0">
                <DialogHeader className="px-6 pt-6 pb-4 border-b shrink-0">
                  <DialogTitle className="font-heading uppercase tracking-wide text-base flex items-center gap-2">
                    <FileText size={18} className="text-primary" />
                    Club Waiver &amp; Release
                  </DialogTitle>
                  {!pdfScrolledToBottom && (
                    <p className="text-xs text-muted-foreground mt-1">Scroll to the bottom to accept the waiver.</p>
                  )}
                </DialogHeader>

                {event.waiverPdfUrl && (
                  <PdfScrollViewer
                    url={event.waiverPdfUrl}
                    onScrolledToBottom={() => setPdfScrolledToBottom(true)}
                  />
                )}

                <div className="px-6 py-4 border-t shrink-0 space-y-3">
                  {!pdfScrolledToBottom && (
                    <p className="text-xs text-amber-600 text-center">↓ Scroll to the bottom to enable the Accept button</p>
                  )}
                  {pdfScrolledToBottom && (
                    <label className="flex items-start gap-2.5 cursor-pointer select-none">
                      <Checkbox
                        className="mt-0.5 shrink-0"
                        checked={pdfWaiverChecked}
                        onCheckedChange={(v) => setPdfWaiverChecked(!!v)}
                      />
                      <span className="text-sm text-foreground leading-snug">
                        I have read the club waiver and agree to its terms
                      </span>
                    </label>
                  )}
                  <div className="flex gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={() => { setPdfWaiverModalOpen(false); setPdfWaiverChecked(false); setPdfScrolledToBottom(false); }}
                    >
                      Close
                    </Button>
                    <Button
                      type="button"
                      className="flex-1 font-heading uppercase tracking-wider"
                      disabled={!pdfScrolledToBottom || !pdfWaiverChecked}
                      onClick={handleAcceptWaiver}
                    >
                      <ShieldCheck size={16} className="mr-2" />
                      I Accept
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>

            {/* Waiver modal */}
            <Dialog open={waiverModalOpen} onOpenChange={setWaiverModalOpen}>
              <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0">
                <DialogHeader className="px-6 pt-6 pb-4 border-b shrink-0">
                  <DialogTitle className="font-heading uppercase tracking-wide text-base flex items-center gap-2">
                    <FileText size={18} className="text-primary" />
                    Club Waiver &amp; Release
                  </DialogTitle>
                  {!waiverScrolledToBottom && <p className="text-xs text-muted-foreground mt-1">Scroll to the bottom to accept the waiver.</p>}
                </DialogHeader>
                <div
                  ref={waiverScrollRef}
                  onScroll={handleWaiverScroll}
                  className="flex-1 overflow-y-auto px-6 py-4"
                  style={{ minHeight: 0 }}
                >
                  <pre className="whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed">
                    {event.waiverText}
                  </pre>
                </div>
                <div className="px-6 py-4 border-t shrink-0 space-y-3">
                  {!waiverScrolledToBottom && (
                    <p className="text-xs text-amber-600 text-center">↓ Scroll to the bottom to enable the Accept button</p>
                  )}
                  <div className="flex gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={() => setWaiverModalOpen(false)}
                    >
                      Close
                    </Button>
                    <Button
                      type="button"
                      className="flex-1 font-heading uppercase tracking-wider"
                      disabled={!waiverScrolledToBottom}
                      onClick={handleAcceptWaiver}
                    >
                      <ShieldCheck size={16} className="mr-2" />
                      I Accept
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </div>

      {/* Image lightbox */}
      {imageLightboxOpen && (event as any).imageUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-4 cursor-zoom-out"
          onClick={() => setImageLightboxOpen(false)}
        >
          <button
            type="button"
            className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors bg-black/40 rounded-full p-2"
            onClick={() => setImageLightboxOpen(false)}
            aria-label="Close"
          >
            <XIcon size={22} />
          </button>
          <img
            src={(event as any).imageUrl}
            alt={event.name}
            className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl"
            onClick={e => e.stopPropagation()}
          />
          <p className="mt-4 text-white/40 text-sm select-none">Click anywhere to close</p>
        </div>
      )}
    </div>
  );
}
