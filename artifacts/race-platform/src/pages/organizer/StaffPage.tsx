import { useState } from "react";
import { useListTeamMembers, useCreateTeamMember, useUpdateTeamMember, useDeleteTeamMember } from "@workspace/api-client-react";
import type { TeamMember } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { UsersRound, Plus, Pencil, Trash2, MailCheck, RefreshCw, AlertCircle, Link2, Flag, Copy, Check } from "lucide-react";

const ALL_PERMISSIONS: { key: string; label: string; description?: string }[] = [
  { key: "dashboard", label: "Dashboard" },
  { key: "events", label: "Events" },
  { key: "practice", label: "Practice" },
  { key: "riders", label: "Riders" },
  { key: "series", label: "Series" },
  { key: "points_tables", label: "Points Scoring Tables" },
  { key: "payments", label: "Payments" },
  { key: "discount_codes", label: "Discount Codes" },
  { key: "reader_setup", label: "Reader Setup" },
  { key: "offline_mode", label: "Offline Mode" },
];

type DialogMode = "create" | "edit";

interface EmployeeDialogProps {
  open: boolean;
  mode: DialogMode;
  initial?: TeamMember;
  onClose: () => void;
  onSave: (data: { name: string; email: string; permissions: string[]; resendInvite?: boolean }) => void;
  isPending: boolean;
}

function EmployeeDialog({ open, mode, initial, onClose, onSave, isPending }: EmployeeDialogProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [permissions, setPermissions] = useState<string[]>(initial?.permissions ?? []);

  const toggle = (key: string) => {
    setPermissions((prev) => prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]);
  };

  const handleSave = () => {
    if (!name.trim() || !email.trim()) return;
    onSave({ name: name.trim(), email: email.trim(), permissions });
  };

  const handleResend = () => {
    if (!name.trim() || !email.trim()) return;
    onSave({ name: name.trim(), email: email.trim(), permissions, resendInvite: true });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-heading uppercase tracking-wider">
            {mode === "create" ? "Add Staff Member" : "Edit Staff Member"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="emp-name">Name</Label>
            <Input id="emp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="emp-email">Email</Label>
            <Input id="emp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="employee@example.com" />
          </div>

          <div>
            <Label className="text-sm font-semibold mb-3 block">Page Access</Label>
            <div className="space-y-3 rounded-lg border p-4">
              {ALL_PERMISSIONS.map(({ key, label, description }) => (
                <div key={key} className="flex items-start gap-3">
                  <Checkbox
                    id={`perm-${key}`}
                    checked={permissions.includes(key)}
                    onCheckedChange={() => toggle(key)}
                  />
                  <div className="flex-1 leading-none">
                    <label htmlFor={`perm-${key}`} className="text-sm font-medium cursor-pointer">
                      {label}
                    </label>
                    {description && (
                      <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          {mode === "edit" && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleResend}
              disabled={isPending}
              className="sm:mr-auto"
            >
              <RefreshCw size={14} className="mr-1.5" />
              Re-send Invite
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSave} disabled={isPending || !name.trim() || !email.trim()}>
            {isPending ? "Saving…" : mode === "create" ? "Create & Send Invite" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function StaffPage() {
  const { toast } = useToast();
  const { user } = useAuth();

  const { data: members = [], isLoading, refetch } = useListTeamMembers({ query: {} as any });

  const createMutation = useCreateTeamMember();
  const updateMutation = useUpdateTeamMember();
  const deleteMutation = useDeleteTeamMember();

  const [dialogMode, setDialogMode] = useState<DialogMode>("create");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TeamMember | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<TeamMember | undefined>(undefined);
  const [gateLinkCopied, setGateLinkCopied] = useState(false);

  const gateUrl = user?.clubId
    ? `${window.location.origin}/gate-mobile?club=${user.clubId}`
    : null;

  const copyGateLink = () => {
    if (!gateUrl) return;
    navigator.clipboard.writeText(gateUrl).then(() => {
      setGateLinkCopied(true);
      setTimeout(() => setGateLinkCopied(false), 2500);
    });
  };

  const openCreate = () => {
    setEditing(undefined);
    setDialogMode("create");
    setDialogOpen(true);
  };

  const openEdit = (member: TeamMember) => {
    setEditing(member);
    setDialogMode("edit");
    setDialogOpen(true);
  };

  const handleSave = (data: { name: string; email: string; permissions: string[]; resendInvite?: boolean }) => {
    if (dialogMode === "create") {
      createMutation.mutate(
        { data: { name: data.name, email: data.email, permissions: data.permissions } },
        {
          onSuccess: (result) => {
            setDialogOpen(false);
            refetch();
            if ((result as any).setupUrl) {
              toast({
                title: "Staff member added",
                description: `${data.name} was added. Invite email couldn't be sent — share their setup link manually from the staff list.`,
              });
            } else {
              toast({ title: "Staff member added", description: `An invite email has been sent to ${data.name}.` });
            }
          },
          onError: (err: any) => {
            toast({ title: "Error", description: err?.data?.error ?? err?.message ?? "Failed to create staff member", variant: "destructive" });
          },
        }
      );
    } else if (editing) {
      updateMutation.mutate(
        { userId: editing.id, data: { name: data.name, email: data.email, permissions: data.permissions, resendInvite: data.resendInvite } },
        {
          onSuccess: (result) => {
            setDialogOpen(false);
            refetch();
            if (data.resendInvite && (result as any).setupUrl) {
              navigator.clipboard.writeText((result as any).setupUrl).catch(() => {});
              toast({ title: "Setup link copied", description: "Email couldn't be sent — the setup link has been copied to your clipboard." });
            } else {
              toast({ title: data.resendInvite ? "Invite re-sent" : "Profile updated" });
            }
          },
          onError: (err: any) => {
            toast({ title: "Error", description: err?.data?.error ?? err?.message ?? "Failed to update staff member", variant: "destructive" });
          },
        }
      );
    }
  };

  const handleDelete = (member: TeamMember) => {
    deleteMutation.mutate(
      { userId: member.id },
      {
        onSuccess: () => {
          setConfirmDelete(undefined);
          refetch();
          toast({ title: "Staff member removed" });
        },
        onError: (err: any) => {
          toast({ title: "Error", description: err?.data?.error ?? err?.message ?? "Failed to remove staff member", variant: "destructive" });
        },
      }
    );
  };

  const permissionLabel = (p: string) => ALL_PERMISSIONS.find((x) => x.key === p)?.label ?? p;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-8">
        <UsersRound size={24} className="text-primary" />
        <div>
          <h1 className="font-heading font-bold text-2xl uppercase tracking-wider">Staff</h1>
          <p className="text-sm text-muted-foreground">Manage employee access to the organizer portal</p>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <UsersRound size={18} className="text-primary" />
            </div>
            <div>
              <h2 className="font-heading font-semibold text-base uppercase tracking-wider">Team Members</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Employees with access to the organizer portal</p>
            </div>
          </div>
          <Button onClick={openCreate} size="sm">
            <Plus size={16} className="mr-1.5" />
            Add Member
          </Button>
        </div>

        {/* Gate Schedule link */}
        {gateUrl && (
          <div className="rounded-lg border bg-muted/30 p-4 mb-4 flex items-start gap-4">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
              <Flag size={18} className="text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-heading font-semibold text-sm uppercase tracking-wider">Gate Schedule Link</p>
              <p className="text-xs text-muted-foreground mt-0.5 mb-2">
                Share this link with anyone helping at the gates — no login needed. Updates every 5 seconds on race day.
              </p>
              <div className="flex items-center gap-2 bg-muted/60 border rounded-lg px-3 py-1.5">
                <span className="text-xs text-muted-foreground font-mono truncate flex-1">{gateUrl}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 shrink-0 gap-1.5 text-xs"
                  onClick={copyGateLink}
                >
                  {gateLinkCopied ? (
                    <><Check size={12} className="text-green-500" /> Copied</>
                  ) : (
                    <><Copy size={12} /> Copy</>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="text-center py-10 text-muted-foreground">Loading…</div>
        ) : members.length === 0 ? (
          <div className="text-center py-10 rounded-xl border-2 border-dashed">
            <UsersRound size={36} className="mx-auto mb-3 text-muted-foreground/40" />
            <p className="font-heading font-semibold text-base mb-1">No staff members yet</p>
            <p className="text-sm text-muted-foreground mb-4">Add employees and control which pages they can access.</p>
            <Button onClick={openCreate} variant="outline" size="sm">
              <Plus size={14} className="mr-1.5" />
              Add First Member
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {(members as TeamMember[]).map((member) => (
              <div key={member.id} className="rounded-xl border bg-card p-4 flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-heading font-semibold text-base">{member.name}</span>
                    <Badge variant={member.status === "active" ? "default" : "secondary"} className="text-xs">
                      {member.status === "active" ? "Active" : (
                        <span className="flex items-center gap-1"><MailCheck size={10} /> Pending invite</span>
                      )}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">{member.email}</p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {member.permissions.length === 0 ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <AlertCircle size={11} /> No pages assigned
                      </span>
                    ) : (
                      member.permissions.map((p) => (
                        <Badge key={p} variant="outline" className="text-xs font-normal">
                          {permissionLabel(p)}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  {member.status === "invited" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Copy setup link"
                      disabled={updateMutation.isPending}
                      onClick={() => {
                        updateMutation.mutate(
                          { userId: member.id, data: { resendInvite: true } as any },
                          {
                            onSuccess: (result) => {
                              if ((result as any).setupUrl) {
                                navigator.clipboard.writeText((result as any).setupUrl).catch(() => {});
                                toast({ title: "Setup link copied", description: "Email couldn't be sent — the setup link has been copied to your clipboard." });
                              } else {
                                toast({ title: "Invite re-sent", description: `A new invite email was sent to ${member.email}.` });
                              }
                            },
                            onError: (err: any) => {
                              toast({ title: "Error", description: err?.data?.error ?? err?.message ?? "Failed to resend invite", variant: "destructive" });
                            },
                          }
                        );
                      }}
                    >
                      <Link2 size={14} />
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => openEdit(member)}>
                    <Pencil size={14} />
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(member)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create / Edit dialog */}
      {dialogOpen && (
        <EmployeeDialog
          open={dialogOpen}
          mode={dialogMode}
          initial={editing}
          onClose={() => setDialogOpen(false)}
          onSave={handleSave}
          isPending={createMutation.isPending || updateMutation.isPending}
        />
      )}

      {/* Confirm delete dialog */}
      {confirmDelete && (
        <Dialog open onOpenChange={(v) => !v && setConfirmDelete(undefined)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="font-heading uppercase tracking-wider">Remove Staff Member</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground py-2">
              Remove <strong>{confirmDelete.name}</strong> ({confirmDelete.email}) from your team? This cannot be undone.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(undefined)}>Cancel</Button>
              <Button variant="destructive" onClick={() => handleDelete(confirmDelete)} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? "Removing…" : "Remove"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
