import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListClubs,
  useCreateClub,
  useUpdateClub,
  useDeleteClub,
  useResendUserInvite,
  getListClubsQueryKey,
} from "@workspace/api-client-react";
import type { Club } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import {
  Plus, Pencil, Trash2, Building2, Mail, Phone, Globe, MapPin, Hash,
  Search, X as XIcon, ShieldOff, User, CheckCircle, Clock, RefreshCw,
  Copy, Check, AlertTriangle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];

const clubSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  state: z.string().length(2, "Select a state"),
  contactEmail: z.string().email("Enter a valid email").or(z.literal("")).optional(),
  contactPhone: z.string().optional(),
  website: z.string().optional().refine(
    val => !val || /^(https?:\/\/)?[\w\-.]+(\.[\w\-.]+)+(\/[^\s]*)?$/.test(val),
    { message: "Enter a valid website (e.g. myclub.com)" }
  ),
  description: z.string().optional(),
  organizerName: z.string().optional(),
  organizerEmail: z.string().email("Enter a valid email").or(z.literal("")).optional(),
});

type ClubFormValues = z.infer<typeof clubSchema>;

function matchesSearch(club: Club, q: string): boolean {
  const term = q.toLowerCase().trim();
  if (!term) return true;
  return (
    club.name.toLowerCase().includes(term) ||
    String(club.id).includes(term) ||
    (club.contactPhone ?? "").replace(/\D/g, "").includes(term.replace(/\D/g, "")) ||
    (club.contactPhone ?? "").toLowerCase().includes(term) ||
    (club.contactEmail ?? "").toLowerCase().includes(term) ||
    (club.organizer?.email ?? "").toLowerCase().includes(term) ||
    (club.organizer?.name ?? "").toLowerCase().includes(term)
  );
}

export default function ClubsAdmin() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: clubs = [], isLoading } = useListClubs({ query: {} as any });

  const createMutation = useCreateClub();
  const updateMutation = useUpdateClub();
  const deleteMutation = useDeleteClub();
  const resendMutation = useResendUserInvite();

  const [editingClub, setEditingClub] = useState<Club | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Club | null>(null);
  const [search, setSearch] = useState("");
  const [togglingId, setTogglingId] = useState<number | null>(null);

  // Setup-link dialog (always shown after invite/reset so admin can copy the link)
  const [setupLinkUrl, setSetupLinkUrl] = useState<string | null>(null);
  const [setupLinkName, setSetupLinkName] = useState("");
  const [setupLinkEmailSent, setSetupLinkEmailSent] = useState(false);
  const [copied, setCopied] = useState(false);

  const form = useForm<ClubFormValues>({
    resolver: zodResolver(clubSchema),
    defaultValues: {
      name: "", state: "", contactEmail: "", contactPhone: "",
      website: "", description: "", organizerName: "", organizerEmail: "",
    },
  });

  const openCreate = () => {
    form.reset({
      name: "", state: "", contactEmail: "", contactPhone: "",
      website: "", description: "", organizerName: "", organizerEmail: "",
    });
    setEditingClub(null);
    setShowForm(true);
  };

  const openEdit = (club: Club) => {
    form.reset({
      name: club.name,
      state: club.state,
      contactEmail: club.contactEmail ?? "",
      contactPhone: club.contactPhone ?? "",
      website: club.website ?? "",
      description: club.description ?? "",
      organizerName: "",
      organizerEmail: "",
    });
    setEditingClub(club);
    setShowForm(true);
  };

  const onSubmit = (data: ClubFormValues) => {
    const formatWebsite = (w?: string) =>
      w ? (w.startsWith("http") ? w : `https://${w}`) : undefined;

    // Organizer required on create; required when editing a club with no organizer yet
    const needsOrganizer = editingClub && !editingClub.organizer;
    if (!editingClub || needsOrganizer) {
      let hasError = false;
      if (!data.organizerName?.trim()) {
        form.setError("organizerName", { message: "Organizer name is required" });
        hasError = true;
      }
      if (!data.organizerEmail?.trim()) {
        form.setError("organizerEmail", { message: "Organizer email is required" });
        hasError = true;
      }
      if (hasError) return;
    }
    const payload = {
      name: data.name,
      state: data.state,
      contactEmail: data.contactEmail || undefined,
      contactPhone: data.contactPhone || undefined,
      website: formatWebsite(data.website),
      description: data.description || undefined,
      ...(((!editingClub || needsOrganizer) && data.organizerName && data.organizerEmail)
        ? { organizerName: data.organizerName, organizerEmail: data.organizerEmail }
        : {}),
    };

    if (editingClub) {
      updateMutation.mutate(
        { clubId: editingClub.id, data: payload },
        {
          onSuccess: (resp: any) => {
            queryClient.invalidateQueries({ queryKey: getListClubsQueryKey() });
            setShowForm(false);
            if (resp?.organizer && resp?.setupUrl) {
              setSetupLinkName(resp.organizer.name);
              setSetupLinkEmailSent(!!resp.emailSent);
              setSetupLinkUrl(resp.setupUrl);
            } else {
              toast({ title: "Club updated", description: `${data.name} has been updated.` });
            }
          },
          onError: () => toast({ title: "Error", description: "Failed to update club.", variant: "destructive" }),
        }
      );
    } else {
      createMutation.mutate(
        { data: payload },
        {
          onSuccess: (resp: any) => {
            queryClient.invalidateQueries({ queryKey: getListClubsQueryKey() });
            setShowForm(false);
            if (resp?.organizer && resp?.setupUrl) {
              setSetupLinkName(resp.organizer.name);
              setSetupLinkEmailSent(!!resp.emailSent);
              setSetupLinkUrl(resp.setupUrl);
            } else if (resp?.organizer) {
              toast({
                title: "Club created",
                description: `${data.name} added. Invite sent to ${resp.organizer.email}.`,
              });
            } else {
              toast({ title: "Club created", description: `${data.name} has been added.` });
            }
          },
          onError: () => toast({ title: "Error", description: "Failed to create club.", variant: "destructive" }),
        }
      );
    }
  };

  const toggleActive = (club: Club) => {
    setTogglingId(club.id);
    updateMutation.mutate(
      { clubId: club.id, data: { active: !club.active } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListClubsQueryKey() });
          toast({
            title: club.active ? "Club deactivated" : "Club activated",
            description: club.active
              ? `${club.name} is suspended. Organizers will see an inactive message at login.`
              : `${club.name} is active again.`,
          });
        },
        onError: () => toast({ title: "Error", description: "Failed to update club status.", variant: "destructive" }),
        onSettled: () => setTogglingId(null),
      }
    );
  };

  const handleResendInvite = (userId: number, userName: string) => {
    resendMutation.mutate(
      { userId },
      {
        onSuccess: (resp: any) => {
          if (resp?.setupUrl) {
            setSetupLinkName(userName);
            setSetupLinkEmailSent(!!resp.emailSent);
            setSetupLinkUrl(resp.setupUrl);
          } else {
            toast({ title: "Invite resent", description: `Setup email sent to ${userName}.` });
          }
        },
        onError: () => toast({ title: "Failed to resend", variant: "destructive" }),
      }
    );
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(
      { clubId: deleteTarget.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListClubsQueryKey() });
          setDeleteTarget(null);
          toast({ title: "Club deleted", description: `${deleteTarget.name} has been removed.` });
        },
        onError: (err: any) => {
          const msg = err?.response?.data?.message ?? err?.message;
          toast({
            title: "Cannot delete club",
            description: msg ?? "Failed to delete club.",
            variant: "destructive",
          });
        },
      }
    );
  };

  const copyLink = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isBusy = createMutation.isPending || updateMutation.isPending;
  const filteredClubs = clubs.filter(c => matchesSearch(c, search));
  const hasSearch = search.trim().length > 0;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Building2 className="text-primary" size={28} />
            <h1 className="text-3xl font-heading font-bold uppercase tracking-tight">Club Management</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            Set up clubs and their organizer accounts. Each club gets a login for the race management portal.
          </p>
        </div>
        <Button onClick={openCreate} className="gap-2 font-heading font-bold uppercase tracking-wider">
          <Plus size={16} />
          New Club
        </Button>
      </div>

      {/* Search */}
      <div className="mb-6">
        <div className="flex items-center gap-2 max-w-sm">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search by name, ID, phone, email…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          {hasSearch && (
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => setSearch("")}>
              <XIcon size={14} />
            </Button>
          )}
        </div>
        {hasSearch && (
          <p className="text-sm text-muted-foreground mt-2">
            {filteredClubs.length === 0
              ? <span className="flex items-center gap-1.5"><Search size={13} /> No clubs matched <span className="font-semibold">"{search}"</span></span>
              : <span>{filteredClubs.length} club{filteredClubs.length !== 1 ? "s" : ""} matched</span>
            }
          </p>
        )}
      </div>

      {/* Club list */}
      {isLoading ? (
        <div className="text-muted-foreground text-center py-16 animate-pulse font-heading uppercase tracking-widest">
          Loading clubs...
        </div>
      ) : clubs.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <Building2 size={48} className="mx-auto mb-4 opacity-30" />
          <p className="font-heading uppercase tracking-wider">No clubs yet</p>
          <p className="text-sm mt-1">Add the first club to get started.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {filteredClubs.map((club) => (
            <div
              key={club.id}
              className={`bg-card border rounded-sm p-5 transition-colors ${
                club.active
                  ? "border-border hover:border-primary/30"
                  : "border-destructive/30 bg-destructive/5"
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                {/* Club info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-2 flex-wrap">
                    <h2 className={`text-lg font-heading font-bold uppercase tracking-tight ${!club.active ? "text-muted-foreground" : ""}`}>
                      {club.name}
                    </h2>
                    {!club.active && (
                      <Badge variant="destructive" className="text-xs flex items-center gap-1">
                        <ShieldOff size={10} />
                        Inactive
                      </Badge>
                    )}
                    <Badge variant="outline" className="font-mono text-xs flex items-center gap-1">
                      <MapPin size={10} />
                      {club.state}
                    </Badge>
                    <Badge variant="secondary" className="font-mono text-xs flex items-center gap-1 bg-muted text-muted-foreground">
                      <Hash size={10} />
                      Club ID: {club.id}
                    </Badge>
                  </div>

                  {club.description && (
                    <p className="text-sm text-muted-foreground mb-3 line-clamp-1">{club.description}</p>
                  )}

                  {/* Club contact details */}
                  <div className="flex flex-wrap gap-4 text-xs text-muted-foreground mb-3">
                    {club.contactEmail && (
                      <span className="flex items-center gap-1.5">
                        <Mail size={12} />
                        {club.contactEmail}
                      </span>
                    )}
                    {club.contactPhone && (
                      <span className="flex items-center gap-1.5">
                        <Phone size={12} />
                        {club.contactPhone}
                      </span>
                    )}
                    {club.website && (
                      <a
                        href={club.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 hover:text-primary transition-colors"
                      >
                        <Globe size={12} />
                        {club.website.replace(/^https?:\/\//, "")}
                      </a>
                    )}
                  </div>

                  {/* Organizer account row */}
                  <div className={`rounded-sm px-3 py-2 flex items-center gap-3 text-xs ${
                    club.organizer
                      ? "bg-muted/40 border border-border/50"
                      : "bg-muted/20 border border-dashed border-border/40"
                  }`}>
                    <User size={13} className="shrink-0 text-muted-foreground" />
                    {club.organizer ? (
                      <div className="flex items-center gap-3 flex-1 min-w-0 flex-wrap">
                        <span className="font-medium text-foreground">{club.organizer.name}</span>
                        <span className="text-muted-foreground font-mono">{club.organizer.email}</span>
                        {club.organizer.hasPassword ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20">
                            <CheckCircle size={10} /> Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider bg-yellow-500/10 text-yellow-600 border border-yellow-500/20">
                            <Clock size={10} /> Invite Pending
                          </span>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground ml-auto"
                          onClick={() => handleResendInvite(club.organizer!.id, club.organizer!.name)}
                          disabled={resendMutation.isPending}
                        >
                          {resendMutation.isPending ? <RefreshCw size={10} className="animate-spin" /> : <Mail size={10} />}
                          {club.organizer.hasPassword ? "Send Password Reset" : "Resend Invite"}
                        </Button>
                      </div>
                    ) : (
                      <span className="text-muted-foreground italic">No organizer account — edit to add one</span>
                    )}
                  </div>
                </div>

                {/* Actions column */}
                <div className="flex flex-col items-end gap-3 shrink-0">
                  {/* Active toggle */}
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-heading font-bold uppercase tracking-wider ${club.active ? "text-green-600 dark:text-green-400" : "text-destructive"}`}>
                      {club.active ? "Active" : "Inactive"}
                    </span>
                    <Switch
                      checked={club.active}
                      onCheckedChange={() => toggleActive(club)}
                      disabled={togglingId === club.id}
                      aria-label={club.active ? "Deactivate club" : "Activate club"}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 h-8"
                      onClick={() => openEdit(club)}
                    >
                      <Pencil size={13} />
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 h-8 text-destructive border-destructive/30 hover:bg-destructive hover:text-destructive-foreground"
                      onClick={() => setDeleteTarget(club)}
                    >
                      <Trash2 size={13} />
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-heading uppercase tracking-tight text-xl">
              {editingClub ? "Edit Club" : "New Club"}
            </DialogTitle>
            <DialogDescription>
              {editingClub
                ? `Editing ${editingClub.name}`
                : "Set up a new club and optionally create their organizer login."}
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Club details section */}
              <div className="space-y-1 pb-1">
                <p className="text-xs font-heading font-bold uppercase tracking-widest text-muted-foreground">Club Details</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="col-span-2">
                      <FormLabel className="font-heading uppercase text-xs tracking-wider text-muted-foreground font-bold">Club Name *</FormLabel>
                      <FormControl>
                        <Input placeholder="Desert Storm MX Club" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="state"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-heading uppercase text-xs tracking-wider text-muted-foreground font-bold">State *</FormLabel>
                      <FormControl>
                        <select
                          {...field}
                          className="flex h-9 w-full rounded-sm border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <option value="">Select state</option>
                          {US_STATES.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="contactPhone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-heading uppercase text-xs tracking-wider text-muted-foreground font-bold">Club Phone</FormLabel>
                      <FormControl>
                        <Input placeholder="602-555-0100" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="contactEmail"
                  render={({ field }) => (
                    <FormItem className="col-span-2">
                      <FormLabel className="font-heading uppercase text-xs tracking-wider text-muted-foreground font-bold">Club Contact Email</FormLabel>
                      <FormControl>
                        <Input placeholder="info@club.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="website"
                  render={({ field }) => (
                    <FormItem className="col-span-2">
                      <FormLabel className="font-heading uppercase text-xs tracking-wider text-muted-foreground font-bold">Website</FormLabel>
                      <FormControl>
                        <Input placeholder="https://club.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem className="col-span-2">
                      <FormLabel className="font-heading uppercase text-xs tracking-wider text-muted-foreground font-bold">Description</FormLabel>
                      <FormControl>
                        <Textarea placeholder="Brief description of the club..." rows={2} className="resize-none" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Organizer account section — shown on create, or when editing a club with no organizer */}
              {(!editingClub || !editingClub.organizer) && (
                <>
                  <div className="border-t border-border my-2" />
                  <div className="space-y-1 pb-1">
                    <p className="text-xs font-heading font-bold uppercase tracking-widest text-muted-foreground">Organizer Login Account</p>
                    <p className="text-xs text-muted-foreground">
                      {editingClub
                        ? "This club has no organizer account yet. Add one below and they'll receive an invite to set their password."
                        : "This person will manage the club's events and scoring. They'll receive an email invite to set their password."}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="organizerName"
                      render={({ field }) => (
                        <FormItem className="col-span-2">
                          <FormLabel className="font-heading uppercase text-xs tracking-wider text-muted-foreground font-bold">Organizer Name *</FormLabel>
                          <FormControl>
                            <Input placeholder="Jane Smith" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="organizerEmail"
                      render={({ field }) => (
                        <FormItem className="col-span-2">
                          <FormLabel className="font-heading uppercase text-xs tracking-wider text-muted-foreground font-bold">Organizer Email *</FormLabel>
                          <FormControl>
                            <Input type="email" placeholder="jane@club.com" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                </>
              )}

              <DialogFooter className="gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isBusy} className="font-heading font-bold uppercase tracking-wider">
                  {isBusy ? "Saving..." : editingClub ? "Save Changes" : "Create Club"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Setup link dialog — always shown so admin can copy the link */}
      <Dialog open={!!setupLinkUrl} onOpenChange={(v) => { if (!v) { setSetupLinkUrl(null); setCopied(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading uppercase text-xl flex items-center gap-2">
              {setupLinkEmailSent
                ? <><Mail size={18} className="text-primary" /> Email Sent</>
                : <><AlertTriangle size={18} className="text-yellow-500" /> Email Not Delivered</>
              }
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <p className="text-sm text-muted-foreground">
              {setupLinkEmailSent ? (
                <>An email was sent to <span className="font-semibold text-foreground">{setupLinkName}</span>. Copy the link below as a backup in case it doesn't arrive.</>
              ) : (
                <>The invite for <span className="font-semibold text-foreground">{setupLinkName}</span> couldn't be delivered — your Resend account needs a verified domain to send to external addresses. Copy and share this link directly.</>
              )}
            </p>
            <div className="bg-muted rounded-sm p-3 flex items-center gap-2">
              <code className="text-xs flex-1 break-all text-foreground">{setupLinkUrl}</code>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 gap-1.5 font-heading uppercase tracking-wider"
                onClick={() => setupLinkUrl && copyLink(setupLinkUrl)}
              >
                {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              This link expires in 72 hours.{!setupLinkEmailSent && <> Verify your domain at{" "}
              <a href="https://resend.com/domains" target="_blank" rel="noopener noreferrer" className="text-primary underline">resend.com/domains</a>.</>}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-heading uppercase">Delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the club and cannot be undone. Events, riders, and the organizer account associated with this club will be orphaned.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete Club
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
