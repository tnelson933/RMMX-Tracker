import { useState, useEffect } from "react";
import { useListTeamMembers, useCreateTeamMember, useUpdateTeamMember, useDeleteTeamMember, useGetClubSettings, usePutClubSettings } from "@workspace/api-client-react";
import { getPublicOrigin } from "@/lib/publicOrigin";
import type { TeamMember } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { Settings, UsersRound, Plus, Pencil, Trash2, MailCheck, RefreshCw, AlertCircle, Link2, Flag, Copy, Check, FileText, ListChecks, MapPin } from "lucide-react";


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
            {mode === "create" ? "Add Team Member" : "Edit Team Member"}
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

export default function TeamPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const clubId = user?.clubId ?? 0;

  const { data: members = [], isLoading, refetch } = useListTeamMembers({ query: {} as any });
  const { data: settingsData } = useGetClubSettings(clubId, { query: { enabled: !!clubId } as any });

  const putSettings = usePutClubSettings();

  // Rider Acknowledgement state
  const [ackText, setAckText] = useState("");
  const [ackSaving, setAckSaving] = useState(false);

  // Track Name state
  const [trackNameText, setTrackNameText] = useState("");
  const [trackNameSaving, setTrackNameSaving] = useState(false);

  // Default Classes state
  const [classes, setClasses] = useState<{ id: string; name: string }[]>([]);
  const [newClassName, setNewClassName] = useState("");

  // Gate link state
  const [gateLinkCopied, setGateLinkCopied] = useState(false);

  const gateUrl = user?.clubId
    ? `${window.location.origin}/gate-mobile?club=${user.clubId}`
    : null;

  // Load settings on mount
  useEffect(() => {
    if (settingsData) {
      setAckText(settingsData.riderAcknowledgement ?? "");
      setClasses((settingsData.defaultClasses as { id: string; name: string }[]) ?? []);
      setTrackNameText((settingsData as any).trackName ?? "");
    }
  }, [settingsData]);

  const copyGateLink = () => {
    if (!gateUrl) return;
    navigator.clipboard.writeText(gateUrl).then(() => {
      setGateLinkCopied(true);
      setTimeout(() => setGateLinkCopied(false), 2500);
    });
  };

  // Save track name
  const saveTrackName = () => {
    if (!clubId) return;
    setTrackNameSaving(true);
    putSettings.mutate(
      { clubId, data: { trackName: trackNameText.trim() || null } as any },
      {
        onSuccess: () => {
          toast({ title: "Saved", description: "Track name saved." });
        },
        onError: (err: any) => {
          toast({ title: "Error", description: err?.data?.error ?? "Failed to save", variant: "destructive" });
        },
        onSettled: () => setTrackNameSaving(false),
      }
    );
  };

  // Save rider acknowledgement
  const saveAck = () => {
    if (!clubId) return;
    setAckSaving(true);
    putSettings.mutate(
      { clubId, data: { riderAcknowledgement: ackText } },
      {
        onSuccess: () => {
          toast({ title: "Saved", description: "Rider acknowledgement form saved." });
        },
        onError: (err: any) => {
          toast({ title: "Error", description: err?.data?.error ?? "Failed to save", variant: "destructive" });
        },
        onSettled: () => setAckSaving(false),
      }
    );
  };

  // Add a new default class and save immediately
  const addClass = () => {
    const trimmed = newClassName.trim();
    if (!trimmed || !clubId) return;
    const updated = [...classes, { id: crypto.randomUUID(), name: trimmed }];
    setClasses(updated);
    setNewClassName("");
    putSettings.mutate(
      { clubId, data: { defaultClasses: updated } },
      {
        onError: (err: any) => {
          setClasses(classes);
          toast({ title: "Error", description: err?.data?.error ?? "Failed to save", variant: "destructive" });
        },
      }
    );
  };

  // Delete a class and save immediately
  const deleteClass = (id: string) => {
    const updated = classes.filter((c) => c.id !== id);
    setClasses(updated);
    if (!clubId) return;
    putSettings.mutate(
      { clubId, data: { defaultClasses: updated } },
      {
        onError: (err: any) => {
          setClasses(classes);
          toast({ title: "Error", description: err?.data?.error ?? "Failed to save", variant: "destructive" });
        },
      }
    );
  };

  const createMutation = useCreateTeamMember();
  const updateMutation = useUpdateTeamMember();
  const deleteMutation = useDeleteTeamMember();

  const [dialogMode, setDialogMode] = useState<DialogMode>("create");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TeamMember | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<TeamMember | undefined>(undefined);

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
                title: "Team member added",
                description: `${data.name} was added. Invite email couldn't be sent — share their setup link manually from the team list.`,
              });
            } else {
              toast({ title: "Team member added", description: `An invite email has been sent to ${data.name}.` });
            }
          },
          onError: (err: any) => {
            toast({ title: "Error", description: err?.data?.error ?? err?.message ?? "Failed to create team member", variant: "destructive" });
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
            toast({ title: "Error", description: err?.data?.error ?? err?.message ?? "Failed to update team member", variant: "destructive" });
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
          toast({ title: "Team member removed" });
        },
        onError: (err: any) => {
          toast({ title: "Error", description: err?.data?.error ?? err?.message ?? "Failed to remove team member", variant: "destructive" });
        },
      }
    );
  };

  const permissionLabel = (p: string) => ALL_PERMISSIONS.find((x) => x.key === p)?.label ?? p;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-8">
        <Settings size={24} className="text-primary" />
        <div>
          <h1 className="font-heading font-bold text-2xl uppercase tracking-wider">Admin</h1>
          <p className="text-sm text-muted-foreground">Club settings, waivers, default classes, and team access</p>
        </div>
      </div>

      {/* Rider Acknowledgement Form */}
      <div className="rounded-xl border bg-card p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <FileText size={18} className="text-primary" />
          </div>
          <div>
            <h2 className="font-heading font-semibold text-base uppercase tracking-wider">Rider Acknowledgement Form</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Custom rules or waiver text shown to riders at registration</p>
          </div>
        </div>
        <Textarea
          placeholder="Type your club rules, waiver, or acknowledgement text here…"
          className="min-h-[140px] resize-y font-mono text-sm"
          value={ackText}
          onChange={(e) => setAckText(e.target.value)}
        />
        <div className="flex justify-end mt-3">
          <Button onClick={saveAck} disabled={ackSaving || putSettings.isPending}>
            {ackSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {/* Track Name */}
      <div className="rounded-xl border bg-card p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <MapPin size={18} className="text-primary" />
          </div>
          <div>
            <h2 className="font-heading font-semibold text-base uppercase tracking-wider">Track / Venue Name</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Auto-fills the Track Name field when creating new events and stamps practice sessions</p>
          </div>
        </div>
        <Input
          placeholder="e.g. Thunder Valley MX"
          value={trackNameText}
          onChange={(e) => setTrackNameText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && saveTrackName()}
          className="mb-3"
        />
        <div className="flex justify-end">
          <Button onClick={saveTrackName} disabled={trackNameSaving || putSettings.isPending}>
            {trackNameSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {/* Default Race Classes */}
      <div className="rounded-xl border bg-card p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <ListChecks size={18} className="text-primary" />
          </div>
          <div>
            <h2 className="font-heading font-semibold text-base uppercase tracking-wider">Default Race Classes</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Reusable class templates for your events (e.g. 125cc Class A, 250cc Class B)</p>
          </div>
        </div>

        {/* Class list */}
        {classes.length > 0 && (
          <div className="space-y-2 mb-4">
            {classes.map((cls) => (
              <div key={cls.id} className="flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-2.5">
                <span className="flex-1 text-sm font-medium">{cls.name}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                  onClick={() => deleteClass(cls.id)}
                  disabled={putSettings.isPending}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Add new class */}
        <div className="flex gap-2">
          <Input
            placeholder="Class name (e.g. 125cc Class A)"
            value={newClassName}
            onChange={(e) => setNewClassName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addClass()}
            className="flex-1"
          />
          <Button
            onClick={addClass}
            disabled={!newClassName.trim() || putSettings.isPending}
            variant="outline"
          >
            <Plus size={16} className="mr-1.5" />
            Add Class
          </Button>
        </div>

        {classes.length === 0 && (
          <p className="text-xs text-muted-foreground mt-3">No classes yet. Add your first default race class above.</p>
        )}
      </div>

      {/* Team Members */}
      <div className="rounded-xl border bg-card p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <UsersRound size={18} className="text-primary" />
            </div>
            <div>
              <h2 className="font-heading font-semibold text-base uppercase tracking-wider">Team Members</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Manage employee access to the organizer portal</p>
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
            <p className="font-heading font-semibold text-base mb-1">No team members yet</p>
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
              <DialogTitle className="font-heading uppercase tracking-wider">Remove Team Member</DialogTitle>
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
