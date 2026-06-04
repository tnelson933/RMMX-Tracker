import { useState, useRef, useEffect } from "react";
import { useRoute } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useListRegistrations, useUpdateRegistration, useGetEvent, getListRegistrationsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Plus, Search, Check, X, Download, Pencil, Loader2, AlertCircle,
  CheckCircle2, Banknote, CreditCard, ExternalLink, DollarSign, Smartphone,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { QRCodeSVG } from "qrcode.react";
import { useToast } from "@/hooks/use-toast";
import * as XLSX from "xlsx";
import { format } from "date-fns";

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

// ── Form schema ──────────────────────────────────────────────────────────────
// ── Edit registration schema ──────────────────────────────────────────────────
const editRegSchema = z.object({
  firstName: z.string().min(1, "Required"),
  lastName: z.string().min(1, "Required"),
  email: z.string().email("Valid email required"),
  phone: z.string().optional(),
  dateOfBirth: z.string().optional(),
  emergencyContact: z.string().optional(),
  emergencyPhone: z.string().optional(),
  raceClass: z.string().min(1, "Required"),
});
type EditRegForm = z.infer<typeof editRegSchema>;

const onSiteRegSchema = z.object({
  firstName: z.string().min(1, "Required"),
  lastName: z.string().min(1, "Required"),
  email: z.string().email("Valid email required"),
  phone: z.string().optional(),
  dateOfBirth: z.string().optional(),
  emergencyContact: z.string().optional(),
  emergencyPhone: z.string().optional(),
  hometown: z.string().optional(),
  homeState: z.string().optional(),
  raceClass: z.string().min(1, "Race class is required"),
  bibNumber: z.string().optional(),
  clubIdNumber: z.string().optional(),
  bikeBrand: z.string().optional(),
  rentTransponder: z.boolean().default(false),
  myLapsTransponderNumber: z.string().optional(),
  selectedPurchaseOptions: z.array(z.string()).default([]),
});
type OnSiteRegForm = z.infer<typeof onSiteRegSchema>;

// ── Dialog step state ────────────────────────────────────────────────────────
type Step =
  | "form"          // registration input form
  | "pay-prompt"    // "collect payment?" prompt
  | "pay-method"    // cash or card choice
  | "pay-cash"      // cash amount entry
  | "pay-card"      // stripe checkout (pending/polling)
  | "pay-done"      // payment recorded — registration confirmed
  | "reg-done"      // registration confirmed, free event (no payment needed)
  | "pending-done"  // registration saved as pending — payment not yet collected
  ;

interface RegSuccess {
  id: number;
  riderName: string;
  raceClass: string;
}

interface PendingCard {
  regId: number;
  checkoutUrl: string;
  sessionId: string;
  entryFee: number;
  rentalFee: number;
  purchaseOptionsTotal: number;
}

interface PaymentDone {
  method: "cash" | "card";
  amount: number;
}

export default function Registrations() {
  const [, params] = useRoute("/events/:eventId/registrations");
  const eventId = parseInt(params?.eventId || "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // ── Table state ─────────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");

  // Inline bib editing
  const [editingBibId, setEditingBibId] = useState<number | null>(null);
  const [editBibValue, setEditBibValue] = useState("");
  const bibInputRef = useRef<HTMLInputElement>(null);

  // ── Dialog state ─────────────────────────────────────────────────────────────
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [step, setStep] = useState<Step>("form");
  const [regSuccess, setRegSuccess] = useState<RegSuccess | null>(null);
  const [pendingCard, setPendingCard] = useState<PendingCard | null>(null);
  const [paymentDone, setPaymentDone] = useState<PaymentDone | null>(null);
  const [cashAmount, setCashAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [lookupState, setLookupState] = useState<"idle" | "loading" | "found" | "not_found">("idle");
  const [lookedUpName, setLookedUpName] = useState("");
  const [bibCheckState, setBibCheckState] = useState<"idle" | "checking" | "taken" | "available">("idle");

  // ── Data ─────────────────────────────────────────────────────────────────────
  const { data: event } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const { data: registrations, isLoading } = useListRegistrations(eventId, { query: { enabled: !!eventId } as any });
  const updateMutation = useUpdateRegistration();

  const eventEntryFee: number | null = (event as any)?.entryFee ?? null;

  // ── Registration form ─────────────────────────────────────────────────────────
  const form = useForm<OnSiteRegForm>({
    resolver: zodResolver(onSiteRegSchema),
    defaultValues: {
      firstName: "", lastName: "", email: "", phone: "",
      dateOfBirth: "", emergencyContact: "", emergencyPhone: "",
      hometown: "", homeState: "",
      raceClass: "", bibNumber: "", clubIdNumber: "", bikeBrand: "",
      rentTransponder: false, myLapsTransponderNumber: "", selectedPurchaseOptions: [],
    },
  });

  // ── Edit dialog state ─────────────────────────────────────────────────────────
  const [editingReg, setEditingReg] = useState<null | { id: number; riderId: number; firstName: string; lastName: string; email: string; phone: string; dateOfBirth: string; emergencyContact: string; emergencyPhone: string; raceClass: string }>(null);
  const [editSaving, setEditSaving] = useState(false);
  const editForm = useForm<EditRegForm>({
    resolver: zodResolver(editRegSchema),
    defaultValues: { firstName: "", lastName: "", email: "", phone: "", dateOfBirth: "", emergencyContact: "", emergencyPhone: "", raceClass: "" },
  });

  useEffect(() => {
    if (editingReg) {
      editForm.reset({
        firstName: editingReg.firstName,
        lastName: editingReg.lastName,
        email: editingReg.email,
        phone: editingReg.phone,
        dateOfBirth: editingReg.dateOfBirth,
        emergencyContact: editingReg.emergencyContact,
        emergencyPhone: editingReg.emergencyPhone,
        raceClass: editingReg.raceClass,
      });
    }
  }, [editingReg]);

  const handleEditSave = async (data: EditRegForm) => {
    if (!editingReg) return;
    setEditSaving(true);
    try {
      const nameChanged =
        data.firstName.trim().toLowerCase() !== editingReg.firstName.trim().toLowerCase() ||
        data.lastName.trim().toLowerCase() !== editingReg.lastName.trim().toLowerCase();

      let targetRiderId = editingReg.riderId;

      if (nameChanged) {
        // Create a new rider profile for the new name so other registrations
        // sharing this rider (e.g. a parent who also registered a child) are not affected.
        const newRiderRes = await fetch(`/api/riders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            firstName: data.firstName,
            lastName: data.lastName,
            email: data.email,
            phone: data.phone || null,
            dateOfBirth: data.dateOfBirth || null,
            emergencyContact: data.emergencyContact || null,
            emergencyPhone: data.emergencyPhone || null,
          }),
        });
        if (!newRiderRes.ok) { const j = await newRiderRes.json(); throw new Error(j.error || "Failed to create rider"); }
        const newRider = await newRiderRes.json();
        targetRiderId = newRider.id;
      } else {
        // Name unchanged — just update contact info on the existing rider profile
        const riderRes = await fetch(`/api/riders/${editingReg.riderId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: data.email,
            phone: data.phone || null,
            dateOfBirth: data.dateOfBirth || null,
            emergencyContact: data.emergencyContact || null,
            emergencyPhone: data.emergencyPhone || null,
          }),
        });
        if (!riderRes.ok) { const j = await riderRes.json(); throw new Error(j.error || "Failed to update rider"); }
      }

      // Update the registration: new riderId (if name changed) + race class + clear display overrides
      const regRes = await fetch(`/api/registrations/${editingReg.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          riderId: nameChanged ? targetRiderId : undefined,
          raceClass: data.raceClass,
          displayFirstName: null,
          displayLastName: null,
        }),
      });
      if (!regRes.ok) { const j = await regRes.json(); throw new Error(j.error || "Failed to update registration"); }

      await queryClient.invalidateQueries({ queryKey: getListRegistrationsQueryKey(eventId) });
      setEditingReg(null);
      toast({ title: "Registration updated" });
    } catch (e: any) {
      toast({ title: "Failed to update", description: e.message, variant: "destructive" });
    } finally {
      setEditSaving(false);
    }
  };

  const isMyLaps = (event as any)?.timingTechnology === "mylaps";
  const transponderRentalEnabled = !!(event as any)?.transponderRentalEnabled;
  const transponderRentalFee: number | null = (event as any)?.transponderRentalFee ?? null;
  const eventPurchaseOptions = ((event as any)?.purchaseOptions ?? []) as Array<{ id: string; name: string; amount: number }>;

  useEffect(() => {
    if (editingBibId !== null) bibInputRef.current?.focus();
  }, [editingBibId]);

  // Reset all dialog state when dialog closes
  useEffect(() => {
    if (!isAddOpen) {
      form.reset();
      setStep("form");
      setRegSuccess(null);
      setPendingCard(null);
      setPaymentDone(null);
      setCashAmount("");
      setSubmitting(false);
      setSubmitError(null);
      setPaymentError(null);
      setLookupState("idle");
      setLookedUpName("");
      setBibCheckState("idle");
    }
  }, [isAddOpen]);

  const noDuplicateBibs = !!(event as any)?.noDuplicateBibs;
  const requireClubId = !!(event as any)?.requireClubId;
  const watchedBib = form.watch("bibNumber");
  useEffect(() => {
    if (!noDuplicateBibs) { setBibCheckState("idle"); return; }
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
  }, [watchedBib, eventId, noDuplicateBibs]);

  // ── Email lookup — finds existing rider profile and pre-fills the form ────────
  const lookupByEmail = async (email: string) => {
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return;
    setLookupState("loading");
    setLookedUpName("");
    try {
      const res = await fetch(`/api/public/riders/lookup?email=${encodeURIComponent(trimmed)}`);
      const data = await res.json();
      if (data.found) {
        // Only overwrite fields the user hasn't already typed into themselves.
        // shouldDirty:false means auto-populate doesn't mark the field dirty,
        // so if dirtyFields[field] is true the user has typed something — leave it alone.
        const dirty = form.formState.dirtyFields;
        if (!dirty.firstName) form.setValue("firstName", data.firstName || "", { shouldDirty: false });
        if (!dirty.lastName) form.setValue("lastName", data.lastName || "", { shouldDirty: false });
        if (!dirty.phone) form.setValue("phone", data.phone || "", { shouldDirty: false });
        if (!dirty.dateOfBirth) form.setValue("dateOfBirth", data.dateOfBirth || "", { shouldDirty: false });
        if (!dirty.emergencyContact) form.setValue("emergencyContact", data.emergencyContact || "", { shouldDirty: false });
        if (!dirty.emergencyPhone) form.setValue("emergencyPhone", data.emergencyPhone || "", { shouldDirty: false });
        if (!dirty.hometown && data.hometown) form.setValue("hometown", data.hometown, { shouldDirty: false });
        if (!dirty.homeState && data.homeState) form.setValue("homeState", data.homeState, { shouldDirty: false });
        if (!dirty.bibNumber && data.bibNumber) form.setValue("bibNumber", data.bibNumber, { shouldDirty: false });
        if (!dirty.bikeBrand && data.bikeBrand) form.setValue("bikeBrand", data.bikeBrand, { shouldDirty: false });
        setLookedUpName(`${data.firstName} ${data.lastName}`);
        setLookupState("found");
      } else {
        setLookupState("not_found");
      }
    } catch {
      setLookupState("not_found");
    }
  };

  // Auto-poll card payment every 4s while on card step
  useEffect(() => {
    if (step !== "pay-card" || !pendingCard) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/public/registrations/${pendingCard.regId}/verify-payment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: pendingCard.sessionId }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.registrationId) {
            await queryClient.invalidateQueries({ queryKey: getListRegistrationsQueryKey(eventId) });
            setPaymentDone({ method: "card", amount: data.amountPaid ?? pendingCard.entryFee });
            setStep("pay-done");
          }
        }
      } catch {}
    }, 4000);
    return () => clearInterval(id);
  }, [step, pendingCard?.sessionId]);

  // ── Bib suggestions ──────────────────────────────────────────────────────────
  const confirmedBibSet = new Set<number>(
    (registrations ?? [])
      .map(r => r.bibNumber ? parseInt(r.bibNumber, 10) : NaN)
      .filter(n => !isNaN(n))
  );

  function computeSuggestions(regs: typeof registrations): Map<number, string> {
    const suggestions = new Map<number, string>();
    if (!regs) return suggestions;
    const used = new Set(confirmedBibSet);
    for (const reg of regs) {
      if (!reg.bibNumber) {
        let candidate = 1;
        while (used.has(candidate)) candidate++;
        suggestions.set(reg.id, String(candidate));
        used.add(candidate);
      }
    }
    return suggestions;
  }

  const suggestions = computeSuggestions(registrations);

  const bibCount = new Map<string, number>();
  for (const reg of registrations ?? []) {
    const bib = reg.bibNumber || suggestions.get(reg.id) || "";
    if (!bib) continue;
    bibCount.set(bib, (bibCount.get(bib) ?? 0) + 1);
  }

  const filteredRegs = (registrations ?? []).filter(r =>
    r.riderName.toLowerCase().includes(search.toLowerCase()) ||
    (r.bibNumber && r.bibNumber.includes(search)) ||
    (suggestions.get(r.id) ?? "").includes(search)
  );

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const handleCreate = async (data: OnSiteRegForm) => {
    if (isMyLaps) {
      const hasNumber = !!data.myLapsTransponderNumber?.trim();
      const hasRental = !!data.rentTransponder;
      if (!hasNumber && !hasRental) {
        form.setError("myLapsTransponderNumber", {
          message: "Enter the rider's MyLaps transponder number, or select a rental.",
        });
        return;
      }
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/events/${eventId}/registrations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          phone: data.phone || undefined,
          dateOfBirth: data.dateOfBirth || undefined,
          emergencyContact: data.emergencyContact || undefined,
          emergencyPhone: data.emergencyPhone || undefined,
          hometown: data.hometown || undefined,
          homeState: data.homeState || undefined,
          raceClass: data.raceClass,
          bibNumber: data.bibNumber || undefined,
          clubIdNumber: data.clubIdNumber || undefined,
          bikeBrand: data.bikeBrand || undefined,
          rentTransponder: data.rentTransponder || undefined,
          myLapsTransponderNumber: data.myLapsTransponderNumber || undefined,
          selectedPurchaseOptions: eventPurchaseOptions.filter(o => data.selectedPurchaseOptions.includes(o.id)),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Registration failed");

      await queryClient.invalidateQueries({ queryKey: getListRegistrationsQueryKey(eventId) });
      setRegSuccess({ id: json.id, riderName: json.riderName, raceClass: json.raceClass });

      // If event has an entry fee, prompt for payment; otherwise show basic success
      if (eventEntryFee && eventEntryFee > 0) {
        const rentalTotal = (data.rentTransponder && transponderRentalFee) ? transponderRentalFee : 0;
        const purchasesTotal = eventPurchaseOptions
          .filter(o => data.selectedPurchaseOptions.includes(o.id))
          .reduce((sum, o) => sum + Number(o.amount), 0);
        setCashAmount((eventEntryFee + rentalTotal + purchasesTotal).toFixed(2));
        setStep("pay-prompt");
      } else {
        setStep("reg-done");
      }
    } catch (e: any) {
      setSubmitError(e.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartCardPayment = async () => {
    if (!regSuccess) return;
    setSubmitting(true);
    setPaymentError(null);
    try {
      const res = await fetch(`/api/events/${eventId}/registrations/${regSuccess.id}/charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to start card payment");

      setPendingCard({
        regId: regSuccess.id,
        checkoutUrl: json.checkoutUrl,
        sessionId: json.sessionId,
        entryFee: json.entryFee,
        rentalFee: json.rentalFee ?? 0,
        purchaseOptionsTotal: json.purchaseOptionsTotal ?? 0,
      });
      setStep("pay-card");
    } catch (e: any) {
      setPaymentError(e.message || "Could not start card payment.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleManualVerifyCard = async () => {
    if (!pendingCard) return;
    setSubmitting(true);
    setPaymentError(null);
    try {
      const res = await fetch(`/api/public/registrations/${pendingCard.regId}/verify-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: pendingCard.sessionId }),
      });
      const data = await res.json();
      if (res.ok && data.registrationId) {
        await queryClient.invalidateQueries({ queryKey: getListRegistrationsQueryKey(eventId) });
        setPaymentDone({ method: "card", amount: data.amountPaid ?? pendingCard.entryFee });
        setStep("pay-done");
      } else if (res.status === 402) {
        setPaymentError("Payment hasn't completed yet. Ask the rider to finish checkout.");
      } else {
        setPaymentError(data.error || "Could not verify payment.");
      }
    } catch {
      setPaymentError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCashPayment = async () => {
    if (!regSuccess) return;
    const amount = parseFloat(cashAmount);
    if (isNaN(amount) || amount < 0) {
      setPaymentError("Enter a valid amount.");
      return;
    }
    setSubmitting(true);
    setPaymentError(null);
    try {
      const res = await fetch(`/api/registrations/${regSuccess.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentStatus: "paid", amountPaid: amount, paymentMethod: "cash" }),
      });
      if (!res.ok) throw new Error("Failed to record payment");
      await queryClient.invalidateQueries({ queryKey: getListRegistrationsQueryKey(eventId) });
      setPaymentDone({ method: "cash", amount });
      setStep("pay-done");
    } catch (e: any) {
      setPaymentError(e.message || "Could not record cash payment.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateStatus = (regId: number, status: string) => {
    updateMutation.mutate({ registrationId: regId, data: { status } }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListRegistrationsQueryKey(eventId) }),
    });
  };

  const startEditBib = (regId: number, currentBib: string | null | undefined, suggested: string | undefined) => {
    setEditingBibId(regId);
    setEditBibValue(currentBib ?? suggested ?? "");
  };

  const commitBib = (regId: number) => {
    const bib = editBibValue.trim();
    if (!bib) { setEditingBibId(null); return; }
    updateMutation.mutate({ registrationId: regId, data: { bibNumber: bib } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListRegistrationsQueryKey(eventId) });
        setEditingBibId(null);
        toast({ title: "Bib number saved" });
      },
      onError: (err) => {
        toast({ title: "Failed to save bib", description: err.message, variant: "destructive" });
      }
    });
  };

  const handleExport = () => {
    const rows = (registrations ?? []).map((r) => ({
      "Registration ID": r.id,
      "Rider Name": r.riderName,
      "Race Class": r.raceClass,
      "Bib #": r.bibNumber ?? suggestions.get(r.id) ?? "",
      "Bib Status": r.bibNumber ? "confirmed" : "suggested",
      "Status": r.status,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Registrations");
    const slug = (event?.name ?? `event-${eventId}`).replace(/[^a-z0-9]/gi, "_").toLowerCase();
    XLSX.writeFile(wb, `${slug}_registrations_${format(new Date(), "yyyy-MM-dd")}.xlsx`);
  };

  // ── Dialog content ────────────────────────────────────────────────────────────

  function renderDialogContent() {

    // ── Registration form ──────────────────────────────────────────────────
    if (step === "form") {
      return (
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleCreate)} className="space-y-5 py-2">

            {/* ── Email first — triggers rider lookup ── */}
            <div className="space-y-2">
              <h3 className="font-heading font-bold uppercase tracking-wide text-xs text-muted-foreground border-b pb-1.5">Rider Lookup</h3>
              <FormField control={form.control} name="email" render={({ field }) => (
                <FormItem>
                  <FormLabel>Email <span className="text-destructive">*</span></FormLabel>
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
                  Looking up rider profile...
                </div>
              )}
              {lookupState === "found" && (
                <div className="flex items-center gap-2 rounded-md bg-green-50 border border-green-200 text-green-800 px-4 py-3 text-sm">
                  <CheckCircle2 size={16} className="shrink-0 text-green-600" />
                  <span>Found <strong>{lookedUpName}</strong> — details pre-filled. Review and update anything that's changed.</span>
                </div>
              )}
              {lookupState === "not_found" && (
                <p className="text-xs text-muted-foreground">No existing profile found — fill in the rider's details below and we'll create one.</p>
              )}
            </div>

            {/* ── Race class ── */}
            <div className="space-y-2">
              <h3 className="font-heading font-bold uppercase tracking-wide text-xs text-muted-foreground border-b pb-1.5">Race Class</h3>
              <FormField control={form.control} name="raceClass" render={({ field }) => (
                <FormItem>
                  <FormLabel>Class <span className="text-destructive">*</span></FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger><SelectValue placeholder="Select race class" /></SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {event?.raceClasses?.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            {/* ── MyLaps transponder (conditional) ── */}
            {isMyLaps && (
              <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/[0.03] p-4">
                <h3 className="font-heading font-bold uppercase tracking-wide text-xs text-muted-foreground border-b pb-1.5">MyLaps Transponder</h3>
                <FormField control={form.control} name="myLapsTransponderNumber" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Transponder Number</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="e.g. 123456789"
                        disabled={form.watch("rentTransponder")}
                        onChange={e => {
                          field.onChange(e);
                          if (e.target.value.trim()) form.setValue("rentTransponder", false);
                        }}
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">Number printed on the rider's personal MyLaps transponder.</p>
                    <FormMessage />
                  </FormItem>
                )} />

                {transponderRentalEnabled && transponderRentalFee != null && (
                  <>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <div className="h-px flex-1 bg-border" />
                      <span className="uppercase tracking-widest font-semibold">or</span>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                    <FormField control={form.control} name="rentTransponder" render={({ field }) => (
                      <FormItem>
                        <div className="flex items-start gap-3 rounded-lg border bg-background px-4 py-3.5">
                          <FormControl>
                            <Checkbox
                              id="rent-transponder-onsite"
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
                            <label htmlFor="rent-transponder-onsite" className="text-sm font-semibold cursor-pointer">
                              Rent a MyLaps transponder — <span className="text-primary">${Number(transponderRentalFee).toFixed(2)}</span>
                            </label>
                            <p className="text-xs text-muted-foreground">Rider doesn't have their own transponder.</p>
                          </div>
                        </div>
                      </FormItem>
                    )} />
                  </>
                )}
              </div>
            )}

            {/* ── Purchase Options ── */}
            {eventPurchaseOptions.length > 0 && (
              <div className="space-y-3">
                <h3 className="font-heading font-bold uppercase tracking-wide text-xs text-muted-foreground border-b pb-1.5">Add-ons</h3>
                <div className="space-y-2">
                  {eventPurchaseOptions.map(opt => (
                    <FormField
                      key={opt.id}
                      control={form.control}
                      name="selectedPurchaseOptions"
                      render={({ field }) => (
                        <FormItem>
                          <div className="flex items-center gap-3 rounded-lg border bg-background px-4 py-3">
                            <FormControl>
                              <Checkbox
                                id={`onsite-opt-${opt.id}`}
                                checked={field.value.includes(opt.id)}
                                onCheckedChange={checked => {
                                  if (checked) {
                                    field.onChange([...field.value, opt.id]);
                                  } else {
                                    field.onChange(field.value.filter((id: string) => id !== opt.id));
                                  }
                                }}
                              />
                            </FormControl>
                            <label htmlFor={`onsite-opt-${opt.id}`} className="text-sm font-semibold cursor-pointer flex-1 flex items-center justify-between">
                              <span>{opt.name}</span>
                              <span className="text-primary">${Number(opt.amount).toFixed(2)}</span>
                            </label>
                          </div>
                        </FormItem>
                      )}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* ── Rider info ── */}
            <div className="space-y-3">
              <h3 className="font-heading font-bold uppercase tracking-wide text-xs text-muted-foreground border-b pb-1.5">Rider Info</h3>
              <div className="grid grid-cols-2 gap-3">
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
              <div className="grid grid-cols-2 gap-3">
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
                  <FormLabel>
                    Preferred Bib #
                    {noDuplicateBibs && <span className="text-destructive ml-1">*</span>}
                  </FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input placeholder="101" {...field} className={bibCheckState === "taken" ? "border-destructive pr-8" : bibCheckState === "available" ? "border-green-500 pr-8" : ""} />
                      {bibCheckState === "checking" && <Loader2 size={14} className="absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground" />}
                      {bibCheckState === "taken" && <AlertCircle size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-destructive" />}
                      {bibCheckState === "available" && <Check size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-green-500" />}
                    </div>
                  </FormControl>
                  {bibCheckState === "taken" && <p className="text-xs text-destructive">Bib #{field.value} is already taken for this event</p>}
                  {bibCheckState === "available" && <p className="text-xs text-green-600">Bib #{field.value} is available</p>}
                  <FormMessage />
                </FormItem>
              )} />
              {requireClubId && (
                <FormField control={form.control} name="clubIdNumber" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Club ID # <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input placeholder="Club membership number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              )}
              <FormField control={form.control} name="bikeBrand" render={({ field }) => (
                <FormItem>
                  <FormLabel>Bike Manufacturer</FormLabel>
                  <div className="grid grid-cols-4 gap-1.5 mt-0.5">
                    {BIKE_BRANDS.map(brand => {
                      const selected = field.value === brand.name;
                      return (
                        <button
                          key={brand.name}
                          type="button"
                          onClick={() => field.onChange(selected ? "" : brand.name)}
                          className="rounded px-1.5 py-2 text-xs font-bold font-heading uppercase tracking-wide transition-all border-2"
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
              )} />
            </div>

            {/* ── Hometown ── */}
            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="hometown" render={({ field }) => (
                <FormItem>
                  <FormLabel>Hometown</FormLabel>
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
            </div>

            {/* ── Emergency contact ── */}
            <div className="space-y-3">
              <h3 className="font-heading font-bold uppercase tracking-wide text-xs text-muted-foreground border-b pb-1.5">Emergency Contact</h3>
              <div className="grid grid-cols-2 gap-3">
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
            </div>

            {submitError && (
              <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-md px-3 py-2.5 text-sm flex items-center gap-2">
                <AlertCircle size={15} className="shrink-0" />{submitError}
              </div>
            )}

            <Button type="submit" disabled={submitting || bibCheckState === "taken" || bibCheckState === "checking"} className="w-full font-heading uppercase tracking-wider h-11">
              {submitting ? <><Loader2 size={16} className="mr-2 animate-spin" /> Registering...</> : "Complete Registration →"}
            </Button>
          </form>
        </Form>
      );
    }

    // ── Registration success, no entry fee ────────────────────────────────
    if (step === "reg-done") {
      return (
        <div className="py-6 space-y-6 text-center">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto">
            <CheckCircle2 size={32} className="text-green-600" />
          </div>
          <div>
            <h3 className="text-xl font-heading font-bold uppercase">Registered!</h3>
            <p className="text-muted-foreground mt-1">Rider confirmed and added to check-in.</p>
          </div>
          {regSuccess && <ConfirmationCard reg={regSuccess} />}
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1 font-heading uppercase" onClick={() => { form.reset(); setStep("form"); setRegSuccess(null); }}>
              Register Another
            </Button>
            <Button className="flex-1 font-heading uppercase" onClick={() => setIsAddOpen(false)}>Done</Button>
          </div>
        </div>
      );
    }

    // ── Registration saved as pending, payment not yet collected ──────────
    if (step === "pending-done") {
      return (
        <div className="py-6 space-y-6 text-center">
          <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mx-auto">
            <CreditCard size={32} className="text-amber-600" />
          </div>
          <div>
            <h3 className="text-xl font-heading font-bold uppercase">Registration Pending</h3>
            <p className="text-muted-foreground mt-1">
              Spot is <strong>not confirmed</strong> until payment is collected. You can collect payment from the registrations list.
            </p>
          </div>
          {regSuccess && (
            <ConfirmationCard
              reg={regSuccess}
              entryFee={eventEntryFee}
              rentalFee={(form.getValues("rentTransponder") && transponderRentalFee) ? transponderRentalFee : 0}
              purchaseOptionsTotal={eventPurchaseOptions.filter(o => form.getValues("selectedPurchaseOptions").includes(o.id)).reduce((s, o) => s + Number(o.amount), 0)}
            />
          )}
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1 font-heading uppercase" onClick={() => { form.reset(); setStep("form"); setRegSuccess(null); }}>
              Register Another
            </Button>
            <Button className="flex-1 font-heading uppercase" onClick={() => setIsAddOpen(false)}>Done</Button>
          </div>
        </div>
      );
    }

    // ── Payment prompt ────────────────────────────────────────────────────
    if (step === "pay-prompt") {
      return (
        <div className="py-6 space-y-6">
          <div className="text-center space-y-2">
            <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mx-auto">
              <CreditCard size={32} className="text-amber-600" />
            </div>
            <h3 className="text-xl font-heading font-bold uppercase">Payment Required</h3>
            <p className="text-muted-foreground">
              Rider is registered but <strong>not yet confirmed</strong>. Collect payment to secure their spot.
            </p>
          </div>

          {regSuccess && (
            <ConfirmationCard
              reg={regSuccess}
              entryFee={eventEntryFee}
              rentalFee={(form.getValues("rentTransponder") && transponderRentalFee) ? transponderRentalFee : 0}
              purchaseOptionsTotal={eventPurchaseOptions.filter(o => form.getValues("selectedPurchaseOptions").includes(o.id)).reduce((s, o) => s + Number(o.amount), 0)}
            />
          )}

          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <p className="font-medium text-center">Collect payment now?</p>
            <div className="flex gap-3">
              <Button className="flex-1 font-heading uppercase" onClick={() => setStep("pay-method")}>
                Yes, Collect Payment
              </Button>
              <Button variant="outline" className="flex-1 font-heading uppercase" onClick={() => setStep("pending-done")}>
                Save as Pending
              </Button>
            </div>
          </div>
        </div>
      );
    }

    // ── Payment method choice ─────────────────────────────────────────────
    if (step === "pay-method") {
      return (
        <div className="py-6 space-y-6">
          <div className="text-center">
            <h3 className="text-xl font-heading font-bold uppercase">How will the rider pay?</h3>
            {eventEntryFee && (() => {
              const rentalFee = (form.getValues("rentTransponder") && transponderRentalFee) ? transponderRentalFee : 0;
              const selectedOpts = eventPurchaseOptions.filter(o => form.getValues("selectedPurchaseOptions").includes(o.id));
              const purchasesTotal = selectedOpts.reduce((s, o) => s + Number(o.amount), 0);
              const total = eventEntryFee + rentalFee + purchasesTotal;
              const hasExtras = rentalFee > 0 || purchasesTotal > 0;
              return (
                <div className="mt-2 inline-block text-left bg-muted rounded-lg px-4 py-2.5 space-y-1">
                  <div className="flex justify-between gap-8 text-sm">
                    <span className="text-muted-foreground">Entry fee</span>
                    <span className="font-medium">${eventEntryFee.toFixed(2)}</span>
                  </div>
                  {rentalFee > 0 && (
                    <div className="flex justify-between gap-8 text-sm">
                      <span className="text-muted-foreground">Transponder rental</span>
                      <span className="font-medium">${rentalFee.toFixed(2)}</span>
                    </div>
                  )}
                  {selectedOpts.map(o => (
                    <div key={o.id} className="flex justify-between gap-8 text-sm">
                      <span className="text-muted-foreground">{o.name}</span>
                      <span className="font-medium">${Number(o.amount).toFixed(2)}</span>
                    </div>
                  ))}
                  {hasExtras && (
                    <div className="flex justify-between gap-8 text-sm border-t pt-1 mt-0.5">
                      <span className="font-bold">Total</span>
                      <span className="font-bold text-primary">${total.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <button
              onClick={() => setStep("pay-cash")}
              className="flex flex-col items-center gap-3 rounded-xl border-2 border-border hover:border-primary/50 hover:bg-primary/5 p-6 transition-all group"
            >
              <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center group-hover:bg-green-200 transition-colors">
                <Banknote size={28} className="text-green-700" />
              </div>
              <span className="font-heading font-bold uppercase tracking-wide">Cash</span>
              <span className="text-xs text-muted-foreground text-center">Record amount collected on site</span>
            </button>

            <button
              onClick={handleStartCardPayment}
              disabled={submitting}
              className="flex flex-col items-center gap-3 rounded-xl border-2 border-border hover:border-primary/50 hover:bg-primary/5 p-6 transition-all group disabled:opacity-60"
            >
              <div className="w-14 h-14 rounded-full bg-blue-100 flex items-center justify-center group-hover:bg-blue-200 transition-colors">
                {submitting ? <Loader2 size={28} className="text-blue-700 animate-spin" /> : <CreditCard size={28} className="text-blue-700" />}
              </div>
              <span className="font-heading font-bold uppercase tracking-wide">Card</span>
              <span className="text-xs text-muted-foreground text-center">Stripe checkout via link or QR</span>
            </button>
          </div>

          {paymentError && (
            <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-md px-3 py-2.5 text-sm flex items-center gap-2">
              <AlertCircle size={15} className="shrink-0" />{paymentError}
            </div>
          )}

          <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={() => setStep("pay-prompt")}>
            ← Back
          </Button>
        </div>
      );
    }

    // ── Cash payment entry ────────────────────────────────────────────────
    if (step === "pay-cash") {
      return (
        <div className="py-6 space-y-6">
          <div className="text-center">
            <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
              <Banknote size={26} className="text-green-700" />
            </div>
            <h3 className="text-xl font-heading font-bold uppercase">Cash Payment</h3>
            <p className="text-muted-foreground mt-1">Enter the amount collected from the rider.</p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Amount Received ($)</label>
            <div className="relative">
              <DollarSign size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="number"
                step="0.01"
                min="0"
                value={cashAmount}
                onChange={e => setCashAmount(e.target.value)}
                className="pl-8 text-lg font-mono h-12"
                placeholder="0.00"
                autoFocus
              />
            </div>
            {eventEntryFee && (() => {
              const rentalFee = (form.getValues("rentTransponder") && transponderRentalFee) ? transponderRentalFee : 0;
              const purchasesTotal = eventPurchaseOptions
                .filter(o => form.getValues("selectedPurchaseOptions").includes(o.id))
                .reduce((s, o) => s + Number(o.amount), 0);
              const total = eventEntryFee + rentalFee + purchasesTotal;
              return (
                <p className="text-xs text-muted-foreground">
                  Entry fee ${eventEntryFee.toFixed(2)}
                  {rentalFee > 0 ? ` + $${rentalFee.toFixed(2)} transponder rental` : ""}
                  {purchasesTotal > 0 ? ` + $${purchasesTotal.toFixed(2)} add-ons` : ""}
                  {(rentalFee > 0 || purchasesTotal > 0) ? ` = $${total.toFixed(2)} total` : ""}
                </p>
              );
            })()}
          </div>

          {paymentError && (
            <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-md px-3 py-2.5 text-sm flex items-center gap-2">
              <AlertCircle size={15} className="shrink-0" />{paymentError}
            </div>
          )}

          <div className="flex gap-3">
            <Button variant="outline" className="flex-1 font-heading uppercase" onClick={() => { setPaymentError(null); setStep("pay-method"); }}>
              ← Back
            </Button>
            <Button className="flex-1 font-heading uppercase" onClick={handleCashPayment} disabled={submitting || !cashAmount}>
              {submitting ? <><Loader2 size={16} className="mr-2 animate-spin" />Recording…</> : "Record Payment"}
            </Button>
          </div>
        </div>
      );
    }

    // ── Card payment pending (Stripe) — QR code first ────────────────────
    if (step === "pay-card" && pendingCard) {
      return (
        <div className="py-4 space-y-5">
          {/* Header */}
          <div className="text-center space-y-1">
            <h3 className="text-xl font-heading font-bold uppercase">Scan to Pay</h3>
            <p className="text-muted-foreground text-sm">
              Have the rider scan this QR code with their phone to complete checkout.
            </p>
          </div>

          {/* Amount due */}
          <div className="bg-muted rounded-lg px-4 py-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Entry Fee</span>
              <span className="text-sm font-medium">${pendingCard.entryFee.toFixed(2)}</span>
            </div>
            {pendingCard.rentalFee > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Transponder Rental</span>
                <span className="text-sm font-medium">${pendingCard.rentalFee.toFixed(2)}</span>
              </div>
            )}
            {pendingCard.purchaseOptionsTotal > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Add-ons</span>
                <span className="text-sm font-medium">${pendingCard.purchaseOptionsTotal.toFixed(2)}</span>
              </div>
            )}
            <div className="flex items-center justify-between border-t pt-1.5 mt-1">
              <span className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Total Due</span>
              <span className="font-heading font-bold text-lg">${(pendingCard.entryFee + pendingCard.rentalFee + pendingCard.purchaseOptionsTotal).toFixed(2)}</span>
            </div>
          </div>

          {/* QR code */}
          <div className="flex justify-center">
            <div className="rounded-2xl border-4 border-primary/20 bg-white p-4 shadow-md inline-flex">
              <QRCodeSVG
                value={pendingCard.checkoutUrl}
                size={220}
                level="M"
                marginSize={1}
              />
            </div>
          </div>

          {/* Polling indicator */}
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Waiting for payment confirmation…
          </div>

          {paymentError && (
            <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-md px-3 py-2.5 text-sm flex items-center gap-2">
              <AlertCircle size={15} className="shrink-0" />{paymentError}
            </div>
          )}

          <div className="space-y-2 pt-1">
            {/* Manual verify */}
            <Button className="w-full font-heading uppercase" onClick={handleManualVerifyCard} disabled={submitting}>
              {submitting ? <><Loader2 size={16} className="mr-2 animate-spin" />Checking…</> : "Verify Payment Now"}
            </Button>

            {/* Manual entry fallback */}
            <Button variant="outline" className="w-full font-heading uppercase" onClick={() => window.open(pendingCard.checkoutUrl, "_blank")}>
              <Smartphone size={16} className="mr-2" /> Enter Information Manually
            </Button>

            <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={() => { setPaymentError(null); setStep("pay-method"); }}>
              ← Change Method
            </Button>
          </div>
        </div>
      );
    }

    // ── Payment done ──────────────────────────────────────────────────────
    if (step === "pay-done" && paymentDone && regSuccess) {
      return (
        <div className="py-6 space-y-6 text-center">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto">
            <CheckCircle2 size={32} className="text-green-600" />
          </div>
          <div>
            <h3 className="text-xl font-heading font-bold uppercase">Payment Recorded!</h3>
            <p className="text-muted-foreground mt-1">Rider is fully registered and paid.</p>
          </div>
          <div className="bg-muted rounded-lg p-4 space-y-3 text-left">
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground font-bold uppercase tracking-widest">Rider</span>
              <span className="font-heading font-bold">{regSuccess.riderName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground font-bold uppercase tracking-widest">Class</span>
              <span className="font-heading font-bold text-primary">{regSuccess.raceClass}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground font-bold uppercase tracking-widest">Confirmation #</span>
              <span className="font-mono text-sm">REG-{regSuccess.id.toString().padStart(5, "0")}</span>
            </div>
            <div className="flex justify-between border-t pt-3">
              <span className="text-xs text-muted-foreground font-bold uppercase tracking-widest">Paid</span>
              <span className="font-heading font-bold text-green-600">${paymentDone.amount.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-xs text-muted-foreground font-bold uppercase tracking-widest">Method</span>
              <span className="capitalize font-medium">{paymentDone.method}</span>
            </div>
          </div>
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1 font-heading uppercase" onClick={() => {
              form.reset();
              setStep("form");
              setRegSuccess(null);
              setPendingCard(null);
              setPaymentDone(null);
              setCashAmount("");
              setSubmitError(null);
              setPaymentError(null);
            }}>
              Register Another
            </Button>
            <Button className="flex-1 font-heading uppercase" onClick={() => setIsAddOpen(false)}>Done</Button>
          </div>
        </div>
      );
    }

    return null;
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
        <div className="relative w-full max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search registrations..."
            className="pl-10"
          />
        </div>

        <div className="flex gap-2 w-full sm:w-auto">
          {(registrations?.length ?? 0) > 0 && (
            <Button variant="outline" onClick={handleExport} className="font-heading uppercase tracking-wider w-full sm:w-auto">
              <Download size={16} className="mr-2" /> Export Excel
            </Button>
          )}
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button className="font-heading uppercase tracking-wider w-full sm:w-auto">
                <Plus size={16} className="mr-2" /> Add Registration
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="font-heading uppercase text-xl">
                  {step === "form" ? "On-Site Registration" :
                   step === "pay-prompt" ? "Collect Payment" :
                   step === "pay-method" ? "Collect Payment" :
                   step === "pay-cash" ? "Cash Payment" :
                   step === "pay-card" ? "Card Payment" :
                   step === "pay-done" ? "Registration Confirmed!" :
                   step === "pending-done" ? "Registration Pending" :
                   "Registration Complete"}
                </DialogTitle>
              </DialogHeader>
              {renderDialogContent()}
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* ── Edit Registration Dialog ─────────────────────────────────────────── */}
      <Dialog open={!!editingReg} onOpenChange={open => { if (!open) setEditingReg(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-heading uppercase text-xl">Edit Registration</DialogTitle>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(handleEditSave)} className="space-y-4 py-2">
              <div className="space-y-2">
                <h3 className="font-heading font-bold uppercase tracking-wide text-xs text-muted-foreground border-b pb-1.5">Rider Info</h3>
                <p className="text-xs text-muted-foreground bg-muted/40 rounded px-3 py-2 border border-dashed">
                  Updating a rider's info here changes their profile — name and contact info will reflect across check-in, results, and all pages for this event.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <FormField control={editForm.control} name="firstName" render={({ field }) => (
                    <FormItem>
                      <FormLabel>First Name <span className="text-destructive">*</span></FormLabel>
                      <FormControl><Input {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={editForm.control} name="lastName" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Last Name <span className="text-destructive">*</span></FormLabel>
                      <FormControl><Input {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
                <FormField control={editForm.control} name="email" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input type="email" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <div className="grid grid-cols-2 gap-3">
                  <FormField control={editForm.control} name="phone" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone</FormLabel>
                      <FormControl><Input {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={editForm.control} name="dateOfBirth" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Date of Birth</FormLabel>
                      <FormControl><Input type="date" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="font-heading font-bold uppercase tracking-wide text-xs text-muted-foreground border-b pb-1.5">Emergency Contact</h3>
                <div className="grid grid-cols-2 gap-3">
                  <FormField control={editForm.control} name="emergencyContact" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Contact Name</FormLabel>
                      <FormControl><Input {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={editForm.control} name="emergencyPhone" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Contact Phone</FormLabel>
                      <FormControl><Input {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="font-heading font-bold uppercase tracking-wide text-xs text-muted-foreground border-b pb-1.5">Race Class</h3>
                <FormField control={editForm.control} name="raceClass" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Class <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger><SelectValue placeholder="Select race class" /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {event?.raceClasses?.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <div className="flex gap-3 pt-2">
                <Button type="button" variant="outline" className="flex-1 font-heading uppercase" onClick={() => setEditingReg(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={editSaving} className="flex-1 font-heading uppercase">
                  {editSaving ? <><Loader2 size={16} className="mr-2 animate-spin" />Saving...</> : "Save Changes"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Card>
        <div className="rounded-md border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-16">ID</TableHead>
                <TableHead className="font-heading font-bold uppercase tracking-wider">Rider</TableHead>
                <TableHead className="font-heading font-bold uppercase tracking-wider">Class</TableHead>
                <TableHead className="font-heading font-bold uppercase tracking-wider">Bib</TableHead>
                <TableHead className="font-heading font-bold uppercase tracking-wider">Status</TableHead>
                <TableHead className="text-right font-heading font-bold uppercase tracking-wider">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8">Loading...</TableCell></TableRow>
              ) : filteredRegs.length > 0 ? (
                filteredRegs.map(reg => {
                  const suggested = suggestions.get(reg.id);
                  const effectiveBib = reg.bibNumber || suggested || "";
                  const isDuplicate = effectiveBib ? (bibCount.get(effectiveBib) ?? 0) > 1 : false;
                  const isSuggested = !reg.bibNumber && !!suggested;
                  const isEditing = editingBibId === reg.id;

                  return (
                    <TableRow key={reg.id}>
                      <TableCell className="text-muted-foreground font-mono">{reg.id}</TableCell>
                      <TableCell>
                        <button
                          onClick={() => setEditingReg({
                            id: reg.id,
                            riderId: reg.riderId,
                            firstName: (reg as any).firstName ?? "",
                            lastName: (reg as any).lastName ?? "",
                            email: (reg as any).email ?? "",
                            phone: (reg as any).phone ?? "",
                            dateOfBirth: (reg as any).dateOfBirth ?? "",
                            emergencyContact: (reg as any).emergencyContact ?? "",
                            emergencyPhone: (reg as any).emergencyPhone ?? "",
                            raceClass: reg.raceClass,
                          })}
                          className="group flex items-center gap-1.5 font-bold hover:text-primary transition-colors text-left"
                          title="Click to edit registration"
                        >
                          {reg.riderName}
                          <Pencil size={12} className="opacity-0 group-hover:opacity-50 transition-opacity shrink-0" />
                        </button>
                      </TableCell>
                      <TableCell>
                        <span className="bg-secondary/10 text-secondary px-2 py-1 rounded text-xs font-bold uppercase tracking-wider">
                          {reg.raceClass}
                        </span>
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <Input
                              ref={bibInputRef}
                              value={editBibValue}
                              onChange={e => setEditBibValue(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === "Enter") commitBib(reg.id);
                                if (e.key === "Escape") setEditingBibId(null);
                              }}
                              className="h-7 w-20 font-mono text-sm px-2"
                            />
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-secondary hover:text-secondary" onClick={() => commitBib(reg.id)} disabled={updateMutation.isPending}>
                              <Check size={14} />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={() => setEditingBibId(null)}>
                              <X size={14} />
                            </Button>
                          </div>
                        ) : effectiveBib ? (
                          <button
                            onClick={() => startEditBib(reg.id, reg.bibNumber, suggested)}
                            className={`group flex items-center gap-1.5 font-mono px-2 py-1 rounded border transition-colors hover:border-primary/40 hover:bg-primary/5 ${
                              isDuplicate
                                ? "bg-destructive/10 border-destructive/40 text-destructive"
                                : isSuggested
                                ? "bg-transparent border-dashed border-muted-foreground/30 text-muted-foreground italic"
                                : "bg-muted border-border text-foreground"
                            }`}
                            title={isSuggested ? "Suggested — click to confirm or change" : isDuplicate ? "Duplicate bib number" : "Click to edit"}
                          >
                            {effectiveBib}
                            <Pencil size={10} className="opacity-0 group-hover:opacity-60 transition-opacity" />
                          </button>
                        ) : (
                          <button onClick={() => startEditBib(reg.id, null, undefined)} className="text-muted-foreground/40 hover:text-muted-foreground text-sm italic transition-colors">
                            —
                          </button>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className={`px-2 py-1 rounded text-xs font-bold uppercase tracking-wider border ${
                            reg.status === 'confirmed' ? 'bg-secondary/10 text-secondary border-secondary/20' :
                            reg.status === 'pending' ? 'bg-amber-500/10 text-amber-600 border-amber-500/20' :
                            'bg-muted text-muted-foreground border-border'
                          }`}>
                            {reg.status === 'pending' ? 'Pending Payment' : reg.status}
                          </span>
                          {(reg as any).paymentStatus === 'paid' && (
                            <span className="px-1.5 py-0.5 rounded text-xs font-bold uppercase tracking-wider bg-green-500/10 text-green-600 border border-green-500/20">
                              Paid
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {reg.status !== 'confirmed' && (
                          <Button variant="ghost" size="icon" onClick={() => handleUpdateStatus(reg.id, 'confirmed')} className="text-secondary hover:text-secondary hover:bg-secondary/10">
                            <Check size={18} />
                          </Button>
                        )}
                        {reg.status !== 'void' && (
                          <Button variant="ghost" size="icon" onClick={() => handleUpdateStatus(reg.id, 'void')} className="text-destructive hover:text-destructive hover:bg-destructive/10">
                            <X size={18} />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No registrations found.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}

// ── Small helper component ────────────────────────────────────────────────────
function ConfirmationCard({ reg, entryFee, rentalFee, purchaseOptionsTotal }: { reg: { id: number; riderName: string; raceClass: string }; entryFee?: number | null; rentalFee?: number | null; purchaseOptionsTotal?: number | null }) {
  const hasRental = rentalFee != null && rentalFee > 0;
  const hasPurchases = purchaseOptionsTotal != null && purchaseOptionsTotal > 0;
  const total = (entryFee ?? 0) + (hasRental ? (rentalFee ?? 0) : 0) + (hasPurchases ? (purchaseOptionsTotal ?? 0) : 0);
  const hasExtras = hasRental || hasPurchases;
  return (
    <div className="bg-muted rounded-lg p-4 space-y-2 text-left text-sm">
      <div className="flex justify-between">
        <span className="text-muted-foreground font-bold uppercase tracking-widest text-xs">Rider</span>
        <span className="font-heading font-bold">{reg.riderName}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground font-bold uppercase tracking-widest text-xs">Class</span>
        <span className="font-heading font-bold text-primary">{reg.raceClass}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground font-bold uppercase tracking-widest text-xs">Confirmation #</span>
        <span className="font-mono">REG-{reg.id.toString().padStart(5, "0")}</span>
      </div>
      {entryFee != null && entryFee > 0 && (
        <div className="border-t pt-2 mt-1 space-y-1.5">
          <div className="flex justify-between">
            <span className="text-muted-foreground font-bold uppercase tracking-widest text-xs">Entry Fee</span>
            <span className="font-heading font-bold">${entryFee.toFixed(2)}</span>
          </div>
          {hasRental && (
            <div className="flex justify-between">
              <span className="text-muted-foreground font-bold uppercase tracking-widest text-xs">Transponder Rental</span>
              <span className="font-heading font-bold">${(rentalFee as number).toFixed(2)}</span>
            </div>
          )}
          {hasPurchases && (
            <div className="flex justify-between">
              <span className="text-muted-foreground font-bold uppercase tracking-widest text-xs">Add-ons</span>
              <span className="font-heading font-bold">${(purchaseOptionsTotal as number).toFixed(2)}</span>
            </div>
          )}
          {hasExtras && (
            <div className="flex justify-between border-t pt-1.5">
              <span className="text-muted-foreground font-bold uppercase tracking-widest text-xs">Total Due</span>
              <span className="font-heading font-bold text-primary">${total.toFixed(2)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
