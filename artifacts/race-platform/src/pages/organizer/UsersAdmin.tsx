import { useState } from "react";
import { useListUsers, useCreateUser, useDeleteUser, useResendUserInvite, getListUsersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UserCog, Plus, Mail, Trash2, CheckCircle, Clock, RefreshCw, Copy, Check, AlertTriangle, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

const INTERNAL_ROLES = [
  { value: "staff", label: "Staff" },
  { value: "super_admin", label: "Super Admin" },
];

export default function UsersAdmin() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [setupLinkUrl, setSetupLinkUrl] = useState<string | null>(null);
  const [setupLinkName, setSetupLinkName] = useState("");
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("staff");

  const { data: allUsers = [], isLoading } = useListUsers({ query: {} as any });
  const users = allUsers.filter((u) => u.role !== "club_organizer");

  const createMutation = useCreateUser();
  const deleteMutation = useDeleteUser();
  const resendMutation = useResendUserInvite();

  const resetForm = () => { setName(""); setEmail(""); setRole("staff"); };

  const copyLink = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCreate = () => {
    if (!name || !email || !role) return;
    createMutation.mutate(
      { data: { name, email, role } },
      {
        onSuccess: (data: any) => {
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          setIsCreateOpen(false);
          resetForm();
          if (data?.setupUrl) {
            setSetupLinkName(data.name ?? email);
            setSetupLinkUrl(data.setupUrl);
          } else {
            toast({ title: "Account created", description: "A setup email has been sent to their inbox." });
          }
        },
        onError: (err: any) => {
          toast({ title: "Failed to create account", description: err?.message || "Unknown error", variant: "destructive" });
        },
      }
    );
  };

  const handleResend = (userId: number, userName: string) => {
    resendMutation.mutate(
      { userId },
      {
        onSuccess: (data: any) => {
          if (data?.setupUrl) {
            setSetupLinkName(userName);
            setSetupLinkUrl(data.setupUrl);
          } else {
            toast({ title: "Invite resent", description: `Setup email sent to ${userName}.` });
          }
        },
        onError: () => toast({ title: "Failed to resend", variant: "destructive" }),
      }
    );
  };

  const handleDelete = (userId: number) => {
    deleteMutation.mutate(
      { userId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          toast({ title: "Account deleted" });
        },
        onError: (err: any) => {
          toast({ title: "Failed to delete", description: err?.message, variant: "destructive" });
        },
      }
    );
  };

  const roleLabel = (r: string) => INTERNAL_ROLES.find((x) => x.value === r)?.label ?? r;

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
            <UserCog className="text-primary" size={32} /> Internal Staff
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage employee accounts for Rocky Mountain ATV/MC staff. Club organizer accounts are managed from the Clubs tab.
          </p>
        </div>

        <Dialog open={isCreateOpen} onOpenChange={(v) => { setIsCreateOpen(v); if (!v) resetForm(); }}>
          <DialogTrigger asChild>
            <Button className="font-heading uppercase tracking-wider h-12 px-6 gap-2">
              <Plus size={16} /> Add Staff Account
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-heading uppercase text-xl">Add Staff Account</DialogTitle>
            </DialogHeader>
            <div className="space-y-5 py-2">
              <div className="bg-primary/5 border border-primary/20 rounded-sm px-3 py-2.5 text-xs text-muted-foreground flex gap-2">
                <ShieldCheck size={14} className="shrink-0 mt-0.5 text-primary" />
                <span>This creates an internal account for Rocky Mountain ATV/MC staff. To create a club organizer account, use the <strong>Clubs</strong> tab instead.</span>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Full Name</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Smith" className="h-11" autoFocus />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Email Address</label>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@rockymountainatv.com" className="h-11" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Role</label>
                <Select value={role} onValueChange={setRole}>
                  <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {INTERNAL_ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="bg-muted/50 rounded-sm p-3 text-sm text-muted-foreground flex gap-2">
                <Mail size={16} className="shrink-0 mt-0.5 text-primary" />
                A setup email with a password link will be sent automatically.
              </div>

              <Button
                onClick={handleCreate}
                disabled={createMutation.isPending || !name || !email || !role}
                className="w-full h-12 font-heading uppercase tracking-wider gap-2"
              >
                {createMutation.isPending
                  ? <><RefreshCw size={16} className="animate-spin" /> Creating...</>
                  : <><Plus size={16} /> Create & Send Invite</>}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Setup link fallback */}
      <Dialog open={!!setupLinkUrl} onOpenChange={(v) => { if (!v) { setSetupLinkUrl(null); setCopied(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading uppercase text-xl flex items-center gap-2">
              <AlertTriangle size={18} className="text-yellow-500" /> Email Not Delivered
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <p className="text-sm text-muted-foreground">
              The setup email for <span className="font-semibold text-foreground">{setupLinkName}</span> couldn't be delivered — your Resend account needs a verified domain to send to external addresses. Copy this link and share it directly.
            </p>
            <div className="bg-muted rounded-md p-3 flex items-center gap-2">
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
              This link expires in 72 hours. To fix email delivery permanently, verify your domain at{" "}
              <a href="https://resend.com/domains" target="_blank" rel="noopener noreferrer" className="text-primary underline">resend.com/domains</a>.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <Card className="overflow-hidden border-sidebar-border">
        <Table>
          <TableHeader className="bg-sidebar text-sidebar-foreground">
            <TableRow className="hover:bg-sidebar">
              <TableHead className="text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Name</TableHead>
              <TableHead className="text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Email</TableHead>
              <TableHead className="text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Role</TableHead>
              <TableHead className="text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Status</TableHead>
              <TableHead className="text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Added</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-16">Loading...</TableCell></TableRow>
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                  <UserCog size={48} className="mx-auto opacity-20 mb-4" />
                  <p className="text-lg font-medium">No internal staff yet</p>
                  <p className="text-sm mt-1">Add the first staff account to get started.</p>
                </TableCell>
              </TableRow>
            ) : (
              users.map((user) => (
                <TableRow key={user.id} className="hover:bg-muted/50 transition-colors">
                  <TableCell className="font-bold">{user.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-sm">{user.email}</TableCell>
                  <TableCell>
                    <Badge
                      variant={user.role === "super_admin" ? "default" : "secondary"}
                      className="font-mono text-xs"
                    >
                      {roleLabel(user.role)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {user.hasPassword ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-secondary/10 text-secondary border border-secondary/20">
                        <CheckCircle size={12} /> Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-yellow-500/10 text-yellow-600 border border-yellow-500/20">
                        <Clock size={12} /> Pending Setup
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {format(new Date(user.createdAt), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleResend(user.id, user.name)}
                        disabled={resendMutation.isPending}
                        title="Resend invite email"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                      >
                        <Mail size={15} />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 size={15} />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete {user.name}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will permanently remove their account. They will no longer be able to log in.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDelete(user.id)}
                              className="bg-destructive hover:bg-destructive/90"
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
