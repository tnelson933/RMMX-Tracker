import { useState } from "react";
import { useListUsers, useCreateUser, useDeleteUser, useResendUserInvite, useListClubs, getListUsersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UserCog, Plus, Mail, Trash2, CheckCircle, Clock, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

const ROLES = [
  { value: "club_organizer", label: "Club Organizer" },
  { value: "staff", label: "Staff" },
  { value: "super_admin", label: "Super Admin" },
];

export default function UsersAdmin() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("club_organizer");
  const [clubIdStr, setClubIdStr] = useState("");

  const { data: users = [], isLoading } = useListUsers({ query: {} as any });
  const { data: clubs = [] } = useListClubs({ query: { enabled: isCreateOpen } as any });

  const createMutation = useCreateUser();
  const deleteMutation = useDeleteUser();
  const resendMutation = useResendUserInvite();

  const resetForm = () => { setName(""); setEmail(""); setRole("club_organizer"); setClubIdStr(""); };

  const handleCreate = () => {
    if (!name || !email || !role) return;
    createMutation.mutate(
      {
        data: {
          name,
          email,
          role,
          clubId: clubIdStr ? parseInt(clubIdStr) : undefined,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          setIsCreateOpen(false);
          resetForm();
          toast({ title: "User created", description: "A setup email has been sent to their inbox." });
        },
        onError: (err: any) => {
          toast({ title: "Failed to create user", description: err?.message || "Unknown error", variant: "destructive" });
        },
      }
    );
  };

  const handleResend = (userId: number, userName: string) => {
    resendMutation.mutate(
      { userId },
      {
        onSuccess: () => {
          toast({ title: "Invite resent", description: `Setup email sent to ${userName}.` });
        },
        onError: () => {
          toast({ title: "Failed to resend", variant: "destructive" });
        },
      }
    );
  };

  const handleDelete = (userId: number) => {
    deleteMutation.mutate(
      { userId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          toast({ title: "User deleted" });
        },
        onError: (err: any) => {
          toast({ title: "Failed to delete user", description: err?.message, variant: "destructive" });
        },
      }
    );
  };

  const roleLabel = (r: string) => ROLES.find((x) => x.value === r)?.label ?? r;

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
            <UserCog className="text-primary" size={32} /> Users
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage organizer accounts. New users receive an email to set their password.
          </p>
        </div>

        <Dialog open={isCreateOpen} onOpenChange={(v) => { setIsCreateOpen(v); if (!v) resetForm(); }}>
          <DialogTrigger asChild>
            <Button className="font-heading uppercase tracking-wider h-12 px-6 gap-2">
              <Plus size={16} /> Add User
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-heading uppercase text-xl">Add Organizer Account</DialogTitle>
            </DialogHeader>
            <div className="space-y-5 py-2">
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Full Name</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Smith" className="h-11" autoFocus />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Email Address</label>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@club.com" className="h-11" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Role</label>
                <Select value={role} onValueChange={setRole}>
                  <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Club (optional)</label>
                <Select value={clubIdStr} onValueChange={setClubIdStr}>
                  <SelectTrigger className="h-11"><SelectValue placeholder="No club assigned" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">No club assigned</SelectItem>
                    {clubs.map((c) => (
                      <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="bg-muted/50 rounded-md p-3 text-sm text-muted-foreground flex gap-2">
                <Mail size={16} className="shrink-0 mt-0.5 text-primary" />
                A setup email with a password link will be sent automatically when the account is created.
              </div>

              <Button
                onClick={handleCreate}
                disabled={createMutation.isPending || !name || !email || !role}
                className="w-full h-12 font-heading uppercase tracking-wider gap-2"
              >
                {createMutation.isPending ? <><RefreshCw size={16} className="animate-spin" /> Creating...</> : <><Plus size={16} /> Create & Send Invite</>}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="overflow-hidden border-sidebar-border">
        <Table>
          <TableHeader className="bg-sidebar text-sidebar-foreground">
            <TableRow className="hover:bg-sidebar">
              <TableHead className="text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Name</TableHead>
              <TableHead className="text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Email</TableHead>
              <TableHead className="text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Role</TableHead>
              <TableHead className="text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Club</TableHead>
              <TableHead className="text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Status</TableHead>
              <TableHead className="text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider py-4">Added</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7} className="text-center py-16">Loading users...</TableCell></TableRow>
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                  <UserCog size={48} className="mx-auto opacity-20 mb-4" />
                  <p className="text-lg font-medium">No users yet</p>
                </TableCell>
              </TableRow>
            ) : (
              users.map((user) => (
                <TableRow key={user.id} className="hover:bg-muted/50 transition-colors">
                  <TableCell className="font-bold">{user.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-sm">{user.email}</TableCell>
                  <TableCell>
                    <Badge variant={user.role === "super_admin" ? "default" : "secondary"} className="font-mono text-xs">
                      {roleLabel(user.role)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">{user.clubName ?? <span className="text-muted-foreground italic">—</span>}</TableCell>
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
