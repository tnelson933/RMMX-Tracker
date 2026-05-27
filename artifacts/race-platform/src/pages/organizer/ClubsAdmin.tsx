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
  getListClubsQueryKey,
} from "@workspace/api-client-react";
import type { Club } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { Plus, Pencil, Trash2, Building2, Mail, Phone, Globe, MapPin } from "lucide-react";
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
});

type ClubFormValues = z.infer<typeof clubSchema>;

export default function ClubsAdmin() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: clubs = [], isLoading } = useListClubs({ query: {} as any });

  const createMutation = useCreateClub();
  const updateMutation = useUpdateClub();
  const deleteMutation = useDeleteClub();

  const [editingClub, setEditingClub] = useState<Club | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Club | null>(null);

  const form = useForm<ClubFormValues>({
    resolver: zodResolver(clubSchema),
    defaultValues: { name: "", state: "", contactEmail: "", contactPhone: "", website: "", description: "" },
  });

  const openCreate = () => {
    form.reset({ name: "", state: "", contactEmail: "", contactPhone: "", website: "", description: "" });
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
    });
    setEditingClub(club);
    setShowForm(true);
  };

  const onSubmit = (data: ClubFormValues) => {
    const payload = {
      name: data.name,
      state: data.state,
      contactEmail: data.contactEmail || undefined,
      contactPhone: data.contactPhone || undefined,
      website: data.website
        ? (data.website.startsWith("http") ? data.website : `https://${data.website}`)
        : undefined,
      description: data.description || undefined,
    };

    if (editingClub) {
      updateMutation.mutate(
        { clubId: editingClub.id, data: payload },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListClubsQueryKey() });
            setShowForm(false);
            toast({ title: "Club updated", description: `${data.name} has been updated.` });
          },
          onError: () => toast({ title: "Error", description: "Failed to update club.", variant: "destructive" }),
        }
      );
    } else {
      createMutation.mutate(
        { data: payload },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListClubsQueryKey() });
            setShowForm(false);
            toast({ title: "Club created", description: `${data.name} has been added.` });
          },
          onError: () => toast({ title: "Error", description: "Failed to create club.", variant: "destructive" }),
        }
      );
    }
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
        onError: () => toast({ title: "Error", description: "Failed to delete club.", variant: "destructive" }),
      }
    );
  };

  const isBusy = createMutation.isPending || updateMutation.isPending;

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
            Create and manage clubs on the platform. Changes take effect immediately.
          </p>
        </div>
        <Button onClick={openCreate} className="gap-2 font-heading font-bold uppercase tracking-wider">
          <Plus size={16} />
          New Club
        </Button>
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
          {clubs.map((club) => (
            <div
              key={club.id}
              className="bg-card border border-border rounded-sm p-5 flex items-start justify-between gap-4 hover:border-primary/30 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-2">
                  <h2 className="text-lg font-heading font-bold uppercase tracking-tight">{club.name}</h2>
                  <Badge variant="outline" className="font-mono text-xs flex items-center gap-1">
                    <MapPin size={10} />
                    {club.state}
                  </Badge>
                </div>
                {club.description && (
                  <p className="text-sm text-muted-foreground mb-3 line-clamp-1">{club.description}</p>
                )}
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
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
              </div>
              <div className="flex items-center gap-2 shrink-0">
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
          ))}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-heading uppercase tracking-tight text-xl">
              {editingClub ? "Edit Club" : "New Club"}
            </DialogTitle>
            <DialogDescription>
              {editingClub ? `Editing ${editingClub.name}` : "Add a new club to the platform."}
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
                      <FormLabel className="font-heading uppercase text-xs tracking-wider text-muted-foreground font-bold">Phone</FormLabel>
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
                      <FormLabel className="font-heading uppercase text-xs tracking-wider text-muted-foreground font-bold">Contact Email</FormLabel>
                      <FormControl>
                        <Input placeholder="admin@club.com" {...field} />
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
                        <Textarea
                          placeholder="Brief description of the club..."
                          rows={2}
                          className="resize-none"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

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

      {/* Delete Confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-heading uppercase">Delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the club and cannot be undone. Events and riders associated with this club will be orphaned.
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
