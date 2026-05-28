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
import { Plus, Search, Check, X, Download, Pencil, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import * as XLSX from "xlsx";
import { format } from "date-fns";

const onSiteRegSchema = z.object({
  firstName: z.string().min(1, "Required"),
  lastName: z.string().min(1, "Required"),
  email: z.string().email("Valid email required"),
  phone: z.string().optional(),
  dateOfBirth: z.string().optional(),
  emergencyContact: z.string().optional(),
  emergencyPhone: z.string().optional(),
  raceClass: z.string().min(1, "Race class is required"),
  bibNumber: z.string().optional(),
});
type OnSiteRegForm = z.infer<typeof onSiteRegSchema>;

interface RegSuccess {
  id: number;
  riderName: string;
  raceClass: string;
}

export default function Registrations() {
  const [match, params] = useRoute("/events/:eventId/registrations");
  const eventId = parseInt(params?.eventId || "0");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<RegSuccess | null>(null);

  // Inline bib editing state
  const [editingBibId, setEditingBibId] = useState<number | null>(null);
  const [editBibValue, setEditBibValue] = useState("");
  const bibInputRef = useRef<HTMLInputElement>(null);

  const { data: event } = useGetEvent(eventId, { query: { enabled: !!eventId } as any });
  const { data: registrations, isLoading } = useListRegistrations(eventId, { query: { enabled: !!eventId } as any });

  const updateMutation = useUpdateRegistration();

  const form = useForm<OnSiteRegForm>({
    resolver: zodResolver(onSiteRegSchema),
    defaultValues: {
      firstName: "", lastName: "", email: "", phone: "",
      dateOfBirth: "", emergencyContact: "", emergencyPhone: "",
      raceClass: "", bibNumber: "",
    },
  });

  useEffect(() => {
    if (editingBibId !== null) bibInputRef.current?.focus();
  }, [editingBibId]);

  // Reset form when dialog closes
  useEffect(() => {
    if (!isAddOpen) {
      form.reset();
      setSubmitError(null);
      setAddSuccess(null);
    }
  }, [isAddOpen]);

  // Build set of all confirmed bibs (as numbers) across the event
  const confirmedBibSet = new Set<number>(
    (registrations ?? [])
      .map(r => r.bibNumber ? parseInt(r.bibNumber, 10) : NaN)
      .filter(n => !isNaN(n))
  );

  // Assign a unique suggested bib to each rider missing one
  function computeSuggestions(regs: typeof registrations): Map<number, string> {
    const suggestions = new Map<number, string>();
    if (!regs) return suggestions;
    const usedInSuggestions = new Set(confirmedBibSet);
    for (const reg of regs) {
      if (!reg.bibNumber) {
        let candidate = 1;
        while (usedInSuggestions.has(candidate)) candidate++;
        suggestions.set(reg.id, String(candidate));
        usedInSuggestions.add(candidate);
      }
    }
    return suggestions;
  }

  const suggestions = computeSuggestions(registrations);

  // Detect duplicate bibs: count occurrences of each effective bib across all registrations
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

  const handleCreate = async (data: OnSiteRegForm) => {
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
          raceClass: data.raceClass,
          bibNumber: data.bibNumber || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Registration failed");

      await queryClient.invalidateQueries({ queryKey: getListRegistrationsQueryKey(eventId) });
      setAddSuccess({
        id: json.id,
        riderName: json.riderName,
        raceClass: json.raceClass,
      });
    } catch (e: any) {
      setSubmitError(e.message || "Something went wrong. Please try again.");
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

  const cancelEditBib = () => setEditingBibId(null);

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
                <DialogTitle className="font-heading uppercase text-xl">On-Site Registration</DialogTitle>
              </DialogHeader>

              {addSuccess ? (
                /* Success state */
                <div className="py-6 space-y-6 text-center">
                  <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto">
                    <CheckCircle2 size={32} className="text-green-600" />
                  </div>
                  <div>
                    <h3 className="text-xl font-heading font-bold uppercase">Registered!</h3>
                    <p className="text-muted-foreground mt-1">Rider has been confirmed and added to check-in.</p>
                  </div>
                  <div className="bg-muted rounded-lg p-4 text-left space-y-2">
                    <div className="flex justify-between">
                      <span className="text-sm text-muted-foreground font-bold uppercase tracking-widest">Rider</span>
                      <span className="font-heading font-bold">{addSuccess.riderName}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-muted-foreground font-bold uppercase tracking-widest">Class</span>
                      <span className="font-heading font-bold text-primary">{addSuccess.raceClass}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-muted-foreground font-bold uppercase tracking-widest">Confirmation #</span>
                      <span className="font-mono text-sm">REG-{addSuccess.id.toString().padStart(5, "0")}</span>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <Button variant="outline" className="flex-1 font-heading uppercase" onClick={() => {
                      form.reset();
                      setAddSuccess(null);
                      setSubmitError(null);
                    }}>
                      Register Another
                    </Button>
                    <Button className="flex-1 font-heading uppercase" onClick={() => setIsAddOpen(false)}>
                      Done
                    </Button>
                  </div>
                </div>
              ) : (
                /* Registration form */
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(handleCreate)} className="space-y-5 py-2">
                    {/* Race Class */}
                    <div className="space-y-2">
                      <h3 className="font-heading font-bold uppercase tracking-wide text-xs text-muted-foreground border-b pb-1.5">Race Class</h3>
                      <FormField
                        control={form.control}
                        name="raceClass"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Class <span className="text-destructive">*</span></FormLabel>
                            <Select onValueChange={field.onChange} value={field.value}>
                              <FormControl>
                                <SelectTrigger>
                                  <SelectValue placeholder="Select race class" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {event?.raceClasses?.map(c => (
                                  <SelectItem key={c} value={c}>{c}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    {/* Rider Info */}
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
                      <FormField control={form.control} name="email" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Email <span className="text-destructive">*</span></FormLabel>
                          <FormControl><Input type="email" placeholder="rider@example.com" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
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
                          <FormLabel>Preferred Bib #</FormLabel>
                          <FormControl><Input placeholder="101" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>

                    {/* Emergency Contact */}
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
                        <AlertCircle size={15} className="shrink-0" />
                        {submitError}
                      </div>
                    )}

                    <Button
                      type="submit"
                      disabled={submitting}
                      className="w-full font-heading uppercase tracking-wider h-11"
                    >
                      {submitting ? (
                        <><Loader2 size={16} className="mr-2 animate-spin" /> Registering...</>
                      ) : (
                        "Complete Registration →"
                      )}
                    </Button>
                  </form>
                </Form>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </div>

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
                      <TableCell className="font-bold">{reg.riderName}</TableCell>
                      <TableCell>
                        <span className="bg-secondary/10 text-secondary px-2 py-1 rounded text-xs font-bold uppercase tracking-wider">
                          {reg.raceClass}
                        </span>
                      </TableCell>

                      {/* Bib cell */}
                      <TableCell>
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <Input
                              ref={bibInputRef}
                              value={editBibValue}
                              onChange={e => setEditBibValue(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === "Enter") commitBib(reg.id);
                                if (e.key === "Escape") cancelEditBib();
                              }}
                              className="h-7 w-20 font-mono text-sm px-2"
                            />
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-secondary hover:text-secondary" onClick={() => commitBib(reg.id)} disabled={updateMutation.isPending}>
                              <Check size={14} />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={cancelEditBib}>
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
