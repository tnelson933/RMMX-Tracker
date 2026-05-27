import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useListRiders, useCreateRider, getListRidersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { Users, Search, Plus, ChevronRight, Tag } from "lucide-react";

const createRiderSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  bibNumber: z.string().optional(),
  rfidNumber: z.string().optional(),
});

export default function RidersList() {
  const { user } = useAuth();
  const clubId = user?.clubId || 0;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [search, setSearch] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);

  // Simple debounce for search would be good, but direct usage is fine for this demo
  const { data: riders, isLoading } = useListRiders(
    { clubId, search: search.length > 2 ? search : undefined }, 
    { query: { enabled: !!clubId } as any }
  );

  const createMutation = useCreateRider();

  const form = useForm<z.infer<typeof createRiderSchema>>({
    resolver: zodResolver(createRiderSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      bibNumber: "",
      rfidNumber: "",
    }
  });

  const onSubmit = (data: z.infer<typeof createRiderSchema>) => {
    createMutation.mutate({
      data: {
        ...data,
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListRidersQueryKey({ clubId }) });
        setIsAddOpen(false);
        form.reset();
        toast({ title: "Rider added successfully" });
      },
      onError: (err) => {
        toast({ title: "Failed to add rider", description: err.message, variant: "destructive" });
      }
    });
  };

  // Client-side filter if search is too short for API
  const displayRiders = riders?.filter(r => {
    if (search.length <= 2) {
      const s = search.toLowerCase();
      return r.firstName.toLowerCase().includes(s) || 
             r.lastName.toLowerCase().includes(s) || 
             (r.bibNumber && r.bibNumber.includes(s));
    }
    return true;
  }) || [];

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-4xl font-heading font-bold uppercase tracking-tight flex items-center gap-3">
            <Users className="text-primary" /> Rider Database
          </h1>
          <p className="text-muted-foreground mt-1">Manage rider profiles and assignments.</p>
        </div>
        
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button className="font-heading uppercase tracking-wider">
              <Plus size={16} className="mr-2" /> Add Rider
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-heading uppercase text-xl">Add New Rider</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="firstName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>First Name</FormLabel>
                        <FormControl><Input {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="lastName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Last Name</FormLabel>
                        <FormControl><Input {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email (Optional)</FormLabel>
                      <FormControl><Input type="email" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="bibNumber"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Default Bib #</FormLabel>
                        <FormControl><Input {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="rfidNumber"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>RFID Tag #</FormLabel>
                        <FormControl><Input {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="pt-4 flex justify-end">
                  <Button type="submit" disabled={createMutation.isPending} className="font-heading uppercase tracking-wider">
                    {createMutation.isPending ? "Adding..." : "Add Rider"}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <div className="p-4 border-b bg-muted/30">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
            <Input 
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name or bib number..." 
              className="pl-10"
            />
          </div>
        </div>
        <div className="rounded-b-md">
          <Table>
            <TableHeader className="bg-sidebar text-sidebar-foreground">
              <TableRow className="hover:bg-sidebar">
                <TableHead className="w-20 text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider">ID</TableHead>
                <TableHead className="text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider">Name</TableHead>
                <TableHead className="w-24 text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider text-center">Bib</TableHead>
                <TableHead className="w-32 text-sidebar-foreground/80 font-heading font-bold uppercase tracking-wider text-center">RFID</TableHead>
                <TableHead className="w-16"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={5} className="text-center py-12">Loading riders...</TableCell></TableRow>
              ) : displayRiders.length > 0 ? (
                displayRiders.map(rider => (
                  <TableRow key={rider.id} className="hover:bg-muted/50 cursor-pointer group" onClick={() => window.location.href = `/riders/${rider.id}`}>
                    <TableCell className="text-muted-foreground font-mono">{rider.id}</TableCell>
                    <TableCell className="font-bold text-lg">{rider.firstName} {rider.lastName}</TableCell>
                    <TableCell className="text-center">
                      {rider.bibNumber ? <span className="font-mono bg-muted px-2 py-1 rounded border">{rider.bibNumber}</span> : "-"}
                    </TableCell>
                    <TableCell className="text-center">
                      {rider.rfidNumber ? (
                        <span className="inline-flex items-center gap-1 text-xs text-primary font-bold bg-primary/10 px-2 py-1 rounded">
                          <Tag size={12}/> Active
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50 text-sm">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <ChevronRight className="text-muted-foreground group-hover:text-primary transition-colors inline-block" />
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-16 text-muted-foreground">
                    <Users size={48} className="mx-auto opacity-20 mb-4" />
                    <p className="text-lg font-medium">No riders found</p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
