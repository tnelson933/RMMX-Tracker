import { eventToday } from "@workspace/api-zod";
import { localDateString } from "@/lib/eventDates";
import { useState, useEffect, useRef, useCallback } from "react";
import { StateSelect } from "@/components/ui/StateSelect";
import { RM_TRACKR_OPTION_ID } from "@/lib/rmTrackr";
import { eventTimingTags, type TimingTags } from "@/components/organizer/timingTags";
import { useRoute, Link } from "wouter";
import { useForm, type FieldErrors } from "react-hook-form";
import { zodResolver } from "@/lib/zodResolver";
import { z } from "zod";
import { loadPdfJs, PDF_JS_WORKER_URL } from "@/lib/pdfJs";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TitleBand } from "@/components/TitleBand";
import { BikeBrandChips } from "@/components/BikeBrandChips";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Calendar, MapPin, Flag, CheckCircle2, AlertCircle, CreditCard, Loader2, ExternalLink, DollarSign, Mail, Tag, X as XIcon, FileText, ShieldCheck, Users, ZoomIn, HelpCircle, ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { format, parseISO } from "date-fns";
import { formatEventDatesFull } from "@/lib/eventDates";

import { PdfSignedViewer } from "@/components/PdfSignedViewer";
import { responseErrorMessage } from "@/lib/friendlyErrors";
import { EmbeddedCardForm } from "@/components/payments/EmbeddedCardForm";

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
        const pdfjsLib: any = await loadPdfJs();
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
          pdfjsLib.GlobalWorkerOptions.workerSrc =
            PDF_JS_WORKER_URL;
        }
        // Pre-fetch as ArrayBuffer so pdfjs never has to issue its own XHR
        // (avoids range-request issues behind the Replit proxy).
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) throw new Error(responseErrorMessage(resp.status));
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


// Brand section heading: charcoal Barlow 800 with the TitleBand's skewed red slash.
function SectionHeader({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <CardHeader className="px-6 py-4 border-b-2 border-[#ECECEC] flex flex-row items-center justify-between gap-3 space-y-0">
      <h3 className="flex items-center gap-3 m-0 font-heading font-extrabold uppercase text-lg leading-none tracking-[0.5px] text-[#242424]">
        <span aria-hidden className="w-[4px] h-5 bg-primary -skew-x-[18deg] shrink-0" />
        {children}
      </h3>
      {action}
    </CardHeader>
  );
}

// The registration wizard: one group of fields per step, then a review.
type StepId = "rider" | "contact" | "classes" | "addons" | "bike" | "waiver" | "review";

const STEP_LABELS: Record<StepId, string> = {
  rider: "Rider",
  contact: "Contact",
  classes: "Classes",
  addons: "Add-ons",
  bike: "Bike",
  waiver: "Waiver",
  review: "Review",
};

// Which step each field lives on, so a failed submit can send the rider back to it.
const FIELD_STEPS: Record<string, StepId> = {
  email: "rider", firstName: "rider", lastName: "rider", phone: "rider", dateOfBirth: "rider",
  bibNumber: "rider", amaNumber: "rider", clubIdNumber: "rider",
  streetAddress: "contact", city: "contact", homeState: "contact", zip: "contact",
  emergencyContact: "contact", emergencyPhone: "contact", statsEmailOptIn: "contact",
  selectedClasses: "classes",
  myLapsTransponderNumber: "addons", rentTransponder: "addons", purchaseRfidSticker: "addons", selectedPurchaseOptions: "addons",
  bikeBrand: "bike", bikeModel: "bike", bikeYear: "bike", sponsors: "bike",
};

function StepProgress({ steps, current, onJump }: { steps: string[]; current: number; onJump: (index: number) => void }) {
  return (
    <nav aria-label="Registration progress">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-bold uppercase tracking-[2px] text-muted-foreground">Step {current + 1} of {steps.length}</span>
        <span className="font-heading font-extrabold uppercase text-lg leading-none text-[#242424] sm:hidden">{steps[current]}</span>
      </div>
      <ol className="flex gap-1.5 mt-2.5">
        {steps.map((label, i) => (
          <li key={label} className="flex-1 min-w-0">
            {/* Earlier steps can be revisited; later ones open with Next. */}
            <button
              type="button"
              disabled={i >= current}
              onClick={() => onJump(i)}
              aria-current={i === current ? "step" : undefined}
              aria-label={`${label}${i < current ? " (done, go back)" : ""}`}
              className="group w-full text-left disabled:cursor-default"
            >
              <span className={`block h-1.5 rounded-full ${i < current ? "bg-[#242424] group-hover:bg-primary" : i === current ? "bg-primary" : "bg-[#ECECEC]"}`} />
              <span className={`hidden sm:block mt-1.5 truncate text-[12px] font-bold uppercase tracking-[1px] ${i === current ? "text-[#242424]" : "text-muted-foreground"}`}>
                {label}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function ReviewSection({ title, onEdit, children }: { title: string; onEdit: () => void; children: React.ReactNode }) {
  return (
    <Card>
      <SectionHeader
        action={
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1.5 min-h-[44px] -my-2 -mr-2 px-2 text-sm font-bold uppercase tracking-[0.5px] text-primary hover:underline"
            aria-label={`Edit ${title}`}
          >
            <Pencil size={14} /> Edit
          </button>
        }
      >
        {title}
      </SectionHeader>
      <CardContent className="px-6 py-1.5">
        <dl className="divide-y divide-[#ECECEC]">{children}</dl>
      </CardContent>
    </Card>
  );
}

function ReviewRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex justify-between gap-4 py-2.5">
      <dt className="text-[13px] font-bold uppercase tracking-[1px] text-muted-foreground pt-0.5 shrink-0 max-w-[45%]">{label}</dt>
      <dd className={`text-right text-[15px] min-w-0 break-words ${value ? "font-medium text-[#242424]" : "text-muted-foreground"}`}>{value || "—"}</dd>
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
  requireLiabilityWaiver: boolean;
  requireTransponder: boolean;
  waiverText: string | null;
  waiverPdfUrl?: string | null;
  liabilityWaiverText?: string | null;
  liabilityWaiverPdfUrl?: string | null;
  liabilityWaiverFields?: Array<{ id: string; type: string; page: number; x: number; y: number; width: number; height: number }> | null;
  clubName: string | null;
  clubLogoUrl: string | null;
  registrationOpen: string | null;
  registrationClose: string | null;
  timingTechnology: string;
  /** Which kinds of tag the event's readers use (RM TrackR, RFID or both). */
  timingTags?: TimingTags;
  /** Brands that pay contingency at this event. */
  contingencyBrands?: string[] | null;
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
  /** Stripe's form shown in this page (embedded checkout). */
  clientSecret?: string | null;
  /** The club's own Stripe account the payment is on. */
  stripeAccount?: string | null;
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
  myLapsTransponderNumber: string;
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
  // "new_rider": a different rider (e.g. a second child) on an email that already has a profile.
  const [lookupState, setLookupState] = useState<"idle" | "loading" | "found" | "not_found" | "pick" | "new_rider">("idle");
  const [lookedUpName, setLookedUpName] = useState<string>("");
  const [riderOptions, setRiderOptions] = useState<RiderOption[] | null>(null);
  const autoLookupFiredRef = useRef(false);
  const lookupRequestRef = useRef(0);
  const riderClassesRequestRef = useRef(0);
  const [alreadyRegisteredClasses, setAlreadyRegisteredClasses] = useState<Set<string>>(new Set());

  const [compCodeInput, setCompCodeInput] = useState("");
  const [appliedComp, setAppliedComp] = useState<{ code: string; amount: number; discountType: "fixed" | "percentage" } | null>(null);
  const [compApplying, setCompApplying] = useState(false);
  const [compError, setCompError] = useState<string | null>(null);

  const [bibCheckState, setBibCheckState] = useState<"idle" | "checking" | "taken" | "available">("idle");
  const [selectedRiderId, setSelectedRiderId] = useState<number | null>(null);

  // Wizard state
  const [step, setStep] = useState<StepId>("rider");
  // Set when the rider taps Edit on the review, so Next goes straight back to it.
  const [returnToReview, setReturnToReview] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const wizardTopRef = useRef<HTMLDivElement>(null);
  const reviewOpenedAtRef = useRef(0);

  // Waiver state
  const [waiverModalOpen, setWaiverModalOpen] = useState(false);
  const [pdfWaiverModalOpen, setPdfWaiverModalOpen] = useState(false);
  const [pdfWaiverChecked, setPdfWaiverChecked] = useState(false);
  const [pdfScrolledToBottom, setPdfScrolledToBottom] = useState(false);
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const [waiverScrolledToBottom, setWaiverScrolledToBottom] = useState(false);
  const [waiverTimestamp, setWaiverTimestamp] = useState<string | null>(null);
  const waiverScrollRef = useRef<HTMLDivElement>(null);

  // Liability waiver e-sign state
  const [liabilityWaiverModalOpen, setLiabilityWaiverModalOpen] = useState(false);
  const [liabilityWaiverScrolledToBottom, setLiabilityWaiverScrolledToBottom] = useState(false);
  const [liabilityWaiverConsentChecked, setLiabilityWaiverConsentChecked] = useState(false);
  const [liabilityWaiverConsentGiven, setLiabilityWaiverConsentGiven] = useState(false);
  const [liabilityWaiverSignerName, setLiabilityWaiverSignerName] = useState("");
  const [liabilityWaiverAccepted, setLiabilityWaiverAccepted] = useState(false);
  const [liabilityWaiverSignatureId, setLiabilityWaiverSignatureId] = useState<number | null>(null);
  const [liabilityWaiverSignedAt, setLiabilityWaiverSignedAt] = useState<string | null>(null);
  const [liabilityWaiverSigning, setLiabilityWaiverSigning] = useState(false);
  const [liabilityWaiverDownloading, setLiabilityWaiverDownloading] = useState(false);
  const [liabilityWaiverSignError, setLiabilityWaiverSignError] = useState<string | null>(null);
  const [liabilityWaiverSignerType, setLiabilityWaiverSignerType] = useState<"self" | "guardian">("self");
  const [liabilityWaiverMinorRiderName, setLiabilityWaiverMinorRiderName] = useState("");
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
    setStepError(null);
    setWaiverModalOpen(false);
    setPdfWaiverModalOpen(false);
    setPdfWaiverChecked(false);
    setPdfScrolledToBottom(false);
  };

  const handleSignLiabilityWaiver = async () => {
    if (!event?.liabilityWaiverPdfUrl || !liabilityWaiverConsentChecked || !liabilityWaiverSignerName.trim()) return;
    if (liabilityWaiverSignerType === "guardian" && !liabilityWaiverMinorRiderName.trim()) return;
    setLiabilityWaiverSigning(true);
    setLiabilityWaiverSignError(null);
    try {
      const signerEmail = (form.getValues("email") as string | undefined) || "";
      const res = await fetch(`/api/public/events/${eventId}/liability-waiver/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signerName: liabilityWaiverSignerName.trim(),
          signerEmail,
          consentToEsign: true,
          waiverSnapshot: event.liabilityWaiverPdfUrl,
          fieldLayout: event.liabilityWaiverFields ?? null,
          signerType: liabilityWaiverSignerType,
          minorRiderName: liabilityWaiverSignerType === "guardian" ? liabilityWaiverMinorRiderName.trim() : null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Signing failed");
      setLiabilityWaiverSignatureId(json.signatureId);
      setLiabilityWaiverSignedAt(new Date().toISOString());
      setLiabilityWaiverAccepted(true);
      setLiabilityWaiverModalOpen(false);
      setStepError(null);
    } catch (e: any) {
      setLiabilityWaiverSignError(e.message || "Signing failed. Please try again.");
    } finally {
      setLiabilityWaiverSigning(false);
    }
  };

  const downloadSignedPdf = async () => {
    if (!event?.liabilityWaiverPdfUrl || !liabilityWaiverSignerName) return;
    setLiabilityWaiverDownloading(true);
    try {
      const lib: any = await loadPdfJs();
      if (!lib.GlobalWorkerOptions.workerSrc)
        lib.GlobalWorkerOptions.workerSrc = PDF_JS_WORKER_URL;
      const resp = await fetch(event.liabilityWaiverPdfUrl, { credentials: "include" });
      if (!resp.ok) throw new Error("Could not load waiver PDF");
      const data = await resp.arrayBuffer();
      const pdfDoc = await lib.getDocument({ data }).promise;

      const fields = (event.liabilityWaiverFields ?? []) as Array<{ id: string; type: string; page: number; x: number; y: number; width: number; height: number }>;
      const signerEmail = (form.getValues("email") as string | undefined) || "";
      const signedAtDisplay = liabilityWaiverSignedAt
        ? new Date(liabilityWaiverSignedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
        : new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

      const { jsPDF } = await import("jspdf");
      const MM = 0.2645835; // px → mm at 96 dpi
      const pdf = new jsPDF({ unit: "mm", compress: true });
      let firstPage = true;

      for (let pi = 0; pi < pdfDoc.numPages; pi++) {
        const page = await pdfDoc.getPage(pi + 1);
        const vp = page.getViewport({ scale: 2 });
        const cv = document.createElement("canvas");
        cv.width = vp.width; cv.height = vp.height;
        const ctx = cv.getContext("2d")!;
        await page.render({ canvasContext: ctx, viewport: vp }).promise;

        // Stamp signature fields
        const pageFields = fields.filter(f => f.page === pi);
        for (const field of pageFields) {
          let value = "";
          if (field.type === "name") value = liabilityWaiverSignerName;
          else if (field.type === "email") value = signerEmail;
          else if (field.type === "date") value = signedAtDisplay;
          else if (field.type === "signature")
            value = liabilityWaiverSignerType === "guardian" && liabilityWaiverMinorRiderName
              ? `${liabilityWaiverSignerName} — parent/guardian of ${liabilityWaiverMinorRiderName}`
              : liabilityWaiverSignerName;
          if (!value) continue;
          const px = field.x * vp.width, py = field.y * vp.height;
          const pw = field.width * vp.width, ph = field.height * vp.height;
          const isSig = field.type === "signature";
          const fs = Math.max(isSig ? 18 : 14, Math.min(isSig ? ph * 0.55 : ph * 0.5, isSig ? 40 : 28));
          ctx.save();
          ctx.fillStyle = isSig ? "rgba(17,17,17,0.06)" : "rgba(16,185,129,0.06)";
          ctx.fillRect(px, py, pw, ph);
          ctx.strokeStyle = isSig ? "#3b82f6" : "#10b981";
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(px, py + ph); ctx.lineTo(px + pw, py + ph); ctx.stroke();
          ctx.fillStyle = "#111";
          ctx.font = isSig ? `italic ${fs}px Georgia,serif` : `${fs}px system-ui,sans-serif`;
          ctx.textBaseline = "middle";
          ctx.fillText(value, px + 6, py + ph / 2, pw - 12);
          ctx.restore();
        }

        const imgData = cv.toDataURL("image/jpeg", 0.92);
        const wMm = vp.width * MM, hMm = vp.height * MM;
        if (firstPage) { pdf.deletePage(1); firstPage = false; }
        pdf.addPage([wMm, hMm], wMm > hMm ? "landscape" : "portrait");
        pdf.addImage(imgData, "JPEG", 0, 0, wMm, hMm);
      }

      const safeName = (event.name ?? "waiver").replace(/[^a-z0-9]/gi, "_");
      pdf.save(`${safeName}_signed_waiver.pdf`);
    } catch (e: any) {
      console.error("Download failed:", e);
    } finally {
      setLiabilityWaiverDownloading(false);
    }
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
      const json = await res.json().catch(() => ({}));
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

  // Next checks a step without submitting the form, so re-check a flagged field as
  // the rider fixes it (react-hook-form only does this by itself after a submit).
  useEffect(() => {
    const sub = form.watch((_, { name }) => {
      if (name && form.getFieldState(name).error) void form.trigger(name);
    });
    return () => sub.unsubscribe();
  }, [form]);

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
        liabilityWaiverPdfUrl: json.liabilityWaiverPdfUrl ?? null,
        liabilityWaiverFields: json.liabilityWaiverFields ?? null,
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
  // RM TrackR events: a rider without a transponder can rent or buy one instead.
  const trackrOption = (event?.purchaseOptions ?? []).find(o => o.id === RM_TRACKR_OPTION_ID) ?? null;
  const offersRental = !!event?.transponderRentalEnabled;
  // The transponder section shows when the event's readers include an RM TrackR
  // loop, or the event asks for (or rents, or sells) transponders.
  const showTransponderSection = !!event && (eventTimingTags(event).transponder || event.requireTransponder
    || offersRental || !!trackrOption);
  const addOnOptions = (event?.purchaseOptions ?? []).filter(o => !(o.id === RM_TRACKR_OPTION_ID && showTransponderSection));
  const buyingTrackr = (watchedPurchaseOptions ?? []).includes(RM_TRACKR_OPTION_ID);
  const gettingTransponder = !!watchedRentTransponder || buyingTrackr;
  const chooseTransponder = (choice: "rent" | "buy" | null) => {
    const others = (form.getValues("selectedPurchaseOptions") ?? []).filter(id => id !== RM_TRACKR_OPTION_ID);
    form.setValue("rentTransponder", choice === "rent");
    form.setValue("selectedPurchaseOptions", choice === "buy" ? [...others, RM_TRACKR_OPTION_ID] : others);
    if (choice) {
      form.setValue("myLapsTransponderNumber", "");
      form.clearErrors("myLapsTransponderNumber");
    }
  };
  const numSelectedClasses = (watchedSelectedClasses ?? []).length;
  const selectedPurchasesTotal = (event?.purchaseOptions ?? [])
    .filter(o => (watchedPurchaseOptions ?? []).includes(o.id))
    .reduce((sum, o) => sum + Number(o.amount), 0);
  const rentalTotal = (watchedRentTransponder && event?.transponderRentalEnabled && event?.transponderRentalFee != null)
    ? Number(event.transponderRentalFee)
    : 0;
  const rfidStickerTotal = (watchedPurchaseRfidSticker && event?.rfidStickerFee != null)
    ? Number(event.rfidStickerFee)
    : 0;
  // Early-bird pricing ends by the track's local date (same rule as the server).
  const today = event ? eventToday(event as any) : localDateString();
  const earlyBirdActive = !!(event?.earlyBirdEndsAt && today <= event.earlyBirdEndsAt && event?.earlyBirdFee != null);
  const effectiveEntryFee = earlyBirdActive ? (event?.earlyBirdFee ?? null) : (event?.entryFee ?? null);
  const totalEntryFees = (effectiveEntryFee ?? 0) * Math.max(1, numSelectedClasses);
  // Same rule as the server: a code only discounts entry fees, rounded to the
  // cent once, and never more than the entry fees (fixed or percentage).
  const totalEntryCents = Math.round(totalEntryFees * 100);
  const compDiscountDollars = appliedComp && effectiveEntryFee
    ? Math.min(
      totalEntryCents,
      appliedComp.discountType === "percentage"
        ? Math.round(totalEntryCents * appliedComp.amount / 100)
        : Math.round(appliedComp.amount * 100),
    ) / 100
    : 0;
  const totalDue = event?.paymentEnabled && effectiveEntryFee
    ? Math.max(0, (effectiveEntryFee * Math.max(1, numSelectedClasses)) + selectedPurchasesTotal + rentalTotal + rfidStickerTotal - compDiscountDollars)
    : 0;

  useEffect(() => {
    if (!event?.noDuplicateBibs) { setBibCheckState("idle"); return; }
    const bib = (watchedBib ?? "").trim();
    if (!bib) { setBibCheckState("idle"); return; }
    setBibCheckState("checking");
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/public/events/${eventId}/check-bib?bib=${encodeURIComponent(bib)}`, { signal: controller.signal })
        .then(r => {
          // A failed check (rate limit, server error) must not read as "available".
          if (!r.ok) throw new Error(`Couldn\'t check that bib number. ${responseErrorMessage(r.status)}`);
          return r.json();
        })
        .then(data => setBibCheckState(data?.taken ? "taken" : "available"))
        .catch(() => { if (!controller.signal.aborted) setBibCheckState("idle"); });
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
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
    const profileValues: Partial<RegisterForm> = {
      firstName: rider.firstName ?? "",
      lastName: rider.lastName ?? "",
      phone: rider.phone ?? "",
      dateOfBirth: rider.dateOfBirth ?? "",
      emergencyContact: rider.emergencyContact ?? "",
      emergencyPhone: rider.emergencyPhone ?? "",
      streetAddress: rider.streetAddress ?? "",
      city: rider.city ?? "",
      homeState: rider.homeState ?? "",
      zip: rider.zip ?? "",
      amaNumber: rider.amaNumber ?? "",
      clubIdNumber: rider.clubIdNumber ?? "",
      bikeBrand: rider.bikeBrand ?? "",
      bikeModel: rider.bikeModel ?? "",
      bikeYear: rider.bikeYear ?? "",
      bibNumber: rider.bibNumber ?? "",
      sponsors: rider.sponsors ?? "",
      myLapsTransponderNumber: rider.myLapsTransponderNumber ?? "",
    };
    for (const [name, value] of Object.entries(profileValues) as Array<[keyof RegisterForm, RegisterForm[keyof RegisterForm]]>) {
      if (!form.getFieldState(name).isDirty) {
        form.setValue(name, value, { shouldDirty: false });
      }
    }
    setSelectedRiderId(rider.id ?? null);
    setLookedUpName(`${rider.firstName} ${rider.lastName}`);
    setLookupState("found");
    setRiderOptions(null);
    setAlreadyRegisteredClasses(new Set());
    const classesRequest = ++riderClassesRequestRef.current;
    // Fetch which classes this rider is already registered for at this event
    if (eventId && rider.id) {
      fetch(`/api/public/events/${eventId}/rider-classes?riderId=${rider.id}`)
        .then(r => (r.ok ? r.json() : {}))
        .then((d: { registeredClasses?: string[] }) => {
          if (classesRequest !== riderClassesRequestRef.current) return;
          setAlreadyRegisteredClasses(new Set(d.registeredClasses ?? []));
        })
        .catch(() => {});
    }
  };

  // Register someone else on this email: a new profile, with the other rider's
  // personal details cleared (shared ones like address and emergency contact stay).
  const startNewRiderOnEmail = () => {
    lookupRequestRef.current++;
    riderClassesRequestRef.current++;
    setSelectedRiderId(null);
    setRiderOptions(null);
    setLookedUpName("");
    setAlreadyRegisteredClasses(new Set());
    for (const name of ["firstName", "lastName", "dateOfBirth", "bibNumber", "amaNumber", "clubIdNumber", "myLapsTransponderNumber", "bikeBrand", "bikeModel", "bikeYear", "sponsors"] as const) {
      form.setValue(name, "", { shouldDirty: false });
    }
    setLookupState("new_rider");
  };

  const lookupByEmail = async (email: string) => {
    const trimmed = email.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmed)) return;
    const request = ++lookupRequestRef.current;
    setLookupState("loading");
    setLookedUpName("");
    setRiderOptions(null);
    try {
      const res = await fetch(`/api/public/riders/lookup?email=${encodeURIComponent(trimmed)}`);
      const data = await res.json();
      if (request !== lookupRequestRef.current || form.getValues("email").trim().toLowerCase() !== trimmed.toLowerCase()) return;
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
      if (request !== lookupRequestRef.current) return;
      setLookupState("not_found");
    }
  };

  const onSubmit = async (data: RegisterForm) => {
    if (lookupState === "pick" || (riderOptions !== null && selectedRiderId === null)) {
      setSubmitError("Select the correct rider profile for this email before registering.");
      return;
    }
    // Client-side enforcement of event-level required fields
    // Each failed rule sends the rider back to the step that holds the field.
    if (event?.requireAma && !data.amaNumber?.trim()) {
      setStep("rider");
      form.setError("amaNumber", { message: "AMA # is required for this event" });
      return;
    }
    if (event?.requireClubId && !data.clubIdNumber?.trim()) {
      setStep("rider");
      form.setError("clubIdNumber", { message: "Club ID # is required for this event" });
      return;
    }
    if (event?.requireTransponder
      && !data.myLapsTransponderNumber?.trim() && !data.rentTransponder && !data.selectedPurchaseOptions.includes(RM_TRACKR_OPTION_ID)) {
      const canGetOne = !!event.transponderRentalEnabled || (event.purchaseOptions ?? []).some(o => o.id === RM_TRACKR_OPTION_ID);
      setStep("addons");
      form.setError("myLapsTransponderNumber", {
        message: canGetOne ? "Enter your transponder number, or choose to rent or buy one below." : "A transponder number is required for this event.",
      });
      return;
    }
    if (event?.requireWaiver && !waiverAccepted) {
      setSubmitError("You must read and accept the rider acknowledgement form before registering.");
      return;
    }
    if (event?.requireLiabilityWaiver && !liabilityWaiverAccepted) {
      setSubmitError("You must sign the liability waiver before registering.");
      return;
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
          // Show Stripe's payment form in this page instead of a new window.
          embeddedCheckout: true,
          raceClasses: selectedClasses,
          selectedPurchaseOptions: (event?.purchaseOptions ?? []).filter(o => data.selectedPurchaseOptions.includes(o.id)),
          compCode: appliedComp?.code ?? null,
          waiverAcknowledgedAt: waiverAccepted ? waiverTimestamp : null,
          waiverSnapshot: waiverAccepted ? (event?.waiverText ?? null) : null,
          liabilityWaiverSignatureId: liabilityWaiverSignatureId,
          ...(selectedRiderId ? { riderId: selectedRiderId } : {}),
          ...(lookupState === "new_rider" ? { newRider: true } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Registration failed");

      if (json.requiresPayment && (json.checkoutUrl || json.clientSecret)) {
        setPendingPayment({
          checkoutUrl: json.checkoutUrl ?? "",
          clientSecret: json.clientSecret ?? null,
          stripeAccount: json.stripeAccount ?? null,
          registrationId: json.registrationId,
          sessionId: json.sessionId ?? null,
          riderName: json.riderName,
          raceClasses: json.raceClasses ?? (json.raceClass ? [json.raceClass] : []),
          eventName: json.eventName,
          entryFee: Number(json.entryFee),
        });
        // Older servers only send Stripe's page: open it in a new tab.
        if (!json.clientSecret && json.checkoutUrl) window.open(json.checkoutUrl, "_blank");
      } else {
        setSuccess({ ...json, amountPaid: json.amountPaid != null ? Number(json.amountPaid) : null });
      }
      // The payment / confirmation screen is short; show it from the top.
      window.scrollTo({ top: 0 });
    } catch (e: any) {
      setSubmitError(e.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || verifying) {
    return (
      <div className="flex items-center justify-center px-4 py-24">
        <div className="font-heading text-xl uppercase tracking-widest text-muted-foreground animate-pulse">
          {verifying ? "Verifying payment..." : "Loading Event..."}
        </div>
      </div>
    );
  }

  if (notFound || !event) {
    return (
      <div className="flex items-center justify-center px-4 py-24">
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
      <div className="flex items-center justify-center px-4 py-16">
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
  if (pendingPayment && (pendingPayment.checkoutUrl || pendingPayment.clientSecret)) {
    return (
      <div className="flex items-center justify-center px-4 py-16">
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

          {/* Stripe's payment form, in this page */}
          {pendingPayment.clientSecret && (
            <Card><CardContent className="p-2 sm:p-4">
              <EmbeddedCardForm clientSecret={pendingPayment.clientSecret} stripeAccount={pendingPayment.stripeAccount} onComplete={() => verifyPayment(pendingPayment.registrationId, pendingPayment.sessionId)} />
            </CardContent></Card>
          )}

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
            {!pendingPayment.clientSecret && (
              <Button
                className="w-full font-heading uppercase tracking-wider text-base h-12"
                onClick={() => window.open(pendingPayment.checkoutUrl, "_blank")}
              >
                <ExternalLink size={18} className="mr-2" />
                Reopen Stripe Checkout
              </Button>
            )}
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

  // Steps this event needs: add-ons and waivers only show when the event has them.
  const hasLiabilityWaiver = event.requireLiabilityWaiver && !!event.liabilityWaiverPdfUrl;
  const hasAcknowledgement = event.requireWaiver && !!(event.waiverText || event.waiverPdfUrl);
  const steps: StepId[] = [
    "rider",
    "contact",
    "classes",
    ...(showTransponderSection || event.rfidStickerFee != null || addOnOptions.length > 0 ? ["addons" as const] : []),
    "bike",
    ...(hasLiabilityWaiver || hasAcknowledgement ? ["waiver" as const] : []),
    "review",
  ];
  const stepIndex = Math.max(0, steps.indexOf(step));
  // Drives the "* Required" note; must match what validateStep enforces.
  const stepHasRequired = step === "rider" || step === "classes" || step === "waiver"
    || (step === "addons" && event.requireTransponder && !gettingTransponder);
  const v = form.getValues();

  const goTo = (id: StepId) => {
    if (id === "review") reviewOpenedAtRef.current = Date.now();
    setStepError(null);
    setStep(id);
    requestAnimationFrame(() => wizardTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  // Same rules the submit enforces, checked as the rider leaves each step.
  const validateStep = async (id: StepId): Promise<boolean> => {
    setStepError(null);
    setSubmitError(null);
    if (id === "rider") {
      if (!(await form.trigger(["email", "firstName", "lastName"]))) return false;
      if (lookupState === "pick" || (riderOptions !== null && selectedRiderId === null)) {
        setStepError("Select the correct rider profile for this email to continue.");
        return false;
      }
      if (event.requireAma && !form.getValues("amaNumber")?.trim()) {
        form.setError("amaNumber", { message: "AMA # is required for this event" });
        return false;
      }
      if (event.requireClubId && !form.getValues("clubIdNumber")?.trim()) {
        form.setError("clubIdNumber", { message: "Club ID # is required for this event" });
        return false;
      }
      if (bibCheckState === "taken") {
        setStepError(`#${form.getValues("bibNumber")} is already taken for this event. Choose another number.`);
        return false;
      }
    }
    if (id === "classes") return form.trigger("selectedClasses");
    if (id === "addons" && event.requireTransponder) {
      const d = form.getValues();
      if (!d.myLapsTransponderNumber?.trim() && !d.rentTransponder && !d.selectedPurchaseOptions.includes(RM_TRACKR_OPTION_ID)) {
        form.setError("myLapsTransponderNumber", {
          message: offersRental || trackrOption ? "Enter your transponder number, or choose to rent or buy one below." : "A transponder number is required for this event.",
        });
        return false;
      }
    }
    if (id === "waiver") {
      if (hasLiabilityWaiver && !liabilityWaiverAccepted) {
        setStepError("Sign the liability waiver to continue.");
        return false;
      }
      if (hasAcknowledgement && !waiverAccepted) {
        setStepError("Read and accept the rider acknowledgement form to continue.");
        return false;
      }
    }
    return true;
  };

  const goNext = async () => {
    if (!(await validateStep(step))) return;
    if (returnToReview) {
      setReturnToReview(false);
      goTo("review");
      return;
    }
    goTo(steps[Math.min(stepIndex + 1, steps.length - 1)]);
  };

  const goBack = () => {
    setReturnToReview(false);
    goTo(steps[Math.max(0, stepIndex - 1)]);
  };

  const editStep = (id: StepId) => {
    setReturnToReview(true);
    goTo(id);
  };

  // The schema failed on submit: open the first step with a problem.
  const onInvalid = (errors: FieldErrors<RegisterForm>) => {
    const first = steps.find(s => Object.keys(errors).some(f => FIELD_STEPS[f] === s));
    if (first) goTo(first);
  };

  return (
    <div>
      <TitleBand
        containerClassName="max-w-3xl"
        eyebrow={event.clubName}
        title={event.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[15px]">
            <span className="flex items-center gap-1.5"><Calendar size={16} className="text-white/70" /> {formatEventDatesFull(event.date, event.endDate)}</span>
            {event.location && <span className="flex items-center gap-1.5"><MapPin size={16} className="text-white/70" /> {event.location}, {event.state}</span>}
            {event.trackName && <span className="flex items-center gap-1.5"><Flag size={16} className="text-white/70" /> {event.trackName}</span>}
          </span>
        }
      >
        {effectiveEntryFee != null && (
          <div className="bg-primary rounded-[14px] px-6 py-4 text-center md:min-w-[150px]">
            {earlyBirdActive && (
              <div className="text-white text-[13px] font-bold uppercase tracking-[2px] mb-1">Early Bird</div>
            )}
            <div className="text-white/80 text-[13px] font-bold uppercase tracking-[2px]">Entry Fee</div>
            <div className="text-white text-4xl font-heading font-extrabold leading-tight">${effectiveEntryFee}</div>
            {earlyBirdActive && event?.entryFee && (
              <div className="text-white/80 text-[13px] line-through">${event.entryFee} after {event.earlyBirdEndsAt}</div>
            )}
            {event.raceClasses.length > 1 && (
              <div className="text-white/80 text-[13px]">per class</div>
            )}
          </div>
        )}
      </TitleBand>

      <div className="brand-form max-w-2xl mx-auto px-4 py-10">
        {/* Club logo / event image */}
        {(event.clubLogoUrl || (event as any).imageUrl) && (
          <div className="flex items-center justify-center gap-6 mb-8 flex-wrap">
            {event.clubLogoUrl && (
              <img
                src={event.clubLogoUrl}
                alt={event.clubName || "Club logo"}
                className="h-40 w-auto max-w-xs object-contain"
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
                  className="h-40 w-auto max-w-xs object-contain rounded-[14px] transition-opacity group-hover:opacity-80"
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
              <h2 className="text-[28px] font-heading font-extrabold uppercase text-[#242424] leading-none">Rider Registration</h2>
              <p className="text-[#333] mt-3 leading-[1.7]">
                A few quick steps to secure your spot. You can check everything before you finish.
                {event.paymentEnabled && !!effectiveEntryFee && (
                  <> You pay the <strong>${effectiveEntryFee} entry fee</strong> on the last step.</>
                )}
              </p>
            </div>

            {paymentCancelled && (
              <div className="bg-amber-500/10 border border-amber-500/30 text-amber-700 rounded-md px-4 py-3 text-sm flex items-center gap-2">
                <AlertCircle size={16} className="shrink-0" />
                Payment was cancelled. Your registration was not confirmed. Fill out the form again to try again.
              </div>
            )}

            {submitError && step !== "review" && (
              <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-md px-4 py-3 text-sm flex items-center gap-2">
                <AlertCircle size={16} className="shrink-0" />
                {submitError}
              </div>
            )}

            <Form {...form}>
              <form
                onSubmit={e => {
                  // Enter (or the phone's Go key) moves to the next step; only the review step submits.
                  if (step === "review") {
                    // A double-tap on "Next: Review" must not land on Pay/Submit.
                    if (Date.now() - reviewOpenedAtRef.current < 800) { e.preventDefault(); return; }
                    void form.handleSubmit(onSubmit, onInvalid)(e);
                    return;
                  }
                  e.preventDefault();
                  void goNext();
                }}
                className="space-y-6"
              >
                <div ref={wizardTopRef} className="scroll-mt-4">
                  <StepProgress steps={steps.map(s => STEP_LABELS[s])} current={stepIndex} onJump={i => goTo(steps[i])} />
                  {step !== "review" && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {stepHasRequired
                        ? <><span className="text-destructive">*</span> Required. Everything else is optional.</>
                        : "Everything on this step is optional."}
                    </p>
                  )}
                </div>

                {step === "rider" && (
                  <>
                    {/* Email — first question, drives rider lookup */}
                    <Card>
                      <SectionHeader>Your Email</SectionHeader>
                      <CardContent className="p-6 space-y-3">
                        <FormField control={form.control} name="email" render={({ field }) => (
                          <FormItem>
                            <FormLabel>Email Address <span className="text-destructive">*</span></FormLabel>
                            <FormControl>
                              <Input
                                type="email"
                                placeholder="rider@example.com"
                                {...field}
                                onChange={e => {
                                  lookupRequestRef.current++;
                                  riderClassesRequestRef.current++;
                                  setSelectedRiderId(null);
                                  setAlreadyRegisteredClasses(new Set());
                                  setRiderOptions(null);
                                  setLookedUpName("");
                                  setLookupState("idle");
                                  field.onChange(e);
                                }}
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
                            <span>
                              Welcome back, <strong>{lookedUpName}</strong>! Your info has been pre-filled — review and update anything that's changed.{" "}
                              <button type="button" onClick={startNewRiderOnEmail} className="underline font-semibold">Not {lookedUpName.split(" ")[0]}? Register a different rider on this email</button>
                            </span>
                          </div>
                        )}
                        {lookupState === "new_rider" && (
                          <p className="text-xs text-muted-foreground">Registering a new rider on this email: fill in their details below and we'll create their own profile.</p>
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
                                  <div className="text-xs text-muted-foreground mt-0.5">
                                    {[
                                      rider.dateOfBirth ? `DOB ${rider.dateOfBirth}` : "",
                                      rider.phone,
                                      [rider.city, rider.homeState].filter(Boolean).join(", "),
                                      rider.bibNumber ? `#${rider.bibNumber}` : "",
                                    ].filter(Boolean).join(" · ") || `Profile ID ${rider.id}`}
                                  </div>
                                </button>
                              ))}
                              <button
                                type="button"
                                onClick={startNewRiderOnEmail}
                                className="w-full text-left rounded-lg border border-dashed border-border bg-background px-4 py-3 text-sm font-semibold hover:border-primary hover:bg-primary/5 transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
                              >
                                + Someone else (a new rider on this email)
                              </button>
                            </div>
                          </div>
                        )}
                        {lookupState === "not_found" && (
                          <p className="text-xs text-muted-foreground">No existing profile found — fill in your details below and we'll create one for you.</p>
                        )}
                      </CardContent>
                    </Card>

                    <Card>
                      <SectionHeader>Rider Info</SectionHeader>
                      <CardContent className="p-6 space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <FormField control={form.control} name="firstName" render={({ field }) => (
                            <FormItem>
                              <FormLabel>First Name <span className="text-destructive">*</span></FormLabel>
                              <FormControl>
                                <Input
                                  placeholder="Jake"
                                  {...field}
                                  onChange={field.onChange}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                          <FormField control={form.control} name="lastName" render={({ field }) => (
                            <FormItem>
                              <FormLabel>Last Name <span className="text-destructive">*</span></FormLabel>
                              <FormControl>
                                <Input
                                  placeholder="Morrison"
                                  {...field}
                                  onChange={field.onChange}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        </div>
                        <div className="grid grid-cols-2 items-end gap-4">
                          <FormField control={form.control} name="phone" render={({ field }) => (
                            <FormItem>
                              <FormLabel>Phone <span className="text-muted-foreground font-normal text-xs">(optional)</span></FormLabel>
                              <FormControl><Input placeholder="602-555-0100" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                          <FormField control={form.control} name="dateOfBirth" render={({ field }) => (
                            <FormItem>
                              <FormLabel>Date of Birth <span className="text-muted-foreground font-normal text-xs">(optional)</span></FormLabel>
                              <FormControl><Input type="text" inputMode="numeric" placeholder="MM/DD/YYYY" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        </div>
                        <FormField control={form.control} name="bibNumber" render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              Preferred # <span className="text-muted-foreground font-normal text-xs">(optional)</span>
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
                  </>
                )}

                {step === "contact" && (
                  <>
                    <Card>
                      <SectionHeader>Address</SectionHeader>
                      <CardContent className="p-6 space-y-4">
                        <FormField control={form.control} name="streetAddress" render={({ field }) => (
                          <FormItem>
                            <FormLabel>Street Address <span className="text-muted-foreground font-normal text-xs">(optional)</span></FormLabel>
                            <FormControl><Input placeholder="123 Dirt Track Rd" {...field} /></FormControl>
                            <p className="text-xs text-muted-foreground">Saved to your profile for next time.</p>
                            <FormMessage />
                          </FormItem>
                        )} />
                        <div className="grid grid-cols-2 sm:grid-cols-3 items-end gap-4">
                          <FormField control={form.control} name="city" render={({ field }) => (
                            <FormItem className="col-span-2 sm:col-span-1">
                              <FormLabel>City <span className="text-muted-foreground font-normal text-xs">(optional)</span></FormLabel>
                              <FormControl><Input placeholder="Tucson" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                          <FormField control={form.control} name="homeState" render={({ field }) => (
                            <FormItem>
                              <FormLabel>State <span className="text-muted-foreground font-normal text-xs">(optional)</span></FormLabel>
                              <FormControl><StateSelect value={field.value} onChange={field.onChange} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                          <FormField control={form.control} name="zip" render={({ field }) => (
                            <FormItem>
                              <FormLabel>ZIP <span className="text-muted-foreground font-normal text-xs">(optional)</span></FormLabel>
                              <FormControl><Input placeholder="85701" maxLength={10} {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <SectionHeader>Emergency Contact</SectionHeader>
                      <CardContent className="p-6 space-y-4">
                        <div className="grid grid-cols-2 items-end gap-4">
                          <FormField control={form.control} name="emergencyContact" render={({ field }) => (
                            <FormItem>
                              <FormLabel>Contact Name <span className="text-muted-foreground font-normal text-xs">(optional)</span></FormLabel>
                              <FormControl><Input placeholder="Jane Morrison" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                          <FormField control={form.control} name="emergencyPhone" render={({ field }) => (
                            <FormItem>
                              <FormLabel>Contact Phone <span className="text-muted-foreground font-normal text-xs">(optional)</span></FormLabel>
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
                          <div className="flex items-start gap-3 rounded-[14px] border-2 border-[#ECECEC] bg-[#FAFAFA] px-5 py-4">
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
                                <Mail size={16} className="text-[#555] shrink-0" />
                                Send me my race day stats
                              </label>
                              <p className="text-[13px] leading-snug text-muted-foreground">
                                We'll email your results — finish position, lap times, and points — to <strong>{form.watch("email") || "your email"}</strong> once the event is complete.
                              </p>
                            </div>
                          </div>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </>
                )}

                {step === "classes" && (
                  <>
                    <Card>
                      <SectionHeader>Race Class</SectionHeader>
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
                                <p className="text-[13px] text-muted-foreground mt-0.5 mb-2">You can enter multiple classes — each costs one entry fee.</p>
                              )}
                              <div className="space-y-2 mt-1">
                                {event.raceClasses.map(cls => {
                                  const alreadyIn = alreadyRegisteredClasses.has(cls);
                                  return (
                                  <div key={cls} className={`flex items-center gap-3 rounded-[14px] border-2 px-4 min-h-[56px] transition-colors ${alreadyIn ? "bg-muted/60 border-[#ECECEC] opacity-60 cursor-not-allowed" : (field.value ?? []).includes(cls) ? "bg-background border-primary" : "bg-background border-[#ECECEC] hover:border-[#8C8C8C]"}`}>
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
                                    <label htmlFor={`class-${cls}`} className={`py-3.5 font-bold text-[#242424] flex items-center justify-between flex-1 ${alreadyIn ? "cursor-not-allowed" : "cursor-pointer"}`}>
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
                                          <span className="text-[#242424] font-bold">${effectiveEntryFee.toFixed(2)}</span>
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
                  </>
                )}

                {step === "addons" && (
                  <>
                    {showTransponderSection && (
                      <Card>
                        <SectionHeader>RM TrackR Transponder</SectionHeader>
                        <CardContent className="p-6 space-y-4">
                          {/* Own transponder number */}
                          <FormField
                            control={form.control}
                            name="myLapsTransponderNumber"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>
                                  RM TrackR Transponder Number
                                  {event.requireTransponder && !gettingTransponder
                                    ? <> <span className="text-destructive">*</span></>
                                    : <> <span className="text-muted-foreground font-normal text-xs">(optional)</span></>}
                                </FormLabel>
                                <FormControl>
                                  <Input
                                    {...field}
                                    placeholder={gettingTransponder ? "Assigned at check-in" : "e.g. 123456789"}
                                    disabled={gettingTransponder}
                                    onChange={e => {
                                      field.onChange(e);
                                      if (e.target.value.trim()) {
                                        form.setValue("rentTransponder", false);
                                        form.setValue("selectedPurchaseOptions", (form.getValues("selectedPurchaseOptions") ?? []).filter(id => id !== RM_TRACKR_OPTION_ID));
                                      }
                                    }}
                                  />
                                </FormControl>
                                <p className="text-xs text-muted-foreground">Enter the number printed on your personal active transponder.</p>
                                <FormMessage />
                              </FormItem>
                            )}
                          />

                          {/* No transponder? Rent or buy one — only what the event offers */}
                          {(offersRental || trackrOption) && (
                            <>
                              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                <div className="h-px flex-1 bg-border" />
                                <span className="uppercase tracking-widest font-semibold">or, no transponder?</span>
                                <div className="h-px flex-1 bg-border" />
                              </div>
                              {offersRental && (
                                <div className="flex items-start gap-3 rounded-lg border bg-background px-4 py-3.5">
                                  <Checkbox
                                    id="rent-transponder"
                                    checked={!!watchedRentTransponder}
                                    onCheckedChange={val => chooseTransponder(val === true ? "rent" : null)}
                                    className="mt-0.5"
                                  />
                                  <div className="space-y-0.5 leading-none">
                                    <label htmlFor="rent-transponder" className="text-sm font-semibold cursor-pointer">
                                      Rent one for this event{event.transponderRentalFee != null && <> — <span className="text-primary">${Number(event.transponderRentalFee).toFixed(2)}</span></>}
                                    </label>
                                    <p className="text-xs text-muted-foreground">
                                      Pick it up at check-in and return it after the event.
                                      {!event.paymentEnabled && event.transponderRentalFee != null && " You pay the rental fee at the gate."}
                                    </p>
                                  </div>
                                </div>
                              )}
                              {trackrOption && (
                                <div className="flex items-start gap-3 rounded-lg border bg-background px-4 py-3.5">
                                  <Checkbox
                                    id="buy-transponder"
                                    checked={buyingTrackr}
                                    onCheckedChange={val => chooseTransponder(val === true ? "buy" : null)}
                                    className="mt-0.5"
                                  />
                                  <div className="space-y-0.5 leading-none">
                                    <label htmlFor="buy-transponder" className="text-sm font-semibold cursor-pointer">
                                      Buy your own {trackrOption.name} — <span className="text-primary">${Number(trackrOption.amount).toFixed(2)}</span>
                                    </label>
                                    <p className="text-xs text-muted-foreground">
                                      Yours to keep for every race. Pick it up at check-in.
                                      {!event.paymentEnabled && " You pay for it at the gate."}
                                    </p>
                                  </div>
                                </div>
                              )}
                              {gettingTransponder && (
                                <p className="text-xs font-medium text-green-800 bg-green-50 border border-green-200 rounded-md px-3 py-2">
                                  You don't need a transponder number now. The organizer hands you your transponder at check-in and records its number.
                                </p>
                              )}
                            </>
                          )}
                        </CardContent>
                      </Card>
                    )}

                    {/* RFID Sticker */}
                    {event.rfidStickerFee != null && (
                      <Card>
                        <SectionHeader>RFID Sticker</SectionHeader>
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
                    {addOnOptions.length > 0 && (
                      <Card>
                        <SectionHeader>Add-ons</SectionHeader>
                        <CardContent className="p-6 space-y-3">
                          {addOnOptions.map(opt => (
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
                                      {opt.id === RM_TRACKR_OPTION_ID && (
                                        <p className="text-xs text-muted-foreground pt-1">
                                          Your own RM TrackR Transponder to keep. Pick it up at check-in.
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                </FormItem>
                              )}
                            />
                          ))}
                        </CardContent>
                      </Card>
                    )}
                  </>
                )}

                {step === "bike" && (
                  <>
                    <Card>
                      <SectionHeader>Bike</SectionHeader>
                      <CardContent className="p-6">
                        {/* Contingency: the organizer reports each brand's finishers from these answers. */}
                        {(event.contingencyBrands ?? []).length > 0 && (
                          <div className="mb-5 rounded-lg border border-primary/30 bg-primary/[0.03] px-4 py-3">
                            <p className="text-sm font-semibold flex items-center gap-1.5"><Flag size={14} className="text-primary" /> Contingency at this event</p>
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {(event.contingencyBrands ?? []).map(b => (
                                <span key={b} className="rounded-full border bg-background px-2.5 py-0.5 text-xs font-semibold">{b}</span>
                              ))}
                            </div>
                            <p className="text-xs text-muted-foreground mt-2">
                              These brands pay contingency on their own rules. To be included in a brand's results, pick your bike brand below and list gear or parts brands under Sponsors.
                              Register with the brand's program first, and use the same name you registered with.
                            </p>
                          </div>
                        )}
                        <FormField
                          control={form.control}
                          name="bikeBrand"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Manufacturer <span className="text-muted-foreground font-normal text-xs">(optional)</span></FormLabel>
                              <div className="mt-1">
                                <BikeBrandChips brands={BIKE_BRANDS} value={field.value} onChange={field.onChange} />
                              </div>
                              <input
                                type="text"
                                placeholder="Other brand (e.g. Sherco, TM, Rieju…)"
                                value={BIKE_BRANDS.some(b => b.name === field.value) ? "" : (field.value ?? "")}
                                onChange={e => field.onChange(e.target.value)}
                                className="mt-3 w-full rounded-none border-2 border-input bg-background px-3 text-base placeholder:text-muted-foreground focus:outline-none focus:border-foreground"
                              />
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <div className="grid grid-cols-2 items-end gap-3 mt-4">
                          <FormField control={form.control} name="bikeModel" render={({ field }) => (
                            <FormItem>
                              <FormLabel>Model <span className="text-muted-foreground font-normal text-xs">(optional)</span></FormLabel>
                              <FormControl><Input placeholder="450 SX-F, CRF450R…" {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                          <FormField control={form.control} name="bikeYear" render={({ field }) => (
                            <FormItem>
                              <FormLabel>Year <span className="text-muted-foreground font-normal text-xs">(optional)</span></FormLabel>
                              <FormControl><Input placeholder="2024" maxLength={4} {...field} /></FormControl>
                              <FormMessage />
                            </FormItem>
                          )} />
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <SectionHeader>Sponsors</SectionHeader>
                      <CardContent className="p-6">
                        <FormField control={form.control} name="sponsors" render={({ field }) => (
                          <FormItem>
                            <FormLabel>Sponsors <span className="text-muted-foreground font-normal text-xs">(optional)</span></FormLabel>
                            <FormControl>
                              <Input placeholder="KTM, FMF, Alpinestars" {...field} />
                            </FormControl>
                            <p className="text-xs text-muted-foreground mt-1">Separate multiple sponsors with a comma.</p>
                            <FormMessage />
                          </FormItem>
                        )} />
                      </CardContent>
                    </Card>
                  </>
                )}

                {step === "waiver" && (
                  <>
                    {/* Liability Waiver e-sign */}
                    {event.requireLiabilityWaiver && event.liabilityWaiverPdfUrl && (
                      <div className={`rounded-lg border px-4 py-4 space-y-3 transition-colors ${liabilityWaiverAccepted ? "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800" : "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-700"}`}>
                        <div className="flex items-start gap-3">
                          <ShieldCheck size={18} className={`mt-0.5 shrink-0 ${liabilityWaiverAccepted ? "text-green-600" : "text-red-600"}`} />
                          <div className="flex-1 space-y-1">
                            <p className="text-sm font-semibold">
                              {liabilityWaiverAccepted ? "Liability Waiver Signed" : <>Liability Waiver <span className="text-destructive">*</span></>}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {liabilityWaiverAccepted
                                ? `Signed by ${liabilityWaiverSignerName}${liabilityWaiverSignerType === "guardian" && liabilityWaiverMinorRiderName ? ` (parent/guardian of ${liabilityWaiverMinorRiderName})` : ""} — legally binding electronic signature`
                                : "You must read and electronically sign the liability waiver before registering."}
                            </p>
                          </div>
                          {liabilityWaiverAccepted && <ShieldCheck size={18} className="text-green-600 shrink-0 mt-0.5" />}
                        </div>
                        {!liabilityWaiverAccepted && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="w-full h-auto py-2.5 whitespace-normal leading-snug font-heading uppercase tracking-wider border-red-400 text-red-700 hover:bg-red-100"
                            onClick={() => {
                              setLiabilityWaiverScrolledToBottom(false);
                              setLiabilityWaiverConsentChecked(false);
                              setLiabilityWaiverConsentGiven(false);
                              setLiabilityWaiverSignerName(`${form.getValues("firstName")} ${form.getValues("lastName")}`.trim());
                              setLiabilityWaiverSignError(null);
                              setLiabilityWaiverSignerType("self");
                              setLiabilityWaiverMinorRiderName("");
                              setLiabilityWaiverModalOpen(true);
                            }}
                          >
                            <ShieldCheck size={14} className="mr-2" />
                            Read &amp; Sign Liability Waiver
                          </Button>
                        )}
                        {liabilityWaiverAccepted && (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setLiabilityWaiverScrolledToBottom(false);
                                setLiabilityWaiverSignError(null);
                                setLiabilityWaiverConsentGiven(true);
                                setLiabilityWaiverModalOpen(true);
                              }}
                              className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-primary flex-1"
                            >
                              <FileText size={12} /> View signed waiver
                            </button>
                            <button
                              type="button"
                              onClick={downloadSignedPdf}
                              disabled={liabilityWaiverDownloading}
                              className="flex items-center justify-center gap-1.5 text-xs text-primary hover:text-primary/80 font-semibold flex-1 disabled:opacity-50"
                            >
                              {liabilityWaiverDownloading
                                ? <><Loader2 size={12} className="animate-spin" /> Preparing…</>
                                : <><FileText size={12} /> Download signed copy</>}
                            </button>
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
                              {waiverAccepted ? "Acknowledgement Accepted" : <>Rider Acknowledgement Form <span className="text-destructive">*</span></>}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {waiverAccepted
                                ? `Accepted on ${waiverTimestamp ? format(new Date(waiverTimestamp), "MMM d, yyyy 'at' h:mm a") : "—"}`
                                : "You must read and acknowledge the rider acknowledgement form before registering."}
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
                            className="w-full h-auto py-2.5 whitespace-normal leading-snug font-heading uppercase tracking-wider border-amber-400 text-amber-700 hover:bg-amber-100"
                            onClick={() => { setPdfWaiverChecked(false); setPdfWaiverModalOpen(true); }}
                          >
                            <FileText size={14} className="mr-2" />
                            Read &amp; Acknowledge Rider Acknowledgement Form
                          </Button>
                        )}

                        {/* Text waiver path (no PDF) */}
                        {!event.waiverPdfUrl && !waiverAccepted && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="w-full h-auto py-2.5 whitespace-normal leading-snug font-heading uppercase tracking-wider border-amber-400 text-amber-700 hover:bg-amber-100"
                            onClick={() => { setWaiverScrolledToBottom(false); setWaiverModalOpen(true); }}
                          >
                            <FileText size={14} className="mr-2" />
                            Read &amp; Acknowledge Rider Acknowledgement Form
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
                            View acknowledgement form
                          </Button>
                        )}
                      </div>
                    )}
                  </>
                )}

                {step === "review" && (
                  <>
                    <ReviewSection title="Rider" onEdit={() => editStep("rider")}>
                      <ReviewRow label="Name" value={`${v.firstName} ${v.lastName}`.trim()} />
                      <ReviewRow label="Email" value={v.email} />
                      <ReviewRow label="Phone" value={v.phone} />
                      <ReviewRow label="Date of Birth" value={v.dateOfBirth} />
                      <ReviewRow label="Preferred #" value={v.bibNumber} />
                      {(event.requireAma || !!v.amaNumber) && <ReviewRow label="AMA #" value={v.amaNumber} />}
                      {(event.requireClubId || !!v.clubIdNumber) && <ReviewRow label="Club ID #" value={v.clubIdNumber} />}
                    </ReviewSection>

                    <ReviewSection title="Contact" onEdit={() => editStep("contact")}>
                      <ReviewRow
                        label="Address"
                        value={[v.streetAddress, v.city, [v.homeState, v.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
                      />
                      <ReviewRow label="Emergency Contact" value={[v.emergencyContact, v.emergencyPhone].filter(Boolean).join(" · ")} />
                      <ReviewRow label="Race Day Stats" value={v.statsEmailOptIn ? "Email them to me" : "No"} />
                    </ReviewSection>

                    <ReviewSection title={v.selectedClasses.length > 1 ? "Classes" : "Class"} onEdit={() => editStep("classes")}>
                      {v.selectedClasses.map(cls => (
                        <ReviewRow
                          key={cls}
                          label={cls}
                          value={event.paymentEnabled && effectiveEntryFee ? `$${effectiveEntryFee.toFixed(2)}` : "Entered"}
                        />
                      ))}
                    </ReviewSection>

                    {steps.includes("addons") && (
                      <ReviewSection title="Add-ons" onEdit={() => editStep("addons")}>
                        {showTransponderSection && (
                          <ReviewRow
                            label="Transponder"
                            value={buyingTrackr && trackrOption
                              ? `Buying ${trackrOption.name} — $${Number(trackrOption.amount).toFixed(2)}`
                              : v.rentTransponder
                                ? `Renting one${event.transponderRentalFee != null ? ` — $${Number(event.transponderRentalFee).toFixed(2)}` : ""}`
                                : v.myLapsTransponderNumber?.trim() ? `My own: ${v.myLapsTransponderNumber.trim()}` : "None"}
                          />
                        )}
                        {event.rfidStickerFee != null && (
                          <ReviewRow
                            label="RFID Sticker"
                            value={v.purchaseRfidSticker ? `Yes — $${Number(event.rfidStickerFee).toFixed(2)}` : "No"}
                          />
                        )}
                        {addOnOptions.length > 0 && (
                          <ReviewRow
                            label="Extras"
                            value={addOnOptions.filter(o => v.selectedPurchaseOptions.includes(o.id))
                              .map(o => `${o.name} — $${Number(o.amount).toFixed(2)}`).join(", ") || "None"}
                          />
                        )}
                        {!event.paymentEnabled && (gettingTransponder || v.purchaseRfidSticker) && (
                          <p className="py-2.5 text-[13px] text-muted-foreground">You pay for these at the gate.</p>
                        )}
                      </ReviewSection>
                    )}

                    <ReviewSection title="Bike" onEdit={() => editStep("bike")}>
                      <ReviewRow label="Bike" value={[v.bikeYear, v.bikeBrand, v.bikeModel].filter(Boolean).join(" ")} />
                      <ReviewRow label="Sponsors" value={v.sponsors} />
                    </ReviewSection>

                    {steps.includes("waiver") && (
                      <ReviewSection title="Waiver" onEdit={() => editStep("waiver")}>
                        {event.requireLiabilityWaiver && event.liabilityWaiverPdfUrl && (
                          <ReviewRow
                            label="Liability Waiver"
                            value={liabilityWaiverAccepted
                              ? `Signed by ${liabilityWaiverSignerName}${liabilityWaiverSignerType === "guardian" && liabilityWaiverMinorRiderName ? ` (parent/guardian of ${liabilityWaiverMinorRiderName})` : ""}`
                              : "Not signed"}
                          />
                        )}
                        {event.requireWaiver && (event.waiverText || event.waiverPdfUrl) && (
                          <ReviewRow
                            label="Acknowledgement"
                            value={waiverAccepted && waiverTimestamp ? `Accepted ${format(new Date(waiverTimestamp), "MMM d, yyyy 'at' h:mm a")}` : "Not accepted"}
                          />
                        )}
                      </ReviewSection>
                    )}

                    {event.paymentEnabled && !!effectiveEntryFee ? (
                      <Card>
                        <SectionHeader>Total</SectionHeader>
                        <CardContent className="p-6 space-y-4">
                          <dl className="space-y-2 text-[15px] text-[#333]">
                            <div className="flex justify-between gap-4">
                              <dt>
                                {numSelectedClasses > 1
                                  ? `Entry fee (${numSelectedClasses} classes × $${effectiveEntryFee.toFixed(2)})`
                                  : earlyBirdActive ? "Entry fee (early bird)" : "Entry fee"}
                              </dt>
                              <dd>${(effectiveEntryFee * Math.max(1, numSelectedClasses)).toFixed(2)}</dd>
                            </div>
                            {(event.purchaseOptions ?? []).filter(o => (watchedPurchaseOptions ?? []).includes(o.id)).map(o => (
                              <div key={o.id} className="flex justify-between gap-4">
                                <dt>{o.name}</dt><dd>${Number(o.amount).toFixed(2)}</dd>
                              </div>
                            ))}
                            {rentalTotal > 0 && (
                              <div className="flex justify-between gap-4">
                                <dt>Transponder rental</dt><dd>${rentalTotal.toFixed(2)}</dd>
                              </div>
                            )}
                            {rfidStickerTotal > 0 && (
                              <div className="flex justify-between gap-4">
                                <dt>RFID sticker</dt><dd>${rfidStickerTotal.toFixed(2)}</dd>
                              </div>
                            )}
                            {appliedComp && (
                              <div className="flex justify-between gap-4 text-green-700">
                                <dt>Discount code ({appliedComp.code})</dt>
                                <dd>−{appliedComp.discountType === "percentage"
                                  ? `${appliedComp.amount.toFixed(0)}% ($${compDiscountDollars.toFixed(2)})`
                                  : `$${compDiscountDollars.toFixed(2)}`
                                }</dd>
                              </div>
                            )}
                          </dl>
                          {/* Discount Code */}
                          {event.paymentEnabled && event.entryFee && (
                            <div className="rounded-[14px] border-2 border-[#ECECEC] bg-[#FAFAFA] px-5 py-4 space-y-3">
                              <p className="font-bold text-[#242424] flex items-center gap-1.5">
                                <Tag size={16} className="text-[#555] shrink-0" />
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
                                    className="font-mono tracking-widest flex-1 bg-white"
                                    disabled={compApplying}
                                  />
                                  <Button
                                    type="button"
                                    className="h-[52px] px-6 bg-[#242424] border-[#242424] text-white hover:bg-black"
                                    onClick={handleApplyComp}
                                    disabled={compApplying || !compCodeInput.trim()}
                                  >
                                    {compApplying ? <Loader2 size={14} className="animate-spin" /> : "Apply"}
                                  </Button>
                                </div>
                              )}
                              {compError && <p className="text-xs text-red-500">{compError}</p>}
                            </div>
                          )}
                          <div className="flex items-baseline justify-between gap-4 border-t-2 border-[#ECECEC] pt-4">
                            <span className="font-heading font-extrabold uppercase text-lg text-[#242424]">Total Due</span>
                            <span className="font-heading font-extrabold text-[28px] leading-none text-[#242424]">{totalDue === 0 ? "FREE" : `$${totalDue.toFixed(2)}`}</span>
                          </div>
                        </CardContent>
                      </Card>
                    ) : !event.paymentEnabled && (effectiveEntryFee || rentalTotal || rfidStickerTotal || selectedPurchasesTotal) ? (
                      <p className="rounded-[14px] border-2 border-[#ECECEC] bg-[#FAFAFA] px-5 py-4 text-[15px] text-[#333]">
                        This event doesn't take payment online. You pay any fees at the gate.
                      </p>
                    ) : null}
                  </>
                )}

                {/* Back / Next, kept in reach of the thumb on phones */}
                <div className="sticky bottom-0 z-10 -mx-4 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-background/95 backdrop-blur border-t-2 border-[#ECECEC] space-y-3">
                  {(stepError || (step === "review" && submitError)) && (
                    <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-md px-4 py-3 text-sm flex items-center gap-2">
                      <AlertCircle size={16} className="shrink-0" />
                      {stepError || submitError}
                    </div>
                  )}
                  <div className="flex gap-3">
                    {stepIndex > 0 && (
                      <Button type="button" variant="outline" className="h-[52px] px-5 text-base" onClick={goBack} disabled={submitting}>
                        <ChevronLeft size={18} /> Back
                      </Button>
                    )}
                    {step !== "review" ? (
                      <Button
                        key="next"
                        type="submit"
                        className="flex-1 h-[52px] text-base"
                        disabled={step === "rider" && (lookupState === "loading" || bibCheckState === "checking")}
                      >
                        {returnToReview ? "Save & Review" : `Next: ${STEP_LABELS[steps[stepIndex + 1]]}`} <ChevronRight size={18} />
                      </Button>
                    ) : (
                      <Button
                        key="finish"
                        type="submit"
                        disabled={submitting || lookupState === "pick" || (riderOptions !== null && selectedRiderId === null) || bibCheckState === "taken" || bibCheckState === "checking" || (event.requireWaiver && !waiverAccepted) || (event.requireLiabilityWaiver && !liabilityWaiverAccepted)}
                        variant="secondary"
                        className="flex-1 text-base h-[52px] hover:bg-[#146806]"
                      >
                        {submitting ? (
                          <><Loader2 size={18} className="mr-2 animate-spin" /> Processing...</>
                        ) : event.paymentEnabled && totalDue > 0 ? (
                          <><CreditCard size={18} className="mr-2" /> Pay ${totalDue.toFixed(2)}</>
                        ) : (
                          "Submit Registration"
                        )}
                      </Button>
                    )}
                  </div>
                  {step === "review" && (
                    <p className="text-center text-[13px] text-muted-foreground">By registering you agree to the event's waiver and rules.</p>
                  )}
                </div>
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

      {/* Liability Waiver e-sign modal */}
      <Dialog open={liabilityWaiverModalOpen} onOpenChange={(open) => {
        if (!open) setLiabilityWaiverSignError(null);
        setLiabilityWaiverModalOpen(open);
      }}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-6 pb-4 border-b shrink-0">
            <DialogTitle className="font-heading uppercase tracking-wide text-base flex items-center gap-2">
              <ShieldCheck size={18} className="text-primary" />
              Liability Waiver &amp; Release
            </DialogTitle>
            {liabilityWaiverConsentGiven && !liabilityWaiverScrolledToBottom && (
              <p className="text-xs text-muted-foreground mt-1">Scroll to the bottom — your information will appear in the highlighted fields as you type.</p>
            )}
            {liabilityWaiverConsentGiven && liabilityWaiverScrolledToBottom && (
              <p className="text-xs text-emerald-600 mt-1">✓ Type your full legal name below to see how your signed document will look.</p>
            )}
          </DialogHeader>

          {/* Consent gate — must agree before seeing the waiver content */}
          {!liabilityWaiverConsentGiven && (
            <div className="flex-1 flex flex-col items-center justify-center px-8 py-10 gap-6 text-center">
              <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <ShieldCheck size={28} className="text-primary" />
              </div>
              <div className="space-y-2 max-w-md">
                <p className="font-semibold text-base">Electronic Document Disclosure</p>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  This event requires a signed liability waiver. The waiver will be presented to you as an electronic document.
                  By proceeding you confirm that you have the ability to access, read, and retain an electronic document,
                  and you consent to conducting this transaction electronically rather than on paper.
                </p>
                <p className="text-xs text-muted-foreground">
                  You may withdraw consent at any time by contacting the event organizer.
                </p>
              </div>
              <div className="flex flex-col gap-2 w-full max-w-xs">
                <Button
                  type="button"
                  className="w-full font-heading uppercase tracking-wider"
                  onClick={() => setLiabilityWaiverConsentGiven(true)}
                >
                  <ShieldCheck size={15} className="mr-2" />
                  I Agree — Show Waiver
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full text-muted-foreground"
                  onClick={() => setLiabilityWaiverModalOpen(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {liabilityWaiverConsentGiven && event?.liabilityWaiverPdfUrl && (
            <PdfSignedViewer
              url={event.liabilityWaiverPdfUrl}
              fields={(event.liabilityWaiverFields ?? []) as any}
              signerName={liabilityWaiverSignerName}
              signerEmail={form.getValues("email") || ""}
              signedAt={new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
              signerType={liabilityWaiverSignerType}
              minorRiderName={liabilityWaiverMinorRiderName || undefined}
              onScrolledToBottom={() => setLiabilityWaiverScrolledToBottom(true)}
            />
          )}

          {liabilityWaiverConsentGiven && <div className="px-6 py-4 border-t shrink-0 space-y-3">
            {liabilityWaiverAccepted ? (
              <div className="flex items-center gap-2 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 px-4 py-3">
                <ShieldCheck size={16} className="text-green-600 shrink-0" />
                <p className="text-sm text-green-800 dark:text-green-200">
                  Signed by <strong>{liabilityWaiverSignerName}</strong>
                  {liabilityWaiverSignerType === "guardian" && liabilityWaiverMinorRiderName && (
                    <> — parent/guardian of <strong>{liabilityWaiverMinorRiderName}</strong></>
                  )}
                  {" "}— legally binding electronic signature on file.
                </p>
              </div>
            ) : (
              <>
                {/* Signer type — always visible */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-foreground uppercase tracking-wide">Who is signing?</p>
                  <label className="flex items-start gap-2.5 cursor-pointer select-none group">
                    <input
                      type="radio"
                      name="signerType"
                      value="self"
                      checked={liabilityWaiverSignerType === "self"}
                      onChange={() => setLiabilityWaiverSignerType("self")}
                      className="mt-0.5 shrink-0 accent-primary"
                    />
                    <span className="text-sm text-foreground leading-snug">
                      I am 18 or older, signing for myself
                    </span>
                  </label>
                  <label className="flex items-start gap-2.5 cursor-pointer select-none group">
                    <input
                      type="radio"
                      name="signerType"
                      value="guardian"
                      checked={liabilityWaiverSignerType === "guardian"}
                      onChange={() => setLiabilityWaiverSignerType("guardian")}
                      className="mt-0.5 shrink-0 accent-primary"
                    />
                    <span className="text-sm text-foreground leading-snug">
                      I am the parent/legal guardian of a minor rider, signing on their behalf
                    </span>
                  </label>
                </div>

                {/* Minor rider name — only when guardian is selected */}
                {liabilityWaiverSignerType === "guardian" && (
                  <div className="space-y-1 pl-0.5">
                    <label className="text-xs font-medium text-foreground">Minor rider's full name <span className="text-destructive">*</span></label>
                    <Input
                      placeholder="Minor rider's full legal name"
                      value={liabilityWaiverMinorRiderName}
                      onChange={(e) => setLiabilityWaiverMinorRiderName(e.target.value)}
                      className="text-sm"
                    />
                  </div>
                )}

                {!liabilityWaiverScrolledToBottom ? (
                  <p className="text-xs text-amber-600 text-center">↓ Scroll to the bottom to enable signing</p>
                ) : (
                  <>
                    <label className="flex items-start gap-2.5 cursor-pointer select-none">
                      <Checkbox
                        className="mt-0.5 shrink-0"
                        checked={liabilityWaiverConsentChecked}
                        onCheckedChange={(v) => setLiabilityWaiverConsentChecked(!!v)}
                      />
                      <span className="text-sm text-foreground leading-snug">
                        I consent to signing this liability waiver electronically rather than on paper. I understand this constitutes a legally binding electronic signature.
                      </span>
                    </label>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-foreground">
                        {liabilityWaiverSignerType === "guardian"
                          ? "Your full legal name (parent/guardian)"
                          : "Confirm your full legal name to sign"}
                        {" "}<span className="text-destructive">*</span>
                      </label>
                      <Input
                        placeholder="Full legal name"
                        value={liabilityWaiverSignerName}
                        onChange={(e) => setLiabilityWaiverSignerName(e.target.value)}
                        className="text-sm"
                      />
                    </div>
                    {liabilityWaiverSignError && (
                      <p className="text-xs text-destructive">{liabilityWaiverSignError}</p>
                    )}
                  </>
                )}
              </>
            )}
            <div className="flex gap-3">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setLiabilityWaiverModalOpen(false)}
              >
                Close
              </Button>
              {!liabilityWaiverAccepted && (
                <Button
                  type="button"
                  className="flex-1 font-heading uppercase tracking-wider"
                  disabled={
                    !liabilityWaiverScrolledToBottom ||
                    !liabilityWaiverConsentChecked ||
                    !liabilityWaiverSignerName.trim() ||
                    (liabilityWaiverSignerType === "guardian" && !liabilityWaiverMinorRiderName.trim()) ||
                    liabilityWaiverSigning
                  }
                  onClick={handleSignLiabilityWaiver}
                >
                  {liabilityWaiverSigning ? (
                    <><Loader2 size={16} className="mr-2 animate-spin" /> Signing…</>
                  ) : (
                    <><ShieldCheck size={16} className="mr-2" /> Sign &amp; Accept</>
                  )}
                </Button>
              )}
            </div>
          </div>}
        </DialogContent>
      </Dialog>

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
